import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ProxyAgent, fetch as undiciFetch } from 'undici';
import { imageType } from '../../core/image-type.js';
import { buildPixivPdf } from '../pixiv/pdf.js';
import { ehentaiConfig } from './config.js';
import { EhentaiDirect } from './direct.js';
import { dailyUrl, galleryUrl, imageUrl, parseGallery, parseImagePage, parseListing, searchUrl } from './site.js';

const HOUR = 3600000;
const LIST_TTL = 30 * 60000;
const USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const safeTitle = (text) => String(text || '').replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\[CQ:[^\]]*\]/gi, '').trim().slice(0, 90);
const fileName = (text) => safeTitle(text).replace(/[<>:"/\\|?*]/g, '_').slice(0, 75);

export class EhentaiManager {
  constructor(options) {
    this.options = options;
    this.root = path.join(options.dataDir, 'ehentai');
    this.lists = new Map();
    this.active = null;
    this.timer = null;
    this.proxy = null;
    this.proxyUrl = '';
    this.direct = null;
    this.directIps = '';
    this.sync();
  }
  settings() { return ehentaiConfig(this.options.getConfig().ehentai); }
  allowed(chatKey) {
    const s = this.settings();
    const owner = String(this.options.getConfig().admin?.ownerUin || '');
    return s.enabled && this.options.canRun(chatKey)
      && (chatKey === `private:${owner}` || s.allowedChats.includes(chatKey));
  }
  hasList(chatKey) {
    const state = this.lists.get(chatKey);
    if (state && Date.now() - state.at < LIST_TTL) return true;
    this.lists.delete(chatKey);
    return false;
  }
  sync() {
    if (this.settings().enabled && !this.timer) {
      this.sweep();
      this.timer = setInterval(() => this.sweep(), HOUR);
      this.timer.unref?.();
    } else if (!this.settings().enabled && this.timer) {
      clearInterval(this.timer); this.timer = null;
      this.active?.abort(); this.lists.clear();
    }
    if (this.active?.chatKey && !this.allowed(this.active.chatKey)) this.active.abort();
  }
  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null; this.active?.abort(); this.lists.clear();
    void this.proxy?.close(); this.proxy = null;
    this.direct?.close(); this.direct = null;
  }
  sweep() {
    if (!this.settings().enabled) return { removed: 0 };
    const dir = path.join(this.root, 'pdf');
    const deadline = Date.now() - this.settings().keepHours * HOUR;
    let removed = 0;
    if (fs.existsSync(dir)) for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile() || !/^\d+-[a-f0-9]+\.pdf$/i.test(entry.name)) continue;
      const target = path.join(dir, entry.name);
      try {
        if (this.active?.file === target || fs.lstatSync(target).isSymbolicLink()) continue;
        if (fs.statSync(target).mtimeMs < deadline) { fs.rmSync(target); removed++; }
      } catch (error) { this.options.log?.(`E站 PDF 清理失败：${error.message}`); }
    }
    const jobs = path.join(this.root, 'jobs');
    if (fs.existsSync(jobs)) for (const entry of fs.readdirSync(jobs, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^job-[a-f0-9-]{36}$/i.test(entry.name)) continue;
      const target = path.join(jobs, entry.name);
      if (this.active?.job === target) continue;
      try { if (fs.statSync(target).mtimeMs < Date.now() - 24 * HOUR) fs.rmSync(target, { recursive: true, force: true }); } catch { /* 下次清理 */ }
    }
    return { removed };
  }
  async fetch(url, limit, signal, referer = 'https://e-hentai.org/') {
    const target = new URL(url);
    if (target.protocol !== 'https:' || target.username || target.password || target.hash
      || !(target.hostname === 'e-hentai.org' || imageUrl(url))) throw new Error('站点返回了不允许的地址');
    const proxyUrl = this.settings().proxyUrl;
    if (proxyUrl !== this.proxyUrl) {
      void this.proxy?.close(); this.proxy = proxyUrl ? new ProxyAgent(proxyUrl) : null;
      this.proxyUrl = proxyUrl;
    }
    const directIps = this.settings().directIps;
    if (JSON.stringify(directIps) !== this.directIps) {
      this.direct?.close(); this.direct = new EhentaiDirect(directIps);
      this.directIps = JSON.stringify(directIps);
    }
    const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(this.settings().timeoutMs)]);
    let response;
    try {
      const init = { redirect: 'manual', signal: requestSignal,
        headers: { 'user-agent': USER_AGENT, referer },
        ...(this.proxy && !this.options.fetchImpl ? { dispatcher: this.proxy } : {}) };
      response = this.options.fetchImpl ? await this.options.fetchImpl(url, init)
        : this.proxy ? await undiciFetch(url, init)
          : target.hostname === 'e-hentai.org' ? await this.direct.fetch(url, { ...init, limit })
            : await fetch(url, init);
    } catch (error) {
      if (signal.aborted) throw error;
      throw new Error(this.proxy ? 'E站代理连接失败或目标站点不可达，请检查专用代理。' : `E-Hentai 直连失败：${error.message}；可更新直连 IP 或配置专用本机代理。`, { cause: error });
    }
    if (!response.ok) throw new Error(`E-Hentai 请求失败：HTTP ${response.status}`);
    if (Number(response.headers.get('content-length') || 0) > limit) throw new Error('站点返回内容超过大小上限');
    const parts = []; let size = 0;
    for await (const part of response.body) {
      size += part.length;
      if (size > limit) throw new Error('站点返回内容超过大小上限');
      parts.push(part);
    }
    return Buffer.concat(parts, size);
  }
  async html(url, signal) { return (await this.fetch(url, 3 * 1048576, signal)).toString('utf8'); }
  async listing(state, needed, signal) {
    while (state.items.length < needed && state.next && state.fetched < 12) {
      const url = state.next; state.next = '';
      const parsed = parseListing(await this.html(url, signal), state.kind);
      const seen = new Set(state.items.map((item) => item.url));
      state.items.push(...parsed.items.filter((item) => !seen.has(item.url)));
      state.fetched++;
      state.next = state.kind === 'daily' && parsed.items.length ? `${dailyUrl}&p=${state.fetched}` : parsed.next;
    }
  }
  async send(chatKey, message, runId, signal) {
    this.sending = true;
    await this.options.send(chatKey, [message], { runId, signal, preserveCode: false });
    this.sending = false;
  }
  async upload(chatKey, pdf, name, bytes, runId, signal) {
    this.sending = true;
    await this.options.file(chatKey, { file: pdf, name, bytes }, { runId, signal, timeoutMs: 600000 });
    this.sending = false;
  }
  async showPage(chatKey, state, page, runId, signal) {
    if (!Number.isInteger(page) || page < 1 || page > 30) throw new Error('页码须为 1—30');
    await this.listing(state, page * 10, signal);
    const items = state.items.slice((page - 1) * 10, page * 10);
    if (!items.length) throw new Error('没有更多结果');
    state.page = page; state.at = Date.now();
    const title = state.kind === 'daily' ? 'E站昨日排行榜（按站方名次）' : `E站${state.kind === 'tag' ? '标签' : '搜索'}：${state.query}（按发布时间）`;
    const lines = items.map((item, index) => `${index + 1}. ${safeTitle(item.title)}${item.date ? ` · ${item.date}` : ''}${item.pages ? ` · ${item.pages}页` : ''}`);
    await this.send(chatKey, `${title} · 第${page}页\n${lines.join('\n')}\n回复 1—${items.length} 获取 PDF；“下一页”“上一页”或“第N页”翻页。`, runId, signal);
  }
  async downloadPdf(chatKey, item, runId, signal) {
    const s = this.settings();
    const match = galleryUrl(item.url).match(/\/g\/(\d+)\/([a-f0-9]+)/i);
    if (!match) throw new Error('作品地址无效');
    const pdfDir = path.join(this.root, 'pdf');
    fs.mkdirSync(pdfDir, { recursive: true, mode: 0o700 });
    const pdf = path.join(pdfDir, `${match[1]}-${match[2]}.pdf`);
    this.active.file = pdf;
    if (fs.existsSync(pdf) && fs.statSync(pdf).size > 0 && Date.now() - fs.statSync(pdf).mtimeMs < s.keepHours * HOUR) {
      await this.upload(chatKey, pdf, `E站-${match[1]}-${fileName(item.title)}.pdf`, fs.statSync(pdf).size, runId, signal);
      return;
    }
    const first = parseGallery(await this.html(item.url, signal), item.url, 0);
    const total = first.pageCount || item.pages;
    if (!total) throw new Error('无法确认画廊页数，未生成 PDF');
    if (total > s.maxPdfPages) throw new Error(`作品共 ${total} 页，超过当前 PDF 上限 ${s.maxPdfPages} 页`);
    const links = [...first.links];
    for (let p = 1; links.length < total && p < Math.ceil(total / Math.max(1, first.links.length)) + 2; p++) {
      signal.throwIfAborted();
      const page = parseGallery(await this.html(`${item.url}?p=${p}`, signal), item.url, p);
      if (!page.links.length) break;
      links.push(...page.links.filter((link) => !links.includes(link)));
    }
    if (links.length !== total) throw new Error(`画廊页数不完整（应有 ${total} 页，取得 ${links.length} 页），未生成 PDF`);
    const jobs = path.join(this.root, 'jobs');
    fs.mkdirSync(jobs, { recursive: true, mode: 0o700 });
    const job = path.join(jobs, `job-${randomUUID()}`);
    fs.mkdirSync(job, { mode: 0o700 }); this.active.job = job;
    const files = []; let bytes = 0;
    try {
      for (let index = 0; index < links.length; index++) {
        signal.throwIfAborted();
        if (index) await new Promise((resolve) => setTimeout(resolve, 250));
        const url = parseImagePage(await this.html(links[index], signal));
        if (!url) throw new Error(`第 ${index + 1} 页图片地址无效，未发送 PDF`);
        const buffer = await this.fetch(url, s.maxImageBytes, signal, links[index]);
        const type = imageType(buffer);
        if (!type) throw new Error(`第 ${index + 1} 页不是受支持的图片，未发送 PDF`);
        bytes += buffer.length;
        if (bytes > s.maxPdfBytes) throw new Error('图片总量超过 PDF 上限，未发送 PDF');
        const source = path.join(job, `${String(index + 1).padStart(4, '0')}.${type.split('/')[1]}`);
        fs.writeFileSync(source, buffer, { mode: 0o600 });
        files.push({ page: index + 1, file: source });
      }
      const output = path.join(job, 'output.pdf');
      const result = await (this.options.buildPdf || buildPixivPdf)({ files, output, signal, maxBytes: s.maxPdfBytes, pythonPath: s.pythonPath });
      signal.throwIfAborted();
      fs.renameSync(result.file, pdf);
      fs.chmodSync(pdf, 0o600);
      await this.upload(chatKey, pdf, `E站-${match[1]}-${fileName(first.title || item.title)}.pdf`, result.bytes, runId, signal);
    } finally {
      try { fs.rmSync(job, { recursive: true, force: true }); } catch { /* 启动后定期清理 */ }
      this.active.job = null;
    }
  }
  async handle(command, chatKey, messageId) {
    if (!this.allowed(chatKey)) return { handled: true, error: 'E站功能未启用，或当前会话未获允许。' };
    if (this.active) return { handled: true, error: 'E站任务正在处理中，请稍后再试。' };
    const controller = new AbortController();
    controller.chatKey = chatKey;
    this.active = controller;
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(15 * 60000)]);
    const runId = `ehentai-${messageId}`;
    this.sending = false;
    try {
      if (['tag', 'search', 'daily'].includes(command.kind)) {
        const state = { kind: command.kind, query: command.query || '', items: [], next: command.kind === 'daily' ? dailyUrl : searchUrl(command.query, command.kind), fetched: 0, page: 1, at: Date.now() };
        this.lists.set(chatKey, state);
        if (this.lists.size > 100) this.lists.delete(this.lists.keys().next().value);
        await this.showPage(chatKey, state, 1, runId, signal);
      } else {
        if (!this.hasList(chatKey)) throw new Error('请先发送 E站搜索、E站tag 或 E站每日排行榜。');
        const state = this.lists.get(chatKey);
        if (command.kind === 'select') {
          const item = state.items[(state.page - 1) * 10 + command.index - 1];
          if (!item || command.index > 10) throw new Error('序号不在当前页');
          this.active = { abort: () => controller.abort(), chatKey, file: null, job: null };
          await this.downloadPdf(chatKey, item, runId, signal);
        } else await this.showPage(chatKey, state, command.kind === 'turn' ? state.page + command.direction : command.page, runId, signal);
      }
      return { handled: true };
    } catch (error) {
      this.options.log?.(`E站任务失败：${error.message}`);
      return { handled: true, sendUnknown: this.sending, error: this.sending ? 'E站发送结果未确认，请先检查 QQ 会话；不会自动补发。' : signal.aborted ? 'E站任务已取消或超时，未自动重试。' : String(error.message).slice(0, 250) };
    } finally { this.active = null; }
  }
}
