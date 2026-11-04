// 发送失败的定性：能证明"没送达"的算 failed（可被「重试失败批次」捞回来），
// 可能已经投递的才算 unknown（持有待人工核对）。
//
// 背景（2026-09-23 全项目审查）：以前 outbox 的 outcome 只看 error.outcome，而那只在
// OneBotActionError 上才有；裸 undici 失败（ECONNREFUSED 等）永远落进 unknown ——
// 一次"连接被拒"会被记成 critical 未知写入挂在"待处理"，回复静默丢失且不可重试。
import assert from 'node:assert/strict';
import { it } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-send-outcome-'));
process.env.QQ_AGENT_DATA_DIR = dir;
process.on('exit', () => fs.rmSync(dir, { recursive: true, force: true }));

const { ChatStore } = await import('../src/core/store.js');
const { SendQueue, classifyTransportFailure } = await import('../src/onebot/sender.js');
const { OneBotClient } = await import('../src/onebot/onebot.js');
const { setRuntimeConfig, DEFAULT_CONFIG } = await import('../src/core/config.js');

const cfg = structuredClone(DEFAULT_CONFIG);
cfg.runtime.mode = 'active';
cfg.allow.groups = ['1'];
setRuntimeConfig(cfg);

const fetchFailure = (code) => Object.assign(new TypeError('fetch failed'), { cause: { code } });

it('classifyTransportFailure：连不上=确定没送达，超时/重置/5xx=结果未知', () => {
  const refused = classifyTransportFailure(fetchFailure('ECONNREFUSED'));
  assert.equal(refused.definite, true);
  assert.equal(refused.uncertain, false);

  for (const code of ['ECONNRESET', 'ETIMEDOUT', 'EPIPE']) {
    const r = classifyTransportFailure(fetchFailure(code));
    assert.equal(r.definite, false, code);
    assert.equal(r.uncertain, true, code);
  }
  assert.equal(classifyTransportFailure(new Error('HTTP 502 Bad Gateway')).uncertain, true, '协议端 5xx 可能已转发');
  assert.equal(classifyTransportFailure(new Error('Request timeout after 15000ms')).uncertain, true);
  const receiptUnknown = Object.assign(new Error('delivery was not confirmed: ECONNREFUSED'), { outcome: 'unknown' });
  assert.equal(classifyTransportFailure(receiptUnknown).definite, false);
  assert.equal(classifyTransportFailure(receiptUnknown).uncertain, true);
});

it('合并转发缺失回执：outbox 记 unknown，同一次运行不能再次发送', async (t) => {
  const caseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-forward-receipt-'));
  const store = new ChatStore(0, { dataDir: caseDir });
  t.after(() => { store.close(); fs.rmSync(caseDir, { recursive: true, force: true }); });
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    return { ok: true, status: 200, json: async () => ({
      status: 'failed', retcode: 100,
      message: 'group message delivery was not confirmed: QQ returned no message receipt'
    }) };
  });
  const bot = new OneBotClient({ httpUrl: 'http://127.0.0.1:1' });
  // 禁言查询不属于本测试的发送请求。
  bot.getGroupInfo = async () => ({});
  bot.getGroupMemberInfo = async () => ({});
  const incidents = [];
  const sender = new SendQueue({ store, onebot: bot, onIncident: (_error, details) => incidents.push(details) });
  const payload = { nodes: [{ type: 'node', data: { uin: '1', name: 'test', content: [{ type: 'text', data: { text: 'ordinary test message' } }] } }] };
  const options = { runId: 'receipt-test' };
  await assert.rejects(sender.forward('group:1', payload, options), error => error.outcome === 'unknown');
  assert.equal(calls, 1);
  assert.equal(outboxState(store, 'group:1'), 'unknown');
  assert.equal(incidents.at(-1)?.outcome, 'unknown');
  await assert.rejects(sender.forward('group:1', payload, options), /uncertain/);
  assert.equal(calls, 1);
  assert.equal(store.listUnknownOperations('group:1').length, 1);
});

// outbox 的落库状态（记账口径就是它）：failed = 确认没送达、可重试；unknown = 可能已投递、持有待核对。
const outboxState = (store, chatKey) => store.db
  .prepare("SELECT state FROM outbox WHERE chat_key=? ORDER BY rowid DESC LIMIT 1")
  .get(chatKey)?.state;

it('确认未送达的裸 fetch 失败记成 failed（可重试），不占"待核对"', async () => {
  const store = new ChatStore(0, { dataDir: dir });
  const sender = new SendQueue({ store, onebot: { sendText: async () => { throw fetchFailure('ECONNREFUSED'); } } });
  await assert.rejects(() => sender.sendTextBatch('group:1', ['hi']));
  assert.equal(store.getChatMeta('group:1').held, 0, '确定没送达的不该记成未知写入');
  assert.equal(outboxState(store, 'group:1'), 'failed', '要记成 failed，人工「重试失败批次」才捞得回来');
  store.close();
});

it('结果未知的失败仍记成 unknown（持有待人工核对）', async () => {
  const store = new ChatStore(0, { dataDir: dir });
  const sender = new SendQueue({ store, onebot: { sendText: async () => { throw fetchFailure('ECONNRESET'); } } });
  await assert.rejects(() => sender.sendTextBatch('group:1', ['hi']));
  assert.equal(store.getChatMeta('group:1').held, 1, '可能已投递的要持有，等人工核对');
  assert.equal(outboxState(store, 'group:1'), 'unknown');
  assert.equal(store.listUnknownOperations('group:1').length, 1, '未知写入要出现在待核对清单里');
  store.close();
});
