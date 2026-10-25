import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { classifyTransportFailure } from '../onebot/sender.js';
import { safeFetchPublicBinary } from '../llm/safe-fetch.js';
import {
  pickBiliLink, pickBareVideoToken, resolveLink, fetchVideoInfo, getPlayUrl,
  downloadVideo, searchVideos, safeFileName, shareCaption, videoDetailCaption, qualityLabel
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
  constructor({ dataDir, getConfig, sender, downloadCover = safeFetchPublicBinary, log = console } = {}) {
    this.dataDir = dataDir || os.tmpdir(); this.getConfig = getConfig || (() => ({})); this.sender = sender; this.log = log;
    this.running = 0; this.pending = []; this.seen = new Map(); this.tempRoot = path.join(this.dataDir, 'bilibili');
    this.downloadCover = downloadCover;
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
  handleMessage({ chatKey, text, segments = null, messageId = null, isSelf = false } = {}) {
    const cfg = normalizeConfig(this.getConfig());
    if (!cfg.enabled || isSelf || !chatKey || (!cfg.allowPrivate && String(chatKey).startsWith('private:'))) return;
    const search = /^\s*(?:[\/#]?b(?:站|ilibili)\s*(?:搜索|搜|[\/#]?搜索b(?:站|ilibili)))\s+(.+)$/i.exec(String(text || ''));
    if (search) { this.searchAndReply(String(chatKey), search[1], cfg).catch((error) => this.log.warn?.(`[bilibili] 搜索失败：${error?.message ?? error}`)); return; }
    const urls = [...new Set([...this.extractUrls(text), ...this.extractUrlsFromSegments(segments)])];
    if (urls.length) this.log.info?.(`[bilibili] 检测到 ${urls.length} 个链接：${urls.join(', ')}`);
    for (const url of urls) this.enqueue({ chatKey: String(chatKey), url, messageId, cfg });
  }
  async searchAndReply(chatKey, query, cfg) {
    const terms = String(query || '').replace(/\s+/g, ' ').trim().slice(0, 100); if (!terms) return;
    const completed = cfg.keywordCompletion && !/\bbilibili\b|哔哩|b站/i.test(terms) ? `${terms} B站` : terms;
    const result = await searchVideos(completed, { limit: cfg.searchLimit, fetchLimit: Math.max(20, cfg.searchLimit), sortBy: searchSortMode(cfg.searchSort), maxDurationSec: cfg.searchMaxDurationSeconds, fuzzy: cfg.keywordCompletion, timeoutMs: cfg.timeoutMs, log: (message) => this.log.info?.(`[bilibili] ${message}`) });
    const items = result.ok ? result.items : [];
    const lines = items.map((item, index) => `${index + 1}. ${String(item.title || '未命名').slice(0, 80)}\n   UP主：${String(item.author || '未知').slice(0, 40)}  时长：${item.duration || durationText(item.durationSec)}\n   ${item.url}`);
    await this.sendCaption(chatKey, lines.length ? `B站搜索：${terms}\n${lines.join('\n')}` : `没有找到符合条件的 B 站视频：${terms}${result.error ? `（${result.error}）` : ''}`);
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
    while (this.running < cfg.maxConcurrent && this.pending.length) {
      const task = this.pending.shift();
      this.running += 1;
      this.process(task).catch(async (error) => {
        const transport = classifyTransportFailure(error);
        task.uncertain = (task.videoAttempted || task.previewAttempted && !task.previewSent) && error?.outcome !== 'failed'
          && !(transport.definite && !transport.uncertain);
        this.log.warn?.(`[bilibili] 转发失败：${error?.message ?? error}`);
        try {
          await this.sendCaption(task.chatKey, task.videoSent
            ? 'B站视频已发送，但说明发送失败；不会重复发送视频。'
            : task.uncertain
              ? 'B站转发发送结果未知，请先核对聊天记录；为避免重复发送，本次不会自动重试。'
              : `B站视频转发失败：${String(error?.message ?? error).slice(0, 180)}`);
        } catch (noticeError) {
          this.log.warn?.(`[bilibili] 失败提示未送出：${noticeError?.message ?? noticeError}`);
        }
      }).finally(() => {
        // 入队/处理中仍防重；只有确认成功或结果未知才保留六小时去重。
        if (!task.videoSent && !task.uncertain) this.seen.delete(`${task.chatKey}|${task.url}`);
        this.running -= 1;
        this.pump();
      });
    }
  }
  async sendCaption(chatKey, caption, options = {}) {
    const result = await this.sender.sendTextBatch(chatKey, [caption], options);
    if (Array.isArray(result?.failed) && result.failed.length) this.log.warn?.('[bilibili] 说明/失败提示未全部送出，请核对 outbox');
    return result;
  }
  async reportFailure(chatKey, message) {
    this.log.warn?.(`[bilibili] ${message}`);
    return this.sendCaption(chatKey, message);
  }
  async sendPreview(task, info, pageUrl, runId) {
    const text = videoDetailCaption(info, { link: pageUrl });
    const rawId = String(task.messageId ?? '');
    const options = { runId, replyToMessageId: /^-?[1-9]\d*$/.test(rawId) ? rawId : null };
    let cover;
    if (info.cover) {
      try {
        cover = await this.downloadCover(info.cover.startsWith('//') ? `https:${info.cover}` : info.cover,
          2 * 1024 * 1024, AbortSignal.timeout(10000), { Referer: pageUrl });
        if (!/^image\/(jpeg|png|webp|gif)(?:;|$)/i.test(cover.contentType)
          || !Buffer.isBuffer(cover.buffer) || !cover.buffer.length || cover.buffer.length > 2 * 1024 * 1024) throw new Error('封面不是支持的图片或超过大小限制');
      } catch (error) {
        cover = null;
        this.log.info?.(`[bilibili] 封面不可用，改发文字详情：${error?.message ?? error}`);
      }
    }
    task.previewAttempted = true;
    if (cover) {
      await this.sender.image(task.chatKey, { url: `base64://${cover.buffer.toString('base64')}`, bytes: cover.buffer.length, label: info.title, text }, options);
    } else {
      const result = await this.sendCaption(task.chatKey, text, options);
      if (result?.failed?.length) throw new Error('B站详情未全部送出');
    }
    task.previewSent = true;
  }
  async process(task) {
    const { chatKey, url, cfg } = task;
    if (!isAllowedBiliUrl(url)) return;
    this.log.info?.(`[bilibili] 开始处理：${url}`);
    const link = pickBiliLink(url) || pickBareVideoToken(url) || url;
    const resolved = await resolveLink(link);
    if (resolved.error || resolved.kind !== 'video') { await this.sendCaption(chatKey, `B站链接解析失败：${resolved.error || '不是视频链接'}\n原链接：${url}`); return; }
    const info = await fetchVideoInfo(resolved, { timeoutMs: cfg.timeoutMs });
    if (!info.ok) { await this.reportFailure(chatKey, `B站视频信息获取失败：${info.error}\n原链接：${url}`); return; }
    // 稳定外发ID让 sender/outbox 在重启和换分享链接后仍能阻止未知写入重放。
    const runId = `bilibili-${createHash('sha256').update(`${chatKey}|${info.bvid || info.aid}|${info.page || 1}`).digest('hex')}`;
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
    if (!play.ok) { await this.reportFailure(chatKey, `${caption}\n视频流获取失败：${play.error}`); return; }
    if (play.sizeBytes && play.sizeBytes > cfg.maxFileBytes) { await this.sendCaption(chatKey, `${caption}\n视频大小超过 ${Math.round(cfg.maxFileBytes / 1048576)} MiB 限制，未下载。`); return; }
    const dir = cfg.mediaDir || this.tempRoot;
    await fs.promises.mkdir(dir, { recursive: true });
    pruneMediaJobs(dir);
    const jobDir = await fs.promises.mkdtemp(path.join(dir, 'job-'));
    // OneBot/NapCat 可能由不同用户运行；mkdtemp 默认 0700，会让它把现有文件误报为 realpath ENOENT。
    await fs.promises.chmod(jobDir, 0o755);
    const dest = path.join(jobDir, safeFileName(info));
    this.log.info?.(`[bilibili] 开始下载：${dest}`);
    let downloaded = false;
    try {
      const dl = await downloadVideo(play.urls, dest, { maxBytes: cfg.maxFileBytes, referer: pageUrl, timeoutMs: cfg.timeoutMs, log: (message) => this.log.info?.(`[bilibili] ${message}`) });
      if (!dl.ok) { await this.reportFailure(chatKey, `${caption}\n视频下载失败：${dl.error}`); return; }
      downloaded = true;
      // 视频是 B 站公开内容，允许 OneBot 进程读取本地文件；失败时仍由延迟清理回收。
      await fs.promises.chmod(dest, 0o644);
      this.log.info?.(`[bilibili] 下载完成：${(dl.bytes / 1048576).toFixed(1)} MB，准备发送`);
      await this.sendPreview(task, info, pageUrl, runId);
      task.videoAttempted = true;
      await this.sender.video(chatKey, { file: dest, duration, label: title }, { runId });
      task.videoSent = true;
      // OneBot 可能以 status=async 先确认请求，NapCat 随后才读取本地文件；不能在这里立即删除。
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
