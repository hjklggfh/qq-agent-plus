import { boundedBody, cleanTitle, publicLink } from './common.js';
import sharp from 'sharp';

const ENDPOINT = 'https://serpapi.com';
const MAX_UPLOAD_BYTES = 500_000;

function sourceFor(url, supplied) {
  const host = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  const known = [
    [/^(?:.+\.)?x\.com$|^(?:.+\.)?twitter\.com$/, 'X'],
    [/^(?:.+\.)?tiktok\.com$/, 'TikTok'],
    [/^(?:.+\.)?instagram\.com$/, 'Instagram'],
    [/^(?:.+\.)?youtube\.com$|^youtu\.be$/, 'YouTube'],
    [/^(?:.+\.)?bilibili\.com$/, 'Bilibili']
  ].find(([pattern]) => pattern.test(host));
  const name = known?.[1] || cleanTitle(supplied, 40);
  return name && name.toLowerCase() !== host ? `${name} (${host})` : host;
}

function pageKind(url) {
  const parsed = new URL(url);
  const host = parsed.hostname.toLowerCase();
  const pathname = parsed.pathname;
  if (/^(?:.+\.)?tiktok\.com$/.test(host) && pathname.startsWith('/discover/')) return 'search';
  if (/^(?:.+\.)?(?:x|twitter)\.com$/.test(host)) return /\/status\/\d+/.test(pathname) ? 'post' : /^\/search(?:\/|$)/.test(pathname) ? 'search' : /^\/[^/]+\/?$/.test(pathname) ? 'profile' : 'page';
  if (/^(?:.+\.)?tiktok\.com$/.test(host) && /\/video\/\d+/.test(pathname)) return 'post';
  if (/^(?:.+\.)?instagram\.com$/.test(host) && /^\/(?:p|reel)\//.test(pathname)) return 'post';
  return 'page';
}

function linkedAccount(url) {
  const parsed = new URL(url);
  const host = parsed.hostname.toLowerCase();
  const segment = parsed.pathname.split('/').filter(Boolean)[0] || '';
  if (/^(?:.+\.)?(?:x|twitter|instagram)\.com$/.test(host) && /^[a-zA-Z0-9_.]{1,30}$/.test(segment) && !['search', 'explore', 'discover'].includes(segment)) return `@${segment}`;
  if (/^(?:.+\.)?tiktok\.com$/.test(host) && /^@[a-zA-Z0-9_.]{2,30}$/.test(segment)) return segment;
  return '';
}

export function parseSerpApiRows(data, section, limit = 5) {
  const seen = new Set();
  const rows = [];
  for (const item of Array.isArray(data?.[section]) ? data[section] : []) {
    const url = publicLink(item?.link);
    if (!url) continue;
    const parsed = new URL(url);
    const key = /^(?:www\.)?(?:x\.com|twitter\.com)$/.test(parsed.hostname) && /\/status\/\d+/.test(parsed.pathname)
      ? parsed.pathname.match(/^\/[^/]+\/status\/\d+/)?.[0] : `${parsed.hostname}${parsed.pathname}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({ title: cleanTitle(item.title) || '匹配网页', url, source: sourceFor(url, item.source), kind: pageKind(url), account: linkedAccount(url), match: section === 'exact_matches' ? 'exact' : 'visual', image: publicLink(item.image), thumbnail: publicLink(item.thumbnail) });
    if (rows.length >= limit) break;
  }
  return rows;
}

async function jsonResponse(response, signal) {
  const body = await boundedBody(response, 2 * 1024 * 1024, signal);
  let data;
  try { data = JSON.parse(body.toString('utf8')); } catch { throw new Error('SerpApi 响应格式无效'); }
  if (!response.ok || data.error) throw new Error('SerpApi 查询未完成');
  return data;
}

export async function prepareSerpApiImage(image) {
  if (['image/jpeg', 'image/png', 'image/webp'].includes(image.type) && image.buffer.length <= MAX_UPLOAD_BYTES) return image;
  for (const [size, quality] of [[1600, 82], [1200, 76], [960, 68], [720, 60]]) {
    const buffer = await sharp(image.buffer, { pages: 1, limitInputPixels: 40_000_000 })
      .rotate().resize({ width: size, height: size, fit: 'inside', withoutEnlargement: true })
      .flatten({ background: '#ffffff' }).jpeg({ quality }).toBuffer();
    if (buffer.length <= MAX_UPLOAD_BYTES) return { buffer, type: 'image/jpeg' };
  }
  throw new Error('图片无法压缩到 SerpApi 的 500 KB 限制内');
}

export async function serpApiLens(image, options = {}) {
  const key = options.serpApiKey || process.env.IMAGE_SEARCH_SERPAPI_API_KEY;
  if (!key) return { platform: 'serpapi', status: 'unavailable', message: '东京中转未配置 SerpApi Key', results: [] };

  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const signal = options.signal;
  try {
    const prepared = await prepareSerpApiImage(image);
    const form = new FormData();
    form.set('api_key', key);
    form.set('image', new Blob([prepared.buffer], { type: prepared.type }), 'search-image');
    const uploaded = await jsonResponse(await fetchImpl(`${ENDPOINT}/image`, { method: 'POST', body: form, signal, redirect: 'error' }), signal);
    if (typeof uploaded.image_id !== 'string' || !/^[\w-]{10,200}$/.test(uploaded.image_id)) throw new Error('SerpApi 图片凭证无效');

    const search = async (type) => {
      const url = new URL(`${ENDPOINT}/search.json`);
      url.search = new URLSearchParams({ engine: 'google_lens', image_id: uploaded.image_id, type, safe: 'off', api_key: key }).toString();
      return jsonResponse(await fetchImpl(url, { signal, redirect: 'error' }), signal);
    };
    let exact = [];
    let exactFailed = false;
    try { exact = parseSerpApiRows(await search('exact_matches'), 'exact_matches', options.limit || 3); }
    catch { exactFailed = true; }
    let visual = [];
    if (exactFailed || !exact.some((row) => row.kind === 'post')) {
      try { visual = parseSerpApiRows(await search('all'), 'visual_matches', options.limit || 3); }
      catch { if (exactFailed) return { platform: 'serpapi', status: 'error', message: 'SerpApi 暂时未返回搜图结果，请稍后手动重试', results: [] }; }
    }
    const seen = new Set();
    const ordered = [
      ...exact.filter((row) => row.kind === 'post'),
      ...exact.filter((row) => row.kind === 'page').slice(0, 2),
      ...visual.filter((row) => row.kind === 'post'),
      ...exact.filter((row) => ['search', 'profile'].includes(row.kind)).slice(0, 1),
      ...visual.filter((row) => row.kind !== 'post')
    ];
    const results = ordered.filter((row) => {
      const url = new URL(row.url);
      const key = `${url.hostname}${url.pathname}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }).slice(0, options.limit || 3);
    return { platform: 'serpapi', status: results.length ? 'ok' : 'empty', message: results.length ? '' : 'Google Lens 未找到可用的公开网页', results };
  } catch (error) {
    signal?.throwIfAborted();
    return { platform: 'serpapi', status: 'error', message: error.message?.includes('无法压缩') ? error.message : 'SerpApi 查询失败，请检查 Key、额度及网络状态', results: [] };
  }
}
