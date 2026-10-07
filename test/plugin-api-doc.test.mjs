// docs/PLUGIN-API.md 的"不许漂移"用例。
//
// 为什么值得一个专门的测试：这份文档存在的唯一理由是**别再出现"作者按一套不存在的接口
// 写插件"**（2026-10-08：一个 1284 行的第三方插件调的接口本仓一个都没有）。如果文档能悄悄
// 与代码脱节，它就从"权威对照表"退化成"更好看的臆想来源"—— 比没有更糟。
//
// 所以这里做两件事：
//   ① 文档里所有**清单类**内容（manifest 认识的键、api 成员、toolCtx 成员、能力 id）
//      都与代码逐项比对，双向 —— 代码多一个没写进文档、文档多写一个代码里没有，都判红；
//   ② 文档第 1 节的示例被**真的装进宿主**：解析出 manifest 与入口、写成临时插件、
//      带审批 initPlugins，并真的调用一次它注册的工具。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const DOC = path.resolve('docs/PLUGIN-API.md');

/** 取出 `<!-- plugin-api:NAME --> … <!-- /plugin-api:NAME -->` 之间的内容。 */
function block(name) {
  const text = fs.readFileSync(DOC, 'utf8');
  const re = new RegExp(`<!-- plugin-api:${name} -->\\n([\\s\\S]*?)\\n<!-- /plugin-api:${name} -->`);
  const match = text.match(re);
  assert.ok(match, `docs/PLUGIN-API.md 里缺少 ${name} 标记块（改文档时别把标记删了）`);
  return match[1];
}

/** 取出标记块里的第一个围栏代码块内容。 */
function fenced(name) {
  const match = block(name).match(/```[a-z]*\n([\s\S]*?)\n```/);
  assert.ok(match, `${name} 标记块里应该有一个围栏代码块`);
  return match[1];
}

/** 空格/换行分隔的清单 → 去重排序数组。 */
function words(name) {
  return [...new Set(block(name).split(/[\s,，]+/).filter(Boolean))].sort();
}

const { PLUGIN_CAPABILITY_IDS, capabilitySummary } = await import('../plugins/_host/capabilities.js');
const { MANIFEST_KNOWN_KEYS, normalizeManifest, readManifest, manifestFingerprint } = await import('../plugins/_host/manifest.js');
const { buildPluginApi, buildPluginToolContext } = await import('../plugins/_host/context.js');
const { initPlugins, resetPlugins } = await import('../plugins/loader.js');
const { pluginToolDefs } = await import('../plugins/_host/registry.js');

const tempRoots = [];
function tempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}
test.after(() => {
  for (const dir of tempRoots) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* Windows 下句柄可能还在，删不掉就算了 */ }
  }
});

const ALL = [...PLUGIN_CAPABILITY_IDS];

test('文档：manifest 字段表与宿主的"已知键"完全一致（双向）', () => {
  assert.deepEqual(words('manifest-keys'), [...MANIFEST_KNOWN_KEYS].sort(),
    '文档的 manifest 字段清单与 plugins/_host/manifest.js 的 MANIFEST_KNOWN_KEYS 不一致');
});

test('文档：能力 id 表与代码完全一致，且每个能力的中文标签都出现在文档里', () => {
  assert.deepEqual(words('capability-ids'), [...PLUGIN_CAPABILITY_IDS].sort());
  const text = fs.readFileSync(DOC, 'utf8');
  for (const cap of capabilitySummary()) {
    assert.ok(text.includes(cap.id), `文档漏了能力 ${cap.id}`);
    assert.ok(text.includes(cap.label), `文档漏了能力 ${cap.id} 的标签「${cap.label}」`);
  }
});

test('文档：api 成员表与 buildPluginApi 实际给出的成员完全一致（双向）', () => {
  const dataDir = tempDir('qq-plugin-api-doc-');
  const api = buildPluginApi({
    manifest: { id: 'doc-probe', name: 'Doc Probe', version: '1.0.0', apiVersion: 1, capabilities: ALL },
    config: {},
    dataDir,
    log: null,
    registerTool: () => {}
  });
  assert.deepEqual(words('api-members'), Object.keys(api).sort(),
    'docs/PLUGIN-API.md 的 api 成员表与 plugins/_host/context.js 的 buildPluginApi 不一致');
});

test('文档：toolCtx 成员表与 buildPluginToolContext 实际给出的成员完全一致（双向）', () => {
  const dataDir = tempDir('qq-plugin-toolctx-doc-');
  const toolCtx = buildPluginToolContext({
    manifest: { id: 'doc-probe', name: 'Doc Probe', version: '1.0.0', apiVersion: 1, capabilities: ALL },
    hostCtx: {
      chatKey: 'group:1',
      sender: { sendTextBatch: async () => ({ sent: [], failed: [] }), image: async () => ({}) },
      store: { recent: () => [] },
      session: { id: 's1', rounds: 1, sent: [] },
      emit: () => {}
    },
    config: {},
    dataDir,
    log: null
  });
  assert.deepEqual(words('toolctx-members'), Object.keys(toolCtx).sort(),
    'docs/PLUGIN-API.md 的 toolCtx 成员表与 plugins/_host/context.js 的 buildPluginToolContext 不一致');
});

test('文档：第 1 节的示例能真的装载，且它注册的工具能真的调用', async (t) => {
  const root = tempDir('qq-plugin-api-example-');
  const pluginDir = path.join(root, 'plugins', 'example-plugin');
  fs.mkdirSync(pluginDir, { recursive: true });

  // 直接落文档里的那两段 —— 文档写错（字段名、成员名、返回值形态）这里就装载不起来
  const manifestText = fenced('example-manifest');
  fs.writeFileSync(path.join(pluginDir, 'plugin.json'), `${manifestText}\n`);
  fs.writeFileSync(path.join(pluginDir, 'index.js'), `${fenced('example-entry')}\n`);

  const parsed = JSON.parse(manifestText);
  assert.equal(parsed.id, 'example-plugin', '示例的 id 必须等于它所在的目录名');
  const manifest = normalizeManifest(readManifest(pluginDir), { pluginDir });
  const dataDir = path.join(root, 'data');

  await resetPlugins();
  t.after(async () => { await resetPlugins(); });

  const warnings = [];
  const result = await initPlugins({
    dataDir,
    log: { info: () => {}, warn: (m) => warnings.push(String(m)), error: () => {} },
    builtinToolNames: [],
    bundledRoot: null,                 // 测试隔离：不要顺带扫仓库自带的 plugins/
    config: {
      plugins: {
        roots: [path.join(root, 'plugins')],
        enabled: ['example-plugin'],
        approved: { 'example-plugin': manifestFingerprint(manifest) },
        settings: {}
      }
    }
  });

  const status = (result.statuses || []).find((item) => item.id === 'example-plugin');
  assert.ok(status, '示例插件没出现在装载结果里');
  assert.equal(status.status, 'loaded', `文档第 1 节的示例装载失败：${status.reason}`);
  assert.deepEqual(warnings, [], `示例不该产生告警（manifest 有宿主不认识的键才会告警）：${warnings.join(' / ')}`);

  const def = pluginToolDefs().find((item) => item.name === 'example_ping');
  assert.ok(def, '示例声明的 example_ping 没有出现在工具表里');
  assert.equal(def.feature, 'plugin:example-plugin');

  // 真的跑一次它的 execute —— 这验证的是文档示例里的函数体、kv 用法与返回值形态
  const first = await def.execute({ chatKey: 'group:1', signal: null }, {});
  assert.equal(first.isError, undefined, `示例工具第一次调用就失败了：${first.content}`);
  assert.match(first.content, /第 1 次/, `示例工具的返回值与文档写的不符：${first.content}`);

  const second = await def.execute({ chatKey: 'group:1', signal: null }, { who: '小明' });
  assert.match(second.content, /小明/, 'args.who 没有按文档说的生效');
  assert.match(second.content, /第 2 次/, 'kv 计数没有在两次调用之间累加（文档说它持久化在状态目录）');

  // 状态确实落在 plugin-state/<id>/ 而不是插件目录里（文档第 7 节承诺的性质）
  const kvFile = path.join(dataDir, 'plugin-state', 'example-plugin', 'kv.json');
  assert.ok(fs.existsSync(kvFile), `状态文件应落在 ${kvFile}`);
  assert.equal(JSON.parse(fs.readFileSync(kvFile, 'utf8')).count, 2);
});
