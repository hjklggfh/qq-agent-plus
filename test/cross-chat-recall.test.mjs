import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, after } from 'node:test';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-cross-recall-'));
process.env.QQ_AGENT_DATA_DIR = dir;
const { DEFAULT_CONFIG, setRuntimeConfig, updateConfig } = await import('../src/core/config.js');
const { ChatStore } = await import('../src/core/store.js');
const { recallConversations } = await import('../src/memory/cross-chat-recall.js');
const { recallPolicyKey } = await import('../src/memory/cross-chat-policy.js');
const { memoryVisibilityOf, impressionVisible } = await import('../src/core/memory-visibility.js');
const { buildToolDefs, executeTool } = await import('../src/tools/tools-core.js');
const { buildUserPrompt } = await import('../src/llm/prompt.js');
const store = new ChatStore(0, { dataDir: dir });
store.ensureIdentityLookupIndex();
const now = Date.now();
function config(patch = {}) {
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.allowAllWhenEmpty = true;
  cfg.memory.crossChat = { ...cfg.memory.crossChat, enabled: true, ...patch };
  setRuntimeConfig(cfg);
  return cfg;
}
const ctx = () => ({ chatKey: 'group:20000', kind: 'group', chatId: '20000', store,
  session: {}, triggerEntries: [{ senderId: '12345', text: '昨天说的那个', id: 100 }],
  memory: { formatForPrompt: () => '', formatHandoffForPrompt: () => '旧跨窗口摘要' } });
store.appendIncoming('private:12345', { mid: '1', senderId: '12345', text: '下周去杭州看展', ts: now - 3000 });
store.appendSelf('private:12345', { mid: '2', text: '我建议上午去看展', ts: now - 2000 });
store.appendIncoming('private:99999', { mid: '3', senderId: '99999', text: '另一个人的秘密', ts: now - 1000 });
store.appendIncoming('group:30000', { mid: '4', senderId: '12345', text: '群里讨论咖啡', ts: now - 8000 });
store.appendSelf('group:30000', { mid: '5', targetUserId: '99999', text: '给别人的回答', ts: now - 7000 });
store.appendSelf('group:30000', { mid: '6', targetUserId: '12345', text: '咖啡适合上午喝', ts: now - 6000 });
store.appendIncoming('group:40000', { mid: '7', senderId: '12345', text: '游戏秘密身份', eventKind: 'game-secret', ts: now - 500 });
after(() => { store.db.close(); fs.rmSync(dir, { recursive: true, force: true }); });

test('recall brings the actual same-person exchange, not unrelated messages', () => {
  const text = recallConversations(ctx(), {}, config(), now);
  assert.match(text, /下周去杭州看展/);
  assert.match(text, /我建议上午去看展/);
  assert.match(text, /咖啡适合上午喝/);
  assert.doesNotMatch(text, /另一个人的秘密|给别人的回答|游戏秘密身份/);
  assert.ok(text.length <= 1200);
});
test('disabled, privacy and perChat prevent querying any source', () => {
  const c = ctx(); c.store = { recallPersonMessages() { throw new Error('must not query'); } };
  for (const patch of [{ enabled: false }, { privacy: true }]) assert.equal(recallConversations(c, {}, config(patch), now), '');
  const cfg = config(); cfg.memory.visibility.mode = 'perChat';
  assert.equal(recallConversations(c, {}, cfg, now), '');
});
test('deny, source allowlist, private hiding and member blocks apply', () => {
  for (const variant of ['deny', 'allow', 'private', 'member']) {
    const cfg = config();
    if (variant === 'deny') cfg.deny.private = ['12345'];
    if (variant === 'allow') cfg.allow.private = ['99999'];
    if (variant === 'private') cfg.memory.visibility.hidePrivateInGroup = true;
    if (variant === 'member') cfg.blocklist = { '20000': ['12345'] };
    assert.doesNotMatch(recallConversations(ctx(), {}, cfg, now), /杭州|看展/);
  }
});
test('keyword retrieval and current-speaker binding', () => {
  const cfg = config();
  const text = recallConversations(ctx(), { userId: '12345', query: '咖啡' }, cfg, now);
  assert.match(text, /咖啡适合上午喝/); assert.doesNotMatch(text, /杭州/);
  assert.equal(recallConversations(ctx(), { userId: '99999' }, cfg, now), '');
  assert.equal(recallConversations(ctx(), { query: '完全不存在的词' }, cfg, now), '');
});
test('retention, total cap, token saver and no extra speakers', () => {
  const cfg = config({ maxChars: 300, maxMessages: 2, lookbackDays: 1 });
  assert.ok(recallConversations(ctx(), {}, cfg, now).length <= 300);
  assert.equal(recallConversations(ctx(), {}, cfg, now + 2 * 86400000), '');
  cfg.tokenSaver.mode = 'aggressive'; cfg.memory.crossChat.maxChars = 3000;
  assert.ok(recallConversations(ctx(), {}, cfg, now).length <= 600);
  assert.equal(recallConversations({ ...ctx(), triggerEntries: [] }, {}, cfg, now), '');
});
test('privacy excludes mixed-source impressions and old handoff/checkpoint prompt', () => {
  config({ privacy: true });
  const vis = memoryVisibilityOf();
  assert.equal(impressionVisible({ sourceChatKeys: ['group:20000', 'private:12345'] }, 'group:20000', vis), false);
  assert.equal(impressionVisible({ sourceChatKeys: ['group:20000'] }, 'group:20000', vis), true);
  const prompt = buildUserPrompt(ctx());
  assert.doesNotMatch(prompt, /旧跨窗口摘要|下周去杭州|跨对话回忆/);
});
test('prompt injects recall and records provenance flag; empty results inject nothing', () => {
  config(); const c = ctx();
  assert.match(buildUserPrompt(c), /下周去杭州看展/);
  assert.equal(c.session.crossChatRecalled, true);
  c.triggerEntries = [{ senderId: '88888', text: '你好', id: 101 }];
  assert.doesNotMatch(buildUserPrompt(c), /【跨对话回忆】/);
});
test('live policy changes reject stale tool execution before effects', async () => {
  const cfg = config(); const c = ctx(); c.recallPolicyKey = recallPolicyKey(cfg);
  let writes = 0;
  config({ privacy: true });
  const result = await executeTool([{ name: 'probe', execute() { writes++; } }], c, 'probe', '{}');
  assert.equal(result.isError, true); assert.equal(writes, 0);
});
test('recall cannot be laundered into a current-chat impression; tool queries are bounded', async () => {
  config(); const c = ctx(); const defs = buildToolDefs();
  recallConversations(c);
  const result = await executeTool(defs, c, 'memory_append', '{"userId":"12345","content":"跨窗口内容"}');
  assert.equal(result.isError, true);
  for (let i = 0; i < 2; i++) assert.notEqual((await executeTool(defs, c, 'recall_conversations', '{"userId":"12345"}')).isError, true);
  assert.equal((await executeTool(defs, c, 'recall_conversations', '{"userId":"12345"}')).isError, true);
});
test('configuration validation rejects wrong types, replacements and unsafe bounds', () => {
  config();
  for (const crossChat of [{ enabled: 'false' }, { privacy: 'false' }, { maxChars: 999999 }, { maxMessages: 0 }, { lookbackDays: -1 }, null, { __replace__: { privacy: false } }]) {
    assert.throws(() => updateConfig({ memory: { crossChat } }));
  }
  updateConfig({ memory: { crossChat: { enabled: true, privacy: true, maxChars: 600 } } });
});
