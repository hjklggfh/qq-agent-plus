import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { meituCommand } from '../src/features/pixiv/command.js';
import { DEFAULT_PIXIV_CONFIG, pixivConfig, validatePixivPatch } from '../src/features/pixiv/config.js';
import { PixivManager } from '../src/features/pixiv/manager.js';

const PNG_1X1 = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000000020001e221bc330000000049454e44ae426082',
  'hex'
);

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' }
  });
}

function imageResponse(buf, { status = 200, contentType = 'image/png', contentLength = null } = {}) {
  const headers = { 'content-type': contentType };
  if (contentLength !== null) headers['content-length'] = String(contentLength);
  return new Response(buf, { status, headers });
}

test('meituCommand 只匹配 /美图 与 /美图 <关键词>', () => {
  assert.deepEqual(meituCommand('/美图'), { mode: 'meitu', keyword: '' });
  assert.deepEqual(meituCommand('  /美图   碧蓝档案  '), { mode: 'meitu', keyword: '碧蓝档案' });
  assert.deepEqual(meituCommand('/美图 初音未来   水着'), { mode: 'meitu', keyword: '初音未来 水着' });
  assert.equal(meituCommand('/美图秀秀'), null);
  assert.equal(meituCommand('美图'), null);
  assert.equal(meituCommand('PID 113383502'), null);
});

test('config 默认全关并严格校验美图配置', () => {
  const cfg = pixivConfig();
  assert.deepEqual(cfg.meituGroups, []);
  assert.equal(cfg.meituAllowPrivate, false);
  assert.equal(cfg.meituCooldownSeconds, 10);
  assert.equal(cfg.meituMaxImageBytes, 15 * 1024 * 1024);
  assert.equal(DEFAULT_PIXIV_CONFIG.meituGroups.length, 0);

  assert.doesNotThrow(() => validatePixivPatch({
    meituGroups: ['747206342', '892485992'],
    meituAllowPrivate: true,
    meituCooldownSeconds: 10,
    meituMaxImageBytes: 15 * 1024 * 1024
  }));
  assert.throws(() => validatePixivPatch({ meituGroups: ['bad'] }), /群白名单/);
  assert.throws(() => validatePixivPatch({ meituCooldownSeconds: -1 }), /meituCooldownSeconds/);
  assert.throws(() => validatePixivPatch({ meituMaxImageBytes: 1024 }), /meituMaxImageBytes/);
});

test('默认全关：未授权群静默忽略，不发请求不发消息', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pixiv-meitu-closed-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  let fetched = 0;
  let sentImages = 0;
  const manager = new PixivManager({
    dataDir,
    getConfig: () => ({ pixiv: { enabled: true, ratings: ['safe', 'r18'], meituGroups: [] } }),
    updateConfig: () => {},
    canRun: () => true,
    onebot: { selfId: '999999' },
    image: async () => { sentImages += 1; },
    send: async () => {},
    forward: async () => {},
    fetchImpl: async () => { fetched += 1; throw new Error('should not fetch'); }
  });
  t.after(() => manager.stop());

  assert.equal(manager.meituAllowed('group:747206342'), false);
  assert.equal(manager.meituAllowed('private:2118530760'), false);
  const res = await manager.startMeitu({ mode: 'meitu', keyword: '' }, 'group:747206342', '101', 50001);
  assert.equal(res.ignored, true);
  assert.equal(fetched, 0);
  assert.equal(sentImages, 0);
});

test('/美图 强制全年龄、优先无损原图不走压缩中转、单条引用图文回复且10s冷却有效', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pixiv-meitu-ok-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const requests = [];
  const sentImages = [];
  const sentTexts = [];
  const sentFiles = [];

  const manager = new PixivManager({
    dataDir,
    getConfig: () => ({
      pixiv: {
        enabled: true,
        outputFormat: 'pdf',
        ratings: ['safe', 'r18', 'r18g'],
        chatRatings: { 'group:747206342': ['safe', 'r18', 'r18g'] },
        imageRelayUrl: 'http://127.0.0.1:3222/image',
        downsampleOverBytes: 1,
        meituGroups: ['747206342'],
        meituCooldownSeconds: 10,
        meituMaxImageBytes: 15 * 1024 * 1024
      }
    }),
    updateConfig: () => {},
    canRun: () => true,
    onebot: { selfId: '999999' },
    image: async (chatKey, payload, opts) => { sentImages.push({ chatKey, payload, opts }); },
    send: async (chatKey, msgs) => { sentTexts.push({ chatKey, msgs }); },
    file: async (chatKey, payload) => { sentFiles.push({ chatKey, payload }); },
    forward: async () => { throw new Error('should not use forward'); },
    fetchImpl: async (url) => {
      requests.push(String(url));
      if (String(url).startsWith('https://api.lolicon.app/setu/v2')) {
        const u = new URL(url);
        assert.equal(u.searchParams.get('r18'), '0');
        assert.equal(u.searchParams.get('tag'), '碧蓝档案');
        assert.deepEqual(u.searchParams.getAll('size').slice(0, 2), ['original', 'regular']);
        return jsonResponse({
          error: '',
          data: [
            {
              pid: 99900001,
              title: 'R18应该被过滤',
              author: 'bad',
              r18: true,
              tags: ['R-18'],
              urls: { original: 'https://i.pixiv.re/img-original/img/2026/01/01/00/00/00/99900001_p0.png' }
            },
            {
              pid: 113383502,
              title: '水着マリー',
              author: 'のみお',
              r18: false,
              tags: ['ブルーアーカイブ', '碧蓝档案', '伊落マリー', '水着'],
              urls: {
                original: 'https://i.pixiv.re/img-original/img/2023/11/14/00/00/00/113383502_p0.png',
                regular: 'https://i.pixiv.re/img-master/img/2023/11/14/00/00/00/113383502_p0_master1200.jpg'
              }
            }
          ]
        });
      }
      if (String(url).includes('113383502_p0.png')) {
        return imageResponse(PNG_1X1);
      }
      throw new Error(`unexpected fetch: ${url}`);
    }
  });
  t.after(() => manager.stop());

  const res = await manager.startMeitu({ mode: 'meitu', keyword: '碧蓝档案' }, 'group:747206342', '201', 88001);
  assert.equal(res.isError, undefined);
  assert.equal(sentTexts.length, 0);
  assert.equal(sentFiles.length, 0);
  assert.equal(sentImages.length, 1);
  assert.equal(sentImages[0].opts.replyToMessageId, 88001);
  assert.equal(sentImages[0].payload.url, `base64://${PNG_1X1.toString('base64')}`);
  assert.equal(
    sentImages[0].payload.text,
    '标题: 水着マリー\n作者: のみお\n标签: ブルーアーカイブ、碧蓝档案、伊落マリー、水着\nPID: 113383502'
  );
  assert.ok(requests.every((u) => !u.includes('/image')));

  // 10s 冷却拦截
  const second = await manager.startMeitu({ mode: 'meitu', keyword: '' }, 'group:747206342', '202', 88002);
  assert.equal(second.isError, true);
  assert.match(second.content, /过于频繁/);
});

test('方案 A：原图超过 15MB 上限时自动回退同一作品官方 regular 高清图', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pixiv-meitu-fallback-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const fetchedUrls = [];
  const sentImages = [];

  const manager = new PixivManager({
    dataDir,
    getConfig: () => ({
      pixiv: {
        enabled: false, // 验证独立于 PID 总开关也可工作
        meituGroups: ['892485992'],
        meituCooldownSeconds: 0,
        meituMaxImageBytes: 15 * 1024 * 1024
      }
    }),
    updateConfig: () => {},
    canRun: () => true,
    onebot: { selfId: '999999' },
    image: async (chatKey, payload, opts) => { sentImages.push({ chatKey, payload, opts }); },
    send: async () => {},
    forward: async () => {},
    fetchImpl: async (url) => {
      fetchedUrls.push(String(url));
      if (String(url).startsWith('https://api.lolicon.app/setu/v2')) {
        const u = new URL(url);
        assert.equal(u.searchParams.has('tag'), false);
        assert.equal(u.searchParams.has('keyword'), false);
        return jsonResponse({
          error: '',
          data: [{
            pid: 148421698,
            title: 'Phantom',
            author: 'anon',
            r18: false,
            tags: ['NIKKE'],
            urls: {
              original: 'https://i.pixiv.re/img-original/img/2026/08/14/20/15/50/148421698_p0.png',
              regular: 'https://i.pixiv.re/img-master/img/2026/08/14/20/15/50/148421698_p0_master1200.jpg'
            }
          }]
        });
      }
      if (String(url).includes('img-original')) {
        return imageResponse(PNG_1X1, { contentLength: 20 * 1024 * 1024 });
      }
      if (String(url).includes('img-master')) {
        return imageResponse(PNG_1X1, { contentType: 'image/jpeg' });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }
  });
  t.after(() => manager.stop());

  const res = await manager.startMeitu({ mode: 'meitu', keyword: '' }, 'group:892485992', '301', 99001);
  assert.equal(res.isError, undefined);
  assert.equal(sentImages.length, 1);
  assert.ok(fetchedUrls.some((u) => u.includes('img-original')));
  assert.ok(fetchedUrls.some((u) => u.includes('img-master')));
  assert.match(sentImages[0].payload.text, /PID: 148421698/);
});
