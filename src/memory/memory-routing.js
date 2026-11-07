// 双人设的记忆路由：按会话当前的人设档（home = 默认人设 / alt = 第二人设）选记忆实例。
//
// 为什么需要这一层：记忆不再是"一份"，而是每个会话可能各有各的库。
// 只要有一处（提示词注入、memory_* 工具、交接、自动整理、控制台记忆页）绕过它，
// 就会出现"读的是这个、写的是那个"——第二人设能看到默认人设的群印象，
// 或者它在控制台里改的东西落到了模型根本不会读的那份里。
//
// 约定：
//   - 功能关闭 / 会话在默认人设 / 没配第二实例 → 一律回主实例，行为与升级前逐字一致；
//   - 只有 personaSwitch.enabled 为真时才去读状态文件，关闭时零额外 I/O。
import path from 'node:path';
import { DATA_DIR, getConfig } from '../core/config.js';
import { personaSwitchConfig, resolveChatProfile } from '../core/persona-switch.js';

/** 第二人设记忆库的目录名。固定不跟配置里的显示名走：改个名字不该搬数据。 */
export const ALT_MEMORY_DIR_NAME = 'memory-alt';

/** 第二人设记忆库的绝对路径（主实例是 DATA_DIR/memory，见 memory-global.js）。 */
export const ALT_MEMORY_ROOT = path.join(DATA_DIR, ALT_MEMORY_DIR_NAME);

/**
 * 解析某个会话当前生效的人设档。
 * 功能关掉时直接返回 'home'，连状态文件都不读。
 */
export function resolveProfileForChat(chatKey, { now = Date.now(), settings = null } = {}) {
  if (!chatKey) return 'home';
  const cfg = settings || personaSwitchConfig(getConfig().personaSwitch);
  if (!cfg.enabled) return 'home';
  return resolveChatProfile(chatKey, now, cfg).profile;
}

/** 按人设档取实例；第二实例不存在（或功能没开）时退回主实例。 */
export function memoryStoreForProfile(stores, profile) {
  if (profile === 'alt' && stores?.alt) return stores.alt;
  return stores?.main || null;
}

/**
 * 按会话取记忆实例。
 * @param {{main: object, alt?: object|null}} stores
 * @param {string} chatKey
 * @param {{profile?: string|null, now?: number, settings?: object|null}} [options]
 *   profile 已知时直接传进来，避免重复读状态文件（编排器每轮已经算过一次）。
 */
export function memoryStoreForChat(stores, chatKey, { profile = null, now = Date.now(), settings = null } = {}) {
  const resolved = profile || resolveProfileForChat(chatKey, { now, settings });
  return memoryStoreForProfile(stores, resolved);
}
