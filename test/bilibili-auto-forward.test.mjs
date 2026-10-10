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

test('B站链接识别支持 QQ json/xml 分享卡片', () => {
  const feature = new BilibiliAutoForward({ getConfig: () => ({ bilibili: { enabled: true } }) });
  const jsonCard = JSON.stringify({
    meta: { detail_1: { title: '视频标题', qqdocurl: 'https://b23.tv/card-link' } }
  });
  assert.deepEqual(feature.extractUrlsFromSegments([
    { type: 'json', data: { data: jsonCard } },
    { type: 'xml', data: { data: '<item url="https://www.bilibili.com/video/BV1card" />' } }
  ]), [
    'https://b23.tv/card-link', 'https://www.bilibili.com/video/BV1card'
  ]);
});

test('B站链接识别支持 OneBot share/link 卡片段', () => {
  const feature = new BilibiliAutoForward({ getConfig: () => ({ bilibili: { enabled: true } }) });
  assert.deepEqual(feature.extractUrlsFromSegments([
    { type: 'share', data: { url: 'https://www.bilibili.com/video/BV1share' } },
    { type: 'link', data: { link: 'https://b23.tv/link-card' } }
  ]), [
    'https://www.bilibili.com/video/BV1share', 'https://b23.tv/link-card'
  ]);
});

test('B站配置限制有安全上限且默认关闭', () => {
  const cfg = normalizeBilibiliConfig({ bilibili: { maxDurationSeconds: 999999, maxFileBytes: 1, maxConcurrent: 99 } });
  assert.equal(cfg.enabled, false);
  assert.equal(cfg.maxDurationSeconds, 7200);
  assert.equal(cfg.maxFileBytes, 20 * 1024 * 1024);
  assert.equal(cfg.maxConcurrent, 3);
});
