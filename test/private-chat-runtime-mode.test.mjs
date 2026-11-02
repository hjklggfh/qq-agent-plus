import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { test } from 'node:test';

const root = fs.mkdtempSync(path.join(process.cwd(), '.private-runtime-test-'));
process.env.QQ_AGENT_DATA_DIR = root;
process.on('exit', () => {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* SQLite 句柄随进程退出。 */ }
});

const { DEFAULT_CONFIG, setRuntimeConfig } = await import('../src/core/config.js');
const { createApp } = await import('../src/console/app.js');
const { IncidentPilotManager } = await import('../src/pilots/incident-pilot.js');

async function freePort() {
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

test('私聊运行模式按好友独立持久化，重开后仍是各自的值', async () => {
  const dataDir = fs.mkdtempSync(path.join(root, 'persist-'));
  const cfg = {
    incidentPilot: {
      enabled: true,
      ownerUin: '10000003',
      notifyWarnings: true,
      duplicateWindowMinutes: 10,
      unknownWritesBlockChat: false,
      retentionDays: 90
    }
  };
  const manager = new IncidentPilotManager({
    dataDir, config: () => cfg, notifyAvailable: () => false, emit: () => {}, log: () => {}
  });
  manager.start();
  manager.setChatControl('private:111111', {
    mode: 'functions', reason: '只在私聊里执行功能指令', expectedVersion: 0
  });
  manager.setChatControl('private:222222', { mode: 'blocked', expectedVersion: 0 });
  manager.setChatControl('group:100001', { mode: 'blocked', expectedVersion: 0 });

  assert.equal(manager.chatDecision('private:111111').allowed, false);
  assert.equal(manager.chatDecision('private:111111').mode, 'functions');
  assert.equal(manager.chatDecision('private:222222').allowed, false);
  assert.equal(manager.chatDecision('group:100001').allowed, false);
  assert.throws(() => manager.setChatControl('group:100001', { mode: 'functions' }), /群聊模式/);
  assert.throws(() => manager.setChatControl('private:111111', { mode: 'continue' }), /私聊模式/);

  await manager.stop();
  const reader = new IncidentPilotManager({
    dataDir, config: () => cfg, notifyAvailable: () => false, emit: () => {}, log: () => {}
  });
  reader.openExisting();
  assert.equal(reader.getChatControl('private:111111').mode, 'functions');
  assert.equal(reader.getChatControl('private:222222').mode, 'blocked');
  assert.equal(reader.getChatControl('group:100001').mode, 'blocked');
  assert.equal(reader.chatDecision('private:111111').allowed, false);
  await reader.stop();
});

test('私聊三档模式复用群聊控制入口，且不误伤其他好友或群聊', async (t) => {
  const port = await freePort();
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.server = { ...cfg.server, host: '127.0.0.1', port, token: '' };
  cfg.runtime.mode = 'active';
  cfg.runtime.paused = false;
  cfg.api.model = 'test-model';
  cfg.admin = { ...(cfg.admin || {}), ownerUin: '10000003' };
  cfg.allow.private = ['111111', '222222'];
  cfg.allow.groups = ['100001'];
  cfg.jm.enabled = true;
  cfg.pixiv.enabled = true;
  cfg.sticker.autoCollect = false;
  cfg.privateProactive = { ...(cfg.privateProactive || {}), enabled: false };
  cfg.onebot.wsUrl = 'ws://127.0.0.1:1';
  cfg.onebot.httpUrl = 'http://127.0.0.1:1';
  setRuntimeConfig(cfg);

  const app = createApp({ log: () => {} });
  t.after(async () => { try { await app.stop(); } catch { /* 测试收尾失败不掩盖断言。 */ } });
  const wakes = [];
  app.orchestrator.onIncoming = (chatKey) => wakes.push(chatKey);
  const sent = [];
  app.sender.sendTextBatch = async (chatKey, messages) => {
    sent.push({ chatKey, messages });
    return { sent: messages.map((text) => ({ text })), failed: [] };
  };
  let pidRuns = 0;
  app.pixiv.start = async () => { pidRuns += 1; return { content: 'ok' }; };
  let imageSearches = 0;
  app.imageSearch.start = async () => { imageSearches += 1; return { ok: true }; };
  await app.start();

  const request = async (route, { method = 'GET', body } = {}) => {
    const response = await fetch(`http://127.0.0.1:${port}${route}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    return { status: response.status, body: await response.json() };
  };
  const privateEvent = (id, mid, message) => app.onebot.onEvent({
    post_type: 'message', message_type: 'private', user_id: Number(id),
    message_id: mid, time: Math.floor(Date.now() / 1000),
    sender: { user_id: Number(id), nickname: '好友' }, message
  });
  const groupEvent = (mid, message) => app.onebot.onEvent({
    post_type: 'message', message_type: 'group', group_id: 100001, user_id: 333333,
    message_id: mid, time: Math.floor(Date.now() / 1000),
    sender: { user_id: 333333, nickname: '群友' }, message
  });
  const setMode = (key, mode, expectedVersion, reason = '') => request(
    `/api/chats/${key.replace(':', '_')}/runtime-control`,
    { method: 'PUT', body: { mode, expectedVersion, backlogAction: 'keep', reason } }
  );
  const imageCommand = [
    { type: 'text', data: { text: '搜图' } },
    { type: 'image', data: { url: 'https://qq.example/image' } }
  ];

  const functions = await setMode('private:111111', 'functions', 0, '仅功能模式（测试）');
  assert.equal(functions.status, 200);
  assert.equal(functions.body.runtimeMode.mode, 'functions');
  const stale = await setMode('private:111111', 'normal', 0);
  assert.equal(stale.status, 409);
  assert.match(stale.body.error, /已被其他操作更新/);
  assert.equal((await request('/api/chats/private_111111/runtime-control')).body.runtimeMode.mode, 'functions');
  assert.equal((await request('/api/chats/private_222222/runtime-control')).body.runtimeMode.mode, 'normal');
  const groupBefore = await request('/api/chats/group_100001/runtime-control');
  assert.equal(groupBefore.body.runtimeMode, null);
  assert.equal(groupBefore.body.control.mode, 'auto');

  // 普通私聊：只入库、不进入 AI 对话流程，也不留下未读。
  await privateEvent('111111', 1, '普通聊天');
  assert.deepEqual(wakes, []);
  assert.equal(app.store.unreadCount('private:111111'), 0);
  assert.equal(app.orchestrator.privateProactive.canWake('private:111111'), true, '仅功能模式不安排主动私信');

  // 功能指令沿用原识别/执行链路：PID、搜图、JM 都照常执行。
  await privateEvent('111111', 2, 'PID 12345678');
  assert.equal(pidRuns, 1);
  await privateEvent('111111', 3, imageCommand);
  assert.equal(imageSearches, 1);
  await privateEvent('111111', 4, `JM搜索 ${'词'.repeat(61)}`);
  assert.match(sent.at(-1)?.messages?.[0] || '', /1～60/);
  assert.deepEqual(wakes, []);
  assert.equal(app.store.unreadCount('private:111111'), 0);

  // 另一个好友和群聊仍按正常模式运行。
  await privateEvent('222222', 5, '普通聊天');
  await groupEvent(6, '群聊普通消息');
  assert.deepEqual(wakes, ['private:222222', 'group:100001']);

  const manualFunctions = await request('/api/chats/private_111111/wake', { method: 'POST', body: {} });
  assert.equal(manualFunctions.status, 409);
  assert.match(manualFunctions.body.reason, /仅功能模式/);

  const invalid = await setMode('private:111111', 'continue', 1);
  assert.equal(invalid.status, 400);
  assert.match(invalid.body.error, /normal、functions 或 blocked/);

  // 完全阻塞：连功能指令和手动唤醒都不执行。
  const blocked = await setMode('private:111111', 'blocked', 1, '完全阻塞（测试）');
  assert.equal(blocked.status, 200);
  assert.equal(blocked.body.runtimeMode.mode, 'blocked');
  const sentBeforeBlocked = sent.length;
  await privateEvent('111111', 7, 'PID 12345678');
  await privateEvent('111111', 8, imageCommand);
  await privateEvent('111111', 9, `JM搜索 ${'词'.repeat(61)}`);
  assert.equal(pidRuns, 1);
  assert.equal(imageSearches, 1);
  assert.equal(sent.length, sentBeforeBlocked);
  assert.deepEqual(wakes, ['private:222222', 'group:100001']);
  assert.equal(app.orchestrator.privateProactive.canWake('private:111111'), true);
  const manualBlocked = await request('/api/chats/private_111111/wake', { method: 'POST', body: {} });
  assert.equal(manualBlocked.status, 409);
  assert.match(manualBlocked.body.reason, /完全阻塞/);

  // 改回正常模式后恢复普通对话，且状态没有串到其他会话。
  const normal = await setMode('private:111111', 'normal', 2);
  assert.equal(normal.status, 200);
  assert.equal(normal.body.runtimeMode.mode, 'normal');
  await privateEvent('111111', 10, '普通聊天');
  assert.equal(wakes.at(-1), 'private:111111');
  assert.equal(app.store.unreadCount('private:111111'), 1);
  assert.equal(app.orchestrator.privateProactive.canWake('private:111111'), false);
  assert.equal((await request('/api/chats/private_222222/runtime-control')).body.runtimeMode.mode, 'normal');
  assert.equal((await request('/api/chats/group_100001/runtime-control')).body.control.mode, 'auto');
});
