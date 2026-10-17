import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { PixivManager } from '../src/features/pixiv/manager.js';
import { createPixivEngine } from '../src/features/pixiv/engine.js';
import { DEFAULT_PIXIV_CONFIG, pixivConfig, migratePixivConfig, validatePixivPatch } from '../src/features/pixiv/config.js';
import { pixivCommand } from '../src/features/pixiv/command.js';
import { installPixivRoutes } from '../src/features/pixiv/routes.js';
import { createRouter } from '../src/console/router.js';
import { builtinFeatureToolDefs, registerBuiltinFeature } from '../src/features/feature-registry.js';
import { sanitizeConfigSecrets } from '../src/core/secret-keys.js';
import { pixivFetch } from '../src/features/pixiv/network.js';
import { MockAgent } from 'undici';
import { describePlugins } from '../plugins/console-routes.js';
import { buildPixivPdf } from '../src/features/pixiv/pdf.js';
import { spawnSync } from 'node:child_process';

const png = Buffer.from('89504e470d0a1a0a00000000', 'hex');
const pid = '12345678';
function fixture(t, settings = {}, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-pixiv-'));
  const cfg = { pixiv: pixivConfig({ enabled: true, metadataUrlTemplate: 'https://www.pixiv.net/ajax/illust/{pid}', cooldownSeconds: 0, maxPages: 100, pagesPerBatch: 2, ...settings }), admin: { ownerUin: '111111' } };
  const requests = [], forwards = [], sends = [];
  const count = options.pages || 5;
  const urls = (page) => ({ regular: `https://img.test/${pid}-${page}.png` });
  const fetchImpl = async (url, init) => {
    const value = String(url); requests.push({ url: value, init });
    if (options.fetchImpl) return options.fetchImpl(value, init);
    if (value.endsWith('/pages')) return Response.json({ body: Array.from({ length: count }, (_, i) => ({ urls: urls(i + 1) })) });
    if (value.includes('/ajax/illust/')) return Response.json({ body: { id: pid, xRestrict: options.restriction ?? 0, pageCount: count, title: '测试作品', userName: '作者', urls: urls(1) } });
    if (options.missing?.some((p) => value.includes(`-${p}.png`))) return new Response('', { status: 404 });
    return new Response(png, { headers: { 'content-type': 'image/png' } });
  };
  const updateConfig = (patch) => {
    const p = patch.pixiv;
    cfg.pixiv = { ...cfg.pixiv, ...p, ...(p.chatRatings ? { chatRatings: p.chatRatings.__replace__ || p.chatRatings } : {}) };
  };
  const manager = new PixivManager({ dataDir: dir, getConfig: () => cfg, updateConfig, canRun: () => options.allowed !== false,
    onebot: { selfId: '999999' }, fetchImpl, forward: async (...args) => { forwards.push(args); return options.forward?.(...args); },
    send: async (...args) => sends.push(args), ...options.host });
  t.after(async () => { await manager.stop(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { manager, cfg, dir, requests, forwards, sends, updateConfig };
}
const pageNames = (f) => f.forwards.flatMap((r) => r[1].nodes.slice(1).map((n) => n.data.name));

test('新实例默认关闭；旧插件启用与配置迁入宿主，不保留插件启用状态', () => {
  assert.equal(DEFAULT_PIXIV_CONFIG.enabled, false);
  const c = { plugins: { enabled: ['pixiv-illust', 'other'], settings: { 'pixiv-illust': { imageSize: 'small', ratings: ['safe'], maxPages: 20, cookie: 'private' } } } };
  migratePixivConfig(c);
  assert.equal(c.pixiv.enabled, true); assert.equal(c.pixiv.imageSize, 'small'); assert.equal(c.pixiv.cookie, 'private');
  assert.deepEqual(c.plugins.enabled, ['other']); assert.equal(c.plugins.settings['pixiv-illust'].cookie, 'private');
  c.pixiv.enabled = false; migratePixivConfig(c); assert.equal(c.pixiv.enabled, false);
});
test('默认PID链路不依赖pixiv.net直连；保留pixiv.re模板与小尺寸推导', async (t) => {
  const f = fixture(t, { metadataUrlTemplate: '' });
  const engine = createPixivEngine({ stateDir: f.manager.stateDir, getSettings: () => f.cfg.pixiv });
  assert.equal(engine.settings().imageUrlTemplate, 'https://pixiv.re/{pid}.png');
  assert.equal(engine.pageUrlsOf({ imageUrl: `https://pixiv.re/${pid}-1.png` }, 2)[0], `https://pixiv.re/${pid}-3.png`);
  const originalFetch = f.manager.options.fetchImpl; delete f.manager.options.fetchImpl;
  assert.deepEqual(await f.manager.detail(pid, new AbortController().signal), { pid });
  assert.equal(f.requests.length, 0); f.manager.options.fetchImpl = originalFetch;
});

test('可选官方代理范围：官网详情和原图走代理，国内图床和关键词仍直连', async (t) => {
  const f = fixture(t, { proxyUrl: 'http://127.0.0.1:3222', proxyScope: 'official' }, { fetchImpl: async () => Response.json({ ok: true }) });
  for (const url of ['https://www.pixiv.net/ajax/illust/12345678', 'https://i.pximg.net/image.jpg', 'https://pixiv.re/12345678.png', 'https://api.lolicon.app/setu/v2']) await f.manager.engine.requestJson(url);
  assert.deepEqual(f.requests.map((r) => Boolean(r.init.dispatcher)), [true, true, false, false]);
  assert.throws(() => validatePixivPatch({ proxyScope: 'invalid' }));
});

test('参考原插件PID入口：临时500有限重试，成功后按X-Origin-URL直接续页，不重复解析PID', async (t) => {
  let attempts = 0;
  const f = fixture(t, { metadataUrlTemplate: '', ratings: ['r18', 'r18g'], unknownRatingPolicy: 'adult-only', maxPages: 3 }, {
    fetchImpl: async (url, init) => {
      if (init.redirect === 'manual') return new Response('', { status: 301, headers: { location: `/${pid}-1.png` } });
      if (url === `https://pixiv.re/${pid}.png`) {
        if (++attempts === 1) return new Response('', { status: 500 });
        return new Response(png, { headers: { 'content-type': 'image/png', 'x-origin-url': `https://i.pximg.net/img-original/img/2026/10/03/21/44/15/${pid}_p0.jpg` } });
      }
      assert.match(url, new RegExp(`^https://i\\.pixiv\\.re/img-master/img/2026/10/03/21/44/15/${pid}_p[12]_master1200\\.jpg$`));
      return new Response(png, { headers: { 'content-type': 'image/png' } });
    }
  });
  const result = await f.manager.start({ pid }, 'group:100001', 'origin-header');
  assert.equal(result.isError, undefined, result.content); assert.equal(attempts, 2);
  assert.deepEqual(pageNames(f), ['第 1 页', '第 2 页', '第 3 页']);
  assert.equal(f.requests.filter((r) => r.url.startsWith('https://i.pixiv.re/')).length, 2);
});

test('X-Origin-URL不信任任意域名、凭据或不同作品和页号；404不作为临时错误重试', async (t) => {
  for (const source of ['https://127.0.0.1/a.png',
    `https://evil.test/img-original/img/2026/10/03/21/44/15/${pid}_p0.jpg`,
    `https://u:secret@i.pximg.net/img-original/img/2026/10/03/21/44/15/${pid}_p0.jpg`,
    'https://i.pximg.net/img-original/img/2026/10/03/21/44/15/98765432_p0.jpg',
    `https://i.pximg.net/img-original/img/2026/10/03/21/44/15/${pid}_p1.jpg`]) {
    const f = fixture(t, {}, { fetchImpl: async () => new Response(png, { headers: { 'x-origin-url': source } }) });
    const got = await f.manager.engine.fetchImage({ pid }, f.manager.engine.settings());
    assert.equal(got.url, `https://pixiv.re/${pid}.png`);
  }
  const f = fixture(t, { pageRetryOnce: 2 }, { fetchImpl: async () => new Response('', { status: 404 }) });
  await assert.rejects(f.manager.engine.fetchImage({ pid, imageUrls: ['https://img.test/page.png'] }, f.manager.engine.settings(), { allowTemplate: false }));
  assert.equal(f.requests.length, 1);
  assert.equal(f.manager.engine.isTransientFetchError({ status: 403 }), false);
  assert.equal(f.manager.engine.isTransientFetchError({ status: 429 }), false);
});

test('公开data详情格式取得真实路径，Yuki图片改用既有反代，缺少分级绝不默认为safe', async (t) => {
  const f = fixture(t, { metadataUrlTemplate: 'https://pixiv.yuki.sh/api/illust?id={pid}', maxPdfPages: 1 }, {
    host: pdfHost({}),
    fetchImpl: async (url) => {
      if (url.includes('pixiv.yuki.sh/api/illust')) return Response.json({ success: true, data: {
        id: pid, title: '旧作品', user: { name: '作者' }, tags: [],
        urls: { regular: `https://pixiv.yuki.sh/image/img-master/img/2011/02/20/01/05/18/${pid}_p0_master1200.jpg` }
      } });
      assert.equal(new URL(url).hostname, 'i.pixiv.re');
      return new Response(png, { headers: { 'content-type': 'image/png' } });
    }
  });
  const item = await f.manager.detail(pid, new AbortController().signal);
  assert.equal(item.title, '旧作品'); assert.equal(item.author, '作者');
  assert.equal(f.manager.engine.ratingKnown(item), false);
  assert.equal(item.imageUrls[0], `https://i.pixiv.re/img-master/img/2011/02/20/01/05/18/${pid}_p0_master1200.jpg`);
  assert.throws(() => f.manager.checkRating(item, 'group:100001'), /无法确认/);
  assert.equal(f.manager.metadata[pid], undefined);
  f.manager.setRating(pid, 'safe');
  const result = await f.manager.start({ pid, outputFormat: 'pdf' }, 'group:100001', 'real-path');
  assert.equal(result.isError, undefined, result.content);
  assert.ok(f.requests.some((r) => r.url.startsWith('https://i.pixiv.re/')));
  assert.equal(f.requests.some((r) => r.url === `https://pixiv.re/${pid}.png`), false);
});
test('设置校验拒绝坏分级、空分级、超量和未知字段', () => {
  for (const patch of [{ ratings: [] }, { ratings: ['unknown'] }, { enabled: 'yes' }, { maxPages: 101 }, { pagesPerBatch: 21 }, { chatRatings: { 'group:abc': ['safe'] } }, { cookie: 'a\nb' }, { metadataUrlTemplate: 'http://user:pass@host/{pid}' }, { unknown: true }]) assert.throws(() => validatePixivPatch(patch));
  validatePixivPatch({ chatRatings: { __replace__: {} }, metadataUrlTemplate: 'https://api.example/illust/{pid}' });
});
test('PID 明确指令识别与页范围；不吞普通数字或聊天', () => {
  assert.deepEqual(pixivCommand('PID 12345678 21-40'), { pid, startPage: 21, endPage: 40 });
  assert.equal(pixivCommand(`https://www.pixiv.net/artworks/${pid}`).pid, pid);
  for (const input of [pid, '我的QQ是12345678', '帮我看看pid是什么', 'https://evil.test/artworks/12345678']) assert.equal(pixivCommand(input), null);
});

test('PDF明确指令支持范围和作品链接；图片可覆盖默认方式', () => {
  assert.deepEqual(pixivCommand(`PID ${pid} 21-40 PDF`), { pid, startPage: 21, endPage: 40, outputFormat: 'pdf' });
  assert.equal(pixivCommand(`https://www.pixiv.net/artworks/${pid} PDF`).outputFormat, 'pdf');
  assert.equal(pixivCommand(`PID ${pid} 图片`).outputFormat, 'images');
  assert.equal(pixivCommand('请做一个 PDF'), null);
});

function pdfHost(captured, extra = {}) {
  return {
    buildPdf: async ({ files, output, signal }) => {
      signal.throwIfAborted();
      captured.inputs = files.map((p) => ({ page: p.page, bytes: fs.statSync(p.file).size }));
      fs.writeFileSync(output, '%PDF-1.4\nmock');
      return { file: output, pages: files.map((p) => p.page), bytes: 13 };
    },
    file: async (_chat, file) => { captured.uploads = (captured.uploads || 0) + 1; captured.name = file.name; captured.file = file.file; assert.ok(fs.existsSync(file.file)); },
    ...extra
  };
}

test('PDF独立页数上限超过卡片20页且有序打包，不发送任何图片卡片', async (t) => {
  const captured = {};
  const f = fixture(t, { maxPages: 20, outputFormat: 'pdf' }, { pages: 25, host: pdfHost(captured) });
  const result = await f.manager.start({ pid }, 'group:100001', 'pdf');
  assert.equal(result.isError, undefined, result.content);
  assert.equal(captured.uploads, 1); assert.equal(captured.inputs.length, 25);
  assert.deepEqual(captured.inputs.map((p) => p.page), Array.from({ length: 25 }, (_, i) => i + 1));
  assert.equal(f.forwards.length, 0); assert.doesNotMatch(captured.name, /部分/);
  assert.equal(f.manager.history.at(-1).status, 'done');
  assert.match(f.sends.at(-1)[1][0], /分级：safe/);
  assert.match(f.sends[0][1][0], /开始处理 PID/);
  assert.match(f.sends[1][1][0], /下载完成.*正在排队合成 PDF/);
  assert.match(f.sends[2][1][0], /PDF 已生成.*上传群文件/);
  assert.doesNotMatch(f.sends.at(-1)[1][0], /包含：|1、2|第\s*\d+\s*页/);
  assert.equal(fs.existsSync(captured.file), false);
});

test('PDF缺页后仍保留后续页并标注部分，不把页码压缩成完整作品', async (t) => {
  const captured = {};
  const f = fixture(t, {}, { missing: [3], host: pdfHost(captured) });
  await f.manager.start({ pid, outputFormat: 'pdf' }, 'group:100001', 'partial-pdf');
  assert.deepEqual(captured.inputs.map((p) => p.page), [1, 2, 4, 5]);
  assert.match(captured.name, /部分/); assert.equal(f.manager.history.at(-1).status, 'partial');
  assert.match(f.sends.at(-1)[1][0], /1 张未取到/);
  assert.doesNotMatch(f.sends.at(-1)[1][0], /第3页|包含：/);
});

test('PDF总量限制停止下载并发送部分文件；分级拦截不会下载或生成', async (t) => {
  const captured = {};
  const f = fixture(t, { pdfMaxBytes: png.length * 2 }, { host: pdfHost(captured) });
  await f.manager.start({ pid, outputFormat: 'pdf' }, 'group:100001', 'limited-pdf');
  assert.deepEqual(captured.inputs.map((p) => p.page), [1, 2]); assert.match(captured.name, /部分/);
  assert.match(f.sends.at(-1)[1][0], /文件大小上限/);
  const denied = {};
  const g = fixture(t, {}, { restriction: 1, host: pdfHost(denied) });
  assert.equal((await g.manager.start({ pid, outputFormat: 'pdf' }, 'group:100001', 'denied-pdf')).isError, true);
  assert.equal(denied.inputs, undefined); assert.equal(denied.uploads, undefined);
});

test('PDF上传未确认只调用一次，不回退卡片或文本；保留文件供协议端读取', async (t) => {
  const captured = {};
  const f = fixture(t, {}, { host: pdfHost(captured, { file: async (_chat, payload) => {
    captured.uploads = (captured.uploads || 0) + 1; captured.file = payload.file; throw new Error('timeout');
  } }) });
  const result = await f.manager.start({ pid, outputFormat: 'pdf' }, 'group:100001', 'unknown-pdf');
  assert.equal(result.sendUnknown, true); assert.equal(captured.uploads, 1);
  assert.equal(f.forwards.length, 0); assert.equal(f.sends.length, 3);
  assert.doesNotMatch(f.sends.at(-1)[1][0], /✅|已上传到本群/);
  assert.equal(f.manager.history.at(-1).status, 'send-unknown'); assert.ok(fs.existsSync(captured.file));
});

test('PDF生成取消后不上传，临时目录清理', async (t) => {
  const captured = {};
  let f;
  f = fixture(t, {}, { host: pdfHost(captured, { buildPdf: async ({ signal }) => {
    f.manager.active.controller.abort(); signal.throwIfAborted();
  } }) });
  const result = await f.manager.start({ pid, outputFormat: 'pdf' }, 'group:100001', 'cancel-pdf');
  assert.equal(result.isError, true); assert.equal(captured.uploads, undefined);
  assert.deepEqual(fs.readdirSync(path.join(f.dir, 'pixiv', 'pdf')), []);
});

test('开始提示未确认时不启动下载、不继续提示或发送文件', async (t) => {
  let calls = 0;
  const f = fixture(t, {}, { host: { file: async () => assert.fail('不应上传'), send: async () => { calls++; throw new Error('timeout'); } } });
  const result = await f.manager.start({ pid, outputFormat: 'pdf' }, 'group:100001', 'unknown-start');
  assert.equal(result.sendUnknown, true);
  assert.equal(calls, 1); assert.equal(f.requests.length, 0); assert.equal(f.forwards.length, 0);
});

test('群聊和私聊分别报告HTTP500、超时及超限，不把下载失败说成分级或白名单问题', async (t) => {
  for (const chat of ['group:100001', 'private:100001']) {
    for (const [error, expected] of [
      [Object.assign(new Error('upstream https://host.test/?token=private-secret'), { status: 500 }), /图片接口暂时异常（HTTP 500）/],
      [Object.assign(new Error('请求超时'), { netError: true }), /图片下载超时/],
      [Object.assign(new Error('too big'), { tooBig: true }), /超过单张下载上限/]
    ]) {
      let uploaded = false;
      const f = fixture(t, {}, { host: { file: async () => { uploaded = true; } } });
      f.manager.engine.fetchImage = async () => { throw error; };
      const result = await f.manager.start({ pid, outputFormat: 'pdf' }, chat, 'diagnostic');
      assert.equal(result.isError, true); assert.match(result.content, expected);
      assert.doesNotMatch(result.content, /检查作品分级|白名单|private-secret/);
      assert.equal(uploaded, false); assert.equal(f.sends.length, 1);
      assert.match(f.manager.history[0].failedPages[0].reason, expected);
      assert.equal(f.manager.history[0].error, result.content);
      assert.doesNotMatch(fs.readFileSync(path.join(f.dir, 'pixiv', 'history.json'), 'utf8'), /private-secret/);
    }
  }
});

test('总页数未知且首页404时记录真实失败原因，不把后续页探测404当成缺页', async (t) => {
  const f = fixture(t, { metadataUrlTemplate: '' }, { host: { file: async () => assert.fail('不应上传') } });
  f.manager.setRating(pid, 'safe');
  f.manager.engine.fetchImage = async () => { throw Object.assign(new Error('HTTP 404'), { status: 404 }); };
  const result = await f.manager.start({ pid, outputFormat: 'pdf' }, 'group:100001', 'missing-first');
  assert.match(result.content, /HTTP 404/); assert.match(result.content, /不能据此确认作品已删除/);
  assert.equal(f.manager.history[0].failedPages[0].status, 404);
});

test('私聊PDF按阶段提示，最终不枚举页码；上传前提示失败不上传', async (t) => {
  const captured = {}, stages = [];
  const host = pdfHost(captured);
  const f = fixture(t, {}, { host: { ...host,
    send: async (_chat, messages) => stages.push(messages[0]),
    buildPdf: async (options) => { stages.push('生成文件'); return host.buildPdf(options); },
    file: async (...args) => { stages.push('发送文件'); return host.file(...args); }
  } });
  await f.manager.start({ pid, outputFormat: 'pdf' }, 'private:100001', 'private-pdf');
  assert.match(stages[0], /开始处理/); assert.match(stages[1], /下载完成/);
  assert.equal(stages[2], '生成文件'); assert.match(stages[3], /正在发送私聊文件/);
  assert.equal(stages[4], '发送文件'); assert.match(stages[5], /✅.*处理完成/);
  assert.doesNotMatch(stages[5], /包含：|第\s*\d+\s*页|1、2/);
  let uploads = 0;
  const g = fixture(t, {}, { host: { ...pdfHost({}), file: async () => { uploads++; },
    send: async (_chat, messages) => { if (messages[0].includes('PDF 已生成')) throw new Error('timeout'); }
  } });
  assert.equal((await g.manager.start({ pid, outputFormat: 'pdf' }, 'group:100001', 'pre-upload')).sendUnknown, true);
  assert.equal(uploads, 0);
});

const pdfPython = process.platform === 'win32' ? 'python' : 'python3';
const hasPillow = spawnSync(pdfPython, ['-c', 'from PIL import Image'], { timeout: 10000 }).status === 0;
test('真实逐页PDF包含所有页面；坏图片拒绝上传；PDF超限拒绝', { skip: !hasPillow && 'Pillow unavailable' }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pixiv-pdf-worker-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const image = path.join(dir, 'input.png');
  const generated = spawnSync(pdfPython, ['-c', 'from PIL import Image; import sys; Image.new("RGB", (800, 1200), (80, 140, 210)).save(sys.argv[1])', image]);
  assert.equal(generated.status, 0);
  const files = [1, 2, 4].map((page) => ({ page, file: image }));
  const options = { files, output: path.join(dir, 'result.pdf'), signal: new AbortController().signal, maxBytes: 10485760, pythonPath: pdfPython };
  const result = await buildPixivPdf(options);
  assert.deepEqual(result.pages, [1, 2, 4]);
  assert.match(fs.readFileSync(result.file, 'latin1'), /\/Count 3/);
  await assert.rejects(buildPixivPdf({ ...options, maxBytes: 1 }), /文件大小上限/);
  const bad = path.join(dir, 'bad.png'); fs.writeFileSync(bad, Buffer.alloc(1024));
  await assert.rejects(buildPixivPdf({ ...options, files: [files[0], { page: 2, file: bad }] }), /未上传/);
});
test('旧去重与会话分级仅复制，原件保留，已有新文件不覆盖', async (t) => {
  const f = fixture(t);
  const old = path.join(f.dir, 'plugin-state', 'pixiv-illust'); fs.mkdirSync(old, { recursive: true });
  fs.writeFileSync(path.join(old, 'state.json'), JSON.stringify({ seen: { [pid]: Date.now() }, dead: {} }));
  fs.writeFileSync(path.join(old, 'chat-ratings.json'), JSON.stringify({ 'group:100001': ['r18'] }));
  f.manager.migrateState(); assert.deepEqual(f.manager.ratings('group:100001'), ['r18']);
  assert.equal(f.manager.engine.seenSet().has(pid), true);
  fs.writeFileSync(path.join(old, 'chat-ratings.json'), '{}'); f.manager.migrateState();
  assert.deepEqual(f.manager.ratings('group:100001'), ['r18']); assert.ok(fs.existsSync(path.join(old, 'state.json')));
});
test('插件中心也忽略已迁入宿主的旧Pixiv目录，不删除目录或状态', (t) => {
  const f = fixture(t); const root = path.join(f.dir, 'old-plugins'); const plugin = path.join(root, 'pixiv-illust');
  fs.mkdirSync(plugin, { recursive: true }); fs.writeFileSync(path.join(plugin, 'plugin.json'), '{}');
  const result = describePlugins({ dataDir: f.dir, config: { plugins: { enabled: ['pixiv-illust'], roots: [root] } } });
  assert.equal(result.plugins.some((p) => p.id === 'pixiv-illust'), false);
  assert.ok(fs.existsSync(path.join(plugin, 'plugin.json')));
});
test('关闭时不创建状态目录，不下载，不发送，且与JM工具表互不覆盖', async (t) => {
  registerBuiltinFeature({ toolDefs: [{ name: 'jm_test', execute() {} }] });
  const f = fixture(t, { enabled: false });
  assert.equal((await f.manager.start({ pid }, 'group:100001', 1)).isError, true);
  assert.equal(fs.existsSync(f.manager.dir), false); assert.equal(f.requests.length, 0);
  assert.ok(builtinFeatureToolDefs().some((d) => d.name === 'jm_test'));
  assert.ok(builtinFeatureToolDefs().some((d) => d.name === 'pixiv_image'));
  registerBuiltinFeature({ toolDefs: [] }); assert.ok(builtinFeatureToolDefs().some((d) => d.name === 'pixiv_image'));
});
test('分级字段缺失、非法、空值或仅sl不得被误认成全年龄', (t) => {
  const f = fixture(t);
  for (const raw of [{ id: pid }, { id: pid, xRestrict: 'bad' }, { id: pid, xRestrict: '' }, { id: pid, xRestrict: false }, { id: pid, sl: 0 }, { id: pid, r18: 2 }]) assert.equal(f.manager.engine.ratingKnown(f.manager.engine.normalizeItem(raw)), false);
  assert.equal(f.manager.engine.ratingKnown(f.manager.engine.normalizeItem({ id: pid, xRestrict: 0 })), true);
  assert.equal(f.manager.engine.ratingOf(f.manager.engine.normalizeItem({ id: pid, xRestrict: 0, tags: ['R-18G'] })), 2);
});
test('关闭图片压缩时保持原文件，不尝试调用ffmpeg', async (t) => {
  const f = fixture(t); const file = path.join(f.dir, 'image.png'); fs.writeFileSync(file, png);
  const result = await f.manager.engine.downsampleToJpeg(file, { overBytes: 0, ffmpegPath: '/not-installed/ffmpeg' });
  assert.deepEqual(result, { file, bytes: png.length, downsized: false });
});
test('查明分级后按会话过滤，不因点名PID绕过；成人档区分R18与R18G', async (t) => {
  const f = fixture(t, { ratings: ['safe', 'r18'] }, { restriction: 2 });
  const result = await f.manager.start({ pid }, 'group:100001', 1);
  assert.equal(result.isError, true); assert.match(result.content, /r18g/); assert.equal(f.forwards.length, 0);
});
test('未知分级默认拒绝；人工核实只影响该PID，仍受会话过滤', async (t) => {
  const f = fixture(t, {}, { fetchImpl: async () => { throw new Error('offline'); } });
  assert.match((await f.manager.start({ pid }, 'group:100001', 1)).content, /无法确认/);
  f.manager.setRating(pid, 'r18'); assert.throws(() => f.manager.checkRating({ pid }, 'group:100001'), /不允许/);
  f.manager.setRating(pid, 'safe'); assert.match(f.manager.checkRating({ pid }, 'group:100001'), /管理员标记/);
  assert.throws(() => f.manager.checkRating({ pid: '98765432' }, 'group:100001'), /无法确认/);
});
test('未知分级兼容策略仅在明确允许R18及R18G时生效，绝不当safe', (t) => {
  const f = fixture(t, { unknownRatingPolicy: 'adult-only', ratings: ['r18'] });
  assert.throws(() => f.manager.checkRating({ pid }, 'group:100001'));
  f.cfg.pixiv.ratings = ['r18', 'r18g']; assert.match(f.manager.checkRating({ pid }, 'group:100001'), /未知分级/);
});
test('读取真实页列表：五页按2+2+1分批，顺序完整且不重复首页', async (t) => {
  const f = fixture(t);
  assert.equal((await f.manager.start({ pid }, 'group:100001', 1)).isError, undefined);
  assert.equal(f.forwards.length, 3); assert.deepEqual(pageNames(f), ['第 1 页', '第 2 页', '第 3 页', '第 4 页', '第 5 页']);
  assert.equal(f.manager.history[0].status, 'done'); assert.match(f.sends[0][1][0], /开始处理/);
  assert.match(f.sends.at(-1)[1][0], /✅.*已发送 5 张图片/);
  assert.equal(f.requests.filter((r) => r.url.includes('/pages')).length, 1);
});
test('无官方详情时沿用pixiv.re直取、多页后缀及未知分级标记，不请求pixiv.net', async (t) => {
  const f = fixture(t, { metadataUrlTemplate: '', ratings: ['r18', 'r18g'], unknownRatingPolicy: 'adult-only', maxPages: 5, pageRetryOnce: 0 }, {
    fetchImpl: async (url, init) => {
      assert.equal(new URL(url).hostname, 'pixiv.re');
      if (init.redirect === 'manual') return new Response('', { status: 301, headers: { location: `https://pixiv.re/${pid}-1.png` } });
      if (url.includes('-3.png')) return new Response('', { status: 404 });
      return new Response(png, { headers: { 'content-type': 'image/png' } });
    }
  });
  await f.manager.start({ pid }, 'group:100001', 1);
  assert.deepEqual(pageNames(f), ['第 1 页', '第 2 页']);
  assert.match(f.forwards[0][1].nodes[0].data.content[0].data.text, /未知分级/);
  assert.match(f.manager.history[0].note, /未知总页数/);
});
test('批次按图片总大小收手再继续下载，不因单卡预算截掉后续页', async (t) => {
  const large = Buffer.concat([png, Buffer.alloc(180 * 1024)]);
  const f = fixture(t, { forwardBudgetBytes: 256 * 1024, pagesPerBatch: 10 });
  const original = f.manager.engine.fetchImage;
  f.manager.engine.fetchImage = async (...args) => {
    const got = await original(...args); fs.writeFileSync(got.file, large); return { ...got, bytes: large.length };
  };
  await f.manager.start({ pid }, 'group:100001', 1);
  assert.equal(f.forwards.length, 5);
  assert.deepEqual(pageNames(f), ['第 1 页', '第 2 页', '第 3 页', '第 4 页', '第 5 页']);
});
test('已知页数中间缺页，继续发送后续页并明确缺页，非整作失败', async (t) => {
  const f = fixture(t, { pageRetryOnce: 0 }, { missing: [3] });
  await f.manager.start({ pid }, 'group:100001', 1);
  assert.deepEqual(pageNames(f), ['第 1 页', '第 2 页', '第 4 页', '第 5 页']);
  assert.deepEqual(f.manager.history[0].failedPages.map((p) => p.page), [3]); assert.match(f.sends.at(-1)[1][0], /1 张未取到/);
});
test('指定页范围只取所需页，超出每次上限明确拒绝', async (t) => {
  const f = fixture(t, { maxPages: 3 });
  await f.manager.start({ pid, startPage: 3, endPage: 5 }, 'group:100001', 1);
  assert.deepEqual(pageNames(f), ['第 3 页', '第 4 页', '第 5 页']);
  assert.match((await f.manager.start({ pid, startPage: 1, endPage: 5 }, 'group:100001', 2)).content, /页码无效/);
});
test('发送未确认立即停止剩余批次，不逐张回退、不补发文字', async (t) => {
  const f = fixture(t, {}, { forward: async () => { throw new Error('timeout after remote received'); } });
  const result = await f.manager.start({ pid }, 'group:100001', 1);
  assert.equal(result.sendUnknown, true); assert.equal(f.forwards.length, 1); assert.equal(f.sends.length, 1);
  assert.equal(f.manager.history[0].status, 'send-unknown');
});
test('功能关闭或宿主权限撤销取消任务，后续不发送', async (t) => {
  let started;
  const ready = new Promise((resolve) => { started = resolve; });
  const f = fixture(t, {}, { fetchImpl: async (_url, init) => { started(); await new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })); } });
  const task = f.manager.start({ pid }, 'group:100001', 1); await ready;
  f.cfg.pixiv.enabled = false; f.manager.enforce(); await task;
  assert.equal(f.manager.history[0].status, 'cancelled'); assert.equal(f.forwards.length, 0);
});
test('同时仅执行一个任务，忙碌拒绝不创建第二个网络请求', async (t) => {
  const f = fixture(t);
  const first = f.manager.start({ pid }, 'group:100001', 1);
  assert.match((await f.manager.start({ pid }, 'group:100001', 2)).content, /正忙/); await first;
});
test('分级缓存可用于下一次PID直取；任务历史不写图片或Cookie', async (t) => {
  const f = fixture(t, { cookie: 'PRIVATE_COOKIE' });
  await f.manager.start({ pid }, 'group:100001', 1); const count = f.requests.filter((r) => r.url.includes('/ajax/')).length;
  await f.manager.start({ pid }, 'group:100001', 2);
  assert.equal(f.requests.filter((r) => r.url.includes('/ajax/')).length, count);
  const history = fs.readFileSync(path.join(f.manager.dir, 'history.json'), 'utf8'); assert.doesNotMatch(history, /base64|PRIVATE_COOKIE/);
  assert.equal(f.manager.snapshot().settings.cookie, undefined);
  assert.equal(sanitizeConfigSecrets({ pixiv: { cookie: 'SECRET', proxyUrl: 'SECRET_PROXY' } }).pixiv.proxyUrl, undefined);
});
test('分级工具读任何会话只限本会话，修改只认可信触发者的全局管理员身份', async (t) => {
  const f = fixture(t);
  const tool = f.manager.toolDefs().find((d) => d.name === 'pixiv_set_rating');
  const ctx = { chatKey: 'group:100001', triggerEntries: [{ senderId: '222222', self: false }] };
  assert.equal((await tool.execute(ctx, { action: 'set', ratings: ['r18'] })).isError, true);
  ctx.triggerEntries[0].senderId = '111111'; await tool.execute(ctx, { action: 'set', ratings: ['r18'] });
  assert.deepEqual(f.manager.ratings('group:100001'), ['r18']); assert.deepEqual(f.manager.ratings('group:100002'), ['safe']);
});
test('下载公共地址防护拒绝内网、凭据与非HTTP，不接入任何搜图中转', async () => {
  for (const url of ['http://127.0.0.1/', 'http://169.254.169.254/', 'file:///etc/passwd', 'https://user:pass@example.com/']) await assert.rejects(pixivFetch(url));
});
test('网络层fetch与dispatcher使用同一undici版本，保留状态及图片响应', async (t) => {
  const dispatcher = new MockAgent(); dispatcher.disableNetConnect();
  t.after(() => dispatcher.close());
  dispatcher.get('https://8.8.8.8').intercept({ path: '/image' }).reply(200, png, { headers: { 'content-type': 'image/png' } });
  const response = await pixivFetch('https://8.8.8.8/image', { dispatcher });
  assert.equal(response.status, 200); assert.deepEqual(Buffer.from(await response.arrayBuffer()), png);
});
test('真实API复用鉴权，清空会话覆盖不复活旧名单，密码留空不覆盖', async (t) => {
  const f = fixture(t, { cookie: 'saved' });
  const json = (res, code, data) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };
  const router = createRouter({ authorize: (req) => req.headers['x-test'] === 'yes', json });
  installPixivRoutes({ addRoute: (...args) => router.add(...args), updateConfig: f.updateConfig }, f.manager);
  const server = http.createServer((req, res) => router.handle(req, res));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(`${base}/api/pixiv`)).status, 401);
  const headers = { 'x-test': 'yes', 'content-type': 'application/json' };
  assert.equal((await fetch(`${base}/api/pixiv/settings`, { method: 'POST', headers, body: JSON.stringify({ chatRatings: {} }) })).status, 200);
  assert.equal(f.cfg.pixiv.chatRatingsMigrated, true); assert.equal(f.cfg.pixiv.cookie, 'saved');
  const result = await fetch(`${base}/api/pixiv/rating`, { method: 'POST', headers, body: JSON.stringify({ pid, rating: 'safe' }) });
  assert.equal(result.status, 200); assert.equal(f.manager.overrides[pid].rating, 'safe');
});
