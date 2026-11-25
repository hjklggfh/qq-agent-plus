import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-pid-ingest-'));
process.env.QQ_AGENT_DATA_DIR = dir;
process.on('exit', () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* SQLite句柄随进程退出。 */ } });
test('真实QQ入口：明确PID不唤醒模型，重复事件不重复取图，暂停和白名单有效', async (t) => {
  const { createApp } = await import('../src/console/app.js');
  const { DEFAULT_CONFIG, setRuntimeConfig } = await import('../src/core/config.js');
  const cfg = structuredClone(DEFAULT_CONFIG); cfg.runtime.mode = 'active'; cfg.runtime.paused = false;
  cfg.allow.groups = ['100001']; cfg.pixiv.enabled = true; cfg.sticker.autoCollect = false;
  setRuntimeConfig(cfg);
  const app = createApp({ log: () => {} }); t.after(() => app.stop());
  let runs = 0, wakes = 0;
  app.orchestrator.onIncoming = () => { wakes++; };
  app.pixiv.start = async () => { runs++; assert.equal(app.store.unreadCount('group:100001'), 0); return { content: 'ok' }; };
  const event = (mid, text, group = 100001) => app.onebot.onEvent({ post_type: 'message', message_type: 'group', group_id: group, user_id: 123456, message_id: mid, time: Math.floor(Date.now() / 1000), sender: { nickname: '用户' }, message: text });
  await event(10, 'PID 12345678'); await event(10, 'PID 12345678');
  assert.equal(runs, 1); assert.equal(wakes, 0);
  await event(11, 'https://www.pixiv.net/artworks/12345678'); assert.equal(runs, 2);
  cfg.runtime.paused = true; await event(12, 'PID 12345678'); assert.equal(runs, 2);
  assert.equal(app.store.unreadCount('group:100001'), 0);
  cfg.runtime.paused = false; await event(13, 'PID 12345678', 100002); assert.equal(runs, 2);
  await event(14, '12345678'); assert.equal(wakes, 1, '普通数字不得误识别为命令');
});

test('真实QQ入口：/美图 兼容直发与 @机器人、支持关键词、忽略 @他人，默认全关', async (t) => {
  const { createApp } = await import('../src/console/app.js');
  const { DEFAULT_CONFIG, setRuntimeConfig } = await import('../src/core/config.js');
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.runtime.mode = 'active';
  cfg.runtime.paused = false;
  cfg.allow.groups = ['100001', '100003'];
  cfg.pixiv.enabled = true;
  cfg.pixiv.meituGroups = ['100001'];
  cfg.sticker.autoCollect = false;
  setRuntimeConfig(cfg);
  const app = createApp({ log: () => {} }); t.after(() => app.stop());
  Object.defineProperty(app.onebot, 'selfId', { value: '999999', configurable: true });
  const calls = [];
  let wakes = 0;
  app.orchestrator.onIncoming = () => { wakes++; };
  app.pixiv.startMeitu = async (cmd, chatKey, storedId, replyMid) => {
    calls.push({ cmd, chatKey, replyMid });
    return { content: 'ok' };
  };
  const sendGroup = (mid, message, group = 100001) => app.onebot.onEvent({
    post_type: 'message', message_type: 'group', group_id: group, user_id: 123456,
    message_id: mid, time: Math.floor(Date.now() / 1000), sender: { nickname: '用户' }, message
  });

  // 1. 已开启群：直接发 /美图
  await sendGroup(101, '/美图', 100001);
  // 2. 已开启群：@机器人 /美图 碧蓝档案（数组段）
  await sendGroup(102, [{ type: 'at', data: { qq: '999999' } }, { type: 'text', data: { text: ' /美图 碧蓝档案' } }], 100001);
  // 3. 已开启群：@其他机器人 /美图（不得抢答）
  await sendGroup(103, [{ type: 'at', data: { qq: '888888' } }, { type: 'text', data: { text: ' /美图' } }], 100001);
  // 4. 未开启群：@机器人 /美图（静默消费，不发图也不唤醒大模型）
  await sendGroup(104, [{ type: 'at', data: { qq: '999999' } }, { type: 'text', data: { text: ' /美图' } }], 100003);

  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], { cmd: { mode: 'meitu', keyword: '' }, chatKey: 'group:100001', replyMid: 101 });
  assert.deepEqual(calls[1], { cmd: { mode: 'meitu', keyword: '碧蓝档案' }, chatKey: 'group:100001', replyMid: 102 });
  assert.equal(wakes, 1, '仅 @他人 的普通群消息可按常规流转，已开启和 @本人的未开启群均不唤醒模型');
});
