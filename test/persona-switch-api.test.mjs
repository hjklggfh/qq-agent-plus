// 第二人设的 HTTP 接口：状态查询（谁在值班）与人工叫回。
// 用真 HTTP 起服务，与 asr-config-api.test.mjs 同一套写法（路由层的东西只有真打一遍才算验过）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-persona-switch-api-'));
process.env.QQ_AGENT_DATA_DIR = root;

const { DEFAULT_CONFIG, updateConfig } = await import('../src/core/config.js');
const { createApp } = await import('../src/console/app.js');
const { activateChatProfile, resolveChatProfile, personaSwitchConfig } = await import('../src/core/persona-switch.js');

async function freePort() {
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

test('第二人设状态接口列出值班中的群，叫回接口清掉它', async (t) => {
  const port = await freePort();
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.server = { ...cfg.server, host: '127.0.0.1', port, token: '' };
  cfg.runtime.mode = 'observe';
  cfg.onebot.wsUrl = 'ws://127.0.0.1:1';
  cfg.onebot.httpUrl = 'http://127.0.0.1:1';
  cfg.allow.groups = ['100001', '100002'];
  cfg.personaSwitch.enabled = true;
  cfg.personaSwitch.altModel = 'claude-sonnet-5-5-low';
  cfg.personaSwitch.altRoleText = '你是克劳德';
  cfg.personaSwitch.altName = 'Claude';
  updateConfig(cfg);

  const settings = personaSwitchConfig(cfg.personaSwitch);
  const CHAT = 'group:100001';
  const OTHER = 'group:100002';
  activateChatProfile(CHAT, 'alt', Date.now(), settings);
  assert.equal(resolveChatProfile(CHAT, Date.now(), settings).profile, 'alt');

  const app = createApp({ log: () => {} });
  t.after(async () => {
    await app.stop();
    fs.rmSync(root, { recursive: true, force: true });
  });
  await app.start();

  const request = async (route, { method = 'GET', body } = {}) => {
    const response = await fetch(`http://127.0.0.1:${port}${route}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    return { status: response.status, body: await response.json() };
  };

  // 1) 状态：功能开着、就绪、只有被召唤的那个群在值班
  const before = await request('/api/persona-switch');
  assert.equal(before.status, 200);
  assert.equal(before.body.enabled, true);
  assert.equal(before.body.ready, true);
  assert.equal(before.body.altName, 'Claude');
  assert.equal(before.body.altModel, 'claude-sonnet-5-5-low');
  const activeKeys = before.body.active.map((item) => item.chatKey);
  assert.deepEqual(activeKeys, [CHAT], `只有被召唤的会话该在列表里，实际 ${activeKeys.join(',')}`);
  const entry = before.body.active[0];
  assert.ok(entry.expiresAt > entry.lastReplyAt, '交还时间应晚于最后一次发言');
  assert.equal(entry.expiresAt - entry.lastReplyAt, settings.idleMinutes * 60000, '交还时间 = 最后发言 + 闲置时长');
  assert.ok(!activeKeys.includes(OTHER), '没被召唤的群不该出现');

  // 2) 叫回：清掉之后列表为空，状态文件里也没了
  const cleared = await request('/api/persona-switch/clear', { method: 'POST', body: { chatKey: CHAT } });
  assert.equal(cleared.status, 200);
  assert.equal(cleared.body.cleared, true);
  const after = await request('/api/persona-switch');
  assert.deepEqual(after.body.active, []);
  assert.equal(resolveChatProfile(CHAT, Date.now(), settings).profile, 'home');

  // 3) 非法 chatKey 直接 400，不动任何状态
  const bad = await request('/api/persona-switch/clear', { method: 'POST', body: { chatKey: 'garbage' } });
  assert.equal(bad.status, 400);
  assert.match(String(bad.body.error || ''), /chatKey/);

  // 4) 再次叫回一个本来就不在值班的会话：ok 但 cleared=false（前端据此提示"本来就没在值班"）
  const again = await request('/api/persona-switch/clear', { method: 'POST', body: { chatKey: CHAT } });
  assert.equal(again.status, 200);
  assert.equal(again.body.cleared, false);
});
