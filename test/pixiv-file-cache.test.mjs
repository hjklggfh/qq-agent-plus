import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PixivFileCache, cacheKey } from '../src/features/pixiv/file-cache.js';

test('文件缓存受容量与期限约束，损坏条目失效，清理不动其他状态', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pixiv-cache-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const settings = { cacheEnabled: true, cacheTtlHours: 1, cacheMaxBytes: 1000 };
  let now = 0;
  const cache = new PixivFileCache(path.join(dir, 'cache'), () => settings, () => now);
  const source = path.join(dir, 'source'), output = path.join(dir, 'copy');
  fs.writeFileSync(source, Buffer.alloc(400, 1)); fs.writeFileSync(path.join(dir, 'ratings.json'), 'keep');
  const first = cacheKey('first'), second = cacheKey('second');
  assert.equal(cache.put(first, source, { pages: [1] }), true);
  const hit = cache.get(first, output, 500);
  assert.deepEqual(hit.pages, [1]); assert.equal(fs.statSync(output).size, 400);
  now += 10; assert.equal(cache.put(second, source), true);
  assert.equal(cache.get(first, output, 500), null); assert.ok(cache.sweep().bytes <= 1000);
  fs.writeFileSync(path.join(dir, 'cache', second, 'data'), Buffer.alloc(400, 2));
  assert.equal(cache.get(second, output, 500), null);
  assert.equal(cache.put(first, source), true);
  now += 3600001; assert.equal(cache.sweep().entries, 0);
  assert.equal(fs.readFileSync(path.join(dir, 'ratings.json'), 'utf8'), 'keep');
  settings.cacheEnabled = false; assert.equal(cache.put(first, source), false);
});

test('缓存设置身份用哈希区分，禁用时不读取文件，未启动功能不建目录', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pixiv-cache-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const root = path.join(dir, 'cache');
  const cache = new PixivFileCache(root, () => ({ cacheEnabled: false, cacheTtlHours: 24, cacheMaxBytes: 1000 }));
  cache.sweep(); assert.equal(fs.existsSync(root), false);
  assert.equal(cache.get(cacheKey('x'), path.join(dir, 'out'), 100), null);
  assert.equal(fs.existsSync(root), false);
  assert.notEqual(cacheKey({ size: 'regular', cookie: 'a' }), cacheKey({ size: 'regular', cookie: 'b' }));
  assert.match(cacheKey({ cookie: 'private' }), /^[a-f0-9]{64}$/);
});
