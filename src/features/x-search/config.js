export const DEFAULT_X_SEARCH_CONFIG = Object.freeze({
  enabled: false, apiBaseUrl: 'https://api.x.com', bearerToken: '',
  includeReplies: false, includeReposts: false, includeImages: true,
  timeoutSeconds: 20, cooldownSeconds: 15
});

export function validateXSearchPatch(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('X 设置须为对象');
  for (const [key, value] of Object.entries(patch)) {
    if (!(key in DEFAULT_X_SEARCH_CONFIG)) throw new Error(`未知 X 设置：${key}`);
    if (typeof DEFAULT_X_SEARCH_CONFIG[key] === 'boolean' && typeof value !== 'boolean') throw new Error('X 开关须为布尔值');
    if (key === 'bearerToken' && (typeof value !== 'string' || value.length > 4096 || /\s/.test(value))) throw new Error('X Token 格式无效');
    if (key === 'apiBaseUrl') {
      if (typeof value !== 'string' || value.length > 2048) throw new Error('X 接口地址无效');
      const url = new URL(value);
      if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
        throw new Error('X 接口须为 HTTPS 根地址，不能包含凭据、路径或查询参数');
      }
    }
  }
  for (const [key, min, max] of [['timeoutSeconds', 5, 60], ['cooldownSeconds', 5, 300]]) {
    if (key in patch && (!Number.isInteger(patch[key]) || patch[key] < min || patch[key] > max)) throw new Error(`${key} 必须在 ${min}—${max} 之间`);
  }
}

export function xSearchConfig(raw = {}) {
  // 手写坏配置只关闭本功能，不能阻止整个 Agent 启动；写入 API 仍严格校验。
  try { validateXSearchPatch(raw); }
  catch { return { ...DEFAULT_X_SEARCH_CONFIG }; }
  const config = { ...DEFAULT_X_SEARCH_CONFIG, ...raw };
  config.apiBaseUrl = new URL(config.apiBaseUrl).origin;
  return config;
}
