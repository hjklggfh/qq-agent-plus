import assert from 'node:assert/strict';
import { it } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-delivery-'));
process.env.QQ_AGENT_DATA_DIR = dir;
process.on('exit', () => fs.rmSync(dir, { recursive: true, force: true }));
const { ChatStore } = await import('../src/core/store.js');
const { SessionRegistry } = await import('../src/core/sessions.js');
const { SendQueue } = await import('../src/onebot/sender.js');
const { OneBotActionError, OneBotClient } = await import('../src/onebot/onebot.js');
const { Orchestrator } = await import('../src/core/orchestrator.js');
const { setRuntimeConfig, DEFAULT_CONFIG } = await import('../src/core/config.js');

it('holds uncertain deliveries and does not automatically send again on new input', async (t) => {
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.runtime.mode = 'active';
  cfg.allow.groups = ['1'];
  cfg.api.model = 'test';
  cfg.api.baseUrl = 'https://model.invalid';
  cfg.sticker.enabled = false;
  cfg.memory.consolidateEnabled = false;
  setRuntimeConfig(cfg);
  let sends = 0;
  const onebot = {
    getGroupInfo: async () => ({ group_name: 'test' }),
    sendText: async () => { sends++; throw new Error('HTTP response lost after remote delivery'); }
  };
  const store = new ChatStore(0, { dataDir: dir });
  const sessions = new SessionRegistry();
  const sender = new SendQueue({ store, onebot });
  const runner = new Orchestrator({ store, sessions, sender, onebot,
    stickers: {}, memory: { formatForPrompt: () => '' } });
  const oldFetch = globalThis.fetch;
  t.after(async () => { globalThis.fetch = oldFetch; await runner.abortAll(); store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  globalThis.fetch = async () => Response.json({ choices: [{ message: { tool_calls: [
    { id: 'send-1', function: { name: 'send_message', arguments: '{"messages":"hello"}' } }
  ] } }], usage: { total_tokens: 10 } });
  store.appendIncoming('group:1', { mid: 1, text: 'hello', senderId: '42' });
  await runner.wake('group:1');
  assert.equal(sends, 1);
  assert.equal(store.getChatMeta('group:1').held, 1);
  assert.equal(sessions.listSummaries(1)[0].status, 'error');
  store.appendIncoming('group:1', { mid: 2, text: 'new', senderId: '42' });
  await runner.wake('group:1');
  assert.equal(sends, 1);
  assert.equal(store.findByMid('group:1', 2).state, 'pending');
  assert.equal(store.retryFailed('group:1'), 0);
  assert.equal(store.resolveHeld('group:1'), 1);
  assert.equal(store.getChatMeta('group:1').held, 0);
});

it('also blocks a chat after an uncertain proactive send with no input lease', async (t) => {
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.runtime.mode = 'active';
  cfg.allow.groups = ['1'];
  cfg.api.model = 'test';
  cfg.api.baseUrl = 'https://model.invalid';
  cfg.sticker.enabled = false;
  cfg.memory.consolidateEnabled = false;
  setRuntimeConfig(cfg);
  let sends = 0;
  const onebot = {
    getGroupInfo: async () => ({ group_name: 'test' }),
    sendText: async () => { sends++; throw new Error('response lost'); }
  };
  const store = new ChatStore(0, { dataDir: dir });
  const sessions = new SessionRegistry();
  const runner = new Orchestrator({
    store, sessions, onebot, stickers: {}, memory: { formatForPrompt: () => '' },
    sender: new SendQueue({ store, onebot })
  });
  const oldFetch = globalThis.fetch;
  t.after(async () => { globalThis.fetch = oldFetch; await runner.abortAll(); store.close(); });
  globalThis.fetch = async () => Response.json({ choices: [{ message: { tool_calls: [
    { id: 'send-2', function: { name: 'send_message', arguments: '{"messages":"hello"}' } }
  ] } }], usage: { total_tokens: 10 } });
  await runner.wake('group:1', { proactive: true });
  assert.equal(sends, 1);
  assert.equal(store.getChatMeta('group:1').held, 1);
  store.appendIncoming('group:1', { mid: 2, text: 'new', senderId: '42' });
  await runner.wake('group:1');
  assert.equal(sends, 1);
  assert.equal(store.resolveHeld('group:1'), 1);
});

it('送达之后查被引用消息失败，不能把已经发出的消息改判成发送失败', async (t) => {
  // findByMid 发生在 sendText 成功返回**之后**：库读抛错（磁盘/库损坏这类不受
  // busy_timeout 管的错）若漏出去，整条 promise reject → 该条记 failed → 模型重发 →
  // 群里两条一样的消息。与 #afterSent 同源的漏兜（2026-10-05 全审）。
  const caseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-delivery-reply-'));
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.runtime.mode = 'active';
  cfg.allow.groups = ['1'];
  cfg.api.model = 'test';
  cfg.api.baseUrl = 'https://model.invalid';
  cfg.sticker.enabled = false;
  cfg.memory.consolidateEnabled = false;
  setRuntimeConfig(cfg);
  let sends = 0;
  const onebot = {
    getGroupInfo: async () => ({ group_name: 'test' }),
    sendText: async () => { sends++; return { message_id: 7 }; }
  };
  const store = new ChatStore(0, { dataDir: caseDir });
  // ⚠️ 关库要在删目录**之前**（同一个钩子里按顺序做）：分开注册两个 after 时 Windows 上
  // 会先删目录、撞上还开着的 sqlite 句柄报 EPERM（本文件里那几条环境性失败就是这个成因）。
  t.after(() => { store.close(); fs.rmSync(caseDir, { recursive: true, force: true }); });
  const sender = new SendQueue({ store, onebot });
  store.findByMid = () => { throw new Error('disk I/O error'); };

  const result = await sender.sendTextBatch('group:1', ['hello'], { replyToMessageId: 123 });

  assert.equal(sends, 1, '消息确实发出去了');
  assert.equal(result.sent.length, 1, '送达之后的库读失败不能改判成发送失败（否则模型会重发）');
  assert.equal(result.failed.length, 0);
});

it('改群名片：送达后记账失败不改判成失败，运行中止后不再写', async (t) => {
  // PR#19 合并后补的两处（2026-10-05 复审）：①新写路径要跟五条发送路径同款走 #afterSent
  // —— 名片已经改了，之后的 appendSelf 抛错不能把结果改判成"改群名片失败"；
  // ②工具侧传了 signal 就必须真的用上，等待期间运行被中止就别再发出写入。
  const caseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-delivery-card-'));
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.runtime.mode = 'active';
  cfg.allow.groups = ['1', '2', '3'];
  cfg.api.model = 'test';
  cfg.api.baseUrl = 'https://model.invalid';
  cfg.sticker.enabled = false;
  cfg.memory.consolidateEnabled = false;
  setRuntimeConfig(cfg);
  const store = new ChatStore(0, { dataDir: caseDir });
  t.after(() => { store.close(); fs.rmSync(caseDir, { recursive: true, force: true }); });
  const calls = [];
  const onebot = {
    selfId: '888',
    setGroupCard: async (gid, uid, card, signal) => {
      calls.push({ gid, uid, card, aborted: Boolean(signal?.aborted) });
      return { ok: true };
    }
  };
  const sender = new SendQueue({ store, onebot });

  // ① 正常路径：发出写入 + 群里留档（下次运行模型才知道自己现在叫什么）
  await sender.setCard('group:1', '新名字');
  assert.deepEqual(calls, [{ gid: '1', uid: '888', card: '新名字', aborted: false }]);
  const selfTexts = store.recent('group:1', { limit: 5 }).map((m) => m.text);
  assert.ok(selfTexts.some((x) => x.includes('改群名片') && x.includes('新名字')), '改完要留档');

  // ② 记账失败：名片已经改成功，不许 reject（否则工具回"失败"、模型以为没改成）
  const realAppend = store.appendSelf.bind(store);
  store.appendSelf = () => { throw new Error('disk full'); };
  await sender.setCard('group:2', '新名字2');
  store.appendSelf = realAppend;
  assert.deepEqual(calls.at(-1), { gid: '2', uid: '888', card: '新名字2', aborted: false },
    '记账失败发生在写入成功之后');

  // ③ 运行已中止：等待期间被取消 → 不再发出写入
  const controller = new AbortController();
  controller.abort(new Error('stopped'));
  await assert.rejects(() => sender.setCard('group:3', '新名字3', { signal: controller.signal }));
  assert.equal(calls.some((c) => c.gid === '3'), false, '中止后不该改名片');
});

it('incident pilot quarantines an unknown write without blocking later messages', async (t) => {
  const caseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-delivery-pilot-'));
  t.after(() => fs.rmSync(caseDir, { recursive: true, force: true }));
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.runtime.mode = 'active';
  cfg.allow.groups = ['1'];
  cfg.api.model = 'test';
  cfg.api.baseUrl = 'https://model.invalid';
  cfg.sticker.enabled = false;
  cfg.memory.consolidateEnabled = false;
  setRuntimeConfig(cfg);
  let sends = 0;
  const onebot = {
    connected: true,
    getGroupInfo: async () => ({ group_name: 'test' }),
    sendText: async () => {
      sends++;
      if (sends === 1) throw new Error('response lost');
      return { message_id: 99 };
    }
  };
  const store = new ChatStore(0, { dataDir: caseDir });
  const sessions = new SessionRegistry();
  const incidentPilot = {
    active: true,
    capture: () => null,
    chatDecision: (_chatKey, meta) => ({
      allowed: true,
      mode: 'auto',
      effectiveState: meta.held ? 'degraded' : 'normal',
      reason: meta.held ? '旧写入待核对' : ''
    }),
    contextForChat: () => '【异常隔离】不要重试旧操作'
  };
  const runner = new Orchestrator({
    store,
    sessions,
    onebot,
    stickers: {},
    memory: { formatForPrompt: () => '' },
    sender: new SendQueue({ store, onebot }),
    getIncidentPilot: () => incidentPilot
  });
  const oldFetch = globalThis.fetch;
  let calls = 0;
  t.after(async () => {
    globalThis.fetch = oldFetch;
    await runner.abortAll();
    store.close();
  });
  globalThis.fetch = async () => {
    calls++;
    return Response.json({
      choices: [{
        message: calls <= 2
          ? { tool_calls: [{
              id: `send-${calls}`,
              function: { name: 'send_message', arguments: `{"messages":"message-${calls}"}` }
            }] }
          : { content: 'done' }
      }],
      usage: { total_tokens: 10 }
    });
  };

  store.appendIncoming('group:1', { mid: 1, text: 'first', senderId: '42' });
  await runner.wake('group:1');
  assert.equal(store.getChatMeta('group:1').held, 1);
  store.appendIncoming('group:1', { mid: 2, text: 'second', senderId: '42' });
  await runner.wake('group:1');
  assert.equal(sends, 2);
  assert.equal(store.findByMid('group:1', 2).state, 'acked');
  assert.equal(store.getChatMeta('group:1').held, 1);
  const latest = sessions.get(sessions.listSummaries(1)[0].id);
  assert.match(latest.userPrompt, /异常隔离/);
});

it('manual incident control blocks model work while preserving unread input', async (t) => {
  const caseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-delivery-blocked-'));
  t.after(() => fs.rmSync(caseDir, { recursive: true, force: true }));
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.runtime.mode = 'active';
  cfg.allow.groups = ['1'];
  cfg.api.model = 'test';
  cfg.api.baseUrl = 'https://model.invalid';
  cfg.sticker.enabled = false;
  cfg.memory.consolidateEnabled = false;
  setRuntimeConfig(cfg);
  const store = new ChatStore(0, { dataDir: caseDir });
  const sessions = new SessionRegistry();
  let modelCalls = 0;
  const runner = new Orchestrator({
    store,
    sessions,
    onebot: {
      connected: true,
      getGroupInfo: async () => ({ group_name: 'test' })
    },
    stickers: {},
    memory: { formatForPrompt: () => '' },
    sender: new SendQueue({ store, onebot: {} }),
    getIncidentPilot: () => ({
      active: true,
      chatDecision: () => ({
        allowed: false,
        mode: 'blocked',
        effectiveState: 'blocked',
        reason: '管理员已阻塞'
      })
    })
  });
  const oldFetch = globalThis.fetch;
  t.after(async () => {
    globalThis.fetch = oldFetch;
    await runner.abortAll();
    store.close();
  });
  globalThis.fetch = async () => {
    modelCalls++;
    return Response.json({ choices: [{ message: { content: 'unexpected' } }] });
  };
  store.appendIncoming('group:1', { mid: 20, text: '@bot', senderId: '42' });
  await runner.wake('group:1');
  assert.equal(modelCalls, 0);
  assert.equal(store.findByMid('group:1', 20).state, 'pending');
  assert.match(runner.requestManualWake('group:1').reason, /阻塞/);
});

it('keeps explicit OneBot business rejection retryable without holding the chat', async (t) => {
  const caseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-delivery-definite-'));
  t.after(() => fs.rmSync(caseDir, { recursive: true, force: true }));
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.runtime.mode = 'active';
  cfg.allow.groups = ['1'];
  cfg.api.model = 'test';
  cfg.api.baseUrl = 'https://model.invalid';
  cfg.sticker.enabled = false;
  cfg.memory.consolidateEnabled = false;
  setRuntimeConfig(cfg);
  let sends = 0;
  const onebot = {
    connected: true,
    getGroupInfo: async () => ({ group_name: 'test' }),
    sendText: async () => {
      sends++;
      throw new OneBotActionError(
        'OneBot send_group_msg 失败: retcode=100 failed to resolve UID',
        { action: 'send_group_msg', outcome: 'failed', retcode: 100 }
      );
    }
  };
  const store = new ChatStore(0, { dataDir: caseDir });
  const sessions = new SessionRegistry();
  const runner = new Orchestrator({
    store,
    sessions,
    onebot,
    stickers: {},
    memory: { formatForPrompt: () => '' },
    sender: new SendQueue({ store, onebot })
  });
  const oldFetch = globalThis.fetch;
  let calls = 0;
  t.after(async () => {
    globalThis.fetch = oldFetch;
    await runner.abortAll();
    store.close();
  });
  globalThis.fetch = async () => {
    calls++;
    return Response.json({
      choices: [{
        message: calls === 1
          ? { tool_calls: [{
              id: 'send-definite-failure',
              function: { name: 'send_message', arguments: '{"messages":"hello"}' }
            }] }
          : { content: 'stop after the explicit rejection' }
      }],
      usage: { total_tokens: 10 }
    });
  };

  store.appendIncoming('group:1', { mid: 10, text: 'hello', senderId: '42' });
  await runner.wake('group:1');

  assert.equal(sends, 1);
  assert.equal(store.getChatMeta('group:1').held, 0);
  assert.equal(store.findByMid('group:1', 10).state, 'acked');
  assert.notEqual(sessions.listSummaries(1)[0].status, 'error');
});

it('classifies a parsed OneBot retcode as failed but keeps malformed responses unknown', async (t) => {
  const client = new OneBotClient({
    httpUrl: 'http://onebot.invalid',
    wsUrl: 'ws://onebot.invalid',
    onEvent: () => {}
  });
  const oldFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = oldFetch; });

  globalThis.fetch = async () => Response.json({
    status: 'failed',
    retcode: 100,
    wording: 'Process_Nudge failed'
  });
  await assert.rejects(
    client.call('group_poke', { group_id: 1, user_id: 2 }),
    (error) => error instanceof OneBotActionError
      && error.outcome === 'failed'
      && error.retcode === 100
  );

  globalThis.fetch = async () => new Response('not-json', {
    status: 200,
    headers: { 'content-type': 'application/json' }
  });
  await assert.rejects(
    client.call('send_group_msg', { group_id: 1, message: [] }),
    (error) => error instanceof OneBotActionError && error.outcome === 'unknown'
  );
});

it('image()：按 image 段发出、留档写 [图片] 而不是表情包，且 base64 本体不进 outbox', async (t) => {
  const caseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-delivery-image-'));
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.runtime.mode = 'active';
  cfg.allow.groups = ['1', '2'];
  cfg.api.model = 'test';
  cfg.api.baseUrl = 'https://model.invalid';
  cfg.sticker.enabled = false;
  cfg.memory.consolidateEnabled = false;
  setRuntimeConfig(cfg);
  const store = new ChatStore(0, { dataDir: caseDir });
  t.after(() => { store.close(); fs.rmSync(caseDir, { recursive: true, force: true }); });

  const calls = [];
  const onebot = {
    selfId: '888',
    sendSticker: async (kind, id, url, opts) => {
      calls.push({ kind, id, url, opts });
      return { message_id: 77 };
    }
  };
  const sender = new SendQueue({ store, onebot });

  // 用一段足够长的假 base64：短了就算写进 outbox 也看不出来
  const body = Buffer.alloc(4096, 7).toString('base64');
  const out = await sender.image('group:1', { url: `base64://${body}`, bytes: 4096, label: '初音ミク' });
  assert.equal(out.message_id, 77);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].kind, 'group');
  assert.equal(calls[0].id, '1');
  assert.equal(calls[0].url, `base64://${body}`, '原样把 url 交给 onebot（它负责拼 image 段）');

  // 留档：必须是"图片"。写成 [表情包:…] 会让模型自己读到的"我发过什么"与 outbox 记账都失真
  const selfTexts = store.recent('group:1', { limit: 5 }).filter((m) => m.self).map((m) => m.text);
  assert.ok(selfTexts.some((x) => x.startsWith('[图片') && x.includes('初音ミク')),
    `留档应含 [图片:初音ミク]，实际 ${JSON.stringify(selfTexts)}`);
  assert.equal(selfTexts.some((x) => x.includes('表情包')), false, '图片不该被记成表情包');

  // ⚠️ outbox 的 payload 里绝不能出现 base64 本体：那是会被 beginSend 写进 sqlite 的字段，
  //    几 MB 的图会把数据目录写胖（这里直接查表，不靠推断）。
  const rows = store.db.prepare('SELECT payload FROM outbox').all();
  assert.ok(rows.length >= 1);
  for (const row of rows) {
    assert.equal(String(row.payload).includes(body), false, 'outbox payload 里混进了图片 base64');
    assert.ok(String(row.payload).includes('"type":"image"'), `payload 应是 image 类型：${row.payload}`);
  }

  // 记账失败发生在**已经送达之后**：不许改判成发送失败（否则模型会重发，群里多一张）
  const realAppend = store.appendSelf.bind(store);
  store.appendSelf = () => { throw new Error('disk full'); };
  const second = await sender.image('group:2', { url: 'https://example.invalid/x.png', bytes: 1 });
  store.appendSelf = realAppend;
  assert.equal(second.message_id, 77, '记账失败不该让已送达的发图 reject');
  assert.equal(calls.length, 2);
});
