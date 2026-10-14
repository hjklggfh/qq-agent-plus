export const DEFAULT_TRPG_CONFIG = Object.freeze({ enabled: false, maxPlayers: 6, allowedGroups: Object.freeze([]), allowedPrivate: Object.freeze([]) });

function ids(value) {
  return Array.isArray(value) ? [...new Set(value.filter((id) => typeof id === 'string' && /^\d{5,15}$/.test(id)))] : [];
}

export function trpgConfig(raw = {}) {
  return {
    enabled: raw?.enabled === true,
    maxPlayers: Math.min(6, Math.max(1, Math.floor(Number(raw?.maxPlayers) || 6))),
    allowedGroups: ids(raw?.allowedGroups),
    allowedPrivate: ids(raw?.allowedPrivate)
  };
}

export function validateTrpgPatch(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('跑团配置必须是对象');
  if (Object.hasOwn(raw, 'enabled') && typeof raw.enabled !== 'boolean') throw new Error('跑团开关必须是布尔值');
  if (Object.hasOwn(raw, 'maxPlayers') && (!Number.isInteger(raw.maxPlayers) || raw.maxPlayers < 1 || raw.maxPlayers > 6)) {
    throw new Error('跑团人数必须为 1—6');
  }
  for (const key of ['allowedGroups', 'allowedPrivate']) {
    if (Object.hasOwn(raw, key) && (!Array.isArray(raw[key]) || raw[key].length > 500 || raw[key].some((id) => typeof id !== 'string' || !/^\d{5,15}$/.test(id)))) {
      throw new Error('跑团白名单必须为最多500项的群号或QQ号文本数组（5—15位数字）');
    }
  }
}
