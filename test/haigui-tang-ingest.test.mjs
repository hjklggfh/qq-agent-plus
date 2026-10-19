import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-haigui-ingest-'));
process.env.QQ_AGENT_DATA_DIR = dir;
process.on('exit', () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 退出时仍可能有 SQLite 句柄 */ } });

test('明确海龟汤指令由宿主消费、重复消息不重复执行', async (t) => {
  const { createApp } = await import('../src/console/app.js');
  const { DEFAULT_CONFIG, setRuntimeConfig } = await import('../src/core/config.js');
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.runtime.mode = 'active';
  cfg.runtime.paused = false;
  cfg.allow.groups = ['100001'];
  cfg.haiguiTang.enabled = true;
  cfg.haiguiTang.allowedChats = ['group:100001'];
  cfg.sticker.autoCollect = false;
  setRuntimeConfig(cfg);
  const app = createApp({ log: () => {} });
  t.after(() => app.stop());
  let handled = 0; let wakes = 0;
  app.haiguiTang.handle = async () => { handled++; return {}; };
  app.orchestrator.onIncoming = () => { wakes++; };
  const event = (mid, text) => app.onebot.onEvent({ post_type: 'message', message_type: 'group', group_id: 100001,
    user_id: 123456, message_id: mid, time: Math.floor(Date.now() / 1000), sender: { nickname: '用户' }, message: text });
  await event(10, '海龟汤');
  await event(10, '海龟汤');
  assert.equal(handled, 1);
  assert.equal(wakes, 0);
  assert.equal(app.store.unreadCount('group:100001'), 0);
  await event(11, '今天吃什么');
  assert.equal(wakes, 1);
  app.haiguiTang.isSelecting = () => true;
  await event(12, '2');
  await event(13, '退出');
  assert.equal(handled, 3);
  assert.equal(wakes, 1);
});
