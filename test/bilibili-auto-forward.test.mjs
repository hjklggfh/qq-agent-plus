import test from 'node:test';
import assert from 'node:assert/strict';
import { BilibiliAutoForward, normalizeBilibiliConfig } from '../src/features/bilibili-auto-forward.js';

test('B站链接识别支持主站、短链并去重', () => {
  const feature = new BilibiliAutoForward({ getConfig: () => ({ bilibili: { enabled: true } }) });
  assert.deepEqual(feature.extractUrls('https://www.bilibili.com/video/BV1xx https://b23.tv/abc https://b23.tv/abc'), [
    'https://www.bilibili.com/video/BV1xx', 'https://b23.tv/abc'
  ]);
  assert.deepEqual(feature.extractUrls('https://example.com/video'), []);
});

test('B站配置限制有安全上限且默认关闭', () => {
  const cfg = normalizeBilibiliConfig({ bilibili: { maxDurationSeconds: 999999, maxFileBytes: 1, maxConcurrent: 99 } });
  assert.equal(cfg.enabled, false);
  assert.equal(cfg.maxDurationSeconds, 7200);
  assert.equal(cfg.maxFileBytes, 20 * 1024 * 1024);
  assert.equal(cfg.maxConcurrent, 3);
});
