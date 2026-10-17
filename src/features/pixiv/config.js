export const PIXIV_TOOL_NAMES = Object.freeze(['pixiv_image', 'pixiv_set_rating']);
export const DEFAULT_PIXIV_CONFIG = Object.freeze({
  enabled: false, ratings: ['safe'], chatRatings: {}, chatRatingsMigrated: false, unknownRatingPolicy: 'deny',
  imageSize: 'regular', maxCount: 1, maxPages: 100, timeoutMs: 15000,
  outputFormat: 'images', maxPdfPages: 500, pdfMaxBytes: 256 * 1024 * 1024,
  taskTimeoutSeconds: 300, forwardBudgetBytes: 4 * 1024 * 1024,
  maxImageBytes: 5 * 1024 * 1024, pagesPerBatch: 10,
  downsampleOverBytes: 800 * 1024, downsampleMaxEdge: 1200,
  downsampleQuality: 5, cooldownSeconds: 10, metadataUrlTemplate: '',
  searchBackend: 'auto', loliconApiUrl: 'https://api.lolicon.app/setu/v2',
  searchUrlTemplate: 'https://www.pixiv.net/ajax/search/artworks/{kw}?word={kw}&order=date_d&mode=all&p={page}&s_mode=s_tag&type=all&lang=zh',
  imageUrlTemplate: 'https://pixiv.re/{pid}.png', proxyUrl: '', cookie: '',
  userAgent: '', excludeAI: false, stateCap: 2000, retryCandidates: 3,
  deadTtlDays: 7, poolSize: 5, pageRetryOnce: 1
});
const RATINGS = ['safe', 'r18', 'r18g'];
export function validRatings(value) {
  return Array.isArray(value) && value.length > 0 && value.length <= 3 && value.every((v) => RATINGS.includes(v));
}
export function validatePixivPatch(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('PID 设置须为对象');
  for (const [key, value] of Object.entries(patch)) {
    if (key.startsWith('has')) continue;
    if (!(key in DEFAULT_PIXIV_CONFIG)) throw new Error(`未知 PID 设置：${key}`);
    if (['enabled', 'excludeAI', 'chatRatingsMigrated'].includes(key) && typeof value !== 'boolean') throw new Error('PID 开关须为布尔值');
    if (key === 'ratings' && !validRatings(value)) throw new Error('至少允许一种有效分级');
    const chats = value?.__replace__ ?? value;
    if (key === 'chatRatings' && (!chats || typeof chats !== 'object' || Array.isArray(chats)
      || Object.entries(chats).some(([chat, ratings]) => !/^(group|private):\d{5,15}$/.test(chat) || !validRatings(ratings)))) throw new Error('会话分级格式无效');
    if (key === 'unknownRatingPolicy' && !['deny', 'adult-only'].includes(value)) throw new Error('未知分级策略无效');
    if (key === 'imageSize' && !['original', 'regular', 'small', 'thumb', 'mini'].includes(value)) throw new Error('图片尺寸无效');
    if (key === 'outputFormat' && !['images', 'pdf'].includes(value)) throw new Error('发送方式无效');
    if (key === 'searchBackend' && !['auto', 'builtin', 'pixiv'].includes(value)) throw new Error('检索方式无效');
    if (typeof DEFAULT_PIXIV_CONFIG[key] === 'string' && (typeof value !== 'string' || value.length > 4096 || /[\r\n]/.test(value))) throw new Error('设置文本格式无效');
    if (['metadataUrlTemplate', 'loliconApiUrl', 'searchUrlTemplate', 'imageUrlTemplate', 'proxyUrl'].includes(key) && value) {
      const url = new URL(value.replaceAll('{pid}', '12345678').replaceAll('{kw}', 'test').replaceAll('{page}', '1'));
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) throw new Error('地址须为无凭据的 HTTP(S) 地址');
      if (key === 'metadataUrlTemplate' && !value.includes('{pid}')) throw new Error('作品详情地址必须包含 {pid}');
    }
  }
  for (const [key, min, max] of [
    ['maxPdfPages', 1, 1000], ['pdfMaxBytes', 1048576, 536870912],
    ['maxPages', 1, 100], ['maxCount', 1, 5], ['pagesPerBatch', 1, 20], ['timeoutMs', 3000, 60000],
    ['taskTimeoutSeconds', 30, 600], ['forwardBudgetBytes', 256 * 1024, 8 * 1024 * 1024],
    ['maxImageBytes', 64 * 1024, 16 * 1024 * 1024], ['downsampleOverBytes', 0, 16 * 1024 * 1024],
    ['downsampleMaxEdge', 256, 4096], ['downsampleQuality', 2, 31], ['cooldownSeconds', 0, 3600],
    ['stateCap', 50, 10000], ['retryCandidates', 0, 10], ['deadTtlDays', 0, 365], ['poolSize', 1, 50], ['pageRetryOnce', 0, 2]
  ]) if (key in patch && (!Number.isInteger(patch[key]) || patch[key] < min || patch[key] > max)) throw new Error(`${key} 必须在 ${min}—${max} 之间`);
}
export function pixivConfig(raw = {}) {
  return { ...structuredClone(DEFAULT_PIXIV_CONFIG), ...raw };
}

// 先于默认值合并执行。旧插件设置仅归档保留，旧插件不再装载。
export function migratePixivConfig(config) {
  const old = config.plugins?.settings?.['pixiv-illust'] || {};
  if (!config.pixiv && (config.plugins?.enabled?.includes('pixiv-illust') || Object.keys(old).length)) {
    config.pixiv = Object.fromEntries(Object.entries(old).filter(([k]) => k in DEFAULT_PIXIV_CONFIG));
    config.pixiv.enabled = config.plugins?.enabled?.includes('pixiv-illust') === true && old.enabled !== false;
    if (!config.pixiv.ratings) config.pixiv.ratings = old.allowR18 ? ['safe', 'r18'] : ['safe'];
    config.pixiv.unknownRatingPolicy = 'adult-only';
    // 原来的20页是单卡限制；内置版本分批，保留用户显式设置的页数上限。
  }
  if (Array.isArray(config.plugins?.enabled)) config.plugins.enabled = config.plugins.enabled.filter((id) => id !== 'pixiv-illust');
  return config;
}
