import http from 'node:http';
import fs from 'node:fs';
import { timingSafeEqual } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { readBrowserAccount } from './browser-reader.js';

export function createXBrowserRelay(options) {
  const { token, profileDir } = options;
  if (typeof token !== 'string' || !/^[a-zA-Z0-9_-]{32,128}$/.test(token)) throw new Error('X 中转令牌格式无效');
  const read = options.read || readBrowserAccount;
  let active = null; let task = null;
  const cache = new Map();
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
    const match = req.url?.match(/^\/account\/([a-zA-Z0-9_]{1,15})$/);
    if (req.method !== 'GET' || !match) { respond(res, 404, { error: '接口不存在' }); req.resume(); return; }
    const username = match[1]; const key = username.toLowerCase();
    const cached = cache.get(key);
    if (cached && Date.now() - Date.parse(cached.fetchedAt) < 60000) { respond(res, 200, cached); return; }
    if (active) { respond(res, 429, { error: '东京浏览器正在查询，请稍后重试' }); return; }
    const controller = new AbortController();
    active = controller;
    const disconnected = () => { if (!res.writableEnded) controller.abort(); };
    res.on('close', disconnected);
    task = (async () => {
      try {
        const page = await read(username, { profileDir, chromePath: options.chromePath, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(45000)]) });
        cache.set(key, page);
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
  return { server, stop: async () => { active?.abort(); await task; cache.clear(); server.closeIdleConnections(); await new Promise((resolve) => server.close(resolve)); } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const relay = createXBrowserRelay({ token: fs.readFileSync(process.env.X_BROWSER_RELAY_TOKEN_FILE, 'utf8').trim(),
    profileDir: process.env.X_BROWSER_PROFILE, chromePath: process.env.X_BROWSER_CHROME || '/usr/bin/google-chrome', log: (message) => console.warn(message) });
  const port = Number(process.env.X_BROWSER_RELAY_PORT || 3223);
  relay.server.listen(port, '127.0.0.1', () => console.log(`X 登录态读取服务已启动：127.0.0.1:${port}`));
  const stop = async () => { await relay.stop(); process.exit(0); };
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
}
