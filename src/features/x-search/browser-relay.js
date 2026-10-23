import http from 'node:http';
import fs from 'node:fs';
import { timingSafeEqual } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { pipeline } from 'node:stream/promises';
import { readBrowserAccount } from './browser-reader.js';
import { readXRelayImage, openXRelayImage } from './relay-image.js';
import { boundedXImage } from './image-stream.js';

export function createXBrowserRelay(options) {
  const { token, profileDir } = options;
  if (typeof token !== 'string' || !/^[a-zA-Z0-9_-]{32,128}$/.test(token)) throw new Error('X 中转令牌格式无效');
  const read = options.read || readBrowserAccount;
  const download = options.download || readXRelayImage;
  const original = options.original || openXRelayImage;
  let active = null; let task = null;
  const cache = new Map();
  const originals = new Map();
  const remember = (page) => {
    for (const [id, entry] of originals) if (Date.now() - entry.at > 600000) originals.delete(id);
    for (const post of page.posts) originals.set(post.id, { media: post.media, at: Date.now() });
    while (originals.size > 1000) originals.delete(originals.keys().next().value);
  };
  const respond = (res, code, value) => {
    if (res.destroyed) return;
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(value));
  };
  const server = http.createServer(async (req, res) => {
    const actual = Buffer.from(req.headers.authorization || '');
    const expected = Buffer.from(`Bearer ${token}`);
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) { respond(res, 401, { error: 'X 中转未授权' }); req.resume(); return; }
    if (req.method === 'GET' && req.url === '/healthz') { respond(res, 200, { ok: true, busy: Boolean(active), source: 'tokyo-browser' }); return; }
    const originalMatch = req.url?.match(/^\/original\?post=([0-9]{1,20})&index=([0-3])$/);
    if (req.method === 'GET' && originalMatch) {
      const entry = originals.get(originalMatch[1]);
      if (!entry || Date.now() - entry.at > 600000) { respond(res, 410, { error: '原图索引已过期' }); return; }
      const media = entry.media[Number(originalMatch[2])];
      if (media?.type !== 'photo') { respond(res, 404, { error: '该位置不是照片' }); return; }
      if (active) { respond(res, 429, { error: '东京服务忙' }); return; }
      const controller = new AbortController(); active = controller;
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(60000)]);
      const disconnected = () => { if (!res.writableEnded) controller.abort(); };
      res.on('close', disconnected);
      task = (async () => {
        let image;
        try {
          image = await original(media.url, { original: true, signal });
          const limiter = boundedXImage(image.contentType);
          res.writeHead(200, { 'content-type': image.contentType, 'cache-control': 'no-store' });
          await pipeline(image.stream, limiter, res, { signal });
        } catch {
          if (res.headersSent) res.destroy(); else respond(res, 502, { error: '原图暂不可用' });
        } finally {
          image?.stream.destroy(); res.off('close', disconnected); if (active === controller) active = null;
        }
      })();
      await task; return;
    }
    if (req.method === 'GET' && req.url?.startsWith('/image?')) {
      let image;
      try { image = new URL(new URL(req.url, 'http://127.0.0.1').searchParams.get('url')); } catch { respond(res, 400, { error: '图片地址无效' }); return; }
      const permitted = image.protocol === 'https:' && image.hostname === 'pbs.twimg.com' && !image.username && !image.password
        && [...cache.values()].some((page) => Date.now() - Date.parse(page.fetchedAt) < 120000 && page.posts.some((post) => post.media.some((m) => {
          try { return new URL(m.url).pathname === image.pathname; } catch { return false; }
        })));
      if (!permitted) { respond(res, 403, { error: '图片不属于近期账号查询结果' }); return; }
      if (active) { respond(res, 429, { error: '东京服务忙' }); return; }
      const controller = new AbortController(); active = controller;
      const disconnected = () => { if (!res.writableEnded) controller.abort(); };
      res.on('close', disconnected);
      task = (async () => {
        try {
          const result = await download(image.href, { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]) });
          if (result.buffer.length > 2 * 1024 * 1024) throw new Error('图片超过限制');
          if (!res.destroyed) { res.writeHead(200, { 'content-type': result.contentType, 'cache-control': 'no-store' }); res.end(result.buffer); }
        } catch { respond(res, 502, { error: 'X 缩略图暂不可用' }); }
        finally { res.off('close', disconnected); if (active === controller) active = null; }
      })();
      await task; return;
    }
    const match = req.url?.match(/^\/account\/([a-zA-Z0-9_]{1,15})(?:\?before=([0-9]{1,20}))?$/);
    if (req.method !== 'GET' || !match) { respond(res, 404, { error: '接口不存在' }); req.resume(); return; }
    const username = match[1]; const before = match[2] || ''; const key = `${username.toLowerCase()}:${before}`;
    const cached = cache.get(key);
    if (cached && Date.now() - Date.parse(cached.fetchedAt) < 60000) { remember(cached); respond(res, 200, cached); return; }
    if (active) { respond(res, 429, { error: '东京浏览器正在查询，请稍后重试' }); return; }
    const controller = new AbortController();
    active = controller;
    const disconnected = () => { if (!res.writableEnded) controller.abort(); };
    res.on('close', disconnected);
    task = (async () => {
      try {
        const page = await read(username, { profileDir, before, chromePath: options.chromePath, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(45000)]) });
        cache.set(key, page);
        remember(page);
        if (cache.size > 30) cache.delete(cache.keys().next().value);
        respond(res, 200, page);
      } catch (error) {
        options.log?.(String(error.message).slice(0, 160));
        respond(res, 503, { error: '东京未能读取公开帖子；请检查登录态、临时登录桌面是否已停止以及服务日志' });
      }
      finally { res.off('close', disconnected); if (active === controller) active = null; }
    })();
    await task;
  });
  server.requestTimeout = 5000; server.headersTimeout = 5000;
  return { server, stop: async () => { active?.abort(); await task; cache.clear(); originals.clear(); server.closeIdleConnections(); await new Promise((resolve) => server.close(resolve)); } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const relay = createXBrowserRelay({ token: fs.readFileSync(process.env.X_BROWSER_RELAY_TOKEN_FILE, 'utf8').trim(),
    profileDir: process.env.X_BROWSER_PROFILE, chromePath: process.env.X_BROWSER_CHROME || '/usr/bin/google-chrome', log: (message) => console.warn(message) });
  const port = Number(process.env.X_BROWSER_RELAY_PORT || 3223);
  relay.server.listen(port, '127.0.0.1', () => console.log(`X 登录态读取服务已启动：127.0.0.1:${port}`));
  const stop = async () => { await relay.stop(); process.exit(0); };
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
}
