import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  pickBiliLink, pickBareVideoToken, resolveLink, fetchVideoInfo, getPlayUrl,
  downloadVideo, searchVideos, safeFileName, shareCaption, qualityLabel
} from './bilibili-api.js';

const URL_RE = /https?:\/\/[^\s<>“”【】\[\]()'"`]+/gi;
const DEFAULT_COLLECTION_WORDS = ['合集', '歌单', '循环', '助眠', '白噪音', 'playlist', 'mix'];

function trimUrl(raw) { return String(raw || '').replace(/[),.!?，。！？】）}'"\\\]]+$/g, ''); }
function isAllowedBiliUrl(raw) {
  try {
    const host = new URL(raw).hostname.toLowerCase();
    return host === 'bilibili.com' || host.endsWith('.bilibili.com') || host === 'b23.tv' || host.endsWith('.b23.tv');
  } catch { return false; }
}
function decodeCardSource(value) {
  return String(value || '').replace(/\\u002f/gi, '/').replace(/\\\//g, '/')
    .replace(/&amp;/gi, '&').replace(/&quot;/gi, '"').replace(/&#x2f;/gi, '/').replace(/&#47;/gi, '/');
}
function collectCardSources(value, output = [], depth = 0) {
  if (value == null || depth > 6) return output;
  if (typeof value === 'string') {
    output.push(decodeCardSource(value));
    const trimmed = value.trim();
    if (/^[{[]/.test(trimmed)) {
      try { const parsed = JSON.parse(trimmed); if (parsed && parsed !== value) collectCardSources(parsed, output, depth + 1); } catch { /* XML 卡片 */ }
    }
  } else if (Array.isArray(value)) {
    for (const item of value.slice(0, 100)) collectCardSources(item, output, depth + 1);
  } else if (typeof value === 'object') {
    for (const item of Object.values(value).slice(0, 100)) collectCardSources(item, output, depth + 1);
  }
  return output;
}
function durationText(seconds) {
  const n = Math.max(0, Math.round(Number(seconds) || 0));
  return `${Math.floor(n / 60)}:${String(n % 60).padStart(2, '0')}`;
}
function normalizeConfig(config = {}) {
  const c = config.bilibili || {};
  return {
    enabled: c.enabled === true, allowPrivate: c.allowPrivate === true,
    downloader: String(c.downloader || 'bilibili-api'), ffmpeg: String(c.ffmpeg || 'unused'),
    qn: Math.min(80, Math.max(6, Number(c.qn) || 16)), mediaDir: String(c.mediaDir || '').trim(),
    maxDurationSeconds: Math.min(7200, Math.max(30, Number(c.maxDurationSeconds) || 900)),
    maxFileBytes: Math.min(1024 * 1024 * 1024, Math.max(20 * 1024 * 1024, Number(c.maxFileBytes) || 300 * 1024 * 1024)),
    timeoutMs: Math.min(15 * 60_000, Math.max(30_000, Number(c.timeoutMs) || 180_000)),
    maxConcurrent: Math.min(3, Math.max(1, Number(c.maxConcurrent) || 1)),
    rejectCollections: c.rejectCollections !== false,
    collectionKeywords: Array.isArray(c.collectionKeywords) && c.collectionKeywords.length ? c.collectionKeywords.map(String).slice(0, 40) : DEFAULT_COLLECTION_WORDS,
    preferredUploader: String(c.preferredUploader || '').trim(), searchMaxDurationSeconds: Math.min(7200, Math.max(30, Number(c.searchMaxDurationSeconds) || 900)),
    searchLimit: Math.min(10, Math.max(1, Number(c.searchLimit) || 5)), searchSort: ['relevance', 'date', 'views', 'duration'].includes(c.searchSort) ? c.searchSort : 'relevance', keywordCompletion: c.keywordCompletion !== false
  };
}
function searchSortMode(value) { return ({ relevance: 'default', date: 'default', views: 'play', duration: 'default' })[value] || 'default'; }

const MEDIA_RETENTION_MS = 10 * 60_000;
const MEDIA_PRUNE_AGE_MS = 2 * 60 * 60_000;

function pruneMediaJobs(root, maxAgeMs = MEDIA_PRUNE_AGE_MS) {
  try {
    if (!fs.existsSync(root)) return;
    const now = Date.now();
    for (const name of fs.readdirSync(root)) {
      if (!name.startsWith('job-')) continue;
      const target = path.join(root, name);
      try {
        const stat = fs.statSync(target);
        if (now - stat.mtimeMs > maxAgeMs) fs.rmSync(target, { recursive: true, force: true });
      } catch { /* 单个临时目录清理失败不影响发送 */ }
    }
  } catch { /* 目录不存在或暂时不可读 */ }
}

function removeMediaJobLater(jobDir, delayMs = MEDIA_RETENTION_MS) {
  const timer = setTimeout(() => {
    fs.promises.rm(jobDir, { recursive: true, force: true }).catch(() => {});
  }, delayMs);
  timer.unref?.();
}

export class BilibiliAutoForward {
  constructor({ dataDir, getConfig, sender, log = console } = {}) {
    this.dataDir = dataDir || os.tmpdir(); this.getConfig = getConfig || (() => ({})); this.sender = sender; this.log = log;
    this.running = 0; this.pending = []; this.seen = new Map(); this.tempRoot = path.join(this.dataDir, 'bilibili');
  }
  status() { const cfg = normalizeConfig(this.getConfig()); return { enabled: cfg.enabled, running: this.running, queued: this.pending.length, downloader: cfg.downloader, ffmpeg: cfg.ffmpeg }; }
  extractUrls(text) { return [...new Set(String(text || '').match(URL_RE)?.map(trimUrl).filter(isAllowedBiliUrl) || [])]; }
  extractUrlsFromSegments(segments) {
    const sources = [];
    for (const segment of segments || []) {
      if (!segment || typeof segment !== 'object') continue;
      if (segment.type === 'text') sources.push(segment.data?.text || ''); else collectCardSources(segment.data, sources);
    }
    return [...new Set(sources.flatMap((source) => this.extractUrls(source)))];
  }
  handleMessage({ chatKey, text, segments = null, isSelf = false } = {}) {
    const cfg = normalizeConfig(this.getConfig());
    if (!cfg.enabled || isSelf || !chatKey || (!cfg.allowPrivate && String(chatKey).startsWith('private:'))) return;
    const search = /^\s*(?:[\/#]?b(?:站|ilibili)\s*(?:搜索|搜|[\/#]?搜索b(?:站|ilibili)))\s+(.+)$/i.exec(String(text || ''));
    if (search) { this.searchAndReply(String(chatKey), search[1], cfg).catch((error) => this.log.warn?.(`[bilibili] 搜索失败：${error?.message ?? error}`)); return; }
    const urls = [...new Set([...this.extractUrls(text), ...this.extractUrlsFromSegments(segments)])];
    if (urls.length) this.log.info?.(`[bilibili] 检测到 ${urls.length} 个链接：${urls.join(', ')}`);
    for (const url of urls) this.enqueue({ chatKey: String(chatKey), url, cfg });
  }
  async searchAndReply(chatKey, query, cfg) {
    const terms = String(query || '').replace(/\s+/g, ' ').trim().slice(0, 100); if (!terms) return;
    const completed = cfg.keywordCompletion && !/\bbilibili\b|哔哩|b站/i.test(terms) ? `${terms} B站` : terms;
    const result = await searchVideos(completed, { limit: cfg.searchLimit, fetchLimit: Math.max(20, cfg.searchLimit), sortBy: searchSortMode(cfg.searchSort), maxDurationSec: cfg.searchMaxDurationSeconds, fuzzy: cfg.keywordCompletion, timeoutMs: cfg.timeoutMs, log: (message) => this.log.info?.(`[bilibili] ${message}`) });
    const items = result.ok ? result.items : [];
    const lines = items.map((item, index) => `${index + 1}. ${String(item.title || '未命名').slice(0, 80)}\n   UP主：${String(item.author || '未知').slice(0, 40)}  时长：${item.duration || durationText(item.durationSec)}\n   ${item.url}`);
    await this.sender.sendText(chatKey, lines.length ? `B站搜索：${terms}\n${lines.join('\n')}` : `没有找到符合条件的 B 站视频：${terms}${result.error ? `（${result.error}）` : ''}`);
  }
  enqueue(task) {
    const key = `${task.chatKey}|${task.url}`;
    const previous = this.seen.get(key) || 0;
    if (Date.now() - previous < 6 * 60 * 60_000) {
      this.log.info?.(`[bilibili] 跳过六小时内重复链接：${task.url}`);
      return;
    }
    this.seen.set(key, Date.now()); this.pending.push(task);
    this.log.info?.(`[bilibili] 已入队：${task.url}（队列 ${this.pending.length}）`);
    this.pump();
  }
  pump() {
    const cfg = normalizeConfig(this.getConfig());
    while (this.running < cfg.maxConcurrent && this.pending.length) { const task = this.pending.shift(); this.running += 1; this.process(task).catch((error) => this.log.warn?.(`[bilibili] ${error?.stack ?? error}`)).finally(() => { this.running -= 1; this.pump(); }); }
  }
  async sendCaption(chatKey, caption) { if (this.sender?.sendText) await this.sender.sendText(chatKey, caption); }
  async process({ chatKey, url, cfg }) {
    if (!isAllowedBiliUrl(url)) return;
    this.log.info?.(`[bilibili] 开始处理：${url}`);
    const link = pickBiliLink(url) || pickBareVideoToken(url) || url;
    const resolved = await resolveLink(link);
    if (resolved.error || resolved.kind !== 'video') { await this.sendCaption(chatKey, `B站链接解析失败：${resolved.error || '不是视频链接'}\n原链接：${url}`); return; }
    const info = await fetchVideoInfo(resolved, { timeoutMs: cfg.timeoutMs });
    if (!info.ok) { await this.sendCaption(chatKey, `B站视频信息获取失败：${info.error}\n原链接：${url}`); return; }
    const duration = Number(info.duration) || 0;
    if (duration > cfg.maxDurationSeconds) { await this.sendCaption(chatKey, `B站视频超过时长限制（${durationText(duration)} > ${durationText(cfg.maxDurationSeconds)}）\n原链接：${url}`); return; }
    const title = String(info.title || 'B站视频').replace(/\s+/g, ' ').trim(); const uploader = String(info.author || '未知 UP 主').replace(/\s+/g, ' ').trim();
    const collectionText = `${title} ${info.desc || ''} ${info.pageTitle || ''}`.toLowerCase();
    if (cfg.rejectCollections && cfg.collectionKeywords.some((word) => collectionText.includes(String(word).toLowerCase()))) { await this.sendCaption(chatKey, `已跳过疑似合集/歌单内容：${title}\n原链接：${url}`); return; }
    if (cfg.preferredUploader && !uploader.toLowerCase().includes(cfg.preferredUploader.toLowerCase())) return;
    const pageUrl = info.bvid ? `https://www.bilibili.com/video/${info.bvid}${info.page > 1 ? `?p=${info.page}` : ''}` : url;
    const caption = shareCaption({ ...info, title, author: uploader, duration }, { link: pageUrl });
    this.log.info?.(`[bilibili] 元信息成功：${info.bvid || url}，${durationText(duration)}，${title}`);
    const play = await getPlayUrl(info.bvid, info.cid, { qn: cfg.qn, timeoutMs: cfg.timeoutMs });
    if (!play.ok) { await this.sendCaption(chatKey, `${caption}\n视频流获取失败：${play.error}`); return; }
    if (play.sizeBytes && play.sizeBytes > cfg.maxFileBytes) { await this.sendCaption(chatKey, `${caption}\n视频大小超过 ${Math.round(cfg.maxFileBytes / 1048576)} MiB 限制，未下载。`); return; }
    const dir = cfg.mediaDir || this.tempRoot;
    await fs.promises.mkdir(dir, { recursive: true });
    pruneMediaJobs(dir);
    const jobDir = await fs.promises.mkdtemp(path.join(dir, 'job-'));
    const dest = path.join(jobDir, safeFileName(info));
    this.log.info?.(`[bilibili] 开始下载：${dest}`);
    let downloaded = false;
    try {
      const dl = await downloadVideo(play.urls, dest, { maxBytes: cfg.maxFileBytes, referer: pageUrl, timeoutMs: cfg.timeoutMs, log: (message) => this.log.info?.(`[bilibili] ${message}`) });
      if (!dl.ok) { await this.sendCaption(chatKey, `${caption}\n视频下载失败：${dl.error}`); return; }
      downloaded = true;
      this.log.info?.(`[bilibili] 下载完成：${(dl.bytes / 1048576).toFixed(1)} MB，准备发送`);
      await this.sender.video(chatKey, { file: dest, duration, label: title });
      // OneBot 可能以 status=async 先确认请求，NapCat 随后才读取本地文件；不能在这里立即删除。
      await this.sendCaption(chatKey, caption);
      this.log.info?.(`[bilibili] 已转发《${title}》（${uploader}，${qualityLabel(play.qn)}，${(dl.bytes / 1048576).toFixed(1)} MB）`);
    } finally {
      // 下载完成后即使 OneBot 返回错误也延迟清理，给异步媒体后端留下读取时间，
      // 同时保留现场以便排查；超过 2 小时由 pruneMediaJobs 回收。
      if (downloaded) removeMediaJobLater(jobDir);
      else await fs.promises.rm(jobDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}
export { normalizeConfig as normalizeBilibiliConfig };
