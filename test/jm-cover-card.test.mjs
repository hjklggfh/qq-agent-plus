import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { registerHooks } from 'node:module';
import test from 'node:test';
import crypto from 'node:crypto';
import sharp from 'sharp';
import { fetchSiteCover } from '../src/features/jm-suomingor/daily_updates.mjs';

const legacyUrl = new URL('../src/features/jm-suomingor/legacy-index.js', import.meta.url).href;
const dailyUrl = new URL('../src/features/jm-suomingor/daily_updates.mjs', import.meta.url).href;

const state = {
  cards: [],
  digests: [],
  fetch: null,
  scrambleId: 220980,
};
globalThis.__jmCoverTest = state;

const engineStub = `export * from '${new URL('../src/features/jm-suomingor/engine.js', import.meta.url).href}';
  export const createClient = opts => ({
    ...engineBase(opts),
    albumInfo: async id => ({ id, name: '封面测试作品', series: [], authors: ['作者'], tags: ['标签'], description: '简介' }),
    photoInfo: async id => ({ id, images: ['00001.png'] }),
    fetchScrambleId: async () => globalThis.__jmCoverTest.scrambleId,
  });
  import * as base from '${new URL('../src/features/jm-suomingor/engine.js', import.meta.url).href}';
  function engineBase(opts) { return base.createClient(opts); }`;

const pdfStub = `import fs from 'node:fs';
  export const detect = () => ({ ok: true, python: 'mock' });
  export const runTask = async ({ task }) => {
    fs.writeFileSync(task.output, '%PDF-mock');
    return { ok: true, output: task.output, pages: 1, pagesOk: 1, restored: 1, bytes: 9, timings: {} };
  };`;

const dailyStub = `
  import fs from 'node:fs';
  import * as real from '${dailyUrl}';
  export const { collect, buildDigestFromState, sendDigest, loadDigestItems, sendDigestImage, cleanTitle, fetchSiteCover } = real;
  export const renderDigestImage = async ({ payload, outPath }) => {
    globalThis.__jmCoverTest.digests.push(payload);
    fs.writeFileSync(outPath, 'digest-jpg');
    return outPath;
  };
  export const renderAlbumImage = async ({ payload, outPath }) => {
    globalThis.__jmCoverTest.cards.push(payload);
    fs.writeFileSync(outPath, 'album-jpg');
    return outPath;
  };`;

const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (context.parentURL === legacyUrl) {
      const stub = specifier === './engine.js'
        ? engineStub
        : specifier === './pdf.js'
          ? pdfStub
          : specifier === './daily_updates.mjs'
            ? dailyStub
            : null;
      if (stub) return { url: `data:text/javascript,${encodeURIComponent(stub)}`, shortCircuit: true };
    }
    return next(specifier, context);
  },
});
const jm = await import(legacyUrl);
hooks.deregister();

const jpegBuf = await sharp(crypto.randomBytes(120 * 160 * 3), {
  raw: { width: 120, height: 160, channels: 3 },
}).jpeg({ quality: 90 }).toBuffer();

const pngBuf = await sharp(crypto.randomBytes(120 * 160 * 3), {
  raw: { width: 120, height: 160, channels: 3 },
}).png().toBuffer();

async function waitFor(check) {
  for (let i = 0; i < 300; i++) {
    const val = check();
    if (val) return val;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.fail('JM 任务超时');
}

test('fetchSiteCover 写入指定 downloadDir/daily-covers 并过滤损坏缓存', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jm-site-cover-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const badPath = path.join(root, 'daily-covers', '998877.jpg');
  fs.mkdirSync(path.dirname(badPath), { recursive: true });
  fs.writeFileSync(badPath, Buffer.alloc(2048, 0));

  let requested = 0;
  const hit = await fetchSiteCover('998877', {
    downloadDir: root,
    fetchImpl: async () => {
      requested += 1;
      return new Response(jpegBuf, { status: 200, headers: { 'content-type': 'image/jpeg' } });
    },
  });
  assert.equal(hit, badPath);
  assert.equal(requested, 1);
  assert.deepEqual(fs.readFileSync(hit), jpegBuf);

  const cached = await fetchSiteCover('998877', {
    downloadDir: root,
    fetchImpl: async () => {
      throw new Error('命中有效缓存后不应再发网络请求');
    },
  });
  assert.equal(cached, badPath);
});

test('单本简介卡与今日JM优先使用站点官方封面，不可用时回退本地图并传递 scrambleId', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jm-cover-card-'));
  t.after(() => {
    jm.dispose();
    delete globalThis.__jmCoverTest;
    fs.rmSync(root, { recursive: true, force: true });
  });

  let siteCoverAvailable = true;
  const tools = new Map();
  const messages = [];
  const config = {
    enabled: true,
    downloadDir: root,
    dataDir: root,
    translateTitles: false,
    uploadMode: 'off',
    deleteImagesAfterPdf: false,
    keepHours: 12,
    restore: true,
  };

  jm.setup({
    config: () => config,
    registerTool: (tool) => tools.set(tool.id, tool),
    log: () => {},
    warn: () => {},
    fetch: async (url) => {
      if (String(url).includes('/media/albums/')) {
        if (!siteCoverAvailable) return new Response('not found', { status: 404 });
        return new Response(jpegBuf, { status: 200, headers: { 'content-type': 'image/jpeg' } });
      }
      return new Response(pngBuf, { status: 200, headers: { 'content-type': 'image/png' } });
    },
  });

  const onebot = {
    async sendSegments() {},
  };
  const sender = {
    async sendTextBatch(_chatKey, list) {
      messages.push(...list);
    },
  };
  const ctx = { chatKey: 'group:100001', kind: 'group', onebot, sender };

  // 1) 站点封面可用：即使本地目录保留了未还原的 00001.png，也应使用 daily-covers 里的官方封面
  await tools.get('download_album').execute(ctx, { album_id: '533801' });
  await waitFor(() => state.cards.length === 1 && messages.some((m) => m.includes('处理好啦')));
  const firstCard = state.cards[0];
  assert.equal(firstCard.cover, path.join(root, 'daily-covers', '533801.jpg'));
  assert.equal(firstCard.cover_scrambled, false);
  assert.equal(firstCard.cover_scramble_id, 0);

  const albumDir = path.join(root, 'jm-533801');
  const subDir = fs.readdirSync(albumDir).find((name) => fs.statSync(path.join(albumDir, name)).isDirectory());
  const meta = JSON.parse(fs.readFileSync(path.join(albumDir, subDir, 'metadata.json'), 'utf8'));
  assert.equal(meta.scrambleId, 220980);

  // 2) 站点封面不可用（无 cached cover 的新本子）：应回退到本地第一页并附带 scrambleId
  siteCoverAvailable = false;
  await tools.get('download_album').execute(ctx, { album_id: '533802' });
  await waitFor(() => state.cards.length === 2);
  const fallbackCard = state.cards[1];
  assert.ok(fallbackCard.cover.endsWith('00001.png'));
  assert.equal(fallbackCard.cover_scrambled, true);
  assert.equal(fallbackCard.cover_scramble_id, 220980);

  // 3) 缓存重发时，若站点封面不可用，应能从 metadata.json 读取原 scrambleId
  await tools.get('download_album').execute(ctx, { album_id: '533802' });
  await waitFor(() => state.cards.length === 3);
  const cachedFallbackCard = state.cards[2];
  assert.ok(cachedFallbackCard.cover.endsWith('00001.png'));
  assert.equal(cachedFallbackCard.cover_scrambled, true);
  assert.equal(cachedFallbackCard.cover_scramble_id, 220980);

  // 4) 今日JM书架卡片：533801 命中站点封面（不反混淆），533802 回退本地图（标记需反混淆）
  await tools.get('today_list').execute(ctx, {});
  assert.equal(state.digests.length, 1);
  const item533801 = state.digests[0].items.find((it) => it.id === '533801');
  const item533802 = state.digests[0].items.find((it) => it.id === '533802');
  assert.equal(item533801.cover, path.join(root, 'daily-covers', '533801.jpg'));
  assert.equal(item533801.cover_scrambled, false);
  assert.ok(item533802.cover.endsWith('00001.png'));
  assert.equal(item533802.cover_scrambled, true);
  assert.equal(item533802.cover_scramble_id, 220980);
});
