// 东京中转独立进程；不加载宿主配置、记忆、OneBot 或模型。
import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { imageType } from '../../core/image-type.js';
import { IMAGE_SEARCH_PLATFORMS } from './config.js';
import { MAX_IMAGE_BYTES } from './common.js';
import { searchProvider } from './providers.js';

function respond(res, status, value) {
  if (res.destroyed) return;
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(value));
}

export function createImageSearchRelay(options = {}) {
  const token = options.token || process.env.IMAGE_SEARCH_RELAY_TOKEN || '';
  if (token.length < 32 || token.length > 512 || /[\r\n]/.test(token)) throw new Error('IMAGE_SEARCH_RELAY_TOKEN 至少32字符，最多512字符');
  const provider = options.search || searchProvider;
  let busy = false;
  const controllers = new Set();
  const server = http.createServer(async (req, res) => {
    const received = Buffer.from(req.headers.authorization || '');
    const expected = Buffer.from(`Bearer ${token}`);
    if (received.length !== expected.length || !timingSafeEqual(received, expected)) { respond(res, 401, { error: '未授权' }); req.resume(); return; }
    if (req.url === '/healthz' && req.method === 'GET') { respond(res, 200, { ok: true, busy, googleConfigured: Boolean(options.chromePath || process.env.IMAGE_SEARCH_CHROME) }); return; }
    if (req.url !== '/v1/search') { respond(res, 404, { error: '接口不存在' }); req.resume(); return; }
    if (req.method !== 'POST') { respond(res, 405, { error: '仅支持 POST' }); req.resume(); return; }
    if (busy) { respond(res, 429, { error: '搜图中转正忙' }); req.resume(); return; }
    const platform = req.headers['x-search-platform'];
    if (!IMAGE_SEARCH_PLATFORMS.includes(platform)) { respond(res, 400, { error: '未知搜图平台' }); req.resume(); return; }
    if (Number(req.headers['content-length']) > MAX_IMAGE_BYTES) { respond(res, 413, { error: '图片最多8MB' }); req.resume(); return; }
    busy = true;
    const seconds = Math.min(90, Math.max(10, Number(req.headers['x-search-timeout']) || 45));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), (seconds + 5) * 1000);
    controllers.add(controller);
    const abort = () => { if (!res.writableEnded) controller.abort(); };
    res.on('close', abort);
    req.on('aborted', abort);
    try {
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        controller.signal.throwIfAborted();
        size += chunk.length;
        if (size > MAX_IMAGE_BYTES) { respond(res, 413, { error: '图片最多8MB' }); return; }
        chunks.push(chunk);
      }
      const buffer = Buffer.concat(chunks);
      const type = imageType(buffer);
      if (!type) { respond(res, 400, { error: '不支持的图片格式' }); return; }
      const report = await provider(platform, { buffer, type }, {
        signal: controller.signal, timeoutSeconds: seconds, chromePath: options.chromePath,
        limit: Math.min(5, Math.max(1, Math.floor(Number(req.headers['x-search-limit']) || 3))),
        traceMinSimilarity: Math.min(1, Math.max(0.8, Number(req.headers['x-trace-min-similarity']) || 0.9))
      });
      respond(res, 200, report);
    } catch {
      respond(res, 200, { platform, status: 'error', message: controller.signal.aborted ? '平台查询超时或已取消' : '搜图中转处理失败', results: [] });
    } finally {
      clearTimeout(timer);
      controllers.delete(controller);
      res.off('close', abort);
      req.off('aborted', abort);
      busy = false;
    }
  });
  server.requestTimeout = 20000;
  server.headersTimeout = 10000;
  server.on('close', () => { for (const c of controllers) c.abort(); });
  server.abortSearches = () => { for (const c of controllers) c.abort(); };
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const server = createImageSearchRelay();
  const port = Number(process.env.IMAGE_SEARCH_RELAY_PORT || 3220);
  // 固定监听本机，杭州经 SSH 隧道连接；无匿名公网搜图接口。
  server.listen(port, '127.0.0.1', () => process.stdout.write(`搜图中转已启动：127.0.0.1:${port}\n`));
  const stop = () => {
    server.abortSearches();
    server.closeAllConnections();
    server.close();
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
}
