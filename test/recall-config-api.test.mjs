import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-recall-api-'));
process.env.QQ_AGENT_DATA_DIR = root;
const { DEFAULT_CONFIG, updateConfig } = await import('../src/core/config.js');
const { createApp } = await import('../src/console/app.js');
const { recallConversations } = await import('../src/memory/cross-chat-recall.js');

test('authenticated settings round-trip, privacy cancels old runs and closes persisted context', async t => {
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.server = { ...cfg.server, host: '127.0.0.1', port: 22498, token: 'recall-test-token' };
  cfg.runtime.mode = 'observe';
  cfg.allow.groups = ['10001']; cfg.allow.private = ['12345'];
  cfg.onebot.wsUrl = 'ws://127.0.0.1:1'; cfg.onebot.httpUrl = 'http://127.0.0.1:1';
  updateConfig(cfg);
  const app = createApp({ log: () => {} });
  t.after(async () => { await app.stop(); fs.rmSync(root, { recursive: true, force: true }); });
  await app.start();
  const request = async (body, authenticated = true, route = '/api/config') => {
    const response = await fetch(`http://127.0.0.1:22498${route}`, {
      method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json', ...(authenticated ? { 'x-console-token': 'recall-test-token' } : {}) },
      body: body ? JSON.stringify(body) : undefined
    });
    return { status: response.status, body: await response.json() };
  };
  assert.equal((await request(undefined, false)).status, 401);
  for (const route of ['/api/recall-traces', '/api/recall-traces/fake']) assert.equal((await request(undefined, false, route)).status, 401);
  assert.equal((await request({ confirm: true }, false, '/api/recall-exclusions')).status, 401);
  assert.equal((await request({ memory: { crossChat: { enabled: true, privacy: false } } })).status, 200);
  app.store.appendIncoming('private:12345', { mid: '1', senderId: '12345', text: '待纠错的咖啡片段', ts: Date.now() - 1000 });
  const session = app.sessions.create({ chatKey: 'group:10001', trigger: [], triggerSummary: 'test' });
  const recallContext = () => ({ chatKey: 'group:10001', session: {}, store: app.store, triggerEntries: [{ senderId: '12345', text: '咖啡' }] });
  const firstContext = recallContext(); firstContext.session = session;
  assert.match(recallConversations(firstContext), /待纠错的咖啡/);
  app.sessions.update(session.id);
  const traces = (await request(undefined, true, '/api/recall-traces')).body;
  assert.equal(traces.sessions[0].id, session.id);
  assert.ok(traces.sessions[0].chars > 0);
  const detail = (await request(undefined, true, `/api/recall-traces/${session.id}`)).body;
  const ref = detail.recall.entries[0].fragments[0];
  const action = { action: 'exclude', confirm: true, sessionId: session.id, chatKey: ref.chatKey, id: ref.id, reason: 'incorrect' };
  assert.equal((await request({ ...action, confirm: false }, true, '/api/recall-exclusions')).status, 409);
  assert.equal((await request({ ...action, id: 99999 }, true, '/api/recall-exclusions')).status, 400);
  assert.equal((await request(action, true, '/api/recall-exclusions')).status, 200);
  assert.equal(recallConversations(recallContext()), '');
  assert.equal((await request({ ...action, action: 'restore' }, true, '/api/recall-exclusions')).status, 200);
  assert.match(recallConversations(recallContext()), /待纠错的咖啡/);
  app.store.appendIncoming('group:10001', { mid: '1', senderId: '12345', text: 'hi' });
  const controller = new AbortController(); app.orchestrator.controllers.set('group:10001', controller);
  let closed = 0;
  const close = app.store.closeConversationThread.bind(app.store);
  app.store.closeConversationThread = (key, reason) => { if (reason === 'memory-policy-changed') closed++; return close(key, reason); };
  assert.equal((await request({ memory: { crossChat: { privacy: true } }, webSearch: { knowledge: { summaryChars: 500 } } })).status, 200);
  assert.equal(controller.signal.aborted, true); assert.ok(closed > 0);
  const actual = (await request()).body;
  assert.equal(actual.memory.crossChat.privacy, true);
  assert.equal(actual.memory.crossChat.enabled, true);
  assert.equal(actual.webSearch.knowledge.summaryChars, 500);
  assert.equal(app.store.recent('group:10001', { limit: 1 }).length, 1);
  app.orchestrator.controllers.delete('group:10001');
});
