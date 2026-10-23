import http from 'node:http';
import { normalizeBrowserPosts } from './browser-reader.js';
import { xThumbnail } from './client.js';

export async function xBrowserThumbnail(raw, settings, signal) {
  const base = validateXRelayUrl(settings.relayUrl);
  const download = (url, maxBytes) => new Promise((resolve, reject) => {
    const target = new URL('/image', base); target.searchParams.set('url', url);
    const request = http.get(target, { signal, headers: { Authorization: `Bearer ${settings.relayToken}` } }, (res) => {
      res.on('error', () => reject(new Error('东京图片连接中断')));
      if (res.statusCode !== 200) { res.resume(); reject(new Error('东京缩略图暂不可用')); return; }
      let size = 0; const chunks = [];
      res.on('data', (chunk) => {
        size += chunk.length;
        if (size > maxBytes) { reject(new Error('东京缩略图过大')); res.destroy(); return; }
        chunks.push(chunk);
      });
      res.on('end', () => resolve({ buffer: Buffer.concat(chunks) }));
    });
    request.on('error', () => reject(new Error('东京图片连接失败')));
  });
  return xThumbnail(raw, signal, download);
}

export function validateXRelayUrl(raw) {
  const url = new URL(raw);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('东京中转须为 SSH 隧道的 http://127.0.0.1:端口 根地址');
  }
  return url;
}

export async function fetchXBrowserPage(username, settings, options = {}) {
  const base = validateXRelayUrl(settings.relayUrl);
  if (!/^[a-z0-9_]{1,15}$/i.test(username)) throw new Error('X 用户名无效');
  const before = options.next || '';
  if (before && !/^[0-9]{1,20}$/.test(before)) throw new Error('X 翻页标记无效');
  const target = new URL(`/account/${username}`, base);
  if (before) target.searchParams.set('before', before);
  const page = await new Promise((resolve, reject) => {
    const request = http.get(target, { signal: options.signal,
      headers: { Authorization: `Bearer ${settings.relayToken}`, Accept: 'application/json' } }, (res) => {
      res.on('error', () => reject(new Error('东京读取连接中断')));
      if (res.statusCode !== 200) {
        res.resume(); reject(new Error(res.statusCode === 401 ? '东京中转令牌不匹配' : res.statusCode === 429 ? '东京浏览器忙，请稍后重试' : '东京未能读取帖子，请检查登录态或服务状态')); return;
      }
      let size = 0; const chunks = [];
      res.on('data', (chunk) => {
        size += chunk.length;
        if (size > 1024 * 1024) { reject(new Error('东京响应过大')); res.destroy(); return; }
        chunks.push(chunk);
      });
      res.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(new Error('东京返回格式无效')); } });
    });
    request.on('error', () => reject(new Error('东京中转连接失败，请检查 SSH 隧道')));
  });
  if (page?.source !== 'tokyo-browser' || page?.user?.username?.toLowerCase() !== username.toLowerCase() || !Array.isArray(page.posts)) throw new Error('东京返回账号不匹配或格式无效');
  const posts = normalizeBrowserPosts(username, page.posts.slice(0, 20));
  if (before && posts.some((post) => BigInt(post.id) >= BigInt(before))) throw new Error('东京返回了重复的翻页结果');
  if (page.next && (!/^[0-9]{1,20}$/.test(page.next) || posts.length !== 5 || page.next !== posts.at(-1).id)) throw new Error('东京返回翻页标记无效');
  return { user: { username, name: String(page.user.name || username), description: String(page.user.description || '') },
    posts, next: page.next || '',
    fetchedAt: Number.isFinite(Date.parse(page.fetchedAt)) ? page.fetchedAt : new Date().toISOString(), partial: Boolean(page.partial), source: 'tokyo-browser' };
}
