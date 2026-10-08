// Optional, private-chat-only proactive scheduler. It only chooses *when* and *whom*;
// the orchestrator owns model calls, send queue, budget and delivery accounting.
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, getConfig } from './config.js';
import { canRun } from './access.js';

const STATE_FILE = path.join(DATA_DIR, 'private-proactive-state.json');
const DAY_MS = 86400000;

function bounded(value, fallback, min, max) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
}

function range(value, fallbackMin, fallbackMax, min, max) {
  const match = /^(\d+)(?:\s*-\s*(\d+))?$/.exec(String(value ?? '').trim());
  if (!match) return { min: fallbackMin, max: fallbackMax };
  const low = bounded(match[1], fallbackMin, min, max);
  const high = bounded(match[2] ?? match[1], fallbackMax, min, max);
  return { min: Math.min(low, high), max: Math.max(low, high) };
}

function minutes(text) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(text).trim());
  if (!match) return null;
  const h = Number(match[1]);
  const m = Number(match[2]);
  return h < 24 && m < 60 ? h * 60 + m : null;
}

function inPeriod(value, atMinute) {
  const match = /^(\d{1,2}:\d{2})\s*[-~]\s*(\d{1,2}:\d{2})$/.exec(String(value ?? '').trim());
  if (!match) return false;
  const start = minutes(match[1]);
  const end = minutes(match[2]);
  if (start === null || end === null || start === end) return false;
  return start < end ? atMinute >= start && atMinute < end : atMinute >= start || atMinute < end;
}

function shanghaiClock(now) {
  const local = new Date(now + 8 * 3600000);
  return {
    day: local.toISOString().slice(0, 10),
    weekday: local.getUTCDay() || 7,
    minute: local.getUTCHours() * 60 + local.getUTCMinutes()
  };
}

export function privateProactiveTimeAllowed(settings, now = Date.now()) {
  const clock = shanghaiClock(now);
  if (inPeriod(settings.quietRange ?? '00:00-07:00', clock.minute)) return false;
  if (settings.liangwenfengEnabled !== false) {
    const days = String(settings.lwfDays ?? '1,2,3,4,5').split(/[,，\s]+/).map(Number);
    if (days.includes(clock.weekday)
      && String(settings.lwfPeriods ?? '09:00-12:00,14:00-18:00').split(/[,，]/)
        .some((part) => inPeriod(part, clock.minute))) return false;
  }
  return true;
}

export function privateProactiveTargets(settings = {}) {
  const raw = String(settings.targets ?? '').trim();
  if (!raw) return null;
  const result = new Map();
  for (const item of raw.split(/[,，\s]+/)) {
    const match = /^(\d{5,15})(?::(\d+)(?:\/(\d+))?)?$/.exec(item);
    if (!match) continue;
    result.set(match[1], {
      idle: bounded(match[2], settings.targetIdleMinMinutes ?? 30, 1, 10080),
      cooldown: bounded(match[3], settings.cooldownMinutes ?? 120, 1, 10080)
    });
  }
  return result;
}

function readState(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)
      || !Number.isSafeInteger(raw.dayCount) || raw.dayCount < 0
      || !raw.friends || typeof raw.friends !== 'object' || Array.isArray(raw.friends)) {
      throw new Error('主动私信状态文件格式无效；请检查后再启用发送');
    }
    return { day: String(raw.day || ''), dayCount: raw.dayCount, friends: raw.friends };
  } catch (error) {
    if (error?.code === 'ENOENT') return { day: '', dayCount: 0, friends: {} };
    throw error;
  }
}

function saveState(file, state) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, file);
  } finally {
    try { fs.rmSync(tmp, { force: true }); } catch { /* cleanup only */ }
  }
}

export class PrivateProactive {
  constructor({ store, wake, canWake, log, config = getConfig, allowed = canRun,
    now = Date.now, random = Math.random, stateFile = STATE_FILE }) {
    this.store = store;
    this.wake = wake;
    this.canWake = canWake;
    this.log = log;
    this.config = config;
    this.allowed = allowed;
    this.now = now;
    this.random = random;
    this.stateFile = stateFile;
    this.timer = null;
    this.running = false;
    this.epoch = 0;
  }

  start() {
    this.stop();
    this.running = true;
    this.schedule(15000);
  }

  stop() {
    this.running = false;
    this.epoch += 1;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  schedule(delay) {
    if (!this.running) return;
    const epoch = this.epoch;
    this.timer = setTimeout(() => {
      if (!this.running || this.epoch !== epoch) return;
      this.tick(epoch).catch((error) => this.log.error(`[private-proactive] 判定失败：${error?.message ?? error}`))
        .finally(() => {
          if (!this.running || this.epoch !== epoch) return;
          const r = range(this.config().privateProactive?.wakeRange, 15, 30, 1, 1440);
          const minutes = r.min + this.random() * (r.max - r.min);
          this.schedule(Math.round(minutes * 60000));
        });
    }, delay);
    this.timer.unref?.();
  }

  async tick(epoch = this.epoch) {
    const cfg = this.config();
    const settings = cfg.privateProactive || {};
    if (!this.running || this.epoch !== epoch || settings.enabled !== true
      || !privateProactiveTimeAllowed(settings, this.now())) return;
    const clock = shanghaiClock(this.now());
    const state = readState(this.stateFile);
    if (state.day !== clock.day) { state.day = clock.day; state.dayCount = 0; }
    const maxPerDay = bounded(settings.maxPerDay, 20, 0, 100);
    if (state.dayCount >= maxPerDay) return;
    const targets = privateProactiveTargets(settings);
    // An empty or invalid explicit list must never broaden the audience.
    const allow = new Set((cfg.allow?.private || []).map(String));
    if (!allow.size) return;
    const now = this.now();
    const candidates = [];
    for (const key of this.store.listChats()) {
      const match = /^private:(\d{5,15})$/.exec(key);
      if (!match || !allow.has(match[1]) || (targets && !targets.has(match[1]))) continue;
      if (!this.allowed(key) || this.canWake(key) || this.store.unreadCount(key) > 0) continue;
      const incoming = this.store.recent(key, { limit: 1, includeSelf: false }).at(-1);
      if (!incoming?.ts || now - incoming.ts > 14 * DAY_MS) continue;
      const rule = targets?.get(match[1]);
      const idle = bounded(rule?.idle ?? settings.targetIdleMinMinutes, 30, 1, 10080) * 60000;
      const cooldown = bounded(rule?.cooldown ?? settings.cooldownMinutes, 120, 1, 10080) * 60000;
      const friend = state.friends[key] || {};
      const latest = this.store.recent(key, { limit: 1 }).at(-1);
      if (now - incoming.ts < idle || now - incoming.ts < bounded(settings.replyGuardMinutes, 30, 0, 1440) * 60000) continue;
      const replied = (friend.lastSelfId && Number(incoming.id) > friend.lastSelfId)
        || (friend.pending && Number(incoming.id) > friend.lastIncomingId);
      if (friend.lastAt && !replied && now - friend.lastAt < cooldown) continue;
      if (friend.pending && !replied) continue;
      if (settings.noRepeatWhenUnreplied !== false && friend.lastSelfId && !replied) continue;
      if (latest?.self && now - latest.ts < bounded(settings.resendGuardMinutes, 30, 0, 1440) * 60000) continue;
      candidates.push({ key, incomingAt: incoming.ts });
    }
    candidates.sort((a, b) => a.incomingAt - b.incomingAt);
    const sendRange = range(settings.targetSendRange, 1, 1, 1, 20);
    const cap = Math.min(maxPerDay - state.dayCount,
      Math.floor(sendRange.min + this.random() * (sendRange.max - sendRange.min + 1)));
    for (const item of candidates.slice(0, cap)) {
      const current = this.config();
      if (!this.running || this.epoch !== epoch || current.privateProactive?.enabled !== true) break;
      if (!(current.allow?.private || []).map(String).includes(item.key.slice('private:'.length))) continue;
      if (!this.allowed(item.key) || this.canWake(item.key) || this.store.unreadCount(item.key) > 0) continue;
      // An absent or malformed dryRun flag is never permission to send.
      if (current.privateProactive.dryRun !== false) {
        this.log.info(`[private-proactive] 演练：${item.key} 符合主动私信条件（未调用模型、未发送）`);
        continue;
      }
      const before = this.store.recent(item.key, { limit: 1 }).at(-1)?.id || 0;
      const incomingId = this.store.recent(item.key, { limit: 1, includeSelf: false }).at(-1)?.id || 0;
      const previousFriend = state.friends[item.key];
      // Reserve the daily slot and persist a pending marker *before* the model can
      // send. A crash or failed state write must never turn into a second DM.
      state.friends[item.key] = { ...previousFriend, pending: true, lastAt: this.now(), lastIncomingId: incomingId };
      state.dayCount += 1;
      saveState(this.stateFile, state);
      const note = '【系统提醒】这是私聊主动开口机会。结合真实聊天历史判断现在是否适合关心对方。合适才自然地说一句，不合适就保持安静。不要追问未回复的主动消息。'
        + String(settings.personaNote || '').trim().slice(0, 120);
      let wakeError = null;
      try { await this.wake(item.key, { proactive: true, privateProactive: true, wakeNote: note }); }
      catch (error) { wakeError = error; }
      // Even if the model run failed, a send may already have happened. Record it
      // before considering another wake, so an uncertain run cannot cause a chase.
      const additions = this.store.recent(item.key, { limit: 100, afterId: before }).filter((m) => m.self);
      if (additions.length) {
        const last = additions.at(-1);
        state.friends[item.key] = { lastAt: last.ts || this.now(), lastSelfId: last.id };
        state.dayCount += additions.length - 1;
        saveState(this.stateFile, state);
        this.log.info(`[private-proactive] ${item.key} 主动发送 ${additions.length} 条，今日累计 ${state.dayCount}/${maxPerDay}`);
      } else if (!wakeError) {
        if (previousFriend) state.friends[item.key] = previousFriend;
        else delete state.friends[item.key];
        state.dayCount -= 1;
        saveState(this.stateFile, state);
      }
      if (wakeError) this.log.error(`[private-proactive] ${item.key} 唤醒失败：${wakeError?.message ?? wakeError}`);
      const gap = bounded(settings.sendGapSec, 20, 0, 600) * 1000;
      if (gap && item !== candidates[Math.min(candidates.length, cap) - 1]) {
        await new Promise((resolve) => { setTimeout(resolve, gap); });
      }
    }
  }
}
