// 东京中转独立进程；不加载宿主配置、记忆、OneBot 或模型。
import http from 'node:http';
import { timingSafeEqual, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { imageType } from '../../core/image-type.js';
import { IMAGE_SEARCH_LIMIT_MAX, IMAGE_SEARCH_PLATFORMS } from './config.js';
import { MAX_IMAGE_BYTES, publicLink } from './common.js';
import { searchProvider } from './providers.js';
import { safeFetchPublicBinary } from '../../llm/safe-fetch.js';
import {
  TOKYO_RELAY_RESOURCE_SOURCES,
  isRelayAllowedTouchGalDomain,
  runTokyoRelayResourceSearch
} from '../resource-search/sources.js';
import { WEBPAGE_TIMEOUT_MS, fetchWebpageDirect } from '../resource-search/webpage.js';

function respond(res, status, value) {
  if (res.destroyed) return;
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(value));
}

export function createImageSearchRelay(options = {}) {
  const token = options.token || process.env.IMAGE_SEARCH_RELAY_TOKEN || '';
  if (token.length < 32 || token.length > 512 || /[\r\n]/.test(token)) throw new Error('IMAGE_SEARCH_RELAY_TOKEN 至少32字符，最多512字符');
  const provider = options.search || searchProvider;
  const download = options.download || safeFetchPublicBinary;
  const resourceProvider = options.resourceSearch || runTokyoRelayResourceSearch;
  const webpageProvider = options.webpageFetch || fetchWebpageDirect;
  // 仅接受最近搜索结果的短期凭证，不能作为任意 URL 下载代理。
  // 容量须装下“搜图 全部”与多站点资源检索一轮的全部凭证，避免先查的站点凭证被挤掉。
  const maxImageKeys = Math.max(64, IMAGE_SEARCH_PLATFORMS.length * IMAGE_SEARCH_LIMIT_MAX * 2);
  const images = new Map();
  let googleBlockedUntil = 0;
  let busy = false;
  let resourceBusy = 0;
  let webpageBusy = 0;
  const controllers = new Set();
  const server = http.createServer(async (req, res) => {
    const received = Buffer.from(req.headers.authorization || '');
    const expected = Buffer.from(`Bearer ${token}`);
    if (received.length !== expected.length || !timingSafeEqual(received, expected)) { respond(res, 401, { error: '未授权' }); req.resume(); return; }
    if (req.url === '/healthz' && req.method === 'GET') { respond(res, 200, { ok: true, busy, googleConfigured: Boolean(options.chromePath || process.env.IMAGE_SEARCH_CHROME), serpapiConfigured: Boolean(options.serpApiKey || process.env.IMAGE_SEARCH_SERPAPI_API_KEY) }); return; }
    const imageRequest = req.url === '/v1/image';
    const resourceRequest = req.url === '/v1/resource-search';
    const webpageRequest = req.url === '/v1/webpage';
    if (req.url !== '/v1/search' && !imageRequest && !resourceRequest && !webpageRequest) { respond(res, 404, { error: '接口不存在' }); req.resume(); return; }
    if (req.method !== 'POST') { respond(res, 405, { error: '仅支持 POST' }); req.resume(); return; }
    if (webpageRequest) {
      if (Number(req.headers['content-length']) > 2048) { respond(res, 413, { error: '请求过大' }); req.resume(); return; }
      if (webpageBusy >= 8) { respond(res, 429, { error: '外网读页中转正忙' }); req.resume(); return; }
      webpageBusy += 1;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), WEBPAGE_TIMEOUT_MS);
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
          if (size > 2048) { respond(res, 413, { error: '请求过大' }); return; }
          chunks.push(chunk);
        }
        let body;
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { respond(res, 400, { error: '无效 JSON' }); return; }
        const targetUrl = publicLink(body?.url);
        if (!targetUrl) {
          respond(res, 400, { error: 'URL 无效（仅允许无凭据的 http/https 链接）' });
          return;
        }
        const page = await webpageProvider(targetUrl, { signal: controller.signal });
        respond(res, 200, {
          url: page.url || targetUrl,
          statusCode: page.statusCode || 200,
          title: page.title || '',
          truncated: Boolean(page.truncated),
          blocked: page.blocked || '',
          warning: page.warning || '',
          excerpt: page.excerpt || '',
          links: Array.isArray(page.links) ? page.links : []
        });
      } catch (error) {
        const msg = String(error?.message ?? error);
        const isPolicyRejection = error?.code === 'UNSUPPORTED_CONTENT_TYPE'
          || /内网|本机|URL 无效|仅允许 http\/https|不能包含凭据|主机名为空/.test(msg);
        if (isPolicyRejection) {
          respond(res, 400, { error: msg.slice(0, 160) });
        } else {
          respond(res, 502, {
            status: 'error',
            error: controller.signal.aborted ? '目标网页读取超时（10s）' : msg.slice(0, 160)
          });
        }
      } finally {
        clearTimeout(timer);
        controllers.delete(controller);
        res.off('close', abort);
        req.off('aborted', abort);
        webpageBusy -= 1;
      }
      return;
    }
    if (resourceRequest) {
      if (Number(req.headers['content-length']) > 1024) { respond(res, 413, { error: '请求过大' }); req.resume(); return; }
      if (resourceBusy >= 24) { respond(res, 429, { error: '搜图中转正忙' }); req.resume(); return; }
      resourceBusy += 1;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15000);
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
          if (size > 1024) { respond(res, 413, { error: '请求过大' }); return; }
          chunks.push(chunk);
        }
        let body;
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { respond(res, 400, { error: '无效 JSON' }); return; }
        const source = String(body?.source || '');
        const query = String(body?.query || '').trim().slice(0, 120);
        const rawDomain = typeof body?.domain === 'string' ? body.domain.trim() : '';
        if (!TOKYO_RELAY_RESOURCE_SOURCES.includes(source) || !query) {
          respond(res, 400, { error: '未知资源检索源或查询词为空' });
          return;
        }
        if (rawDomain && (source !== 'touchgal' || !isRelayAllowedTouchGalDomain(rawDomain))) {
          respond(res, 400, { error: '不支持的中转域名参数' });
          return;
        }
        for (const [key, item] of images) if (item.expires < Date.now()) images.delete(key);
        const providerOptions = { signal: controller.signal };
        if (source === 'touchgal' && rawDomain) providerOptions.domain = rawDomain;
        const report = await resourceProvider(source, query, providerOptions);
        for (const row of (report?.results || []).slice(0, 10)) {
          const url = publicLink(row?.cover);
          if (!url) continue;
          const key = randomUUID();
          images.set(key, { url, expires: Date.now() + 5 * 60 * 1000 });
          row.coverKey = key;
        }
        while (images.size > maxImageKeys) images.delete(images.keys().next().value);
        respond(res, 200, report);
      } catch (error) {
        respond(res, 200, {
          source: 'unknown',
          status: 'error',
          message: controller.signal.aborted ? '搜图中转查询超时' : '搜图中转处理失败',
          error: String(error?.message ?? error).slice(0, 120),
          results: []
        });
      } finally {
        clearTimeout(timer);
        controllers.delete(controller);
        res.off('close', abort);
        req.off('aborted', abort);
        resourceBusy -= 1;
      }
      return;
    }
    if (busy) { respond(res, 429, { error: '搜图中转正忙' }); req.resume(); return; }
    const platform = req.headers['x-search-platform'];
    if (!imageRequest && !IMAGE_SEARCH_PLATFORMS.includes(platform)) { respond(res, 400, { error: '未知搜图平台' }); req.resume(); return; }
    const maxBody = imageRequest ? 1024 : MAX_IMAGE_BYTES;
    if (Number(req.headers['content-length']) > maxBody) { respond(res, 413, { error: '请求过大' }); req.resume(); return; }
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
        if (size > maxBody) { respond(res, 413, { error: '请求过大' }); return; }
        chunks.push(chunk);
      }
      const buffer = Buffer.concat(chunks);
      for (const [key, item] of images) if (item.expires < Date.now()) images.delete(key);
      if (imageRequest) {
        const item = images.get(JSON.parse(buffer.toString('utf8')).key);
        if (!item) { respond(res, 404, { error: '图片凭证无效或已过期，请重新搜图' }); return; }
        const maxBytes = Math.min(MAX_IMAGE_BYTES, Math.max(1, Number(req.headers['x-image-max-bytes']) || MAX_IMAGE_BYTES));
        const imageSignal = AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]);
        const result = await download(item.url, maxBytes, imageSignal);
        const type = imageType(result.buffer);
        if (!type || result.buffer.length > maxBytes) throw new Error('无效图片');
        if (!res.destroyed) {
          res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store', 'content-length': result.buffer.length });
          res.end(result.buffer);
        }
        return;
      }
      const type = imageType(buffer);
      if (!type) { respond(res, 400, { error: '不支持的图片格式' }); return; }
      if (platform === 'google' && Date.now() < googleBlockedUntil) {
        respond(res, 200, { platform, status: 'blocked', message: 'Google 需要人工验证，暂停自动访问10分钟；请使用其他平台', results: [] });
        return;
      }
      const report = await provider(platform, { buffer, type }, {
        signal: controller.signal, timeoutSeconds: seconds, chromePath: options.chromePath, serpApiKey: options.serpApiKey,
        limit: Math.min(IMAGE_SEARCH_LIMIT_MAX, Math.max(1, Math.floor(Number(req.headers['x-search-limit']) || 3))),
        traceMinSimilarity: Math.min(1, Math.max(0.8, Number(req.headers['x-trace-min-similarity']) || 0.9))
      });
      if (platform === 'google' && report.status === 'blocked') googleBlockedUntil = Date.now() + 10 * 60 * 1000;
      for (const row of (report.results || []).slice(0, IMAGE_SEARCH_LIMIT_MAX)) {
        for (const field of ['image', 'thumbnail']) {
          const url = publicLink(row[field]);
          if (!url) continue;
          const key = randomUUID();
          images.set(key, { url, expires: Date.now() + 5 * 60 * 1000 });
          row[`${field}Key`] = key;
        }
      }
      while (images.size > maxImageKeys) images.delete(images.keys().next().value);
      respond(res, 200, report);
    } catch {
      if (imageRequest) respond(res, 422, { error: '匹配图片暂时无法下载' });
      else respond(res, 200, { platform, status: 'error', message: controller.signal.aborted ? '平台查询超时或已取消' : '搜图中转处理失败', results: [] });
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
