import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { BilibiliAutoForward } from '../src/features/bilibili-auto-forward.js';

test('seed-asr：pump 定时回调内不再调用会同步抛错的 throwIfAborted', () => {
  const src = fs.readFileSync(new URL('../src/llm/seed-asr.js', import.meta.url), 'utf8');
  const start = src.indexOf('const pump = () =>');
  const pumpBlock = src.slice(start, src.indexOf('setTimeout(pump, 20)', start));
  assert.doesNotMatch(pumpBlock, /throwIfAborted/, 'pump 异步回调中抛出的异常会变成 uncaughtException');
  assert.match(pumpBlock, /signal\?\.aborted[\s\S]*finish\(reject/);
});

test('BilibiliAutoForward：enqueue 会清理 6 小时前的过期去重记录并限制上限', () => {
  const forward = new BilibiliAutoForward({
    getConfig: () => ({ enabled: true, maxConcurrent: 0 }),
    sender: { sendTextBatch: async () => ({ sentCount: 1, failed: [] }) },
    log: { info: () => {}, warn: () => {} },
  });
  forward.seen.set('group:1|https://www.bilibili.com/video/BV1old', Date.now() - 7 * 3600_000);
  forward.pump = () => {};
  forward.enqueue({
    chatKey: 'group:1',
    url: 'https://www.bilibili.com/video/BV1new',
    messageId: 'm1',
    cfg: { maxConcurrent: 1 },
  });
  assert.equal(forward.seen.has('group:1|https://www.bilibili.com/video/BV1old'), false);
  assert.equal(forward.seen.has('group:1|https://www.bilibili.com/video/BV1new'), true);
});
