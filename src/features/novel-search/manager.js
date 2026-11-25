import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { uploadFile, FILENAME_COMPATIBILITY_NOTE } from '../jm-suomingor/upload.js';
import { novelSearchConfig } from './config.js';
import { checkNovelRelayHealth, downloadNovelViaRelay, searchNovelsViaRelay } from './client.js';
import { buildNovelSearchNodes, formatNovelHelp, formatNovelSearchText } from './cards.js';

const LIST_TTL_MS = 30 * 60 * 1000;
const MAX_LISTS = 200;

const SOURCE_LABELS = Object.freeze({
  pixiv: 'Pixiv小说',
  cool18: '禁忌书屋',
  esjzone: 'ESJZone',
  telegram: 'Telegram频道'
});

const SOURCE_ALIASES = Object.freeze({
  pixiv: ['p站', 'p站小说', 'pixiv', 'pixiv小说'],
  cool18: ['书屋', '禁忌书屋', 'cool18'],
  esjzone: ['esj', 'esjzone', '轻小说']
});

function sanitizeUploadFileName(rawName, fallbackExt = '.txt') {
  const parsed = path.parse(String(rawName || '').trim());
  const ext = /^\.[a-z0-9]{1,8}$/i.test(parsed.ext) ? parsed.ext.toLowerCase() : fallbackExt;
  const safeBase = String(parsed.name || '')
    .replace(/[\\/:*?"<>|\x00-\x1f\x7f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 96);
  return `${safeBase || 'novel'}${ext}`;
}

function resolveRoute(command, settings) {
  const enabledSources = Object.entries(settings.sources || {})
    .filter(([, on]) => on)
    .map(([key]) => key);
  const enabledChannels = (settings.channels || []).filter((c) => c.enabled !== false);
  const channelIds = enabledChannels.map((c) => c.id);

  if (command.sourceHint) {
    if (!enabledSources.includes(command.sourceHint)) {
      return { sources: [], channelIds: [], label: SOURCE_LABELS[command.sourceHint] || command.sourceHint, query: command.query || '', disabledSource: command.sourceHint };
    }
    if (command.sourceHint === 'telegram' && command.channelHint) {
      const ch = enabledChannels.find((c) => c.id === command.channelHint);
      return {
        sources: ['telegram'],
        channelIds: ch ? [ch.id] : channelIds,
        label: ch ? ch.label : SOURCE_LABELS.telegram,
        query: command.query || ''
      };
    }
    return {
      sources: [command.sourceHint],
      channelIds: command.sourceHint === 'telegram' ? channelIds : [],
      label: SOURCE_LABELS[command.sourceHint] || command.sourceHint,
      query: command.query || ''
    };
  }

  // 支持 "/搜小说 书屋 关键词"、"/搜小说 P站 关键词"、"/搜小说 ESJ 关键词"、"/搜小说 蓝P 关键词"
  if (command.kind === 'search' && command.query) {
    const parts = command.query.split(/\s+/);
    if (parts.length >= 2) {
      const head = parts[0].replace(/^@+/, '').toLowerCase();
      for (const [srcKey, aliases] of Object.entries(SOURCE_ALIASES)) {
        if (aliases.includes(head) && enabledSources.includes(srcKey)) {
          return {
            sources: [srcKey],
            channelIds: [],
            label: SOURCE_LABELS[srcKey],
            query: parts.slice(1).join(' ').trim()
          };
        }
      }
      if (enabledSources.includes('telegram')) {
        const matched = enabledChannels.find((c) => c.id === head
          || c.label.toLowerCase() === head
          || (c.aliases || []).some((a) => a.toLowerCase() === head));
        if (matched) {
          return {
            sources: ['telegram'],
            channelIds: [matched.id],
            label: matched.label,
            query: parts.slice(1).join(' ').trim()
          };
        }
      }
    }
  }

  return {
    sources: enabledSources,
    channelIds: enabledSources.includes('telegram') ? channelIds : [],
    label: '',
    query: command.query || ''
  };
}

export class NovelSearchManager {
  constructor(options = {}) {
    this.getConfig = options.getConfig;
    this.canRun = options.canRun;
    this.send = options.send;
    this.forward = options.forward;
    this.onebot = options.onebot;
    this.fetchImpl = options.fetchImpl;
    this.uploadImpl = options.uploadImpl || uploadFile;
    this.dataDir = options.dataDir;
    this.file = path.join(options.dataDir, 'novel-search', 'history.json');
    this.tmpDir = path.join(options.dataDir, 'novel-search', 'tmp');
    this.lists = new Map();
    this.activeByChat = new Map();
    this.searchCooldowns = new Map();
    this.downloadCooldowns = new Map();
    this.history = [];
    try {
      const rows = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.history = Array.isArray(rows) ? rows.slice(-50) : [];
    } catch { /* 首次未启用时不创建目录 */ }
  }

  settings() {
    return novelSearchConfig(this.getConfig().novelSearch);
  }

  effectivePixivCookie(settings = this.settings()) {
    const own = String(settings?.pixivCookie || '').trim();
    if (own) return own;
    return String(this.getConfig()?.pixiv?.cookie || '').trim();
  }

  snapshot() {
    const rawSettings = this.settings();
    const { relayToken, pixivCookie, ...publicSettings } = rawSettings;
    return {
      settings: {
        ...publicSettings,
        hasRelayToken: Boolean(relayToken),
        hasPixivCookie: Boolean(pixivCookie),
        hasGlobalPixivCookie: Boolean(String(this.getConfig()?.pixiv?.cookie || '').trim())
      },
      activeChats: this.activeByChat.size,
      history: this.history.slice().reverse()
    };
  }

  async health() {
    return checkNovelRelayHealth(this.settings(), { fetchImpl: this.fetchImpl });
  }

  saveHistory() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.history.slice(-50)), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  recordHistory(entry) {
    this.history.push(entry);
    this.history = this.history.slice(-50);
    try { this.saveHistory(); } catch { /* 忽略持久化写入异常 */ }
  }

  allowed(chatKey, settings = this.settings()) {
    const [kind, id] = String(chatKey || '').split(':');
    if (!settings.enabled || !this.canRun(chatKey)) return false;
    if (kind === 'private') return settings.allowPrivate === true;
    if (kind === 'group') return settings.allowedGroups.includes(id);
    return false;
  }

  hasList(chatKey, now = Date.now()) {
    const session = this.lists.get(chatKey);
    if (!session) return false;
    if (now - session.updatedAt >= LIST_TTL_MS) {
      this.lists.delete(chatKey);
      return false;
    }
    return true;
  }

  enforce() {
    const settings = this.settings();
    for (const [chatKey, active] of this.activeByChat.entries()) {
      if (!this.allowed(chatKey, settings)) {
        active.controller.abort();
      }
    }
  }

  async stop() {
    const tasks = [];
    for (const active of this.activeByChat.values()) {
      active.controller.abort();
      if (active.task) tasks.push(active.task);
    }
    await Promise.allSettled(tasks);
  }

  async sendCard(chatKey, session, page, runId) {
    const built = buildNovelSearchNodes(session, page, {
      selfId: this.onebot?.selfId,
      name: this.onebot?.selfNickname
    });
    session.page = built.page;
    session.updatedAt = Date.now();
    if (typeof this.forward === 'function') {
      try {
        const sent = await this.forward(chatKey, { nodes: built.nodes, label: built.label }, { runId });
        if (!sent?.failed?.length) return;
      } catch { /* 合并转发失败时自动回退纯文本 */ }
    }
    await this.send(chatKey, [formatNovelSearchText(session, built.page)], { runId, preserveCode: false });
  }

  handle(command, chatKey, messageId) {
    const settings = this.settings();
    const [kind, id] = String(chatKey || '').split(':');
    const runId = `novel-search-${messageId}`;
    const reply = (text) => this.send(chatKey, [text], { runId, preserveCode: false });
    if (!this.canRun(chatKey)) return Promise.resolve();

    if (!settings.enabled) {
      return reply('小说检索尚未启用，请在控制台“功能 → 小说检索”中开启。');
    }
    if ((kind === 'private' && !settings.allowPrivate) || (kind === 'group' && !settings.allowedGroups.includes(id))) {
      return reply('当前会话未获准使用小说检索。');
    }

    if (command.kind === 'help') {
      return reply(formatNovelHelp(settings));
    }

    if (command.kind === 'page' || command.kind === 'turn') {
      if (!this.hasList(chatKey)) {
        return reply('当前没有进行中的小说检索列表，请先发送 /搜小说 关键词。');
      }
      const session = this.lists.get(chatKey);
      const totalPages = Math.max(1, Math.ceil(session.items.length / session.pageSize));
      const targetPage = command.kind === 'page'
        ? command.page
        : session.page + command.direction;
      if (targetPage < 1) return reply('已经是第 1 页了。');
      if (targetPage > totalPages) return reply(`已经是最后一页（第 ${totalPages} 页）了。`);
      return this.sendCard(chatKey, session, targetPage, runId);
    }

    if (command.kind === 'select') {
      if (!this.hasList(chatKey)) {
        return reply('小说搜索列表已过期，请重新发送 /搜小说 关键词。');
      }
      const session = this.lists.get(chatKey);
      const item = session.items[command.index - 1];
      if (!item) {
        return reply(`序号超出范围，请回复 1—${session.items.length} 之间的数字。`);
      }
      if (this.activeByChat.has(chatKey)) {
        return reply('本会话已有小说任务处理中，请稍候完成再试。');
      }
      const lastDl = this.downloadCooldowns.get(chatKey) || 0;
      if (Date.now() - lastDl < settings.downloadCooldownSeconds * 1000) {
        return reply('下载请求过于频繁，请稍后再试。');
      }
      return this.startTask(chatKey, (signal) => this.runDownload(item, chatKey, runId, settings, signal));
    }

    if (command.kind === 'search' || command.kind === 'latest') {
      if (!settings.relayToken) {
        return reply('小说中转尚未配置令牌，请在控制台“功能 → 小说检索”中完成配置。');
      }
      if (this.activeByChat.has(chatKey)) {
        return reply('本会话已有小说检索或下载任务进行中，请稍候。');
      }
      const lastSearch = this.searchCooldowns.get(chatKey) || 0;
      if (Date.now() - lastSearch < settings.cooldownSeconds * 1000) {
        return reply('小说检索过于频繁，请稍后再试。');
      }
      this.searchCooldowns.set(chatKey, Date.now());
      if (this.searchCooldowns.size > 1000) this.searchCooldowns.delete(this.searchCooldowns.keys().next().value);
      return this.startTask(chatKey, (signal) => this.runSearch(command, chatKey, runId, settings, signal));
    }

    return Promise.resolve();
  }

  startTask(chatKey, runner) {
    const controller = new AbortController();
    const active = { controller, task: null };
    const exec = runner;
    this.activeByChat.set(chatKey, active);
    active.task = Promise.resolve()
      .then(() => exec(controller.signal))
      .finally(() => {
        if (this.activeByChat.get(chatKey) === active) {
          this.activeByChat.delete(chatKey);
        }
      });
    return active.task;
  }

  async runSearch(command, chatKey, runId, settings, signal) {
    const resolved = resolveRoute(command, settings);
    if (resolved.disabledSource) {
      await this.send(chatKey, [`书源「${resolved.label}」未在控制台启用。`], { runId, preserveCode: false });
      return;
    }
    if (!resolved.sources.length) {
      await this.send(chatKey, ['未启用任何小说书源，请在控制台至少开启一个书源。'], { runId, preserveCode: false });
      return;
    }
    const mode = command.kind === 'latest' ? 'latest' : 'search';
    const query = resolved.query;
    const startedAt = new Date().toISOString();
    try {
      const data = await searchNovelsViaRelay({
        mode,
        query,
        sources: resolved.sources,
        channels: resolved.channelIds,
        limit: 32,
        summaryMode: settings.summaryMode,
        pixivCookie: this.effectivePixivCookie(settings)
      }, settings, { fetchImpl: this.fetchImpl, signal });

      const items = Array.isArray(data?.items) ? data.items : [];
      this.recordHistory({
        id: randomUUID(),
        action: mode,
        chatKey,
        query: mode === 'latest' ? `[最新] ${resolved.label || '全书源'}` : query,
        count: items.length,
        status: 'ok',
        at: startedAt
      });

      if (!items.length) {
        await this.send(chatKey, [
          mode === 'latest'
            ? '暂未获取到近期小说更新，请稍后再试。'
            : `没有找到与「${query}」匹配的小说，可以换个关键词、简化 #标签 或去掉部分限制再试试。`
        ], { runId, preserveCode: false });
        return;
      }

      const session = {
        mode,
        query,
        channelLabel: resolved.label,
        items,
        pageSize: settings.pageSize,
        page: 1,
        channelErrors: data?.channelErrors || {},
        updatedAt: Date.now()
      };
      this.lists.delete(chatKey);
      this.lists.set(chatKey, session);
      while (this.lists.size > MAX_LISTS) this.lists.delete(this.lists.keys().next().value);

      await this.sendCard(chatKey, session, 1, runId);
    } catch (error) {
      if (signal?.aborted) return;
      const msg = String(error?.message || error || '未知错误');
      this.recordHistory({
        id: randomUUID(),
        action: mode,
        chatKey,
        query: mode === 'latest' ? '[最新]' : query,
        status: 'error',
        error: msg.slice(0, 160),
        at: startedAt
      });
      await this.send(chatKey, [`小说检索失败：${msg}`], { runId, preserveCode: false });
    }
  }

  async runDownload(item, chatKey, runId, settings, signal) {
    this.downloadCooldowns.set(chatKey, Date.now());
    if (this.downloadCooldowns.size > 1000) this.downloadCooldowns.delete(this.downloadCooldowns.keys().next().value);

    const ext = item.ext && /^\.[a-z0-9]{1,8}$/i.test(item.ext) ? item.ext.toLowerCase() : '.txt';
    const tmpFile = path.join(this.tmpDir, `novel-${randomUUID()}${ext}`);
    const startedAt = new Date().toISOString();
    const itemSource = item.source || (['pixiv', 'cool18', 'esjzone'].includes(item.channel) ? item.channel : 'telegram');
    const itemId = String(item.id || item.msgId || '');

    await this.send(chatKey, [
      `📥 正在获取《${item.title}》并上传群文件，请稍候…`
    ], { runId: `${runId}-start`, preserveCode: false });

    try {
      const downloaded = await downloadNovelViaRelay({
        source: itemSource,
        channel: item.channel,
        id: itemId,
        msgId: item.msgId,
        fallbackFileName: item.fileName,
        pixivCookie: this.effectivePixivCookie(settings)
      }, settings, tmpFile, { fetchImpl: this.fetchImpl, signal });

      const displayName = sanitizeUploadFileName(downloaded.fileName || `${item.title}${ext}`, ext);
      const fallbackTag = itemSource === 'telegram' ? `${item.channel}-${itemId}` : `${itemSource}-${itemId}`;
      const fallbackName = `NOVEL-${fallbackTag}${ext}`;

      const uploadFn = this.uploadImpl;
      const up = await uploadFn({
        onebot: this.onebot,
        chatKey,
        filePath: downloaded.filePath,
        name: displayName,
        publish: true,
        checkQuota: true,
        fallbackName,
        fallbackOnFailure: true
      });

      if (!up?.ok) {
        const errText = String(up?.error || '文件上传失败');
        this.recordHistory({
          id: randomUUID(),
          action: 'download',
          chatKey,
          query: item.title,
          channel: item.channel || itemSource,
          status: 'error',
          error: errText.slice(0, 160),
          at: startedAt
        });
        await this.send(chatKey, [`❌ 《${item.title}》上传失败：${errText}`], { runId: `${runId}-fail`, preserveCode: false });
        return;
      }

      this.recordHistory({
        id: randomUUID(),
        action: 'download',
        chatKey,
        query: item.title,
        channel: item.channel || itemSource,
        size: downloaded.size,
        cacheHit: downloaded.cacheHit,
        status: 'ok',
        at: startedAt
      });

      const notes = [`✅ 已上传《${item.title}》`];
      if (up.usedFallbackName) {
        notes.push(FILENAME_COMPATIBILITY_NOTE);
        notes.push(`📎 群文件名：${up.fileName || fallbackName}`);
      } else {
        notes.push(`📎 群文件名：${displayName}`);
      }
      if (downloaded.encoding && downloaded.encoding !== 'binary' && downloaded.encoding !== 'utf-8') {
        notes.push(`🔤 已自动从 ${downloaded.encoding} 转为 UTF-8 防乱码`);
      }
      await this.send(chatKey, [notes.join('\n')], { runId: `${runId}-done`, preserveCode: false });
    } catch (error) {
      if (signal?.aborted) return;
      const msg = String(error?.message || error || '未知错误');
      this.recordHistory({
        id: randomUUID(),
        action: 'download',
        chatKey,
        query: item.title,
        channel: item.channel || itemSource,
        status: 'error',
        error: msg.slice(0, 160),
        at: startedAt
      });
      await this.send(chatKey, [`❌ 获取《${item.title}》失败：${msg}`], { runId: `${runId}-err`, preserveCode: false });
    } finally {
      fs.rmSync(tmpFile, { force: true });
    }
  }
}
