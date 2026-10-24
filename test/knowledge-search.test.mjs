import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, after } from 'node:test';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-knowledge-'));
process.env.QQ_AGENT_DATA_DIR = dir;
const { createKnowledgeSearch, cleanMemeTerm, knowledgeSettings } = await import('../src/llm/knowledge-search.js');
const { DEFAULT_CONFIG, setRuntimeConfig, updateConfig } = await import('../src/core/config.js');
const { buildToolDefs, executeTool } = await import('../src/tools/tools-core.js');
after(() => fs.rmSync(dir, { recursive: true, force: true }));
const settings = { enabled: true, maxEntries: 2, summaryChars: 200, hotLimit: 3 };

test('natural-language term cleanup preserves actual keyword and valid unicode', () => {
  assert.equal(cleanMemeTerm('「尊嘟假嘟」是什么意思？'), '尊嘟假嘟');
  assert.equal(cleanMemeTerm('鸡你太美是什么梗？'), '鸡你太美');
  assert.equal(cleanMemeTerm('😀'.repeat(100)).isWellFormed(), true);
});
test('bounded extracts, redirects, sources, cloning and cache expiry', async () => {
  let calls = 0; let now = 1000;
  const search = createKnowledgeSearch({ now: () => now, request: async url => {
    calls++;
    const u = new URL(url);
    if (u.searchParams.get('action') === 'opensearch') return ['term', ['别名', '另一个'], [], ['http://127.0.0.1/secret']];
    assert.equal(u.searchParams.get('exchars'), '200');
    return { query: { redirects: [{ from: '别名', to: '正文' }], pages: [
      { title: '正文', extract: '😀'.repeat(300) }, { title: '另一个', extract: '独立释义' }
    ] } };
  } });
  const first = await search.lookup('梗', settings);
  assert.equal(first.entries[0].title, '正文');
  assert.equal(first.entries[0].text.length, 200);
  assert.equal(first.entries[0].text.isWellFormed(), true);
  assert.match(first.entries[0].url, /^https:\/\/zh.moegirl.org.cn\//);
  first.entries[0].text = 'mutated';
  assert.notEqual((await search.lookup('梗', settings)).entries[0].text, 'mutated');
  assert.equal(calls, 2);
  now += 600001;
  await search.lookup('梗', settings); assert.equal(calls, 4);
});
test('primary extract failure falls back to mirror instead of stopping at titles', async () => {
  const hosts = [];
  const search = createKnowledgeSearch({ request: async url => {
    const u = new URL(url); hosts.push(u.hostname);
    if (u.searchParams.get('action') === 'opensearch') return ['', ['词条']];
    if (u.hostname === 'zh.moegirl.org.cn') throw new Error('403');
    return { query: { pages: [{ title: '词条', extract: '镜像正文' }] } };
  } });
  const result = await search.lookup('词条', settings);
  assert.equal(result.source, 'moegirl.uk');
  assert.equal(result.titlesOnly, false);
  assert.equal(hosts.length, 4);
});
test('title-only response never implies a verified definition; empty sources degrade explicitly', async () => {
  const search = createKnowledgeSearch({ request: async url => {
    if (new URL(url).searchParams.get('action') === 'opensearch') return ['', ['词条']];
    return { query: { pages: [] } };
  } });
  const result = await search.lookup('词条', settings);
  assert.equal(result.titlesOnly, true); assert.match(result.note, /不能据此断言/);
  const empty = createKnowledgeSearch({ request: async () => { throw new Error('offline'); } });
  assert.equal((await empty.lookup('词条', settings)).entries.length, 0);
});
test('hot topics return partial data with bounded lists, links and unavailable source', async () => {
  const search = createKnowledgeSearch({ request: async url => {
    if (url.includes('square')) throw new Error('412');
    return { data: { list: Array.from({ length: 30 }, () => ({ title: '热门'.repeat(200), bvid: 'BV1234', owner: { name: '作者' } })) } };
  } });
  const result = await search.hot(settings);
  assert.deepEqual(result.unavailable, ['热搜']);
  assert.equal(result.videos.length, 3); assert.equal(result.videos[0].title.length, 120);
  assert.match(result.videos[0].url, /BV1234/);
});
test('abort is propagated without mirror retry', async () => {
  const controller = new AbortController(); let calls = 0;
  const search = createKnowledgeSearch({ request: async () => { calls++; controller.abort(new Error('cancelled')); throw new Error('cancelled'); } });
  await assert.rejects(search.lookup('词条', settings, controller.signal), /cancelled/);
  assert.equal(calls, 1);
});
test('settings clamp token budget and reject invalid API patches', () => {
  setRuntimeConfig(structuredClone(DEFAULT_CONFIG));
  assert.equal(knowledgeSettings({ webSearch: { enabled: false } }).enabled, false);
  assert.equal(knowledgeSettings({ webSearch: { knowledge: { summaryChars: 100000 } } }).summaryChars, 1200);
  for (const knowledge of [null, { enabled: 'false' }, { summaryChars: 100000 }, { maxEntries: 0 }, { hotLimit: 99 }]) {
    assert.throws(() => updateConfig({ webSearch: { knowledge } }));
  }
});
test('disabled tools enforce gates even if a stale schema calls them', async () => {
  const cfg = structuredClone(DEFAULT_CONFIG); cfg.webSearch.enabled = false; setRuntimeConfig(cfg);
  const defs = buildToolDefs();
  for (const name of ['meme_lookup', 'hot_topics']) {
    const result = await executeTool(defs, { session: {} }, name, '{"term":"词条"}');
    assert.equal(result.isError, true);
  }
});
