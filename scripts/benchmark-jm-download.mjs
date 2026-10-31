// 隔离对照：默认本地确定性故障 CDN；--live 只读取显式清单，不调用 QQ 或生产配置。
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import sharp from 'sharp';
import { createClient } from '../src/features/jm-suomingor/engine.js';
import { validateImage } from '../src/features/jm-suomingor/image-download.js';

const args = process.argv.slice(2);
const option = name => args.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
if (!option('baseline')) throw new Error('需要 --baseline=/absolute/path/to/production-engine.js');
if (args.includes('--live') && !option('manifest')) throw new Error('Live benchmark requires an explicit image manifest');
const baseline = await import(pathToFileURL(path.resolve(option('baseline'))));
const live = args.includes('--live');
const timeoutMs = Number(option('timeout')) || (live ? 20000 : 1500);
const manifest = option('manifest') ? JSON.parse(await fs.readFile(option('manifest'), 'utf8')) : {
  photoId: '123456', files: Array.from({ length: 96 }, (_, i) => `${String(i + 27).padStart(5, '0')}.webp`)
};
if (manifest.files.length !== 96 || !/^\d+$/.test(String(manifest.photoId))) throw new Error('Benchmark requires exactly 96 images and numeric photoId');
const allowedDomains = new Set(baseline.IMAGE_DOMAINS);
if (manifest.domains?.some(domain => !allowedDomains.has(domain))) throw new Error('Unexpected CDN');
let connections = 0;
let server;
let baseUrl;
if (!live) {
  // 同一份有效图片，固定主 CDN 上两个失败/慢页；无随机网络故障。
  const pixels = Buffer.alloc(256 * 256 * 3);
  let random = 0x12345678;
  for (let i = 0; i < pixels.length; i++) { random = (1664525 * random + 1013904223) >>> 0; pixels[i] = random >>> 24; }
  const image = await sharp(pixels, { raw: { width: 256, height: 256, channels: 3 } }).webp({ lossless: true }).toBuffer();
  server = http.createServer((req, res) => {
    const isPrimary = req.url.startsWith('/cdn-msp.jmapiproxy2.cc/');
    const slow = req.url.includes('/00122.webp');
    const broken = req.url.includes('/00047.webp');
    const timer = setTimeout(() => {
      if (isPrimary && broken) { res.writeHead(503); res.end(); }
      else { res.writeHead(200, { 'content-type': 'image/webp', 'content-length': image.length }); res.end(image); }
    }, isPrimary && slow ? 650 : isPrimary ? 8 : 25);
    res.on('close', () => clearTimeout(timer));
  });
  server.on('connection', () => connections++);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
}
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'qq-jm-benchmark-'));
const results = [];
let referenceHashes;
try {
  for (const concurrency of [16, 24, 32, 48]) {
    // 交替先后顺序，减轻连接预热和短时网络变化偏差；不在多个档位之间并行发请求。
    for (const mode of option('mode') ? [option('mode')] : concurrency === 24 || concurrency === 48 ? ['adaptive', 'baseline'] : ['baseline', 'adaptive']) {
      const dir = path.join(root, `${mode}-${concurrency}`);
      await fs.mkdir(dir);
      const abort = new AbortController();
      const hardTimer = setTimeout(() => abort.abort(), live ? 90000 : 20000);
      let attempts = 0;
      let timeouts = 0;
      let networkBytes = 0;
      let peakRss = process.memoryUsage().rss;
      const monitor = setInterval(() => { peakRss = Math.max(peakRss, process.memoryUsage().rss); }, 100);
      const beforeConnections = connections;
      const fetchImpl = async (url, opts) => {
        abort.signal.throwIfAborted();
        if (manifest.domains && !manifest.domains.includes(new URL(url).hostname)) throw new Error('CDN excluded by benchmark manifest');
        if (attempts >= 144) throw new Error('Benchmark request budget exhausted');
        attempts++;
        const signal = AbortSignal.any([abort.signal, opts.signal]);
        const onAbort = () => { if (signal.reason?.name === 'TimeoutError') timeouts++; };
        signal.addEventListener('abort', onAbort, { once: true });
        const parsed = new URL(url);
        try {
          const response = await fetch(live ? url : `${baseUrl}/${parsed.hostname}${parsed.pathname}${parsed.search}`, { ...opts, signal });
          async function* consume() {
            try { for await (const chunk of response.body) { networkBytes += chunk.length; yield chunk; } }
            finally { signal.removeEventListener('abort', onAbort); }
          }
          const body = consume();
          body.cancel = () => response.body.cancel();
          return { status: response.status, headers: response.headers, body, url,
            async arrayBuffer() { const chunks = []; for await (const chunk of body) chunks.push(Buffer.from(chunk)); return Buffer.concat(chunks); } };
        } catch (error) { signal.removeEventListener('abort', onAbort); throw error; }
      };
      const factory = mode === 'baseline' ? baseline.createClient : createClient;
      const client = factory({ fetchImpl, timeoutMs: () => timeoutMs, signal: abort.signal, concurrency,
        cdnStrategy: 'adaptive', hedgeDelayMs: live ? 3000 : 80, imageDomains: manifest.domains });
      let cursor = 0;
      const rows = [];
      const startedAt = performance.now();
      try {
        await Promise.all(Array.from({ length: concurrency }, async () => {
          for (;;) {
            const index = cursor++;
            if (index >= manifest.files.length) return;
            const file = manifest.files[index];
            const at = performance.now();
            try {
              const target = path.join(dir, file);
              if (mode === 'baseline') await fs.writeFile(target, await client.fetchImage(manifest.photoId, file));
              else await client.downloadImage(manifest.photoId, file, target);
              rows.push({ file, ok: true, ms: performance.now() - at });
            } catch (error) { rows.push({ file, ok: false, ms: performance.now() - at, error: error.message.slice(0, 150) }); }
          }
        }));
      } finally { clearTimeout(hardTimer); clearInterval(monitor); await client.close?.(); }
      const elapsedMs = performance.now() - startedAt;
      const hashes = {};
      let bytes = 0;
      for (const row of rows.filter(row => row.ok)) {
        const file = path.join(dir, row.file);
        try {
          await validateImage(file);
          const buffer = await fs.readFile(file);
          hashes[row.file] = crypto.createHash('sha256').update(buffer).digest('hex');
          row.contentMismatch = Boolean(referenceHashes?.[row.file] && referenceHashes[row.file] !== hashes[row.file]);
          bytes += buffer.length;
        } catch (error) { row.ok = false; row.error = error.message.slice(0, 150); }
      }
      referenceHashes ||= hashes;
      const durations = rows.map(row => row.ms).sort((a, b) => a - b);
      const stats = client.downloadStats?.();
      const result = { mode, concurrency, images: rows.length, success: rows.filter(row => row.ok).length,
        elapsedMs: Math.round(elapsedMs), mibPerSecond: +(bytes / 1048576 / (elapsedMs / 1000)).toFixed(3), bytes,
        networkBytes, requests: attempts, timeouts, p95Ms: Math.round(durations[Math.floor(durations.length * 0.95)]),
        slowest: rows.sort((a, b) => b.ms - a.ms).slice(0, 5), peakRssMiB: +(peakRss / 1048576).toFixed(1),
        newConnections: live ? undefined : connections - beforeConnections, hedges: stats?.hedges, switches: stats?.switches,
        cdns: stats?.cdns,
        contentMismatches: rows.filter(row => row.contentMismatch).length,
        hashesMatched: rows.filter(row => row.ok).every(row => !referenceHashes[row.file] || referenceHashes[row.file] === hashes[row.file]) };
      results.push(result);
      console.log(JSON.stringify(result));
      if (option('out')) await fs.writeFile(option('out'), JSON.stringify({ live, timeoutMs, manifest, results }, null, 2));
      if (live) await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }
} finally {
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  // 仅清理本脚本 mkdtemp 创建的独立测试目录。
  await fs.rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}
