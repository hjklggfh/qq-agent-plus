import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { rememberSearchPage, clearSearchSessions } from '../src/features/jm-suomingor/search-session.js';

const dir = fs.mkdtempSync(path.join(process.cwd(), '.jm-direct-ingest-test-'));
process.env.QQ_AGENT_DATA_DIR = dir;
process.on('exit', () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* SQLite may still hold a file */ } });

test('JM 直接指令等待发送时已被消费，不再交给普通聊天模型', async (t) => {
  const { createApp } = await import('../src/console/app.js');
  const { DEFAULT_CONFIG, setRuntimeConfig } = await import('../src/core/config.js');
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.runtime.mode = 'active';
  cfg.runtime.paused = false;
  cfg.allow.private = ['123456'];
  cfg.jm.enabled = true;
  cfg.sticker.autoCollect = false;
  setRuntimeConfig(cfg);
  const app = createApp({ log: () => {} });
  t.after(() => app.stop());
  let wakes = 0;
  let releaseSend;
  app.orchestrator.onIncoming = () => { wakes += 1; };
  app.sender.sendTextBatch = async () => new Promise((resolve) => {
    releaseSend = () => resolve({ sent: [{ text: '错误提示' }], failed: [] });
  });
  const incoming = app.onebot.onEvent({
    post_type: 'message', message_type: 'private', user_id: 123456,
    message_id: 1001, time: Math.floor(Date.now() / 1000),
    sender: { user_id: 123456, nickname: '用户' },
    message: `JM搜索 ${'词'.repeat(61)}`
  });
  for (let i = 0; i < 100 && !releaseSend; i++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(typeof releaseSend, 'function', 'JM 错误提示已进入发送阶段');
  assert.equal(app.store.unreadCount('private:123456'), 0, '异步发送期间已标记为已读');
  assert.equal(wakes, 0, '普通编排器没有被唤醒');
  releaseSend();
  await incoming;
  assert.equal(wakes, 0);
});

test('白名单群内紧贴 @ 的 JM 搜索指令由直接入口处理', async (t) => {
  const { createApp } = await import('../src/console/app.js');
  const { DEFAULT_CONFIG, setRuntimeConfig } = await import('../src/core/config.js');
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.runtime.mode = 'active';
  cfg.runtime.paused = false;
  cfg.allow.groups = ['100001'];
  cfg.jm.enabled = true;
  cfg.sticker.autoCollect = false;
  setRuntimeConfig(cfg);
  const app = createApp({ log: () => {} });
  t.after(() => app.stop());
  let wakes = 0;
  const sent = [];
  app.orchestrator.onIncoming = () => { wakes += 1; };
  app.sender.sendTextBatch = async (chatKey, messages) => {
    sent.push({ chatKey, messages });
    return { sent: messages.map((text) => ({ text })), failed: [] };
  };
  const search = `JM搜索 ${'词'.repeat(61)}`;
  await app.onebot.onEvent({
    post_type: 'message', message_type: 'group', group_id: 100001, user_id: 123456,
    message_id: 1003, time: Math.floor(Date.now() / 1000),
    sender: { user_id: 123456, nickname: '群友' },
    message: [{ type: 'at', data: { qq: '987654' } }, { type: 'text', data: { text: search } }]
  });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].chatKey, 'group:100001');
  assert.match(sent[0].messages[0], /1～60 字/);
  assert.equal(wakes, 0, '固定指令不会再交给聊天模型');
  assert.equal(app.store.unreadCount('group:100001'), 0);
  await app.onebot.onEvent({
    post_type: 'message', message_type: 'group', group_id: 100001, user_id: 123456,
    message_id: 1006, time: Math.floor(Date.now() / 1000),
    sender: { user_id: 123456, nickname: '群友' },
    message: `[CQ:at,qq=987654]${search}`
  });
  assert.equal(sent.length, 2, 'CQ 字符串格式的 @ 同样能识别');
  await app.onebot.onEvent({
    post_type: 'message', message_type: 'group', group_id: 100001, user_id: 123456,
    message_id: 1007, time: Math.floor(Date.now() / 1000),
    sender: { user_id: 123456, nickname: '群友' }, message: search
  });
  assert.equal(sent.length, 3, '群内直接发送搜索指令也能识别');
  rememberSearchPage({
    chatKey: 'group:100001', senderId: '123456', query: '测试', page: 1, pages: 1,
    rows: [{ id: '123450' }]
  });
  await app.onebot.onEvent({
    post_type: 'message', message_type: 'group', group_id: 100001, user_id: 123456,
    message_id: 1005, time: Math.floor(Date.now() / 1000),
    sender: { user_id: 123456, nickname: '群友' },
    message: [{ type: 'at', data: { qq: '987654' } }, { type: 'text', data: { text: '下一页' } }]
  });
  assert.equal(sent.length, 4);
  assert.match(sent[3].messages[0], /已经是第 1 页/);
  assert.equal(wakes, 0);
  clearSearchSessions();
  await app.onebot.onEvent({
    post_type: 'message', message_type: 'group', group_id: 100002, user_id: 123456,
    message_id: 1004, time: Math.floor(Date.now() / 1000),
    sender: { user_id: 123456, nickname: '群友' }, message: search
  });
  assert.equal(sent.length, 4, '非白名单群不响应');
});

test('下一页等待站点搜索时，普通编排器不能领取同一条消息', async (t) => {
  const { createApp } = await import('../src/console/app.js');
  const { DEFAULT_CONFIG, setRuntimeConfig } = await import('../src/core/config.js');
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.runtime.mode = 'active';
  cfg.runtime.paused = false;
  cfg.allow.private = ['123456'];
  cfg.jm.enabled = true;
  cfg.sticker.autoCollect = false;
  setRuntimeConfig(cfg);
  const app = createApp({ log: () => {} });
  t.after(() => app.stop());
  clearSearchSessions();
  rememberSearchPage({ chatKey: 'private:123456', senderId: '123456', query: '测试', page: 1, pages: 2,
    rows: [{ id: '123450' }] });
  let wakes = 0;
  app.orchestrator.onIncoming = () => { wakes += 1; };
  app.sender.sendTextBatch = async (_chatKey, messages) => ({ sent: messages.map((text) => ({ text })), failed: [] });
  const originalFetch = globalThis.fetch;
  let releaseFetch;
  let firstFetch = true;
  globalThis.fetch = async () => {
    if (firstFetch) {
      firstFetch = false;
      await new Promise((resolve) => { releaseFetch = resolve; });
    }
    return new Response('', { status: 503 });
  };
  try {
    const incoming = app.onebot.onEvent({
      post_type: 'message', message_type: 'private', user_id: 123456,
      message_id: 1002, time: Math.floor(Date.now() / 1000),
      sender: { user_id: 123456, nickname: '用户' }, message: '下一页'
    });
    for (let i = 0; i < 100 && !releaseFetch; i++) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(typeof releaseFetch, 'function', '翻页已进入站点请求');
    assert.equal(app.store.unreadCount('private:123456'), 0, '请求未完成时消息已被消费');
    assert.equal(wakes, 0);
    releaseFetch();
    await incoming;
    assert.equal(wakes, 0);
  } finally {
    releaseFetch?.();
    globalThis.fetch = originalFetch;
    clearSearchSessions();
  }
});
