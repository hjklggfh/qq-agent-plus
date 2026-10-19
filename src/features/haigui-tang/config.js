export const DEFAULT_HAIGUI_TANG_CONFIG = Object.freeze({
  enabled: false,
  allowedChats: [],
  includeDark: true,
  maxStars: 5,
  sessionHours: 3,
  hintLimit: 3,
  revealAfterQuestions: 5,
  showRules: true,
  avoidRepeat: true
});

export function haiguiTangConfig(raw = {}) {
  return { ...DEFAULT_HAIGUI_TANG_CONFIG, ...raw };
}

export function validateHaiguiTangPatch(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('海龟汤设置须为对象');
  for (const [key, value] of Object.entries(patch)) {
    if (!(key in DEFAULT_HAIGUI_TANG_CONFIG)) throw new Error(`未知海龟汤设置：${key}`);
    if (['enabled', 'includeDark', 'showRules', 'avoidRepeat'].includes(key) && typeof value !== 'boolean') {
      throw new Error(`${key} 须为布尔值`);
    }
    if (key === 'allowedChats' && (!Array.isArray(value) || value.length > 100
      || value.some((chat) => typeof chat !== 'string' || !/^(group|private):\d{5,15}$/.test(chat)))) {
      throw new Error('海龟汤允许会话格式无效');
    }
  }
  for (const [key, min, max] of [
    ['maxStars', 3, 5], ['sessionHours', 1, 24], ['hintLimit', 0, 10], ['revealAfterQuestions', 0, 30]
  ]) {
    if (key in patch && (!Number.isInteger(patch[key]) || patch[key] < min || patch[key] > max)) {
      throw new Error(`${key} 必须在 ${min}—${max} 之间`);
    }
  }
}
