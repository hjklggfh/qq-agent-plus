import fs from 'node:fs';
import path from 'node:path';
import { nextAtFromHHMM } from '../../core/reminders.js';
import { todayKey } from '../../core/util.js';
import { RANK_META, normalizeRankKind } from './rankings.js';

const VALID_KINDS = ['daily', 'weekly', 'monthly', 'total'];
const CATCHUP_WINDOW_MS = 30 * 60 * 1000;
const GROUP_INTERVAL_MS = 1500;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function minuteOfHHMM(hhmm) {
  const m = String(hhmm || '').match(/^([01]\d|2[0-3]):([0-5]\d)$/);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

function beijingMinuteOfDay(now = Date.now()) {
  const d = new Date(now + 8 * 3600000);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

export class JmRankPushManager {
  constructor({
    dataDir,
    getConfig,
    onebot,
    getRank,
    isChatAllowed = () => true,
    log = console.log,
    now = () => Date.now(),
  } = {}) {
    this.dataDir = String(dataDir || '');
    this.getConfig = getConfig || (() => ({}));
    this.onebot = onebot;
    this.getRank = getRank;
    this.isChatAllowed = isChatAllowed;
    this.log = typeof log === 'function' ? log : (...args) => console.log(...args);
    this.now = now;
    this.timer = null;
    this.catchupTimer = null;
    this.running = false;
    this.nextRunAt = 0;
    this.lastRun = null;
    this.lastSuccessAt = 0;
    this.lastErrorAt = 0;
    this.controller = null;
    this.currentTask = null;
  }

  #statePath() {
    const base = String(this.getConfig()?.jm?.downloadDir || '').trim()
      || path.join(this.dataDir, 'plugin-state', 'jm-suomingor');
    return path.join(base, 'ranks', 'push-state.json');
  }

  #readState() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.#statePath(), 'utf8'));
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }

  #writeState(state) {
    try {
      const target = this.#statePath();
      fs.mkdirSync(path.dirname(target), { recursive: true });
      const tmp = `${target}.${process.pid}.${this.now()}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
      fs.renameSync(tmp, target);
    } catch (error) {
      this.log(`[jm-rank-push] 状态写入失败：${error?.message ?? error}`);
    }
  }

  #cfg() {
    const root = this.getConfig() || {};
    const j = root.jm || {};
    const kinds = (Array.isArray(j.rankPushKinds) ? j.rankPushKinds : ['daily', 'weekly'])
      .map((k) => String(k || '').trim().toLowerCase())
      .filter((k, idx, arr) => VALID_KINDS.includes(k) && arr.indexOf(k) === idx);
    const chats = (Array.isArray(j.rankPushChats) ? j.rankPushChats : [])
      .map((c) => String(c || '').trim())
      .filter((c, idx, arr) => /^group:\d{5,15}$/.test(c) && arr.indexOf(c) === idx);
    return {
      runtimeMode: String(root.runtime?.mode || 'active'),
      runtimePaused: root.runtime?.paused === true,
      jmEnabled: j.enabled !== false,
      enabled: j.enabled !== false && j.rankPushEnabled === true,
      time: String(j.rankPushTime || '00:05'),
      kinds: kinds.length ? kinds : ['daily', 'weekly'],
      chats,
      topN: Math.min(40, Math.max(4, Number(j.rankTopN) || 20)),
    };
  }

  start() {
    this.reconfigure();
  }

  stop() {
    if (this.timer) clearTimeout(this.timer);
    if (this.catchupTimer) clearTimeout(this.catchupTimer);
    this.timer = null;
    this.catchupTimer = null;
    this.nextRunAt = 0;
    this.controller?.abort(new Error('JM rank push stopped'));
  }

  async shutdown() {
    this.stop();
    await this.currentTask?.catch(() => {});
  }

  reconfigure() {
    this.stop();
    this.#scheduleNext();
    this.#maybeScheduleCatchup();
  }

  #maybeScheduleCatchup() {
    const cfg = this.#cfg();
    if (!cfg.enabled || !cfg.chats.length) return;
    const targetMin = minuteOfHHMM(cfg.time);
    if (targetMin === null) return;
    const nowMs = this.now();
    const curMin = beijingMinuteOfDay(nowMs);
    const diffMs = (curMin - targetMin) * 60000;
    if (diffMs < 0 || diffMs > CATCHUP_WINDOW_MS) return;
    const state = this.#readState();
    if (state.lastPushedDate === todayKey(nowMs)) return;
    this.catchupTimer = setTimeout(() => {
      this.catchupTimer = null;
      this.runOnce({ forceRefresh: true, scheduled: true }).catch((err) => {
        this.log(`[jm-rank-push] 补推失败：${err?.message ?? err}`);
      });
    }, 5000);
    this.catchupTimer.unref?.();
    this.log(`[jm-rank-push] 今日 ${cfg.time} 尚未推送且仍在补推窗口内，将于 5 秒后补推`);
  }

  #scheduleNext() {
    clearTimeout(this.timer);
    this.timer = null;
    this.nextRunAt = 0;
    const cfg = this.#cfg();
    if (!cfg.enabled) return;
    const at = nextAtFromHHMM(cfg.time, this.now());
    if (at === null) {
      this.log('[jm-rank-push] 推送时间格式不合法（应为 HH:MM），已停用');
      return;
    }
    const wait = Math.max(1000, at - this.now());
    this.nextRunAt = at;
    this.timer = setTimeout(() => {
      this.#scheduleNext();
      this.runOnce({ forceRefresh: true, scheduled: true }).catch((err) => {
        this.log(`[jm-rank-push] 定时运行出错：${err?.message ?? err}`);
      });
    }, wait);
    this.timer.unref?.();
    this.log(`[jm-rank-push] 已排程：每日 ${cfg.time}，榜单 [${cfg.kinds.join(',')}]，群 ${cfg.chats.length} 个`);
  }

  status() {
    const cfg = this.#cfg();
    const state = this.#readState();
    return {
      enabled: cfg.enabled,
      time: cfg.time,
      kinds: cfg.kinds,
      chats: cfg.chats,
      running: this.running,
      nextRunAt: this.nextRunAt,
      lastSuccessAt: this.lastSuccessAt,
      lastErrorAt: this.lastErrorAt,
      lastPushedDate: state.lastPushedDate || '',
      lastRun: this.lastRun,
    };
  }

  runOnce({ forceRefresh = true, scheduled = false } = {}) {
    if (this.running) return Promise.resolve({ skipped: 'already-running' });
    const cfg = this.#cfg();
    if (!cfg.jmEnabled) return Promise.resolve({ skipped: 'jm-disabled' });
    if (!cfg.chats.length) return Promise.resolve({ skipped: 'no-chats' });
    if (scheduled && cfg.runtimeMode !== 'active') return Promise.resolve({ skipped: 'observe-mode' });
    if (scheduled && cfg.runtimePaused) return Promise.resolve({ skipped: 'paused' });
    if (scheduled && this.#readState().lastPushedDate === todayKey(this.now())) {
      return Promise.resolve({ skipped: 'already-pushed-today' });
    }
    this.running = true;
    this.controller = new AbortController();
    this.currentTask = this.#execute(cfg, { forceRefresh, scheduled }, this.controller.signal).finally(() => {
      this.running = false;
      this.controller = null;
      this.currentTask = null;
    });
    return this.currentTask;
  }

  async #execute(cfg, { forceRefresh, scheduled }, signal) {
    if (!this.onebot?.sendSegments) {
      this.lastErrorAt = this.now();
      return { ok: false, error: 'OneBot 通道不可用' };
    }
    const prepared = [];
    const rankErrors = [];
    for (const rawKind of cfg.kinds) {
      signal.throwIfAborted();
      const kind = normalizeRankKind(rawKind);
      try {
        const res = await this.getRank(kind, { force: forceRefresh, topN: cfg.topN });
        prepared.push(res);
      } catch (error) {
        const msg = String(error?.message ?? error);
        rankErrors.push({ kind, error: msg });
        this.log(`[jm-rank-push] 获取 ${RANK_META[kind].label} 失败：${msg}`);
      }
    }

    if (!prepared.length) {
      this.lastErrorAt = this.now();
      this.lastRun = { at: this.now(), ok: false, rankErrors, results: [] };
      return { ok: false, rankErrors, results: [] };
    }

    const results = [];
    for (let i = 0; i < cfg.chats.length; i++) {
      if (signal.aborted) break;
      const chatKey = cfg.chats[i];
      const [, groupId] = chatKey.split(':');
      if (!this.isChatAllowed(chatKey)) {
        results.push({ chatKey, ok: false, skipped: 'not-allowed' });
        continue;
      }
      let chatOk = true;
      for (const rank of prepared) {
        if (signal.aborted) break;
        try {
          const caption = `${rank.payload.title}\n${rank.payload.subtitle}`;
          await this.onebot.sendSegments('group', groupId, [
            { type: 'text', data: { text: caption } },
            { type: 'image', data: { file: `file://${rank.imagePath}` } },
          ]);
          results.push({ chatKey, kind: rank.kind, ok: true });
        } catch (error) {
          chatOk = false;
          const msg = String(error?.message ?? error).slice(0, 200);
          results.push({ chatKey, kind: rank.kind, ok: false, error: msg });
          this.log(`[jm-rank-push] 发送到 ${chatKey}（${rank.label}）失败：${msg}`);
        }
        await sleep(800);
      }
      if (chatOk && i < cfg.chats.length - 1) await sleep(GROUP_INTERVAL_MS);
    }

    const anySent = results.some((r) => r.ok);
    const nowMs = this.now();
    if (anySent) this.lastSuccessAt = nowMs;
    else this.lastErrorAt = nowMs;
    const prev = this.#readState();
    this.#writeState({
      ...prev,
      lastPushedDate: (scheduled || anySent) ? todayKey(nowMs) : (prev.lastPushedDate || ''),
      lastAttemptAt: nowMs,
      lastResults: results,
      rankErrors,
    });
    this.lastRun = { at: nowMs, ok: anySent, rankErrors, results };
    return { ok: anySent, rankErrors, results };
  }
}
