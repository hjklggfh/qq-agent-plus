// 插件网络请求（capability: http）。
//
// 为什么不直接把宿主 web_fetch 用的 safeFetch 给插件：那个函数是 **GET-only** 的
// （safe-fetch.js 的 requestOnce 把 method 写死成 'GET'，`path`/body 都不接受），插件
// 调不了一次 API。但也不能因此放开裸 fetch —— 那会让 SSRF 防护整个失效。
//
// 所以这里**复用 safe-fetch.js 的安全核心**（validateFetchUrl：scheme 校验、拒绝带凭据的
// URL、DNS 解析后拒绝内网/本机地址），自己实现受限请求。关键点照抄它的做法：
// 请求发往**已校验的那个 IP**，同时保留 `host` 头与 `servername`（SNI），
// 于是"校验时解析到公网、请求时又解析到内网"的 DNS rebinding 从根上不成立。
//
// 与 safeFetch 的差别只有"允许哪些 method/请求头/请求体"，其它上限一律更严或持平。
import http from 'node:http';
import https from 'node:https';
import { validateFetchUrl } from '../../src/llm/safe-fetch.js';

export const ALLOWED_METHODS = Object.freeze(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']);
export const DEFAULT_TIMEOUT_MS = 20000;
export const MAX_TIMEOUT_MS = 30000;
export const DEFAULT_MAX_BYTES = 256 * 1024;
export const MAX_MAX_BYTES = 1024 * 1024;
export const MAX_REQUEST_BODY_BYTES = 64 * 1024;
export const MAX_REDIRECTS = 5;
export const MAX_HEADERS = 24;

/** 这些头由实现自己决定，插件改它们等于绕过长度/连接管理，一律拒绝。 */
const FORBIDDEN_HEADERS = new Set([
  'host', 'content-length', 'connection', 'transfer-encoding',
  'upgrade', 'keep-alive', 'te', 'trailer', 'proxy-authorization'
]);

const HEADER_NAME_PATTERN = /^[a-zA-Z0-9-]{1,64}$/;

export class PluginHttpError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PluginHttpError';
  }
}

function fail(message) {
  throw new PluginHttpError(message);
}

/**
 * 目标校验的统一出口。
 *
 * 共享的安全核心（llm/safe-fetch.js 的 validateFetchUrl）抛的是**裸 Error**。直接放出去，
 * 调用方就没法区分"被策略拒绝"（scheme / 凭据 / 内网地址）与"网络本身失败"——
 * 前者是插件参数问题、后者是环境问题。所以策略类拒绝一律统一成 PluginHttpError；
 * 真正的 socket / 超时错误则原样冒泡，保持它是"网络失败"。
 */
async function validateTarget(rawUrl) {
  try {
    return await validateFetchUrl(rawUrl, { allowPrivate: false });
  } catch (error) {
    throw new PluginHttpError(String(error?.message ?? error));
  }
}

function normalizeHeaders(raw) {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) fail('headers 必须是对象');
  const names = Object.keys(raw);
  if (names.length > MAX_HEADERS) fail(`headers 最多 ${MAX_HEADERS} 个`);
  const out = {};
  for (const name of names) {
    const lower = String(name).toLowerCase();
    if (!HEADER_NAME_PATTERN.test(lower)) fail(`请求头名不合法：${JSON.stringify(name)}`);
    if (FORBIDDEN_HEADERS.has(lower)) fail(`请求头 ${lower} 由宿主管理，插件不能设置`);
    const value = raw[name];
    if (value === undefined || value === null) continue;
    const text = String(value);
    // 头注入：值里出现 CR/LF 能让插件伪造出额外的头甚至额外的请求。
    if (/[\r\n]/.test(text)) fail(`请求头 ${lower} 的值不能包含换行`);
    if (text.length > 2000) fail(`请求头 ${lower} 的值过长`);
    out[lower] = text;
  }
  return out;
}

function normalizeBody(raw) {
  if (raw === undefined || raw === null) return null;
  let buffer = null;
  if (typeof raw === 'string') buffer = Buffer.from(raw, 'utf8');
  else if (Buffer.isBuffer(raw)) buffer = raw;
  else if (raw instanceof Uint8Array) buffer = Buffer.from(raw);
  else fail('body 只接受字符串或 Buffer/Uint8Array');
  if (buffer.length > MAX_REQUEST_BODY_BYTES) {
    fail(`请求体超过上限 ${MAX_REQUEST_BODY_BYTES} 字节（实际 ${buffer.length}）`);
  }
  return buffer;
}

/** 有界读取：超过 maxBytes 就断开并把内容截断（不让恶意目标一直吐数据占住连接）。 */
function readBounded(res, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      fn(value);
    };
    res.on('data', (chunk) => {
      if (settled) return;
      total += chunk.length;
      if (total >= maxBytes) {
        chunks.push(chunk.subarray(0, Math.max(0, chunk.length - (total - maxBytes))));
        try { res.destroy(); } catch { /* 已经断了 */ }
        const buffer = Buffer.concat(chunks);
        finish(resolve, { buffer, truncated: true });
        return;
      }
      chunks.push(chunk);
    });
    res.on('end', () => finish(resolve, { buffer: Buffer.concat(chunks), truncated: false }));
    res.on('error', (error) => finish(reject, error));
  });
}

function responseHeaders(res) {
  const out = {};
  const raw = res.headers || {};
  for (const name of Object.keys(raw)) {
    const value = raw[name];
    out[name] = Array.isArray(value) ? value.join(', ') : String(value ?? '');
  }
  return out;
}

function requestOnce(url, ip, { method, headers, body, maxBytes, signal, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const mod = url.protocol === 'https:' ? https : http;
    const port = url.port || (url.protocol === 'https:' ? 443 : 80);
    const outgoing = {
      hostname: ip,
      port,
      path: url.pathname + url.search,
      method,
      headers: {
        host: url.host,
        'user-agent': 'qq-agent-plus-plugin/1.0',
        accept: '*/*',
        ...headers,
        ...(body ? { 'content-length': String(body.length) } : {})
      },
      servername: url.protocol === 'https:' ? url.hostname : undefined,
      rejectUnauthorized: url.protocol === 'https:',
      signal,
      timeout: timeoutMs
    };
    const req = mod.request(outgoing, (res) => {
      const statusCode = res.statusCode || 0;
      if ([301, 302, 303, 307, 308].includes(statusCode)) {
        // 不排空重定向响应体：它不计入 maxBytes，恶意目标可以借此一直吐数据。
        res.destroy();
        resolve({
          statusCode,
          redirect: String(res.headers.location || ''),
          headers: responseHeaders(res)
        });
        return;
      }
      readBounded(res, maxBytes)
        .then((read) => resolve({
          statusCode,
          headers: responseHeaders(res),
          body: read.buffer,
          truncated: read.truncated
        }))
        .catch(reject);
    });
    req.on('timeout', () => req.destroy(new Error(`请求超时：${url.hostname}`)));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

/**
 * 受限请求。
 *
 * 返回 `{ url, statusCode, headers, body(string), truncated, redirects }`。
 * body 一律按 UTF-8 文本给出：插件是给模型做工具用的，二进制没有意义（要图请让插件拿 URL）。
 */
export async function pluginFetch(rawUrl, options = {}) {
  const method = String(options.method ?? 'GET').toUpperCase();
  if (!ALLOWED_METHODS.includes(method)) {
    fail(`不支持的 method：${method}（允许 ${ALLOWED_METHODS.join(', ')}）`);
  }
  const maxBytes = (() => {
    if (options.maxBytes === undefined) return DEFAULT_MAX_BYTES;
    const value = Number(options.maxBytes);
    if (!Number.isFinite(value) || value < 1024) fail('maxBytes 必须是不小于 1024 的数字');
    return Math.min(Math.round(value), MAX_MAX_BYTES);
  })();
  const timeoutMs = (() => {
    if (options.timeoutMs === undefined) return DEFAULT_TIMEOUT_MS;
    const value = Number(options.timeoutMs);
    if (!Number.isFinite(value) || value < 1000) fail('timeoutMs 必须是不小于 1000 的数字');
    return Math.min(Math.round(value), MAX_TIMEOUT_MS);
  })();
  let headers = normalizeHeaders(options.headers);
  const body = normalizeBody(options.body);
  const signal = options.signal ?? undefined;

  // 内网例外不开放给插件：宿主的 web_fetch 有 security.allowPrivateImageHosts 这个逃生口，
  // 那是给"自建图床"用的运维开关；插件是第三方代码，不继承它。
  let { url, ip } = await validateTarget(rawUrl);
  let currentMethod = method;
  let currentBody = body;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    signal?.throwIfAborted();
    const result = await requestOnce(url, ip, {
      method: currentMethod,
      headers,
      body: currentBody,
      maxBytes,
      signal,
      timeoutMs
    });
    if (![301, 302, 303, 307, 308].includes(result.statusCode)) {
      return {
        url: url.toString(),
        statusCode: result.statusCode,
        headers: result.headers,
        body: result.body ? result.body.toString('utf8') : '',
        truncated: result.truncated === true,
        redirects: hop
      };
    }
    if (!result.redirect) fail(`重定向缺少 Location：${result.statusCode}`);
    const previousOrigin = url.origin;
    const next = new URL(result.redirect, url).toString();
    ({ url, ip } = await validateTarget(next));
    // 303（以及历史行为里的 301/302）按规范把方法降成 GET 并丢掉请求体。
    if (result.statusCode === 303 || ((result.statusCode === 301 || result.statusCode === 302)
      && currentMethod !== 'GET' && currentMethod !== 'HEAD')) {
      currentMethod = 'GET';
      currentBody = null;
    }
    // 跨源跳转必须摘掉凭据类请求头：否则插件把 Authorization 发给 A，
    // A 用 302 就能把它引到 B 并把头一起带走（这是常见的凭据外泄路径）。
    if (url.origin !== previousOrigin) {
      const nextHeaders = { ...headers };
      delete nextHeaders.authorization;
      delete nextHeaders.cookie;
      headers = nextHeaders;
    }
  }
  fail(`重定向次数超过 ${MAX_REDIRECTS}，已停止`);
}
