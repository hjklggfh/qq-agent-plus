import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import sharp from 'sharp';
import { XSearchManager } from '../src/features/x-search/manager.js';
import { xSearchCommand } from '../src/features/x-search/command.js';
import { createXBrowserRelay } from '../src/features/x-search/browser-relay.js';
import { downloadXOriginal } from '../src/features/x-search/originals.js';
import { boundedXImage } from '../src/features/x-search/image-stream.js';
import { xImageUrl } from '../src/features/x-search/relay-image.js';
import { DEFAULT_X_SEARCH_CONFIG } from '../src/features/x-search/config.js';

const token = 't'.repeat(48);
const media = Array.from({ length: 4 }, (_, i) => ({ type: 'photo', url: `https://pbs.twimg.com/media/photo${i}.png` }));
const post = (id, images = media) => ({ id, text: '测试正文', createdAt: '2026-10-23T02:00:00Z', media: images, url: `https://x.com/Example/status/${id}` });
const page = (posts, next = '') => ({ user: { username: 'Example', name: '示例' }, posts, next, source: 'tokyo-browser', fetchedAt: new Date().toISOString() });

test('原图命令只接管明确X编号，原图URL保留图片格式并请求orig尺寸', () => {
  for (const input of ['X 6原图', '/x 6 原图', 'X6原图']) assert.deepEqual(xSearchCommand(input), { original: 6 });
  for (const input of ['6原图', 'X 0原图', 'X -1原图', 'X 6原图 随便聊', 'X 1000000原图']) assert.equal(xSearchCommand(input), null);
  const url = xImageUrl('https://pbs.twimg.com/media/demo.png?name=small', true);
  assert.equal(url.pathname, '/media/demo'); assert.equal(url.searchParams.get('name'), 'orig'); assert.equal(url.searchParams.get('format'), 'png');
  for (const url of ['https://evil.test/media/demo.jpg', 'https://pbs.twimg.com:444/media/demo.jpg', 'https://pbs.twimg.com/ext_tw_video_thumb/demo.jpg']) assert.throws(() => xImageUrl(url, true));
});

test('东京原图只允许已查帖子照片，原始字节流落盘不重编码，过期拒绝', async (t) => {
  const png = await sharp({ create: { width: 20, height: 30, channels: 3, background: '#06c' } }).png().toBuffer();
  let calls = 0; let corrupt = false;
  const relay = createXBrowserRelay({ token, profileDir: '/unused', read: async () => page([post('123')]),
    original: async (url, options) => { calls++; assert.equal(options.original, true); assert.equal(url, media[0].url); return { stream: Readable.from(corrupt ? [Buffer.alloc(20)] : [png.subarray(0, 7), png.subarray(7)]), contentType: 'image/png' }; } });
  await new Promise(resolve => relay.server.listen(0, '127.0.0.1', resolve)); t.after(() => relay.stop());
  const base = `http://127.0.0.1:${relay.server.address().port}`; const headers = { Authorization: `Bearer ${token}` };
  assert.equal((await fetch(`${base}/original?post=123&index=0`)).status, 401);
  assert.equal((await fetch(`${base}/original?post=123&index=0`, { headers })).status, 410);
  await fetch(`${base}/account/Example`, { headers });
  assert.equal((await fetch(`${base}/original?post=123&index=9`, { headers })).status, 404);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'x-original-test-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const output = path.join(dir, 'original');
  const got = await downloadXOriginal({ postId: '123', index: 0, media: media[0] }, { backend: 'tokyo-browser', relayUrl: base, relayToken: token }, output, AbortSignal.timeout(5000));
  assert.equal(got.extension, 'png'); assert.equal(got.bytes, png.length); assert.deepEqual(fs.readFileSync(output), png); assert.equal(calls, 1);
  corrupt = true;
  const broken = path.join(dir, 'broken');
  await assert.rejects(downloadXOriginal({ postId: '123', index: 0, media: media[0] }, { backend: 'tokyo-browser', relayUrl: base, relayToken: token }, broken, AbortSignal.timeout(5000)));
  assert.equal(fs.existsSync(broken), false);
  const now = Date.now(); t.mock.method(Date, 'now', () => now + 600001);
  assert.equal((await fetch(`${base}/original?post=123&index=0`, { headers })).status, 410);
});

test('原图流拒绝伪造文件和超限内容，不保留半成品', async () => {
  const sink = () => new Writable({ write(_chunk, _encoding, cb) { cb(); } });
  await assert.rejects(pipeline(Readable.from([Buffer.alloc(30)]), boundedXImage('image/png'), sink()), /签名/);
  await assert.rejects(pipeline(Readable.from([Buffer.alloc(30)]), boundedXImage('image/png', 20), sink()), /大小/);
  await assert.rejects(pipeline(Readable.from([Buffer.alloc(3)]), boundedXImage('image/png'), sink()), /不完整/);
});

async function managerFixture(t, overrides = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'x-session-test-')); t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const config = { xSearch: { ...DEFAULT_X_SEARCH_CONFIG, enabled: true, backend: 'tokyo-browser', relayToken: token, translateChinese: false, includeImages: false } };
  const uploads = []; const downloads = [];
  const manager = new XSearchManager({ dataDir, getConfig: () => config, canRun: () => true, onebot: { selfId: '1' },
    browserRequest: async (_user, _settings, options) => options.next ? page([post('95')]) : page(Array.from({ length: 5 }, (_, i) => post(String(100 - i))), '96'),
    forward: async () => ({ message_id: '1' }),
    originalDownload: async (item, _settings, destination) => { downloads.push(item); fs.writeFileSync(destination, 'unchanged'); return { bytes: 9, extension: 'png' }; },
    file: async (_chat, payload) => { uploads.push(payload); assert.equal(fs.readFileSync(payload.file, 'utf8'), 'unchanged'); }, ...overrides });
  const run = (command, sender = '1', chat = 'private:1') => { manager.cooldowns.clear(); return manager.start(command, chat, String(Math.random()), sender); };
  return { dataDir, config, manager, uploads, downloads, run };
}

test('跨页连续编号保留已查帖子，按人/会话隔离，原图四文件串行发送并清理，重新搜索重置', async (t) => {
  const f = await managerFixture(t);
  assert.match((await f.run({ original: 1 })).error, /未查询|过期/);
  await f.run({ username: 'Example' }); await f.run({ next: true });
  assert.equal((await f.run({ original: 6 })).files, 4);
  assert.ok(f.downloads.every(item => item.postId === '95'));
  assert.ok(f.uploads.every(item => /X-Example-95-[1-4]\.png/.test(item.name)));
  assert.equal((await f.run({ original: 1 })).files, 4, '上一页依旧可取');
  assert.match((await f.run({ original: 6 }, '2')).error, /未查询|过期/);
  assert.match((await f.run({ original: 6 }, '1', 'private:2')).error, /未查询|过期/);
  assert.deepEqual(fs.readdirSync(path.join(f.dataDir, 'tmp/x-search-originals')), []);
  await f.run({ username: 'Example' }); assert.match((await f.run({ original: 6 })).error, /未查询|过期/);
  for (const session of f.manager.sessions.values()) session.at = Date.now() - 600001;
  assert.match((await f.run({ original: 1 })).error, /未查询|过期/);
});

test('原图发送未知立即停止，不重发、不发剩余文件；关闭或取消不继续上传', async (t) => {
  const f = await managerFixture(t, { file: async () => { throw new Error('timeout'); } });
  await f.run({ username: 'Example' });
  assert.equal((await f.run({ original: 1 })).sendUnknown, true); assert.equal(f.downloads.length, 1);
  assert.equal(fs.readdirSync(path.join(f.dataDir, 'tmp/x-search-originals')).length, 1, '未知上传临时文件保留供协议端读取');
  const g = await managerFixture(t);
  await g.run({ username: 'Example' });
  g.manager.options.originalDownload = async (_item, _settings, destination) => { fs.writeFileSync(destination, 'x'); g.config.xSearch.enabled = false; g.manager.enforce(); return { bytes: 1, extension: 'png' }; };
  assert.match((await g.run({ original: 1 })).error, /取消/); assert.equal(g.uploads.length, 0);
});
