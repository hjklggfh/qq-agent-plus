import test from 'node:test';
import assert from 'node:assert/strict';
import { ensureFingerprint, fetchVideoInfo, getPlayUrl, videoDetailCaption } from '../src/features/bilibili-api.js';

const json = (body, status = 200) => new Response(JSON.stringify(body), { status });
const video = { code: 0, data: { bvid: 'BV1iFnb6tE5V', cid: 42, title: '测试视频', duration: 10, owner: { name: 'UP' } } };

test('B站元信息和播放请求复用匿名指纹，不需要登录Cookie', async (t) => {
  let reads = 0;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (url.includes('/finger/spi')) return json({ code: 0, data: { b_3: 'anonymous3', b_4: 'anonymous4' } });
    assert.equal(options.headers.Cookie, 'buvid3=anonymous3; buvid4=anonymous4');
    reads++;
    return url.includes('/playurl') ? json({ code: 0, data: { quality: 16, durl: [{ url: 'https://cdn.example/video.mp4', size: 100 }] } }) : json(video);
  });
  await ensureFingerprint({ force: true });
  const info = await fetchVideoInfo('https://www.bilibili.com/video/BV1iFnb6tE5V');
  assert.equal(info.ok, true);
  assert.equal(info.cid, 42);
  assert.equal((await getPlayUrl(info.bvid, info.cid)).ok, true);
  assert.equal(reads, 2);
});

for (const persistent of [false, true]) test(`B站412刷新匿名指纹最多一次（持续拒绝=${persistent}）`, async (t) => {
  let fingerprints = 0; let reads = 0;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (url.includes('/finger/spi')) return json({ code: 0, data: { b_3: `fp${++fingerprints}` } });
    reads++;
    assert.equal(options.headers.Cookie, `buvid3=fp${fingerprints}`);
    return persistent || reads === 1 ? json({ code: -412 }, 412) : json(video);
  });
  await ensureFingerprint({ force: true });
  const result = await fetchVideoInfo('https://www.bilibili.com/video/BV1iFnb6tE5V');
  assert.equal(result.ok, !persistent);
  assert.equal(reads, 2);
  assert.equal(fingerprints, 2);
  if (persistent) assert.match(result.error, /HTTP 412/);
});

test('匿名指纹暂不可用时仍尝试公开视频接口', async (t) => {
  t.mock.method(globalThis, 'fetch', async (url) => url.includes('/finger/spi') ? json({}, 503) : json(video));
  const fresh = await import('../src/features/bilibili-api.js?without-fingerprint');
  assert.equal((await fresh.fetchVideoInfo('https://www.bilibili.com/video/BV1iFnb6tE5V')).ok, true);
});

test('卡片详情缺失统计明确标未知，真实0值仍显示0', () => {
  const text = videoDetailCaption({ title: '标题', author: 'UP', bvid: 'BV1iFnb6tE5V', stats: { view: 0, like: 32123 } });
  assert.match(text, /播放：0 \| 弹幕：未知/);
  assert.match(text, /点赞：3.2万 \| 投币：未知/);
  assert.match(text, /https:\/\/www.bilibili.com\/video\/BV1iFnb6tE5V/);
});
