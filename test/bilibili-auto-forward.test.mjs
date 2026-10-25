import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BilibiliAutoForward, normalizeBilibiliConfig } from '../src/features/bilibili-auto-forward.js';
import { ensureFingerprint } from '../src/features/bilibili-api.js';
import { SendQueue } from '../src/onebot/sender.js';

test('B站链接识别支持主站、短链并去重', () => {
  const feature = new BilibiliAutoForward({ getConfig: () => ({ bilibili: { enabled: true } }) });
  assert.deepEqual(feature.extractUrls('https://www.bilibili.com/video/BV1xx https://b23.tv/abc https://b23.tv/abc'), [
    'https://www.bilibili.com/video/BV1xx', 'https://b23.tv/abc'
  ]);
  assert.deepEqual(feature.extractUrls('https://example.com/video'), []);
});

test('B站链接识别支持 QQ json/xml 分享卡片', () => {
  const feature = new BilibiliAutoForward({ getConfig: () => ({ bilibili: { enabled: true } }) });
  const jsonCard = JSON.stringify({
    meta: { detail_1: { title: '视频标题', qqdocurl: 'https://b23.tv/card-link' } }
  });
  assert.deepEqual(feature.extractUrlsFromSegments([
    { type: 'json', data: { data: jsonCard } },
    { type: 'xml', data: { data: '<item url="https://www.bilibili.com/video/BV1card" />' } }
  ]), [
    'https://b23.tv/card-link', 'https://www.bilibili.com/video/BV1card'
  ]);
});

test('B站链接识别支持 OneBot share/link 卡片段', () => {
  const feature = new BilibiliAutoForward({ getConfig: () => ({ bilibili: { enabled: true } }) });
  assert.deepEqual(feature.extractUrlsFromSegments([
    { type: 'share', data: { url: 'https://www.bilibili.com/video/BV1share' } },
    { type: 'link', data: { link: 'https://b23.tv/link-card' } }
  ]), [
    'https://www.bilibili.com/video/BV1share', 'https://b23.tv/link-card'
  ]);
});

test('B站配置限制有安全上限且默认关闭', () => {
  const cfg = normalizeBilibiliConfig({ bilibili: { maxDurationSeconds: 999999, maxFileBytes: 1, maxConcurrent: 99 } });
  assert.equal(cfg.enabled, false);
  assert.equal(cfg.maxDurationSeconds, 7200);
  assert.equal(cfg.maxFileBytes, 20 * 1024 * 1024);
  assert.equal(cfg.maxConcurrent, 3);
});

async function forwardingFixture(t, { metadataFails = false, videoError = null, previewError = null, coverFails = false, downloadFails = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bili-forward-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const messages = []; const videoCalls = []; const previewCalls = []; const events = []; const logs = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    const data = url.includes('/finger/spi') ? { b_3: 'anon' }
      : url.includes('/view?') ? { bvid: 'BV1iFnb6tE5V', cid: 42, title: 'test', pic: 'https://cover.example/a.jpg', duration: 10, owner: { name: 'UP' }, stat: { view: 32123, danmaku: 6, like: 3633, coin: 22, favorite: 606, reply: 45 } }
        : { quality: 16, durl: [{ url: 'https://cdn.example/video.mp4', size: 16 }] };
    if (url.includes('cdn.example')) {
      events.push('download');
      return new Response(new Uint8Array(16), { status: downloadFails ? 503 : 200, headers: { 'content-type': 'video/mp4' } });
    }
    const status = metadataFails && url.includes('/view?') ? 412 : 200;
    return new Response(JSON.stringify({ code: 0, data }), { status });
  });
  await ensureFingerprint({ force: true });
  const cfg = { bilibili: { enabled: true, allowPrivate: true } };
  const feature = new BilibiliAutoForward({ dataDir: root, getConfig: () => cfg,
    downloadCover: async (url, maxBytes) => {
      assert.equal(maxBytes, 2 * 1024 * 1024);
      if (coverFails) throw new Error('cover unavailable');
      return { buffer: Buffer.from('cover'), contentType: 'image/jpeg' };
    },
    log: { info: (...args) => logs.push(args.join(' ')), warn: (...args) => logs.push(args.join(' ')) },
    sender: {
      async sendTextBatch(chatKey, texts, options) {
        messages.push(...texts);
        if (options?.replyToMessageId) events.push('text-preview');
        return { sent: texts.map(text => ({ text })), failed: [] };
      },
      async image(chatKey, payload, options) {
        const mediaRoot = path.join(root, 'bilibili');
        const mediaReady = fs.existsSync(mediaRoot) && fs.readdirSync(mediaRoot).some(dir =>
          fs.readdirSync(path.join(mediaRoot, dir)).some(file => fs.statSync(path.join(mediaRoot, dir, file)).size === 16));
        assert.equal(mediaReady, true, '必须下载完成才能发送图文回复');
        events.push('preview'); previewCalls.push({ payload, options }); messages.push(payload.text);
        if (previewError) throw previewError;
      },
      async video(chatKey, payload, options) {
        events.push('video');
        videoCalls.push({ chatKey, exists: fs.existsSync(payload.file), runId: options.runId });
        if (videoError) throw videoError;
      }
    }
  });
  const url = 'https://www.bilibili.com/video/BV1iFnb6tE5V';
  const run = async () => {
    feature.handleMessage({ chatKey: 'private:12345', text: url, messageId: '-42' });
    for (let i = 0; i < 400 && feature.running; i++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(feature.running, 0);
  };
  return { feature, run, messages, videoCalls, previewCalls, events, logs, url };
}

test('B站元信息失败用真实发送队列接口提示，允许用户再次提交', async (t) => {
  const f = await forwardingFixture(t, { metadataFails: true });
  await f.run(); await f.run();
  assert.equal(f.videoCalls.length, 0);
  assert.equal(f.messages.filter(text => text.includes('HTTP 412')).length, 2);
  assert.equal(f.feature.seen.size, 0);
});

test('B站下载完成后引用原卡片连续发送图文与视频，六小时内防重', async (t) => {
  const f = await forwardingFixture(t);
  await f.run(); await f.run();
  assert.equal(f.videoCalls.length, 1);
  assert.equal(f.videoCalls[0].exists, true);
  assert.match(f.videoCalls[0].runId, /^bilibili-[a-f0-9]{64}$/);
  assert.equal(f.messages.length, 1);
  assert.deepEqual(f.events, ['download', 'preview', 'video']);
  assert.equal(f.previewCalls[0].options.replyToMessageId, '-42');
  assert.equal(f.previewCalls[0].options.runId, f.videoCalls[0].runId);
  assert.match(f.messages[0], /作者：UP\n播放：3.2万 \| 弹幕：6\n点赞：3633 \| 投币：22\n收藏：606 \| 评论：45/);
  assert.equal(f.logs.some(text => text.includes('已转发')), true);
  assert.equal(f.logs.some(text => text.includes('未全部送出')), false);
});

for (const outcome of ['failed', 'unknown']) test(`B站视频发送${outcome}的重试边界`, async (t) => {
  const error = Object.assign(new Error('test delivery failure'), { outcome });
  const f = await forwardingFixture(t, { videoError: error });
  await f.run(); await f.run();
  assert.equal(f.videoCalls.length, outcome === 'failed' ? 2 : 1);
  if (outcome === 'unknown') assert.equal(f.messages.some(text => text.includes('结果未知')), true);
});

test('图文详情发送结果未知时不继续发视频，也不重复发图文', async (t) => {
  const f = await forwardingFixture(t, { previewError: Object.assign(new Error('response lost'), { outcome: 'unknown' }) });
  await f.run(); await f.run();
  assert.equal(f.videoCalls.length, 0);
  assert.equal(f.previewCalls.length, 1);
  assert.equal(f.feature.seen.size, 1);
});

test('封面获取失败时引用原卡片发文字详情后仍可发送视频', async (t) => {
  const f = await forwardingFixture(t, { coverFails: true });
  await f.run();
  assert.deepEqual(f.events, ['download', 'text-preview', 'video']);
  assert.equal(f.previewCalls.length, 0);
  assert.equal(f.videoCalls.length, 1);
  assert.match(f.messages[0], /播放：3.2万/);
});

test('下载失败只报错，不提前发图文卡片或视频', async (t) => {
  const f = await forwardingFixture(t, { downloadFails: true });
  await f.run();
  assert.deepEqual(f.events, ['download']);
  assert.equal(f.previewCalls.length, 0);
  assert.equal(f.videoCalls.length, 0);
  assert.equal(f.messages.some(text => text.includes('视频下载失败')), true);
});

test('清空进程去重后仍经稳定外发ID拦截outbox未知发送', async (t) => {
  const f = await forwardingFixture(t, { videoError: Object.assign(new Error('response lost'), { outcome: 'unknown' }) });
  await f.run();
  const heldRunId = f.videoCalls[0].runId;
  let protocolCalls = 0;
  const queue = new SendQueue({
    onebot: { async sendVideo() { protocolCalls++; } },
    store: { hasUncertainEffects: runId => runId === heldRunId }
  });
  // 只模拟提示文字；视频使用真实 SendQueue 的未知写入闸门。
  queue.sendTextBatch = f.feature.sender.sendTextBatch;
  f.feature.sender = queue;
  f.feature.seen.clear();
  await f.run();
  assert.equal(protocolCalls, 0);
  assert.equal(f.feature.seen.size, 1);
});
