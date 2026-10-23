import assert from 'node:assert/strict';
import test from 'node:test';
import { browserResponseRows, normalizeBrowserPosts, readBrowserAccount } from '../src/features/x-search/browser-reader.js';
import { createXBrowserRelay } from '../src/features/x-search/browser-relay.js';
import { fetchXBrowserPage, validateXRelayUrl, xBrowserThumbnail } from '../src/features/x-search/relay-client.js';
import sharp from 'sharp';
import { XSearchManager } from '../src/features/x-search/manager.js';
import { DEFAULT_X_SEARCH_CONFIG } from '../src/features/x-search/config.js';

const token = 't'.repeat(48);
const post = { url: 'https://x.com/Example/status/90071992547409931', createdAt: '2026-10-23T02:00:00Z', text: '公开测试帖',
  media: [{ type: 'photo', url: 'https://pbs.twimg.com/media/demo.jpg' }] };
const page = { source: 'tokyo-browser', user: { username: 'Example', name: '示例', description: '简介' },
  posts: normalizeBrowserPosts('Example', [post]), next: '', partial: false, fetchedAt: new Date().toISOString() };

test('浏览器结果不混入转帖、置顶、其他账号或外部链接，ID不丢精度', async () => {
  const rows = [post, post, { ...post, pinned: true }, { ...post, repost: true },
    { ...post, url: 'https://x.com/Other/status/1234' }, { ...post, url: 'https://evil.test/Example/status/1234' },
    { ...post, createdAt: 'bad' }];
  assert.equal(normalizeBrowserPosts('Example', rows).length, 1);
  assert.equal(normalizeBrowserPosts('Example', rows)[0].id, '90071992547409931');
  await assert.rejects(readBrowserAccount('home', { profileDir: '/unused' }), /用户名/);
  for (const url of ['http://localhost:3223', 'https://127.0.0.1:3223', 'http://10.0.0.1:3223', 'http://127.0.0.1:3223/?token=secret']) assert.throws(() => validateXRelayUrl(url));
});

test('仅提取目标公开时间线原文，忽略引用、转帖、回复及置顶', () => {
  const tweet = { rest_id: '90071992547409931', core: { user_results: { result: { core: { screen_name: 'Example' } } } },
    legacy: { created_at: 'Fri Oct 23 02:00:00 +0000 2026', full_text: 'Original English text', extended_entities: { media: [{ type: 'photo', media_url_https: post.media[0].url }] } } };
  const entry = (value) => ({ content: { itemContent: { tweet_results: { result: value } } } });
  const body = { instructions: [{ type: 'TimelinePinEntry', entry: entry(tweet) }, { entries: [entry(tweet),
    entry({ ...tweet, legacy: { ...tweet.legacy, retweeted_status_result: {} } }),
    entry({ ...tweet, legacy: { ...tweet.legacy, in_reply_to_status_id_str: '123' } }),
    entry({ ...tweet, core: { user_results: { result: { legacy: { screen_name: 'Other' } } } } })] }] };
  const rows = browserResponseRows('Example', body);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].text, 'Original English text');
  assert.equal(normalizeBrowserPosts('Example', rows)[0].media.length, 1);
});

test('东京服务鉴权、固定账号路径、单任务互斥、缓存及端到端读取', async (t) => {
  let reads = 0; let release;
  let downloads = 0;
  const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#fff' } }).png().toBuffer();
  const relay = createXBrowserRelay({ token, profileDir: '/dedicated/profile', download: async (url) => {
    assert.equal(new URL(url).hostname, 'pbs.twimg.com'); downloads++;
    return { buffer: png, contentType: 'image/png' };
  }, read: async (username, options) => {
    assert.equal(username, 'Example'); assert.equal(options.profileDir, '/dedicated/profile');
    reads++; await new Promise((resolve) => { release = resolve; }); return structuredClone(page);
  } });
  await new Promise((resolve) => relay.server.listen(0, '127.0.0.1', resolve));
  t.after(() => relay.stop());
  const base = `http://127.0.0.1:${relay.server.address().port}`;
  assert.equal((await fetch(`${base}/healthz`)).status, 401);
  const headers = { Authorization: `Bearer ${token}` };
  assert.equal((await fetch(`${base}/account/Example/../../home`, { headers })).status, 404);
  const first = fetchXBrowserPage('Example', { relayUrl: base, relayToken: token });
  for (let i = 0; i < 40 && !release; i++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal((await fetch(`${base}/account/Other`, { headers })).status, 429);
  release();
  assert.equal((await first).posts[0].text, '公开测试帖');
  assert.equal((await fetchXBrowserPage('Example', { relayUrl: base, relayToken: token })).posts.length, 1);
  assert.equal(reads, 1);
  await assert.rejects(fetchXBrowserPage('Example', { relayUrl: base, relayToken: 'wrong' }), /不匹配/);
  assert.equal((await (await fetch(`${base}/healthz`, { headers })).json()).source, 'tokyo-browser');
  assert.equal((await fetch(`${base}/image?url=${encodeURIComponent(post.media[0].url)}`)).status, 401);
  for (const url of ['https://pbs.twimg.com/media/unknown.jpg', 'https://evil.test/media/demo.jpg']) {
    assert.equal((await fetch(`${base}/image?url=${encodeURIComponent(url)}`, { headers })).status, 403);
  }
  const image = await xBrowserThumbnail(post.media[0].url, { relayUrl: base, relayToken: token }, AbortSignal.timeout(5000));
  assert.equal(image.type, 'image');
  assert.equal(downloads, 1);
  assert.match(image.data.file, /^base64:\/\//);
  assert.equal((await sharp(Buffer.from(image.data.file.slice(9), 'base64')).metadata()).format, 'jpeg');
});

test('东京模式无需官方Key，预览不发QQ，两个凭据均不回显', async () => {
  let browserCalls = 0;
  const config = { xSearch: { ...DEFAULT_X_SEARCH_CONFIG, backend: 'tokyo-browser', enabled: true, relayToken: token } };
  const manager = new XSearchManager({ getConfig: () => config, canRun: () => true,
    request: async () => { throw new Error('不得请求官方API'); },
    browserRequest: async () => { browserCalls++; return page; }, forward: async () => { throw new Error('不得发送QQ'); } });
  assert.equal((await manager.preview('Example')).posts.length, 1);
  assert.equal(browserCalls, 1);
  assert.equal(manager.snapshot().settings.hasRelayToken, true);
  assert.doesNotMatch(JSON.stringify(manager.snapshot()), new RegExp(token));
});
