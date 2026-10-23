import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { test } from 'node:test';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-feature-management-'));
process.env.QQ_AGENT_DATA_DIR = dataDir;
process.on('exit', () => {
  if (path.dirname(dataDir) === path.resolve(os.tmpdir()) && path.basename(dataDir).startsWith('qq-feature-management-')) {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
const { DEFAULT_CONFIG, updateConfig } = await import('../src/core/config.js');
const { createApp } = await import('../src/console/app.js');
const { GroupDigestManager } = await import('../src/features/group-digest.js');

test('authenticated feature inventory coordinates live tasks and cleans all timers on shutdown', async () => {
  const listener = net.createServer();
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.server = { ...cfg.server, host: '127.0.0.1', port, token: 'feature-test-auth' };
  cfg.runtime.mode = 'observe';
  cfg.onebot = { ...cfg.onebot, wsUrl: 'ws://127.0.0.1:1', httpUrl: 'http://127.0.0.1:1', accessToken: '' };
  cfg.api = { ...cfg.api, baseUrl: '', apiKey: 'private-test-key', priceRemoteUrl: 'none' };
  updateConfig(cfg);
  const app = createApp({ log: () => {} });
  try {
    await app.start();
    const url = `http://127.0.0.1:${port}`;
    assert.equal((await fetch(url + '/api/features')).status, 401);
    const request = async (route, body) => {
      const response = await fetch(url + route, { headers: { 'content-type': 'application/json', 'x-console-token': 'feature-test-auth' },
        ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}) });
      assert.equal(response.status, 200);
      return response.json();
    };
    const first = await request('/api/features');
    assert.equal(first.features.length, 16);
    assert.equal(first.tasks.length, 11);
    assert.equal(new Set(first.features.map(item => item.id)).size, first.features.length);
    assert.equal(first.tasks.find(item => item.id === 'reminders').state, 'waiting');
    assert.equal(first.tasks.find(item => item.id === 'daily-report').state, 'disabled');
    assert.doesNotMatch(JSON.stringify(first), /private-test-key|feature-test-auth|"apiKey"|"records"/);
    const initialChanges = first.tasks.map(item => item.changedAt);
    assert.deepEqual((await request('/api/features')).tasks.map(item => item.changedAt), initialChanges, 'polling is read-only');
    await request('/api/config', { reminders: { enabled: false } });
    assert.equal((await request('/api/features')).tasks.find(item => item.id === 'reminders').state, 'disabled');
    assert.equal(Boolean(app.orchestrator.reminderTimer), false);
    await request('/api/config', { reminders: { enabled: true } });
    assert.equal(Boolean(app.orchestrator.reminderTimer), true);
    const handle = app.orchestrator.reminderTimer;
    await request('/api/config', { send: { maxPerMinute: cfg.send.maxPerMinute } });
    assert.equal(app.orchestrator.reminderTimer === handle, true, 'unrelated save does not reschedule reminders');
  } finally { await app.stop(); }
  assert.equal(Boolean(app.orchestrator.retryTimer), false);
  assert.equal(Boolean(app.orchestrator.reminderTimer), false);
  assert.equal(Boolean(app.orchestrator.scheduledWakeTicker), false);
  assert.equal(app.backgroundTasks.snapshot().every(item => item.state === 'stopped'), true);
});

test('group digest cancellation holds a late model result instead of sending after disable', async () => {
  updateConfig({ runtime: { mode: 'active', paused: false }, allow: { groups: ['123456'] },
    timeControl: { enabled: false }, groupDigest: { enabled: true, time: '09:30', chats: ['group:123456'] } });
  let finish; let writes = 0; let signal;
  const manager = new GroupDigestManager({
    log: () => {},
    store: { recent: () => Array.from({ length: 5 }, () => ({ ts: Date.now(), text: 'hello', senderId: '234567' })) },
    sender: { sendTextBatch: async () => { writes++; } },
    complete: options => { signal = options.signal; return new Promise(resolve => { finish = resolve; }); }
  });
  const running = manager.runOnce();
  assert.equal(Boolean(finish), true);
  const stopped = manager.shutdown();
  assert.equal(signal.aborted, true);
  finish({ message: { content: 'late reply' } });
  await running; await stopped;
  assert.equal(writes, 0);
  assert.equal(manager.running, false);
});
