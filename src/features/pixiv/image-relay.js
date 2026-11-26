import { fetch as undiciFetch } from 'undici';

// 只接受管理员配置的本机SSH端点，不接收任意代理目标或凭据。
export function validateImageRelay(raw) {
  const url = new URL(raw);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.pathname !== '/image'
    || url.username || url.password || url.search || url.hash) throw new Error('图片处理端点须为 http://127.0.0.1:端口/image');
  return url.href;
}
export async function fetchRelayedImage(raw, settings, options = {}) {
  const url = new URL(raw);
  if (url.protocol !== 'https:' || url.hostname !== 'i.pximg.net' || url.port || url.username || url.password || url.search || url.hash) throw new Error('仅可中转官方图片地址');
  const endpoint = validateImageRelay(settings.imageRelayUrl);
  const fetchImpl = options.fetchImpl || undiciFetch;
  const maxBytes = Math.max(65536, Math.min(16 * 1024 * 1024, Math.round(Number(settings.maxImageBytes) || 5 * 1024 * 1024)));
  const maxEdge = Math.max(256, Math.min(4096, Math.round(Number(settings.downsampleMaxEdge) || 1200)));
  const timeoutSeconds = Math.max(3, Math.min(60, Math.ceil((Number(settings.timeoutMs) || 15000) / 1000)));
  return fetchImpl.call(null, endpoint, { method: 'POST', redirect: 'error', signal: options.signal,
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: url.href,
      maxBytes, maxEdge, timeoutSeconds }) });
}
