import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { registerHooks } from 'node:module';
import test from 'node:test';
import sharp from 'sharp';
import crypto from 'node:crypto';

const legacyUrl = new URL('../src/features/jm-suomingor/legacy-index.js', import.meta.url).href;
const dailyUrl = new URL('../src/features/jm-suomingor/daily_updates.mjs', import.meta.url).href;

const state = { cards: [] };
globalThis.__jmTranslateTest = state;

const engineStub = `export * from '${new URL('../src/features/jm-suomingor/engine.js', import.meta.url).href}';
  import * as base from '${new URL('../src/features/jm-suomingor/engine.js', import.meta.url).href}';
  export const createClient = opts => ({
    ...base.createClient(opts),
    albumInfo: async id => ({
      id,
      name: String(id) === '777002'
        ? 'テスト別タイトル'
        : String(id) === '777003'
          ? 'テスト第三弾'
          : 'テスト獵奇女僕裝項圈裡',
      series: [],
      authors: ['作者'],
      tags: ['獵奇'],
      description: '裡世界簡介',
    }),
    photoInfo: async id => ({ id, images: ['00001.png'] }),
    fetchScrambleId: async () => 0,
  });`;

const pdfStub = `import fs from 'node:fs';
  export const detect = () => ({ ok: true, python: 'mock' });
  export const runTask = async ({ task }) => {
    fs.writeFileSync(task.output, '%PDF-mock');
    return { ok: true, output: task.output, pages: 1, pagesOk: 1, restored: 0, bytes: 9, timings: {} };
  };`;

const dailyStub = `
  import fs from 'node:fs';
  import * as real from '${dailyUrl}';
  export const { collect, buildDigestFromState, sendDigest, loadDigestItems, sendDigestImage, cleanTitle, fetchSiteCover } = real;
  export const renderDigestImage = async () => '';
  export const renderAlbumImage = async ({ payload, outPath }) => {
    globalThis.__jmTranslateTest.cards.push(payload);
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

test('翻译优先读取全局 providerKeys 并生效 opencc-js，401 错误立即停止重试', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jm-translate-'));
  const downloadDir = path.join(dataDir, 'plugin-state', 'jm-suomingor');
  fs.mkdirSync(downloadDir, { recursive: true });
  t.after(() => {
    jm.dispose();
    delete globalThis.__jmTranslateTest;
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  const cfgPath = path.join(dataDir, 'config.json');
  fs.writeFileSync(cfgPath, JSON.stringify({
    api: {
      provider: 'custom_provider',
      baseUrl: 'https://mock-llm.local/v1',
      model: 'deepseek-flash',
      apiKey: 'old-invalid-3d45',
    },
    providerKeys: {
      custom_provider: 'valid-key-c260',
    },
  }));

  const llmAuths = [];
  const llmBodies = [];
  let llmMode = 'ok';
  const tools = new Map();
  const logs = [];
  const config = {
    enabled: true,
    dataDir,
    downloadDir,
    translateTitles: true,
    uploadMode: 'off',
    deleteImagesAfterPdf: false,
    keepHours: 12,
    restore: false,
  };

  jm.setup({
    config: () => config,
    registerTool: (tool) => tools.set(tool.id, tool),
    log: (line) => logs.push(line),
    warn: (line) => logs.push(line),
    fetch: async (url, opts = {}) => {
      if (String(url).endsWith('/chat/completions')) {
        llmAuths.push(opts.headers?.Authorization);
        const parsedBody = opts.body ? JSON.parse(opts.body) : {};
        llmBodies.push(parsedBody);
        if (llmMode === 'unauthorized') {
          return new Response(JSON.stringify({ error: { message: 'invalid key' } }), { status: 401 });
        }
        if (llmMode === 'reject-thinking' && parsedBody.thinking) {
          return new Response(JSON.stringify({ error: { message: 'unknown parameter: thinking' } }), { status: 400 });
        }
        return new Response(JSON.stringify({
          choices: [{ message: { content: '1|测试猎奇女仆装项圈里' } }],
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (String(url).includes('/media/albums/')) {
        return new Response(jpegBuf, { status: 200, headers: { 'content-type': 'image/jpeg' } });
      }
      return new Response(pngBuf, { status: 200, headers: { 'content-type': 'image/png' } });
    },
  });

  const ctx = {
    chatKey: 'group:100001',
    kind: 'group',
    onebot: { async sendSegments() {} },
    sender: { async sendTextBatch() {} },
  };

  // 1) 正常读取 providerKeys['custom_provider'] 与 opencc-js 繁转简，并注入关思考参数
  await tools.get('download_album').execute(ctx, { album_id: '777001' });
  await waitFor(() => state.cards.length === 1);
  assert.deepEqual(llmAuths, ['Bearer valid-key-c260']);
  assert.deepEqual(llmBodies[0].thinking, { type: 'disabled' });
  assert.equal(state.cards[0].title, '测试猎奇女仆装项圈里');
  assert.deepEqual(state.cards[0].tags, ['猎奇']);
  assert.equal(state.cards[0].desc, '里世界简介');

  // 2) HTTP 401 时只尝试 1 次即中止，不再白等 3 次重试
  llmMode = 'unauthorized';
  llmAuths.length = 0;
  fs.writeFileSync(cfgPath, JSON.stringify({
    api: {
      provider: 'custom_provider',
      baseUrl: 'https://mock-llm.local/v1',
      model: 'deepseek-flash',
      apiKey: 'old-invalid-3d45',
    },
    providerKeys: {
      custom_provider: 'bad-key',
    },
  }));
  await tools.get('download_album').execute(ctx, { album_id: '777002' });
  await waitFor(() => state.cards.length === 2);
  assert.equal(llmAuths.length, 1);
  assert.equal(state.cards[1].title, 'テスト别タイトル');
  assert.ok(logs.some((line) => line.includes('不重试，退回原文')));

  // 3) 若网关拒绝 thinking 参数返回 400，应自动剥离后重试成功
  llmMode = 'reject-thinking';
  llmBodies.length = 0;
  fs.writeFileSync(cfgPath, JSON.stringify({
    api: {
      provider: 'custom_provider',
      baseUrl: 'https://api.deepseek.com/v1',
      model: 'deepseek-flash',
    },
    providerKeys: {
      custom_provider: 'valid-key-c260',
    },
  }));
  await tools.get('download_album').execute(ctx, { album_id: '777003' });
  await waitFor(() => state.cards.length === 3);
  assert.equal(llmBodies.length, 2);
  assert.deepEqual(llmBodies[0].thinking, { type: 'disabled' });
  assert.equal(llmBodies[1].thinking, undefined);
});
