import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import test from 'node:test';
import { TrpgManager } from '../src/features/trpg/manager.js';
import { installTrpgRoutes } from '../src/features/trpg/routes.js';
import { createRouter } from '../src/console/router.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-trpg-integration-'));
process.env.QQ_AGENT_DATA_DIR = root;
process.on('exit', () => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* Windows handles may close at process exit. */ } });

test('跑团 API 沿用鉴权、405、验证与删除确认，禁用时仍可编辑卡片', async (t) => {
  const cfg = { trpg: { enabled: false, maxPlayers: 6 } };
  const manager = new TrpgManager({ dataDir: root, getConfig: () => cfg, canRun: () => true });
  const json = (res, code, value) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
  const router = createRouter({ authorize: (req) => req.headers['x-test-token'] === 'yes', json });
  installTrpgRoutes({ addRoute: (...args) => router.add(...args), updateConfig: (patch) => Object.assign(cfg.trpg, patch.trpg), enforceTrpgState: () => {} }, manager);
  const server = http.createServer((req, res) => { router.handle(req, res).catch(() => json(res, 500, { error: 'unexpected' })); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const request = async (route, body, authorized = true, method = body ? 'POST' : 'GET') => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/trpg${route}`, {
      method, headers: { 'content-type': 'application/json', ...(authorized ? { 'x-test-token': 'yes' } : {}) },
      body: body ? JSON.stringify(body) : undefined
    });
    return { status: response.status, data: await response.json() };
  };
  assert.equal((await request('', undefined, false)).status, 401);
  assert.equal((await request('', {}, false)).status, 401);
  assert.equal((await request('', {})).status, 405);
  assert.equal((await request('')).data.settings.enabled, false);
  assert.equal(fs.existsSync(manager.file), false);
  assert.equal((await request('/settings', { enabled: 'yes' })).status, 400);
  const card = await request('/asset', { kind: 'characters', asset: { name: '守望者', description: '一位港口调查员', hp: 12 } });
  assert.equal(card.status, 200);
  assert.equal((await request('/delete-asset', { kind: 'characters', id: card.data.id })).status, 400);
  assert.equal((await request('/delete-asset', { kind: 'characters', id: card.data.id, confirm: true })).status, 200);
  assert.equal((await request('/settings', { enabled: true, maxPlayers: 3 })).data.settings.maxPlayers, 3);
  assert.equal(cfg.trpg.enabled, true);
  assert.equal((await request('/settings', { allowedGroups: ['100001'], allowedPrivate: ['123456'] })).status, 200);
  await request('/settings', { maxPlayers: 4 });
  assert.deepEqual(cfg.trpg.allowedGroups, ['100001'], '部分保存不能清空白名单');
  assert.equal(cfg.trpg.enabled, true);
  assert.equal((await request('/settings', { allowedGroups: ['*'] })).status, 400);
  assert.equal((await request('/settings', { allowedPrivate: '123456' })).status, 400);
});

test('跑团完整模型链路：仅注入游戏工具，真实检定、落盘后发送，计入既有会话用量', async (t) => {
  const { ChatStore } = await import('../src/core/store.js');
  const { SessionRegistry } = await import('../src/core/sessions.js');
  const { SendQueue } = await import('../src/onebot/sender.js');
  const { Orchestrator } = await import('../src/core/orchestrator.js');
  const { setRuntimeConfig, getConfig, DEFAULT_CONFIG } = await import('../src/core/config.js');
  const { canRun } = await import('../src/core/access.js');
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.runtime.mode = 'active';
  cfg.allow.groups = ['100001', '100002'];
  cfg.persona.roleText = '原人设标记：活泼撒娇，用亲昵称呼。';
  cfg.persona.customRules = '附加风格标记：每次都卖萌。';
  cfg.api.model = 'test'; cfg.api.baseUrl = 'https://model.invalid'; cfg.api.apiKey = 'test-key';
  cfg.api.maxRounds = 6;
  cfg.sticker.enabled = false;
  cfg.memory.consolidateEnabled = false;
  cfg.trpg = { enabled: true, maxPlayers: 6, allowedGroups: ['100001'], allowedPrivate: [] };
  setRuntimeConfig(cfg);
  const dir = path.join(root, 'model');
  const manager = new TrpgManager({ dataDir: dir, getConfig, canRun, rng: () => 12 });
  const chatKey = 'group:100001', actor = '123456';
  manager.command(chatKey, actor, '/跑团 开团 mist-harbor');
  manager.command(chatKey, actor, '/跑团 加入 traveler');
  manager.command(chatKey, actor, '/跑团 开始');
  const store = new ChatStore(0, { dataDir: dir });
  const sessions = new SessionRegistry();
  let sends = 0, calls = 0;
  const onebot = { getGroupInfo: async () => ({ group_name: '测试团' }), sendText: async () => {
    sends++;
    assert.equal(manager.current(chatKey).location, '灯塔入口', '发送前必须已经存档');
    return { message_id: 500 + sends };
  } };
  const runner = new Orchestrator({ store, sessions, onebot, sender: new SendQueue({ store, onebot }), stickers: {}, memory: { formatForPrompt: () => '亲疏印象标记：非常偏爱这名玩家', formatHandoffForPrompt: () => '旧交接标记：延续撒娇口吻' }, getTrpg: () => manager });
  const oldFetch = globalThis.fetch;
  t.after(async () => { globalThis.fetch = oldFetch; await runner.abortAll(); store.close(); });
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    assert.deepEqual(body.tools.map((tool) => tool.function.name).sort(), ['finish', 'send_message', 'trpg_roll', 'trpg_state', 'trpg_update']);
    assert.match(JSON.stringify(body.messages), /跑团主持任务/);
    assert.match(body.messages[0].content, /跑团裁判／旁白模式/);
    assert.equal(/原人设标记|附加风格标记|亲疏印象标记|旧交接标记/.test(JSON.stringify(body.messages)), false);
    const queue = [
      ['trpg_roll', { checkId: 'door', expression: '1d20+2' }],
      ['trpg_update', { checkId: 'scene', expectedRevision: manager.current(chatKey).revision, summary: '旅人在灯塔找到铜锁', location: '灯塔入口' }],
      ['send_message', { messages: '检定14，你发现铜锁上有与钥匙相同的纹路。接下来准备做什么？' }],
      ['finish', { summary: '等待玩家决定下一步行动' }]
    ];
    const [name, args] = queue[calls++];
    return Response.json({ choices: [{ message: { role: 'assistant', tool_calls: [{ id: `tool-${calls}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } });
  };
  store.appendIncoming(chatKey, { mid: 1, ts: Date.now(), text: '检查门锁', eventKind: 'trpg-action', senderId: actor, mentionsSelf: true });
  await runner.wake(chatKey);
  assert.equal(calls, 4);
  assert.equal(sends, 1);
  assert.equal(runner.scheduledWakes.has(chatKey), false, '跑团回复不安排通用补话');
  assert.equal(manager.current(chatKey).location, '灯塔入口');
  const summary = sessions.listSummaries(1)[0];
  assert.equal(summary.status, 'done', JSON.stringify(summary));
  assert.ok(summary.usage.promptTokens >= 400);

  // 模型误把发言放在存档前时，执行层必须拦截，不能只靠提示词劝说。
  let deniedFirstSend = false;
  let secondCalls = 0;
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    if (secondCalls === 1) {
      deniedFirstSend = JSON.stringify(body.messages).includes('请先用trpg_update成功保存');
      assert.equal(sends, 1, '未存档的叙述不得送到QQ');
    }
    const queue = [
      ['send_message', { messages: '不应该被发送的剧情' }],
      ['trpg_update', { checkId: 'second', expectedRevision: manager.current(chatKey).revision, summary: '旅人把钥匙插进铜锁', location: '灯塔入口' }],
      ['send_message', { messages: '钥匙与锁孔吻合。' }],
      ['finish', { summary: '等待下一步' }]
    ];
    const [name, args] = queue[secondCalls++];
    return Response.json({ choices: [{ message: { role: 'assistant', tool_calls: [{ id: `second-${secondCalls}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }], usage: { prompt_tokens: 100, completion_tokens: 20 } });
  };
  store.appendIncoming(chatKey, { mid: 2, ts: Date.now(), text: '/跑团 行动 尝试用钥匙开锁', senderId: actor, mentionsSelf: true });
  await runner.wake(chatKey);
  assert.equal(deniedFirstSend, true);
  assert.equal(sends, 2);

  let ordinaryMid = 10;
  const assertTone = async (key, narrator) => {
    let requested = false;
    globalThis.fetch = async (_url, options) => {
      requested = true;
      const body = JSON.parse(options.body);
      const system = body.messages[0].content;
      assert.equal(system.includes('跑团裁判／旁白模式'), narrator);
      assert.equal(system.includes('原人设标记'), !narrator);
      assert.equal(system.includes('附加风格标记'), !narrator);
      if (narrator) {
        assert.equal(/亲疏印象标记|旧交接标记/.test(JSON.stringify(body.messages)), false);
        assert.equal(body.tools.some((tool) => ['send_sticker', 'send_face', 'send_poke', 'trpg_update'].includes(tool.function.name)), false);
      }
      return Response.json({ choices: [{ message: { role: 'assistant', tool_calls: [{ id: `tone-${ordinaryMid}`, type: 'function', function: { name: 'finish', arguments: '{"summary":"规则已确认"}' } }] } }], usage: { prompt_tokens: 100, completion_tokens: 20 } });
    };
    store.appendIncoming(key, { mid: ++ordinaryMid, ts: Date.now(), text: '请说明当前规则', senderId: actor, mentionsSelf: true });
    await runner.wake(key);
    assert.equal(requested, true);
  };
  await assertTone(chatKey, true); // 本团普通答疑同样使用旁白。
  await assertTone('group:100002', false); // 其他窗口保留原人设。
  manager.command(chatKey, actor, '/跑团 暂停');
  await assertTone(chatKey, false);
  manager.command(chatKey, actor, '/跑团 继续');
  await assertTone(chatKey, true);

  // 撤销白名单必须中断已在进行的模型请求，存档保留。
  let signal;
  let started;
  const ready = new Promise((resolve) => { started = resolve; });
  globalThis.fetch = async (_url, options) => {
    signal = options.signal;
    started();
    return new Promise((_resolve, reject) => {
      const abort = () => reject(signal.reason || new Error('aborted'));
      if (signal.aborted) abort();
      else signal.addEventListener('abort', abort, { once: true });
    });
  };
  store.appendIncoming(chatKey, { mid: 100, ts: Date.now(), text: '/跑团 行动 走进灯塔', senderId: actor, mentionsSelf: true });
  const running = runner.wake(chatKey);
  await ready;
  cfg.trpg.allowedGroups = [];
  setRuntimeConfig(cfg);
  runner.enforceTrpgState();
  await running;
  assert.equal(signal.aborted, true);
  assert.equal(sends, 2);
  assert.equal(manager.current(chatKey).summary, '旅人把钥匙插进铜锁');
  let staleCalls = 0;
  globalThis.fetch = async () => { staleCalls++; throw new Error('失效行动不得触发模型'); };
  store.appendIncoming(chatKey, { mid: 200, ts: Date.now(), text: '等候中的行动', eventKind: 'trpg-action', senderId: actor, mentionsSelf: true });
  await runner.wake(chatKey);
  assert.equal(staleCalls, 0, '撤销权限后的排队行动不能转为普通聊天');
  globalThis.fetch = async (_url, options) => {
    staleCalls++;
    assert.equal(JSON.parse(options.body).messages[0].content.includes('跑团裁判／旁白模式'), false);
    return Response.json({ choices: [{ message: { role: 'assistant', tool_calls: [{ id: 'normal-after-exit', type: 'function', function: { name: 'finish', arguments: '{"summary":"普通聊天"}' } }] } }] });
  };
  store.appendIncoming(chatKey, { mid: 201, ts: Date.now(), text: '另一条失效行动', eventKind: 'trpg-action', senderId: actor, mentionsSelf: true });
  store.appendIncoming(chatKey, { mid: 202, ts: Date.now(), text: '现在正常聊天', senderId: actor, mentionsSelf: true });
  await runner.wake(chatKey);
  assert.equal(staleCalls, 1, '失效行动不能吞掉同一批次的新聊天');
});

test('真实消息入口：确定性指令直接消费，行动标记唤醒，重复事件不重复修改存档', async (t) => {
  const { createApp } = await import('../src/console/app.js');
  const { setRuntimeConfig, DEFAULT_CONFIG } = await import('../src/core/config.js');
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.runtime.mode = 'active'; cfg.runtime.paused = false;
  cfg.allow.groups = ['200001', '200002'];
  cfg.allow.private = ['123456', '234567'];
  cfg.trpg = { enabled: true, maxPlayers: 6, allowedGroups: ['200001'], allowedPrivate: ['123456'] };
  cfg.sticker.autoCollect = false;
  cfg.api.apiKey = 'test-key'; cfg.api.model = 'mock';
  setRuntimeConfig(cfg);
  const app = createApp({ log: () => {} });
  t.after(() => app.stop());
  const replies = [];
  app.sender.sendTextBatch = async (_chat, messages) => { replies.push(...messages); return { sent: messages.map((text) => ({ text })), failed: [] }; };
  let wakes = 0;
  app.orchestrator.onIncoming = () => { wakes++; };
  let id = 1000;
  const message = (text, uid = '123456', mid = ++id) => app.onebot.onEvent({ post_type: 'message', message_type: 'group', group_id: 200001, user_id: Number(uid), message_id: mid, time: Math.floor(Date.now() / 1000), sender: { nickname: '玩家' }, message: [{ type: 'text', data: { text } }] });
  await app.onebot.onEvent({ post_type: 'message', message_type: 'group', group_id: 200002, user_id: 123456, message_id: ++id, message: '/跑团 开团 mist-harbor' });
  assert.equal(app.trpg.current('group:200002'), null, '全局授权群也必须单独加入跑团白名单');
  await message('/跑团 开团 mist-harbor');
  await message('/跑团 加入 traveler');
  await message('/跑团 开始');
  assert.equal(wakes, 0);
  assert.equal(app.trpg.current('group:200001').status, 'playing');
  await message('/跑团 行动 观察码头', '234567');
  assert.equal(wakes, 0, '旁观者行动被拒绝并消费');
  await message('观察码头');
  assert.equal(wakes, 1);
  const entry = app.store.findByMid('group:200001', id);
  assert.equal(entry.mentionsSelf, true);
  assert.equal(entry.eventKind, 'trpg-action');
  await message('观察码头', '123456', id);
  assert.equal(wakes, 1, '普通行动的重复事件也不重复唤醒');
  await message('我也观察码头', '234567');
  assert.equal(wakes, 1, '旁观者普通消息不触发模型');
  await message('检查这张藏宝图 https://b23.tv/example');
  assert.equal(wakes, 2, '游戏消息优先作为行动，不交给链接下载器');
  assert.ok(app.trpg.actionContext('group:200001', [entry]), 'QQ秒级时间戳不能误判为开团前的消息');
  await message('/跑团 掷骰 1d20', '123456', 9000);
  const revision = app.trpg.current('group:200001').revision;
  await message('/跑团 掷骰 1d20', '123456', 9000);
  assert.equal(app.trpg.current('group:200001').revision, revision);
  assert.equal(replies.filter((text) => /掷骰.*合计/.test(text)).length, 1);
  await message('退出游戏', '234567');
  assert.equal(app.trpg.current('group:200001').status, 'playing', '只有团主可退出整局');
  await message('退出游戏');
  assert.equal(app.trpg.current('group:200001'), null);
  assert.equal(wakes, 2);
  await message('现在正常聊天');
  assert.equal(wakes, 3, '退出后恢复普通聊天路由');
  const privateMessage = (text, uid = 123456) => app.onebot.onEvent({ post_type: 'message', message_type: 'private', user_id: uid, message_id: ++id, message: text });
  await privateMessage('/跑团 开团 mist-harbor', 234567);
  assert.equal(app.trpg.current('private:234567'), null);
  for (const text of ['/跑团 开团 mist-harbor', '/跑团 加入 traveler', '/跑团 开始', '我独自探索灯塔']) await privateMessage(text);
  assert.equal(app.trpg.current('private:123456').status, 'playing');
  assert.equal(wakes, 4, '私聊开始后直接发言行动');
  await privateMessage('退出游戏');
  assert.equal(app.trpg.current('private:123456'), null);
  assert.equal(wakes, 4);
});
