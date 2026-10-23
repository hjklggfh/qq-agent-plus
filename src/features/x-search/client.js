import https from 'node:https';
import { validateFetchUrl, safeFetchPublicBinary } from '../../llm/safe-fetch.js';
import sharp from 'sharp';

// 不跟随 API 重定向，Token 仅发到管理员配置的接口；DNS 校验并固定 IP。
export async function xRequestJson(raw, options) {
  const { signal, bearerToken } = options;
  const { url, ip } = await validateFetchUrl(raw);
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname: ip, servername: url.hostname, port: url.port || 443,
      path: url.pathname + url.search, signal, method: 'GET',
      headers: { Host: url.host, Authorization: `Bearer ${bearerToken}`, Accept: 'application/json' }
    }, (res) => {
      res.on('error', reject);
      if (res.statusCode !== 200) {
        res.resume();
        const messages = { 401: 'X 凭据无效，请检查 Bearer Token', 402: 'X API 额度不足',
          403: 'X 接口无权限或目标账号受限', 404: '未找到该 X 账号', 429: 'X 接口限流，请稍后重试' };
        reject(new Error(messages[res.statusCode] || `X 接口返回 HTTP ${res.statusCode}`));
        req.destroy();
        return;
      }
      let size = 0;
      const chunks = [];
      res.on('data', (chunk) => {
        size += chunk.length;
        if (size > 1024 * 1024) { reject(new Error('X 接口响应过大')); req.destroy(); return; }
        chunks.push(chunk);
      });
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch { reject(new Error('X 接口返回无效 JSON')); }
      });
    });
    req.on('error', () => reject(new Error(signal?.aborted ? 'X 请求已取消或超时' : 'X 接口连接失败，请检查网络或中转地址')));
    req.end();
  });
}

export function normalizeXPage(user, raw) {
  if (!raw || typeof raw !== 'object' || (raw.data != null && !Array.isArray(raw.data)) || (!raw.data && !raw.meta)) throw new Error('X 帖子响应格式无效');
  const media = new Map((raw.includes?.media || []).map((m) => [m.media_key, m]));
  const seen = new Set();
  const posts = (raw.data || []).filter((p) => {
    if (!/^\d{1,20}$/.test(p?.id) || seen.has(p.id)) return false;
    seen.add(p.id); return true;
  }).sort((a, b) => a.id === b.id ? 0 : BigInt(a.id) > BigInt(b.id) ? -1 : 1).slice(0, 5).map((p) => ({
    id: p.id, text: String(p.note_post?.text || p.note_tweet?.text || p.text || ''), createdAt: p.created_at || '',
    sensitive: p.possibly_sensitive === true, url: `https://x.com/${user.username}/status/${p.id}`,
    media: (p.attachments?.media_keys || []).map((key) => media.get(key)).filter(Boolean).slice(0, 4).map((m) => ({
      type: m.type, url: m.type === 'photo' ? m.url : m.preview_image_url
    }))
  }));
  return { user, posts, next: typeof raw.meta?.next_token === 'string' ? raw.meta.next_token.slice(0, 4096) : '',
    fetchedAt: new Date().toISOString(), partial: Boolean(raw.errors?.length) };
}

export async function fetchXPage(username, settings, options = {}) {
  const request = options.request || xRequestJson;
  const init = { signal: options.signal, bearerToken: settings.bearerToken };
  const base = settings.apiBaseUrl;
  const profile = await request(`${base}/2/users/by/username/${encodeURIComponent(username)}?user.fields=description,protected`, init);
  const user = profile?.data;
  if (!/^\d{1,20}$/.test(user?.id) || !/^[a-z0-9_]{1,15}$/i.test(user?.username) || user.username.toLowerCase() !== username.toLowerCase()) throw new Error('X 账号响应无效或账号不匹配');
  if (user.protected) throw new Error('该账号为受保护账号，试用版仅支持公开帖子');
  const url = new URL(`${base}/2/users/${user.id}/tweets`);
  url.searchParams.set('max_results', '5');
  // 当前 X 文档采用 post.fields；响应同时兼容旧版 note_tweet 字段。
  url.searchParams.set('post.fields', 'created_at,attachments,possibly_sensitive,note_post');
  url.searchParams.set('expansions', 'attachments.media_keys');
  url.searchParams.set('media.fields', 'type,url,preview_image_url');
  const exclude = [!settings.includeReplies && 'replies', !settings.includeReposts && 'retweets'].filter(Boolean);
  if (exclude.length) url.searchParams.set('exclude', exclude.join(','));
  if (options.next) url.searchParams.set('pagination_token', options.next);
  const raw = await request(url.href, init);
  return normalizeXPage({ id: user.id, username: user.username, name: String(user.name || user.username), description: String(user.description || '') }, raw);
}

export async function xThumbnail(raw, signal) {
  const url = new URL(raw);
  // 媒体不发送 API Token；只从 X 官方图片域名获取小图，不下载视频。
  if (url.protocol !== 'https:' || !/(^|\.)pbs\.twimg\.com$/i.test(url.hostname)) throw new Error('非 X 图片地址');
  if (url.pathname.startsWith('/media/')) { url.searchParams.set('name', 'small'); url.searchParams.set('format', 'jpg'); }
  const { buffer } = await safeFetchPublicBinary(url.href, 2 * 1024 * 1024, signal);
  const jpeg = await sharp(buffer, { limitInputPixels: 12_000_000, failOn: 'warning' })
    .rotate().resize({ width: 640, height: 640, fit: 'inside', withoutEnlargement: true })
    .flatten({ background: '#fff' }).toColourspace('srgb').jpeg({ quality: 75 }).toBuffer();
  if (jpeg.length > 160 * 1024) throw new Error('缩略图过大');
  return { type: 'image', data: { file: `base64://${jpeg.toString('base64')}` } };
}
