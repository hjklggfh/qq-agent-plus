import fs from 'node:fs';
import path from 'node:path';
import { nextAtFromHHMM } from '../../core/reminders.js';
import { todayKey } from '../../core/util.js';
import { formatGroupNetworkError } from '../../core/error-explain.js';
import { RANK_META, normalizeRankKind } from './rankings.js';

const VALID_KINDS = ['daily', 'weekly', 'monthly', 'total'];
const CATCHUP_WINDOW_MS = 30 * 60 * 1000;
const GROUP_INTERVAL_MS = 1500;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function explainPushError(error) {
  const raw = String(error?.message ?? error ?? '未知错误').trim();
  if (/返回为空/.test(raw)) return '站点接口暂未返回数据（可能刚跨天重置或上游暂无榜单条目）';
  if (/no message receipt|delivery was not confirmed|retcode=100/i.test(raw)) {
    return 'QQ 服务端未确认消息回执（可能图片触发了风控拦截或群消息发送失败）';
  }
  return formatGroupNetworkError(raw, '榜单拉取');
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
      time: String(j.rankPushTime || '23:50'),
      kinds: kinds.length ? kinds : ['daily', 'weekly'],
      chats,
      topN: Math.min(60, Math.max(4, Number(j.rankTopN) || 48)),
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
        const res = await this.getRank(kind, {
          force: forceRefresh,
          category: 'all',
          topN: cfg.topN,
          allowStale: false,
        });
        prepared.push(res);
      } catch (error) {
        const msg = explainPushError(error);
        rankErrors.push({ kind, label: RANK_META[kind].label, error: msg });
        this.log(`[jm-rank-push] 获取 ${RANK_META[kind].label} 失败：${error?.message ?? error}`);
      }
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
      const sendFailures = [];
      for (let rIdx = 0; rIdx < prepared.length; rIdx++) {
        const rank = prepared[rIdx];
        if (signal.aborted) break;
        try {
          const baseCaption = `${rank.payload.title}\n${rank.payload.subtitle}`;
          const hint = rIdx === prepared.length - 1
            ? '\n💡 也可发送「JM月榜」「JM热门」「JM同人日榜」「JM同人周榜」获取其他榜单，发「jm」查看全部指令。'
            : '';
          const caption = `${baseCaption}${hint}`;
          await this.onebot.sendSegments('group', groupId, [
            { type: 'text', data: { text: caption } },
            { type: 'image', data: { file: `file://${rank.imagePath}` } },
          ]);
          results.push({ chatKey, kind: rank.kind, ok: true });
        } catch (error) {
          chatOk = false;
          const rawMsg = String(error?.message ?? error).slice(0, 200);
          const friendly = explainPushError(error);
          sendFailures.push({ kind: rank.kind, label: rank.label, error: friendly });
          results.push({ chatKey, kind: rank.kind, ok: false, error: rawMsg });
          this.log(`[jm-rank-push] 发送到 ${chatKey}（${rank.label}）失败：${rawMsg}`);
        }
        await sleep(800);
      }
      const chatErrors = [...rankErrors, ...sendFailures];
      if (chatErrors.length && !signal.aborted) {
        const noticeLines = [
          `⚠️ 本次定时推送有 ${chatErrors.length} 项榜单未成功发出：`,
          ...chatErrors.map((e) => `• ${e.label}：${e.error}`),
          '可稍后发送「今日JM」「JM周榜」或「jm」手动获取。',
        ];
        try {
          await this.onebot.sendSegments('group', groupId, [
            { type: 'text', data: { text: noticeLines.join('\n') } },
          ]);
          results.push({ chatKey, kind: 'notice', ok: true });
        } catch (noticeErr) {
          chatOk = false;
          this.log(`[jm-rank-push] 发送失败说明到 ${chatKey} 出错：${noticeErr?.message ?? noticeErr}`);
        }
      }
      if (chatOk && i < cfg.chats.length - 1) await sleep(GROUP_INTERVAL_MS);
    }

    const anyRankSent = results.some((r) => r.ok && r.kind !== 'notice');
    const anyMessageSent = results.some((r) => r.ok);
    const nowMs = this.now();
    if (anyRankSent) this.lastSuccessAt = nowMs;
    else this.lastErrorAt = nowMs;
    const prev = this.#readState();
    this.#writeState({
      ...prev,
      lastPushedDate: (scheduled || anyMessageSent) ? todayKey(nowMs) : (prev.lastPushedDate || ''),
      lastAttemptAt: nowMs,
      lastResults: results,
      rankErrors,
    });
    this.lastRun = { at: nowMs, ok: anyRankSent, rankErrors, results };
    return { ok: anyRankSent, rankErrors, results };
  }
}
