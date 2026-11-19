import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { registerHooks } from 'node:module';
import test from 'node:test';
import sharp from 'sharp';
import * as engine from '../src/features/jm-suomingor/engine.js';

const legacyUrl = new URL('../src/features/jm-suomingor/legacy-index.js', import.meta.url).href;
const state = {
  pdfTasks: [],
  names: ['00001.png', '00002.png', '00003.png'],
  failSecondPage: true,
  fetchedFiles: [],
  groupFiles: [],
  deletedFileIds: [],
  uploaded: [],
  texts: [],
};
globalThis.__jmIncompleteTest = state;

const engineStub = `export * from '${new URL('../src/features/jm-suomingor/engine.js', import.meta.url).href}';
  export const createClient = opts => globalThis.__jmIncompleteTest.client(opts);`;
const pdfStub = `import fs from 'node:fs';
  export const detect = () => ({ ok: true, python: 'mock' });
  export const runTask = async ({ task }) => {
    globalThis.__jmIncompleteTest.pdfTasks.push(task);
    fs.writeFileSync(task.output, Buffer.alloc(2048, 0x25));
    const count = task.chapters.reduce((n, ch) => n + ch.pages.length, 0);
    return { ok: true, output: task.output, pages: count, pagesOk: count, bytes: 2048, restored: 0, timings: { restoreMs: 1, pdfWriteMs: 1 } };
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

const image = await sharp(crypto.randomBytes(64 * 96 * 3), { raw: { width: 64, height: 96, channels: 3 } }).png().toBuffer();
const settle = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check) {
  for (let i = 0; i < 500; i++) {
    const result = check();
    if (result) return result;
    await settle(10);
  }
  assert.fail('JM incomplete resume task timed out');
}

test('缺页PDF打标、断点只补缺页保持原序、补齐重传正常名并删除群内旧残缺文件', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jm-incomplete-resume-'));
  const tools = new Map();
  let fidSeq = 1;

  jm.setup({
    config: () => ({
      enabled: true,
      downloadDir: root,
      concurrency: 2,
      cdnStrategy: 'fixed',
      keepHours: 12,
      keepDays: 7,
      deleteImagesAfterPdf: false,
      restore: false,
      translateTitles: false,
      outputFormat: 'pdf',
      uploadMode: 'group',
      checkQuota: false,
      maxUploadMB: 200,
    }),
    registerTool: (tool) => tools.set(tool.id, tool),
    log: () => {},
    warn: () => {},
    fetch: async (url) => {
      const name = new URL(url).pathname.split('/').pop();
      state.fetchedFiles.push(name);
      if (state.failSecondPage && name === '00002.png') {
        return new Response('not found', { status: 404 });
      }
      return new Response(image, { headers: { 'content-type': 'image/png' } });
    },
  });

  t.after(() => {
    jm.dispose();
    delete globalThis.__jmIncompleteTest;
    fs.rmSync(root, { recursive: true, force: true });
  });

  state.client = (opts) => {
    const real = engine.createClient(opts);
    return {
      ...real,
      albumInfo: async (id) => ({ id, name: 'TestAlbum', series: [], authors: [], tags: [] }),
      photoInfo: async (id) => ({ id, images: state.names }),
    };
  };

  const ctx = {
    chatKey: 'group:747206342',
    kind: 'group',
    sender: {
      sendTextBatch: async (_chatKey, msgs, opts) => {
        assert.equal(opts?.bypassTimeControl, true);
        state.texts.push(...msgs);
      },
    },
    onebot: {
      async call(action, params = {}) {
        if (action === 'upload_group_file') {
          const fileId = `fid-${fidSeq++}`;
          state.uploaded.push({ name: params.name, fileId });
          state.groupFiles.push({ file_id: fileId, file_name: params.name, busid: 102 });
          return { file_id: fileId };
        }
        if (action === 'get_group_root_files') {
          return { files: [...state.groupFiles] };
        }
        if (action === 'delete_group_file') {
          state.deletedFileIds.push(params.file_id);
          state.groupFiles = state.groupFiles.filter((f) => f.file_id !== params.file_id);
          return {};
        }
        return {};
      },
    },
  };

  const history = () => {
    try { return JSON.parse(fs.readFileSync(path.join(root, 'tasks.json'), 'utf8')); }
    catch { return []; }
  };

  // 1) 初次下载：00002.png 缺失 → 应生成带「（缺1页）」的 PDF，并记录 incomplete: true
  await tools.get('download_album').execute(ctx, { album_id: '1470985' });
  await until(() => history().find((r) => r.id === '1470985' && r.ok));
  const albumDir = path.join(root, 'jm-1470985', '1470985-TestAlbum');
  const meta1 = JSON.parse(fs.readFileSync(path.join(albumDir, 'metadata.json'), 'utf8'));
  assert.equal(meta1.pages, 3);
  assert.equal(meta1.pagesOk, 2);
  assert.equal(meta1.pagesFail, 1);
  assert.equal(meta1.incomplete, true);
  assert.equal(state.uploaded.length, 1);
  assert.equal(state.uploaded[0].name, 'JM1470985-TestAlbum（缺1页）.pdf');

  // 2) 第二次发送同一编号（第 2 页依然 404）→ 跳过好图仅请求 00002.png，无进展则直接重发旧残缺 PDF、不重复打包
  state.fetchedFiles = [];
  const beforePdfCount = state.pdfTasks.length;
  await tools.get('download_album').execute(ctx, { album_id: '1470985' });
  await until(() => state.uploaded.length === 2);
  assert.equal(state.pdfTasks.length, beforePdfCount, '补全无新增时不应重新打包 PDF');
  assert.equal(state.fetchedFiles.some((n) => n === '00001.png' || n === '00003.png'), false, '已存在的好图不得重下');
  assert.equal(state.fetchedFiles.includes('00002.png'), true);
  assert.equal(state.uploaded[1].name, 'JM1470985-TestAlbum（缺1页）.pdf');

  // 3) 第三次发送（第 2 页恢复可下）→ 只补下 00002.png，页序保持 1->2->3，按正常名出完整版并清理群内旧残缺文件
  state.failSecondPage = false;
  state.fetchedFiles = [];
  await tools.get('download_album').execute(ctx, { album_id: '1470985' });
  await until(() => state.uploaded.length === 3);
  assert.equal(state.fetchedFiles.some((n) => n === '00001.png' || n === '00003.png'), false, '已存在的好图不得重下');
  assert.deepEqual(state.fetchedFiles, ['00002.png']);
  const lastTaskPages = state.pdfTasks.at(-1).chapters[0].pages.map((p) => path.basename(p));
  assert.deepEqual(lastTaskPages, ['00001.png', '00002.png', '00003.png'], '补齐后的页序必须严格保持原序');
  assert.equal(state.uploaded[2].name, 'JM1470985-TestAlbum.pdf');
  assert.deepEqual(state.deletedFileIds, ['fid-1', 'fid-2'], '应自动删除群里所有带（缺N页）标记的旧文件');
  assert.deepEqual(state.groupFiles.map((f) => f.file_name), ['JM1470985-TestAlbum.pdf']);
  assert.equal(fs.existsSync(path.join(albumDir, 'JM1470985-TestAlbum（缺1页）.pdf')), false, '本地旧残缺PDF应已清理');
  assert.equal(fs.existsSync(path.join(albumDir, 'JM1470985-TestAlbum.pdf')), true);
  const meta3 = JSON.parse(fs.readFileSync(path.join(albumDir, 'metadata.json'), 'utf8'));
  assert.equal(meta3.incomplete, false);
  assert.equal(meta3.pagesOk, 3);
  assert.equal(meta3.pagesFail, 0);

  // 4) 第四次发送同一编号 → 完整版命中缓存，不请求网络、不重新打包
  state.fetchedFiles = [];
  const tasksAfterComplete = state.pdfTasks.length;
  await tools.get('download_album').execute(ctx, { album_id: '1470985' });
  await until(() => state.uploaded.length === 4);
  assert.deepEqual(state.fetchedFiles, []);
  assert.equal(state.pdfTasks.length, tasksAfterComplete);
  assert.equal(state.uploaded[3].name, 'JM1470985-TestAlbum.pdf');
});
