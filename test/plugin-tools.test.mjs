// 插件工具的契约用例：注入工具表、能力面收窄、超时、返回值归一、宿主原始 ctx 不泄漏。
//
// 这里最要紧的两组断言：
//   ① 「没有插件时工具表与升级前逐字一致」—— 插件系统不能改变既有行为；
//   ② 「未声明的能力在门面上根本不存在」+「原始 ctx 没泄漏」—— 声明式能力清单之所以
//      有意义，全靠这两条。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, 'fixtures', 'plugins');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-plugin-tools-'));
process.env.QQ_AGENT_DATA_DIR = dataDir;
process.on('exit', () => {
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* Windows 句柄占用 */ }
});

const { buildToolDefs, executeTool, toOpenAiTools, buildToolDefs: _alias } =
  await import('../src/tools/tools.js');
const { buildToolDefs: coreBuildToolDefs } = await import('../src/tools/tools-core.js');
const { initPlugins, resetPlugins } = await import('../plugins/loader.js');
const { runPluginTool } = await import('../plugins/_host/context.js');
const { normalizeManifest, readManifest, manifestFingerprint } = await import('../plugins/_host/manifest.js');
const { PLUGIN_CAPABILITY_IDS } = await import('../plugins/_host/capabilities.js');
const { pluginToolDefs } = await import('../plugins/_host/registry.js');

void _alias;

const BUILTIN_TOOL_NAMES = ['send_message', 'send_sticker', 'web_fetch', 'finish', 'remind'];

const stagedRoots = [];
function stageRoot(ids) {
  const root = fs.mkdtempSync(path.join(dataDir, 'root-'));
  stagedRoots.push(root);
  for (const id of ids) {
    fs.cpSync(path.join(FIXTURES, id), path.join(root, id), { recursive: true });
  }
  return root;
}

function approve(id) {
  const dir = path.join(FIXTURES, id);
  return manifestFingerprint(normalizeManifest(readManifest(dir), {
    pluginDir: dir,
    expectedId: id,
    capabilityNames: PLUGIN_CAPABILITY_IDS
  }));
}

async function loadFixture(ids, extra = {}) {
  const root = stageRoot(ids);
  const approved = {};
  for (const id of ids) approved[id] = approve(id);
  return initPlugins({
    dataDir,
    config: { plugins: { roots: [root], enabled: ids, approved, settings: {}, ...extra } },
    builtinToolNames: BUILTIN_TOOL_NAMES,
    bundledRoot: null
  });
}

/** 一个尽量贴近 orchestrator 真实 ctx 的假宿主上下文（含那些**不许**泄漏给插件的字段）。 */
function fakeHostCtx(overrides = {}) {
  const sends = [];
  const emitted = [];
  const session = { id: 'sess-1', leaseId: 'lease-1', rounds: 3, sent: [], triggerText: '在吗' };
  const ctx = {
    chatKey: 'group:12345',
    kind: 'group',
    chatId: '12345',
    selfId: '999',
    selfNickname: '小鲸鱼',
    botName: '小鲸鱼',
    signal: null,
    sender: {
      async sendTextBatch(chatKey, messages, options) {
        sends.push({ chatKey, messages, options });
        return { sent: messages.map((text) => ({ text, messageId: sends.length, at: '00:00:01' })), failed: [] };
      }
    },
    store: { recent: () => [{ id: 1, mid: 10, ts: 1700000000000, senderId: '7', senderName: '阿花', self: false, text: '在吗' }] },
    memory: { append() { throw new Error('插件不该碰到 memory'); } },
    onebot: { selfId: '999' },
    identityPilot: null,
    stickers: {},
    reminders: {},
    games: null,
    emit: (type, payload) => emitted.push([type, payload]),
    session,
    ...overrides
  };
  return { ctx, sends, emitted, session };
}

test.after(async () => {
  await resetPlugins();
  for (const root of stagedRoots) {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* 忽略 */ }
  }
});

test('没有插件时 buildToolDefs() 与 tools-core 的内置工具逐字一致（插件系统不改变既有行为）', async () => {
  await resetPlugins();
  assert.deepEqual(buildToolDefs().map((def) => def.name), coreBuildToolDefs().map((def) => def.name));
});

test('装载插件后工具表追加插件工具，卸载后完全恢复', async () => {
  await loadFixture(['fixture-ok']);
  const names = buildToolDefs().map((def) => def.name);
  assert.ok(names.includes('fixture_ok_echo'));
  assert.ok(names.includes('fixture_ok_kv'));
  // 内置工具一个都不能少：追加而不是替换
  assert.deepEqual(names.slice(0, coreBuildToolDefs().length), coreBuildToolDefs().map((def) => def.name));

  await resetPlugins();
  assert.deepEqual(buildToolDefs().map((def) => def.name), coreBuildToolDefs().map((def) => def.name));
});

test('executeTool 能按名字找到插件工具并按内置工具同一套约定返回 content', async () => {
  await loadFixture(['fixture-ok']);
  const defs = buildToolDefs();
  const { ctx } = fakeHostCtx();

  const result = await executeTool(defs, ctx, 'fixture_ok_echo', JSON.stringify({ text: '早安' }));
  assert.equal(result.isError, undefined);
  assert.match(result.content, /echo=早安/);
  assert.deepEqual(result.parsedArgs, { text: '早安' });
});

test('未声明的能力在门面上根本不存在，且宿主的原始 ctx 一个字段都没泄漏', async () => {
  await loadFixture(['fixture-ok']);
  const { ctx } = fakeHostCtx();
  const result = await executeTool(buildToolDefs(), ctx, 'fixture_ok_echo', JSON.stringify({ text: 'x' }));

  const fields = Object.fromEntries(result.content.split(';').map((part) => {
    const index = part.indexOf('=');
    return [part.slice(0, index), part.slice(index + 1)];
  }));

  assert.equal(fields.chat, 'group:12345');
  // capabilities 排序后进 ctx：manifest 里写的是 ["chat:read","storage"]
  assert.equal(fields.caps, 'chat:read|storage');
  // 声明了 storage/chat:read，所以这两个在；http/secrets 没声明，连属性都没有
  assert.equal(fields.fetch, 'undefined');
  assert.equal(fields.secret, 'undefined');
  // 原始 ctx 上的这些一律不许出现
  for (const key of ['sender', 'store', 'onebot', 'memory', 'emit']) {
    assert.equal(fields[key], 'undefined', `${key} 泄漏给了插件`);
  }
  assert.equal(fields.leaseId, 'none', 'session.leaseId 泄漏给了插件');
});

test('零能力插件：门面上没有任何宿主能力（纯计算插件也合法）', async () => {
  await loadFixture(['fixture-pure']);
  const { ctx } = fakeHostCtx();
  const result = await executeTool(buildToolDefs(), ctx, 'pure_add', JSON.stringify({ a: 2, b: 40 }));
  assert.equal(result.content, 'sum=42;leaked=none');
});

test('声明 http / secrets 时对应方法才存在', async () => {
  await loadFixture(['fixture-net']);
  const { ctx } = fakeHostCtx();
  const result = await executeTool(buildToolDefs(), ctx, 'net_probe', '{}');
  assert.equal(
    result.content,
    'fetch=function;secret=function;send=undefined;recent=undefined;kv=undefined;token=empty'
  );
});

test('chat:send 只能发到当前会话，并且与内置 send_message 一样记账与广播', async () => {
  await loadFixture(['fixture-send']);
  const { ctx, sends, emitted, session } = fakeHostCtx();

  const result = await executeTool(buildToolDefs(), ctx, 'send_greeting', JSON.stringify({ text: '大家好' }));
  assert.match(result.content, /sent=1;failed=0;recent=1;chat=group:12345/);

  // 发送用的 chatKey 是宿主绑定的那个，插件无法指定别的会话
  assert.equal(sends.length, 1);
  assert.equal(sends[0].chatKey, 'group:12345');
  assert.deepEqual(sends[0].messages, ['大家好']);
  assert.equal(sends[0].options.runId, 'lease-1');

  // 记账与广播：不记的话控制台会话视图与模型看到的上下文会分叉
  assert.deepEqual(session.sent, [{ type: 'text', text: '大家好', at: '00:00:01' }]);
  assert.deepEqual(emitted, [['session-update', 'sess-1']]);
});

test('插件 send() 传 replyToMessageId/atUserId 时明确报错，且消息不会发出去', async () => {
  await loadFixture(['fixture-send']);
  const { ctx, sends } = fakeHostCtx();

  const result = await executeTool(
    buildToolDefs(), ctx, 'send_greeting', JSON.stringify({ text: '嗨', atUserId: '7' })
  );
  assert.equal(result.isError, true);
  assert.match(result.content, /暂不支持 replyToMessageId\/atUserId/);
  assert.deepEqual(sends, [], '被拒绝的调用不能真的发出消息');
});

test('插件工具在 toOpenAiTools 里与内置工具同形（名字/描述/参数原样交给模型）', async () => {
  await loadFixture(['fixture-ok']);
  const tool = toOpenAiTools(buildToolDefs()).find((item) => item.function.name === 'fixture_ok_echo');
  assert.ok(tool);
  assert.equal(tool.type, 'function');
  assert.match(tool.function.description, /Echo the given text/);
  assert.equal(tool.function.parameters.required[0], 'text');
});

test('插件工具带 pluginId/feature 标记（诊断与过滤链靠它认归属）', async () => {
  await loadFixture(['fixture-ok']);
  const def = pluginToolDefs().find((item) => item.name === 'fixture_ok_echo');
  assert.equal(def.pluginId, 'fixture-ok');
  assert.equal(def.feature, 'plugin:fixture-ok');
  assert.equal(def.pluginVersion, '1.0.0');
});

const SYNTHETIC_MANIFEST = Object.freeze({
  id: 'synthetic', name: 'Synthetic', version: '1.0.0', capabilities: []
});

test('runPluginTool：字符串返回值直接当作 content，且成功时不带 isError 字段', async () => {
  const result = await runPluginTool({
    manifest: SYNTHETIC_MANIFEST,
    toolName: 'plain',
    timeoutMs: 1000,
    handler: async () => '纯文本结果',
    hostCtx: fakeHostCtx().ctx
  });
  // 逐字对齐内置工具的 ok()（`{ content }`）：成功没有 isError 这个键。
  // 写成 isError:false 会让会话留档与审计里冒出内置工具没有的字段。
  assert.deepEqual(result, { content: '纯文本结果' });
  assert.equal('isError' in result, false);
});

test('runPluginTool：{error} 记成 isError，其余畸形返回值给出可读错误而不是空结果', async () => {
  const asError = await runPluginTool({
    manifest: SYNTHETIC_MANIFEST,
    toolName: 'boom',
    timeoutMs: 1000,
    handler: async () => ({ error: '拿不到数据' }),
    hostCtx: fakeHostCtx().ctx
  });
  assert.equal(asError.isError, true);
  assert.equal(asError.content, '拿不到数据');

  const bad = await runPluginTool({
    manifest: SYNTHETIC_MANIFEST,
    toolName: 'bad',
    timeoutMs: 1000,
    handler: async () => 42,
    hostCtx: fakeHostCtx().ctx
  });
  assert.equal(bad.isError, true);
  assert.equal(bad.errorCode, 'PLUGIN_TOOL_BAD_RESULT');
});

test('runPluginTool：超时后返回可读错误（而不是把整轮运行挂住）', async () => {
  const started = Date.now();
  const result = await runPluginTool({
    manifest: SYNTHETIC_MANIFEST,
    toolName: 'slow',
    timeoutMs: 50,
    // 永不 resolve，且不持有任何句柄 —— 专门验证超时定时器本身能救场
    handler: () => new Promise(() => {}),
    hostCtx: fakeHostCtx().ctx
  });
  assert.equal(result.isError, true);
  assert.equal(result.errorCode, 'PLUGIN_TOOL_TIMEOUT');
  assert.match(result.content, /超时（50ms）/);
  assert.ok(Date.now() - started < 5000, '不该等太久');
});

test('runPluginTool：超时会 abort toolCtx.signal（插件可据此收尾）', async () => {
  let observed = 'not-aborted';
  await runPluginTool({
    manifest: SYNTHETIC_MANIFEST,
    toolName: 'cooperative',
    timeoutMs: 30,
    handler: (toolCtx) => new Promise((resolve) => {
      toolCtx.signal.addEventListener('abort', () => { observed = 'aborted'; resolve('late'); }, { once: true });
    }),
    hostCtx: fakeHostCtx().ctx
  });
  // 给 abort 事件一点时间落到位
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(observed, 'aborted');
});

test('runPluginTool：抛错时变成工具错误（不会冒泡成未处理异常）', async () => {
  const result = await runPluginTool({
    manifest: SYNTHETIC_MANIFEST,
    toolName: 'throws',
    timeoutMs: 1000,
    handler: async () => { throw new Error('内部炸了'); },
    hostCtx: fakeHostCtx().ctx
  });
  assert.equal(result.isError, true);
  assert.equal(result.errorCode, 'PLUGIN_TOOL_FAILED');
  assert.match(result.content, /内部炸了/);
});

test('runPluginTool：宿主取消时把取消原样抛出（交给编排器的取消语义处理）', async () => {
  const controller = new AbortController();
  controller.abort(new Error('Run cancelled'));
  await assert.rejects(
    runPluginTool({
      manifest: SYNTHETIC_MANIFEST,
      toolName: 'cancelled',
      timeoutMs: 1000,
      handler: async () => 'never',
      hostCtx: fakeHostCtx({ signal: controller.signal }).ctx
    }),
    /Run cancelled/
  );
});

test('runPluginTool：返回内容超过上限时截断并写明（不许把上下文撑爆）', async () => {
  const result = await runPluginTool({
    manifest: SYNTHETIC_MANIFEST,
    toolName: 'huge',
    timeoutMs: 1000,
    handler: async () => 'x'.repeat(70000),
    hostCtx: fakeHostCtx().ctx
  });
  assert.equal(result.truncated, true);
  assert.ok(result.content.length < 70000);
  assert.match(result.content, /已截断/);
});
