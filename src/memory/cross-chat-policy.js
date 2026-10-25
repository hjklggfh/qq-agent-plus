import crypto from 'node:crypto';
// Settings helpers shared by config validation and runtime recall.
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
  if (Object.hasOwn(value, 'chats')) {
    const chats = value.chats?.__replace__ || value.chats;
    if (!chats || typeof chats !== 'object' || Array.isArray(chats) || Object.keys(chats).length > 200) throw new Error('会话隐私规则最多200项');
    for (const [key, rule] of Object.entries(chats)) {
      if (!/^(group|private):\d{1,15}$/.test(key) || !rule || typeof rule !== 'object' || Array.isArray(rule)) throw new Error('会话隐私规则格式无效');
      for (const field of Object.keys(rule)) if (!['allowSource', 'allowTarget', 'privacy'].includes(field) || typeof rule[field] !== 'boolean') throw new Error('会话隐私规则只接受三个布尔开关');
    }
  }
  if (Object.hasOwn(value, 'excludedMessages')) {
    if (!Array.isArray(value.excludedMessages) || value.excludedMessages.length > 500
      || value.excludedMessages.some(ref => !ref || !/^(group|private):\d{1,15}$/.test(ref.chatKey)
        || !Number.isSafeInteger(ref.id) || ref.id < 1 || !['incorrect', 'never'].includes(ref.reason))) throw new Error('回忆排除列表格式无效或超过500条');
  }
}
export function chatRecallRule(cfg = {}, chatKey = '') {
  const rule = cfg.memory?.crossChat?.chats?.[chatKey] || {};
  return { allowSource: rule.allowSource !== false, allowTarget: rule.allowTarget !== false, privacy: rule.privacy === true };
}
export function privateRecallContext(cfg = {}, chatKey = '') {
  const rule = chatRecallRule(cfg, chatKey);
  return cfg.memory?.crossChat?.privacy === true || rule.privacy || !rule.allowTarget;
}
export function recallPolicyKey(cfg = {}) {
  return JSON.stringify([crossChatSettings(cfg), cfg.memory?.crossChat?.chats || {}, cfg.memory?.crossChat?.excludedMessages || [], cfg.memory?.visibility || {}, cfg.allow || {}, cfg.deny || {},
    cfg.allowAllWhenEmpty === true, cfg.blocklist || {}]);
}
export function recallPolicyFingerprint(cfg = {}) {
  return crypto.createHash('sha256').update(recallPolicyKey(cfg)).digest('hex');
}
