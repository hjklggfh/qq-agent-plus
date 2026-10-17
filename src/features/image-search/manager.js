import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { imageSearchConfig, IMAGE_SEARCH_PLATFORMS } from './config.js';
import { MAX_IMAGE_BYTES, boundedBody, formatSearchReply } from './common.js';
import { searchSegments } from './command.js';
import { imageType } from '../../core/image-type.js';
import { searchResultNodes } from './result-images.js';

export class ImageSearchManager {
  constructor(options) {
    this.getConfig = options.getConfig;
    this.canRun = options.canRun;
    this.download = options.download;
    this.send = options.send;
    this.forward = options.forward;
    this.onebot = options.onebot;
    this.store = options.store;
    this.fetch = options.fetchImpl || globalThis.fetch;
    this.file = path.join(options.dataDir, 'image-search', 'history.json');
    this.active = null;
    this.task = null;
    this.cooldowns = new Map();
    this.history = [];
    try {
      const rows = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.history = Array.isArray(rows) ? rows.slice(-50).map((r) => ({ ...r, status: r.status === 'running' ? 'interrupted' : r.status })) : [];
    } catch { /* 未启用过时不创建目录；损坏的历史不影响宿主启动。 */ }
  }
  settings() { return imageSearchConfig(this.getConfig().imageSearch); }
  snapshot() {
    const { relayToken, ...settings } = this.settings();
    return { settings: { ...settings, hasRelayToken: Boolean(relayToken) }, running: Boolean(this.active), history: this.history.slice().reverse() };
  }
  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.history.slice(-50)), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }
  enforce() {
    if (this.active && (JSON.stringify(this.settings()) !== JSON.stringify(this.active.settings) || !this.canRun(this.active.chatKey))) this.active.controller.abort();
  }
  async health() {
    const settings = this.settings();
    if (!settings.relayUrl || !settings.relayToken) throw new Error('请先保存中转地址和令牌');
    try {
      const signal = AbortSignal.timeout(5000);
      const res = await this.fetch(`${settings.relayUrl.replace(/\/$/, '')}/healthz`, { signal, redirect: 'error', headers: { authorization: `Bearer ${settings.relayToken}` } });
      if (!res.ok) throw new Error('unavailable');
      const data = JSON.parse((await boundedBody(res, 4096, signal)).toString('utf8'));
      if (data.ok !== true) throw new Error('invalid');
      return { ok: true, busy: data.busy === true, googleConfigured: data.googleConfigured === true };
    } catch { throw new Error('中转连接失败，请检查 SSH 隧道、地址及令牌'); }
  }
  async stop() { this.active?.controller.abort(); await this.task; }
  async image(command, chatKey, signal) {
    let segments = command.segments;
    if (!segments.some((s) => s.type === 'image')) {
      const mid = segments.find((s) => s.type === 'reply')?.data?.id;
      const local = mid && this.store.findByMid(chatKey, mid);
      // 只允许引用已入库的本会话消息，不能借 get_msg 读取其他群或私聊。
      if (local) {
        try {
          const message = await this.onebot.getMsg(mid);
          segments = searchSegments(message?.message);
        } catch { segments = []; /* 协议不支持 get_msg 时尝试本会话存档。 */ }
        if (!segments.some((s) => s.type === 'image')) segments = (local.media || []).filter((m) => m.kind === 'image').map((m) => ({ type: 'image', data: { url: m.url } }));
      }
    }
    signal.throwIfAborted();
    const item = segments.find((s) => s.type === 'image');
    const url = item?.data?.url || item?.data?.file;
    if (!url || !/^https?:\/\//i.test(url)) throw new Error('请发送“搜图＋一张图片”，或回复本会话已记录的图片发送“搜图”。');
    const { buffer } = await this.download(url, MAX_IMAGE_BYTES, signal);
    const type = imageType(buffer);
    if (!type || buffer.length > MAX_IMAGE_BYTES) throw new Error('仅支持不超过8MB的 PNG、JPEG、GIF、WebP 图片');
    return { buffer, type };
  }
  start(command, chatKey, messageId) {
    const settings = this.settings();
    const [kind, id] = chatKey.split(':');
    const runId = `image-search-${messageId}`;
    const reply = (text) => this.send(chatKey, [text], { runId, preserveCode: false });
    if (!this.canRun(chatKey)) return Promise.resolve();
    let reason = '';
    if (!settings.enabled) reason = '以图搜图尚未启用，请在控制台“设置 → 以图搜图”配置。';
    else if (kind === 'private' && !settings.allowPrivate || kind === 'group' && !settings.allowedGroups.includes(id)) reason = '当前会话未获准使用以图搜图。';
    else if (!settings.relayUrl || !settings.relayToken) reason = '请先配置搜图中转地址和令牌。';
    else if (command.platform === 'invalid') reason = '可用指令：搜图、搜图 Google、搜图 Yandex、搜图 trace.moe、搜图 全部。';
    else if (this.active) reason = '已有搜图任务正在运行，请稍后再试。';
    else if (Date.now() - (this.cooldowns.get(chatKey) || 0) < settings.cooldownSeconds * 1000) reason = '搜图请求过于频繁，请稍后再试。';
    if (reason) return reply(reason);
    const controller = new AbortController();
    this.active = { chatKey, controller, settings };
    this.cooldowns.delete(chatKey);
    this.cooldowns.set(chatKey, Date.now());
    if (this.cooldowns.size > 1000) this.cooldowns.delete(this.cooldowns.keys().next().value);
    this.task = this.run(command, chatKey, runId, controller, settings).finally(() => { this.active = null; this.task = null; });
    return Promise.resolve();
  }
  async run(command, chatKey, runId, controller, settings) {
    const record = { id: randomUUID(), chatKey, startedAt: new Date().toISOString(), status: 'running', platforms: [] };
    this.history.push(record);
    this.history = this.history.slice(-50);
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(settings.timeoutSeconds * 3000 + 60000)]);
    const guard = setInterval(() => {
      try { this.enforce(); } catch { controller.abort(); }
    }, 500);
    try {
      this.save();
      const image = await this.image(command, chatKey, signal);
      const platforms = command.platform === 'all' ? IMAGE_SEARCH_PLATFORMS : command.platform === 'auto'
        ? [settings.defaultPlatform, ...(settings.fallback ? IMAGE_SEARCH_PLATFORMS.filter((p) => p !== settings.defaultPlatform) : [])] : [command.platform];
      const enabled = platforms.filter((p) => settings.platforms[p]);
      if (!enabled.length) throw new Error('所选搜图平台已关闭');
      const reports = [];
      for (const platform of enabled) {
        if (!this.settings().enabled || !this.canRun(chatKey)) throw new Error('任务已取消');
        signal.throwIfAborted();
        const platformSignal = AbortSignal.any([signal, AbortSignal.timeout((settings.timeoutSeconds + 5) * 1000)]);
        try {
          const res = await this.fetch(`${settings.relayUrl.replace(/\/$/, '')}/v1/search`, {
            method: 'POST', redirect: 'error', signal: platformSignal,
            headers: { authorization: `Bearer ${settings.relayToken}`, 'content-type': image.type, 'x-search-platform': platform, 'x-search-limit': String(settings.limit), 'x-search-timeout': String(settings.timeoutSeconds), 'x-trace-min-similarity': String(settings.traceMinSimilarity) }, body: image.buffer
          });
          if (!res.ok) throw new Error(`中转服务 HTTP ${res.status}`);
          const report = JSON.parse((await boundedBody(res, 128 * 1024, platformSignal)).toString('utf8'));
          if (report.platform !== platform || !['ok', 'empty', 'blocked', 'error', 'unavailable'].includes(report.status) || !Array.isArray(report.results) || report.results.length > 20) throw new Error('中转返回格式无效');
          reports.push(report);
        } catch {
          signal.throwIfAborted();
          reports.push({ platform, status: 'error', message: '查询失败或超时，请检查中转服务及平台状态', results: [] });
        }
        if (command.platform === 'auto' && reports.at(-1).status === 'ok' && reports.at(-1).results.length) break;
      }
      record.platforms = reports.map((r) => ({ platform: r.platform, status: r.status, count: r.results.length }));
      record.status = reports.some((r) => r.status === 'ok' && r.results.length) ? 'done' : 'no-result';
      record.finishedAt = new Date().toISOString();
      this.save();
      const nodes = settings.sendImages && this.forward && reports.some((r) => r.status === 'ok' && r.results.length)
        ? await searchResultNodes(reports, settings, { signal, fetch: this.fetch, selfId: this.onebot.selfId, name: this.onebot.selfNickname }) : null;
      this.enforce();
      if (this.settings().enabled && this.canRun(chatKey) && !signal.aborted) {
        // 发送结果未知时由既有 outbox 管理，不重试或自动重跑搜索。
        try {
          const sent = nodes
            ? await this.forward(chatKey, { nodes, label: '以图搜图结果' }, { runId, signal })
            : await this.send(chatKey, [formatSearchReply(reports, settings.limit)], { runId, preserveCode: false, signal });
          if (sent?.failed?.length) throw new Error('部分发送未确认');
        } catch {
          record.status = 'send-unknown';
          try { this.save(); } catch { /* 不重试外发。 */ }
        }
      }
    } catch (error) {
      record.status = controller.signal.aborted ? 'cancelled' : 'failed';
      record.finishedAt = new Date().toISOString();
      try { this.save(); } catch { /* 历史写盘失败不能触发重复外发。 */ }
      if (!signal.aborted && this.settings().enabled && this.canRun(chatKey)) {
        // 不把包含地址或令牌的底层网络异常发到 QQ。
        const hint = /请发送|仅支持|平台已关闭/.test(error.message) ? error.message : '搜图未完成，请检查中转配置或稍后手动重试。';
        try { await this.send(chatKey, [hint], { runId: `${runId}-error`, preserveCode: false }); } catch { /* 无自动重试。 */ }
      }
    } finally { clearInterval(guard); }
  }
}
