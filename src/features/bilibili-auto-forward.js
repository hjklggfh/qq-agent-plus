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
import {
  DEFAULT_COLLECTION_KEYWORDS,
  collectCardSources,
  extractCandidateUrls,
  normalizeCollectionKeywords,
  matchCollectionKeyword,
  durationText,
  createSeenTracker,
  chmodBestEffort,
  pruneMediaJobs,
  removeMediaJobLater
} from './media-forward-common.js';

const BARE_BILI_HOSTS = ['b23.tv', 'www.bilibili.com', 'm.bilibili.com', 'bilibili.com', 't.bilibili.com'];
const BILI_TRACKING_PARAMS = new Set([
  'spm_id_from', 'vd_source', 'buvid', 'from_spmid', 'mid', 'share_source', 'share_medium',
  'share_plat', 'share_session_id', 'share_tag', 'share_times', 'timestamp', 'unique_k',
  'bbid', 'ts', 'is_story_h5', 'plat_id', 'up_id', 'csource', '-arouter', 'from', 'seid',
  'launch_id', 'bsource', 'refer_from'
]);

function isAllowedBiliUrl(raw) {
  try {
    const u = new URL(raw);
    const host = u.hostname.toLowerCase();
    const allowedHost = host === 'bilibili.com' || host.endsWith('.bilibili.com') || host === 'b23.tv' || host.endsWith('.b23.tv');
    if (!allowedHost) return false;
    return u.pathname.length > 1 || u.search.length > 1;
  } catch {
    return false;
  }
}

export function normalizeBilibiliDedupUrl(rawUrl) {
  try {
    const u = new URL(rawUrl);
    u.hash = '';
    const kept = [];
    for (const [k, v] of u.searchParams.entries()) {
      const lower = k.toLowerCase();
      if (lower.startsWith('utm_') || BILI_TRACKING_PARAMS.has(lower)) continue;
      kept.push([k, v]);
    }
    kept.sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]));
    u.search = kept.length ? `?${new URLSearchParams(kept).toString()}` : '';
    const pathname = u.pathname.replace(/\/+$/, '') || '/';
    return `${u.protocol}//${u.hostname.toLowerCase()}${pathname}${u.search}`;
  } catch {
    return String(rawUrl || '').trim();
  }
}

function formatBiliError(error) {
  const msg = String(error?.message ?? error ?? '未知错误').trim();
  if (/aborted|timeout/i.test(msg)) return `请求超时（${msg}）`;
  return msg.slice(0, 180);
}

function normalizeConfig(config = {}) {
  const c = config.bilibili || {};
  return {
    enabled: c.enabled === true,
    allowPrivate: c.allowPrivate === true,
    downloader: String(c.downloader || 'bilibili-api'),
    ffmpeg: String(c.ffmpeg || 'unused'),
    qn: Math.min(80, Math.max(6, Number(c.qn) || 16)),
    mediaDir: String(c.mediaDir || '').trim(),
    maxDurationSeconds: Math.min(7200, Math.max(30, Number(c.maxDurationSeconds) || 900)),
    maxFileBytes: Math.min(1024 * 1024 * 1024, Math.max(20 * 1024 * 1024, Number(c.maxFileBytes) || 300 * 1024 * 1024)),
    timeoutMs: Math.min(15 * 60_000, Math.max(30_000, Number(c.timeoutMs) || 180_000)),
    maxConcurrent: Math.min(3, Math.max(1, Number(c.maxConcurrent) || 1)),
    rejectCollections: c.rejectCollections !== false,
    collectionKeywords: normalizeCollectionKeywords(c.collectionKeywords, DEFAULT_COLLECTION_KEYWORDS).slice(0, 40),
    preferredUploader: String(c.preferredUploader || '').trim(),
    searchMaxDurationSeconds: Math.min(7200, Math.max(30, Number(c.searchMaxDurationSeconds) || 900)),
    searchLimit: Math.min(10, Math.max(1, Number(c.searchLimit) || 5)),
    searchSort: ['relevance', 'date', 'views', 'duration'].includes(c.searchSort) ? c.searchSort : 'relevance',
    keywordCompletion: c.keywordCompletion !== false
  };
}

function searchSortMode(value) {
  return ({ relevance: 'default', date: 'default', views: 'play', duration: 'default' })[value] || 'default';
}

export class BilibiliAutoForward {
  constructor(options = {}) {
    this.dataDir = options.dataDir || os.tmpdir();
    this.getConfig = options.getConfig || (() => ({}));
    this.sender = options.sender;
    this.log = options.log || console;
    this.downloadCover = options.downloadCover || safeFetchPublicBinary;
    this.api = {
      resolveLink,
      fetchVideoInfo,
      getPlayUrl,
      downloadVideo,
      searchVideos,
      ...(options.api || {})
    };
    this.running = 0;
    this.pending = [];
    this.seenTracker = createSeenTracker();
    this.seen = this.seenTracker.seen;
    this.seenCanonical = this.seenTracker.seenCanonical;
    this.tempRoot = path.join(this.dataDir, 'bilibili');
  }

  status() {
    const cfg = normalizeConfig(this.getConfig());
    return {
      enabled: cfg.enabled,
      running: this.running,
      queued: this.pending.length,
      downloader: cfg.downloader,
      ffmpeg: cfg.ffmpeg
    };
  }

  extractUrls(text) {
    return extractCandidateUrls(text, { bareHosts: BARE_BILI_HOSTS }).filter(isAllowedBiliUrl);
  }

  extractUrlsFromSegments(segments) {
    const sources = collectCardSources(segments);
    return [...new Set(sources.flatMap(source => this.extractUrls(source)))];
  }

  handleMessage({ chatKey, text, segments = null, messageId = null, isSelf = false } = {}) {
    const cfg = normalizeConfig(this.getConfig());
    if (!cfg.enabled || isSelf || !chatKey || (!cfg.allowPrivate && String(chatKey).startsWith('private:'))) return;
    const trimmed = String(text || '').trim();
    const searchMatch = trimmed.match(/^(?:搜(?:一下)?|search)\s*(?:b站|bilibili)\s*[:：]?\s*(.+)$/i);
    if (searchMatch) { this.searchAndReply(String(chatKey), searchMatch[1], cfg).catch(() => {}); return; }
    const urls = [...new Set([...this.extractUrls(text), ...this.extractUrlsFromSegments(segments)])];
    if (urls.length) this.log.info?.(`[bilibili] 检测到 ${urls.length} 个链接：${urls.join(', ')}`);
    for (const url of urls) this.enqueue({ chatKey: String(chatKey), url, messageId, cfg });
  }

  async searchAndReply(chatKey, query, cfg) {
    const terms = String(query || '').replace(/\s+/g, ' ').trim().slice(0, 100);
    if (!terms) return;
    const completed = cfg.keywordCompletion && !/\bbilibili\b|哔哩|b站/i.test(terms) ? `${terms} B站` : terms;
    const result = await this.api.searchVideos(completed, {
      limit: cfg.searchLimit,
      fetchLimit: Math.max(20, cfg.searchLimit),
      sortBy: searchSortMode(cfg.searchSort),
      maxDurationSec: cfg.searchMaxDurationSeconds,
      fuzzy: cfg.keywordCompletion,
      timeoutMs: cfg.timeoutMs,
      log: (message) => this.log.info?.(`[bilibili] ${message}`)
    });
    const items = result.ok ? result.items : [];
    const lines = items.map((item, index) => (
      `${index + 1}. ${String(item.title || '未命名').slice(0, 80)}\n   UP主：${String(item.author || '未知').slice(0, 40)}  时长：${item.duration || durationText(item.durationSec)}\n   ${item.url}`
    ));
    await this.sendCaption(
      chatKey,
      lines.length
        ? `B站搜索：${terms}\n${lines.join('\n')}`
        : `没有找到符合条件的 B 站视频：${terms}${result.error ? `（${result.error}）` : ''}`
    );
  }

  enqueue(task) {
    const dedupUrl = normalizeBilibiliDedupUrl(task.url);
    const seenKey = `${task.chatKey}|${dedupUrl}`;
    if (this.seenTracker.hasUrl(seenKey)) {
      this.log.info?.(`[bilibili] 跳过六小时内重复链接：${task.url}`);
      return;
    }
    this.seenTracker.markUrl(seenKey);
    this.pending.push({ ...task, dedupUrl, seenKey });
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
        task.uncertain = (task.videoAttempted || (task.previewAttempted && !task.previewSent))
          && error?.outcome !== 'failed'
          && !(transport.definite && !transport.uncertain);
        this.log.warn?.(`[bilibili] 转发失败：${error?.message ?? error}`);
        try {
          await this.sendCaption(
            task.chatKey,
            task.videoSent
              ? 'B站视频已发送，但说明发送失败；不会重复发送视频。'
              : task.uncertain
                ? 'B站转发发送结果未知，请先核对聊天记录；为避免重复发送，本次不会自动重试。'
                : `B站视频转发失败：${formatBiliError(error)}`
          );
        } catch (noticeError) {
          this.log.warn?.(`[bilibili] 失败提示未送出：${noticeError?.message ?? noticeError}`);
        }
      }).finally(() => {
        // 入队/处理中仍防重；只有确认成功、结果未知或规范 ID 已命中重复去重才保留六小时去重。
        if (!task.videoSent && !task.uncertain && !task.duplicateSkipped) {
          this.seenTracker.unmarkUrl(task.seenKey);
          this.seenTracker.unmarkCanonical(task.canonicalKey);
        }
        this.running -= 1;
        this.pump();
      });
    }
  }

  async sendCaption(chatKey, caption, options = {}) {
    const result = await this.sender.sendTextBatch(chatKey, [caption], options);
    if (Array.isArray(result?.failed) && result.failed.length) {
      this.log.warn?.('[bilibili] 说明/失败提示未全部送出，请核对 outbox');
    }
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
        cover = await this.downloadCover(
          info.cover.startsWith('//') ? `https:${info.cover}` : info.cover,
          2 * 1024 * 1024,
          AbortSignal.timeout(10000),
          { Referer: pageUrl }
        );
        if (
          !/^image\/(jpeg|png|webp|gif)(?:;|$)/i.test(cover.contentType)
          || !Buffer.isBuffer(cover.buffer)
          || !cover.buffer.length
          || cover.buffer.length > 2 * 1024 * 1024
        ) {
          throw new Error('封面不是支持的图片或超过大小限制');
        }
      } catch (error) {
        cover = null;
        this.log.info?.(`[bilibili] 封面不可用，改发文字详情：${error?.message ?? error}`);
      }
    }
    task.previewAttempted = true;
    if (cover) {
      await this.sender.image(
        task.chatKey,
        { url: `base64://${cover.buffer.toString('base64')}`, bytes: cover.buffer.length, label: info.title, text },
        options
      );
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
    const resolved = await this.api.resolveLink(link);
    if (resolved.error || (resolved.kind !== 'video' && resolved.kind !== 'bangumi')) {
      await this.sendCaption(chatKey, `B站链接解析失败：${resolved.error || '暂只支持视频或番剧单集(/ep)链接'}\n原链接：${url}`);
      return;
    }
    const info = await this.api.fetchVideoInfo(resolved, { timeoutMs: cfg.timeoutMs });
    if (!info.ok) {
      await this.reportFailure(chatKey, `B站视频信息获取失败：${info.error}\n原链接：${url}`);
      return;
    }
    const epId = info.epId || resolved.epId || 0;
    const canonicalId = info.kind === 'bangumi' && epId
      ? `ep${epId}`
      : `${info.bvid || info.aid}|${info.page || 1}`;
    const canonicalKey = `${chatKey}|${canonicalId}`;
    if (this.seenTracker.hasCanonical(canonicalKey)) {
      task.duplicateSkipped = true;
      this.log.info?.(`[bilibili] 跳过六小时内同一视频的重复链接：${canonicalId}（原链接：${url}）`);
      return;
    }
    task.canonicalKey = canonicalKey;
    this.seenTracker.markCanonical(canonicalKey);

    // 稳定外发ID让 sender/outbox 在重启和换分享链接后仍能阻止未知写入重放。
    const runKey = info.kind === 'bangumi' && epId && !info.bvid && !info.aid
      ? `ep${epId}`
      : `${info.bvid || info.aid}|${info.page || 1}`;
    const runId = `bilibili-${createHash('sha256').update(`${chatKey}|${runKey}`).digest('hex')}`;
    const duration = Number(info.duration) || 0;
    if (duration > cfg.maxDurationSeconds) {
      await this.sendCaption(chatKey, `B站视频超过时长限制（${durationText(duration)} > ${durationText(cfg.maxDurationSeconds)}）\n原链接：${url}`);
      return;
    }
    const title = String(info.title || 'B站视频').replace(/\s+/g, ' ').trim();
    const uploader = String(info.author || '未知 UP 主').replace(/\s+/g, ' ').trim();
    const collectionText = `${title} ${info.desc || ''} ${info.pageTitle || ''}`;
    if (cfg.rejectCollections && matchCollectionKeyword(collectionText, cfg.collectionKeywords)) {
      await this.sendCaption(chatKey, `已跳过疑似合集/歌单内容：${title}\n原链接：${url}`);
      return;
    }
    if (cfg.preferredUploader && !uploader.toLowerCase().includes(cfg.preferredUploader.toLowerCase())) return;
    const pageUrl = info.kind === 'bangumi' && epId
      ? `https://www.bilibili.com/bangumi/play/ep${epId}`
      : (info.bvid ? `https://www.bilibili.com/video/${info.bvid}${info.page > 1 ? `?p=${info.page}` : ''}` : url);
    const caption = shareCaption({ ...info, title, author: uploader, duration }, { link: pageUrl });
    this.log.info?.(`[bilibili] 元信息成功：${info.bvid || canonicalId}，${durationText(duration)}，${title}`);

    const dir = cfg.mediaDir || this.tempRoot;
    const qnLadder = [cfg.qn, ...[32, 16, 6].filter(q => q < cfg.qn)];
    let jobDir = '';
    let dest = '';
    let downloaded = false;
    let chosenPlay = null;
    let dl = null;
    let overflowOnly = false;
    let lastPlayError = '';
    try {
      for (let i = 0; i < qnLadder.length; i += 1) {
        const tryQn = qnLadder[i];
        const play = await this.api.getPlayUrl(info.bvid, info.cid, { qn: tryQn, timeoutMs: cfg.timeoutMs });
        if (!play.ok) {
          lastPlayError = play.error || '未知错误';
          continue;
        }
        const actualQn = Number(play.qn) || tryQn;
        const lowerCandidatesExist = qnLadder.slice(i + 1).some(q => q < actualQn)
          && (!Array.isArray(play.accept) || !play.accept.length || play.accept.some(q => Number(q) < actualQn));

        if (play.sizeBytes && play.sizeBytes > cfg.maxFileBytes) {
          overflowOnly = true;
          if (lowerCandidatesExist) {
            this.log.info?.(`[bilibili] ${qualityLabel(actualQn)} 预计体积 ${(play.sizeBytes / 1048576).toFixed(1)} MiB 超限，尝试降级清晰度`);
            while (i + 1 < qnLadder.length && qnLadder[i + 1] >= actualQn) i += 1;
            continue;
          }
          chosenPlay = play;
          break;
        }

        if (!jobDir) {
          await fs.promises.mkdir(dir, { recursive: true });
          await pruneMediaJobs(dir);
          jobDir = await fs.promises.mkdtemp(path.join(dir, 'job-'));
          // OneBot/NapCat 可能由不同用户运行；mkdtemp 默认 0700，会让它把现有文件误报为 realpath ENOENT。
          await chmodBestEffort(jobDir, 0o755);
          dest = path.join(jobDir, safeFileName(info));
        }

        this.log.info?.(
          i === 0
            ? `[bilibili] 开始下载：${dest}`
            : `[bilibili] 降级至 ${qualityLabel(actualQn)} 重新下载：${dest}`
        );
        dl = await this.api.downloadVideo(play.urls, dest, {
          maxBytes: cfg.maxFileBytes,
          referer: pageUrl,
          timeoutMs: cfg.timeoutMs,
          log: (message) => this.log.info?.(`[bilibili] ${message}`)
        });
        if (dl.ok) {
          chosenPlay = play;
          downloaded = true;
          overflowOnly = false;
          break;
        }
        if (dl.tooLarge && lowerCandidatesExist) {
          overflowOnly = true;
          await fs.promises.rm(dest, { force: true }).catch(() => {});
          this.log.info?.(`[bilibili] ${qualityLabel(actualQn)} 下载体积超限，尝试降级清晰度`);
          while (i + 1 < qnLadder.length && qnLadder[i + 1] >= actualQn) i += 1;
          continue;
        }
        chosenPlay = play;
        break;
      }

      if (!downloaded) {
        if (!chosenPlay) {
          await this.reportFailure(chatKey, `${caption}\n视频流获取失败：${lastPlayError || '未获取到可用播放地址'}`);
          return;
        }
        if (overflowOnly || (chosenPlay.sizeBytes && chosenPlay.sizeBytes > cfg.maxFileBytes && !dl)) {
          await this.sendCaption(chatKey, `${caption}\n视频大小超过 ${Math.round(cfg.maxFileBytes / 1048576)} MiB 限制，未下载。`);
          return;
        }
        await this.reportFailure(chatKey, `${caption}\n视频下载失败：${dl?.error || '未知错误'}`);
        return;
      }

      // 视频是 B 站公开内容，允许 OneBot 进程读取本地文件；失败时仍由延迟清理回收。
      await chmodBestEffort(dest, 0o644);
      this.log.info?.(`[bilibili] 下载完成：${(dl.bytes / 1048576).toFixed(1)} MB（${qualityLabel(chosenPlay.qn)}），准备发送`);
      await this.sendPreview(task, info, pageUrl, runId);
      task.videoAttempted = true;
      await this.sender.video(chatKey, { file: dest, duration, label: title }, { runId });
      task.videoSent = true;
      // OneBot 可能以 status=async 先确认请求，NapCat 随后才读取本地文件；不能在这里立即删除。
      this.log.info?.(`[bilibili] 已转发《${title}》（${uploader}，${qualityLabel(chosenPlay.qn)}，${(dl.bytes / 1048576).toFixed(1)} MB）`);
    } finally {
      if (jobDir) {
        // 下载完成后即使 OneBot 返回错误也延迟清理，给异步媒体后端留下读取时间，
        // 同时保留现场以便排查；超过 2 小时由 pruneMediaJobs 回收。
        if (downloaded) removeMediaJobLater(jobDir);
        else await fs.promises.rm(jobDir, { recursive: true, force: true }).catch(() => {});
      }
    }
  }
}

export { normalizeConfig as normalizeBilibiliConfig };
