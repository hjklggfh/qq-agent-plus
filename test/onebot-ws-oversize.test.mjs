// 超大请求体自动改走 WebSocket（上游 Issue #21，本项目 2026-10-08 复现并移植）。
//
// 根因：协议端（SnowLuma）的 OneBot **HTTP** 端点对请求体有 ≈2MiB 硬上限，超过时在
// 100-Continue 之后直接掐断连接 —— bot 侧只看到一句 undici 的 "fetch failed"，
// 真因（ECONNRESET）埋在 error.cause 里。而图片是整张 base64 塞进消息段的，
// 1024×1024 的图 base64 后 2~3MB+，正好压线：**小图偶尔成、大图必挂**。
// 修复：超过 HTTP_BODY_SAFE_MAX(1.5MiB) 的调用改走事件常驻的 WebSocket 通道。
//
// 断言纪律（照抄上游那份用例的三条，它们是被真实 bug 教出来的）：
//   1. 大请求经 WS 时**必须验证服务端收到的 params 载荷完整** —— 只查"发了帧"挡不住"漏带 params"；
//   2. 断线类用例先等帧真的到达服务端再动手，不用 sleep 撑时序；
//   3. 假协议端**只对带 echo 的帧应答**（真实协议端行为），并记录 HTTP 请求体。
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { WebSocketServer } from 'ws';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-onebot-ws-oversize-'));
process.env.QQ_AGENT_DATA_DIR = dataDir;
fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({ runtime: { mode: 'active' } }));
process.on('exit', () => {
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* Windows 句柄占用 */ }
});

const { OneBotClient } = await import('../src/onebot/onebot.js');

/** 与 onebot.js 里的阈值同一个数（它会随实现变，这里跟着改）。 */
const BODY_SAFE_MAX = 1536 * 1024;
/** JSON 外壳本身的字节数：构造"恰好等于阈值"的载荷时要减掉它。 */
const BIG_JSON_OVERHEAD = Buffer.byteLength(JSON.stringify({ big: '' }));
const BIG = 'A'.repeat(2 * 1024 * 1024);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(10);
  }
  return predicate();
}

/**
 * 假协议端：WS 收帧并应答（只答带 echo 的），HTTP 记下请求体。
 * wsStatus/wsRetcode 用来演"协议端明确拒绝"；hold=true 时故意不答（演超时）。
 */
async function startOneBotServer({ wsStatus = 'ok', wsRetcode = 0, hold = false } = {}) {
  const wss = new WebSocketServer({ port: 0 });
  await new Promise((resolve) => wss.once('listening', resolve));
  const httpServer = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      httpRequests.push({ url: req.url, body });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', retcode: 0, data: { via: 'http', message_id: 111 } }));
    });
  });
  await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));

  const wsReceived = [];
  const httpRequests = [];
  let live = null;
  wss.on('connection', (socket) => {
    live = socket;
    socket.on('message', (data) => {
      let frame = null;
      try { frame = JSON.parse(String(data)); } catch { return; }
      wsReceived.push(frame);
      // 真协议端只对**带 echo 的调用帧**应答；事件帧（我们发出去的）不该被应答
      if (frame?.echo === undefined || hold) return;
      socket.send(JSON.stringify({
        status: wsStatus,
        retcode: wsRetcode,
        wording: wsStatus === 'failed' ? '模拟拒绝' : '',
        data: { message_id: 777 },
        echo: frame.echo
      }));
    });
  });

  return {
    wsUrl: `ws://127.0.0.1:${wss.address().port}`,
    httpUrl: `http://127.0.0.1:${httpServer.address().port}`,
    wsReceived,
    httpRequests,
    terminate: () => live?.terminate(),
    sendEvent: (event) => live?.send(JSON.stringify(event)),
    close: async () => {
      await new Promise((resolve) => wss.close(resolve));
      await new Promise((resolve) => httpServer.close(resolve));
    }
  };
}

/** 起一个已连上的客户端（心跳关掉，免得 ping 打扰）。 */
async function connectedClient(fake, { onEvent } = {}) {
  const client = new OneBotClient({
    wsUrl: fake.wsUrl,
    httpUrl: fake.httpUrl,
    accessToken: 'test-token',
    onEvent,
    heartbeat: 'off'
  });
  client.connect();
  await waitFor(() => client.connected);
  return client;
}

test('超过阈值的调用改走 WS：HTTP 零请求，且载荷完整送达', async (t) => {
  const fake = await startOneBotServer();
  const client = await connectedClient(fake);
  t.after(async () => { client.close(); await fake.close(); });

  const data = await client.call('send_group_msg', { group_id: 123, message_type: 'group', big: BIG });
  assert.equal(data.message_id, 777);

  assert.equal(fake.httpRequests.filter((one) => String(one.url).includes('send_group_msg')).length, 0,
    '大请求不该再走 HTTP');
  assert.equal(fake.wsReceived.length, 1, '应当只有一帧');
  const frame = fake.wsReceived[0];
  assert.equal(frame.action, 'send_group_msg');
  assert.ok(frame.echo, 'WS 调用必须带 echo（否则应答无法关联）');
  // 「发了帧」不等于「发对了」——载荷必须完整
  assert.equal(frame.params.big.length, BIG.length, 'payload 必须完整送达');
  assert.equal(frame.params.group_id, 123, 'params 不能漏字段');
  assert.equal(frame.params.message_type, 'group');
});

test('小请求仍走原 HTTP 路线（守卫不许变成一律走 WS），且请求体完整', async (t) => {
  const fake = await startOneBotServer();
  const client = await connectedClient(fake);
  t.after(async () => { client.close(); await fake.close(); });

  const data = await client.call('get_version_info', {});
  assert.equal(data.via, 'http');
  assert.equal(fake.httpRequests.filter((one) => String(one.url).includes('get_version_info')).length, 1);
  assert.equal(fake.wsReceived.length, 0, '小请求不该占用 WS 通道');
  assert.equal(fake.httpRequests[0].body, '{}', 'HTTP 请求体也要带上（发空体也算"漏带 params"）');
});

test('阈值边界：恰好等于上限仍走 HTTP，多 1 字节改走 WS', async (t) => {
  const fake = await startOneBotServer();
  const client = await connectedClient(fake);
  t.after(async () => { client.close(); await fake.close(); });

  // 构造 body 恰好等于阈值
  const exact = 'A'.repeat(BODY_SAFE_MAX - BIG_JSON_OVERHEAD);
  assert.equal(Buffer.byteLength(JSON.stringify({ big: exact })), BODY_SAFE_MAX, '构造应恰好等于阈值');
  await client.call('get_version_info', { big: exact });
  // 只数这一次调用：connect() 时客户端自己会打一次 get_login_info（也走 HTTP）
  const calls = () => fake.httpRequests.filter((one) => String(one.url).includes('get_version_info')).length;
  assert.equal(calls(), 1, '等于阈值仍走 HTTP');
  assert.equal(fake.wsReceived.length, 0);

  await client.call('send_group_msg', { big: `${exact}A` });
  assert.equal(fake.wsReceived.length, 1, '超过阈值 1 字节就必须改走 WS');
  assert.equal(fake.wsReceived[0].params.big.length, exact.length + 1, '载荷仍要完整');
});

test('WS 应答 status=failed：按明确失败结清（口径与 HTTP 通道一致）', async (t) => {
  const fake = await startOneBotServer({ wsStatus: 'failed', wsRetcode: 1200 });
  const client = await connectedClient(fake);
  t.after(async () => { client.close(); await fake.close(); });

  const error = await client.call('send_group_msg', { big: BIG }).then(() => null, (e) => e);
  assert.ok(error, '应该抛错');
  assert.equal(error.name, 'OneBotActionError');
  assert.equal(error.outcome, 'failed', '协议端明确拒绝 = 确定没做，可以重试');
  assert.match(error.message, /retcode=1200/);
});

test('WS 中途断线：在途调用立即按 unknown 结清，不挂到超时', async (t) => {
  const fake = await startOneBotServer({ hold: true });
  const client = await connectedClient(fake);
  t.after(async () => { client.close(); await fake.close(); });

  const promise = client.call('send_group_msg', { big: BIG }, 10000).then(() => null, (e) => e);
  // 先等帧真的到了服务端，再断——不用 sleep 撑时序
  assert.ok(await waitFor(() => fake.wsReceived.length === 1), '帧应先到达服务端');
  fake.terminate();
  const error = await promise;
  assert.ok(error, '断线后调用应当结清');
  assert.match(error.message, /断开|投递状态未知/);
  assert.equal(error.outcome, 'unknown', '断线 = 不知道对方收没收到，必须 unknown');
});

test('WS 应答超时：按 unknown 结清', async (t) => {
  const fake = await startOneBotServer({ hold: true });
  const client = await connectedClient(fake);
  t.after(async () => { client.close(); await fake.close(); });

  const error = await client.call('send_group_msg', { big: BIG }, 400).then(() => null, (e) => e);
  assert.ok(error);
  assert.equal(error.outcome, 'unknown');
  assert.match(error.message, /超时/);
});

test('WS 调用期间事件帧照常分发，且**命中 echo 的应答**不会漏进事件流', async (t) => {
  const events = [];
  const fake = await startOneBotServer({ hold: true });
  const client = await connectedClient(fake, { onEvent: (event) => events.push(event) });
  t.after(async () => { client.close(); await fake.close(); });

  const promise = client.call('send_group_msg', { big: BIG }, 5000);
  assert.ok(await waitFor(() => fake.wsReceived.length === 1), '调用帧应先到达');
  const echo = fake.wsReceived[0].echo;

  // ① 事件帧照常分发（同一个通道上调用与事件谁也不许吞谁）
  fake.sendEvent({ post_type: 'message', message_type: 'group', group_id: 9, raw_message: 'hi' });
  assert.ok(await waitFor(() => events.length === 1), '事件应当照常分发');
  assert.equal(events[0].group_id, 9);
  await sleep(60);

  // ② 命中 echo 的应答帧要被调用**吃掉**，不能变成一条假事件
  //    （口径照上游：只吞命中在途表的 echo；不命中的帧照旧当事件处理）
  fake.sendEvent({ status: 'ok', retcode: 0, data: { message_id: 999 }, echo });
  const result = await promise;
  assert.equal(result.message_id, 999, '应答应被在途调用收走');
  await sleep(60);
  assert.equal(events.length, 1, '带 echo 的应答帧不该漏进事件流');
  assert.equal(client.wsPending.size, 0);
});

test('WS 未连接时大请求回落 HTTP（保留原有网络行为 + 告警日志）', async (t) => {
  const fake = await startOneBotServer();
  const client = new OneBotClient({ wsUrl: fake.wsUrl, httpUrl: fake.httpUrl, onEvent: () => {}, heartbeat: 'off' });
  t.after(async () => { client.close(); await fake.close(); });
  // 故意不 connect()：connected=false、socket=null

  const warnings = [];
  const original = console.warn;
  console.warn = (...args) => warnings.push(args.map(String).join(' '));
  try {
    const data = await client.call('send_group_msg', { big: BIG });
    assert.equal(data.via, 'http', 'WS 没连上就该回落 HTTP');
  } finally {
    console.warn = original;
  }
  assert.equal(fake.wsReceived.length, 0);
  assert.equal(fake.httpRequests.length, 1);
  assert.ok(fake.httpRequests[0].body.length > 2 * 1024 * 1024, '回落时载荷也要完整');
  assert.ok(fake.httpRequests[0].body.includes('"big"'));
  assert.ok(warnings.some((line) => /超过 HTTP 安全阈值且 WS 未连接/.test(line)),
    `应当留下告警（否则线上只会看到"发不出去"而没有解释），实际：${warnings.join(' | ')}`);
});

test('callViaWs 直连兜底：未连接时按 failed 拒绝（确定没写进任何连接）', async (t) => {
  const fake = await startOneBotServer();
  const client = new OneBotClient({ wsUrl: fake.wsUrl, httpUrl: fake.httpUrl, onEvent: () => {}, heartbeat: 'off' });
  t.after(async () => { client.close(); await fake.close(); });

  const error = await client.callViaWs('send_group_msg', { big: BIG }).then(() => null, (e) => e);
  assert.ok(error);
  assert.equal(error.outcome, 'failed', '没写进任何连接 = 确定未投递，必须 failed');
  assert.match(error.message, /未连接/);
});

test('并发在途调用各拿各的 echo 应答，不串扰', async (t) => {
  const fake = await startOneBotServer();
  const client = await connectedClient(fake);
  t.after(async () => { client.close(); await fake.close(); });

  const [r1, r2] = await Promise.all([
    client.call('send_group_msg', { big: `${BIG}1` }),
    client.call('send_group_msg', { big: `${BIG}2` })
  ]);
  assert.equal(r1.message_id, 777);
  assert.equal(r2.message_id, 777);
  assert.deepEqual(fake.wsReceived.map((frame) => frame.echo), ['ws_1', 'ws_2'], 'echo 必须按序唯一');
  assert.equal(client.wsPending.size, 0, '结清后不该留下在途记录');
});

test('signal 预中止：按中止原因结清，一帧都不发；wsPending 不留残骸', async (t) => {
  const fake = await startOneBotServer();
  const client = await connectedClient(fake);
  t.after(async () => { client.close(); await fake.close(); });

  const aborted = AbortSignal.abort(new Error('测试取消'));
  const error = await client.call('send_group_msg', { big: BIG }, 5000, aborted).then(() => null, (e) => e);
  assert.ok(error);
  assert.equal(error.message, '测试取消', '预中止要按 signal.reason 结清');
  assert.equal(fake.wsReceived.length, 0, '已经中止就不该发帧');
  assert.equal(client.wsPending.size, 0);

  // 残骸检查：之后再来一次必须照常成功
  const ok = await client.call('send_group_msg', { big: BIG });
  assert.equal(ok.message_id, 777);
});

test('close() 会把在途调用按 unknown 结清并给出关闭原因', async (t) => {
  const fake = await startOneBotServer({ hold: true });
  const client = await connectedClient(fake);
  t.after(async () => { await fake.close(); });

  const promise = client.call('send_group_msg', { big: BIG }, 10000).then(() => null, (e) => e);
  assert.ok(await waitFor(() => fake.wsReceived.length === 1));
  client.close();
  const error = await promise;
  assert.equal(error?.outcome, 'unknown');
  assert.match(error.message, /已关闭/);
  assert.equal(client.wsPending.size, 0);
});

test('WS send 回调报错（帧确定没写进 socket）按 failed 结清，可自动重试', async (t) => {
  const fake = await startOneBotServer();
  const client = await connectedClient(fake);
  t.after(async () => { client.close(); await fake.close(); });

  // 换一个"send 会回调报错"的假 socket（readyState 保持 OPEN，这样才会进 WS 通道）
  const real = client.socket;
  client.socket = {
    readyState: real.readyState,
    send: (_data, callback) => callback(new Error('WebSocket is not open: readyState 2 (CLOSING)'))
  };
  const error = await client.callViaWs('send_group_msg', { big: BIG }).then(() => null, (e) => e);
  client.socket = real;

  assert.ok(error);
  assert.equal(error.outcome, 'failed',
    'send 回调报错 = 帧确定没写进 socket = 可重试；压成 unknown 会升级成 critical 人工核对');
  assert.match(error.message, /WS 发送失败/);
  assert.equal(client.wsPending.size, 0, '失败也要把在途记录清掉');
});

test('阈值按**字节**算而不是字符数：中文正文必须按 UTF-8 字节判', async (t) => {
  // '中' 是 1 个字符 / 3 个字节：字符数远低于阈值、字节数超过。
  // 若实现写成 `bodyJson.length > MAX`（字符数），这种消息会错走 HTTP ——
  // 而 HTTP 正是协议端会掐断的那条路（本地实测 2MB 起断连）。所以这条用例专门钉住口径。
  const fake = await startOneBotServer();
  const client = await connectedClient(fake);
  t.after(async () => { client.close(); await fake.close(); });

  const text = '中'.repeat(Math.ceil(BODY_SAFE_MAX / 3) + 200);
  assert.ok(text.length < BODY_SAFE_MAX, '前提：字符数低于阈值（否则证明不了按字节判）');
  assert.ok(Buffer.byteLength(JSON.stringify({ text })) > BODY_SAFE_MAX, '前提：字节数超过阈值');

  await client.call('send_group_msg', { text });
  assert.equal(fake.wsReceived.length, 1, '按字节超限就必须走 WS');
  assert.equal(fake.wsReceived[0].params.text.length, text.length, '中文载荷必须完整送达');
});

test('sendSticker 端到端：整图 base64 超阈值时整条链路自动落到 WS', async (t) => {
  const fake = await startOneBotServer();
  const client = await connectedClient(fake);
  t.after(async () => { client.close(); await fake.close(); });

  const image = `base64://${'A'.repeat(2 * 1024 * 1024)}`;
  const data = await client.sendSticker('group', '12345', image, {});
  assert.equal(data.message_id, 777);
  assert.equal(fake.httpRequests.filter((one) => /\/send_/.test(String(one.url))).length, 0,
    '图片发送不该再走 HTTP（那条路必被协议端掐断）');
  const frame = fake.wsReceived[fake.wsReceived.length - 1];
  assert.equal(frame.action, 'send_group_msg');
  assert.equal(frame.params.group_id, 12345);
  const segment = frame.params.message.find((one) => one.type === 'image');
  assert.equal(segment.data.file, image, '整图 base64 要完整送达');
  // ⚠️ 这里只断言本项目的 sendSticker 真的会发的字段。上游那份用例还断言了
  //    `sub_type: 1` 与 `summary: '[动画表情]'` —— 那是 NapCat 系的扩展字段，
  //    本项目的 sendSticker 不带（照抄会得到一条假红）。
});
