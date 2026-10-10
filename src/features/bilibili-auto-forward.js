import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';

const URL_RE = /https?:\/\/[^\s<>「」【】]+/gi;
const DEFAULT_COLLECTION_WORDS = ['合集', '歌单', '循环', '助眠', '白噪音', 'playlist', 'mix'];

function trimUrl(raw) {
  return String(raw || '').replace(/[),.!?，。！？》】"'\\}\]]+$/g, '');
}

function hostOf(url) {
  try { return new URL(url).hostname.toLowerCase(); } catch { return ''; }
}

function isAllowedBiliUrl(raw) {
  const host = hostOf(raw);
  return host === 'bilibili.com' || host.endsWith('.bilibili.com') || host === 'b23.tv' || host.endsWith('.b23.tv');
}

function decodeCardSource(value) {
  return String(value || '')
    .replace(/\\u002f/gi, '/')
    .replace(/\\\//g, '/')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#x2f;/gi, '/')
    .replace(/&#47;/gi, '/');
}

function collectCardSources(value, output = [], depth = 0) {
  if (value == null || depth > 6) return output;
  if (typeof value === 'string') {
    const source = decodeCardSource(value);
    output.push(source);
    const trimmed = value.trim();
    if (/^[{[]/.test(trimmed)) {
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed && parsed !== value) collectCardSources(parsed, output, depth + 1);
      } catch { /* XML 或非 JSON 卡片，保留原文继续用 URL 正则提取 */ }
    }
    return output;
  }
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 100)) collectCardSources(item, output, depth + 1);
    return output;
  }
  if (typeof value === 'object') {
    for (const item of Object.values(value).slice(0, 100)) collectCardSources(item, output, depth + 1);
  }
  return output;
}

function run(command, args, { cwd, timeoutMs = 120000, signal } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch (error) { void error; } finish(reject, new Error(`命令超时（${timeoutMs}ms）`)); }, timeoutMs);
    const finish = (fn, value) => { if (settled) return; settled = true; clearTimeout(timer); fn(value); };
    child.stdout.on('data', (d) => { stdout += String(d); if (stdout.length > 2_000_000) stdout = stdout.slice(-2_000_000); });
    child.stderr.on('data', (d) => { stderr += String(d); if (stderr.length > 20_000) stderr = stderr.slice(-20_000); });
    child.once('error', (e) => finish(reject, e));
    child.once('close', (code) => code === 0 ? finish(resolve, { stdout, stderr }) : finish(reject, Object.assign(new Error(stderr.trim() || `命令退出码 ${code}`), { code })));
    if (signal) {
      if (signal.aborted) { try { child.kill('SIGKILL'); } catch (error) { void error; } finish(reject, signal.reason || new Error('已取消')); }
      else signal.addEventListener('abort', () => { try { child.kill('SIGKILL'); } catch (error) { void error; } finish(reject, signal.reason || new Error('已取消')); }, { once: true });
    }
  });
}

function parseJsonLine(stdout) {
  const line = String(stdout || '').trim().split(/\r?\n/).filter(Boolean).pop();
  if (!line) throw new Error('下载器没有返回视频信息');
  try { return JSON.parse(line); } catch { throw new Error('下载器返回的元数据无效'); }
}

function durationText(seconds) {
  const n = Math.max(0, Math.round(Number(seconds) || 0));
  return `${Math.floor(n / 60)}:${String(n % 60).padStart(2, '0')}`;
}

function normalizeConfig(config = {}) {
  const c = config.bilibili || {};
  return {
    enabled: c.enabled === true,
    allowPrivate: c.allowPrivate === true,
    downloader: String(c.downloader || 'yt-dlp'),
    ffmpeg: String(c.ffmpeg || 'ffmpeg'),
    maxDurationSeconds: Math.min(7200, Math.max(30, Number(c.maxDurationSeconds) || 900)),
    maxFileBytes: Math.min(1024 * 1024 * 1024, Math.max(20 * 1024 * 1024, Number(c.maxFileBytes) || 300 * 1024 * 1024)),
    timeoutMs: Math.min(15 * 60_000, Math.max(30_000, Number(c.timeoutMs) || 180_000)),
    maxConcurrent: Math.min(3, Math.max(1, Number(c.maxConcurrent) || 1)),
    rejectCollections: c.rejectCollections !== false,
    collectionKeywords: Array.isArray(c.collectionKeywords) && c.collectionKeywords.length ? c.collectionKeywords.map(String).slice(0, 40) : DEFAULT_COLLECTION_WORDS,
    preferredUploader: String(c.preferredUploader || '').trim(),
    searchMaxDurationSeconds: Math.min(7200, Math.max(30, Number(c.searchMaxDurationSeconds) || 900)),
    searchLimit: Math.min(10, Math.max(1, Number(c.searchLimit) || 5)),
    searchSort: ['relevance', 'date', 'views', 'duration'].includes(c.searchSort) ? c.searchSort : 'relevance',
    keywordCompletion: c.keywordCompletion !== false
  };
}

export class BilibiliAutoForward {
  constructor({ dataDir, getConfig, sender, log = console } = {}) {
    this.dataDir = dataDir || os.tmpdir();
    this.getConfig = getConfig || (() => ({}));
    this.sender = sender;
    this.log = log;
    this.running = 0;
    this.pending = [];
    this.seen = new Map();
    this.tempRoot = path.join(this.dataDir, 'bilibili');
  }

  status() {
    const cfg = normalizeConfig(this.getConfig());
    return { enabled: cfg.enabled, running: this.running, queued: this.pending.length, downloader: cfg.downloader, ffmpeg: cfg.ffmpeg };
  }

  extractUrls(text) {
    return [...new Set(String(text || '').match(URL_RE)?.map(trimUrl).filter(isAllowedBiliUrl) || [])];
  }

  extractUrlsFromSegments(segments) {
    const sources = [];
    for (const segment of segments || []) {
      if (!segment || typeof segment !== 'object') continue;
      if (segment.type === 'text') sources.push(segment.data?.text || '');
      if (segment.type === 'json' || segment.type === 'xml') {
        collectCardSources(segment.data, sources);
      }
    }
    return [...new Set(sources.flatMap((source) => this.extractUrls(source)))];
  }

  handleMessage({ chatKey, text, segments = null, isSelf = false } = {}) {
    const cfg = normalizeConfig(this.getConfig());
    if (!cfg.enabled || isSelf || !chatKey || (!cfg.allowPrivate && String(chatKey).startsWith('private:'))) return;
    const search = /^\s*(?:[\/#]?b(?:站|ilibili)\s*(?:搜索|搜)|[\/#]?搜索b(?:站|ilibili))\s+(.+)$/i.exec(String(text || ''));
    if (search) {
      this.searchAndReply(String(chatKey), search[1], cfg).catch((error) => this.log.warn?.(`[bilibili] 搜索失败：${error?.message ?? error}`));
      return;
    }
    const urls = [...new Set([
      ...this.extractUrls(text),
      ...this.extractUrlsFromSegments(segments)
    ])];
    for (const url of urls) this.enqueue({ chatKey: String(chatKey), url, cfg });
  }

  async searchAndReply(chatKey, query, cfg) {
    const terms = String(query || '').replace(/\s+/g, ' ').trim().slice(0, 100);
    if (!terms) return;
    const completed = cfg.keywordCompletion && !/\bbilibili\b|哔哩|b站/i.test(terms) ? `${terms} B站` : terms;
    const info = parseJsonLine((await run(cfg.downloader, [
      '--flat-playlist', '--dump-single-json', '--no-warnings', `ytsearch${cfg.searchLimit}:${completed}`
    ], { timeoutMs: cfg.timeoutMs })).stdout);
    let entries = Array.isArray(info.entries) ? info.entries.filter(Boolean) : [];
    entries = entries.filter((item) => {
      const duration = Number(item.duration) || 0;
      const uploader = String(item.uploader || item.channel || '');
      return duration <= cfg.searchMaxDurationSeconds
        && (!cfg.preferredUploader || uploader.toLowerCase().includes(cfg.preferredUploader.toLowerCase()));
    });
    const sorters = {
      date: (a, b) => String(b.upload_date || '').localeCompare(String(a.upload_date || '')),
      views: (a, b) => (Number(b.view_count) || 0) - (Number(a.view_count) || 0),
      duration: (a, b) => (Number(a.duration) || 0) - (Number(b.duration) || 0),
      relevance: () => 0
    };
    entries.sort(sorters[cfg.searchSort] || sorters.relevance);
    const lines = entries.slice(0, cfg.searchLimit).map((item, index) => {
      const title = String(item.title || '未命名').replace(/\s+/g, ' ').slice(0, 80);
      const uploader = String(item.uploader || item.channel || '未知 UP 主').slice(0, 40);
      return `${index + 1}. ${title}\n   UP 主：${uploader}  时长：${durationText(item.duration)}\n   ${item.webpage_url || item.url || ''}`;
    });
    await this.sender.sendText(chatKey, lines.length ? `B站搜索：${terms}\n${lines.join('\n')}` : `没有找到符合条件的 B 站视频：${terms}`);
  }

  enqueue(task) {
    const key = `${task.chatKey}|${task.url}`;
    const previous = this.seen.get(key) || 0;
    if (Date.now() - previous < 6 * 60 * 60_000) return;
    this.seen.set(key, Date.now());
    this.pending.push(task);
    this.pump();
  }

  pump() {
    const cfg = normalizeConfig(this.getConfig());
    while (this.running < cfg.maxConcurrent && this.pending.length) {
      const task = this.pending.shift();
      this.running += 1;
      this.process(task).catch((error) => this.log.warn?.(`[bilibili] ${error?.message ?? error}`)).finally(() => { this.running -= 1; this.pump(); });
    }
  }

  async process({ chatKey, url, cfg }) {
    if (!isAllowedBiliUrl(url)) return;
    await fs.promises.mkdir(this.tempRoot, { recursive: true });
    const dir = await fs.promises.mkdtemp(path.join(this.tempRoot, 'job-'));
    try {
      // 固定允许的 B 站域名，禁止播放列表，避免将合集当作单个视频处理。
      const info = parseJsonLine((await run(cfg.downloader, ['--dump-single-json', '--no-playlist', '--no-warnings', url], { timeoutMs: cfg.timeoutMs })).stdout);
      const duration = Number(info.duration) || 0;
      if (duration > cfg.maxDurationSeconds) throw new Error(`视频时长 ${durationText(duration)} 超过限制`);
      const title = String(info.title || 'B站视频').replace(/\s+/g, ' ').trim().slice(0, 120);
      const uploader = String(info.uploader || info.channel || '未知 UP 主').replace(/\s+/g, ' ').trim().slice(0, 80);
      const collectionText = `${title} ${String(info.playlist_title || '')}`.toLowerCase();
      if (cfg.rejectCollections && cfg.collectionKeywords.some((word) => collectionText.includes(String(word).toLowerCase()))) {
        throw new Error('疑似合集、歌单或循环内容，已跳过');
      }
      if (cfg.preferredUploader && !uploader.toLowerCase().includes(cfg.preferredUploader.toLowerCase())) throw new Error('UP 主不符合筛选条件');
      const output = path.join(dir, 'video.%(ext)s');
      await run(cfg.downloader, ['--no-playlist', '--no-warnings', '-f', 'bv*+ba/b', '--merge-output-format', 'mp4', '--ffmpeg-location', cfg.ffmpeg, '-o', output, url], { cwd: dir, timeoutMs: cfg.timeoutMs });
      const files = (await fs.promises.readdir(dir)).filter((name) => /\.(mp4|mkv|webm|mov)$/i.test(name));
      if (!files.length) throw new Error('下载器没有生成视频文件');
      const file = path.join(dir, files[0]);
      const stat = await fs.promises.stat(file);
      if (stat.size > cfg.maxFileBytes) throw new Error(`视频文件超过 ${Math.round(cfg.maxFileBytes / 1024 / 1024)} MiB 限制`);
      const caption = [`标题：${title}`, `UP 主：${uploader}`, `时长：${durationText(duration)}`, `原链接：${url}`].join('\n');
      await this.sender.video(chatKey, { file, duration, label: title }, { text: caption });
    } finally {
      await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

export { normalizeConfig as normalizeBilibiliConfig };
