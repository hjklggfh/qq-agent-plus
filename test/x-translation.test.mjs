import assert from 'node:assert/strict';
import test from 'node:test';
import { needsChineseTranslation, XPostTranslator } from '../src/features/x-search/translation.js';
import { xCardNodes, XSearchManager } from '../src/features/x-search/manager.js';
import { DEFAULT_X_SEARCH_CONFIG } from '../src/features/x-search/config.js';

const post = (id, text, sensitive = false) => ({ id, text, sensitive, url: `https://x.com/Example/status/${id}`, media: [], createdAt: '2026-10-23T02:00:00Z' });
const page = { user: { username: 'Example', name: 'Example' }, posts: [post('1', 'Hello world!'), post('2', '这是中文，API 已开放。'), post('3', '今日は良い天気'), post('4', 'Secret text', true)], next: '', fetchedAt: new Date().toISOString() };

test('非中文批量翻译仅发送可展示正文，保留原文，按ID关联并缓存，清除CQ注入', async () => {
  for (const text of ['中文内容', 'https://x.com/Example ❤️', '📷 #photo @Example']) assert.equal(needsChineseTranslation(text), false);
  for (const text of ['Hello!', '今日は晴れ', '안녕하세요', 'Bonjour', 'Привет']) assert.equal(needsChineseTranslation(text), true);
  let calls = 0;
  const translator = new XPostTranslator(async (args) => {
    calls++; assert.equal(args.tools, null); assert.equal(args.signal.aborted, false);
    assert.deepEqual(JSON.parse(args.messages[1].content).map(p => p.id), ['1', '3']);
    return { message: { content: JSON.stringify([{ id: '3', text: '今天天气很好' }, { id: '1', text: '你好，世界[CQ:image,file=bad]' }]) } };
  });
  const translated = await translator.translate(page);
  assert.equal(translated.posts[0].text, 'Hello world!'); assert.equal(page.posts[0].translation, undefined);
  assert.equal(translated.posts[2].translation, '今天天气很好'); assert.equal(translated.posts[3].translation, undefined);
  const nodes = await xCardNodes(translated);
  assert.match(nodes[0].data.content[0].data.text, /Hello world![\s\S]*中文翻译（机器翻译）[\s\S]*你好/);
  assert.doesNotMatch(JSON.stringify(nodes), /\[CQ:|Secret text/);
  await translator.translate(page); assert.equal(calls, 1);
  translator.clear(); await translator.translate(page); assert.equal(calls, 2);
});

test('翻译异常或错误ID不影响原文，敏感正文不泄露，取消仍停止', async () => {
  for (const complete of [async () => { throw new Error('offline'); }, async () => ({ message: { content: '[{"id":"wrong","text":"错误"}]' } })]) {
    const result = await new XPostTranslator(complete).translate(page);
    assert.equal(result.posts[0].translationUnavailable, true); assert.equal(result.posts[1].translationUnavailable, undefined);
    assert.match((await xCardNodes(result))[0].data.content[0].data.text, /Hello world![\s\S]*翻译暂不可用/);
  }
  await assert.rejects(new XPostTranslator(async () => { throw new Error(); }).translate(page, AbortSignal.abort()), /abort/i);
});

test('配置关闭不调用翻译，启用后QQ与网页预览均附译文，预览不发送QQ', async () => {
  const config = { xSearch: { ...DEFAULT_X_SEARCH_CONFIG, enabled: true, backend: 'tokyo-browser', relayToken: 't'.repeat(48), translateChinese: false } };
  let calls = 0;
  const manager = new XSearchManager({ getConfig: () => config, canRun: () => true, browserRequest: async () => page,
    complete: async () => { calls++; return { message: { content: '[{"id":"1","text":"你好世界"},{"id":"3","text":"今天天气很好"}]' } }; },
    forward: async () => { throw new Error('预览不能发送'); } });
  assert.equal((await manager.preview('Example')).posts[0].translation, undefined); assert.equal(calls, 0);
  config.xSearch.translateChinese = true; manager.cooldowns.clear();
  assert.equal((await manager.preview('Example')).posts[0].translation, '你好世界'); assert.equal(calls, 1);
});

test('多图帖子发送全部四张，逐张处理且单图失败不吞掉后续图片', async () => {
  const photos = Array.from({ length: 4 }, (_, i) => ({ type: 'photo', url: `https://pbs.twimg.com/media/${i}.jpg` }));
  const imagePage = { ...page, posts: [{ ...post('10', '多图'), media: photos }] };
  let active = 0; let peak = 0; const calls = [];
  const nodes = await xCardNodes(imagePage, { includeImages: true, thumbnail: async (url) => {
    calls.push(url); active++; peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, 2)); active--;
    if (url.endsWith('/1.jpg')) throw new Error('broken');
    return { type: 'image', data: { file: 'base64://fixture' } };
  } });
  assert.equal(calls.length, 4); assert.equal(peak, 1);
  assert.equal(nodes[0].data.content.filter(s => s.type === 'image').length, 3);
  assert.match(JSON.stringify(nodes), /图片暂不可用/);
});
