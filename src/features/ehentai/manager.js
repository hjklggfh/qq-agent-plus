import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ProxyAgent, fetch as undiciFetch } from 'undici';
import { imageType } from '../../core/image-type.js';
import { buildPixivPdf } from '../pixiv/pdf.js';
import { ehentaiConfig } from './config.js';
import { EhentaiDirect } from './direct.js';
import { dailyUrl, galleryUrl, imageUrl, parseGallery, parseImagePage, parseListing, reloadImagePage, searchUrl } from './site.js';

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
    const cache = path.join(this.root, 'cache');
    if (fs.existsSync(cache)) for (const entry of fs.readdirSync(cache, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^\d+-[a-f0-9]+$/i.test(entry.name)) continue;
      const target = path.join(cache, entry.name);
      if (this.active?.cache === target) continue;
      try { if (fs.statSync(target).mtimeMs < Date.now() - 24 * HOUR) fs.rmSync(target, { recursive: true, force: true }); } catch { /* 下次清理 */ }
    }
    return { removed };
  }
  async fetch(url, limit, signal, referer = 'https://e-hentai.org/', directClient = null) {
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
          : target.hostname === 'e-hentai.org' ? await (directClient || this.direct).fetch(url, { ...init, limit })
            : await fetch(url, init);
    } catch (error) {
      if (signal.aborted) throw error;
      const message = this.proxy ? 'E站代理连接失败或目标站点不可达，请检查专用代理。'
        : target.hostname === 'e-hentai.org' ? `E-Hentai 主站直连失败：${error.message}`
          : `E站图片 CDN 请求失败：${error.message}`;
      throw new Error(message, { cause: error });
    }
    if (!response.ok) throw new Error(`E-Hentai 请求失败：HTTP ${response.status}`);
    if (!response.body) throw new Error('站点返回空内容');
    if (Number(response.headers.get('content-length') || 0) > limit) throw new Error('站点返回内容超过大小上限');
    const parts = []; let size = 0;
    for await (const part of response.body) {
      size += part.length;
      if (size > limit) throw new Error('站点返回内容超过大小上限');
      parts.push(part);
    }
    return Buffer.concat(parts, size);
  }
  async html(url, signal, directClient) { return (await this.fetch(url, 3 * 1048576, signal, 'https://e-hentai.org/', directClient)).toString('utf8'); }
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
  async downloadImage(link, index, settings, signal, directClient, failedHosts = new Set()) {
    let pageUrl = link;
    let lastError;
    let pageLoads = 0, staleLoads = 0, nlUses = 0;
    const tries = new Map();
    const totalTries = () => [...tries.values()].reduce((sum, count) => sum + count, 0);
    // 图片页每次普通加载都可能重新分配 H@H 节点，而且不消耗强制重载额度；?nl= 重载只在
    // 另一个小池子里轮换，还会计入站点图片额度。所以失败后先用普通加载换节点，连续多次
    // 拿不到新节点时才用一次 nl 换池。坏节点（高端口常见）由站点分配，等再久也不会通，
    // 不能因为“不是 443”就跳过下载，也不能锁死在 nl 池里。
    while (pageLoads < 10 && totalTries() < 4) {
      signal.throwIfAborted();
      pageLoads++;
      let pageHtml;
      try {
        pageHtml = await this.html(pageUrl, signal, directClient);
      } catch (error) {
        lastError = error;
        pageUrl = link;
        continue;
      }
      const url = parseImagePage(pageHtml);
      if (!url) { lastError = new Error('图片地址无效'); break; }
      let host = '', port = '';
      try {
        const address = new URL(url);
        host = address.host; port = address.port;
      } catch {
        lastError = new Error('图片地址无效');
        continue;
      }
      const reloadUrl = reloadImagePage(pageHtml, link);
      // 超时才算死节点（跨页也不再试）；几秒内就失败的更可能是瞬时网络错误，
      // 换过几次节点后再给它一次机会，避免把偶尔抖一下的好节点永久拉黑。
      const count = tries.get(host) || 0;
      const canTry = count === 0 || (count === 1 && staleLoads >= 2);
      if (failedHosts.has(host) || !canTry) {
        staleLoads++;
        if (staleLoads >= 6 && nlUses < 1 && reloadUrl) {
          pageUrl = reloadUrl; nlUses++; staleLoads = 0;
        } else pageUrl = link;
        continue;
      }
      tries.set(host, count + 1);
      staleLoads = 0;
      const started = Date.now();
      try {
        const imageSignal = AbortSignal.any([signal, AbortSignal.timeout(Math.min(settings.timeoutMs, port ? 8000 : 15000))]);
        const buffer = await this.fetch(url, settings.maxImageBytes, imageSignal, link, directClient);
        const type = imageType(buffer);
        if (!type) throw new Error('站点返回了不受支持的图片');
        return { buffer, type };
      } catch (error) {
        lastError = error;
        if (signal.aborted || /超过大小上限/.test(error.message)) throw error;
        const elapsed = Date.now() - started;
        if (elapsed >= 3000) failedHosts.add(host);
        this.options.log?.(`E站第${index + 1}页：节点 ${host} 获取失败（${elapsed}ms，${error.message}），重新分配节点`);
      }
      pageUrl = link;
    }
    throw new Error(`第 ${index + 1} 页图片获取失败：${lastError?.message || '未知错误'}，未发送 PDF`);
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
      await this.send(chatKey, `📦 E站 ${match[1]} 命中已生成的 PDF，正在发送…`, runId, signal);
      await this.upload(chatKey, pdf, `E站-${match[1]}-${fileName(item.title)}.pdf`, fs.statSync(pdf).size, runId, signal);
      return;
    }
    await this.send(chatKey, `🔍 开始处理 E站 ${match[1]}，正在读取画廊…`, runId, signal);
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
    const cache = path.join(this.root, 'cache', `${match[1]}-${match[2]}`);
    fs.mkdirSync(cache, { recursive: true, mode: 0o700 }); this.active.cache = cache;
    const files = new Array(links.length); let bytes = 0;
    try {
      for (const entry of fs.readdirSync(cache, { withFileTypes: true })) {
        const found = entry.name.match(/^(\d{4})\.(png|jpeg|webp|gif)$/);
        if (!entry.isFile() || !found) continue;
        const index = Number(found[1]) - 1;
        const source = path.join(cache, entry.name);
        if (index < 0 || index >= links.length || files[index]) continue;
        const stat = fs.lstatSync(source);
        if (stat.isSymbolicLink() || stat.size <= 512 || stat.size > s.maxImageBytes) continue;
        const type = imageType(fs.readFileSync(source));
        if (type !== `image/${found[2]}`) continue;
        files[index] = { page: index + 1, file: source };
        bytes += stat.size;
      }
      if (bytes > s.maxPdfBytes) throw new Error('已缓存图片总量超过 PDF 上限');
      fs.utimesSync(cache, new Date(), new Date());
      const cachedCount = files.filter(Boolean).length;
      await this.send(chatKey, `📥 已找到 ${total} 页，${cachedCount ? `已缓存 ${cachedCount} 张，继续下载` : '开始下载图片'}…`, runId, signal);
      const failed = new AbortController();
      const downloadSignal = AbortSignal.any([signal, failed.signal]);
      const failedHosts = new Set();
      let next = 0, completed = cachedCount, firstError = null, lastReported = cachedCount, lastReportAt = 0;
      let progress = Promise.resolve();
      const report = () => {
        if (completed >= links.length || completed - lastReported < 10
          || (lastReported && Date.now() - lastReportAt < 12000)) return;
        lastReported = completed; lastReportAt = Date.now();
        const count = completed;
        progress = progress.then(() => this.send(chatKey, `📥 下载中：${count}/${links.length} 张…`, runId, downloadSignal))
          .catch((error) => { if (!firstError) { firstError = error; failed.abort(error); } });
      };
      const workers = Array.from({ length: Math.min(3, links.length) }, async () => {
        const directClient = new EhentaiDirect(s.directIps);
        try {
          while (!downloadSignal.aborted) {
            const index = next++;
            if (index >= links.length) break;
            if (files[index]) continue;
            const { buffer, type } = await this.downloadImage(links[index], index, s, downloadSignal, directClient, failedHosts);
            bytes += buffer.length;
            if (bytes > s.maxPdfBytes) throw new Error('图片总量超过 PDF 上限，未发送 PDF');
            const source = path.join(cache, `${String(index + 1).padStart(4, '0')}.${type.split('/')[1]}`);
            const temporary = `${source}.part-${randomUUID()}`;
            fs.writeFileSync(temporary, buffer, { mode: 0o600 });
            fs.renameSync(temporary, source);
            files[index] = { page: index + 1, file: source };
            completed++; report();
          }
        } catch (error) {
          if (!firstError) { firstError = error; failed.abort(error); }
        } finally { directClient.close(); }
      });
      await Promise.all(workers);
      await progress;
      if (firstError) throw firstError;
      signal.throwIfAborted();
      if (files.filter(Boolean).length !== links.length) throw new Error('画廊图片不完整，未生成 PDF');
      await this.send(chatKey, `🖼 下载完成（${files.length} 张），正在合成 PDF…`, runId, signal);
      const output = path.join(job, 'output.pdf');
      const result = await (this.options.buildPdf || buildPixivPdf)({ files, output, signal, maxBytes: s.maxPdfBytes, pythonPath: s.pythonPath });
      signal.throwIfAborted();
      fs.renameSync(result.file, pdf);
      fs.chmodSync(pdf, 0o600);
      fs.rmSync(cache, { recursive: true, force: true });
      await this.send(chatKey, `📤 PDF 已生成（${(result.bytes / 1048576).toFixed(1)} MB），正在发送文件…`, runId, signal);
      await this.upload(chatKey, pdf, `E站-${match[1]}-${fileName(first.title || item.title)}.pdf`, result.bytes, runId, signal);
    } finally {
      try { fs.rmSync(job, { recursive: true, force: true }); } catch { /* 启动后定期清理 */ }
      this.active.job = null;
      this.active.cache = null;
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
