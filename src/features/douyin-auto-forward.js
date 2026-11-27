import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { classifyTransportFailure } from '../onebot/sender.js';
import { formatGroupNetworkError } from '../core/error-explain.js';
import { safeFetchPublicBinary } from '../llm/safe-fetch.js';
import {
  pickDouyinLinks,
  resolveDouyinLink,
  fetchDouyinInfo,
  normalizeDouyinQuality,
  pickVideoStreamCandidates,
  downloadDouyinVideo,
  safeDouyinFileName,
  douyinShareCaption,
  douyinDetailCaption,
  formatDouyinDuration
} from './douyin-api.js';
import {
  DEFAULT_COLLECTION_KEYWORDS,
  collectCardSources,
  normalizeCollectionKeywords,
  matchCollectionKeyword,
  createSeenTracker,
  chmodBestEffort,
  pruneMediaJobs,
  removeMediaJobLater,
  splitImageBatches
} from './media-forward-common.js';

const DOUYIN_REFERER = 'https://www.douyin.com/';
const DOUYIN_TRACKING_PARAMS = new Set([
  'previous_page', 'u_code', 'dd_full_origin', 'timestamp', 'app', 'tt_from',
  'from_ssr', 'iid', 'did', 'mid', 'share_track_info', 'sec_user_id',
  'enter_from', 'c_id', '_r', 'extra_params', 'ug_source', 'share_link_id',
  'activity_info', 'social_share_type'
]);

export function normalizeDouyinDedupUrl(rawUrl) {
  try {
    const u = new URL(rawUrl);
    u.hash = '';
    const kept = [];
    for (const [k, v] of u.searchParams.entries()) {
      const lower = k.toLowerCase();
      if (lower.startsWith('utm_') || DOUYIN_TRACKING_PARAMS.has(lower)) continue;
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

function formatDouyinError(error) {
  return formatGroupNetworkError(error, '下载或转发');
}

function normalizeConfig(config = {}) {
  const c = config?.douyin || {};
  return {
    enabled: c.enabled === true,
    allowPrivate: c.allowPrivate === true,
    preferredQuality: normalizeDouyinQuality(c.preferredQuality),
    mediaDir: String(c.mediaDir || '').trim(),
    maxDurationSeconds: Math.min(7200, Math.max(30, Number(c.maxDurationSeconds) || 900)),
    maxFileBytes: Math.min(1024 * 1024 * 1024, Math.max(10 * 1024 * 1024, Number(c.maxFileBytes) || 100 * 1024 * 1024)),
    timeoutMs: Math.min(15 * 60_000, Math.max(30_000, Number(c.timeoutMs) || 180_000)),
    maxConcurrent: Math.min(3, Math.max(1, Number(c.maxConcurrent) || 1)),
    forwardGallery: c.forwardGallery !== false,
    maxGalleryImages: Math.min(30, Math.max(1, Math.round(Number(c.maxGalleryImages) || 12))),
    rejectCollections: c.rejectCollections === true,
    collectionKeywords: normalizeCollectionKeywords(c.collectionKeywords, DEFAULT_COLLECTION_KEYWORDS).slice(0, 40),
    preferredAuthor: String(c.preferredAuthor || '').trim()
  };
}

export class DouyinAutoForward {
  constructor(options = {}) {
    this.dataDir = options.dataDir || os.tmpdir();
    this.getConfig = typeof options.getConfig === 'function' ? options.getConfig : () => ({});
    this.sender = options.sender;
    this.selfId = typeof options.selfId === 'function' ? options.selfId : () => String(options.selfId || '10000');
    this.log = options.log || console;
    this.downloadCover = typeof options.downloadCover === 'function' ? options.downloadCover : safeFetchPublicBinary;
    this.api = {
      resolveDouyinLink,
      fetchDouyinInfo,
      downloadDouyinVideo,
      ...(options.api || {})
    };
    this.running = 0;
    this.pending = [];
    this.seenTracker = createSeenTracker();
    this.seen = this.seenTracker.seen;
    this.seenCanonical = this.seenTracker.seenCanonical;
    this.tempRoot = path.join(this.dataDir, 'douyin');
  }

  status() {
    const cfg = normalizeConfig(this.getConfig());
    return {
      enabled: cfg.enabled,
      running: this.running,
      queued: this.pending.length
    };
  }

  extractUrls(text) {
    return pickDouyinLinks(text);
  }

  extractUrlsFromSegments(segments) {
    const sources = collectCardSources(segments);
    return [...new Set(sources.flatMap(source => this.extractUrls(source)))];
  }

  handleMessage({ chatKey, text, segments = null, messageId = null, isSelf = false } = {}) {
    const cfg = normalizeConfig(this.getConfig());
    if (!cfg.enabled || isSelf || !chatKey || (!cfg.allowPrivate && String(chatKey).startsWith('private:'))) return;
    const urls = [...new Set([...this.extractUrls(text), ...this.extractUrlsFromSegments(segments)])];
    if (urls.length) this.log.info?.(`[douyin] 检测到 ${urls.length} 个链接：${urls.join(', ')}`);
    for (const url of urls) this.enqueue({ chatKey: String(chatKey), url, messageId, cfg });
  }

  enqueue(task) {
    const dedupUrl = normalizeDouyinDedupUrl(task.url);
    const seenKey = `${task.chatKey}|${dedupUrl}`;
    if (this.seenTracker.hasUrl(seenKey)) {
      this.log.info?.(`[douyin] 跳过六小时内重复链接：${task.url}`);
      return;
    }
    this.seenTracker.markUrl(seenKey);
    this.pending.push({ ...task, dedupUrl, seenKey });
    this.log.info?.(`[douyin] 已入队：${task.url}（队列 ${this.pending.length}）`);
    this.pump();
  }

  pump() {
    const cfg = normalizeConfig(this.getConfig());
    while (this.running < cfg.maxConcurrent && this.pending.length) {
      const task = this.pending.shift();
      this.running += 1;
      this.process(task).catch(async (error) => {
        const transport = classifyTransportFailure(error);
        task.uncertain = (task.mediaAttempted || (task.previewAttempted && !task.previewSent))
          && error?.outcome !== 'failed'
          && !(transport.definite && !transport.uncertain);
        this.log.warn?.(`[douyin] 转发失败：${error?.message ?? error}`);
        try {
          await this.sendCaption(
            task.chatKey,
            task.mediaSent
              ? '抖音内容已发送，但说明发送失败；不会重复发送内容。'
              : task.uncertain
                ? '抖音内容发送结果未知（未收到 QQ 送达回执，为避免重复发送本次不会自动重试，请先核对聊天记录）。'
                : `抖音转发失败：${formatDouyinError(error)}`
          );
        } catch (noticeError) {
          this.log.warn?.(`[douyin] 失败提示未送出：${noticeError?.message ?? noticeError}`);
        }
      }).finally(() => {
        if (!task.mediaSent && !task.uncertain && !task.duplicateSkipped) {
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
      this.log.warn?.('[douyin] 说明/失败提示未全部送出，请核对 outbox');
    }
    return result;
  }

  async reportFailure(chatKey, message) {
    this.log.warn?.(`[douyin] ${message}`);
    return this.sendCaption(chatKey, message);
  }

  replyOptions(task, runId) {
    const rawId = String(task.messageId ?? '');
    return { runId, replyToMessageId: /^-?[1-9]\d*$/.test(rawId) ? rawId : null };
  }

  async downloadImageWithMirrors(imageEntry, timeoutMs = 15000, maxBytes = 15 * 1024 * 1024) {
    const mirrors = Array.isArray(imageEntry?.mirrors) && imageEntry.mirrors.length
      ? imageEntry.mirrors
      : (imageEntry?.url ? [imageEntry.url] : []);
    let lastError = '图片地址为空';
    for (const imgUrl of mirrors) {
      try {
        const res = await this.downloadCover(
          imgUrl.startsWith('//') ? `https:${imgUrl}` : imgUrl,
          maxBytes,
          AbortSignal.timeout(Math.min(20_000, timeoutMs)),
          { Referer: DOUYIN_REFERER }
        );
        if (
          !/^image\/(jpeg|jpg|png|webp|gif)(?:;|$)/i.test(res?.contentType || '')
          || !Buffer.isBuffer(res?.buffer)
          || !res.buffer.length
          || res.buffer.length > maxBytes
        ) {
          throw new Error('返回内容不是有效图片或超过大小限制');
        }
        return res;
      } catch (error) {
        lastError = error?.message ?? String(error);
      }
    }
    throw new Error(lastError);
  }

  async sendVideoPreview(task, info, pageUrl, runId) {
    const text = douyinDetailCaption(info, { link: pageUrl });
    const options = this.replyOptions(task, runId);
    let cover = null;
    if (info.cover) {
      try {
        cover = await this.downloadImageWithMirrors({ url: info.cover }, 10_000, 4 * 1024 * 1024);
      } catch (error) {
        cover = null;
        this.log.info?.(`[douyin] 封面不可用，改发文字详情：${error?.message ?? error}`);
      }
    }
    task.previewAttempted = true;
    if (cover) {
      await this.sender.image(
        task.chatKey,
        { url: `base64://${cover.buffer.toString('base64')}`, bytes: cover.buffer.length, label: info.title || '抖音视频', text },
        options
      );
    } else {
      const result = await this.sendCaption(task.chatKey, text, options);
      if (result?.failed?.length) throw new Error('抖音详情未全部送出');
    }
    task.previewSent = true;
  }

  async processGallery(task, info, pageUrl, runId, cfg) {
    if (!cfg.forwardGallery) {
      this.log.info?.(`[douyin] 已关闭图文转发，跳过：${info.awemeId}`);
      return;
    }
    const total = info.images.length;
    const selected = info.images.slice(0, cfg.maxGalleryImages);
    const buffers = [];
    for (const entry of selected) {
      try {
        const fetched = await this.downloadImageWithMirrors(entry, cfg.timeoutMs, 15 * 1024 * 1024);
        buffers.push(fetched);
      } catch (error) {
        this.log.warn?.(`[douyin] 图文单张图片下载失败，已跳过：${error?.message ?? error}`);
      }
    }
    if (!buffers.length) {
      await this.reportFailure(task.chatKey, `${douyinShareCaption(info, { link: pageUrl })}\n图文图片下载失败，未发送。`);
      return;
    }

    const baseText = douyinDetailCaption(info, { link: pageUrl });
    const detailText = total > selected.length
      ? `${baseText}\n（共 ${total} 张，当前配置仅转发前 ${selected.length} 张）`
      : baseText;
    const title = String(info.title || '抖音图文').trim();
    const authorName = String(info.author || '抖音图文').trim() || '抖音图文';
    const uin = String(this.selfId() || '10000');

    if (buffers.length === 1) {
      const only = buffers[0];
      task.previewAttempted = true;
      task.mediaAttempted = true;
      await this.sender.image(
        task.chatKey,
        { url: `base64://${only.buffer.toString('base64')}`, bytes: only.buffer.length, label: title, text: detailText },
        this.replyOptions(task, runId)
      );
      task.previewSent = true;
      task.mediaSent = true;
      this.log.info?.(`[douyin] 已转发图文《${title}》（单图，${(only.buffer.length / 1024).toFixed(0)} KB）`);
      return;
    }

    task.previewAttempted = true;
    const captionResult = await this.sendCaption(task.chatKey, detailText, this.replyOptions(task, `${runId}-caption`));
    if (captionResult?.failed?.length) throw new Error('抖音图文详情未全部送出');
    task.previewSent = true;

    const batches = splitImageBatches(buffers, 10);
    task.mediaAttempted = true;
    for (let b = 0; b < batches.length; b += 1) {
      const batch = batches[b];
      const forwardRunId = `${runId}-gallery-${b}`;
      const nodes = batch.map((img) => ({
        type: 'node',
        data: {
          uin,
          name: authorName,
          content: [{ type: 'image', data: { file: `base64://${img.buffer.toString('base64')}` } }]
        }
      }));
      try {
        await this.sender.forward(task.chatKey, { nodes, label: title }, { runId: forwardRunId });
      } catch (err) {
        const transport = classifyTransportFailure(err);
        const isUncertain = err?.outcome !== 'failed' && !(transport.definite && !transport.uncertain);
        if (isUncertain) throw err;
        this.log.warn?.(`[douyin] 合并转发失败，改发逐张图片：${err?.message ?? err}`);
        for (let i = 0; i < batch.length; i += 1) {
          const img = batch[i];
          await this.sender.image(
            task.chatKey,
            {
              url: `base64://${img.buffer.toString('base64')}`,
              bytes: img.buffer.length,
              label: `${title} (${i + 1}/${batch.length})`
            },
            { runId: `${forwardRunId}-img-${i}` }
          );
        }
      }
    }
    task.mediaSent = true;
    this.log.info?.(`[douyin] 已转发图文《${title}》（${buffers.length}/${total} 张）`);
  }

  async process(task) {
    const { chatKey, url, cfg } = task;
    this.log.info?.(`[douyin] 开始处理：${url}`);
    const resolved = await this.api.resolveDouyinLink(url, { timeoutMs: Math.min(15_000, cfg.timeoutMs) });
    if (resolved.error || !resolved.awemeId) {
      await this.sendCaption(chatKey, `抖音链接解析失败：${resolved.error || '不是支持的视频或图文链接'}\n原链接：${url}`);
      return;
    }

    const canonicalKey = `${chatKey}|dy:${resolved.awemeId}`;
    if (this.seenTracker.hasCanonical(canonicalKey)) {
      task.duplicateSkipped = true;
      this.log.info?.(`[douyin] 跳过六小时内同一作品的重复链接：${resolved.awemeId}（原链接：${url}）`);
      return;
    }
    task.canonicalKey = canonicalKey;
    this.seenTracker.markCanonical(canonicalKey);

    const info = await this.api.fetchDouyinInfo(resolved, { timeoutMs: Math.min(30_000, cfg.timeoutMs) });
    if (!info.ok) {
      await this.reportFailure(chatKey, `抖音作品信息获取失败：${info.error}\n原链接：${url}`);
      return;
    }

    const awemeId = info.awemeId || resolved.awemeId;
    const runId = `douyin-${createHash('sha256').update(`${chatKey}|${awemeId}`).digest('hex')}`;
    const title = String(info.title || (info.kind === 'gallery' ? '抖音图文' : '抖音视频')).replace(/\s+/g, ' ').trim();
    const author = String(info.author || '未知作者').replace(/\s+/g, ' ').trim();
    const normalizedInfo = { ...info, awemeId, title, author };

    if (cfg.preferredAuthor && !author.toLowerCase().includes(cfg.preferredAuthor.toLowerCase())) return;
    if (cfg.rejectCollections && matchCollectionKeyword(title, cfg.collectionKeywords)) {
      await this.sendCaption(chatKey, `已跳过疑似合集/歌单内容：${title}\n原链接：${url}`);
      return;
    }

    const pageUrl = `https://www.douyin.com/${info.kind === 'gallery' ? 'note' : 'video'}/${awemeId}`;
    if (info.kind === 'gallery') {
      await this.processGallery(task, normalizedInfo, pageUrl, runId, cfg);
      return;
    }

    const duration = Number(info.duration) || 0;
    if (duration > cfg.maxDurationSeconds) {
      await this.sendCaption(
        chatKey,
        `抖音视频超过时长限制（${formatDouyinDuration(duration)} > ${formatDouyinDuration(cfg.maxDurationSeconds)}）\n原链接：${url}`
      );
      return;
    }

    const caption = douyinShareCaption(normalizedInfo, { link: pageUrl });
    const picked = pickVideoStreamCandidates(info.streams, cfg.maxFileBytes, { preferredQuality: cfg.preferredQuality });
    if (!picked.ok) {
      if (picked.tooLarge) {
        await this.sendCaption(chatKey, `${caption}\n视频大小超过 ${Math.round(cfg.maxFileBytes / 1048576)} MiB 限制，未下载。`);
      } else {
        await this.reportFailure(chatKey, `${caption}\n视频流获取失败：${picked.error}`);
      }
      return;
    }

    this.log.info?.(`[douyin] 元信息成功：${awemeId}，${formatDouyinDuration(duration)}，${title}（首选画质：${cfg.preferredQuality}）`);
    const dir = cfg.mediaDir || this.tempRoot;
    await fs.promises.mkdir(dir, { recursive: true });
    await pruneMediaJobs(dir);
    const jobDir = await fs.promises.mkdtemp(path.join(dir, 'job-'));
    await chmodBestEffort(jobDir, 0o755);
    const dest = path.join(jobDir, safeDouyinFileName(normalizedInfo));

    let downloaded = false;
    let dl = null;
    try {
      for (let i = 0; i < picked.candidates.length; i += 1) {
        const stream = picked.candidates[i];
        const resLabel = stream.resolution ? `/${stream.resolution}P` : '';
        this.log.info?.(
          i === 0
            ? `[douyin] 开始下载（${stream.gear || 'default'}${resLabel}）：${dest}`
            : `[douyin] 尝试备用码率（${stream.gear || 'default'}${resLabel}）重新下载：${dest}`
        );
        dl = await this.api.downloadDouyinVideo(stream.urls, dest, {
          maxBytes: cfg.maxFileBytes,
          referer: DOUYIN_REFERER,
          timeoutMs: cfg.timeoutMs,
          log: (message) => this.log.info?.(`[douyin] ${message}`)
        });
        if (dl.ok) {
          downloaded = true;
          break;
        }
        await fs.promises.rm(dest, { force: true }).catch(() => {});
        if (dl.tooLarge && i + 1 < picked.candidates.length) {
          this.log.info?.(`[douyin] ${stream.gear || '当前码率'} 体积超限，尝试更低码率`);
        }
      }

      if (!downloaded) {
        if (dl?.tooLarge) {
          await this.sendCaption(chatKey, `${caption}\n视频大小超过 ${Math.round(cfg.maxFileBytes / 1048576)} MiB 限制，已放弃。`);
        } else {
          await this.reportFailure(chatKey, `${caption}\n视频下载失败：${dl?.error || '未知错误'}`);
        }
        return;
      }

      await chmodBestEffort(dest, 0o644);
      this.log.info?.(`[douyin] 下载完成：${(dl.bytes / 1048576).toFixed(1)} MB，准备发送`);
      await this.sendVideoPreview(task, normalizedInfo, pageUrl, runId);
      task.mediaAttempted = true;
      await this.sender.video(chatKey, { file: dest, duration, label: title }, { runId });
      task.mediaSent = true;
      this.log.info?.(`[douyin] 已转发《${title}》（${author}，${(dl.bytes / 1048576).toFixed(1)} MB）`);
    } finally {
      if (downloaded) removeMediaJobLater(jobDir);
      else await fs.promises.rm(jobDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

export { normalizeConfig as normalizeDouyinConfig };
