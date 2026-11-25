import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { registerHooks } from 'node:module';
import test from 'node:test';
import sharp from 'sharp';
import * as engine from '../src/features/jm-suomingor/engine.js';
import { rawDownloadByteLimit, removeRejectedAlbumDir } from '../src/features/jm-suomingor/limits.js';

const legacyUrl = new URL('../src/features/jm-suomingor/legacy-index.js', import.meta.url).href;
const state = {
  pdfBytes: 16,
  pdfCalls: 0,
  photoCalls: 0,
  fetchCalls: 0,
  album: null,
  photos: new Map(),
};
globalThis.__jmOversizeTest = state;

const engineStub = `export * from '${new URL('../src/features/jm-suomingor/engine.js', import.meta.url).href}';
  export const createClient = opts => globalThis.__jmOversizeTest.client(opts);`;
const pdfStub = `import fs from 'node:fs';
  export const detect = () => ({ ok: true, python: 'mock' });
  export const runTask = async ({ task }) => {
    globalThis.__jmOversizeTest.pdfCalls += 1;
    const buf = Buffer.alloc(globalThis.__jmOversizeTest.pdfBytes, 0x41);
    fs.writeFileSync(task.output, buf);
    return { ok: true, output: task.output, pages: task.chapters.reduce((n, ch) => n + ch.pages.length, 0), bytes: buf.length, timings: { restoreMs: 1, pdfWriteMs: 1 } };
  };`;
const dailyStub = `
  export const collect = () => {}, buildDigestFromState = () => {}, sendDigest = () => {}, loadDigestItems = () => [],
    renderDigestImage = () => {}, sendDigestImage = () => {}, cleanTitle = x => x, fetchSiteCover = async () => '';
  export const renderAlbumImage = async () => { throw new Error('mock card'); };`;

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

const settle = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check) {
  for (let i = 0; i < 400; i++) {
    const result = check();
    if (result) return result;
    await settle(10);
  }
  assert.fail('JM oversize test timed out');
}

test('limits 纯函数边界与路径越界保护', async () => {
  assert.equal(rawDownloadByteLimit({ rejectOversize: false, uploadMode: 'request', maxUploadMB: 500 }), 0);
  assert.equal(rawDownloadByteLimit({ rejectOversize: true, uploadMode: 'off', maxUploadMB: 500 }), 0);
  assert.equal(rawDownloadByteLimit({ rejectOversize: true, uploadMode: 'request', maxUploadMB: 500 }), Math.round(500 * 1024 * 1024 * 1.5));

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jm-limits-safe-'));
  try {
    // 越界目录（父目录 / 自身）必须拒绝删除
    assert.equal(await removeRejectedAlbumDir(root, root), false);
    assert.equal(await removeRejectedAlbumDir(path.dirname(root), root), false);
    const child = path.join(root, 'jm-410299');
    fs.mkdirSync(child, { recursive: true });
    fs.writeFileSync(path.join(child, 'a.pdf'), 'x');
    assert.equal(await removeRejectedAlbumDir(child, root), true);
    assert.equal(fs.existsSync(child), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('JM 三道超限硬闸门：多章总页数预检秒拒、下载中总字节熔断、合成超限拒传自动清理', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jm-oversize-job-'));
  const tools = new Map();
  const sentMessages = [];
  let config = {
    enabled: true,
    downloadDir: root,
    concurrency: 2,
    cdnStrategy: 'fixed',
    keepHours: 0,
    keepDays: 7,
    maxPages: 10,
    maxUploadMB: 1,
    rejectOversize: true,
    multiChapter: true,
    restore: false,
    translateTitles: false,
    outputFormat: 'pdf',
    uploadMode: 'request',
    checkQuota: false,
  };

  // 生成一张约 260 KB 的合法 PNG（噪点图不易被 PNG 压小），用于触发下载中字节熔断
  const bigPng = await sharp(crypto.randomBytes(360 * 360 * 3), { raw: { width: 360, height: 360, channels: 3 } })
    .png({ compressionLevel: 0 })
    .toBuffer();
  assert.ok(bigPng.length > 300 * 1024, `expected large png, got ${bigPng.length}`);

  jm.setup({
    config: () => config,
    registerTool: (tool) => tools.set(tool.id, tool),
    log: () => {},
    warn: () => {},
    fetch: async () => {
      state.fetchCalls += 1;
      return new Response(bigPng, { headers: { 'content-type': 'image/png' } });
    },
  });
  t.after(() => {
    jm.dispose();
    delete globalThis.__jmOversizeTest;
    fs.rmSync(root, { recursive: true, force: true });
  });

  state.client = (opts) => {
    const real = engine.createClient(opts);
    return {
      ...real,
      albumInfo: async () => state.album,
      photoInfo: async (id) => {
        state.photoCalls += 1;
        return { id, name: `ch-${id}`, images: state.photos.get(String(id)) || [] };
      },
    };
  };

  const ctx = {
    chatKey: 'group:1128139524',
    kind: 'group',
    onebot: { call: async () => ({ file_id: 'f-1' }) },
    sender: {
      sendTextBatch: async (_chatKey, msgs) => {
        sentMessages.push(...msgs);
      },
    },
  };
  const history = () => {
    try { return JSON.parse(fs.readFileSync(path.join(root, 'tasks.json'), 'utf8')); } catch { return []; }
  };

  // 场景 1（闸门 1）：多章漫画单章仅 4 页 (< maxPages=10)，但共 5 话累计 20 页 -> 扫到第 3 话即秒拒，0 次图片下载，不建目录
  state.photoCalls = 0;
  state.fetchCalls = 0;
  state.pdfCalls = 0;
  state.album = {
    id: '410299',
    name: '剑风传奇全集',
    series: [1, 2, 3, 4, 5].map((n) => ({ id: `4102990${n}`, name: `第${n}话`, sort: n })),
    authors: [],
    tags: [],
  };
  state.photos = new Map(state.album.series.map((s) => [s.id, ['00001.png', '00002.png', '00003.png', '00004.png']]));
  await tools.get('download_album').execute(ctx, { album_id: '410299' });
  const rec1 = await until(() => history().find((row) => row.id === '410299'));
  assert.equal(rec1.stage, 'rejected');
  assert.equal(rec1.ok, false);
  assert.equal(state.photoCalls, 3, '累计到第 3 话（12 > 10 页）应立即停止后续章节 photoInfo');
  assert.equal(state.fetchCalls, 0, '预检拒绝后绝不应下载任何图片');
  assert.equal(state.pdfCalls, 0, '预检拒绝后绝不应调用 PDF 合成');
  assert.equal(fs.existsSync(path.join(root, 'jm-410299')), false, '预检拒绝不应遗留目录');
  assert.match(sentMessages.at(-1), /⛔ JM410299《剑风传奇全集》共 5 话，仅前 3 话已达 12 页，超过整本上限 10 页/);

  // 场景 2（闸门 2）：单章 8 页 (<= maxPages=10)，但每张 PNG ~380KB，累计超过 1MB*1.5=1.5MB -> 下载中熔断并清理目录
  state.photoCalls = 0;
  state.fetchCalls = 0;
  state.pdfCalls = 0;
  state.album = { id: '550001', name: '超清大图集', series: [], authors: [], tags: [] };
  state.photos = new Map([['550001', Array.from({ length: 8 }, (_, i) => `${String(i + 1).padStart(5, '0')}.png`)]]);
  await tools.get('download_album').execute(ctx, { album_id: '550001' });
  const rec2 = await until(() => history().find((row) => row.id === '550001'));
  assert.equal(rec2.stage, 'rejected');
  assert.equal(state.pdfCalls, 0, '下载中熔断后不应再合成 PDF');
  assert.ok(state.fetchCalls < 8, `应在下完 8 张前熔断（实际 ${state.fetchCalls} 次）`);
  assert.equal(fs.existsSync(path.join(root, 'jm-550001')), false, '下载中熔断后必须清理 jm-550001 目录');
  assert.match(sentMessages.at(-1), /预计超过单文件上限 1 MB，已中止下载并清理临时文件/);

  // 场景 3（闸门 3）：仅 2 页（原图约 760KB < 1.5MB 熔断线），但模拟合成后的 PDF 超过 1MB 上限 -> 拒绝上传并清理本地目录
  state.photoCalls = 0;
  state.fetchCalls = 0;
  state.pdfCalls = 0;
  state.pdfBytes = 1200 * 1024; // 1.2 MB > maxUploadMB(1 MB)
  state.album = { id: '550002', name: '合成超限本子', series: [], authors: [], tags: [] };
  state.photos = new Map([['550002', ['00001.png', '00002.png']]]);
  await tools.get('download_album').execute(ctx, { album_id: '550002' });
  const rec3 = await until(() => history().find((row) => row.id === '550002'));
  assert.equal(rec3.stage, 'rejected');
  assert.equal(state.pdfCalls, 1);
  assert.equal(fs.existsSync(path.join(root, 'jm-550002')), false, '合成后超限拒绝必须清理 jm-550002 废目录');
  assert.match(sentMessages.at(-1), /超过单文件上限 1 MB，已拒绝上传并清理本地临时文件/);
});
