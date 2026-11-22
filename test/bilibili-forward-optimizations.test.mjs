import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pickBiliLink, resolveLink, downloadVideo } from '../src/features/bilibili-api.js';
import { BilibiliAutoForward } from '../src/features/bilibili-auto-forward.js';

function makeFakeSender() {
  const calls = [];
  return {
    calls,
    async sendTextBatch(chatKey, messages, options = {}) {
      calls.push({ type: 'text', chatKey, messages, options });
      return { sent: messages, failed: [] };
    },
    async image(chatKey, payload, options = {}) {
      calls.push({ type: 'image', chatKey, payload, options });
      return { ok: true };
    },
    async video(chatKey, payload, options = {}) {
      calls.push({ type: 'video', chatKey, payload, options });
      return { ok: true };
    }
  };
}

async function flushQueue(feature) {
  for (let i = 0; i < 60; i += 1) {
    if (feature.running === 0 && feature.pending.length === 0) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for BilibiliAutoForward queue');
}

test('pickBiliLink与extractUrls兼容中文分享文案粘连及裸链接', () => {
  assert.equal(
    pickBiliLink('快来看这个视频 https://b23.tv/abcXYZ打开B站体验更好'),
    'https://b23.tv/abcXYZ'
  );
  const feature = new BilibiliAutoForward();
  assert.deepEqual(
    feature.extractUrls('推荐 b23.tv/Short01 和 www.bilibili.com/video/BV1xx411c7mD?p=2 顺带 https://www.bilibili.com/'),
    [
      'https://b23.tv/Short01',
      'https://www.bilibili.com/video/BV1xx411c7mD?p=2'
    ]
  );
});

test('resolveLink直接识别/ep番剧且BilibiliAutoForward支持转发番剧单集', async (t) => {
  const direct = await resolveLink('https://www.bilibili.com/bangumi/play/ep123456');
  assert.equal(direct.kind, 'bangumi');
  assert.equal(direct.epId, 123456);

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bili-ep-'));
  t.after(() => fs.rm(tmpDir, { recursive: true, force: true }));

  const sender = makeFakeSender();
  const feature = new BilibiliAutoForward({
    dataDir: tmpDir,
    sender,
    getConfig: () => ({ bilibili: { enabled: true } }),
    downloadCover: async () => ({ contentType: 'image/jpeg', buffer: Buffer.from('epcover') }),
    api: {
      resolveLink: async (u) => resolveLink(u),
      fetchVideoInfo: async (link) => ({
        ok: true,
        kind: 'bangumi',
        epId: link.epId,
        bvid: 'BV1epTest0001',
        aid: 1001,
        cid: 2002,
        title: '番剧 第1话 启程',
        author: '番剧官方',
        duration: 120,
        cover: 'https://i0.hdslb.com/bfs/archive/epcover.jpg',
        page: 1,
        pageTotal: 1
      }),
      getPlayUrl: async () => ({ ok: true, qn: 16, sizeBytes: 1024, urls: ['https://upos.example.com/ep.mp4'], accept: [16] }),
      downloadVideo: async (_urls, dest) => {
        await fs.writeFile(dest, Buffer.from('ep-mp4'));
        return { ok: true, bytes: 6 };
      }
    },
    log: { info() {}, warn() {} }
  });

  feature.handleMessage({ chatKey: 'group:10', text: 'https://www.bilibili.com/bangumi/play/ep123456', messageId: 88 });
  await flushQueue(feature);

  assert.equal(sender.calls.length, 2);
  assert.equal(sender.calls[0].type, 'image');
  assert.match(sender.calls[0].payload.text, /https:\/\/www\.bilibili\.com\/bangumi\/play\/ep123456/);
  assert.equal(sender.calls[1].type, 'video');
});

test('B站视频清晰度超限时自动向下重试qn且downloadVideo非流式超限携带tooLarge', async (t) => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bili-qn-'));
  t.after(() => fs.rm(tmpDir, { recursive: true, force: true }));

  // 验证 downloadVideo 的无 stream reader 分支超限时也返回 tooLarge: true
  const rawDest = path.join(tmpDir, 'raw.mp4');
  const fakeNoReaderRes = {
    status: 200,
    headers: new Headers({ 'content-type': 'video/mp4' }),
    body: {},
    async arrayBuffer() { return Uint8Array.from([1, 2, 3, 4, 5, 6]).buffer; }
  };
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => fakeNoReaderRes;
  t.after(() => { globalThis.fetch = origFetch; });
  const dlOverflow = await downloadVideo(['https://upos.example.com/1.mp4'], rawDest, { maxBytes: 4 });
  assert.equal(dlOverflow.ok, false);
  assert.equal(dlOverflow.tooLarge, true);

  const triedQns = [];
  const sender = makeFakeSender();
  const feature = new BilibiliAutoForward({
    dataDir: tmpDir,
    sender,
    getConfig: () => ({ bilibili: { enabled: true, qn: 64, maxFileBytes: 25 * 1024 * 1024 } }),
    downloadCover: async () => ({ contentType: 'image/jpeg', buffer: Buffer.from('cover') }),
    api: {
      resolveLink: async () => ({ kind: 'video', bvid: 'BV1qnTest0001', page: 1 }),
      fetchVideoInfo: async () => ({
        ok: true,
        kind: 'video',
        bvid: 'BV1qnTest0001',
        aid: 2,
        cid: 3,
        title: '高画质降级测试',
        author: 'UP主',
        duration: 60,
        cover: 'https://i0.hdslb.com/cover.jpg',
        page: 1,
        pageTotal: 1
      }),
      getPlayUrl: async (_bvid, _cid, { qn }) => {
        triedQns.push(qn);
        // 64 在取流期就显示超限；32 流信息未知但在下载中超限；16 正常成功
        if (qn === 64) return { ok: true, qn: 64, sizeBytes: 80 * 1024 * 1024, urls: ['https://upos/64.mp4'], accept: [64, 32, 16] };
        if (qn === 32) return { ok: true, qn: 32, sizeBytes: 0, urls: ['https://upos/32.mp4'], accept: [64, 32, 16] };
        return { ok: true, qn: 16, sizeBytes: 10 * 1024 * 1024, urls: ['https://upos/16.mp4'], accept: [64, 32, 16] };
      },
      downloadVideo: async (urls, dest) => {
        if (urls[0].includes('/32.mp4')) return { ok: false, tooLarge: true, sizeBytes: 30 * 1024 * 1024, error: '体积超限' };
        await fs.writeFile(dest, Buffer.from('ok16'));
        return { ok: true, bytes: 4 };
      }
    },
    log: { info() {}, warn() {} }
  });

  feature.handleMessage({ chatKey: 'group:1', text: 'https://www.bilibili.com/video/BV1qnTest0001', messageId: 1 });
  await flushQueue(feature);

  assert.deepEqual(triedQns, [64, 32, 16]);
  assert.equal(sender.calls.length, 2);
  assert.equal(sender.calls[1].type, 'video');
});

test('B站转发剥离追踪参数并按规范BV号二级去重，且保持seen.clear清空联动', async (t) => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bili-dedup-'));
  t.after(() => fs.rm(tmpDir, { recursive: true, force: true }));

  let infoCalls = 0;
  let dlCalls = 0;
  const sender = makeFakeSender();
  const feature = new BilibiliAutoForward({
    dataDir: tmpDir,
    sender,
    getConfig: () => ({ bilibili: { enabled: true } }),
    downloadCover: async () => ({ contentType: 'image/jpeg', buffer: Buffer.from('cover') }),
    api: {
      resolveLink: async () => ({ kind: 'video', bvid: 'BV1dedup12345', page: 1 }),
      fetchVideoInfo: async () => {
        infoCalls += 1;
        return {
          ok: true,
          kind: 'video',
          bvid: 'BV1dedup12345',
          aid: 9,
          cid: 10,
          title: '去重测试',
          author: 'UP主',
          duration: 30,
          cover: 'https://i0.hdslb.com/cover.jpg',
          page: 1,
          pageTotal: 1
        };
      },
      getPlayUrl: async () => ({ ok: true, qn: 16, sizeBytes: 100, urls: ['https://upos/v.mp4'], accept: [16] }),
      downloadVideo: async (_urls, dest) => {
        dlCalls += 1;
        await fs.writeFile(dest, Buffer.from('ok'));
        return { ok: true, bytes: 2 };
      }
    },
    log: { info() {}, warn() {} }
  });

  // 第一条携带 spm_id_from 追踪参数 -> 发送成功
  feature.handleMessage({ chatKey: 'group:5', text: 'https://www.bilibili.com/video/BV1dedup12345?spm_id_from=333.1', messageId: 1 });
  await flushQueue(feature);
  assert.equal(dlCalls, 1);
  assert.equal(feature.seen.size, 1);

  // 第二条仅追踪参数不同 -> 入口即被剥离追踪参数后的 URL 去重拦截
  feature.handleMessage({ chatKey: 'group:5', text: 'https://www.bilibili.com/video/BV1dedup12345?vd_source=xyz', messageId: 2 });
  await flushQueue(feature);
  assert.equal(infoCalls, 1);
  assert.equal(dlCalls, 1);
  assert.equal(feature.seen.size, 1);

  // 第三条换成短链 b23.tv/xyz -> 二级规范 BV 去重拦截，不重下不重发
  feature.handleMessage({ chatKey: 'group:5', text: 'https://b23.tv/xyz999', messageId: 3 });
  await flushQueue(feature);
  assert.equal(infoCalls, 2);
  assert.equal(dlCalls, 1);
  assert.equal(feature.seen.size, 2);

  // 清空 seen 同时联动重置规范去重，再次发即可重新处理
  feature.seen.clear();
  feature.handleMessage({ chatKey: 'group:5', text: 'https://www.bilibili.com/video/BV1dedup12345', messageId: 4 });
  await flushQueue(feature);
  assert.equal(dlCalls, 2);
});
