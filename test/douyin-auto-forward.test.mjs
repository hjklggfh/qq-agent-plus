import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DouyinAutoForward, normalizeDouyinConfig } from '../src/features/douyin-auto-forward.js';

function makeFakeSender(overrides = {}) {
  const calls = [];
  return {
    calls,
    async sendTextBatch(chatKey, messages, options = {}) {
      calls.push({ type: 'text', chatKey, messages, options });
      if (typeof overrides.sendTextBatch === 'function') return overrides.sendTextBatch(chatKey, messages, options);
      return { sent: messages, failed: [] };
    },
    async image(chatKey, payload, options = {}) {
      calls.push({ type: 'image', chatKey, payload, options });
      if (typeof overrides.image === 'function') return overrides.image(chatKey, payload, options);
      return { ok: true };
    },
    async forward(chatKey, payload, options = {}) {
      calls.push({ type: 'forward', chatKey, payload, options });
      if (typeof overrides.forward === 'function') return overrides.forward(chatKey, payload, options);
      return { ok: true };
    },
    async video(chatKey, payload, options = {}) {
      calls.push({ type: 'video', chatKey, payload, options });
      if (typeof overrides.video === 'function') return overrides.video(chatKey, payload, options);
      return { ok: true };
    }
  };
}

async function flushQueue(feature) {
  for (let i = 0; i < 60; i += 1) {
    if (feature.running === 0 && feature.pending.length === 0) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for DouyinAutoForward queue');
}

test('抖音消息链接识别兼容口令文案、裸短链、json/xml与share/link卡片', () => {
  const feature = new DouyinAutoForward();
  const textUrls = feature.extractUrls(
    '5.12 复制打开抖音 https://v.douyin.com/nWzAJk8H0-E/复制打开抖音 顺带 v.douyin.com/nWzAJk8H0-E/ 和 v.douyin.com/Bare998/'
  );
  assert.deepEqual(textUrls, [
    'https://v.douyin.com/nWzAJk8H0-E/',
    'https://v.douyin.com/Bare998/'
  ]);

  const segmentUrls = feature.extractUrlsFromSegments([
    { type: 'text', data: { text: '看这里 https://www.douyin.com/note/7700608537977802038' } },
    { type: 'json', data: { data: JSON.stringify({ meta: { detail: { qqdocurl: 'https:\\/\\/v.douyin.com\\/JsonCard1\\/' } } }) } },
    { type: 'xml', data: { data: '<msg url="https://www.iesdouyin.com/share/video/7685666547399168505/?region=CN&amp;mid=1"/>' } },
    { type: 'share', data: { url: 'https://www.douyin.com/video/7480659754788900122' } },
    { type: 'link', data: { url: 'https://v.douyin.com/LinkCard2/' } }
  ]);
  assert.deepEqual(segmentUrls, [
    'https://www.douyin.com/note/7700608537977802038',
    'https://v.douyin.com/JsonCard1/',
    'https://www.iesdouyin.com/share/video/7685666547399168505/?region=CN&mid=1',
    'https://www.douyin.com/video/7480659754788900122',
    'https://v.douyin.com/LinkCard2/'
  ]);
});

test('抖音配置归一化默认值及上下界约束', () => {
  const defaults = normalizeDouyinConfig({});
  assert.equal(defaults.enabled, false);
  assert.equal(defaults.allowPrivate, false);
  assert.equal(defaults.preferredQuality, '720p');
  assert.equal(defaults.forwardGallery, true);
  assert.equal(defaults.maxGalleryImages, 12);
  assert.equal(defaults.rejectCollections, false);
  assert.equal(defaults.maxFileBytes, 100 * 1024 * 1024);

  const clamped = normalizeDouyinConfig({
    douyin: {
      enabled: true,
      allowPrivate: true,
      preferredQuality: 'invalid',
      forwardGallery: false,
      maxGalleryImages: 99,
      maxDurationSeconds: 1,
      maxFileBytes: 100,
      maxConcurrent: 10
    }
  });
  assert.equal(clamped.enabled, true);
  assert.equal(clamped.allowPrivate, true);
  assert.equal(clamped.preferredQuality, '720p');
  assert.equal(clamped.forwardGallery, false);
  assert.equal(clamped.maxGalleryImages, 30);
  assert.equal(clamped.maxDurationSeconds, 30);
  assert.equal(clamped.maxFileBytes, 10 * 1024 * 1024);
  assert.equal(clamped.maxConcurrent, 3);
});

test('抖音视频先下载后引用原消息发封面与视频，并按规范作品ID跨短链/长链去重', async (t) => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dy-fwd-'));
  t.after(() => fs.rm(tmpDir, { recursive: true, force: true }));

  const sender = makeFakeSender();
  let resolveCount = 0;
  let infoCount = 0;
  let downloadCount = 0;
  const feature = new DouyinAutoForward({
    dataDir: tmpDir,
    sender,
    getConfig: () => ({ douyin: { enabled: true, maxFileBytes: 50 * 1024 * 1024 } }),
    downloadCover: async () => ({ contentType: 'image/jpeg', buffer: Buffer.from('coverjpg') }),
    api: {
      resolveDouyinLink: async (url) => {
        resolveCount += 1;
        return { kind: 'video', awemeId: '7480659754788900122', raw: url, expanded: url.includes('v.douyin.com') };
      },
      fetchDouyinInfo: async () => {
        infoCount += 1;
        return {
          ok: true,
          kind: 'video',
          awemeId: '7480659754788900122',
          title: '城市夜景延时',
          author: '航拍君',
          duration: 42,
          cover: 'https://p3.douyinpic.com/cover.jpeg',
          stats: { digg: 320, comment: 12, collect: 40, share: 8 },
          streams: [
            { gear: 'h264_1080', isHevc: false, bitRate: 2000000, sizeBytes: 1024, urls: ['https://cdn.example.com/1080.mp4'] }
          ]
        };
      },
      downloadDouyinVideo: async (_urls, dest) => {
        downloadCount += 1;
        await fs.writeFile(dest, Buffer.from('fake-mp4-content'));
        return { ok: true, bytes: 16 };
      }
    },
    log: { info() {}, warn() {} }
  });

  // 默认关闭私聊，不触发
  feature.handleMessage({ chatKey: 'private:1001', text: 'https://v.douyin.com/short1/', messageId: 11 });
  await flushQueue(feature);
  assert.equal(sender.calls.length, 0);

  // 群聊转发
  feature.handleMessage({ chatKey: 'group:2002', text: '看看这个 https://v.douyin.com/short1/复制打开抖音', messageId: 555 });
  await flushQueue(feature);

  assert.equal(sender.calls.length, 2);
  assert.equal(sender.calls[0].type, 'image');
  assert.equal(sender.calls[0].options.replyToMessageId, '555');
  assert.match(sender.calls[0].payload.text, /抖音｜城市夜景延时/);
  assert.equal(sender.calls[1].type, 'video');
  const expectedRunId = `douyin-${createHash('sha256').update('group:2002|7480659754788900122').digest('hex')}`;
  assert.equal(sender.calls[1].options.runId, expectedRunId);
  const sentFileStat = await fs.stat(sender.calls[1].payload.file);
  assert.equal(sentFileStat.isFile(), true);

  // 相同视频换长链 + 追踪参数，应被二级规范 ID 去重拦住，不重下不重发
  feature.handleMessage({
    chatKey: 'group:2002',
    text: 'https://www.douyin.com/video/7480659754788900122?previous_page=web&tt_from=copy',
    messageId: 556
  });
  await flushQueue(feature);
  assert.equal(resolveCount, 2);
  assert.equal(infoCount, 1);
  assert.equal(downloadCount, 1);
  assert.equal(sender.calls.length, 2);

  // 清空 seen 后允许再次发送
  feature.seen.clear();
  feature.handleMessage({
    chatKey: 'group:2002',
    text: 'https://www.douyin.com/video/7480659754788900122?previous_page=other',
    messageId: 557
  });
  await flushQueue(feature);
  assert.equal(downloadCount, 2);
  assert.equal(sender.calls.length, 4);
});

test('抖音高码率下载超限时自动降级备用码率；全部失败则仅报错并允许重试', async (t) => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dy-fallback-'));
  t.after(() => fs.rm(tmpDir, { recursive: true, force: true }));

  const sender = makeFakeSender();
  const attemptedUrls = [];
  const feature = new DouyinAutoForward({
    dataDir: tmpDir,
    sender,
    getConfig: () => ({ douyin: { enabled: true, preferredQuality: '1080p', maxFileBytes: 10 * 1024 * 1024 } }),
    downloadCover: async () => ({ contentType: 'image/jpeg', buffer: Buffer.from('jpg') }),
    api: {
      resolveDouyinLink: async () => ({ kind: 'video', awemeId: '99887766' }),
      fetchDouyinInfo: async () => ({
        ok: true,
        kind: 'video',
        awemeId: '99887766',
        title: '高码率降级测试',
        author: '作者',
        duration: 20,
        cover: 'https://p3.douyinpic.com/c.jpeg',
        streams: [
          { gear: 'h264_1080', isHevc: false, bitRate: 3000000, sizeBytes: 0, urls: ['https://cdn.example.com/high.mp4'] },
          { gear: 'h264_540', isHevc: false, bitRate: 800000, sizeBytes: 2048, urls: ['https://cdn.example.com/low.mp4'] }
        ]
      }),
      downloadDouyinVideo: async (urls, dest) => {
        attemptedUrls.push(urls[0]);
        if (urls[0].includes('high.mp4')) return { ok: false, tooLarge: true, sizeBytes: 20 * 1024 * 1024, error: '超过体积上限' };
        await fs.writeFile(dest, Buffer.from('low-video'));
        return { ok: true, bytes: 9 };
      }
    },
    log: { info() {}, warn() {} }
  });

  feature.handleMessage({ chatKey: 'group:1', text: 'https://www.douyin.com/video/99887766', messageId: 10 });
  await flushQueue(feature);
  assert.deepEqual(attemptedUrls, ['https://cdn.example.com/high.mp4', 'https://cdn.example.com/low.mp4']);
  assert.equal(sender.calls.length, 2);
  assert.equal(sender.calls[1].type, 'video');
});

test('抖音图文作品单图直接发送卡片，多图走详情卡片加分批合并转发及安全回退', async () => {
  const sender = makeFakeSender();
  let mode = 'single';
  const feature = new DouyinAutoForward({
    sender,
    selfId: () => '987654',
    getConfig: () => ({ douyin: { enabled: true, forwardGallery: true, maxGalleryImages: 12 } }),
    downloadCover: async (url) => ({ contentType: 'image/jpeg', buffer: Buffer.from(`img:${url}`) }),
    api: {
      resolveDouyinLink: async () => ({ kind: 'note', awemeId: mode === 'single' ? '11111111' : '22222222' }),
      fetchDouyinInfo: async () => {
        if (mode === 'single') {
          return {
            ok: true,
            kind: 'gallery',
            awemeId: '11111111',
            title: '单图摄影',
            author: '摄影小王',
            images: [{ url: 'https://p3.douyinpic.com/only.jpeg', mirrors: ['https://p3.douyinpic.com/only.jpeg'] }],
            stats: { digg: 10 }
          };
        }
        return {
          ok: true,
          kind: 'gallery',
          awemeId: '22222222',
          title: '十四图合集',
          author: '图集作者',
          images: Array.from({ length: 14 }, (_, idx) => ({
            url: `https://p3.douyinpic.com/${idx}.jpeg`,
            mirrors: [`https://p3.douyinpic.com/${idx}.jpeg`]
          })),
          stats: { digg: 88, collect: 9 }
        };
      }
    },
    log: { info() {}, warn() {} }
  });

  // 单图：仅发 1 条图文卡片，不发合并转发或视频
  feature.handleMessage({ chatKey: 'group:88', text: 'https://www.douyin.com/note/11111111', messageId: 1 });
  await flushQueue(feature);
  assert.equal(sender.calls.length, 1);
  assert.equal(sender.calls[0].type, 'image');
  assert.match(sender.calls[0].payload.text, /图片：1 张/);

  // 14 张图上限裁剪为 12 张并分成两批合并转发（10 + 2）
  sender.calls.length = 0;
  mode = 'multi';
  feature.handleMessage({ chatKey: 'group:88', text: 'https://www.douyin.com/note/22222222', messageId: 2 });
  await flushQueue(feature);
  assert.equal(sender.calls.length, 3);
  assert.equal(sender.calls[0].type, 'text');
  assert.match(sender.calls[0].messages[0], /仅转发前 12 张/);
  assert.equal(sender.calls[1].type, 'forward');
  assert.equal(sender.calls[1].payload.nodes.length, 10);
  assert.equal(sender.calls[1].payload.nodes[0].data.uin, '987654');
  assert.equal(sender.calls[2].type, 'forward');
  assert.equal(sender.calls[2].payload.nodes.length, 2);
});

test('抖音合并转发明确失败回退逐图，结果未知(unknown)绝不重复发送且锁定6小时去重', async () => {
  let forwardErr = Object.assign(new Error('HTTP 400'), { outcome: 'failed' });
  const sender = makeFakeSender({
    forward: async () => { throw forwardErr; }
  });
  const feature = new DouyinAutoForward({
    sender,
    getConfig: () => ({ douyin: { enabled: true } }),
    downloadCover: async (url) => ({ contentType: 'image/jpeg', buffer: Buffer.from(`img:${url}`) }),
    api: {
      resolveDouyinLink: async () => ({ kind: 'note', awemeId: '33333333' }),
      fetchDouyinInfo: async () => ({
        ok: true,
        kind: 'gallery',
        awemeId: '33333333',
        title: '双图',
        author: '作者',
        images: [
          { url: 'https://p3.douyinpic.com/1.jpeg', mirrors: ['https://p3.douyinpic.com/1.jpeg'] },
          { url: 'https://p3.douyinpic.com/2.jpeg', mirrors: ['https://p3.douyinpic.com/2.jpeg'] }
        ]
      })
    },
    log: { info() {}, warn() {} }
  });

  // 明确 failed 应回退逐图
  feature.handleMessage({ chatKey: 'group:1', text: 'https://www.douyin.com/note/33333333', messageId: 9 });
  await flushQueue(feature);
  assert.deepEqual(sender.calls.map(c => c.type), ['text', 'forward', 'image', 'image']);

  // 清空去重改为 unknown 超时错误：绝不回退逐图，且保留去重并警告
  feature.seen.clear();
  sender.calls.length = 0;
  forwardErr = new Error('Request timed out');
  feature.handleMessage({ chatKey: 'group:1', text: 'https://www.douyin.com/note/33333333', messageId: 10 });
  await flushQueue(feature);
  assert.deepEqual(sender.calls.map(c => c.type), ['text', 'forward', 'text']);
  assert.match(sender.calls[2].messages[0], /结果未知/);
  assert.equal(feature.seen.size, 1);
});

test('抖音视频发送failed允许重试，发送unknown保留去重并提示核对聊天记录', async (t) => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dy-retry-'));
  t.after(() => fs.rm(tmpDir, { recursive: true, force: true }));

  let videoErr = Object.assign(new Error('HTTP 400'), { outcome: 'failed' });
  const sender = makeFakeSender({
    video: async () => { throw videoErr; }
  });
  const feature = new DouyinAutoForward({
    dataDir: tmpDir,
    sender,
    getConfig: () => ({ douyin: { enabled: true } }),
    downloadCover: async () => ({ contentType: 'image/jpeg', buffer: Buffer.from('jpg') }),
    api: {
      resolveDouyinLink: async () => ({ kind: 'video', awemeId: '55555555' }),
      fetchDouyinInfo: async () => ({
        ok: true,
        kind: 'video',
        awemeId: '55555555',
        title: '边界测试',
        author: '作者',
        duration: 15,
        cover: 'https://p3.douyinpic.com/c.jpeg',
        streams: [{ gear: 'default', isHevc: false, bitRate: 1, sizeBytes: 10, urls: ['https://cdn.example.com/v.mp4'] }]
      }),
      downloadDouyinVideo: async (_u, dest) => {
        await fs.writeFile(dest, Buffer.from('mp4'));
        return { ok: true, bytes: 3 };
      }
    },
    log: { info() {}, warn() {} }
  });

  feature.handleMessage({ chatKey: 'group:1', text: 'https://www.douyin.com/video/55555555', messageId: 1 });
  await flushQueue(feature);
  assert.equal(feature.seen.size, 0);
  assert.equal(feature.seenCanonical.size, 0);
  assert.match(sender.calls.at(-1).messages[0], /抖音转发失败/);

  videoErr = new Error('Socket hung up timeout');
  feature.handleMessage({ chatKey: 'group:1', text: 'https://www.douyin.com/video/55555555', messageId: 2 });
  await flushQueue(feature);
  assert.equal(feature.seen.size, 1);
  assert.equal(feature.seenCanonical.size, 1);
  assert.match(sender.calls.at(-1).messages[0], /结果未知/);
});

test('抖音默认优先下载720P清晰度，支持配置切换为1080P', async (t) => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dy-quality-'));
  t.after(() => fs.rm(tmpDir, { recursive: true, force: true }));

  const sender = makeFakeSender();
  const downloadedUrls = [];
  let currentCfg = { douyin: { enabled: true } };

  const feature = new DouyinAutoForward({
    dataDir: tmpDir,
    sender,
    getConfig: () => currentCfg,
    downloadCover: async () => ({ contentType: 'image/jpeg', buffer: Buffer.from('jpg') }),
    api: {
      resolveDouyinLink: async () => ({ kind: 'video', awemeId: '77777777' }),
      fetchDouyinInfo: async () => ({
        ok: true,
        kind: 'video',
        awemeId: '77777777',
        title: '清晰度切换测试',
        author: '作者',
        duration: 18,
        cover: 'https://p3.douyinpic.com/c.jpeg',
        streams: [
          { gear: 'normal_1080_0', isHevc: false, bitRate: 3000000, sizeBytes: 5000, width: 1080, height: 1920, resolution: 1080, urls: ['https://cdn.example.com/1080.mp4'] },
          { gear: 'normal_720_0', isHevc: false, bitRate: 1500000, sizeBytes: 3000, width: 720, height: 1280, resolution: 720, urls: ['https://cdn.example.com/720.mp4'] },
          { gear: 'normal_540_0', isHevc: false, bitRate: 800000, sizeBytes: 2000, width: 576, height: 1024, resolution: 540, urls: ['https://cdn.example.com/540.mp4'] }
        ]
      }),
      downloadDouyinVideo: async (urls, dest) => {
        downloadedUrls.push(urls[0]);
        await fs.writeFile(dest, Buffer.from('mp4'));
        return { ok: true, bytes: 3 };
      }
    },
    log: { info() {}, warn() {} }
  });

  // 默认配置应选 720P
  feature.handleMessage({ chatKey: 'group:1', text: 'https://www.douyin.com/video/77777777', messageId: 1 });
  await flushQueue(feature);
  assert.deepEqual(downloadedUrls, ['https://cdn.example.com/720.mp4']);

  // 改为 1080p 后应选 1080P
  feature.seen.clear();
  currentCfg = { douyin: { enabled: true, preferredQuality: '1080p' } };
  feature.handleMessage({ chatKey: 'group:1', text: 'https://www.douyin.com/video/77777777', messageId: 2 });
  await flushQueue(feature);
  assert.deepEqual(downloadedUrls, ['https://cdn.example.com/720.mp4', 'https://cdn.example.com/1080.mp4']);
});
