export const DEFAULT_TRPG_CONFIG = Object.freeze({ enabled: false, maxPlayers: 6 });

export function trpgConfig(raw = {}) {
  return {
    enabled: raw?.enabled === true,
    maxPlayers: Math.min(6, Math.max(1, Math.floor(Number(raw?.maxPlayers) || 6)))
  };
}

export function validateTrpgPatch(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('跑团配置必须是对象');
  if (Object.hasOwn(raw, 'enabled') && typeof raw.enabled !== 'boolean') throw new Error('跑团开关必须是布尔值');
  if (Object.hasOwn(raw, 'maxPlayers') && (!Number.isInteger(raw.maxPlayers) || raw.maxPlayers < 1 || raw.maxPlayers > 6)) {
    throw new Error('跑团人数必须为 1—6');
  }
}
