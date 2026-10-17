export const IMAGE_SEARCH_PLATFORMS = Object.freeze(['google', 'yandex', 'trace']);
export const DEFAULT_IMAGE_SEARCH_CONFIG = Object.freeze({
  enabled: false, relayUrl: '', relayToken: '', defaultPlatform: 'google',
  platforms: Object.freeze({ google: true, yandex: true, trace: true }),
  fallback: true, allowPrivate: false, allowedGroups: Object.freeze([]),
  timeoutSeconds: 45, limit: 3, cooldownSeconds: 15, traceMinSimilarity: 0.9
});

export function validateRelayUrl(value) {
  if (value === '') return;
  let url;
  try { url = new URL(value); } catch { throw new Error('搜图中转地址无效'); }
  const loopback = ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))
    || url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)) {
    throw new Error('搜图中转地址须为 HTTPS 根地址，或 SSH 隧道的本机 HTTP 地址；不能包含凭据和参数');
  }
}

export function validateImageSearchPatch(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('搜图配置必须为对象');
  for (const key of Object.keys(raw)) {
    if (!Object.hasOwn(DEFAULT_IMAGE_SEARCH_CONFIG, key) && !key.startsWith('has')) throw new Error(`未知搜图设置：${key}`);
  }
  for (const key of ['enabled', 'fallback', 'allowPrivate']) {
    if (Object.hasOwn(raw, key) && typeof raw[key] !== 'boolean') throw new Error('搜图开关必须为布尔值');
  }
  if (Object.hasOwn(raw, 'relayUrl')) {
    if (typeof raw.relayUrl !== 'string' || raw.relayUrl.length > 500) throw new Error('搜图地址必须为文本');
    validateRelayUrl(raw.relayUrl);
  }
  if (Object.hasOwn(raw, 'relayToken') && (typeof raw.relayToken !== 'string' || raw.relayToken.length > 512 || raw.relayToken.length > 0 && raw.relayToken.length < 32 || /[\r\n]/.test(raw.relayToken))) throw new Error('搜图令牌须为32—512字符（留空可清除）');
  if (Object.hasOwn(raw, 'defaultPlatform') && !IMAGE_SEARCH_PLATFORMS.includes(raw.defaultPlatform)) throw new Error('未知搜图平台');
  if (Object.hasOwn(raw, 'platforms') && (!raw.platforms || Array.isArray(raw.platforms) || typeof raw.platforms !== 'object'
    || Object.entries(raw.platforms).some(([key, value]) => !IMAGE_SEARCH_PLATFORMS.includes(key) || typeof value !== 'boolean'))) throw new Error('搜图平台开关无效');
  if (Object.hasOwn(raw, 'allowedGroups') && (!Array.isArray(raw.allowedGroups) || raw.allowedGroups.length > 500
    || raw.allowedGroups.some((id) => typeof id !== 'string' || !/^\d{5,15}$/.test(id)))) throw new Error('搜图群白名单须为最多500项群号文本数组');
  for (const [key, min, max] of [['timeoutSeconds', 10, 90], ['limit', 1, 5], ['cooldownSeconds', 0, 3600], ['traceMinSimilarity', 0.8, 1]]) {
    if (Object.hasOwn(raw, key) && (!Number.isFinite(raw[key]) || raw[key] < min || raw[key] > max || (key !== 'traceMinSimilarity' && !Number.isInteger(raw[key])))) throw new Error(`搜图设置 ${key} 必须在 ${min}—${max} 之间`);
  }
}

export function imageSearchConfig(raw = {}) {
  const config = { ...structuredClone(DEFAULT_IMAGE_SEARCH_CONFIG), ...raw, platforms: { ...DEFAULT_IMAGE_SEARCH_CONFIG.platforms, ...raw?.platforms } };
  validateImageSearchPatch(config);
  return config;
}
