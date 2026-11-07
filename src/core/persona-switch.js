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
  callVerbs: ['呼叫', '叫', '喊', '出来', '换', '值班', '接管', '救命', '在吗', '来'],
  // 换人设时把群名片一起换（Claude ⇄ Gemi本咪）。默认开：名片是群友唯一能看出"现在是谁在值班"的东西。
  renameGroupCard: true,
  // 头像也换（账号级，所有群/私聊共用一张）。图片留空＝不做。
  switchAvatar: true,
  altAvatar: '',
  homeAvatar: '',
  // 召唤前先探一次第二人设的模型能不能用：额度用完就不切（否则会出现"别人顶着它的脸说话"）
  probeOnSwitch: true
});

const STATE_FILE = () => path.join(DATA_DIR, 'persona-state.json');
const AVATAR_STATE_FILE = () => path.join(DATA_DIR, 'persona-avatar.json');
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
    callVerbs: words(src.callVerbs, DEFAULT_PERSONA_SWITCH.callVerbs),
    renameGroupCard: src.renameGroupCard !== false,
    switchAvatar: src.switchAvatar !== false,
    altAvatar: String(src.altAvatar || '').trim(),
    homeAvatar: String(src.homeAvatar || '').trim(),
    probeOnSwitch: src.probeOnSwitch !== false
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
 *
 * `ignore`：匹配前先剔掉的文本（机器人自己的名字）。
 * 为什么必须有：@ 的文本里带着群名片，而这台机器的默认人设名字就叫「**Gemi**本咪」——
 * 于是 `@Gemi本咪 呼叫克劳德` 同时命中 home(gemi) 与 alt(claude)，被"拿不准不切"规则判死，
 * 表现为"怎么叫都不切换"（2026-11-07 线上实测）。剔掉自己的名字后只剩 alt，才判得对。
 */
export function matchSwitchRequest(text, { mention = false, settings, ignore = [] } = {}) {
  const cfg = settings || personaSwitchConfig(getConfig().personaSwitch);
  const selfNames = (Array.isArray(ignore) ? ignore : [])
    .map((name) => String(name ?? '').trim())
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);   // 长的先剔：「Gemi本咪」要先于「Gemi」
  let body = String(text || '');
  for (const name of selfNames) {
    body = body.split(name).join('');
    body = body.split(name.toLowerCase()).join('');
  }
  body = body.toLowerCase();
  if (!body.trim()) return null;
  const hit = (list) => list.some((word) => body.includes(word));
  const verb = cfg.callVerbs.some((word) => body.includes(word));
  const alt = hit(cfg.callWords);
  const home = hit(cfg.homeWords);
  if (alt === home) return null;               // 都没提，或同时提到（拿不准就不切）
  if (!mention && !verb) return null;          // 纯提到名字、没有呼叫做派：不切
  return alt ? 'alt' : 'home';
}

/**
 * 当前会话该用哪个人设。闲置超时在这里惰性判定，不需要额外定时器。
 *
 * 过期（以及下面 activate/clear 切回默认人设）时**不直接删记录**：如果这次值班期间我们改过群名片，
 * 得留下一条 `profile:'home'` 的墓碑，把"我们改成了什么、原来叫什么"带到下一轮，
 * 下一轮才能把名片改回去。没有名片记录时行为与以前完全一致（直接删）。
 */
export function resolveChatProfile(chatKey, now = Date.now(), settings = null) {
  const cfg = settings || personaSwitchConfig(getConfig().personaSwitch);
  if (!altPersonaReady(cfg)) return { profile: 'home', since: 0 };
  const state = readState();
  const entry = state[chatKey];
  if (!entry || entry.profile !== 'alt') return { profile: 'home', since: 0 };
  const idle = cfg.idleMinutes * 60 * 1000;
  const last = Number(entry.lastReplyAt || entry.since || 0);
  if (!last || now - last > idle) {
    const card = String(entry.card || '');
    if (card) state[chatKey] = { ...homeTombstone(entry, now), card, homeCard: String(entry.homeCard || '') };
    else delete state[chatKey];
    writeState(state);
    return { profile: 'home', since: 0, expired: true };
  }
  return { profile: 'alt', since: Number(entry.since) || last };
}

/** 切回默认人设后留下的那条记录（只为了把群名片改回去）。 */
function homeTombstone(entry, now) {
  return {
    profile: 'home',
    since: 0,
    lastReplyAt: 0,
    lastSwitchAt: Number(entry?.lastSwitchAt) || now
  };
}

/**
 * 换人设时"群名片该改成什么"的纯决策（不做任何 I/O，便于单测）。
 *
 * @param {object} p
 * @param {boolean} p.altActive  这一轮是不是第二人设
 * @param {string}  p.card       我们上一次给它改成的名片（空串 = 从没改过）
 * @param {string}  p.homeCard   切走之前它本来的名片（捕获失败时为空）
 * @param {string}  p.altName    第二人设要用的名片
 * @param {string}  p.homeName   不知道原名时的兜底（机器人名字）
 * @param {boolean} p.enabled    开关
 * @returns {null | {card: string, remember: boolean, forget: boolean}}
 *   card 空串 = 不用设置、只清记录；remember = 成功后记下"我们改过"；forget = 成功后清记录
 */
export function planGroupCard({
  altActive, card = '', homeCard = '', altName = '', homeName = '', enabled = true,
  failedAt = 0, now = Date.now(), retryAfterMs = 10 * 60 * 1000
} = {}) {
  if (!enabled) return null;
  // 刚失败过（多半是没有群名片权限）：先闭嘴十分钟，别每轮都去撞一次同样的墙
  if (failedAt && now - Number(failedAt) < retryAfterMs) return null;
  const current = String(card || '').trim();
  if (altActive) {
    const target = String(altName || '').trim();
    if (!target || target === current) return null;
    return { card: target, remember: true, forget: false };
  }
  // 没改过名片 → 绝不碰它（别人手设的名字不该被我们覆盖）
  if (!current) return null;
  const target = String(homeCard || homeName || '').trim();
  // 不知道原名、也没有兜底名字：只能把记录清掉，别再反复尝试
  if (!target || target === current) return { card: '', remember: false, forget: true };
  return { card: target, remember: false, forget: true };
}

/**
 * 切换当前会话的人设；受冷却时间保护，避免反复横跳。
 * @param {object} [options]
 * @param {boolean} [options.force] 跳过冷却。**交还**（模型自己交还、额度用完被交还、
 *   管理员叫回）必须用它：冷却的本意是防止"来回切着玩"，不该拦"他下班"。
 *   以前这里对两个方向都生效，导致切过去 60 秒内模型自己输出 [SWITCH_TO_GEMINI] 会被吞掉。
 */
export function activateChatProfile(chatKey, profile, now = Date.now(), settings = null, { force = false } = {}) {
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
  if (!force && sinceSwitch < cfg.cooldownSeconds * 1000) return { changed: false, reason: 'cooldown' };
  // 本来就没有状态、又要切回默认人设：什么都不用做。
  // 以前这里会一路走到 writeState 并返回 changed:true —— 调用方据此打一条"切换"日志，
  // 看起来像切了、其实什么都没发生（2026-11-07 排查"切换不了"时就栽在这条日志上）。
  if (profile === 'home' && !state[chatKey]) return { changed: false, reason: 'already' };
  if (profile === 'alt') {
    // 换人会保留"我们改过的名片"，但不保留上一轮的时间戳（新的一段值班从现在开始）
    state[chatKey] = { profile: 'alt', since: now, lastReplyAt: now, lastSwitchAt: now };
    const card = String(entry.card || '');
    if (card) { state[chatKey].card = card; state[chatKey].homeCard = String(entry.homeCard || ''); }
  } else {
    const card = String(entry.card || '');
    if (card) state[chatKey] = { ...homeTombstone(entry, now), card, homeCard: String(entry.homeCard || '') };
    else delete state[chatKey];
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

/**
 * 清掉某个会话的临时状态（停用功能、或人工复位时用）。
 * 改过群名片的会话会留一条墓碑，等下一轮把名片改回去（否则名片会一直停在「Claude」）。
 * @returns {boolean} 这次清掉的是不是"正在值班"（墓碑不算）
 */
export function clearChatProfile(chatKey) {
  const state = readState();
  const entry = state[chatKey];
  if (!entry) return false;
  const wasAlt = entry.profile === 'alt';
  const card = String(entry.card || '');
  if (card) state[chatKey] = { ...homeTombstone(entry, Date.now()), card, homeCard: String(entry.homeCard || '') };
  else delete state[chatKey];
  writeState(state);
  return wasAlt;
}

/** 这个会话"我们给它改过的群名片"与原名（都没改过时为空串）。 */
export function chatCardState(chatKey) {
  const entry = readState()[chatKey];
  return {
    card: String(entry?.card || ''),
    homeCard: String(entry?.homeCard || ''),
    failedAt: Number(entry?.cardFailAt) || 0
  };
}

/** 改名片失败：记下时间用于退避（别每轮都重试同一个没权限的群）。 */
export function markChatCardFailed(chatKey, now = Date.now()) {
  if (!chatKey) return false;
  const state = readState();
  const entry = state[chatKey] && typeof state[chatKey] === 'object' ? state[chatKey] : {};
  entry.cardFailAt = Number(now) || Date.now();
  state[chatKey] = entry;
  writeState(state);
  return true;
}

/** 记下"我们把群名片改成了 card、它本来是 homeCard"（改名片成功之后调用）。 */
export function rememberChatCard(chatKey, card, homeCard = '') {
  const text = String(card || '').trim();
  if (!chatKey || !text) return false;
  const state = readState();
  const entry = state[chatKey] && typeof state[chatKey] === 'object' ? state[chatKey] : {};
  entry.card = text;
  entry.homeCard = String(homeCard || entry.homeCard || '').trim();
  state[chatKey] = entry;
  writeState(state);
  return true;
}

/** 清掉名片记录（已经把名片改回去了）。没有别的状态就整条删掉。 */
export function forgetChatCard(chatKey) {
  const state = readState();
  const entry = state[chatKey];
  if (!entry || !entry.card) return false;
  delete entry.card;
  delete entry.homeCard;
  if (entry.profile === 'alt') state[chatKey] = entry;
  else delete state[chatKey];
  writeState(state);
  return true;
}

// ── 头像（账号级，全局只有一张）─────────────────────────────────────────
// 为什么单独一个状态文件：它跟"哪个群在值班"无关，只跟"全局现在该露哪张脸"有关；
// 混进 persona-state.json 会被按会话的 prune / 墓碑逻辑带偏。

/** 头像当前记录：{ mode: 'alt'|'home'|'', at: 上次成功时间, failAt: 上次失败时间 }。 */
export function avatarState() {
  try {
    const raw = JSON.parse(fs.readFileSync(AVATAR_STATE_FILE(), 'utf8'));
    return {
      mode: String(raw?.mode || ''),
      at: Number(raw?.at) || 0,
      failAt: Number(raw?.failAt) || 0
    };
  } catch { return { mode: '', at: 0, failAt: 0 }; }
}

function writeAvatarState(value) {
  const file = AVATAR_STATE_FILE();
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(value), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, file);
    fs.chmodSync(file, 0o600);
  } catch { /* 记不住就下次再设一遍，不影响聊天 */ }
}

/** 头像已切换成功。 */
export function markAvatarApplied(mode, now = Date.now()) {
  writeAvatarState({ mode: String(mode || ''), at: Number(now) || Date.now(), failAt: 0 });
}

/** 头像切换失败（多半是图片路径不对）：记失败时间，退避期间不再重试。 */
export function markAvatarFailed(now = Date.now()) {
  const prev = avatarState();
  writeAvatarState({ mode: prev.mode, at: prev.at, failAt: Number(now) || Date.now() });
}

/**
 * 头像该不该换的纯决策（不做 I/O）。
 *
 * 规则：**有任意会话在第二人设值班 → 用第二人设的头像；全部交还 → 换回默认头像**。
 * 头像是账号级的，没法"这个群 Claude、那个群 Gemi"——所以只能按全局值班状态跟随。
 *
 * @returns {null | {mode: 'alt'|'home', file: string}}
 */
export function planAvatar({
  anyDuty = false, state = {}, altAvatar = '', homeAvatar = '', enabled = true,
  now = Date.now(), minGapMs = 20000, backoffMs = 10 * 60 * 1000
} = {}) {
  if (!enabled) return null;
  const mode = anyDuty ? 'alt' : 'home';
  const file = String((anyDuty ? altAvatar : homeAvatar) || '').trim();
  if (!file) return null;                                  // 没配图就不动，也不写状态
  if (String(state?.mode || '') === mode) return null;     // 已经是这副脸
  if (Number(state?.failAt) && now - Number(state.failAt) < backoffMs) return null;
  if (Number(state?.at) && now - Number(state.at) < minGapMs) return null;
  return { mode, file };
}

/** 当前所有处于第二人设的会话（控制台展示用）。 */export function activeAltChats(now = Date.now()) {
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
