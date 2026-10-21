import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { imageSearchConfig, validateImageSearchPatch, validateRelayUrl } from '../src/features/image-search/config.js';
import { imageSearchCommand, searchSegments } from '../src/features/image-search/command.js';
import { boundedBody, formatFindReply, formatSearchReply } from '../src/features/image-search/common.js';
import { parseYandex, parseTrace, searchProvider, providerRequest } from '../src/features/image-search/providers.js';
import { googleResultRows, googleLens } from '../src/features/image-search/google.js';
import { parseSerpApiRows, prepareSerpApiImage, serpApiLens } from '../src/features/image-search/serpapi.js';
import { ImageSearchManager } from '../src/features/image-search/manager.js';
import { createImageSearchRelay } from '../src/features/image-search/relay.js';
import { installImageSearchRoutes } from '../src/features/image-search/routes.js';
import { createRouter } from '../src/console/router.js';
import { sanitizeConfigSecrets } from '../src/core/secret-keys.js';
import { safeFetchPublicBinary } from '../src/llm/safe-fetch.js';
import { searchResultNodes } from '../src/features/image-search/result-images.js';

const png = Buffer.from('89504e470d0a1a0a00000000', 'hex');
const imageMessage = (text = '搜图') => [{ type: 'text', data: { text } }, { type: 'image', data: { url: 'https://qq.example/image' } }];
const okReport = (platform = 'google') => ({ platform, status: 'ok', results: [{ title: '来源', url: 'https://example.com/source' }] });

function fixture(t, overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-search-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const config = { imageSearch: imageSearchConfig({ enabled: true, relayUrl: 'http://127.0.0.1:3220', relayToken: 'a'.repeat(40), allowedGroups: ['100001'], cooldownSeconds: 0, platforms: { serpapi: true } }) };
  const sends = [], calls = [];
  const manager = new ImageSearchManager({ dataDir: dir, getConfig: () => config, canRun: () => true,
    download: async () => ({ buffer: png }), send: async (...args) => sends.push(args), onebot: {}, store: {},
    fetchImpl: async (_url, options) => { calls.push(options.headers['x-search-platform']); return Response.json(okReport(options.headers['x-search-platform'])); }, ...overrides });
  return { manager, config, dir, sends, calls };
}

test('搜图默认关闭、独立配置且不共享可变平台表', () => {
  const a = imageSearchConfig(), b = imageSearchConfig();
  assert.equal(a.enabled, false);
  assert.equal(a.allowPrivate, false);
  assert.equal(a.platforms.serpapi, false);
  assert.deepEqual(a.allowedGroups, []);
  a.platforms.google = false;
  assert.equal(b.platforms.google, true);
});

test('搜图配置验证拒绝错误开关、白名单、阈值及未知字段', () => {
  for (const patch of [{ enabled: 'yes' }, { limit: 9 }, { timeoutSeconds: 3 }, { cooldownSeconds: 1.2 }, { traceMinSimilarity: 0.3 }, { platforms: { other: true } }, { platforms: [] }, { allowedGroups: ['*'] }, { relayToken: 'a\nb' }, { unknown: 1 }]) assert.throws(() => validateImageSearchPatch(patch));
  validateImageSearchPatch({ enabled: false, traceMinSimilarity: 0.95, platforms: { trace: false } });
});

test('搜图中转只允许本机 HTTP 或无凭据 HTTPS 根地址', () => {
  for (const url of ['http://example.com', 'http://127.0.0.1@evil.test', 'https://x.test/path', 'https://x.test?token=a', 'https://x.test#hash', 'file:///tmp']) assert.throws(() => validateRelayUrl(url));
  for (const url of ['', 'http://127.0.0.1:3220', 'http://[::1]:3220/', 'https://search.example.com']) validateRelayUrl(url);
});

test('精确搜图指令兼容图片、引用、at 和 CQ 字符串，不误接普通聊天', () => {
  assert.equal(imageSearchCommand(imageMessage()).platform, 'serpapi');
  assert.equal(imageSearchCommand(imageMessage('找鸡')).mode, 'find');
  assert.equal(imageSearchCommand('[CQ:reply,id=123]找鸡').platform, 'serpapi');
  assert.equal(imageSearchCommand(imageMessage('/搜图 Google')).platform, 'google');
  assert.equal(imageSearchCommand('搜图 trace.moe').platform, 'trace');
  assert.equal(imageSearchCommand('搜图 SerpApi').platform, 'serpapi');
  assert.equal(imageSearchCommand('搜图 全部').platform, 'all');
  assert.equal(imageSearchCommand('搜图 baidu').platform, 'invalid');
  assert.equal(imageSearchCommand('我想搜图'), null);
  assert.equal(imageSearchCommand('帮我找鸡'), null);
  const command = imageSearchCommand('[CQ:at,qq=111111]搜图 yandex[CQ:reply,id=123][CQ:image,url=https://x.test/a?a=1&#44;b=2]');
  assert.equal(command.platform, 'yandex');
  assert.equal(command.segments.find((s) => s.type === 'image').data.url, 'https://x.test/a?a=1,b=2');
  assert.equal(searchSegments('')[0].type, 'text');
});

test('Yandex 只提取来源网页、去重、解码实体并限制数量', () => {
  const rows = [{ title: '<script>标题</script>', url: 'https://a.test/page' }, { title: '重复', url: 'https://a.test/page' }, { title: '坏协议', url: 'javascript:alert(1)' }, { title: '第二条', url: 'https://b.test/' }];
  const state = JSON.stringify({ initialState: { cbirSites: { sites: rows } } }).replace(/"/g, '&quot;');
  const body = `<div data-state="bad"></div><div data-state="${state}"></div>`;
  assert.equal(parseYandex(body, 1).length, 1);
  assert.deepEqual(parseYandex(body).map((r) => r.url), ['https://a.test/page', 'https://b.test/']);
  assert.deepEqual(parseYandex('<html>验证码</html>'), []);
});

test('trace 过滤低相似度及无效动画ID，同一集不同片源去重', () => {
  const row = { anilist: { id: 21034, title: { chinese: '点兔' } }, image: 'https://api.trace.moe/preview.jpg', episode: 1, from: 272, to: 283, similarity: 0.99 };
  const results = parseTrace({ result: [row, { ...row, filename: '不同片源' }, { ...row, episode: 2, similarity: 0.78 }, { ...row, anilist: 'invalid' }] });
  assert.equal(results.length, 1);
  assert.equal(results[0].url, 'https://anilist.co/anime/21034');
  assert.equal(results[0].title, '点兔');
  assert.equal(results[0].image, row.image);
});

test('Google 来源结果排除站内导航、重复与非法协议', () => {
  const results = googleResultRows([{ title: 'Google', url: 'https://accounts.google.com/' }, { title: '原网页', url: 'https://www.google.com/url?q=https%3A%2F%2Fa.test%2Fpage' }, { title: '重复', url: 'https://a.test/page' }, { title: '坏链接', url: 'javascript:alert(1)' }]);
  assert.equal(results.length, 1);
  assert.equal(results[0].url, 'https://a.test/page');
  const image = googleResultRows([{ title: '图片来源', url: 'https://www.google.com/imgres?imgurl=https%3A%2F%2Fa.test%2Foriginal.png&imgrefurl=https%3A%2F%2Fa.test%2Fsource' }])[0];
  assert.equal(image.image, 'https://a.test/original.png');
  assert.equal(image.url, 'https://a.test/source');
});

test('Google 未配置浏览器可降级，不假装返回结果', async () => {
  const saved = process.env.IMAGE_SEARCH_CHROME;
  delete process.env.IMAGE_SEARCH_CHROME;
  try { assert.equal((await googleLens({ buffer: png, type: 'image/png' })).status, 'unavailable'); }
  finally { if (saved !== undefined) process.env.IMAGE_SEARCH_CHROME = saved; }
});

test('SerpApi 区分来源平台、帖子和发现页，过滤无效或重复链接', () => {
  const rows = parseSerpApiRows({ exact_matches: [
    { title: '创作者帖子', source: 'X', link: 'https://x.com/example/status/123/photo/1' },
    { title: '同帖语言版', source: 'X', link: 'https://x.com/example/status/123?lang=bg' },
    { title: '发现页', source: 'TikTok', link: 'https://www.tiktok.com/discover/name' },
    { title: 'Instagram 帖子', source: 'Instagram', link: 'https://www.instagram.com/p/ABC123/' },
    { title: '坏链接', link: 'javascript:alert(1)' }
  ] }, 'exact_matches');
  assert.deepEqual(rows.map((row) => row.kind), ['post', 'search', 'post']);
  assert.match(rows[0].source, /X \(x\.com\)/);
  assert.equal(rows[0].account, '@example');
  assert.match(rows[1].source, /TikTok/);
  assert.equal(rows[1].account, '');
  assert.equal(rows[2].account, '');
});

test('SerpApi 大图压缩后上传，保留 TikTok 来源并不将发现页称为原帖', async () => {
  const noisy = Buffer.alloc(1200 * 1000 * 3);
  let seed = 123456789;
  for (let i = 0; i < noisy.length; i++) { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; noisy[i] = seed & 255; }
  const sharp = (await import('sharp')).default;
  const large = await sharp(noisy, { raw: { width: 1200, height: 1000, channels: 3 } }).png().toBuffer();
  assert.ok(large.length > 500_000);
  const prepared = await prepareSerpApiImage({ buffer: large, type: 'image/png' });
  assert.ok(prepared.buffer.length <= 500_000);
  const calls = [];
  const report = await serpApiLens({ buffer: large, type: 'image/png' }, { serpApiKey: 'test-secret', limit: 3, fetchImpl: async (url, options) => {
    calls.push(String(url));
    if (String(url).endsWith('/image')) {
      assert.ok(options.body instanceof FormData);
      assert.equal(options.body.get('api_key'), 'test-secret');
      assert.ok(options.body.get('image').size <= 500_000);
      return Response.json({ image_id: 'valid-image-id-12345' });
    }
    const type = new URL(url).searchParams.get('type');
    if (type === 'exact_matches') return Response.json({ exact_matches: [{ title: '南忆一依怡nayee', source: 'TikTok', link: 'https://www.tiktok.com/discover/nayee' }] });
    return Response.json({ visual_matches: [{ title: '作品视频', source: 'TikTok', link: 'https://www.tiktok.com/@nayee/video/12345' }] });
  } });
  assert.equal(report.status, 'ok');
  assert.deepEqual(calls.length, 3);
  assert.deepEqual(report.results.map((row) => row.kind), ['post', 'search']);
  assert.equal(report.results[0].account, '@nayee');
  assert.match(formatSearchReply([report]), /来源：TikTok/);
  assert.match(formatSearchReply([report]), /链接账号 @nayee/);
  assert.match(formatSearchReply([report]), /搜索页/);
  assert.equal(JSON.stringify(report).includes('test-secret'), false);
});

test('SerpApi 原图无结果时仅补查一次自动裁剪，并标为相似线索', async () => {
  const calls = [];
  const report = await serpApiLens({ buffer: png, type: 'image/png' }, { serpApiKey: 'test-secret', fetchImpl: async (url) => {
    if (String(url).endsWith('/image')) return Response.json({ image_id: 'valid-image-id-12345' });
    const params = new URL(url).searchParams;
    calls.push([params.get('type'), params.get('auto_crop')]);
    if (params.get('auto_crop') === 'true') return Response.json({ visual_matches: [{ title: '裁剪候选', source: 'X', link: 'https://x.com/example/status/123' }] });
    return Response.json({ exact_matches: [], visual_matches: [] });
  } });
  assert.deepEqual(calls, [['exact_matches', null], ['all', null], ['all', 'true']]);
  assert.equal(report.results[0].match, 'cropped_visual');
  assert.match(formatFindReply(report), /自动裁剪后的相似图片线索/);
  assert.match(formatFindReply(report), /账号：未确认/);
});

test('SerpApi 从前八条候选中找到靠后的社交帖子，展示数量仍受限制', async () => {
  const report = await serpApiLens({ buffer: png, type: 'image/png' }, { serpApiKey: 'test-secret', limit: 3, fetchImpl: async (url) => {
    if (String(url).endsWith('/image')) return Response.json({ image_id: 'valid-image-id-12345' });
    if (new URL(url).searchParams.get('type') === 'exact_matches') return Response.json({ exact_matches: [] });
    return Response.json({ visual_matches: [
      { title: '商品页 A', link: 'https://shop.test/item/a' },
      { title: '商品页 B', link: 'https://shop.test/item/b' },
      { title: '商品页 C', link: 'https://shop.test/item/c' },
      { title: '动态', link: 'https://www.instagram.com/p/ABC123/' },
      { title: '其他页面', link: 'https://shop.test/item/d' }
    ] });
  } });
  assert.equal(report.results.length, 3);
  assert.equal(report.results[0].kind, 'post');
  assert.match(formatFindReply(report), /平台：Instagram/);
});

test('平台 HTTP 403 不泄露原始响应，不伪装成无结果', async () => {
  const report = await searchProvider('trace', { buffer: png, type: 'image/png' }, { fetchImpl: async () => new Response('sensitive', { status: 403 }) });
  assert.equal(report.status, 'blocked');
  assert.equal(JSON.stringify(report).includes('sensitive'), false);
});

test('平台重定向不能把上传文件转发到其他来源', async () => {
  let calls = 0;
  await assert.rejects(providerRequest('https://yandex.com/images/search', { method: 'POST', body: 'image' }, async () => {
    calls++; return new Response('', { status: 307, headers: { location: 'https://evil.test/' } });
  }), /其他站点/);
  assert.equal(calls, 1);
});

test('Yandex 文件上传后用平台给出的图片ID查询来源', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url: String(url), options });
    if (calls.length === 1) {
      assert.ok(options.body instanceof FormData);
      return Response.json({ blocks: [{ name: { block: 'b-page_type_search-by-image__link' }, params: { originalImageUrl: 'https://avatars.mds.yandex.net/get-images-cbir/a/orig', cbirId: 'a/b' } }] });
    }
    return new Response(`<div data-state='${JSON.stringify({ initialState: { cbirSites: { sites: [{ title: '来源', url: 'https://a.test/' }] } } })}'></div>`);
  };
  const report = await searchProvider('yandex', { buffer: png, type: 'image/png' }, { fetchImpl });
  assert.equal(report.status, 'ok');
  assert.match(calls[1].url, /cbir_id=a%2Fb/);
});

test('结果按平台分组且清理 CQ 控制码、低级协议', () => {
  const text = formatSearchReply([{ platform: 'trace', status: 'ok', results: [{ title: '[CQ:at,qq=all]点兔', url: 'https://anilist.co/anime/21034', similarity: 0.99, from: 272, to: 283, episode: 1 }] }, { platform: 'google', status: 'blocked', message: '需要验证码' }]);
  assert.match(text, /99.0%/);
  assert.match(text, /4:32—4:43/);
  assert.match(text, /需要验证码/);
  assert.equal(text.includes('[CQ:'), false);
});

test('找鸡文字格式标来源账号，并把搜索页标为待核对线索', () => {
  const reply = formatFindReply({ platform: 'serpapi', status: 'ok', results: [{ title: '[CQ:at,qq=all]南忆一依怡nayee', source: 'TikTok (tiktok.com)', kind: 'search', match: 'exact', account: '', url: 'https://www.tiktok.com/discover/nayee' }] });
  assert.match(reply, /🎯 找鸡结果/);
  assert.match(reply, /🌐 平台：TikTok/);
  assert.match(reply, /🔎 匹配：完全匹配线索 · 搜索页/);
  assert.match(reply, /🆔 账号：未确认/);
  assert.match(reply, /https:\/\/www\.tiktok\.com\/discover\/nayee/);
  assert.equal(reply.includes('[CQ:'), false);
});

test('找鸡优先展示社交平台帖子，不把商品标题当名字或原作者', () => {
  const reply = formatFindReply({ platform: 'serpapi', status: 'ok', results: [
    { title: 'Costume for sale', source: 'eBay', kind: 'page', match: 'exact', account: '', url: 'https://www.ebay.com/itm/123' },
    { title: 'Video post', source: 'TikTok (tiktok.com)', kind: 'post', match: 'visual', account: '@sampleuser', url: 'https://www.tiktok.com/@sampleuser/video/456' }
  ] });
  assert.match(reply, /平台：TikTok/);
  assert.match(reply, /名字：未确认/);
  assert.match(reply, /账号：@sampleuser/);
  assert.match(reply, /链接账号也可能只是转载者/);
  assert.doesNotMatch(reply, /ebay\.com/);
});

test('中转响应限制字节数，防止超大结果占用内存', async () => {
  await assert.rejects(boundedBody(new Response('123456'), 5), /大小限制/);
});

test('关闭、未授权会话和冷却不请求平台，不创建历史文件', async (t) => {
  const f = fixture(t);
  f.config.imageSearch.enabled = false;
  await f.manager.start(imageSearchCommand(imageMessage()), 'group:100001', 1);
  assert.equal(fs.existsSync(f.manager.file), false);
  f.config.imageSearch.enabled = true;
  await f.manager.start(imageSearchCommand(imageMessage()), 'group:100002', 2);
  await f.manager.start(imageSearchCommand(imageMessage()), 'private:100001', 3);
  assert.deepEqual(f.calls, []);
  f.config.imageSearch.cooldownSeconds = 60;
  f.manager.cooldowns.set('group:100001', Date.now());
  await f.manager.start(imageSearchCommand(imageMessage()), 'group:100001', 4);
  assert.deepEqual(f.calls, []);
});

test('宿主 observe/paused/白名单拒绝时不下载、不发送', async (t) => {
  const f = fixture(t, { canRun: () => false });
  await f.manager.start(imageSearchCommand(imageMessage()), 'group:100001', 1);
  assert.equal(f.sends.length, 0);
  assert.equal(f.calls.length, 0);
});

test('搜图和找鸡都只查询 SerpApi，不因无结果自动切换其他平台', async (t) => {
  const calls = [];
  const f = fixture(t, { fetchImpl: async (_url, options) => {
    const p = options.headers['x-search-platform']; calls.push(p);
    assert.equal(options.redirect, 'error');
    assert.ok(options.signal);
    return Response.json({ platform: p, status: 'empty', message: '没有线索', results: [] });
  } });
  await f.manager.start(imageSearchCommand(imageMessage()), 'group:100001', 1);
  await f.manager.task;
  await f.manager.start(imageSearchCommand(imageMessage('找鸡')), 'group:100001', 2);
  await f.manager.task;
  assert.deepEqual(calls, ['serpapi', 'serpapi']);
  assert.equal(f.sends.length, 2);
  assert.match(f.sends[0][1][0], /没有线索/);
  assert.match(f.sends[1][1][0], /找鸡结果/);
  assert.equal(f.manager.history[0].status, 'no-result');
  assert.equal(fs.readFileSync(f.manager.file, 'utf8').includes('a'.repeat(40)), false);
});

test('找鸡固定发文字，搜图继续按设置走原有合并转发', async (t) => {
  const forwarded = [];
  const f = fixture(t, { forward: async (...args) => forwarded.push(args), fetchImpl: async () => Response.json({
    platform: 'serpapi', status: 'ok', results: [{ title: '南忆一依怡nayee', source: 'TikTok (tiktok.com)', kind: 'search', match: 'exact', account: '', url: 'https://www.tiktok.com/discover/nayee' }]
  }) });
  f.config.imageSearch.sendImages = true;
  await f.manager.start(imageSearchCommand(imageMessage('找鸡')), 'group:100001', 1);
  await f.manager.task;
  assert.equal(f.sends.length, 1);
  assert.equal(forwarded.length, 0);
  assert.match(f.sends[0][1][0], /平台：TikTok/);
  assert.match(f.sends[0][1][0], /账号：未确认/);
  assert.match(f.sends[0][1][0], /搜索／发现页/);
  await f.manager.start(imageSearchCommand(imageMessage()), 'group:100001', 2);
  await f.manager.task;
  assert.equal(forwarded.length, 1);
  assert.equal(f.sends.length, 1);
  assert.equal(f.manager.history[0].status, 'done');
  assert.match(forwarded[0][1].nodes[1].data.content[0].data.text, /以图搜图结果/);
});

test('指定平台不回退，全部查询跳过关闭的平台', async (t) => {
  const f = fixture(t);
  await f.manager.start(imageSearchCommand(imageMessage('搜图 trace.moe')), 'group:100001', 1);
  await f.manager.task;
  assert.deepEqual(f.calls, ['trace']);
  f.config.imageSearch.platforms.google = false;
  await f.manager.start(imageSearchCommand(imageMessage('搜图 全部')), 'group:100001', 2);
  await f.manager.task;
  assert.deepEqual(f.calls, ['trace', 'serpapi', 'yandex', 'trace']);
});

test('引用图片只读本会话已入库消息，禁止猜ID读取其他会话', async (t) => {
  let getCalls = 0;
  const f = fixture(t, { onebot: { getMsg: async () => { getCalls++; return { message: imageMessage('') }; } }, store: { findByMid: (chatKey, mid) => chatKey === 'group:100001' && mid === '11' ? { media: [] } : null } });
  const signal = new AbortController().signal;
  const cmd = imageSearchCommand('[CQ:reply,id=11]搜图');
  assert.equal((await f.manager.image(cmd, 'group:100001', signal)).type, 'image/png');
  await assert.rejects(f.manager.image(cmd, 'group:100002', signal), /请发送/);
  assert.equal(getCalls, 1);
});

test('无图片和非图片下载响应明确失败，不请求搜图平台', async (t) => {
  const f = fixture(t, { download: async () => ({ buffer: Buffer.from('<html>not image</html>') }) });
  await f.manager.start(imageSearchCommand('搜图'), 'group:100001', 1);
  await f.manager.task;
  assert.match(f.sends[0][1][0], /请发送/);
  await f.manager.start(imageSearchCommand(imageMessage()), 'group:100001', 2);
  await f.manager.task;
  assert.match(f.sends[1][1][0], /仅支持/);
  assert.equal(f.calls.length, 0);
});

test('关闭功能取消正在请求的平台，保留历史且不再发送结果', async (t) => {
  let requested;
  const started = new Promise((resolve) => { requested = resolve; });
  const f = fixture(t, { fetchImpl: async (_url, options) => {
    requested();
    await new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('cancel')), { once: true }));
  } });
  await f.manager.start(imageSearchCommand(imageMessage()), 'group:100001', 1);
  await started;
  const task = f.manager.task;
  f.config.imageSearch.enabled = false;
  f.manager.enforce();
  await task;
  assert.equal(f.manager.history[0].status, 'cancelled');
  assert.equal(f.sends.length, 0);
  assert.ok(fs.existsSync(f.manager.file));
});

test('发送结果未知不再次发送错误消息或重跑查询', async (t) => {
  let sends = 0;
  const f = fixture(t, { send: async () => { sends++; throw new Error('timeout after remote send'); } });
  await f.manager.start(imageSearchCommand(imageMessage()), 'group:100001', 1);
  await f.manager.task;
  assert.equal(sends, 1);
  assert.equal(f.calls.length, 1);
  assert.equal(f.manager.history[0].status, 'send-unknown');
});

test('宿主权限在查询途中撤销，无需控制台回调也能取消外部请求', { timeout: 5000 }, async (t) => {
  let allowed = true, requested;
  const ready = new Promise((resolve) => { requested = resolve; });
  const f = fixture(t, { canRun: () => allowed, fetchImpl: async (_url, options) => {
    requested();
    await new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('cancel')), { once: true }));
  } });
  await f.manager.start(imageSearchCommand(imageMessage()), 'group:100001', 1);
  await ready;
  const task = f.manager.task;
  allowed = false;
  await task;
  assert.equal(f.manager.history[0].status, 'cancelled');
  assert.equal(f.sends.length, 0);
});

test('SendQueue 返回部分失败时记录未确认，不自动重发', async (t) => {
  let count = 0;
  const f = fixture(t, { send: async () => { count++; return { sent: [], failed: [{ error: 'timeout' }] }; } });
  await f.manager.start(imageSearchCommand(imageMessage()), 'group:100001', 1);
  await f.manager.task;
  assert.equal(count, 1);
  assert.equal(f.manager.history[0].status, 'send-unknown');
});

test('重启遗留任务标记中断，不自动重试', (t) => {
  const f = fixture(t);
  fs.mkdirSync(path.dirname(f.manager.file), { recursive: true });
  fs.writeFileSync(f.manager.file, JSON.stringify([{ id: 'old', status: 'running' }]));
  const another = new ImageSearchManager({ dataDir: f.dir, getConfig: () => f.config });
  assert.equal(another.snapshot().history[0].status, 'interrupted');
  assert.equal(another.task, null);
});

test('搜图令牌沿用宿主脱敏，状态接口不返回令牌', (t) => {
  const f = fixture(t);
  const safe = sanitizeConfigSecrets(f.config);
  assert.equal(safe.imageSearch.relayToken, undefined);
  assert.equal(safe.imageSearch.hasRelayToken, true);
  assert.equal(f.manager.snapshot().settings.relayToken, undefined);
});

async function listen(t, server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  return `http://127.0.0.1:${server.address().port}`;
}

test('真实中转 HTTP：鉴权、方法、图片嗅探、平台及大小验证', async (t) => {
  const token = 'x'.repeat(40);
  const calls = [];
  const server = createImageSearchRelay({ token, search: async (...args) => { calls.push(args); return okReport(args[0]); } });
  const base = await listen(t, server);
  const headers = { authorization: `Bearer ${token}`, 'x-search-platform': 'yandex' };
  assert.equal((await fetch(`${base}/healthz`)).status, 401);
  assert.equal((await fetch(`${base}/healthz`, { headers })).status, 200);
  assert.equal((await fetch(`${base}/v1/search`, { headers })).status, 405);
  assert.equal((await fetch(`${base}/v1/search`, { method: 'POST', headers: { ...headers, 'x-search-platform': 'other' }, body: png })).status, 400);
  assert.equal((await fetch(`${base}/v1/search`, { method: 'POST', headers, body: 'not image' })).status, 400);
  assert.equal((await fetch(`${base}/v1/search`, { method: 'POST', headers, body: Buffer.alloc(8 * 1024 * 1024 + 1) })).status, 413);
  const response = await fetch(`${base}/v1/search`, { method: 'POST', headers, body: png });
  assert.equal((await response.json()).platform, 'yandex');
  assert.equal(calls.length, 1);
  assert.equal(calls[0][1].type, 'image/png');
});

test('中转仅允许单个任务，同时请求返回429', async (t) => {
  let finish, requested;
  const ready = new Promise((resolve) => { requested = resolve; });
  const server = createImageSearchRelay({ token: 'x'.repeat(40), search: async () => { requested(); return new Promise((resolve) => { finish = resolve; }); } });
  const base = await listen(t, server);
  const options = { method: 'POST', headers: { authorization: `Bearer ${'x'.repeat(40)}`, 'x-search-platform': 'google' }, body: png };
  const first = fetch(`${base}/v1/search`, options);
  await ready;
  assert.equal((await fetch(`${base}/v1/search`, options)).status, 429);
  finish(okReport());
  assert.equal((await first).status, 200);
});

test('控制台搜图 API 复用鉴权，部分保存不清空令牌和白名单', async (t) => {
  const f = fixture(t);
  const json = (res, status, value) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
  const router = createRouter({ authorize: (req) => req.headers['x-test-token'] === 'yes', json });
  installImageSearchRoutes({ addRoute: (...args) => router.add(...args), updateConfig: (patch) => Object.assign(f.config.imageSearch, patch.imageSearch) }, f.manager);
  const server = http.createServer((req, res) => router.handle(req, res));
  const base = await listen(t, server);
  assert.equal((await fetch(`${base}/api/image-search`)).status, 401);
  const headers = { 'x-test-token': 'yes', 'content-type': 'application/json' };
  const get = await fetch(`${base}/api/image-search`, { headers });
  assert.equal(JSON.stringify(await get.json()).includes('a'.repeat(40)), false);
  assert.equal((await fetch(`${base}/api/image-search/settings`, { method: 'POST', headers, body: JSON.stringify({ enabled: false }) })).status, 200);
  assert.equal(f.config.imageSearch.relayToken, 'a'.repeat(40));
  assert.deepEqual(f.config.imageSearch.allowedGroups, ['100001']);
  assert.equal((await fetch(`${base}/api/image-search/settings`, { method: 'POST', headers, body: JSON.stringify({ relayUrl: 'http://evil.test' }) })).status, 400);
});

test('匹配图中转只认短期搜索凭证，返回图片而非任意代理', async (t) => {
  const requests = [];
  const server = createImageSearchRelay({ token: 'x'.repeat(40), search: async () => ({ ...okReport('yandex'), results: [{ title: '来源', url: 'https://a.test/', image: 'https://a.test/full.png' }] }),
    download: async (...args) => { requests.push(args); return { buffer: png }; } });
  const base = await listen(t, server);
  const headers = { authorization: `Bearer ${'x'.repeat(40)}`, 'x-search-platform': 'yandex' };
  assert.equal((await fetch(`${base}/v1/image`, { method: 'POST', body: '{}' })).status, 401);
  assert.equal((await fetch(`${base}/v1/image`, { method: 'POST', headers, body: JSON.stringify({ url: 'http://127.0.0.1/' }) })).status, 404);
  const report = await (await fetch(`${base}/v1/search`, { method: 'POST', headers, body: png })).json();
  const response = await fetch(`${base}/v1/image`, { method: 'POST', headers, body: JSON.stringify({ key: report.results[0].imageKey }) });
  assert.equal(response.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), png);
  assert.equal(requests[0][0], 'https://a.test/full.png');
  assert.equal(requests.length, 1);
});

test('中转图片下载始终拒绝内网、凭据及本机，不受宿主图片例外影响', async () => {
  for (const url of ['http://127.0.0.1/config', 'http://169.254.169.254/', 'http://[::1]/', 'http://localhost/', 'https://user:pass@example.com/', 'file:///etc/passwd']) {
    await assert.rejects(safeFetchPublicBinary(url, 100, AbortSignal.timeout(1000)));
  }
});

test('合并卡片原图失败回退缩略图，链接逐图对应且最多3张', async () => {
  const reports = [{ ...okReport('yandex'), results: Array.from({ length: 4 }, (_, i) => ({ title: `图${i}`, url: `https://a.test/${i}`, imageKey: `${i}0000000-0000-0000-0000-000000000000`, thumbnailKey: `${i}0000000-0000-0000-0000-000000000001` })) }];
  let requests = 0;
  const nodes = await searchResultNodes(reports, imageSearchConfig({ limit: 4 }), { signal: new AbortController().signal, selfId: '123456', fetch: async (_url, options) => {
    requests++;
    return JSON.parse(options.body).key.endsWith('1') ? new Response(png) : new Response('denied', { status: 403 });
  } });
  assert.equal(nodes.length, 5);
  assert.equal(requests, 6);
  for (let i = 0; i < 3; i++) {
    assert.match(nodes[i + 1].data.content[0].data.text, new RegExp(`https://a.test/${i}`));
    assert.match(nodes[i + 1].data.content[1].data.text, /缩略图/);
    assert.equal(nodes[i + 1].data.content[2].data.file, `base64://${png.toString('base64')}`);
  }
  assert.match(nodes[4].data.content[1].data.text, /未附图/);
});

test('附图阶段拒绝超限和非图片响应，取消时不返回待发卡片', async () => {
  const report = { ...okReport('trace'), results: [{ title: '动画', url: 'https://anilist.co/anime/1', imageKey: '00000000-0000-0000-0000-000000000000' }] };
  const config = imageSearchConfig();
  const controller = new AbortController();
  const nodes = await searchResultNodes([report], config, { signal: controller.signal, fetch: async () => new Response(Buffer.alloc(8 * 1024 * 1024 + 1)) });
  assert.equal(nodes[1].data.content.some((s) => s.type === 'image'), false);
  await assert.rejects(searchResultNodes([report], config, { signal: controller.signal, fetch: async () => { controller.abort(); throw new Error('cancelled'); } }));
});

test('合并卡片发送未知不补发文字，历史不落盘图片或凭证', async (t) => {
  let forwards = 0;
  const f = fixture(t, { forward: async () => { forwards++; throw new Error('unknown send'); },
    fetchImpl: async (url) => url.endsWith('/v1/image') ? new Response(png) : Response.json({ ...okReport('serpapi'), results: [{ title: '来源', url: 'https://a.test/', imageKey: '00000000-0000-0000-0000-000000000000' }] }) });
  f.config.imageSearch.sendImages = true;
  await f.manager.start(imageSearchCommand(imageMessage()), 'group:100001', 333);
  await f.manager.task;
  assert.equal(forwards, 1);
  assert.equal(f.sends.length, 0);
  assert.equal(f.manager.history[0].status, 'send-unknown');
  assert.doesNotMatch(fs.readFileSync(f.manager.file, 'utf8'), /base64|imageKey|a\.test/);
});

test('Google 验证后冷却不继续访问，其他平台仍可使用', async (t) => {
  const calls = [];
  const server = createImageSearchRelay({ token: 'x'.repeat(40), search: async (platform) => {
    calls.push(platform);
    return { platform, status: platform === 'google' ? 'blocked' : 'ok', results: [] };
  } });
  const base = await listen(t, server);
  for (const platform of ['google', 'google', 'yandex']) {
    await fetch(`${base}/v1/search`, { method: 'POST', headers: { authorization: `Bearer ${'x'.repeat(40)}`, 'x-search-platform': platform }, body: png });
  }
  assert.deepEqual(calls, ['google', 'yandex']);
});
