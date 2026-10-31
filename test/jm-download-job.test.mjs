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
const state = { pdf: [], options: [], names: [], id: '', mode: 'normal' };
globalThis.__jmDownloadTest = state;
const engineStub = `export * from '${new URL('../src/features/jm-suomingor/engine.js', import.meta.url).href}';
  export const createClient = opts => globalThis.__jmDownloadTest.client(opts);`;
const pdfStub = `import fs from 'node:fs'; export const detect = () => ({ ok: true, python: 'mock' });
  export const runTask = async ({ task }) => {
    globalThis.__jmDownloadTest.pdf.push(task);
    fs.writeFileSync(task.output, '%PDF-mock');
    return { ok: true, output: task.output, pages: task.chapters[0].pages.length, bytes: 9, timings: { restoreMs: 2, pdfWriteMs: 1 } };
  };`;
const dailyStub = `
  export const collect = () => {}, buildDigestFromState = () => {}, sendDigest = () => {}, loadDigestItems = () => [],
    renderDigestImage = () => {}, sendDigestImage = () => {}, cleanTitle = x => x, fetchSiteCover = async () => '';
  export const renderAlbumImage = async () => { throw new Error('mock card'); };`;
const hooks = registerHooks({ resolve(specifier, context, next) {
  if (context.parentURL === legacyUrl) {
    const stub = specifier === './engine.js' ? engineStub : specifier === './pdf.js' ? pdfStub : specifier === './daily_updates.mjs' ? dailyStub : null;
    if (stub) return { url: `data:text/javascript,${encodeURIComponent(stub)}`, shortCircuit: true };
  }
  return next(specifier, context);
} });
const jm = await import(legacyUrl);
hooks.deregister();
const image = await sharp(crypto.randomBytes(64 * 96 * 3), { raw: { width: 64, height: 96, channels: 3 } }).png().toBuffer();
const settle = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) {
  for (let i = 0; i < 500; i++) { const result = check(); if (result) return result; await settle(10); }
  assert.fail('JM task timed out');
}

test('真实任务调度读取最新并发、保持页序，记录阶段统计；暂停与删除不会遗漏或晚写文件', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jm-download-job-'));
  const tools = new Map();
  const logs = [];
  let config = { enabled: true, downloadDir: root, concurrency: 48, cdnStrategy: 'fixed', keepHours: 0,
    restore: false, translateTitles: false, outputFormat: 'pdf', uploadMode: 'off' };
  jm.setup({ config: () => config, registerTool: tool => tools.set(tool.id, tool),
    log: line => logs.push(line), warn: () => {}, fetch: async (url, opts) => state.fetch(url, opts) });
  t.after(() => { jm.dispose(); delete globalThis.__jmDownloadTest; fs.rmSync(root, { recursive: true, force: true }); });
  state.client = opts => {
    state.options.push({ concurrency: opts.concurrency, strategy: opts.cdnStrategy });
    const real = engine.createClient(opts);
    return { ...real, albumInfo: async id => ({ id, name: 'test', series: [], authors: [], tags: [] }),
      photoInfo: async id => ({ id, images: state.names }) };
  };
  const ctx = { chatKey: 'group:100001', kind: 'group', sender: { sendTextBatch: async () => {} } };
  const history = () => { try { return JSON.parse(fs.readFileSync(path.join(root, 'tasks.json'), 'utf8')); } catch { return []; } };
  let active = 0;
  let peak = 0;
  let calls = 0;
  state.fetch = async (url, opts) => {
    calls++; active++; peak = Math.max(peak, active);
    try {
      if (state.mode === 'cancel') await new Promise((resolve, reject) => opts.signal.addEventListener('abort', () => reject(opts.signal.reason), { once: true }));
      if (state.mode === 'pause' && calls === 1) await new Promise(resolve => { state.release = resolve; });
      await settle(url.includes('00000') ? 15 : 3);
      return new Response(image, { headers: { 'content-type': 'image/png' } });
    } finally { active--; }
  };
  for (const concurrency of [48, 1]) {
    const id = String(123400 + concurrency);
    config = { ...config, concurrency };
    state.names = Array.from({ length: 50 }, (_, i) => `${String(49 - i).padStart(5, '0')}.png`);
    calls = 0; peak = 0;
    await tools.get('download_album').execute(ctx, { album_id: id });
    await until(() => history().find(row => row.id === id));
    assert.equal(peak, concurrency);
    assert.equal(state.options.at(-1).concurrency, concurrency);
    const pages = state.pdf.at(-1).chapters[0].pages;
    assert.deepEqual(pages.map(file => path.basename(file)), state.names);
    assert.equal(pages.length, 50);
    for (const file of pages) assert.deepEqual(fs.readFileSync(file), image);
  }
  const downloadLog = JSON.parse(logs.find(line => line.startsWith('[jm-download] ')).slice(14));
  assert.equal(downloadLog.images, 50);
  assert.equal(downloadLog.success, 50);
  assert.equal(downloadLog.bytes, 50 * image.length);
  assert.equal(downloadLog.slowest.length, 5);
  assert.equal(downloadLog.actualConcurrency, 48);
  const stages = JSON.parse(logs.find(line => line.startsWith('[jm-performance] ')).slice(17));
  assert.equal(stages.restoreMs, 2);
  assert.equal(stages.pdfWriteMs, 1);
  assert.ok(stages.totalMs > 0);

  state.mode = 'pause'; calls = 0; state.names = ['00001.png', '00002.png'];
  await tools.get('download_album').execute(ctx, { album_id: '123499' });
  await until(() => state.release);
  await tools.get('control').execute(ctx, { album_id: '123499', action: 'pause' });
  state.release();
  await settle(60);
  assert.equal(calls, 1, '暂停后不能获取下一张图');
  await tools.get('control').execute(ctx, { album_id: '123499', action: 'resume' });
  await until(() => history().find(row => row.id === '123499'));
  assert.equal(calls, 2);

  state.mode = 'cancel'; calls = 0;
  await tools.get('download_album').execute(ctx, { album_id: '123498' });
  await until(() => active > 0);
  await tools.get('control').execute(ctx, { album_id: '123498', action: 'delete' });
  await until(() => history().find(row => row.id === '123498' && row.stage === 'deleted'));
  assert.equal(active, 0);
  await settle(40);
  assert.equal(fs.existsSync(path.join(root, 'jm-123498')), false, '删除后网络请求不能重新创建目录或图片');
});

test('宿主与 AsyncLocalStorage 桥接传递原始 Response 流，不先 arrayBuffer 整图缓冲', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jm-stream-host-'));
  const originalFetch = globalThis.fetch;
  globalThis.__jmDownloadTest = state;
  state.names = ['00001.png']; state.mode = 'normal';
  let requests = 0;
  globalThis.fetch = async (_url, opts) => {
    requests++;
    assert.equal(opts.responseType, undefined, '宿主必须移除内部 responseType 再调用 fetch');
    const response = new Response(image, { headers: { 'content-type': 'image/png' } });
    response.arrayBuffer = async () => { throw new Error('图片链路不能预先整图缓冲'); };
    return response;
  };
  const { initJmFeature } = await import('../src/features/jm-suomingor-host.js');
  const { builtinFeatureToolDefs } = await import('../src/features/feature-registry.js');
  const feature = initJmFeature({ dataDir: root, getConfig: () => ({ jm: { enabled: true,
    concurrency: 1, cdnStrategy: 'fixed', translateTitles: false, restore: false, keepHours: 0,
    outputFormat: 'pdf', uploadMode: 'off' } }),
    sender: { sendTextBatch: async (_key, messages) => ({ sent: messages.map(text => ({ text })), failed: [] }) }, log: () => {} });
  t.after(async () => {
    await feature.deactivate(); globalThis.fetch = originalFetch; delete globalThis.__jmDownloadTest;
    fs.rmSync(root, { recursive: true, force: true });
  });
  await builtinFeatureToolDefs().find(tool => tool.name === 'jm_download_album').execute(
    { chatKey: 'group:100001', kind: 'group', chatId: '100001' }, { album_id: '123497' });
  await until(() => {
    try { return JSON.parse(fs.readFileSync(path.join(root, 'plugin-state/jm-suomingor/tasks.json'), 'utf8')).find(row => row.id === '123497' && row.ok); }
    catch { return false; }
  });
  assert.equal(requests, 1);
  assert.deepEqual(fs.readFileSync(state.pdf.at(-1).chapters[0].pages[0]), image);
});
