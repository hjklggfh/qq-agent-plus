import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import sharp from 'sharp';
import { createImageDownloader, validateImage } from '../src/features/jm-suomingor/image-download.js';
import { createClient, UA_APP } from '../src/features/jm-suomingor/engine.js';

const image = await sharp(crypto.randomBytes(96 * 128 * 3), { raw: { width: 96, height: 128, channels: 3 } }).png().toBuffer();
const response = () => new Response(image, { headers: { 'content-type': 'image/png', 'content-length': String(image.length) } });
function downloader(fetchImpl, extra = {}) {
  return createImageDownloader({ fetchImpl, domains: ['primary.test', 'backup.test'],
    headers: {}, buildImageUrl: (domain, id, file) => `https://${domain}/${id}/${file}`,
    getTimeout: () => 200, hedgeDelayMs: 1000, ...extra });
}
function stalled(signal, onAbort = () => {}) {
  return new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => { onAbort(); reject(signal.reason); }, { once: true });
  });
}
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'jm-download-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { root, target: path.join(root, '001.png') };
}

test('流式落盘保留原始字节，完整验证后原子替换，临时文件不残留', async t => {
  const { root, target } = await fixture(t);
  const client = downloader(async () => response());
  const result = await client.downloadImage('123', '001.png', target);
  assert.equal(result.ok, true);
  assert.deepEqual(await fs.readFile(target), image);
  assert.deepEqual(await fs.readdir(root), ['001.png']);
  assert.equal(client.snapshot().bytes, image.length);
});

test('长时间无首包时有界备用请求获胜，及时取消主请求', async t => {
  const { root, target } = await fixture(t);
  let cancelled = 0;
  const client = downloader(async (url, opts) => url.includes('primary.test')
    ? stalled(opts.signal, () => cancelled++) : response(), { hedgeDelayMs: 15, getTimeout: () => 5000 });
  await client.downloadImage('123', '001.png', target);
  assert.equal(cancelled, 1);
  assert.equal(client.snapshot().attempts, 2);
  assert.equal(client.snapshot().hedges, 1);
  assert.equal(client.snapshot().cancelledRequests, 1);
  assert.deepEqual(await fs.readdir(root), ['001.png']);
});

test('响应头已返回但图片 body 卡住，备用请求仍可解救拖尾', async t => {
  const { target } = await fixture(t);
  let cancelled = false;
  const client = downloader(async (url, opts) => {
    if (!url.includes('primary.test')) return response();
    return new Response(new ReadableStream({ start(controller) {
      controller.enqueue(image.subarray(0, 100));
      opts.signal.addEventListener('abort', () => { cancelled = true; controller.error(opts.signal.reason); }, { once: true });
    } }));
  }, { hedgeDelayMs: 15 });
  await client.downloadImage('123', '001.png', target);
  assert.equal(cancelled, true);
  assert.deepEqual(await fs.readFile(target), image);
});

test('HTML 错误页、截断图片不能成为正式图片，回退后保留正确字节', async t => {
  const { target, root } = await fixture(t);
  let calls = 0;
  const client = downloader(async () => {
    calls++;
    if (calls === 1) return new Response('<html>bad gateway</html>'.repeat(100), { headers: { 'content-type': 'text/html' } });
    if (calls === 2) return new Response(image.subarray(0, 1000), { headers: { 'content-type': 'image/png' } });
    return response();
  });
  await client.downloadImage('123', '001.png', target);
  assert.equal(calls, 3);
  assert.deepEqual(await fs.readFile(target), image);
  assert.deepEqual(await fs.readdir(root), ['001.png']);
});

test('取消任务会中止全部在途请求，清除临时文件且不生成正式文件', async t => {
  const { target, root } = await fixture(t);
  const abort = new AbortController();
  let active = 0;
  let release;
  const started = new Promise(resolve => { release = resolve; });
  const client = downloader(async (_url, opts) => {
    active++; release();
    try { return await stalled(opts.signal); } finally { active--; }
  });
  const pending = client.downloadImage('123', '001.png', target, { signal: abort.signal });
  await started;
  abort.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(active, 0);
  assert.deepEqual(await fs.readdir(root), []);
});

test('主 CDN 超时后下一个尝试获得新的时间预算，不复用已过期 signal', async t => {
  const { target } = await fixture(t);
  const client = downloader(async (url, opts) => url.includes('primary.test') ? stalled(opts.signal) : response(),
    { strategy: 'adaptive', getTimeout: () => 25 });
  await client.downloadImage('123', '001.png', target);
  assert.equal(client.snapshot().timeouts, 1);
  assert.equal(client.snapshot().attempts, 2);
});

test('实际失败与传输耗时反馈会把后续图片分配给成功 CDN', async () => {
  const requests = [];
  const client = downloader(async url => {
    requests.push(new URL(url).hostname);
    return url.includes('primary.test') ? new Response('', { status: 503 }) : response();
  });
  await client.downloadImage('123', '001.png');
  await client.downloadImage('123', '002.png');
  assert.deepEqual(requests, ['primary.test', 'backup.test', 'backup.test']);
  assert.equal(client.snapshot().cdns['backup.test'].success, 2);
});

test('固定顺序模式不启动提前备用请求，保留带 v 与不带 v 的兼容顺序', async () => {
  const requests = [];
  const client = downloader(async url => {
    requests.push(url);
    return url.includes('?v=') ? new Response('', { status: 404 }) : response();
  }, { strategy: 'fixed', hedgeDelayMs: 0 });
  await client.downloadImage('123', '001.png');
  assert.equal(requests.length, 2);
  assert.match(requests[0], /primary.test.*\?v=/);
  assert.equal(requests[1], 'https://primary.test/123/001.png');
  assert.equal(client.snapshot().hedges, 0);
});

test('同时慢请求的额外流量受预算限制，失败时仍穷尽兼容候选而不遗漏图片', async () => {
  const client = downloader(async (url, opts) => url.includes('primary.test') ? stalled(opts.signal) : response(),
    { concurrency: 48, getTimeout: () => 80, hedgeDelayMs: 10 });
  const results = await Promise.all(Array.from({ length: 16 }, (_, i) => client.downloadImage('123', `${i}.png`)));
  assert.equal(results.length, 16);
  assert.equal(client.snapshot().success, 16);
  assert.ok(client.snapshot().hedges <= Math.ceil(16 * 0.1));
  assert.ok(client.snapshot().attempts <= 16 * 4);
});

test('磁盘路径错误不会继续向所有 CDN 请求，同名已有文件不被失败请求破坏', async t => {
  const { root } = await fixture(t);
  let calls = 0;
  const client = downloader(async () => { calls++; return response(); });
  await assert.rejects(client.downloadImage('123', '001.png', path.join(root, 'missing', '001.png')), /落盘失败/);
  assert.equal(calls, 1);
});

test('原有图片 URL、请求头和二进制兼容返回保留，不传 API 鉴权头到 CDN', async () => {
  let captured;
  const client = createClient({ fetchImpl: async (url, opts) => { captured = { url, ...opts }; return response(); },
    timeoutMs: () => 500, cdnStrategy: 'fixed' });
  assert.deepEqual(await client.fetchImage('123', '00122.webp'), image);
  assert.match(captured.url, /cdn-msp.jmapiproxy2.cc\/media\/photos\/123\/00122.webp\?v=\d+/);
  assert.equal(captured.headers['user-agent'], UA_APP);
  assert.equal(captured.headers.referer, 'https://cdn-msp.jmapiproxy1.cc/');
  assert.equal(captured.headers.token, undefined);
});

test('完整解码验证拒绝损坏的已有缓存', async () => {
  await assert.rejects(validateImage(image.subarray(0, 1000)));
  await validateImage(image);
});

test('普通 API 请求的超时重试也获得全新 signal，不继承上次已超时的预算', async (t) => {
  // 模拟 fetch 没有真实 socket；AbortSignal.timeout 的 unref 定时器自身不会保活事件循环。
  const keepAlive = setInterval(() => {}, 1000);
  t.after(() => clearInterval(keepAlive));
  let calls = 0;
  const client = createClient({ timeoutMs: () => 15, fetchImpl: async (_url, opts) => {
    calls++;
    if (calls === 1) return stalled(opts.signal);
    assert.equal(opts.signal.aborted, false);
    return new Response('ok');
  } });
  const result = await client.httpGet('https://api.test/data', { retries: 1, asText: true });
  assert.equal(result.ok, true);
  assert.equal(result.text, 'ok');
  assert.equal(calls, 2);
});

test('未列入主节点池的 CDN 只保留兜底，不因测速而接管正常图片', async () => {
  const requests = [];
  const client = downloader(async url => { requests.push(new URL(url).hostname); return response(); },
    { domains: ['primary.test', 'backup.test', 'legacy.test'], adaptiveDomains: ['primary.test', 'backup.test'] });
  for (let i = 0; i < 32; i++) await client.downloadImage('123', `${i}.png`);
  assert.equal(requests.includes('legacy.test'), false);
});
