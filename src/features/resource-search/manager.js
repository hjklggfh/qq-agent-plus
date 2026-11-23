import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { imageType } from '../../core/image-type.js';
import { MAX_IMAGE_BYTES } from '../image-search/common.js';
import { searchSegments } from '../image-search/command.js';
import { imageSearchConfig } from '../image-search/config.js';
import { resourceSearchConfig } from './config.js';
import { resolveDeepSeekCredentials, runResourceSearchAgent } from './agent.js';
import { buildResourceSearchNodes, formatResourceSearchReply } from './cards.js';
import { resolveOverseasProxyUrl } from './sources.js';

export class ResourceSearchManager {
  constructor(options) {
    this.getConfig = options.getConfig;
    this.canRun = options.canRun;
    this.download = options.download;
    this.send = options.send;
    this.forward = options.forward;
    this.onebot = options.onebot;
    this.store = options.store;
    this.fetch = options.fetchImpl;
    this.complete = options.completeImpl;
    this.webSearch = options.webSearchImpl;
    this.webFetch = options.webFetchImpl;
    this.progressDelayMs = Number.isFinite(options.progressDelayMs) ? options.progressDelayMs : 20000;
    this.file = path.join(options.dataDir, 'resource-search', 'history.json');
    this.active = null;
    this.task = null;
    this.cooldowns = new Map();
    this.history = [];
    try {
      const rows = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.history = Array.isArray(rows)
        ? rows.slice(-50).map((r) => ({ ...r, status: r.status === 'running' ? 'interrupted' : r.status }))
        : [];
    } catch { /* 未启用过时不创建目录；损坏的历史不影响宿主启动。 */ }
  }

  settings() {
    return resourceSearchConfig(this.getConfig().resourceSearch);
  }

  snapshot() {
    const rawSettings = this.settings();
    const { deepseekApiKey, touchgalToken, ...publicSettings } = rawSettings;
    const fullCfg = this.getConfig();
    const globalDeepSeek = resolveDeepSeekCredentials(fullCfg, { ...rawSettings, deepseekApiKey: '' });
    const imgCfg = imageSearchConfig(fullCfg?.imageSearch);
    const hasTokyoRelay = Boolean(imgCfg.relayUrl && imgCfg.relayToken);
    const effectiveProxyUrl = resolveOverseasProxyUrl(rawSettings, { config: fullCfg });
    return {
      settings: {
        ...publicSettings,
        hasDeepseekApiKey: Boolean(deepseekApiKey),
        hasTouchgalToken: Boolean(touchgalToken),
        hasGlobalDeepseekKey: globalDeepSeek.configured,
        hasTokyoRelay,
        tokyoRelayUrl: hasTokyoRelay ? imgCfg.relayUrl : '',
        effectiveProxyUrl
      },
      running: Boolean(this.active),
      history: this.history.slice().reverse()
    };
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.history.slice(-50)), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  allowed(chatKey, settings = this.settings()) {
    const [kind, id] = String(chatKey || '').split(':');
    if (!settings.enabled || !this.canRun(chatKey)) return false;
    if (kind === 'private') return settings.allowPrivate === true;
    if (kind === 'group') return settings.allowedGroups.includes(id);
    return false;
  }

  enforce() {
    if (this.active && (
      JSON.stringify(this.settings()) !== JSON.stringify(this.active.settings)
      || !this.allowed(this.active.chatKey)
    )) {
      this.active.controller.abort();
    }
  }

  async stop() {
    this.active?.controller.abort();
    await this.task;
  }

  async extractImage(command, chatKey, signal) {
    let segments = Array.isArray(command?.segments) ? command.segments : [];
    if (!segments.some((s) => s?.type === 'image')) {
      const mid = segments.find((s) => s?.type === 'reply')?.data?.id;
      const local = mid && this.store?.findByMid?.(chatKey, mid);
      // 只允许引用已入库的本会话消息，不能借 get_msg 读取其他群或私聊。
      if (local) {
        try {
          const message = await this.onebot?.getMsg?.(mid);
          segments = searchSegments(message?.message);
        } catch { segments = []; }
        if (!segments.some((s) => s?.type === 'image')) {
          segments = (local.media || [])
            .filter((m) => m.kind === 'image')
            .map((m) => ({ type: 'image', data: { url: m.url } }));
        }
      }
    }
    signal?.throwIfAborted();
    const item = segments.find((s) => s?.type === 'image');
    const url = item?.data?.url || item?.data?.file;
    if (!url || !/^https?:\/\//i.test(url)) return null;
    if (typeof this.download !== 'function') return null;
    const { buffer } = await this.download(url, MAX_IMAGE_BYTES, signal);
    const type = imageType(buffer);
    if (!type || buffer.length > MAX_IMAGE_BYTES) {
      throw new Error('仅支持不超过8MB的 PNG、JPEG、GIF、WebP 截图');
    }
    return { buffer, type };
  }

  start(command, chatKey, messageId) {
    const settings = this.settings();
    const [kind, id] = String(chatKey || '').split(':');
    const runId = `resource-search-${messageId}`;
    const reply = (text) => this.send(chatKey, [text], { runId, preserveCode: false });
    if (!this.canRun(chatKey)) return Promise.resolve();

    const fullCfg = this.getConfig();
    const creds = resolveDeepSeekCredentials(fullCfg, settings);
    const enabledSites = Object.entries(settings.sources || {}).filter(([k, v]) => k !== 'animetrace' && v).map(([k]) => k);

    let reason = '';
    if (!settings.enabled) {
      reason = '资源检索尚未启用，请在控制台“功能 → 资源检索”中开启。';
    } else if ((kind === 'private' && !settings.allowPrivate) || (kind === 'group' && !settings.allowedGroups.includes(id))) {
      reason = '当前会话未获准使用资源检索。';
    } else if (!creds.configured) {
      reason = '请先在控制台“功能 → 资源检索”或“模型 API”中配置 DeepSeek API Key。';
    } else if (!enabledSites.length) {
      reason = '所选资源检索站点已全部关闭，请在控制台至少开启一个检索站点。';
    } else if (this.active) {
      reason = '已有资源检索任务正在后台运行，请稍后再试。';
    } else if (Date.now() - (this.cooldowns.get(chatKey) || 0) < settings.cooldownSeconds * 1000) {
      reason = '资源检索请求过于频繁，请稍后再试。';
    }
    if (reason) return reply(reason);

    const controller = new AbortController();
    this.active = { chatKey, controller, settings };
    this.cooldowns.delete(chatKey);
    this.cooldowns.set(chatKey, Date.now());
    if (this.cooldowns.size > 1000) this.cooldowns.delete(this.cooldowns.keys().next().value);

    this.task = this.run(command, chatKey, runId, controller, settings).finally(() => {
      this.active = null;
      this.task = null;
    });
    return Promise.resolve();
  }

  async run(command, chatKey, runId, controller, settings) {
    const query = String(command?.query || '').trim();
    const record = {
      id: randomUUID(),
      chatKey,
      query: query || '[图片检索]',
      startedAt: new Date().toISOString(),
      status: 'running',
      sources: []
    };
    this.history.push(record);
    this.history = this.history.slice(-50);
    const signal = AbortSignal.any([
      controller.signal,
      AbortSignal.timeout((settings.timeoutSeconds + 15) * 1000)
    ]);
    const guard = setInterval(() => {
      try { this.enforce(); } catch { controller.abort(); }
    }, 500);
    let digging = true;
    let progressSent = false;
    let progressTimer = null;
    if (this.progressDelayMs > 0) {
      progressTimer = setTimeout(() => {
        if (!digging || progressSent || signal.aborted || controller.signal.aborted || !this.allowed(chatKey)) return;
        progressSent = true;
        Promise.resolve(this.send(
          chatKey,
          ['🔍 仍在继续深挖全网资源与补丁线索，稍后整理完成发送，请稍候…'],
          { runId: `${runId}-progress`, preserveCode: false }
        )).catch(() => { /* 进度提示失败不影响主任务 */ });
      }, this.progressDelayMs);
    }

    try {
      this.save();
      const image = await this.extractImage(command, chatKey, signal);
      if (!query && !image) {
        throw new Error('请提供要检索的游戏/资源名称，或附带/回复一张游戏截图（如：/找资源 千恋万花）。');
      }

      const imageSearchSettings = imageSearchConfig(this.getConfig().imageSearch);
      const agentResult = await runResourceSearchAgent(
        { query, image },
        settings,
        {
          signal,
          getConfig: this.getConfig,
          imageSearchSettings,
          fetchImpl: this.fetch,
          completeImpl: this.complete,
          webSearchImpl: this.webSearch,
          webFetchImpl: this.webFetch
        }
      );
      digging = false;
      if (progressTimer) {
        clearTimeout(progressTimer);
        progressTimer = null;
      }

      const chatKind = String(chatKey || '').startsWith('private:') ? 'private' : 'group';
      record.sources = agentResult.sources || [];
      const nodes = this.forward
        ? await buildResourceSearchNodes(agentResult, settings, {
            query,
            chatKind,
            signal,
            getConfig: this.getConfig,
            imageSearchSettings,
            fetchImpl: this.fetch,
            selfId: this.onebot?.selfId,
            name: this.onebot?.selfNickname
          })
        : null;

      const hasHits = Boolean(nodes) || (agentResult.crawledItems && agentResult.crawledItems.length > 0);
      record.status = hasHits ? 'done' : 'no-result';
      record.finishedAt = new Date().toISOString();
      this.save();

      this.enforce();
      if (this.allowed(chatKey) && !signal.aborted) {
        try {
          const sent = nodes
            ? await this.forward(chatKey, { nodes, label: '资源检索结果' }, { runId, signal })
            : await this.send(chatKey, [formatResourceSearchReply(agentResult, settings, query, { chatKind })], { runId, preserveCode: false, signal });
          if (sent?.failed?.length) throw new Error('部分发送未确认');
        } catch (sendErr) {
          record.status = 'send-unknown';
          const rawMsg = String(sendErr?.message ?? sendErr ?? '');
          record.error = /no message receipt|delivery was not confirmed|retcode=100/i.test(rawMsg)
            ? 'QQ 未返回回执（疑似群聊外链或封面触发风控拦截）'
            : rawMsg.slice(0, 120);
          try { this.save(); } catch { /* 不重试外发。 */ }
        }
      }
    } catch (error) {
      record.status = controller.signal.aborted ? 'cancelled' : 'failed';
      record.finishedAt = new Date().toISOString();
      try { this.save(); } catch { /* 历史写盘失败不能触发重复外发。 */ }
      if (!signal.aborted && this.allowed(chatKey)) {
        const msg = String(error?.message ?? error);
        const hint = /请提供|仅支持|未检测到|已全部关闭/.test(msg)
          ? msg
          : '资源检索未完成，请检查 DeepSeek 密钥或目标站点网络状态后重试。';
        try {
          await this.send(chatKey, [hint], { runId: `${runId}-error`, preserveCode: false });
        } catch { /* 无自动重试。 */ }
      }
    } finally {
      digging = false;
      if (progressTimer) clearTimeout(progressTimer);
      clearInterval(guard);
    }
  }
}
