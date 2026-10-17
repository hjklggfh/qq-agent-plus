import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pixiv-file-send-'));
process.env.QQ_AGENT_DATA_DIR = dir;
process.on('exit', () => fs.rmSync(dir, { recursive: true, force: true }));
const { SendQueue } = await import('../src/onebot/sender.js');
const { DEFAULT_CONFIG, setRuntimeConfig } = await import('../src/core/config.js');
const cfg = structuredClone(DEFAULT_CONFIG);
cfg.runtime.mode = 'active'; cfg.allow.groups = ['1']; cfg.allow.private = ['2'];
setRuntimeConfig(cfg);

function fixture(upload) {
  const calls = [], payloads = [], outcomes = [], self = [];
  const store = {
    hasUncertainEffects: () => outcomes.some((r) => r.outcome === 'unknown'),
    beginSend: (_chat, _run, payload) => { payloads.push(payload); return 'operation'; },
    finishSend: (_id, result) => outcomes.push(result),
    appendSelf: (_chat, row) => self.push(row)
  };
  const sender = new SendQueue({ store, onebot: { call: async (action, params, timeout, signal) => {
    if (!action.startsWith('upload_')) return {};
    calls.push({ action, params, timeout, signal });
    return upload ? upload.call(null) : { file_id: 'file-id' };
  } } });
  return { sender, calls, payloads, outcomes, self };
}
const file = { file: path.join(dir, 'private-local-path.pdf'), name: 'Pixiv-12345678.pdf', bytes: 1234 };

test('群文件与私聊文件进入发送队列，outbox只存文件名大小，不存文件路径和内容', async () => {
  const f = fixture();
  const controller = new AbortController();
  await f.sender.file('group:1', file, { runId: 'group-file', signal: controller.signal });
  await f.sender.file('private:2', file, { runId: 'private-file' });
  assert.deepEqual(f.calls.map((r) => r.action), ['upload_group_file', 'upload_private_file']);
  assert.equal(f.calls[0].signal, controller.signal);
  assert.equal(f.calls[0].params.file, file.file);
  assert.deepEqual(f.payloads[0], { type: 'file', name: file.name, bytes: 1234 });
  assert.equal(f.self.length, 2);
});

test('文件上传超时记为unknown，后续同run发送被拦截，不重复上传', async () => {
  const f = fixture(() => { throw new Error('Request timeout after 120000ms'); });
  await assert.rejects(f.sender.file('group:1', file, { runId: 'unknown-file' }), /timeout/);
  await assert.rejects(f.sender.file('group:1', file, { runId: 'unknown-file' }), /uncertain/);
  assert.equal(f.calls.length, 1); assert.equal(f.outcomes[0].outcome, 'unknown');
  assert.equal(f.self.length, 0);
});

test('取消或宿主不允许的会话不上传文件', async () => {
  const f = fixture();
  const controller = new AbortController(); controller.abort();
  await assert.rejects(f.sender.file('group:1', file, { signal: controller.signal }));
  await assert.rejects(f.sender.file('private:3', file));
  assert.equal(f.calls.length, 0); assert.equal(f.payloads.length, 0);
});
