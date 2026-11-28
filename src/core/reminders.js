// 定时提醒：群友让机器人"X 点提醒我 Y" —— 落盘持久化（重启不丢），到点走主动唤醒，
// 由模型用人设口吻把提醒说出来（而不是系统模板直发）。
// 与 schedule_wake 的区别：那个是"给自己排开口时机"、内存态、每会话只留一条；
// 这里是"给别人设的承诺"、持久化、可多条、可查询/取消。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR } from './config.js';
import { ZONE_OFFSET_MS, sanitizeUserText, shanghaiDayStart } from './util.js';

const FILE = path.join(DATA_DIR, 'reminders.json');
export const MAX_REMINDER_TEXT = 200;
const MAX_PER_CHAT = 10;      // 单个会话待触发上限（防刷）
const MAX_PENDING = 50;       // 全局待触发上限
const DONE_KEEP = 5;          // 每个会话保留最近几条已完成记录（供 list 查看）
const MAX_DELAY_MS = 30 * 24 * 60 * 60 * 1000; // 最多 30 天后（再远没意义）
const EXPIRE_AFTER_MS = 12 * 60 * 60 * 1000;   // 离线导致迟到超过 12 小时 → 作废不补发
const DAY_MS = 24 * 60 * 60 * 1000;
const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

function pad2(n) {
  return String(n).padStart(2, '0');
}

/** 构造上海时区的绝对毫秒时间戳；若日历日期非法（如 2 月 30 日）返回 null。 */
function shanghaiPartsToMs(year, month, day, hour, minute, second = 0) {
  if (!Number.isInteger(year) || year < 2000 || year > 2100) return null;
  if (!Number.isInteger(month) || month < 1 || month > 12) return null;
  if (!Number.isInteger(day) || day < 1 || day > 31) return null;
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) return null;
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) return null;
  if (!Number.isInteger(second) || second < 0 || second > 59) return null;
  const utc = Date.UTC(year, month - 1, day, hour, minute, second);
  const check = new Date(utc);
  if (
    check.getUTCFullYear() !== year
    || check.getUTCMonth() !== month - 1
    || check.getUTCDate() !== day
  ) return null;
  return utc - ZONE_OFFSET_MS;
}

/** "HH:MM" → 下一次出现的绝对毫秒（按项目统一时区 UTC+8，整分归零秒；已过则算明天）。非法返回 null。 */
export function nextAtFromHHMM(hhmm, now = Date.now()) {
  const m = /^(\d{1,2})[:：](\d{2})$/.exec(String(hhmm || '').trim());
  if (!m) return null;
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (hour > 23 || minute > 59) return null;
  const targetMin = hour * 60 + minute;
  const todayTarget = shanghaiDayStart(now) + targetMin * 60 * 1000;
  // 若今天该整分时刻尚未过去（严格晚于 now），就取今天；已过或正好此刻则算明天同一整分。
  return todayTarget > now ? todayTarget : todayTarget + DAY_MS;
}

/**
 * 解析提醒的绝对时间（按北京时间 UTC+8，非法返回 null）：
 * - "HH:MM"（24 小时内，已过算明天）
 * - "YYYY-MM-DD HH:MM" / "YYYY/MM/DD HH:MM" / "YYYY.MM.DD HH:MM" / "YYYY年M月D日 HH:MM"（支持 T 分隔与可选 :SS）
 * - 带显式时区后缀的 ISO 8601（如 "2026-12-03T19:00:00+08:00" 或 "...Z"）
 * - "MM-DD HH:MM" / "MM/DD HH:MM" / "M.D HH:MM" / "M月D日 HH:MM" / "M月D号 HH:MM"
 *   （按上海当前年；仅在跨年窗口内、下一年同月日落在未来 30 天内时自动顺延至下一年）
 */
export function parseReminderAt(input, now = Date.now()) {
  const raw = String(input ?? '').trim();
  if (!raw) return null;

  // 1. 纯 HH:MM（兼容原接口）
  if (/^\d{1,2}[:：]\d{2}$/.test(raw)) {
    return nextAtFromHHMM(raw, now);
  }

  // 2. 带显式时区的 ISO 8601（如 +08:00 / -05:00 / Z）
  if (/^\d{4}-\d{2}-\d{2}[T\s]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:?\d{2})$/i.test(raw)) {
    const parsed = Date.parse(raw.replace(' ', 'T'));
    return Number.isFinite(parsed) ? parsed : null;
  }

  // 3. 完整年月日 + 时分（可选秒），按北京时间
  const full = /^(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})(?:[日号])?(?:[\sT]+)(\d{1,2})[:：](\d{2})(?:[:：](\d{2}))?$/.exec(raw);
  if (full) {
    return shanghaiPartsToMs(
      Number(full[1]), Number(full[2]), Number(full[3]),
      Number(full[4]), Number(full[5]), full[6] !== undefined ? Number(full[6]) : 0
    );
  }

  // 4. 月日 + 时分（可选秒），按上海当前年（支持 12 月下旬设次年 1 月）
  const md = /^(\d{1,2})[-/.月](\d{1,2})(?:[日号])?(?:[\sT]+)(\d{1,2})[:：](\d{2})(?:[:：](\d{2}))?$/.exec(raw);
  if (md) {
    const nowSh = new Date(now + ZONE_OFFSET_MS);
    const year = nowSh.getUTCFullYear();
    const month = Number(md[1]);
    const day = Number(md[2]);
    const hour = Number(md[3]);
    const minute = Number(md[4]);
    const second = md[5] !== undefined ? Number(md[5]) : 0;
    const thisYear = shanghaiPartsToMs(year, month, day, hour, minute, second);
    if (thisYear === null) {
      // 例如平年写 02-29 → 仍按非法日期拒绝
      return null;
    }
    if (thisYear < now - DAY_MS) {
      const nextYear = shanghaiPartsToMs(year + 1, month, day, hour, minute, second);
      if (nextYear !== null && nextYear > now && nextYear - now <= MAX_DELAY_MS) {
        return nextYear;
      }
    }
    return thisYear;
  }

  return null;
}

/** 格式化提醒绝对时间（北京时间，含年/月/日/星期/时:分，便于模型一眼核对日期与星期）。 */
export function formatReminderAt(ts) {
  const value = Number(ts);
  if (!Number.isFinite(value)) return '时间未知';
  const d = new Date(value + ZONE_OFFSET_MS);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}（${WEEKDAYS[d.getUTCDay()]}）${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`;
}

const REMINDER_EXPLICIT_RE = /(?:定时提醒|定时任务|定个?时|设个?时|闹钟|报时|提醒我|提醒一下|提醒下|别忘了提醒|记得提醒|取消提醒|删(?:掉|除).*提醒|别提醒|不用提醒|有哪些提醒|看看.*提醒|查(?:一下|看).*提醒|改(?:一下)?.*提醒)/;
const REMINDER_TIME_CALL_RE = /(?:(?:分钟|小时|钟头)后|半小时|一会儿|待会儿?|稍后|明天|后天|大后天|明早|明晚|今晚|今夜|今早|下?周[一二三四五六日天末]|下?星期[一二三四五六日天]|\d{1,2}\s*[点時:：]|\d{1,2}\s*[月号日]|\d{1,2}[./-]\d{1,2}|凌晨|早上|上午|中午|下午|傍晚|晚上).{0,20}(?:叫我|喊我|戳我|通知我|提醒|再定一个|定一个|设一个|叫一下我|喊一下我)|(?:叫我|喊我|戳我|通知我).{0,16}(?:起床|开会|吃药|喝水|拿快递|上班|下班|出门|睡觉|抢|打卡|交|报|领|吃|看)/;
const REMINDER_FOLLOWUP_RE = /(?:改到|改成|换成|提前|推迟|延迟|晚点|开始|取消|算了别|不是今天|今天才周|日子|星期|周[一二三四五六日天]|(?:\d{1,2}|[零一二两三四五六七八九十]{1,3})\s*(?:点|时|[:：]|号|日))/;

/**
 * 判断本轮用户消息是否像是在设置/查询/修改/取消定时提醒（用于将提醒相关轮次路由到专用模型）。
 * 只读纯函数：不发网络、不改状态。
 */
export function looksLikeReminderRequest(
  triggerEntries = [],
  { hasPendingReminders = false, recentAssistantText = '' } = {}
) {
  const texts = [];
  for (const entry of triggerEntries || []) {
    if (!entry || entry.self) continue;
    const body = String(entry.text || '').trim();
    if (body) texts.push(body);
    const quoted = String(entry.reply?.text || '').trim();
    if (quoted) texts.push(quoted);
  }
  if (!texts.length) return false;
  const combined = texts.join('\n');
  if (REMINDER_EXPLICIT_RE.test(combined)) return true;
  if (REMINDER_TIME_CALL_RE.test(combined)) return true;
  if (
    (hasPendingReminders || /(?:提醒|闹钟|小手账|定时)/.test(String(recentAssistantText || '')))
    && REMINDER_FOLLOWUP_RE.test(combined)
  ) {
    return true;
  }
  return false;
}

/**
 * 解析定时提醒专用模型的 overrides（与记忆整理专用模型同口径）。
 * useChatModel !== false 或配置不完整时返回 null（调用方沿用主模型）。
 */
export function resolveReminderModelOverride(cfg, providers = []) {
  const rem = cfg?.reminders || {};
  if (rem.enabled === false || rem.useChatModel !== false) return null;
  const providerId = String(rem.provider || '').trim();
  const model = String(rem.model || '').trim();
  if (!providerId || !model) return null;
  const p = (Array.isArray(providers) ? providers : []).find((x) => x && x.id === providerId);
  if (!p?.baseURL || !p?.apiKey) return null;
  return {
    providerId: p.id,
    baseUrl: p.baseURL,
    apiKey: p.apiKey,
    model,
    timeoutMs: Math.max(5000, Number(cfg?.api?.timeoutMs) || 60000)
  };
}

export class ReminderStore {
  constructor(file = FILE) {
    this.file = file;
    this.items = this.#load();
  }

  #load() {
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch (error) {
      // 首次运行没有文件是正常的，只有"文件在但读不了"才值得报警并留档：
      // 静默返回空数组的后果是「提示没设成」——下一次 #save 会用空列表覆盖掉
      // 那份损坏文件，用户再也查不出提醒为什么消失（2026-09-29 审查 P2）。
      if (error?.code !== 'ENOENT') {
        console.error(`[reminder] 读取 ${this.file} 失败，本次按"没有提醒"处理，原文件已备份为 .broken-<时间戳>：`, error?.message ?? error);
        try { fs.renameSync(this.file, `${this.file}.broken-${Date.now()}`); } catch { /* 备份失败就留在原处，至少不覆盖 */ }
      }
      return [];
    }
    return Array.isArray(raw?.items) ? raw.items.filter((x) => x && x.id && x.chatKey && x.at) : [];
  }

  #save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
      // 与全仓其它落盘点同口径：tmp + rename 原子替换（此前这里是唯一的直接覆盖写），
      // flush 让 rename 之前数据已经落盘，避免断电后留下"改名成功、内容为空"的文件。
      const tmp = `${this.file}.${process.pid}.tmp`;
      try { fs.rmSync(tmp, { force: true }); } catch { /* 不存在就算了 */ }
      fs.writeFileSync(tmp, JSON.stringify({ items: this.items }, null, 2), { encoding: 'utf8', mode: 0o600, flush: true });
      fs.renameSync(tmp, this.file);
      fs.chmodSync(this.file, 0o600);
    } catch (error) {
      // 落盘失败不影响内存态，但必须留痕：此前静默吞掉，磁盘满时用户看到"设好了"，
      // 重启后提醒全没了且没有任何线索（2026-09-29 审查 P2）。
      console.error('[reminder] 落盘失败（内存态继续用，重启会丢）:', error?.message ?? error);
    }
  }

  #prune() {
    // 每个会话只保留最近 DONE_KEEP 条已完成（fired/expired/canceled），pending 不剪
    const byChat = new Map();
    for (const it of this.items) {
      if (it.status === 'pending') continue;
      const list = byChat.get(it.chatKey) || [];
      list.push(it);
      byChat.set(it.chatKey, list);
    }
    const drop = new Set();
    for (const list of byChat.values()) {
      list.sort((a, b) => (b.finishedAt || 0) - (a.finishedAt || 0));
      for (const it of list.slice(DONE_KEEP)) drop.add(it.id);
    }
    if (drop.size) this.items = this.items.filter((it) => !drop.has(it.id));
  }

  /** 新增一条提醒。返回 { id, at }；超出限制/参数非法时抛带可读原因的错。 */
  add({ chatKey, at, text, createdBy = '' }) {
    const when = Number(at);
    // 提醒正文是"用户可诱导模型原样搬运"的文本，落盘前统一弱化段头（提示注入面，2026-09-28 审查 P2）
    const body = sanitizeUserText(String(text || '').trim()).slice(0, MAX_REMINDER_TEXT);
    if (!chatKey) throw new Error('缺少会话');
    if (!body) throw new Error('提醒内容不能为空');
    if (!Number.isFinite(when)) throw new Error('提醒时间不合法');
    const now = Date.now();
    if (when <= now + 5000) throw new Error('提醒时间必须晚于现在');
    if (when - now > MAX_DELAY_MS) throw new Error('最多只能设到 30 天后');
    // #9：先把"早就过期、还没被巡检标掉"的项标成 expired（它们才是真占着 pending 名额的那批），
    // 再剪留档，最后判上限 —— 否则用户会因为一堆早该作废的提醒而被告知"满了"。
    let expiredNow = false;
    for (const it of this.expired(now)) { it.status = 'expired'; it.finishedAt = now; expiredNow = true; }
    this.#prune();
    if (expiredNow) this.#save();
    const pendingNow = () => this.items.filter((it) => it.status === 'pending');
    if (pendingNow().filter((it) => it.chatKey === chatKey).length >= MAX_PER_CHAT) {
      throw new Error('本会话待触发提醒已达上限（10 条），先取消一些');
    }
    if (pendingNow().length >= MAX_PENDING) {
      throw new Error('全局提醒位已满（每人上限 10 条，共 50 条），先取消一些');
    }
    const item = {
      id: crypto.randomBytes(4).toString('hex'),
      chatKey,
      at: when,
      text: body,
      createdBy: String(createdBy || '').slice(0, 40),
      status: 'pending',
      createdAt: now,
      firedAt: null,
      finishedAt: null
    };
    this.items.push(item);
    this.#save();
    return { id: item.id, at: item.at };
  }

  cancel({ id = '', chatKey = '' }) {
    const key = String(id || '').trim();
    // 不传 id 时：取消该会话**最近一条**待触发（"算了别提醒了"这种口语）。
    // 之前的写法 find(… && true) 恒命中数组里最早的一条，reverse 兜底是死代码
    // （2026-09-29 审查 P2：同一会话有两条 pending 时会取消错条）
    const hit = key
      ? this.items.find((it) => it.chatKey === chatKey && it.status === 'pending' && it.id === key)
      : [...this.items].reverse().find((it) => it.chatKey === chatKey && it.status === 'pending');
    if (!hit) return null;
    hit.status = 'canceled';
    hit.finishedAt = Date.now();
    this.#prune();
    this.#save();
    return hit;
  }

  list(chatKey, { includeDone = false } = {}) {
    return this.items
      .filter((it) => it.chatKey === chatKey && (includeDone || it.status === 'pending'))
      .sort((a, b) => a.at - b.at);
  }

  due(now = Date.now()) {
    return this.items.filter((it) => it.status === 'pending' && it.at <= now);
  }

  /** 迟到的提醒：超过 12 小时的直接作废（不补发一串"迟到的提醒"）。 */
  expired(now = Date.now()) {
    return this.items.filter((it) => it.status === 'pending' && it.at <= now - EXPIRE_AFTER_MS);
  }

  /**
   * 预算等外因挡住派发时，把到点时间显式顺延（2026-10-04 复审 P2）。
   * 只改 at、不动 status：12 小时作废时钟随新 at 重新起算 —— 否则持续超预算的当天，
   * "保持到期等明天"的提醒会在迟到满 12 小时时被 expired() 静默作废，与"顺延到明天"相反。
   */
  deferTo(id, at) {
    const hit = this.items.find((x) => x.id === id && x.status === 'pending');
    if (!hit) return null;
    hit.at = Number(at) || hit.at;
    this.#save();
    return hit;
  }

  markFired(id, now = Date.now()) {
    const it = this.items.find((x) => x.id === id);
    if (!it) return null;
    it.status = 'fired';
    it.firedAt = now;
    it.finishedAt = now;
    this.#prune();
    this.#save();
    return it;
  }

  markExpired(id, now = Date.now()) {
    const it = this.items.find((x) => x.id === id);
    if (!it) return null;
    it.status = 'expired';
    it.finishedAt = now;
    this.#prune();
    this.#save();
    return it;
  }
}

export { EXPIRE_AFTER_MS };
