import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { pixivConfig, validRatings } from './config.js';
import { createPixivEngine } from './engine.js';
import { registerBuiltinFeature } from '../feature-registry.js';
import { imageType } from '../../core/image-type.js';
import { buildPixivPdf, sweepPdfJobs } from './pdf.js';

function readJson(file, fallback) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } }
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${randomUUID()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 });
  fs.renameSync(tmp, file);
}
const titleText = (s) => String(s || '').replace(/\[CQ:[^\]]*\]/gi, '').replace(/[\x00-\x1f]/g, ' ').slice(0, 180);

export class PixivManager {
  constructor(options) {
    this.options = options;
    this.dir = path.join(options.dataDir, 'pixiv');
    this.stateDir = path.join(this.dir, 'state');
    this.metadata = readJson(path.join(this.dir, 'metadata.json'), {});
    this.overrides = readJson(path.join(this.dir, 'ratings.json'), {});
    if (!this.metadata || typeof this.metadata !== 'object' || Array.isArray(this.metadata)) this.metadata = {};
    if (!this.overrides || typeof this.overrides !== 'object' || Array.isArray(this.overrides)) this.overrides = {};
    const history = readJson(path.join(this.dir, 'history.json'), []);
    this.history = (Array.isArray(history) ? history : []).filter((r) => r && typeof r === 'object').slice(-50).map((r) => ({ ...r, status: r.status === 'running' ? 'interrupted' : r.status }));
    this.active = null;
    this.task = null;
    this.cooldowns = new Map();
    this.engine = options.engine || createPixivEngine({ stateDir: this.stateDir, getSettings: () => this.settings(), log: options.log, fetchImpl: options.fetchImpl });
    registerBuiltinFeature({ id: 'pixiv', toolDefs: this.toolDefs() });
  }
  settings() { return pixivConfig(this.options.getConfig().pixiv); }
  allowed(chatKey) { return this.settings().enabled && this.options.canRun(chatKey); }
  migrateState() {
    if (!this.settings().enabled) return;
    const old = path.join(this.options.dataDir, 'plugin-state', 'pixiv-illust');
    for (const file of ['state.json', 'chat-ratings.json']) {
      const target = path.join(this.stateDir, file);
      if (!fs.existsSync(target) && fs.existsSync(path.join(old, file))) {
        const data = JSON.parse(fs.readFileSync(path.join(old, file), 'utf8'));
        writeJson(target, data); // 只复制，原件留作回滚；不覆盖已迁移的数据。
      }
    }
    this.engine.loadState();
  }
  ratings(chatKey) {
    const s = this.settings();
    const migrated = readJson(path.join(this.stateDir, 'chat-ratings.json'), {});
    return s.chatRatings?.[chatKey] || (!s.chatRatingsMigrated && migrated[chatKey]) || s.ratings;
  }
  snapshot() {
    const { cookie, proxyUrl, ...settings } = this.settings();
    const legacy = readJson(path.join(this.stateDir, 'chat-ratings.json'), readJson(path.join(this.options.dataDir, 'plugin-state', 'pixiv-illust', 'chat-ratings.json'), {}));
    return { settings: { ...settings, chatRatings: { ...(!settings.chatRatingsMigrated ? legacy : {}), ...settings.chatRatings }, hasCookie: Boolean(cookie), hasProxyUrl: Boolean(proxyUrl) },
      running: Boolean(this.active), history: this.history.slice().reverse(), overrides: this.overrides };
  }
  setRating(pid, rating) {
    if (!/^\d{5,12}$/.test(String(pid)) || !['safe', 'r18', 'r18g', 'clear'].includes(rating)) throw new Error('作品号或分级无效');
    if (rating === 'clear') delete this.overrides[pid];
    else this.overrides[pid] = { rating, updatedAt: new Date().toISOString() };
    writeJson(path.join(this.dir, 'ratings.json'), this.overrides);
    this.active?.controller.abort();
  }
  enforce() {
    if (this.active && (!this.allowed(this.active.chatKey) || JSON.stringify(this.settings()) !== this.active.settings)) this.active.controller.abort();
  }
  async stop() { this.active?.controller.abort(); await this.task; await this.engine.dispose?.(); registerBuiltinFeature({ id: 'pixiv' }); }
  cache(item) {
    if (!item || !this.engine.ratingKnown(item)) return;
    this.metadata[item.pid] = { ...item, xRestrict: this.engine.ratingOf(item), ratingKnown: true, cachedAt: Date.now() };
    const entries = Object.entries(this.metadata).sort((a, b) => b[1].cachedAt - a[1].cachedAt).slice(0, 200);
    this.metadata = Object.fromEntries(entries);
    writeJson(path.join(this.dir, 'metadata.json'), this.metadata);
  }
  async detail(pid, signal) {
    const cached = this.metadata[pid];
    if (cached && Date.now() - cached.cachedAt < 86400000) return cached;
    if (this.overrides[pid]) return { pid };
    const s = this.settings();
    const template = s.metadataUrlTemplate || 'https://www.pixiv.net/ajax/illust/{pid}';
    // 默认图片链路是国内可用的 Lolicon + pixiv.re，不把官方直连当必需依赖。
    if (!s.metadataUrlTemplate && !s.proxyUrl) return { pid };
    try {
      const raw = await this.engine.requestJson(template.replaceAll('{pid}', pid));
      const body = raw?.illust || raw?.body?.illust || raw?.body || raw;
      if (raw.error || String(body?.id ?? body?.illust_id) !== pid) throw new Error('作品详情无效');
      const item = this.engine.normalizeItem(body);
      if (!item) throw new Error('作品详情无效');
      const count = Number(body.pageCount ?? body.page_count);
      if (Number.isInteger(count) && count > 0) item.pageCount = Math.min(10000, count);
      item.imageUrls = this.engine.pickSizeUrls(body.urls || body.image_urls || {}, s.imageSize);
      const appPages = body.meta_pages || body.pages;
      if (Array.isArray(appPages)) item.pages = appPages.slice(0, 1000).map((p) => this.engine.pickSizeUrls(p.image_urls || p.urls || {}, s.imageSize));
      if (!item.pageCount && item.pages?.length) item.pageCount = item.pages.length;
      if (!item.pages?.length && item.pageCount > 1 && (!s.metadataUrlTemplate || template.startsWith('https://www.pixiv.net/ajax/illust/'))) {
        try {
          const list = await this.engine.requestJson(`https://www.pixiv.net/ajax/illust/${pid}/pages`);
          if (Array.isArray(list.body)) item.pages = list.body.slice(0, 1000).map((p) => this.engine.pickSizeUrls(p.urls || {}, s.imageSize));
        } catch { signal.throwIfAborted(); /* 用详情地址推导页码，仍保留准确页数。 */ }
      }
      this.cache(item);
      return item;
    } catch {
      signal.throwIfAborted();
      return { pid };
    }
  }
  checkRating(item, chatKey) {
    const allowed = this.ratings(chatKey);
    if (!validRatings(allowed)) throw new Error('会话分级设置无效，请在 PID 搜索设置中检查');
    const marked = this.overrides[item.pid];
    const known = Boolean(marked) || this.engine.ratingKnown(item);
    const rating = marked?.rating || ['safe', 'r18', 'r18g'][this.engine.ratingOf(item)];
    if (!known) {
      if (this.settings().unknownRatingPolicy !== 'adult-only' || !allowed.includes('r18') || !allowed.includes('r18g')) {
        throw new Error(`无法确认 PID ${item.pid} 的分级。请在“设置 → PID 搜索”核实并标记该作品，或配置可用的作品详情接口；当前未发送图片。`);
      }
      return '未知分级（当前会话明确允许成人全部档位）';
    }
    if (!allowed.includes(rating)) throw new Error(`PID ${item.pid} 的分级为 ${rating}，当前会话不允许，未发送图片。`);
    return `${rating}${marked ? '（管理员标记）' : ''}`;
  }
  start(args, chatKey, messageId, signal) {
    if (this.active) return Promise.resolve({ content: 'PID 搜索正忙，请稍后再试。', isError: true, immediate: true });
    if (!this.allowed(chatKey)) return Promise.resolve({ content: 'PID 搜索未启用或当前会话不可用。', isError: true, immediate: true });
    if (Date.now() - (this.cooldowns.get(chatKey) || 0) < this.settings().cooldownSeconds * 1000) return Promise.resolve({ content: 'PID 请求过于频繁，请稍后再试。', isError: true, immediate: true });
    const controller = new AbortController();
    this.active = { chatKey, controller, settings: JSON.stringify(this.settings()) };
    this.cooldowns.set(chatKey, Date.now());
    if (this.cooldowns.size > 1000) this.cooldowns.delete(this.cooldowns.keys().next().value);
    this.task = this.run(args, chatKey, `pixiv-${messageId}`, controller, signal).finally(() => { this.active = null; this.task = null; });
    return this.task;
  }
  async run(args, chatKey, runId, controller, parentSignal) {
    const s = this.settings();
    const format = args.outputFormat || s.outputFormat;
    const pdf = format === 'pdf';
    const pageLimit = pdf ? s.maxPdfPages : s.maxPages;
    const signal = AbortSignal.any([controller.signal, ...(parentSignal ? [parentSignal] : []), AbortSignal.timeout(s.taskTimeoutSeconds * 1000)]);
    const record = { id: randomUUID(), chatKey, format, startedAt: new Date().toISOString(), status: 'running', pages: [], failedPages: [] };
    this.history.push(record); this.history = this.history.slice(-50);
    const save = () => writeJson(path.join(this.dir, 'history.json'), this.history);
    const guard = setInterval(() => this.enforce(), 500);
    this.engine.setSignal(signal);
    let sending = false;
    let jobDir;
    try {
      if (!['images', 'pdf'].includes(format)) throw new Error('发送方式无效');
      if (pdf) {
        if (!this.options.file) throw new Error('当前宿主不支持文件发送');
        const root = path.join(this.dir, 'pdf');
        sweepPdfJobs(root);
        jobDir = fs.mkdtempSync(path.join(root, 'job-'));
        fs.chmodSync(jobDir, 0o700);
      }
      this.migrateState(); this.engine.sweepTemp?.(); save();
      const pid = this.engine.extractPid(args.pid) || this.engine.extractPid(args.url);
      let works;
      if (pid) works = [await this.detail(pid, signal)];
      else {
        if (!String(args.keyword || '').trim()) throw new Error('请提供 PID、作品链接或关键词');
        const allowed = new Set(this.ratings(chatKey).map((v) => ['safe', 'r18', 'r18g'].indexOf(v)));
        const found = await this.engine.searchIllusts(this.engine.settings(), String(args.keyword).slice(0, 100), Math.min(s.maxCount, Number(args.count) || 1), allowed);
        works = this.engine.buildTryList(found.items, new Set([...this.engine.seenSet(), ...this.engine.deadSet()]), s.poolSize, Math.min(s.maxCount, Number(args.count) || 1), s.retryCandidates);
        if (!works.length) throw new Error('没有找到当前会话允许分级的作品，请换个关键词。');
        for (const item of works) this.cache(item);
      }
      for (const item of works) {
        if (!pid && new Set(record.pages.map((p) => p.pid)).size >= Math.min(s.maxCount, Number(args.count) || 1)) break;
        const rating = this.checkRating(item, chatKey);
        const from = Number(args.startPage || 1);
        const to = args.endPage === undefined ? Math.min(10000, from + pageLimit - 1) : Number(args.endPage);
        if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to < from || to > 10000 || to - from + 1 > pageLimit) throw new Error(`页码无效；每次最多 ${pageLimit} 页，可用“PID ${item.pid} 21-40${pdf ? ' PDF' : ''}”指定范围。`);
        const last = item.pageCount ? Math.min(item.pageCount, to) : to;
        if (from > last) throw new Error(`作品只有 ${item.pageCount} 页，请检查起始页。`);
        let batch = [], bytes = 0, seed = item, stopped = '', missingWork = false;
        const pdfFiles = [];
        const flush = async () => {
          if (!batch.length) return;
          signal.throwIfAborted(); this.enforce(); signal.throwIfAborted();
          const note = `Pixiv ${item.pid} · ${titleText(item.title)} · ${titleText(item.author)}\n分级：${rating}\n第 ${batch.map((p) => p.page).join('、')} 页${item.pageCount ? `／共 ${item.pageCount} 页` : '（总页数未知）'}\nhttps://www.pixiv.net/artworks/${item.pid}`;
          const nodes = [{ type: 'node', data: { uin: String(this.options.onebot.selfId || ''), name: 'PID 搜索', content: [{ type: 'text', data: { text: note } }] } },
            ...batch.map((p) => ({ type: 'node', data: { uin: String(this.options.onebot.selfId || ''), name: `第 ${p.page} 页`, content: [{ type: 'image', data: { file: `base64://${p.buffer.toString('base64')}` } }] } }))];
          sending = true;
          await this.options.forward(chatKey, { nodes, label: `Pixiv ${item.pid}` }, { runId, signal });
          sending = false;
          record.pages.push(...batch.map((p) => ({ pid: item.pid, page: p.page })));
          batch = []; bytes = 0;
          try { save(); } catch (error) { error.checkpoint = true; throw error; }
        };
        for (let page = from; page <= last; page++) {
          signal.throwIfAborted();
          let urls = item.pages?.[page - 1] || (page === 1 ? item.imageUrls : this.engine.pageUrlsOf(seed, page - 1, s.imageSize));
          urls = (urls || []).map((raw) => {
            try { const u = new URL(raw); if (u.hostname === 'i.pximg.net' && !s.proxyUrl) u.hostname = 'i.pixiv.re'; return u.href; } catch { return ''; }
          }).filter(Boolean);
          if (page > 1 && !urls.length) {
            // PID 简写页码从1起；不能退回不带页码的模板，否则会重复首页。
            const base = s.imageUrlTemplate.replaceAll('{pid}', item.pid);
            const suffix = this.engine.parseSuffixPath(base);
            if (suffix) urls = [`${suffix.origin}/${item.pid}-${page}.${suffix.ext}`];
          }
          try {
            const got = await this.engine.fetchImage({ ...item, imageUrl: '', imageUrls: urls, thumbnail: '' }, this.engine.settings(), { allowTemplate: page === 1 && !urls.length });
            seed = { ...item, imageUrl: got.usedUrl || got.url || urls[0] || seed.imageUrl, imageUrls: [got.usedUrl || got.url || urls[0]].filter(Boolean) };
            const buffer = fs.readFileSync(got.file);
            if (pdf) {
              try {
                if (!imageType(buffer)) throw new Error('返回内容不是图片');
                if (bytes + buffer.length > s.pdfMaxBytes) {
                  stopped = '已到 PDF 图片总大小上限，后续页面未下载；请指定后续页码继续';
                  break;
                }
                const file = path.join(jobDir, `${item.pid}-${page}.img`);
                fs.renameSync(got.file, file);
                pdfFiles.push({ page, file }); bytes += buffer.length;
              } finally {
                try { fs.unlinkSync(got.file); } catch { /* 已移动或已删除。 */ }
              }
              continue;
            }
            try { fs.unlinkSync(got.file); } catch { /* 下次清理临时目录。 */ }
            if (!imageType(buffer)) throw new Error('返回内容不是图片');
            if (batch.length && (batch.length >= s.pagesPerBatch || bytes + buffer.length > s.forwardBudgetBytes)) await flush();
            if (buffer.length > s.forwardBudgetBytes) { record.failedPages.push({ pid: item.pid, page, reason: '图片超过单批大小限制' }); continue; }
            batch.push({ page, buffer }); bytes += buffer.length;
          } catch (error) {
            if (sending || error.checkpoint) throw error;
            signal.throwIfAborted();
            if (!item.pageCount && [404, 410].includes(Number(error.status))) { missingWork = page === 1; stopped = '未知总页数，遇到不存在的页面后停止探测'; break; }
            record.failedPages.push({ pid: item.pid, page, reason: '图片下载失败或超限' });
            if (!item.pageCount) { stopped = `第 ${page} 页暂时取不到，后续页数未确认`; break; }
          }
        }
        const incomplete = stopped || from > 1 || (item.pageCount ? last < item.pageCount : true) || record.failedPages.some((p) => p.pid === item.pid);
        if (pdf && incomplete) record.partial = true;
        if (pdf && pdfFiles.length) {
          signal.throwIfAborted();
          const name = `Pixiv-${item.pid}-${pdfFiles[0].page}-${pdfFiles.at(-1).page}${incomplete ? '-部分' : ''}.pdf`;
          const result = await (this.options.buildPdf || buildPixivPdf)({ files: pdfFiles,
            output: path.join(jobDir, name), signal, maxBytes: s.pdfMaxBytes,
            pythonPath: this.options.getConfig().jm?.pythonPath });
          this.enforce(); signal.throwIfAborted();
          sending = true;
          await this.options.file(chatKey, { file: result.file, name, bytes: result.bytes }, { runId, signal });
          sending = false;
          record.pages.push(...result.pages.map((page) => ({ pid: item.pid, page })));
          try { save(); } catch (error) { error.checkpoint = true; throw error; }
          try {
            for (const page of pdfFiles) fs.rmSync(page.file, { force: true });
            fs.rmSync(result.file, { force: true });
          } catch { /* 文件已发送；清理失败不改变发送结果。 */ }
        } else await flush();
        if (record.pages.some((p) => p.pid === item.pid)) this.engine.markSeen(item.pid);
        else if (missingWork) this.engine.markDead(item.pid);
        record.note = stopped || (item.pageCount && last < item.pageCount ? `作品还有后续页，可发送“PID ${item.pid} ${last + 1}-${Math.min(item.pageCount, last + pageLimit)}${pdf ? ' PDF' : ''}”继续` : !item.pageCount ? '总页数未知，已到本次页数上限，可指定下一页继续' : '');
        if (pdf) {
          record.note = `Pixiv ${item.pid} · ${titleText(item.title)} · 分级：${rating}\nhttps://www.pixiv.net/artworks/${item.pid}\nPDF 按原页码排序，包含：${pdfFiles.map((p) => p.page).join('、') || '无'}。${incomplete ? '这是部分页面，不能视为全本。' : ''}${record.note}`;
        }
      }
      record.status = record.failedPages.length || (pdf ? record.partial : record.note) ? 'partial' : record.pages.length ? 'done' : 'failed';
      signal.throwIfAborted();
      if (!record.pages.length) throw new Error('本次未能发送图片，请检查作品分级、图片接口及页码。');
      if (record.failedPages.length || record.note) {
        sending = true;
        await this.options.send(chatKey, [`PID 取图：已发送 ${record.pages.length} 页。${record.failedPages.length ? `未取到：${record.failedPages.map((p) => `${p.pid} 第${p.page}页`).join('、')}。` : ''}${record.note || ''}`], { runId, signal, preserveCode: false });
        sending = false;
      }
      return { content: `已发送 ${record.pages.length} 页。${record.note || ''} 不要重复发送。` };
    } catch (error) {
      record.status = sending ? 'send-unknown' : signal.aborted ? 'cancelled' : record.pages.length ? 'partial' : 'failed';
      return { content: sending ? '发送结果未确认，已停止后续发送，请先检查 QQ 会话。' : signal.aborted ? 'PID 任务已取消或超时，已发送页面保留，不自动重试。' : String(error.message).slice(0, 350), isError: true, sendUnknown: sending };
    } finally {
      record.finishedAt = new Date().toISOString();
      try { save(); } catch { /* 落盘失败不能触发重复外发。 */ }
      this.engine.setSignal(undefined); clearInterval(guard);
      if (jobDir && !sending) { try { fs.rmSync(jobDir, { recursive: true, force: true }); } catch { /* 下次任务清理。 */ } }
    }
  }
  toolDefs() {
    return [{ name: 'pixiv_image', feature: 'pixiv', description: 'PID 搜索：按作品号、Pixiv链接或关键词发送插画；支持指定起止页、多页分批图片或打包 PDF 文件（outputFormat:pdf）。遵守本会话分级；失败后不要重复调用或编造已发送。',
      parameters: { type: 'object', properties: { pid: { type: 'string' }, url: { type: 'string' }, keyword: { type: 'string' }, count: { type: 'integer' }, startPage: { type: 'integer' }, endPage: { type: 'integer' }, outputFormat: { type: 'string', enum: ['images', 'pdf'], description: 'pdf 将作品各页打包为文件，避免合并卡片限制' } } },
      execute: (ctx, args) => this.start(args, ctx.chatKey, ctx.session?.leaseId || randomUUID(), ctx.signal) },
    { name: 'pixiv_set_rating', feature: 'pixiv', description: '查看当前会话的 Pixiv 分级；仅全局管理员可修改本会话允许的 safe/r18/r18g 分级。不得修改其他会话。',
      parameters: { type: 'object', properties: { action: { type: 'string', enum: ['get', 'set', 'clear'] }, ratings: { type: 'array', items: { type: 'string', enum: ['safe', 'r18', 'r18g'] } } } },
      execute: async (ctx, args) => {
        if (!this.allowed(ctx.chatKey)) return { content: 'PID 搜索未启用或会话不可用', isError: true };
        if (!args.action || args.action === 'get') return { content: JSON.stringify({ ratings: this.ratings(ctx.chatKey) }) };
        const caller = (ctx.triggerEntries || []).filter((r) => !r.self).at(-1)?.senderId;
        const owner = this.options.getConfig().admin?.ownerUin;
        if (!owner || String(caller) !== String(owner)) return { content: '只有全局管理员能修改本会话分级。', isError: true };
        if (!['set', 'clear'].includes(args.action) || args.action === 'set' && !validRatings(args.ratings)) return { content: '分级设置无效', isError: true };
        const chats = this.snapshot().settings.chatRatings;
        if (args.action === 'clear') delete chats[ctx.chatKey]; else chats[ctx.chatKey] = args.ratings;
        this.options.updateConfig({ pixiv: { chatRatings: { __replace__: chats }, chatRatingsMigrated: true } });
        this.enforce();
        return { content: JSON.stringify({ ratings: this.ratings(ctx.chatKey), saved: true }) };
      } }];
  }
}
