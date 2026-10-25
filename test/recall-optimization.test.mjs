import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, after } from 'node:test';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-recall-optimization-'));
process.env.QQ_AGENT_DATA_DIR = dir;
const { DEFAULT_CONFIG, setRuntimeConfig, updateConfig } = await import('../src/core/config.js');
const { ChatStore } = await import('../src/core/store.js');
const { MemoryStore } = await import('../src/memory/memory.js');
const { recallConversations } = await import('../src/memory/cross-chat-recall.js');
const { planRecallQuery } = await import('../src/memory/cross-chat-query.js');
const { memoryVisibilityOf, impressionVisible } = await import('../src/core/memory-visibility.js');
const { buildUserPrompt } = await import('../src/llm/prompt.js');
const store = new ChatStore(0, { dataDir: dir }); store.ensureIdentityLookupIndex();
const now = Date.parse('2026-10-25T09:00:00+08:00');
function cfg(patch = {}) {
  const c = structuredClone(DEFAULT_CONFIG); c.allowAllWhenEmpty = true;
  c.memory.crossChat = { ...c.memory.crossChat, enabled: true, ...patch };
  setRuntimeConfig(c); return c;
}
function context(text = '继续聊聊') {
  return { chatKey: 'group:20000', kind: 'group', store, session: {}, triggerEntries: [{ id: 100, senderId: '12345', text }],
    memory: { formatForPrompt: () => '', formatHandoffForPrompt: () => '旧的跨窗口摘要' } };
}
const past = now - 86400000;
store.appendIncoming('private:12345', { mid: '1', senderId: '12345', text: '我想找种田游戏', ts: past });
store.appendSelf('private:12345', { mid: '2', text: '游戏推荐星露谷', ts: past + 1000 });
store.appendIncoming('group:30000', { mid: '3', senderId: '12345', text: '今天喝咖啡', ts: now - 1000 });
after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });

test('topic relevance outranks a newer unrelated conversation', () => {
  const c = context('上次推荐的游戏');
  const text = recallConversations(c, {}, cfg(), now);
  assert.match(text, /种田游戏|星露谷/); assert.doesNotMatch(text, /咖啡/);
  assert.ok(text.indexOf('我想找种田游戏') < text.indexOf('游戏推荐星露谷'));
  assert.ok(c.session.crossChatRecall.totalChars <= 1200);
});
test('yesterday/private hints constrain both source and Shanghai calendar date', () => {
  const text = recallConversations(context('昨天私聊说的那个'), {}, cfg(), now);
  assert.match(text, /种田游戏/); assert.doesNotMatch(text, /今天喝咖啡/);
  const plan = planRecallQuery('昨天', now);
  assert.equal(plan.since, Date.parse('2026-10-24T00:00:00+08:00'));
  assert.equal(plan.until, Date.parse('2026-10-25T00:00:00+08:00') - 1);
  const week = planRecallQuery('上周', now);
  assert.equal(week.since, Date.parse('2026-10-12T00:00:00+08:00'));
  assert.equal(week.until, Date.parse('2026-10-19T00:00:00+08:00') - 1);
});
test('matching a confirmed bot reply works; unknown topics add no unrelated material', () => {
  assert.match(recallConversations(context(), { query: '星露谷' }, cfg(), now), /星露谷/);
  assert.equal(recallConversations(context('聊量子计算机'), {}, cfg(), now), '');
});
test('indexed keyword lookup reaches a matching older message behind 120 recent ones', () => {
  for (let i = 0; i < 130; i++) store.appendIncoming('group:30000', { mid: `noise-${i}`, senderId: '12345', text: '普通天气', ts: now - 500 + i });
  assert.match(recallConversations(context('种田游戏'), {}, cfg(), now), /种田游戏/);
});
test('same-run duplicates cost no new prompt characters, but a fresh context gets evidence again', () => {
  const c = context('种田游戏'); const config = cfg();
  assert.match(recallConversations(c, {}, config, now), /种田游戏/);
  assert.equal(recallConversations(c, { userId: '12345', query: '种田游戏' }, config, now), '');
  assert.ok(c.session.crossChatRecall.savedChars > 0);
  assert.ok(c.session.crossChatRecall.entries[1].fragments.some(f => f.reused));
  assert.match(recallConversations(context('种田游戏'), {}, config, now), /种田游戏/);
});
test('long messages expose the matching passage within even a small character budget', () => {
  store.appendIncoming('group:30000', { mid: 'long-message', senderId: '12345', text: '背景'.repeat(220) + '火星基地位于山谷。' + '无关内容'.repeat(100), ts: now - 5 });
  const text = recallConversations(context('火星基地'), {}, cfg({ maxChars: 300 }), now);
  assert.match(text, /火星基地/); assert.ok(text.length <= 300);
});
test('committed lifecycle references suppress duplicates only while the transcript exists', () => {
  const c = context('种田游戏'); const config = cfg();
  const text = recallConversations(c, {}, config, now);
  store.commitLifecycleRun({ chatKey: c.chatKey, runId: 'recall-test',
    threadOptions: { acceptedAt: Date.now(), disposition: 'active' },
    checkpointState: { summary: '续接', recallKeys: c.session.crossChatRecall.keys },
    messages: [{ role: 'user', content: text }] });
  const thread = store.getConversationThread(c.chatKey);
  assert.ok(store.getThreadTurns(thread.threadId).length > 0);
  const reopened = new ChatStore(0, { dataDir: dir });
  assert.deepEqual(reopened.latestThreadCheckpoint(c.chatKey).state.recallKeys, c.session.crossChatRecall.keys);
  reopened.close();
  const next = context('种田游戏'); next.priorRecallKeys = store.latestThreadCheckpoint(c.chatKey).state.recallKeys;
  assert.equal(recallConversations(next, {}, config, now), '');
  assert.equal(next.session.crossChatRecalled, true);
  store.closeConversationThread(c.chatKey, 'test');
  assert.match(recallConversations(context('种田游戏'), {}, config, now), /种田游戏/);
});
test('per-window source and target restrictions apply without disabling unrelated windows', () => {
  assert.equal(recallConversations(context('种田游戏'), {}, cfg({ chats: { 'private:12345': { allowSource: false } } }), now), '');
  assert.equal(recallConversations(context(), {}, cfg({ chats: { 'group:20000': { allowTarget: false } } }), now), '');
  assert.match(recallConversations(context('种田游戏'), {}, cfg({ chats: { 'group:99999': { privacy: true } } }), now), /种田游戏/);
});
test('independent privacy filters mixed impressions, both recall directions, and old summary injection', () => {
  const config = cfg({ chats: { 'private:12345': { privacy: true }, 'group:20000': { privacy: true } } });
  assert.equal(recallConversations(context(), {}, config, now), '');
  const vis = memoryVisibilityOf(config);
  assert.equal(impressionVisible({ sourceChatKeys: ['private:12345'] }, 'group:30000', vis), false);
  assert.equal(impressionVisible({ sourceChatKeys: ['private:12345', 'group:20000'] }, 'group:20000', vis), false);
  assert.equal(impressionVisible({ sourceChatKeys: ['group:20000'] }, 'group:20000', vis), true);
  assert.doesNotMatch(buildUserPrompt(context()), /旧的跨窗口摘要/);
});
test('exclusions prevent recall and old handoffs; restoring preserves source data', () => {
  cfg(); const memory = new MemoryStore();
  memory.setHandoff('group:20000', { summary: '之前的游戏跨窗口摘要' });
  assert.match(memory.formatHandoffForPrompt('group:20000'), /之前的游戏/);
  const row = store.recallPersonMessages('12345', { currentChat: 'group:20000', since: past - 1, until: now,
    query: '种田游戏', sourceAllowed: () => true })[0];
  const config = cfg({ excludedMessages: [{ chatKey: row.chatKey, id: row.id, reason: 'incorrect' }] });
  assert.equal(recallConversations(context('种田游戏'), {}, config, now), '');
  assert.equal(memory.formatHandoffForPrompt('group:20000'), '');
  assert.match(recallConversations(context('种田游戏'), {}, cfg({ excludedMessages: [] }), now), /种田游戏/);
  assert.ok(store.recent('private:12345', { limit: 5 }).length > 0);
});
test('validation rejects malformed scope rules and exclusions and accepts explicit whole-map clearing', () => {
  cfg();
  for (const crossChat of [{ chats: { x: {} } }, { chats: { 'group:20000': { privacy: 'false' } } },
    { chats: [] }, { excludedMessages: [{ chatKey: 'group:20000', id: 1, reason: 'evil' }] }]) {
    assert.throws(() => updateConfig({ memory: { crossChat } }));
  }
  updateConfig({ memory: { crossChat: { chats: { 'group:20000': { privacy: true } } } } });
  const result = updateConfig({ memory: { crossChat: { chats: { __replace__: {} } } } });
  assert.deepEqual(result.memory.crossChat.chats, {});
});
