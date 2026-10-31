// JM 图片请求调度：有界慢请求回退、流式临时文件、完整解码验证；不改写原图。
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import sharp from 'sharp';

// 完整解码可能占用数十 MB；全进程只验证一张，不能随下载并发放大解码内存。
let validationQueue = Promise.resolve();
let activeHedges = 0;
export function validateImage(input, signal) {
  const pending = validationQueue.then(async () => {
    signal?.throwIfAborted();
    // 从文件读入只发生在串行验证槽中；使用 Buffer 避免 libvips 文件缓存持有句柄，
    // 导致 Windows 上验证后的临时文件无法 rename/delete。
    if (typeof input === 'string' && (await fs.stat(input)).size > 32 * 1024 * 1024) throw new Error('Image too large');
    const bytes = typeof input === 'string' ? await fs.readFile(input) : input;
    const image = sharp(bytes, { limitInputPixels: 24_000_000, failOn: 'warning' });
    try {
      const meta = await image.metadata();
      if (!['jpeg', 'png', 'webp', 'gif'].includes(meta.format)) throw new Error('Unsupported image');
      // 编解码器读取并验证完整压缩流，丢弃缩略解码输出；避免留存整页像素缓冲。
      // 正式文件始终使用下载的原始字节，不保存这里生成的 1x1 验证图。
      await image.resize(1, 1, { fit: 'fill', kernel: 'nearest' }).raw().toBuffer();
      signal?.throwIfAborted();
    } finally { image.destroy(); }
  });
  validationQueue = pending.catch(() => {});
  return pending;
}

export function createImageDownloader(options) {
  const { fetchImpl, buildImageUrl, domains, headers, signal: taskSignal,
    concurrency = 4, strategy = 'adaptive', adaptiveDomains = domains, hedgeDelayMs = 3000, maxImageBytes = 32 * 1024 * 1024 } = options;
  const requestTimeout = options.getTimeout;
  const cdns = new Map(domains.map((domain) => [domain, { attempts: 0, success: 0, failures: 0, bytes: 0, latencyMs: 0, transferMs: 0 }]));
  const stats = { started: 0, success: 0, failed: 0, bytes: 0, networkBytes: 0, attempts: 0, retries: 0,
    timeouts: 0, switches: 0, hedges: 0, peakRequests: 0, cancelledRequests: 0, slowest: [] };
  let activeRequests = 0;
  const hedgeLimit = Math.max(1, Math.min(4, Math.floor(concurrency / 12)));
  const snapshot = () => ({ ...stats, slowest: stats.slowest.map(x => ({ ...x })),
    cdns: Object.fromEntries([...cdns].map(([key, value]) => [key, { ...value }])) });

  function choose(tried, bareFirst, imageNumber) {
    const candidates = domains.flatMap((domain, index) => [false, true].map(bare => ({ domain, bare, index })))
      .filter(c => !tried.has(`${c.domain}:${c.bare}`));
    if (strategy === 'fixed') return candidates[0];
    // 先跨 CDN，再尝试无 v 参数；空数据等兼容响应可立即试本 CDN 的无 v 版本。
    const score = c => {
      const s = cdns.get(c.domain);
      if (!adaptiveDomains.includes(c.domain)) return 1e8 + c.index * 1e6 + (c.bare ? 1e5 : 0);
      const observed = s.success ? s.latencyMs * 0.3 + s.transferMs * 0.7 : c.index === 0 ? 1000 : 2500;
      return (c.bare ? 1e7 : 0) + observed + s.failures / Math.max(1, s.attempts) * requestTimeout();
    };
    if (bareFirst) {
      const same = candidates.find(c => c.domain === bareFirst && c.bare);
      if (same) return same;
    }
    // 少量正常请求探索未采样 CDN，不为测速额外下载图片。
    if (!tried.size && imageNumber % 16 === 0) {
      const untested = candidates.find(c => !c.bare && adaptiveDomains.includes(c.domain) && cdns.get(c.domain).attempts === 0);
      if (untested) return untested;
    }
    return candidates.sort((a, b) => score(a) - score(b) || a.index - b.index)[0];
  }

  async function downloadImage(photoId, fileName, target, { signal = taskSignal } = {}) {
    signal?.throwIfAborted();
    const startedAt = Date.now();
    const imageNumber = ++stats.started;
    const tried = new Set();
    const pending = new Map();
    const all = [];
    const errors = [];
    let previousDomain = '';
    let bareFirst = '';
    let hedgeConsidered = strategy === 'fixed';
    let hedgeAfterMs = hedgeDelayMs;
    let winner = null;

    const start = (candidate, hedged = false) => {
      const key = `${candidate.domain}:${candidate.bare}`;
      tried.add(key);
      stats.attempts++;
      activeRequests++;
      stats.peakRequests = Math.max(stats.peakRequests, activeRequests);
      if (tried.size > 1) stats.retries++;
      if (previousDomain && previousDomain !== candidate.domain) stats.switches++;
      previousDomain = candidate.domain;
      const state = cdns.get(candidate.domain);
      state.attempts++;
      const controller = new AbortController();
      const entry = { controller, networkDone: false };
      if (hedged) { activeHedges++; stats.hedges++; }
      entry.promise = (async () => {
        const requestAt = Date.now();
        const temp = target ? `${target}.${crypto.randomUUID()}.part` : '';
        let handle;
        let response;
        let timer;
        let timedOut = false;
        let bytes = 0;
        try {
          const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
          timer = setTimeout(() => {
            timedOut = true;
            controller.abort(Object.assign(new Error('Image request timed out'), { name: 'TimeoutError' }));
          }, requestTimeout());
          const query = candidate.bare ? '' : `?v=${Math.floor(Date.now() / 1000)}`;
          response = await fetchImpl(`${buildImageUrl(candidate.domain, photoId, fileName)}${query}`, {
            method: 'GET', headers, redirect: 'follow', signal: combined, responseType: 'stream'
          });
          const latencyMs = Date.now() - requestAt;
          if (response.status < 200 || response.status >= 300) throw Object.assign(new Error('HTTP failure'), { code: `HTTP_${response.status}` });
          const header = name => response.headers?.get?.(name) ?? response.headers?.[name];
          const contentType = String(header('content-type') || '').toLowerCase();
          if (/text\/|application\/(?:json|xml)/.test(contentType)) throw Object.assign(new Error('Not an image'), { code: 'INVALID_IMAGE' });
          const length = Number(header('content-length'));
          if (length > maxImageBytes) throw Object.assign(new Error('Image too large'), { code: 'IMAGE_TOO_LARGE' });
          if (target) handle = await fs.open(temp, 'wx');
          const chunks = [];
          const body = response.body?.[Symbol.asyncIterator] ? response.body : [Buffer.from(await response.arrayBuffer())];
          for await (const chunk of body) {
            combined.throwIfAborted();
            const buffer = Buffer.from(chunk);
            bytes += buffer.length;
            stats.networkBytes += buffer.length;
            state.bytes += buffer.length;
            if (bytes > maxImageBytes) throw Object.assign(new Error('Image too large'), { code: 'IMAGE_TOO_LARGE' });
            if (handle) await handle.writeFile(buffer);
            else chunks.push(buffer);
          }
          if (handle) { await handle.close(); handle = null; }
          entry.networkDone = true;
          clearTimeout(timer);
          const transferMs = Date.now() - requestAt;
          if (bytes <= 512 || (Number.isFinite(length) && length > 0 && !header('content-encoding') && bytes !== length)) {
            throw Object.assign(new Error('Incomplete image'), { code: 'INVALID_IMAGE' });
          }
          const buffer = target ? undefined : Buffer.concat(chunks);
          await validateImage(target ? temp : buffer, combined);
          combined.throwIfAborted();
          state.success++;
          state.latencyMs = state.success === 1 ? latencyMs : state.latencyMs * 0.75 + latencyMs * 0.25;
          state.transferMs = state.success === 1 ? transferMs : state.transferMs * 0.75 + transferMs * 0.25;
          return { key, ok: true, bytes, temp, buffer, domain: candidate.domain };
        } catch (error) {
          const cancelled = controller.signal.aborted && !timedOut || signal?.aborted;
          if (timedOut) stats.timeouts++;
          if (cancelled) stats.cancelledRequests++;
          else state.failures++;
          if (handle) await handle.close().catch(() => {});
          if (temp) await fs.rm(temp, { force: true }).catch(() => {});
          // 只记录域名及错误类别，不能把代理鉴权或请求头写入统计。
          const code = timedOut ? 'TIMEOUT' : cancelled ? 'CANCELLED' : /^HTTP_\d+$|^IMAGE_TOO_LARGE$|^INVALID_IMAGE$/.test(error.code) ? error.code : 'NETWORK_OR_DECODE';
          return { key, ok: false, code, domain: candidate.domain, tryBare: code === 'INVALID_IMAGE',
            fatal: target && ['ENOSPC', 'EACCES', 'EPERM', 'ENOENT'].includes(error.code) };
        } finally {
          clearTimeout(timer);
          try { await response?.body?.cancel?.(); } catch { /* 已消费或正在取消 */ }
          if (hedged) activeHedges--;
          activeRequests--;
        }
      })();
      pending.set(key, entry);
      all.push(entry);
    };

    try {
      const first = choose(tried, '', imageNumber);
      const observed = cdns.get(first.domain);
      if (observed.success >= 3) hedgeAfterMs = Math.max(hedgeDelayMs, Math.min(requestTimeout() * 0.65, observed.transferMs * 2));
      start(first);
      while (pending.size) {
        let hedgeTimer;
        const choices = [...pending.values()].map(entry => entry.promise);
        if (!hedgeConsidered) choices.push(new Promise(resolve => {
          hedgeTimer = setTimeout(() => resolve({ hedge: true }), Math.max(0, startedAt + hedgeAfterMs - Date.now()));
        }));
        const event = await Promise.race(choices);
        clearTimeout(hedgeTimer);
        signal?.throwIfAborted();
        if (event.hedge) {
          hedgeConsidered = true;
          if (![...pending.values()].some(entry => entry.networkDone)
            && activeHedges < hedgeLimit && stats.hedges < Math.ceil(stats.started * 0.1)) {
            const alternate = choose(tried, '', imageNumber);
            if (alternate && alternate.domain !== previousDomain && adaptiveDomains.includes(alternate.domain)) start(alternate, true);
          }
          continue;
        }
        pending.delete(event.key);
        if (event.ok) {
          winner = event;
          for (const entry of pending.values()) entry.controller.abort();
          await Promise.all(all.map(entry => entry.promise));
          signal?.throwIfAborted();
          if (target) await fs.rename(winner.temp, target);
          stats.success++;
          stats.bytes += winner.bytes;
          return { ...winner, elapsedMs: Date.now() - startedAt };
        }
        errors.push(`${event.domain}:${event.code}`);
        if (event.fatal) throw new Error('图片落盘失败，已停止该图片的网络重试');
        if (event.tryBare) bareFirst = event.domain;
        if (!pending.size) {
          const next = choose(tried, bareFirst, imageNumber);
          bareFirst = '';
          if (next) start(next);
        }
      }
      throw new Error(`图片下载失败：${errors.slice(0, 4).join('；')}`);
    } catch (error) {
      stats.failed++;
      throw error;
    } finally {
      for (const entry of all) entry.controller.abort();
      const results = await Promise.all(all.map(entry => entry.promise));
      for (const result of results) if (result.temp) await fs.rm(result.temp, { force: true }).catch(() => {});
      stats.slowest.push({ photoId: String(photoId), file: String(fileName).split('/').pop(), ms: Date.now() - startedAt });
      stats.slowest.sort((a, b) => b.ms - a.ms);
      stats.slowest.length = Math.min(5, stats.slowest.length);
    }
  }
  return { downloadImage, snapshot };
}
