// Pure settings helpers: shared by config validation and runtime recall.
export const CROSS_CHAT_DEFAULTS = Object.freeze({
  enabled: false, privacy: false, maxChars: 1200, maxMessages: 4, lookbackDays: 30
});
const limits = { maxChars: [300, 3000], maxMessages: [1, 8], lookbackDays: [1, 90] };
export function crossChatSettings(cfg = {}) {
  const raw = cfg.memory?.crossChat || {};
  const out = { ...CROSS_CHAT_DEFAULTS, enabled: raw.enabled === true, privacy: raw.privacy === true };
  for (const [key, [min, max]] of Object.entries(limits)) {
    const value = Number(raw[key]);
    out[key] = Number.isFinite(value) ? Math.min(max, Math.max(min, Math.floor(value))) : out[key];
  }
  if (cfg.tokenSaver?.mode === 'balanced') out.maxChars = Math.min(out.maxChars, 900);
  if (cfg.tokenSaver?.mode === 'aggressive') out.maxChars = Math.min(out.maxChars, 600);
  return out;
}
export function validateCrossChatPatch(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.__replace__) throw new Error('跨对话记忆设置必须为普通对象');
  for (const key of ['enabled', 'privacy']) {
    if (Object.hasOwn(value, key) && typeof value[key] !== 'boolean') throw new Error(`跨对话记忆 ${key} 必须为布尔值`);
  }
  for (const [key, [min, max]] of Object.entries(limits)) {
    if (Object.hasOwn(value, key) && (!Number.isInteger(value[key]) || value[key] < min || value[key] > max)) {
      throw new Error(`跨对话记忆 ${key} 必须为 ${min}–${max} 的整数`);
    }
  }
}
export function recallPolicyKey(cfg = {}) {
  return JSON.stringify([crossChatSettings(cfg), cfg.memory?.visibility || {}, cfg.allow || {}, cfg.deny || {},
    cfg.allowAllWhenEmpty === true, cfg.blocklist || {}]);
}
