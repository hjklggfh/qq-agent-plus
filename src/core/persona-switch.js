// 双人设：按会话（群/私聊）临时切到第二人设，闲置超时自动交还默认人设。
//
// 设计要点：
//   - 状态按 chatKey 独立，互不影响；
//   - 计时基准是"第二人设最近一次真正发出消息"的时间（调用方在发送成功后 touch）；
//   - 触发需要"关键词 + 呼叫语境"（@ 或动词），避免群友正常讨论模型名时误切；
//   - 控制标签（如 [SWITCH_TO_GEMINI]）由模型自行输出，这里只负责识别与剥离。
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, getConfig } from './config.js';

export const DEFAULT_PERSONA_SWITCH = Object.freeze({
  enabled: false,
  idleMinutes: 30,
  cooldownSeconds: 60,
  // 第二人设（默认 Claude）；正文由配置提供，不写死在代码里
  altName: 'Claude',
  altModel: '',
  altTemplateId: '',
  altRoleText: '',
  altCustomRules: '',
  altBehaviorProfile: 'legacy',
  callWords: ['claude', '克劳德'],
  homeWords: ['gemi', '哈基米'],
  callVerbs: ['呼叫', '叫', '喊', '出来', '换', '值班', '接管', '救命', '在吗', '来']
});

const STATE_FILE = () => path.join(DATA_DIR, 'persona-state.json');
const MAX_AGE_MS = 7 * 24 * 3600 * 1000;

/** 合并配置里的开关（缺字段用默认值，类型不对也回退默认）。 */
export function personaSwitchConfig(raw = {}) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const num = (value, fallback, min, max) => {
    const n = Number(value);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback;
  };
  const words = (value, fallback) => {
    const list = (Array.isArray(value) ? value : [])
      .map((item) => String(item ?? '').trim().toLowerCase())
      .filter(Boolean);
    return list.length ? list : fallback;
  };
  return {
    enabled: src.enabled === true,
    idleMinutes: num(src.idleMinutes, DEFAULT_PERSONA_SWITCH.idleMinutes, 1, 24 * 60),
    cooldownSeconds: num(src.cooldownSeconds, DEFAULT_PERSONA_SWITCH.cooldownSeconds, 0, 3600),
    altName: String(src.altName || DEFAULT_PERSONA_SWITCH.altName).trim().slice(0, 40),
    altModel: String(src.altModel || '').trim(),
    altTemplateId: String(src.altTemplateId || '').trim(),
    altRoleText: String(src.altRoleText || ''),
    altCustomRules: String(src.altCustomRules || ''),
    altBehaviorProfile: src.altBehaviorProfile === 'grounded' ? 'grounded' : 'legacy',
    callWords: words(src.callWords, DEFAULT_PERSONA_SWITCH.callWords),
    homeWords: words(src.homeWords, DEFAULT_PERSONA_SWITCH.homeWords),
    callVerbs: words(src.callVerbs, DEFAULT_PERSONA_SWITCH.callVerbs)
  };
}

/** 第二人设是否可用：开关打开、有正文、有模型。 */
export function altPersonaReady(settings) {
  return Boolean(settings?.enabled && settings.altModel && String(settings.altRoleText || '').trim());
}

function readState() {
  try {
    const raw = JSON.parse(fs.readFileSync(STATE_FILE(), 'utf8'));
    return raw && typeof raw === 'object' ? raw : {};
  } catch { return {}; }
}

function writeState(state) {
  const file = STATE_FILE();
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, file);
    fs.chmodSync(file, 0o600);
  } catch { /* 状态文件写失败不阻断对话：最坏是这一次切换没记住 */ }
}

function prune(state, now) {
  let changed = false;
  for (const [key, entry] of Object.entries(state)) {
    if (!entry || typeof entry !== 'object' || now - Number(entry.lastSwitchAt || 0) > MAX_AGE_MS) {
      delete state[key];
      changed = true;
    }
  }
  return changed;
}

/**
 * 识别"叫某人出来"的请求。返回 'alt'（切第二人设）/ 'home'（切回默认）/ null。
 * 只匹配关键词还不够：群里正常讨论模型名很常见，所以要求同时有 @（mention）
 * 或者明确的呼叫动词，否则不动。
 */
export function matchSwitchRequest(text, { mention = false, settings } = {}) {
  const cfg = settings || personaSwitchConfig(getConfig().personaSwitch);
  const body = String(text || '').toLowerCase();
  if (!body) return null;
  const hit = (list) => list.some((word) => body.includes(word));
  const verb = cfg.callVerbs.some((word) => body.includes(word));
  const alt = hit(cfg.callWords);
  const home = hit(cfg.homeWords);
  if (alt === home) return null;               // 都没提，或同时提到（拿不准就不切）
  if (!mention && !verb) return null;          // 纯提到名字、没有呼叫做派：不切
  return alt ? 'alt' : 'home';
}

/** 当前会话该用哪个人设。闲置超时在这里惰性判定，不需要额外定时器。 */
export function resolveChatProfile(chatKey, now = Date.now(), settings = null) {
  const cfg = settings || personaSwitchConfig(getConfig().personaSwitch);
  if (!altPersonaReady(cfg)) return { profile: 'home', since: 0 };
  const state = readState();
  const entry = state[chatKey];
  if (!entry || entry.profile !== 'alt') return { profile: 'home', since: 0 };
  const idle = cfg.idleMinutes * 60 * 1000;
  const last = Number(entry.lastReplyAt || entry.since || 0);
  if (!last || now - last > idle) {
    delete state[chatKey];
    writeState(state);
    return { profile: 'home', since: 0 };
  }
  return { profile: 'alt', since: Number(entry.since) || last };
}

/** 切换当前会话的人设；受冷却时间保护，避免反复横跳。 */
export function activateChatProfile(chatKey, profile, now = Date.now(), settings = null) {
  const cfg = settings || personaSwitchConfig(getConfig().personaSwitch);
  if (!chatKey) return { changed: false, reason: 'no-chat' };
  if (profile === 'alt' && !altPersonaReady(cfg)) return { changed: false, reason: 'not-ready' };
  const state = readState();
  prune(state, now);
  const entry = state[chatKey] || {};
  const sinceSwitch = now - Number(entry.lastSwitchAt || 0);
  if (entry.profile === profile) {
    if (profile === 'alt') { entry.lastSwitchAt = now; state[chatKey] = entry; writeState(state); }
    return { changed: false, reason: 'already' };
  }
  if (sinceSwitch < cfg.cooldownSeconds * 1000) return { changed: false, reason: 'cooldown' };
  if (profile === 'alt') {
    state[chatKey] = { profile: 'alt', since: now, lastReplyAt: now, lastSwitchAt: now };
  } else {
    delete state[chatKey];
  }
  writeState(state);
  return { changed: true, profile };
}

/** 第二人设真的发出消息后刷新计时（由发送路径调用）。 */
export function touchAltProfile(chatKey, now = Date.now()) {
  const state = readState();
  const entry = state[chatKey];
  if (!entry || entry.profile !== 'alt') return false;
  entry.lastReplyAt = now;
  state[chatKey] = entry;
  writeState(state);
  return true;
}

/** 清掉某个会话的临时状态（停用功能、或人工复位时用）。 */
export function clearChatProfile(chatKey) {
  const state = readState();
  if (!state[chatKey]) return false;
  delete state[chatKey];
  writeState(state);
  return true;
}

/** 当前所有处于第二人设的会话（控制台展示用）。 */
export function activeAltChats(now = Date.now()) {
  const cfg = personaSwitchConfig(getConfig().personaSwitch);
  const idle = cfg.idleMinutes * 60 * 1000;
  const state = readState();
  const out = [];
  for (const [chatKey, entry] of Object.entries(state)) {
    if (entry?.profile !== 'alt') continue;
    const last = Number(entry.lastReplyAt || entry.since || 0);
    if (!last || now - last > idle) continue;
    out.push({ chatKey, since: Number(entry.since) || last, lastReplyAt: last });
  }
  return out;
}

/**
 * 从文本里剥离控制标签。返回 { text, switchTo }：
 * switchTo = 'home' 表示模型自己要求交还值班权。
 */
export function stripSwitchTags(text) {
  const raw = String(text ?? '');
  if (!/\[switch_to_/i.test(raw)) return { text: raw, switchTo: null };
  let switchTo = null;
  let out = raw;
  const patterns = [
    [/\[\s*SWITCH_TO_GEMINI\s*\]/gi, 'home'],
    [/\[\s*SWITCH_TO_HOME\s*\]/gi, 'home'],
    [/\[\s*SWITCH_TO_CLAUDE\s*\]/gi, 'alt']
  ];
  for (const [re, target] of patterns) {
    if (re.test(out)) {
      switchTo = target;
      out = out.replace(re, '');
    }
  }
  return { text: out.replace(/[ \t]+$/gm, '').trim(), switchTo };
}
