export const RESOURCE_SEARCH_SOURCES = Object.freeze([
  'shionlib',
  'kungal',
  'shinnku',
  'touchgal',
  'vndb',
  'bangumi',
  'dlsite',
  'steam',
  'animetrace',
  'web'
]);

export const RESOURCE_SEARCH_LIMIT_MAX = 10;

export const DEFAULT_RESOURCE_SEARCH_CONFIG = Object.freeze({
  enabled: false,
  allowPrivate: false,
  allowedGroups: Object.freeze([]),
  cooldownSeconds: 15,
  timeoutSeconds: 60,
  maxResults: 5,
  includeImages: true,
  safeGroupLinks: true,
  deepseekBaseUrl: 'https://api.deepseek.com/v1',
  deepseekModel: 'deepseek-chat',
  deepseekApiKey: '',
  touchgalDomain: 'www.touchgal.ink',
  touchgalToken: '',
  shionlibDomain: 'shionlib.com',
  proxyUrl: '',
  sources: Object.freeze({
    shionlib: true,
    kungal: true,
    shinnku: true,
    touchgal: true,
    vndb: true,
    bangumi: true,
    dlsite: true,
    steam: true,
    animetrace: true,
    web: true
  })
});

export function validateApiBaseUrl(value, label = 'DeepSeek API 地址') {
  if (value === '') return;
  let url;
  try { url = new URL(value); } catch { throw new Error(`${label}无效`); }
  const loopback = ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))
    || url.username || url.password || url.search || url.hash) {
    throw new Error(`${label}须为 HTTPS 地址或本机 HTTP 地址，且不含凭据与查询参数`);
  }
}

export function validateProxyUrl(value) {
  if (value === '') return;
  let url;
  try { url = new URL(value); } catch { throw new Error('海外检索本机代理地址无效'); }
  if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)
    || !url.port || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('海外检索本机代理只能是本机 HTTP CONNECT 地址，例如 http://127.0.0.1:3222');
  }
}

export function validateDomainName(value, label = '站点域名') {
  if (typeof value !== 'string' || !/^[a-z0-9.-]{3,120}$/i.test(value) || value.includes('..')) {
    throw new Error(`${label}格式无效（请填写纯域名，如 www.touchgal.ink）`);
  }
}

export function validateResourceSearchPatch(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('资源检索配置必须为对象');
  for (const key of Object.keys(raw)) {
    if (!Object.hasOwn(DEFAULT_RESOURCE_SEARCH_CONFIG, key) && !key.startsWith('has')) {
      throw new Error(`未知资源检索设置：${key}`);
    }
  }
  for (const key of ['enabled', 'allowPrivate', 'includeImages', 'safeGroupLinks']) {
    if (Object.hasOwn(raw, key) && typeof raw[key] !== 'boolean') {
      throw new Error('资源检索开关必须为布尔值');
    }
  }
  if (Object.hasOwn(raw, 'allowedGroups') && (!Array.isArray(raw.allowedGroups) || raw.allowedGroups.length > 500
    || raw.allowedGroups.some((id) => typeof id !== 'string' || !/^\d{5,15}$/.test(id)))) {
    throw new Error('资源检索群白名单须为最多500项群号文本数组');
  }
  if (Object.hasOwn(raw, 'sources') && (!raw.sources || Array.isArray(raw.sources) || typeof raw.sources !== 'object'
    || Object.entries(raw.sources).some(([key, value]) => !RESOURCE_SEARCH_SOURCES.includes(key) || typeof value !== 'boolean'))) {
    throw new Error('资源检索站点开关无效');
  }
  if (Object.hasOwn(raw, 'deepseekBaseUrl')) {
    if (typeof raw.deepseekBaseUrl !== 'string' || raw.deepseekBaseUrl.length > 300) {
      throw new Error('DeepSeek API 地址必须为文本');
    }
    validateApiBaseUrl(raw.deepseekBaseUrl);
  }
  if (Object.hasOwn(raw, 'proxyUrl')) {
    if (typeof raw.proxyUrl !== 'string' || raw.proxyUrl.length > 200) {
      throw new Error('海外检索本机代理地址无效');
    }
    validateProxyUrl(raw.proxyUrl);
  }
  if (Object.hasOwn(raw, 'deepseekModel')) {
    if (typeof raw.deepseekModel !== 'string' || !raw.deepseekModel.trim() || raw.deepseekModel.length > 120 || /[\r\n]/.test(raw.deepseekModel)) {
      throw new Error('DeepSeek 模型名称无效');
    }
  }
  for (const [key, label] of [['deepseekApiKey', 'DeepSeek API Key'], ['touchgalToken', 'TouchGal 令牌']]) {
    if (Object.hasOwn(raw, key) && (typeof raw[key] !== 'string' || raw[key].length > 1024 || /[\r\n]/.test(raw[key]))) {
      throw new Error(`${label}格式无效`);
    }
  }
  if (Object.hasOwn(raw, 'touchgalDomain')) validateDomainName(raw.touchgalDomain, 'TouchGal 域名');
  if (Object.hasOwn(raw, 'shionlibDomain')) validateDomainName(raw.shionlibDomain, '书音图书馆域名');
  for (const [key, min, max] of [
    ['timeoutSeconds', 15, 120],
    ['maxResults', 1, RESOURCE_SEARCH_LIMIT_MAX],
    ['cooldownSeconds', 0, 3600]
  ]) {
    if (Object.hasOwn(raw, key) && (!Number.isInteger(raw[key]) || raw[key] < min || raw[key] > max)) {
      throw new Error(`资源检索设置 ${key} 必须在 ${min}—${max} 之间`);
    }
  }
}

export function resourceSearchConfig(raw = {}) {
  const input = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const rawSources = input.sources && typeof input.sources === 'object' && !Array.isArray(input.sources) ? input.sources : {};
  const sources = { ...DEFAULT_RESOURCE_SEARCH_CONFIG.sources };
  for (const key of RESOURCE_SEARCH_SOURCES) {
    if (typeof rawSources[key] === 'boolean') sources[key] = rawSources[key];
  }
  let proxyUrl = '';
  if (typeof input.proxyUrl === 'string' && input.proxyUrl.trim()) {
    try {
      validateProxyUrl(input.proxyUrl.trim());
      proxyUrl = input.proxyUrl.trim();
    } catch { proxyUrl = ''; }
  }
  const config = {
    ...structuredClone(DEFAULT_RESOURCE_SEARCH_CONFIG),
    enabled: input.enabled === true,
    allowPrivate: input.allowPrivate === true,
    includeImages: input.includeImages !== false,
    safeGroupLinks: input.safeGroupLinks !== false,
    allowedGroups: Array.isArray(input.allowedGroups)
      ? [...new Set(input.allowedGroups.map(String).filter((id) => /^\d{5,15}$/.test(id)))].slice(0, 500)
      : [],
    cooldownSeconds: Number.isInteger(input.cooldownSeconds) && input.cooldownSeconds >= 0 && input.cooldownSeconds <= 3600
      ? input.cooldownSeconds : DEFAULT_RESOURCE_SEARCH_CONFIG.cooldownSeconds,
    timeoutSeconds: Number.isInteger(input.timeoutSeconds) && input.timeoutSeconds >= 15 && input.timeoutSeconds <= 120
      ? input.timeoutSeconds : DEFAULT_RESOURCE_SEARCH_CONFIG.timeoutSeconds,
    maxResults: Number.isInteger(input.maxResults) && input.maxResults >= 1 && input.maxResults <= RESOURCE_SEARCH_LIMIT_MAX
      ? input.maxResults : DEFAULT_RESOURCE_SEARCH_CONFIG.maxResults,
    deepseekBaseUrl: typeof input.deepseekBaseUrl === 'string' && input.deepseekBaseUrl.trim()
      ? input.deepseekBaseUrl.trim() : DEFAULT_RESOURCE_SEARCH_CONFIG.deepseekBaseUrl,
    deepseekModel: typeof input.deepseekModel === 'string' && input.deepseekModel.trim()
      ? input.deepseekModel.trim() : DEFAULT_RESOURCE_SEARCH_CONFIG.deepseekModel,
    deepseekApiKey: typeof input.deepseekApiKey === 'string' ? input.deepseekApiKey.trim() : '',
    touchgalDomain: typeof input.touchgalDomain === 'string' && /^[a-z0-9.-]{3,120}$/i.test(input.touchgalDomain.trim())
      ? input.touchgalDomain.trim() : DEFAULT_RESOURCE_SEARCH_CONFIG.touchgalDomain,
    touchgalToken: typeof input.touchgalToken === 'string' ? input.touchgalToken.trim() : '',
    shionlibDomain: typeof input.shionlibDomain === 'string' && /^[a-z0-9.-]{3,120}$/i.test(input.shionlibDomain.trim())
      ? input.shionlibDomain.trim() : DEFAULT_RESOURCE_SEARCH_CONFIG.shionlibDomain,
    proxyUrl,
    sources
  };
  return config;
}
