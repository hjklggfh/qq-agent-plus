import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(process.cwd(), '.passive-file-test-'));
process.env.QQ_AGENT_DATA_DIR = dir;
process.on('exit', () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* SQLite may still hold a file */ } });

test('file download echo is recorded without triggering JM or chat; real text and audio remain active', async (t) => {
  const { createApp } = await import('../src/console/app.js');
  const { DEFAULT_CONFIG, setRuntimeConfig } = await import('../src/core/config.js');
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.runtime.mode = 'active';
  cfg.runtime.paused = false;
  cfg.allow.private = ['123456'];
  cfg.sticker.autoCollect = false;
  setRuntimeConfig(cfg);
  const app = createApp({ log: () => {} });
  t.after(() => app.stop());
  let wakes = 0;
  let sends = 0;
  app.orchestrator.onIncoming = () => { wakes += 1; };
  app.sender.sendTextBatch = async () => { sends += 1; return { sent: [], failed: [] }; };
  const event = (mid, message) => app.onebot.onEvent({
    post_type: 'message', message_type: 'private', user_id: 123456,
    message_id: mid, time: Math.floor(Date.now() / 1000),
    sender: { user_id: 123456, nickname: '用户' }, message
  });

  await event(1, [{ type: 'file', data: { name: 'JM1483633-漫画.pdf', file: 'abc' } }]);
  assert.equal(wakes, 0);
  assert.equal(sends, 0);
  assert.equal(app.store.unreadCount('private:123456'), 0);
  assert.match(app.store.recent('private:123456', { limit: 1 })[0].text, /JM1483633/);

  await event(2, [{ type: 'text', data: { text: '你好' } }]);
  assert.equal(wakes, 1);
  await event(3, [{ type: 'file', data: { name: '会议录音.m4a', file: 'audio', url: 'https://example.test/audio' } }]);
  assert.equal(wakes, 2);
  await event(4, [
    { type: 'text', data: { text: '你好' } },
    { type: 'file', data: { name: 'JM1483633-漫画.pdf', file: 'abc' } }
  ]);
  assert.equal(wakes, 3, '带文字的文件消息仍进入普通聊天');
  assert.equal(sends, 0, '文件名中的 JM 编号不能成为下载指令');
});
