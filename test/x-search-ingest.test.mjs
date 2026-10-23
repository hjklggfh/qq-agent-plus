import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(process.cwd(), '.x-search-test-'));
process.env.QQ_AGENT_DATA_DIR = dir;
process.on('exit', () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* SQLite */ } });

test('X 异步查询先消费、重复事件不重发、不调用聊天模型、附件名不执行', async (t) => {
  const { createApp } = await import('../src/console/app.js');
  const { DEFAULT_CONFIG, setRuntimeConfig } = await import('../src/core/config.js');
  const config = structuredClone(DEFAULT_CONFIG);
  config.runtime.mode = 'active'; config.runtime.paused = false;
  config.allow.private = ['123456']; config.sticker.autoCollect = false;
  config.xSearch = { ...config.xSearch, enabled: true, bearerToken: 'test-token', includeImages: false };
  setRuntimeConfig(config);
  const app = createApp({ log: () => {} });
  t.after(() => app.stop());
  let wakes = 0; let requests = 0; let release;
  const sent = [];
  app.orchestrator.onIncoming = () => { wakes++; };
  app.xSearch.options.request = async (url) => {
    requests++;
    if (url.includes('/tweets?')) return { data: [{ id: '987654', text: '真实响应测试帖' }], meta: {} };
    return new Promise((resolve) => { release = resolve; });
  };
  app.sender.forward = async (chatKey, payload) => { sent.push({ chatKey, payload }); return { message_id: '111' }; };
  const event = { post_type: 'message', message_type: 'private', user_id: 123456, message_id: 2001,
    time: Math.floor(Date.now() / 1000), sender: { user_id: 123456, nickname: '用户' }, message: 'X @Example' };
  await app.onebot.onEvent(event);
  assert.equal(app.store.unreadCount('private:123456'), 0);
  assert.equal(wakes, 0);
  await app.onebot.onEvent(event);
  assert.equal(requests, 1);
  release({ data: { id: '123456', username: 'Example', name: '示例' } });
  await app.xSearch.task;
  assert.equal(sent.length, 1);
  assert.match(JSON.stringify(sent), /真实响应测试帖/);
  assert.equal(wakes, 0);
  await app.onebot.onEvent({ ...event, message_id: 2002,
    message: [{ type: 'file', data: { name: 'X @Other', url: 'https://example.test/file.pdf' } }] });
  assert.equal(requests, 2, '附件文件名未触发额外 API 请求');
});

test('X 路由要求认证，安全配置隐藏Token，设置与预览均可用', async (t) => {
  const { createApp } = await import('../src/console/app.js');
  const { DEFAULT_CONFIG, setRuntimeConfig } = await import('../src/core/config.js');
  const config = structuredClone(DEFAULT_CONFIG);
  config.server.token = 'console-test'; config.runtime.paused = false;
  setRuntimeConfig(config);
  const app = createApp({ log: () => {} });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  t.after(() => app.stop());
  const base = `http://127.0.0.1:${app.server.address().port}`;
  assert.equal((await fetch(`${base}/api/x-search`)).status, 401);
  const headers = { 'x-console-token': 'console-test', 'content-type': 'application/json' };
  let response = await fetch(`${base}/api/x-search/settings`, { method: 'POST', headers,
    body: JSON.stringify({ enabled: true, bearerToken: 'x-private-token' }) });
  assert.equal(response.status, 200);
  const saved = await response.json();
  assert.equal(saved.settings.hasBearerToken, true);
  assert.doesNotMatch(JSON.stringify(saved), /x-private-token/);
  response = await fetch(`${base}/api/config`, { headers });
  assert.doesNotMatch(await response.text(), /x-private-token/);
  app.xSearch.options.request = async (url) => url.includes('/tweets?') ? { data: [], meta: { result_count: 0 } }
    : { data: { id: '123456', username: 'Example', name: '示例' } };
  response = await fetch(`${base}/api/x-search/preview`, { method: 'POST', headers, body: JSON.stringify({ username: '@Example' }) });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).page.posts.length, 0);
  response = await fetch(`${base}/api/x-search/settings`, { method: 'POST', headers, body: JSON.stringify({ bearerToken: '' }) });
  assert.equal((await response.json()).settings.hasBearerToken, false);
});
