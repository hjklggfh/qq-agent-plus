import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  BAILIAN_RAG_DEFAULTS,
  getBailianRagSettings,
  validateBailianRagPatch,
  rerankWithBailian,
  embedWithBailian,
  cosineSimilarity
} from '../src/memory/bailian-rag.js';

import { recallConversationsAsync } from '../src/memory/cross-chat-recall.js';
import { ChatStore } from '../src/core/store.js';
import { DEFAULT_CONFIG } from '../src/core/config.js';

test('Bailian RAG: settings parsing and environment variable override', () => {
  assert.equal(BAILIAN_RAG_DEFAULTS.embeddingModel, 'text-embedding-v3');
  assert.equal(BAILIAN_RAG_DEFAULTS.rerankModel, 'gte-rerank');
  const defaults = getBailianRagSettings({});
  assert.equal(defaults.enabled, false);
  assert.equal(defaults.apiKey, '');
  assert.equal(defaults.rerankModel, 'gte-rerank');
  assert.equal(defaults.embeddingModel, 'text-embedding-v3');
  assert.equal(defaults.topN, 5);
  assert.equal(defaults.minScore, 0.15);

  const prevEnv = process.env.DASHSCOPE_API_KEY;
  try {
    process.env.DASHSCOPE_API_KEY = 'sk-env-test-key';
    const envResolved = getBailianRagSettings({ memory: { bailian: { enabled: true } } });
    assert.equal(envResolved.enabled, true);
    assert.equal(envResolved.apiKey, 'sk-env-test-key');
  } finally {
    if (prevEnv !== undefined) process.env.DASHSCOPE_API_KEY = prevEnv;
    else delete process.env.DASHSCOPE_API_KEY;
  }
});

test('Bailian RAG: patch validation rejects bad types and bounds', () => {
  assert.throws(() => validateBailianRagPatch(null), /普通对象/);
  assert.throws(() => validateBailianRagPatch('invalid'), /普通对象/);
  assert.throws(() => validateBailianRagPatch({ enabled: 'yes' }), /布尔值/);
  assert.throws(() => validateBailianRagPatch({ apiKey: 12345 }), /字符串/);
  assert.throws(() => validateBailianRagPatch({ baseUrl: 'ftp://bad' }), /URL/);
  assert.throws(() => validateBailianRagPatch({ embeddingModel: '' }), /非空字符串/);
  assert.throws(() => validateBailianRagPatch({ rerankModel: '' }), /非空字符串/);
  assert.throws(() => validateBailianRagPatch({ topN: 0 }), /1–20/);
  assert.throws(() => validateBailianRagPatch({ topN: 25 }), /1–20/);
  assert.throws(() => validateBailianRagPatch({ minScore: -0.1 }), /0–1/);
  assert.throws(() => validateBailianRagPatch({ minScore: 1.5 }), /0–1/);

  // Valid patch passes
  validateBailianRagPatch({
    enabled: true,
    apiKey: 'sk-test-valid',
    baseUrl: 'https://dashscope.aliyuncs.com',
    embeddingModel: 'text-embedding-v3',
    rerankModel: 'gte-rerank',
    topN: 8,
    minScore: 0.25
  });
});

test('Bailian RAG: rerankWithBailian sends correct request and filters by minScore', async (t) => {
  let calledUrl = '';
  let calledHeaders = {};
  let calledBody = null;

  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calledUrl = String(url);
    calledHeaders = options.headers;
    calledBody = JSON.parse(options.body);

    return {
      ok: true,
      status: 200,
      json: async () => ({
        output: {
          results: [
            { index: 1, relevance_score: 0.92 },
            { index: 0, relevance_score: 0.12 }, // Below minScore (0.15)
            { index: 2, relevance_score: 0.65 }
          ]
        },
        usage: { total_tokens: 45 }
      })
    };
  });

  const settings = {
    apiKey: 'sk-test-rerank',
    baseUrl: 'https://dashscope.aliyuncs.com',
    rerankModel: 'gte-rerank',
    topN: 5,
    minScore: 0.15
  };

  const docs = ['昨天吃了烤肉', '我最喜欢的运动是游泳', '今天天气不错'];
  const results = await rerankWithBailian({
    query: '你喜欢游泳吗？',
    documents: docs,
    settings
  });

  assert.equal(calledUrl, 'https://dashscope.aliyuncs.com/api/v1/services/rerank/text-rerank/text-rerank');
  assert.equal(calledHeaders['Authorization'], 'Bearer sk-test-rerank');
  assert.equal(calledBody.model, 'gte-rerank');
  assert.equal(calledBody.input.query, '你喜欢游泳吗？');
  assert.deepEqual(calledBody.input.documents, docs);

  // Index 0 was 0.12 (< 0.15), so filtered out. Index 1 and 2 remain, sorted by score DESC.
  assert.equal(results.length, 2);
  assert.equal(results[0].index, 1);
  assert.equal(results[0].score, 0.92);
  assert.equal(results[1].index, 2);
  assert.equal(results[1].score, 0.65);
});

test('Bailian RAG: rerankWithBailian gracefully returns null on API errors', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => {
    return { ok: false, status: 500, text: async () => 'Internal Server Error' };
  });

  const res = await rerankWithBailian({
    query: '测试',
    documents: ['文本文本'],
    settings: { apiKey: 'sk-fail', baseUrl: 'https://dashscope.aliyuncs.com' }
  });
  assert.equal(res, null);
});

test('Bailian RAG: embedWithBailian and cosineSimilarity', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => {
    return {
      ok: true,
      status: 200,
      json: async () => ({
        object: 'list',
        data: [
          { index: 0, embedding: [1.0, 0.0] },
          { index: 1, embedding: [0.0, 1.0] }
        ]
      })
    };
  });

  const embeddings = await embedWithBailian({
    texts: ['A', 'B'],
    settings: { apiKey: 'sk-test', baseUrl: 'https://dashscope.aliyuncs.com' }
  });
  assert.equal(embeddings.length, 2);
  assert.deepEqual(embeddings[0], [1.0, 0.0]);
  assert.deepEqual(embeddings[1], [0.0, 1.0]);

  // Orthogonal vectors: similarity is 0
  assert.equal(cosineSimilarity(embeddings[0], embeddings[1]), 0);
  // Identical vectors: similarity is 1
  assert.equal(Math.round(cosineSimilarity(embeddings[0], embeddings[0])), 1);
});

test('Bailian RAG: recallConversationsAsync end-to-end semantic rerank and fallback', async (t) => {
  const caseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-bailian-rag-'));
  const store = new ChatStore(0, { dataDir: caseDir });
  t.after(() => { store.close(); fs.rmSync(caseDir, { recursive: true, force: true }); });

  const now = Date.now();
  // Insert messages into source chat
  store.appendIncoming('group:20002', { mid: '101', senderId: '12345', text: '昨天中午吃了牛肉拉面', ts: now - 3600000 });
  store.appendIncoming('group:20002', { mid: '102', senderId: '12345', text: '我最爱的运动是游泳，每周去两次', ts: now - 7200000 });
  store.appendIncoming('group:20002', { mid: '103', senderId: '12345', text: '明天下午要开部门周会', ts: now - 1800000 });

  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.allow.groups = ['20001', '20002'];
  cfg.allow.private = ['12345'];
  cfg.memory.crossChat = { enabled: true, privacy: false, maxChars: 1200, maxMessages: 4, lookbackDays: 30 };
  cfg.memory.bailian = {
    enabled: true,
    apiKey: 'sk-test-mock-key',
    baseUrl: 'https://dashscope.aliyuncs.com',
    rerankModel: 'gte-rerank',
    minScore: 0.2,
    topN: 5
  };

  // Mock fetch to simulate gte-rerank scoring: high score for swimming
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    const body = JSON.parse(options.body);
    const docs = body.input.documents;
    const swimIdx = docs.findIndex(d => d.includes('游泳'));
    return {
      ok: true,
      status: 200,
      json: async () => ({
        output: {
          results: [
            { index: swimIdx >= 0 ? swimIdx : 0, relevance_score: 0.94 },
            { index: 0, relevance_score: 0.15 } // below 0.2
          ]
        }
      })
    };
  });

  const ctx = {
    chatKey: 'group:20001',
    store,
    session: {},
    triggerEntries: [{ senderId: '12345', text: '你还记得我经常做什么运动吗？' }]
  };

  const result = await recallConversationsAsync(ctx, {}, cfg, now);
  assert.ok(result.includes('【跨对话回忆】'));
  assert.ok(result.includes('我最爱的运动是游泳'));
  assert.ok(!result.includes('牛肉拉面')); // filtered out by minScore

  // Test fallback: when API fails, falls back cleanly to keyword recall without throwing
  t.mock.restoreAll();
  t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('Connection refused');
  });

  const fallbackResult = await recallConversationsAsync(ctx, {}, cfg, now);
  // Does not throw, returns string
  assert.equal(typeof fallbackResult, 'string');
});
