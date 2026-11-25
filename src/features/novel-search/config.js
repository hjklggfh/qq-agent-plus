export const NOVEL_SUMMARY_MODES = Object.freeze(['clean', 'minimal']);
export const NOVEL_SOURCES = Object.freeze(['pixiv', 'cool18', 'esjzone', 'telegram']);

export const DEFAULT_NOVEL_CHANNELS = Object.freeze([
  Object.freeze({
    id: 'px_novels',
    label: '蓝P官能文学社',
    aliases: Object.freeze(['蓝p', '蓝P', 'px']),
    enabled: true,
    summaryMode: 'clean'
  }),
  Object.freeze({
    id: 'happylibrary',
    label: '开心书库',
    aliases: Object.freeze(['开心', 'happy', '开心书库']),
    enabled: true,
    summaryMode: 'clean'
  })
]);

export const DEFAULT_NOVEL_SEARCH_CONFIG = Object.freeze({
  enabled: false,
  allowPrivate: false,
  allowedGroups: Object.freeze([]),
  relayUrl: 'http://127.0.0.1:3224',
  relayToken: '',
  pixivCookie: '',
  pixivMinChars: 1500,
  esjMaxChapters: 80,
  cooldownSeconds: 8,
  downloadCooldownSeconds: 10,
  timeoutSeconds: 60,
  pageSize: 8,
  maxFileSizeMb: 30,
  summaryMode: 'clean',
  normalizeTxt: true,
  sources: Object.freeze({
    pixiv: true,
    cool18: true,
    esjzone: true,
    telegram: true
  }),
  channels: DEFAULT_NOVEL_CHANNELS
});

export function validateNovelRelayUrl(value) {
  if (value === '') return;
  let url;
  try { url = new URL(value); } catch { throw new Error('小说中转地址无效'); }
  const loopback = ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))
    || url.username || url.password || url.search || url.hash) {
    throw new Error('小说中转地址须为本机 HTTP（如 http://127.0.0.1:3224）或 HTTPS 地址，且不含凭据与查询参数');
  }
}

function validateChannelEntry(item) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) {
    throw new Error('频道配置项必须为对象');
  }
  const id = String(item.id || '').trim().replace(/^@+/, '').toLowerCase();
  if (!/^[a-z0-9_]{3,64}$/.test(id)) {
    throw new Error(`非法频道用户名：${String(item.id || '')}（仅支持 3—64 位字母、数字、下划线）`);
  }
  if (Object.hasOwn(item, 'label') && (typeof item.label !== 'string' || item.label.length > 40 || /[\r\n]/.test(item.label))) {
    throw new Error(`频道 ${id} 显示名称无效`);
  }
  if (Object.hasOwn(item, 'enabled') && typeof item.enabled !== 'boolean') {
    throw new Error(`频道 ${id} 启用状态必须为布尔值`);
  }
  if (Object.hasOwn(item, 'summaryMode') && !NOVEL_SUMMARY_MODES.includes(item.summaryMode)) {
    throw new Error(`频道 ${id} 展示模式仅支持 clean 或 minimal`);
  }
  if (Object.hasOwn(item, 'aliases') && (!Array.isArray(item.aliases) || item.aliases.length > 20
    || item.aliases.some((a) => typeof a !== 'string' || !a.trim() || a.length > 24 || /[\r\n]/.test(a)))) {
    throw new Error(`频道 ${id} 别名列表无效`);
  }
}

export function validateNovelSearchPatch(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('小说检索配置必须为对象');
  for (const key of Object.keys(raw)) {
    if (!Object.hasOwn(DEFAULT_NOVEL_SEARCH_CONFIG, key) && !key.startsWith('has')) {
      throw new Error(`未知小说检索设置：${key}`);
    }
  }
  for (const key of ['enabled', 'allowPrivate', 'normalizeTxt']) {
    if (Object.hasOwn(raw, key) && typeof raw[key] !== 'boolean') {
      throw new Error('小说检索开关必须为布尔值');
    }
  }
  if (Object.hasOwn(raw, 'allowedGroups') && (!Array.isArray(raw.allowedGroups) || raw.allowedGroups.length > 500
    || raw.allowedGroups.some((id) => typeof id !== 'string' || !/^\d{5,15}$/.test(id)))) {
    throw new Error('小说检索群白名单须为最多500项群号文本数组');
  }
  if (Object.hasOwn(raw, 'sources') && (!raw.sources || Array.isArray(raw.sources) || typeof raw.sources !== 'object'
    || Object.entries(raw.sources).some(([key, value]) => !NOVEL_SOURCES.includes(key) || typeof value !== 'boolean'))) {
    throw new Error('小说检索数据源开关无效');
  }
  if (Object.hasOwn(raw, 'relayUrl')) {
    if (typeof raw.relayUrl !== 'string' || raw.relayUrl.length > 200) {
      throw new Error('小说中转地址必须为文本');
    }
    validateNovelRelayUrl(raw.relayUrl.trim());
  }
  for (const [key, label, maxLen] of [
    ['relayToken', '小说中转令牌', 1024],
    ['pixivCookie', 'Pixiv Cookie', 4096]
  ]) {
    if (Object.hasOwn(raw, key) && (typeof raw[key] !== 'string' || raw[key].length > maxLen || /[\r\n]/.test(raw[key]))) {
      throw new Error(`${label}格式无效`);
    }
  }
  if (Object.hasOwn(raw, 'summaryMode') && !NOVEL_SUMMARY_MODES.includes(raw.summaryMode)) {
    throw new Error('简介展示模式仅支持 clean 或 minimal');
  }
  if (Object.hasOwn(raw, 'channels')) {
    if (!Array.isArray(raw.channels) || raw.channels.length === 0 || raw.channels.length > 20) {
      throw new Error('频道列表须包含 1—20 个频道');
    }
    for (const item of raw.channels) validateChannelEntry(item);
  }
  for (const [key, min, max] of [
    ['cooldownSeconds', 0, 3600],
    ['downloadCooldownSeconds', 0, 3600],
    ['timeoutSeconds', 10, 180],
    ['pageSize', 5, 10],
    ['maxFileSizeMb', 1, 100],
    ['pixivMinChars', 0, 20000],
    ['esjMaxChapters', 1, 200]
  ]) {
    if (Object.hasOwn(raw, key) && (!Number.isInteger(raw[key]) || raw[key] < min || raw[key] > max)) {
      throw new Error(`小说检索设置 ${key} 必须在 ${min}—${max} 之间`);
    }
  }
}

function normalizeChannels(rawChannels, fallbackSummaryMode = 'clean') {
  const source = Array.isArray(rawChannels) && rawChannels.length ? rawChannels : DEFAULT_NOVEL_CHANNELS;
  const seen = new Set();
  const list = [];
  for (const item of source) {
    if (!item || typeof item !== 'object') continue;
    const id = String(item.id || '').trim().replace(/^@+/, '').toLowerCase();
    if (!/^[a-z0-9_]{3,64}$/.test(id) || seen.has(id)) continue;
    seen.add(id);
    const label = String(item.label || id).trim().slice(0, 40) || id;
    const aliases = Array.isArray(item.aliases)
      ? [...new Set(item.aliases.map((a) => String(a || '').trim()).filter((a) => a && a.length <= 24))].slice(0, 20)
      : [];
    const summaryMode = NOVEL_SUMMARY_MODES.includes(item.summaryMode) ? item.summaryMode : fallbackSummaryMode;
    list.push({ id, label, aliases, enabled: item.enabled !== false, summaryMode });
  }
  return list.length ? list : structuredClone(DEFAULT_NOVEL_CHANNELS);
}

export function novelSearchConfig(raw = {}) {
  const input = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const summaryMode = NOVEL_SUMMARY_MODES.includes(input.summaryMode)
    ? input.summaryMode : DEFAULT_NOVEL_SEARCH_CONFIG.summaryMode;
  let relayUrl = DEFAULT_NOVEL_SEARCH_CONFIG.relayUrl;
  if (typeof input.relayUrl === 'string' && input.relayUrl.trim()) {
    try {
      validateNovelRelayUrl(input.relayUrl.trim());
      relayUrl = input.relayUrl.trim().replace(/\/+$/, '');
    } catch { relayUrl = DEFAULT_NOVEL_SEARCH_CONFIG.relayUrl; }
  }
  const rawSources = input.sources && typeof input.sources === 'object' && !Array.isArray(input.sources) ? input.sources : {};
  const sources = { ...DEFAULT_NOVEL_SEARCH_CONFIG.sources };
  for (const key of NOVEL_SOURCES) {
    if (typeof rawSources[key] === 'boolean') sources[key] = rawSources[key];
  }
  return {
    enabled: input.enabled === true,
    allowPrivate: input.allowPrivate === true,
    allowedGroups: Array.isArray(input.allowedGroups)
      ? [...new Set(input.allowedGroups.map(String).filter((id) => /^\d{5,15}$/.test(id)))].slice(0, 500)
      : [],
    relayUrl,
    relayToken: typeof input.relayToken === 'string' ? input.relayToken.trim() : '',
    pixivCookie: typeof input.pixivCookie === 'string' ? input.pixivCookie.trim() : '',
    pixivMinChars: Number.isInteger(input.pixivMinChars) && input.pixivMinChars >= 0 && input.pixivMinChars <= 20000
      ? input.pixivMinChars : DEFAULT_NOVEL_SEARCH_CONFIG.pixivMinChars,
    esjMaxChapters: Number.isInteger(input.esjMaxChapters) && input.esjMaxChapters >= 1 && input.esjMaxChapters <= 200
      ? input.esjMaxChapters : DEFAULT_NOVEL_SEARCH_CONFIG.esjMaxChapters,
    cooldownSeconds: Number.isInteger(input.cooldownSeconds) && input.cooldownSeconds >= 0 && input.cooldownSeconds <= 3600
      ? input.cooldownSeconds : DEFAULT_NOVEL_SEARCH_CONFIG.cooldownSeconds,
    downloadCooldownSeconds: Number.isInteger(input.downloadCooldownSeconds) && input.downloadCooldownSeconds >= 0 && input.downloadCooldownSeconds <= 3600
      ? input.downloadCooldownSeconds : DEFAULT_NOVEL_SEARCH_CONFIG.downloadCooldownSeconds,
    timeoutSeconds: Number.isInteger(input.timeoutSeconds) && input.timeoutSeconds >= 10 && input.timeoutSeconds <= 180
      ? input.timeoutSeconds : DEFAULT_NOVEL_SEARCH_CONFIG.timeoutSeconds,
    pageSize: Number.isInteger(input.pageSize) && input.pageSize >= 5 && input.pageSize <= 10
      ? input.pageSize : DEFAULT_NOVEL_SEARCH_CONFIG.pageSize,
    maxFileSizeMb: Number.isInteger(input.maxFileSizeMb) && input.maxFileSizeMb >= 1 && input.maxFileSizeMb <= 100
      ? input.maxFileSizeMb : DEFAULT_NOVEL_SEARCH_CONFIG.maxFileSizeMb,
    summaryMode,
    normalizeTxt: input.normalizeTxt !== false,
    sources,
    channels: normalizeChannels(input.channels, summaryMode)
  };
}
