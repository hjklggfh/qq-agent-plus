import { parse } from 'node-html-parser';
import { boundedBody, cleanTitle, publicLink } from './common.js';
import { googleLens } from './google.js';

const USER_AGENT = 'Mozilla/5.0';

export function parseYandex(body, limit = 3) {
  const root = parse(body);
  for (const node of root.querySelectorAll('[data-state]')) {
    let state;
    try { state = JSON.parse(node.getAttribute('data-state')); } catch { continue; }
    const initial = state?.initialState;
    if (!initial) continue;
    const rows = initial.cbirSites?.sites || [];
    const seen = new Set();
    const results = [];
    for (const item of rows) {
      const url = publicLink(item.url);
      if (!url || seen.has(url)) continue;
      seen.add(url);
      results.push({ title: cleanTitle(item.title), url, image: publicLink(item.originalImage?.url), thumbnail: publicLink(item.thumb?.url?.startsWith('//') ? `https:${item.thumb.url}` : item.thumb?.url) });
      if (results.length >= limit) break;
    }
    return results;
  }
  return [];
}

export function parseTrace(data, limit = 3, minSimilarity = 0.9) {
  const seen = new Set();
  const results = [];
  for (const row of data.result || []) {
    if (!Number.isFinite(row.similarity) || row.similarity < minSimilarity || row.similarity > 1) continue;
    const anime = row.anilist;
    const id = typeof anime === 'object' ? anime?.id : anime;
    if (!Number.isInteger(id) || id < 1) continue;
    const key = `${id}:${row.episode}`;
    if (seen.has(key)) continue;
    seen.add(key);
    results.push({ title: cleanTitle(anime?.title?.chinese || anime?.title?.native || anime?.title?.romaji || row.filename), url: `https://anilist.co/anime/${id}`, image: publicLink(row.image), episode: row.episode, similarity: row.similarity, from: row.from, to: row.to, version: cleanTitle(row.filename) });
    if (results.length >= limit) break;
  }
  return results;
}

export async function providerRequest(url, options, fetchImpl = globalThis.fetch) {
  // 仅接受固定平台及其自身重定向，不将上传图片转发给其他来源。
  let target = new URL(url);
  const origin = target.origin;
  for (let i = 0; i < 4; i++) {
    const response = await fetchImpl(target, { ...options, redirect: 'manual', headers: { 'user-agent': USER_AGENT, ...options.headers } });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      await response.body?.cancel();
      if (!location) throw new Error('平台重定向无效');
      const next = new URL(location, target);
      if (next.origin !== origin || next.username || next.password) throw new Error('平台要求跳转其他站点，已停止');
      target = next;
      if (response.status === 303 || [301, 302].includes(response.status) && options.method === 'POST') options = { ...options, method: 'GET', body: undefined };
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel();
      const error = new Error(`平台 HTTP ${response.status}`);
      error.blocked = [403, 429].includes(response.status);
      throw error;
    }
    return (await boundedBody(response, 5 * 1024 * 1024, options.signal)).toString('utf8');
  }
  throw new Error('平台重定向过多');
}

export async function searchProvider(platform, image, options = {}) {
  const signal = options.signal;
  const limit = options.limit || 3;
  try {
    let results;
    if (platform === 'google') return await googleLens(image, options);
    const form = new FormData();
    form.set(platform === 'trace' ? 'image' : 'upfile', new Blob([image.buffer], { type: image.type }), 'search-image');
    if (platform === 'trace') {
      const data = JSON.parse(await providerRequest('https://api.trace.moe/search?anilistInfo', { method: 'POST', body: form, signal }, options.fetchImpl));
      if (data.error) throw new Error('动画搜索未完成');
      results = parseTrace(data, limit, options.traceMinSimilarity ?? 0.9);
    } else if (platform === 'yandex') {
      const request = encodeURIComponent(JSON.stringify({ blocks: [{ block: 'b-page_type_search-by-image__link' }] }));
      const body = await providerRequest(`https://yandex.com/images/search?rpt=imageview&format=json&request=${request}`, { method: 'POST', body: form, signal }, options.fetchImpl);
      if (/showcaptcha|SmartCaptcha|unusual traffic/i.test(body)) return { platform, status: 'blocked', message: '平台要求验证码，请换其他平台', results: [] };
      const data = JSON.parse(body);
      const params = data.blocks?.find((b) => b.name?.block === 'b-page_type_search-by-image__link')?.params;
      const original = new URL(params?.originalImageUrl);
      if (original.origin !== 'https://avatars.mds.yandex.net' || !params?.cbirId) throw new Error('图片上传响应无效');
      const url = new URL('https://yandex.com/images/search');
      url.search = new URLSearchParams({ rpt: 'imageview', url: original.href, cbir_id: params.cbirId });
      const html = await providerRequest(url.href, { signal }, options.fetchImpl);
      if (/showcaptcha|SmartCaptcha/i.test(html)) return { platform, status: 'blocked', message: '平台要求验证码，请换其他平台', results: [] };
      results = parseYandex(html, limit);
    } else throw new Error('未知搜图平台');
    return { platform, status: results.length ? 'ok' : 'empty', message: results.length ? '' : platform === 'trace' ? '未找到达到相似度门槛的动画结果' : '未找到来源网页，或平台页面格式已变化', results };
  } catch (error) {
    signal?.throwIfAborted();
    if (platform === 'google' && /浏览器未能启动|浏览器启动超时/.test(error.message)) return { platform, status: 'unavailable', message: '浏览器无法启动，请检查 Chrome 路径、系统依赖和沙箱配置', results: [] };
    return { platform, status: error.blocked ? 'blocked' : 'error', message: error.blocked ? '平台限制访问，请稍后手动重试或换平台' : '平台查询失败，请查看服务状态', results: [] };
  }
}
