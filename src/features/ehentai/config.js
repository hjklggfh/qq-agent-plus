export const DEFAULT_EHENTAI_CONFIG = Object.freeze({
  enabled: false,
  allowedChats: [],
  keepHours: 24,
  maxPdfPages: 500,
  maxPdfBytes: 256 * 1024 * 1024,
  maxImageBytes: 12 * 1024 * 1024,
  timeoutMs: 20000,
  proxyUrl: '',
  directIps: ['172.66.132.196', '172.66.140.62'],
  pythonPath: ''
});

export function ehentaiConfig(raw = {}) {
  return { ...DEFAULT_EHENTAI_CONFIG, ...raw };
}

export function validateEhentaiPatch(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('E站设置须为对象');
  for (const [key, value] of Object.entries(patch)) {
    if (!(key in DEFAULT_EHENTAI_CONFIG)) throw new Error(`未知 E站设置：${key}`);
    if (key === 'enabled' && typeof value !== 'boolean') throw new Error('E站开关须为布尔值');
    if (key === 'allowedChats' && (!Array.isArray(value) || value.length > 100 || value.some((v) => typeof v !== 'string' || !/^(group|private):\d{5,15}$/.test(v)))) throw new Error('E站允许会话格式无效');
    if (key === 'directIps' && (!Array.isArray(value) || value.length < 1 || value.length > 4
      || value.some((v) => typeof v !== 'string' || !publicIpv4(v)))) throw new Error('E站直连 IP 须为公网 IPv4');
    if (key === 'pythonPath' && (typeof value !== 'string' || value.length > 500 || /[\r\n]/.test(value))) throw new Error('Python 路径格式无效');
    if (key === 'proxyUrl') {
      if (typeof value !== 'string' || value.length > 200) throw new Error('E站代理地址无效');
      if (value) {
        let url;
        try { url = new URL(value); } catch { throw new Error('E站代理地址无效'); }
        if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)
          || !url.port || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
          throw new Error('E站代理只能是本机 HTTP CONNECT 地址，例如 http://127.0.0.1:3223');
        }
      }
    }
  }
  for (const [key, min, max] of [
    ['keepHours', 1, 168], ['maxPdfPages', 1, 1000],
    ['maxPdfBytes', 1048576, 536870912], ['maxImageBytes', 65536, 33554432],
    ['timeoutMs', 3000, 60000]
  ]) if (key in patch && (!Number.isInteger(patch[key]) || patch[key] < min || patch[key] > max)) {
    throw new Error(`${key} 必须在 ${min}—${max} 之间`);
  }
}
import { isIP } from 'node:net';

function publicIpv4(value) {
  if (isIP(value) !== 4) return false;
  const [a, b, c] = value.split('.').map(Number);
  return !(a === 0 || a === 10 || a === 127 || a >= 224 || a === 169 && b === 254
    || a === 172 && b >= 16 && b <= 31 || a === 192 && b === 168
    || a === 100 && b >= 64 && b <= 127 || a === 198 && [18, 19].includes(b)
    || a === 192 && b === 0 && c === 2 || a === 198 && b === 51 && c === 100
    || a === 203 && b === 0 && c === 113);
}

