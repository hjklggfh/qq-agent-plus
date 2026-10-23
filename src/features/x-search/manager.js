import { setTimeout as delay } from 'node:timers/promises';
import { xSearchConfig } from './config.js';
import { fetchXPage, xThumbnail } from './client.js';
import { fetchXBrowserPage, xBrowserThumbnail } from './relay-client.js';
import { XPostTranslator } from './translation.js';
import fs from 'node:fs';
import path from 'node:path';
import { downloadXOriginal } from './originals.js';

const cleanXText = (value, limit = 1800) => String(value || '').replace(/\[CQ:[^\]]*\]/gi, '').replace(/[\x00-\x08\x0b-\x1f]/g, '').slice(0, limit);
const textSegment = (text) => ({ type: 'text', data: { text } });

export async function xCardNodes(page, options = {}) {
  const thumbnail = options.thumbnail || xThumbnail;
  const nodes = [];
  const node = (content) => ({ type: 'node', data: { uin: String(options.selfId || ''), name: '小鲸鱼', content } });
  for (const [index, post] of page.posts.entries()) {
    const date = Number.isFinite(Date.parse(post.createdAt))
      ? new Date(post.createdAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) : '时间未提供';
    const translation = post.translation ? `\n\n中文翻译（机器翻译）：\n${cleanXText(post.translation, 2200)}` : post.translationUnavailable ? '\n\n中文翻译暂不可用。' : '';
    const content = [textSegment(`${(options.offset || 0) + index + 1}. ${cleanXText(page.user.name, 80)} @${page.user.username}\n${date}（北京时间）\n${post.sensitive ? '⚠️ 该帖被 X 标记为敏感内容。\n' : ''}${cleanXText(post.text) + translation}\n原帖：${post.url}`)];
    if (options.includeImages) {
      // X 每帖最多四张配图；串行解码，总计最多二十张，不下载视频。
      for (const media of post.media.slice(0, 4)) {
        options.signal?.throwIfAborted();
        if (!media.url) continue;
        try { content.push(await thumbnail(media.url, options.signal)); }
        catch { content.push(textSegment('图片暂不可用，请查看原帖。')); }
      }
      if (post.media.some((m) => m.type !== 'photo')) content.push(textSegment('视频／动图请在原帖查看。'));
    }
    nodes.push(node(content));
  }
  nodes.push(node([textSegment(`X · @${page.user.username}\n${cleanXText(page.user.description, 240)}\n本页 ${page.posts.length} 条，按发布时间倒序。${page.posts.length ? '' : '该筛选条件下没有可显示的帖子。'}\n${page.next ? '发送「X下一页」查看更早的帖子。' : page.partial ? '本次未读取到下一页，可稍后重新查询或查看原账号。' : '没有下一页。'}\n发送「X 编号原图」获取该帖照片文件，例如「X ${(options.offset || 0) + 1}原图」。\n获取时间：${page.fetchedAt}${page.partial ? '\n本页可能不完整。' : ''}`)]));
  return nodes;
}

export class XSearchManager {
  constructor(options) {
    this.options = options;
    this.active = null;
    this.task = null;
    this.cache = new Map();
    this.sessions = new Map();
    this.cooldowns = new Map();
    this.translator = new XPostTranslator(options.complete);
    this.fingerprint = JSON.stringify(this.settings());
  }
  settings() { return xSearchConfig(this.options.getConfig().xSearch); }
  snapshot() {
    const { bearerToken, relayToken, ...settings } = this.settings();
    return { settings: { ...settings, hasBearerToken: Boolean(bearerToken), hasRelayToken: Boolean(relayToken) }, running: Boolean(this.active) };
  }
  enforce() {
    const fingerprint = JSON.stringify(this.settings());
    if (fingerprint !== this.fingerprint) {
      this.active?.controller.abort();
      this.cache.clear(); this.sessions.clear(); this.cooldowns.clear();
      this.translator.clear();
      this.fingerprint = fingerprint;
    }
    if (this.active?.chatKey && !this.options.canRun(this.active.chatKey)) this.active.controller.abort();
  }
  async stop() { this.active?.controller.abort(); await this.task; this.cache.clear(); this.sessions.clear(); this.translator.clear(); }
  async preview(username) {
    const result = await this.start({ username }, '', '', 'preview');
    if (result.error) throw new Error(result.error);
    return result.page;
  }
  start(command, chatKey, messageId, senderId) {
    this.enforce();
    const settings = this.settings();
    if (!settings.enabled) return Promise.resolve({ error: 'X 账号检索尚未启用。' });
    if (!(settings.backend === 'tokyo-browser' ? settings.relayToken : settings.bearerToken)) return Promise.resolve({ error: `请先在控制台「功能 → X 账号检索」配置${settings.backend === 'tokyo-browser' ? '东京中转令牌' : ' Bearer Token'}。` });
    if (chatKey && !this.options.canRun(chatKey)) return Promise.resolve({});
    if (this.active) return Promise.resolve({ error: 'X 正在查询，请稍后再试。' });
    const key = chatKey ? `${chatKey}:${senderId}` : 'preview';
    for (const [id, session] of this.sessions) if (Date.now() - session.at > 10 * 60 * 1000) this.sessions.delete(id);
    const session = this.sessions.get(key);
    if (command.next && !session?.next) return Promise.resolve({ error: '没有可用的 X 下一页，请先发送「X @用户名」。' });
    const selected = command.original ? session?.posts?.get(command.original) : null;
    if (command.original && !selected) return Promise.resolve({ error: '该 X 编号未查询或已过期，请先搜索并翻到对应页面。' });
    if (command.original && !selected.media.some((m) => m.type === 'photo')) return Promise.resolve({ error: '该帖没有可获取的照片原图；视频和动图暂不下载。' });
    if ((this.cooldowns.get(key) || 0) > Date.now()) return Promise.resolve({ error: 'X 查询冷却中，请稍后再试。' });
    const username = command.next || command.original ? session.username : command.username;
    if (!/^[a-z0-9_]{1,15}$/i.test(username || '')) return Promise.resolve({ error: '请输入有效的 X 用户名，例如「X @XDevelopers」。' });
    this.cooldowns.set(key, Date.now() + settings.cooldownSeconds * 1000);
    if (this.cooldowns.size > 200) this.cooldowns.delete(this.cooldowns.keys().next().value);
    const controller = new AbortController();
    const active = { controller, chatKey };
    this.active = active;
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(command.original ? 300000 : settings.timeoutSeconds * 1000)]);
    if (!command.next && !command.original) this.sessions.delete(key);
    const work = command.original
      ? this.runOriginal({ selected, username, chatKey, messageId, settings, signal })
      : this.run({ username, next: command.next ? session.next : '', previous: command.next ? session : null, offset: command.next ? session.offset : 0, key, chatKey, messageId, settings, signal });
    this.task = work
      .finally(() => { if (this.active === active) this.active = null; });
    return this.task;
  }
  async run(job) {
    const { username, next, key, chatKey, messageId, settings, signal } = job;
    let sending = false;
    try {
      const cacheKey = `${username.toLowerCase()}:${next}`;
      let page = this.cache.get(cacheKey);
      if (!page || Date.now() - Date.parse(page.fetchedAt) > 60000) {
        page = settings.backend === 'tokyo-browser'
          ? await (this.options.browserRequest || fetchXBrowserPage)(username, settings, { next, signal })
          : await fetchXPage(username, settings, { next, signal, request: this.options.request });
        this.cache.set(cacheKey, page);
        if (this.cache.size > 30) this.cache.delete(this.cache.keys().next().value);
      }
      signal.throwIfAborted();
      if (settings.translateChinese) page = await this.translator.translate(page, signal);
      if (!chatKey) return { page }; // 控制台预览不发送 QQ，也不下载缩略图。
      const nodes = await xCardNodes(page, { selfId: this.options.onebot.selfId,
        includeImages: settings.includeImages, offset: job.offset, signal, thumbnail: this.options.thumbnail
          || (settings.backend === 'tokyo-browser' ? (url, imageSignal) => xBrowserThumbnail(url, settings, imageSignal) : undefined) });
      const ensureAllowed = () => {
        signal.throwIfAborted();
        if (!this.settings().enabled || !this.options.canRun(chatKey)) throw new Error('X 查询已取消');
      };
      ensureAllowed();
      sending = true;
      const deliveryOptions = { runId: `x-search-${messageId}`, signal };
      const sent = await this.options.forward(chatKey, { nodes, label: `X @${username}` }, deliveryOptions);
      if (chatKey.startsWith('group:')) {
        const visible = await this.visible(chatKey, sent?.message_id, signal);
        if (visible === null) return { sendUnknown: true };
        if (visible === false) {
          ensureAllowed();
          const plain = nodes.map((n) => ({ ...n, data: { ...n.data, content: n.data.content.filter((s) => s.type !== 'image') } }));
          const fallback = await this.options.forward(chatKey, { nodes: plain, label: `X @${username} 文字版` }, deliveryOptions);
          if (await this.visible(chatKey, fallback?.message_id, signal) !== true) return { sendUnknown: true };
        }
      }
      const posts = new Map(job.previous?.posts || []);
      for (const [index, post] of page.posts.entries()) posts.set((job.offset || 0) + index + 1, { id: post.id, media: post.media.slice(0, 4) });
      while (posts.size > 100) posts.delete(posts.keys().next().value);
      this.sessions.set(key, { username, posts, next: page.next, offset: (job.offset || 0) + page.posts.length, at: Date.now() });
      if (this.sessions.size > 100) this.sessions.delete(this.sessions.keys().next().value);
      return { ok: true };
    } catch (error) {
      // 进入发送阶段后，任何异常都不再发提示或自动重发。
      if (sending) return { sendUnknown: true };
      if (signal.aborted) return { error: 'X 查询已取消或超时。' };
      return { error: cleanXText(error.message, 160) };
    }
  }
  async runOriginal({ selected, username, chatKey, messageId, settings, signal }) {
    let jobDir; let sending = false; let sent = 0;
    const root = path.resolve(this.options.dataDir || '.', 'tmp', 'x-search-originals');
    try {
      if (!chatKey || !this.options.file || !this.options.dataDir) throw new Error('当前宿主未配置原图文件发送');
      fs.mkdirSync(root, { recursive: true, mode: 0o700 });
      // 清理本模块一小时前遗留的临时任务；未知上传保留一小时供协议端完成读取。
      for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        if (!entry.isDirectory() || !/^job-/.test(entry.name)) continue;
        const old = path.resolve(root, entry.name);
        if (path.dirname(old) === root && Date.now() - fs.statSync(old).mtimeMs > 3600000) fs.rmSync(old, { recursive: true, force: true });
      }
      jobDir = fs.mkdtempSync(path.join(root, 'job-')); fs.chmodSync(jobDir, 0o700);
      const download = this.options.originalDownload || downloadXOriginal;
      for (const [index, media] of selected.media.entries()) {
        if (media.type !== 'photo') continue;
        signal.throwIfAborted();
        const file = path.join(jobDir, `photo-${index}`);
        const got = await download({ postId: selected.id, index, media }, settings, file,
          AbortSignal.any([signal, AbortSignal.timeout(60000)]));
        signal.throwIfAborted();
        if (!this.settings().enabled || !this.options.canRun(chatKey)) throw new Error('X 原图任务已取消');
        sending = true;
        await this.options.file(chatKey, { file, name: `X-${username}-${selected.id}-${index + 1}.${got.extension}`, bytes: got.bytes },
          { runId: `x-original-${messageId}`, signal, timeoutMs: 120000 });
        sending = false; sent++;
        fs.rmSync(file, { force: true });
      }
      return { ok: true, files: sent };
    } catch (error) {
      if (sending) return { sendUnknown: true };
      return { error: `${sent ? `前 ${sent} 张已上传，后续已停止：` : ''}${signal.aborted ? 'X 原图任务已取消或超时。' : cleanXText(error.message, 160)}` };
    } finally {
      if (!sending && jobDir && path.dirname(path.resolve(jobDir)) === root) {
        try { fs.rmSync(jobDir, { recursive: true, force: true }); } catch { /* 下一次任务清理。 */ }
      }
    }
  }
  async visible(chatKey, messageId, signal) {
    if (messageId == null) return null;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt) await delay(this.options.historyDelayMs ?? 1500, undefined, { signal });
      let history;
      try { history = await this.options.onebot.call('get_group_msg_history', { group_id: Number(chatKey.split(':')[1]), message_seq: 0, count: 50 }, 5000, signal); }
      catch { return null; }
      if (!Array.isArray(history?.messages)) return null;
      if (history.messages.some((m) => String(m.message_id) === String(messageId) && (m.message_seq == null || Number(m.message_seq) > 0))) return true;
    }
    return false;
  }
}
