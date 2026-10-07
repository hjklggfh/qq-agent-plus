// 插件加载器的契约用例：发现 → manifest 校验 → 审批比对 → 动态 import → 工具收集。
//
// 这里钉的是"一个坏插件不能拖垮别的插件、也不能拖垮机器人"这条主线，以及
// "审批快照变了就不加载"（fail-closed）这条安全底线。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, 'fixtures', 'plugins');

// 用例自己造临时数据目录：**不许**碰仓库里的 data/（那里可能是真配置，含 Key）。
// 注意 ESM 的静态 import 会先于文件体执行，所以 src 模块必须放在设置环境变量之后动态 import。
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-plugin-loader-'));
process.env.QQ_AGENT_DATA_DIR = dataDir;
process.on('exit', () => {
  // Windows 上临时目录可能还被句柄占着；清理失败不影响用例结论。
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* 忽略 */ }
});

const { initPlugins, resetPlugins, enabledPluginIds, pluginRoots, listPluginDirs, PLUGIN_STATUS } =
  await import('../plugins/loader.js');
const { BUNDLED_PLUGIN_ROOT, REPO_ROOT } = await import('../plugins/loader.js');
const { normalizeManifest, readManifest, manifestFingerprint } = await import('../plugins/_host/manifest.js');
const { PLUGIN_CAPABILITY_IDS } = await import('../plugins/_host/capabilities.js');
const { pluginToolDefs, pluginRuntimeStatuses, loadedPluginSummaries } = await import('../plugins/_host/registry.js');

// 内置工具名在真实进程里来自 tools-core；这里给一小撮就够验证"不许覆盖内置"。
const BUILTIN_TOOL_NAMES = ['send_message', 'send_sticker', 'web_fetch', 'finish'];

const stagedRoots = [];
function stageRoot(ids) {
  const root = fs.mkdtempSync(path.join(dataDir, 'root-'));
  stagedRoots.push(root);
  for (const id of ids) {
    fs.cpSync(path.join(FIXTURES, id), path.join(root, id), { recursive: true });
  }
  return root;
}

/** 按磁盘上的 manifest 造一份"已确认"快照 —— 与将来控制台批准时写的形态一致。 */
function approve(id) {
  const dir = path.join(FIXTURES, id);
  const manifest = normalizeManifest(readManifest(dir), {
    pluginDir: dir,
    expectedId: id,
    capabilityNames: PLUGIN_CAPABILITY_IDS
  });
  return manifestFingerprint(manifest);
}

/**
 * manifest 本身就坏的夹具没法造出快照（normalizeManifest 会抛，这是对的）。
 * 那条路径压根走不到审批比对，所以这里返回 null 表示"不给它审批记录"。
 */
function approvedMap(ids) {
  const out = {};
  for (const id of ids) {
    try {
      out[id] = approve(id);
    } catch {
      // 故意留空：坏 manifest 在审批之前就被拒了，给不给审批都不影响结论。
    }
  }
  return out;
}

function pluginConfig({ roots = [], enabled = [], approved = {}, settings = {} } = {}) {
  return { plugins: { roots, enabled, approved, settings } };
}

function statusOf(result, id) {
  return result.statuses.find((item) => item.id === id) || null;
}

async function load(config) {
  // bundledRoot: null —— 关掉"随版本分发的插件根"（<仓库根>/plugins）。
  // 用例必须只依赖自己 stage 出来的夹具：否则仓库 plugins/ 里以后多一个自带插件，
  // 一堆断言就会莫名其妙变红。那条路径由下面单独的两个用例覆盖。
  return initPlugins({
    dataDir, config, builtinToolNames: BUILTIN_TOOL_NAMES, bundledRoot: null
  });
}

test.after(async () => {
  await resetPlugins();
  for (const root of stagedRoots) {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* 忽略 */ }
  }
});

test('未在 plugins.enabled 里的插件不加载，但状态仍可读（控制台要能列出"装了什么"）', async () => {
  const root = stageRoot(['fixture-ok']);
  const result = await load(pluginConfig({ roots: [root] }));

  const status = statusOf(result, 'fixture-ok');
  assert.equal(status.status, PLUGIN_STATUS.DISABLED);
  assert.deepEqual(result.toolDefs, []);
  // manifest 仍然被读了：没启用不等于"不知道它是什么"。
  assert.equal(status.name, 'Fixture OK');
  assert.deepEqual(status.tools, ['fixture_ok_echo', 'fixture_ok_kv']);
});

test('启用了但没有审批记录 → pending-approval，且一个工具都不注入', async () => {
  const root = stageRoot(['fixture-ok']);
  const result = await load(pluginConfig({ roots: [root], enabled: ['fixture-ok'] }));

  const status = statusOf(result, 'fixture-ok');
  assert.equal(status.status, PLUGIN_STATUS.PENDING_APPROVAL);
  assert.match(status.reason, /缺少能力确认记录/);
  assert.deepEqual(result.toolDefs, []);
});

test('插件升级后版本变了 → 退回 pending-approval（不许悄悄继承旧授权）', async () => {
  const root = stageRoot(['fixture-ok']);
  const stale = approve('fixture-ok');
  stale.version = '0.9.0';
  const result = await load(pluginConfig({
    roots: [root], enabled: ['fixture-ok'], approved: { 'fixture-ok': stale }
  }));

  assert.equal(statusOf(result, 'fixture-ok').status, PLUGIN_STATUS.PENDING_APPROVAL);
  assert.deepEqual(result.toolDefs, []);
});

test('插件升级后多要一个能力 → 退回 pending-approval', async () => {
  const root = stageRoot(['fixture-ok']);
  const stale = approve('fixture-ok');
  stale.capabilities = ['chat:read'];   // 少了 storage
  const result = await load(pluginConfig({
    roots: [root], enabled: ['fixture-ok'], approved: { 'fixture-ok': stale }
  }));

  assert.equal(statusOf(result, 'fixture-ok').status, PLUGIN_STATUS.PENDING_APPROVAL);
});

test('审批记录形态坏掉时按"没确认过"处理，而不是拿去比对', async () => {
  const root = stageRoot(['fixture-ok']);
  const result = await load(pluginConfig({
    roots: [root],
    enabled: ['fixture-ok'],
    approved: { 'fixture-ok': { version: '1.0.0' } }   // 缺 capabilities / tools
  }));
  assert.equal(statusOf(result, 'fixture-ok').status, PLUGIN_STATUS.PENDING_APPROVAL);
});

test('合法且已确认 → loaded，工具进入注册表且带上插件归属', async () => {
  const root = stageRoot(['fixture-ok', 'fixture-second']);
  const result = await load(pluginConfig({
    roots: [root],
    enabled: ['fixture-ok', 'fixture-second'],
    approved: { 'fixture-ok': approve('fixture-ok'), 'fixture-second': approve('fixture-second') }
  }));

  assert.equal(statusOf(result, 'fixture-ok').status, PLUGIN_STATUS.LOADED);
  assert.equal(statusOf(result, 'fixture-second').status, PLUGIN_STATUS.LOADED);

  const names = pluginToolDefs().map((def) => def.name).sort();
  assert.deepEqual(names, ['fixture_ok_echo', 'fixture_ok_kv', 'second_ping']);

  const echo = pluginToolDefs().find((def) => def.name === 'fixture_ok_echo');
  assert.equal(echo.pluginId, 'fixture-ok');
  assert.equal(echo.feature, 'plugin:fixture-ok');
  assert.equal(echo.pluginVersion, '1.0.0');
  assert.equal(typeof echo.execute, 'function');

  const summaries = loadedPluginSummaries();
  assert.deepEqual(summaries.map((item) => item.id), ['fixture-ok', 'fixture-second']);
});

test('零能力插件也能加载（纯计算插件是合法的）', async () => {
  const root = stageRoot(['fixture-pure']);
  const result = await load(pluginConfig({
    roots: [root], enabled: ['fixture-pure'], approved: { 'fixture-pure': approve('fixture-pure') }
  }));
  assert.equal(statusOf(result, 'fixture-pure').status, PLUGIN_STATUS.LOADED);
  assert.deepEqual(statusOf(result, 'fixture-pure').capabilities, []);
});

const BROKEN_CASES = [
  ['fixture-bad-json', PLUGIN_STATUS.INVALID, /不是合法 JSON/],
  ['fixture-id-mismatch', PLUGIN_STATUS.INVALID, /与插件目录名/],
  ['fixture-api-version', PLUGIN_STATUS.INVALID, /apiVersion 99/],
  ['fixture-bad-capability', PLUGIN_STATUS.INVALID, /未知能力 root:all/],
  ['fixture-escape-entry', PLUGIN_STATUS.INVALID, /越出插件目录/],
  ['fixture-bad-toolname', PLUGIN_STATUS.INVALID, /不许以 qq_ 开头/],
  ['fixture-no-activate', PLUGIN_STATUS.FAILED, /没有导出 activate/],
  ['fixture-throwing', PLUGIN_STATUS.FAILED, /boom from fixture/],
  ['fixture-tool-missing', PLUGIN_STATUS.FAILED, /声明了但没注册：missing_beta/],
  ['fixture-tool-undeclared', PLUGIN_STATUS.FAILED, /undeclared_extra 没有写在 manifest\.tools 里/]
];

for (const [id, expectedStatus, pattern] of BROKEN_CASES) {
  test(`坏插件 ${id} → ${expectedStatus}，并给出可读原因`, async () => {
    const root = stageRoot([id]);
    const result = await load(pluginConfig({
      roots: [root], enabled: [id], approved: approvedMap([id])
    }));

    const status = statusOf(result, id);
    assert.equal(status.status, expectedStatus);
    assert.match(status.reason, pattern);
    assert.deepEqual(result.toolDefs, []);
  });
}

test('一个坏插件不影响同一根目录里的好插件（失败隔离）', async () => {
  const ids = ['fixture-ok', ...BROKEN_CASES.map((entry) => entry[0])];
  const root = stageRoot(ids);
  const result = await load(pluginConfig({
    roots: [root], enabled: ids, approved: approvedMap(ids)
  }));

  assert.equal(statusOf(result, 'fixture-ok').status, PLUGIN_STATUS.LOADED);
  const loadedIds = result.statuses
    .filter((item) => item.status === PLUGIN_STATUS.LOADED)
    .map((item) => item.id);
  assert.deepEqual(loadedIds, ['fixture-ok']);
  // 坏插件一个工具都不许进来
  assert.deepEqual(pluginToolDefs().map((def) => def.name).sort(), ['fixture_ok_echo', 'fixture_ok_kv']);
});

test('工具名与内置工具冲突 → 整个插件拒绝加载（否则模型调的名字与实现不是一回事）', async () => {
  const root = stageRoot(['fixture-collides-builtin']);
  const result = await load(pluginConfig({
    roots: [root],
    enabled: ['fixture-collides-builtin'],
    approved: { 'fixture-collides-builtin': approve('fixture-collides-builtin') }
  }));

  const status = statusOf(result, 'fixture-collides-builtin');
  assert.equal(status.status, PLUGIN_STATUS.FAILED);
  assert.match(status.reason, /与已有工具冲突：send_message/);
});

test('两个插件抢同一个工具名 → 后扫描到的那个失败，先前那个照常', async () => {
  // 根目录顺序决定扫描顺序（默认根在前，然后按 plugins.roots 的次序），
  // 所以把 fixture-ok 放在前一个根里就能确定谁先占住名字。
  const rootA = stageRoot(['fixture-ok']);
  const rootB = stageRoot(['fixture-collides-plugin']);
  const result = await load(pluginConfig({
    roots: [rootA, rootB],
    enabled: ['fixture-ok', 'fixture-collides-plugin'],
    approved: {
      'fixture-ok': approve('fixture-ok'),
      'fixture-collides-plugin': approve('fixture-collides-plugin')
    }
  }));

  assert.equal(statusOf(result, 'fixture-ok').status, PLUGIN_STATUS.LOADED);
  const collided = statusOf(result, 'fixture-collides-plugin');
  assert.equal(collided.status, PLUGIN_STATUS.FAILED);
  assert.match(collided.reason, /与已有工具冲突：fixture_ok_echo/);
  // fixture_ok_echo 只出现一次
  assert.equal(pluginToolDefs().filter((def) => def.name === 'fixture_ok_echo').length, 1);
});

test('同一个插件 id 出现在两个根里只加载一次', async () => {
  const rootA = stageRoot(['fixture-ok']);
  const rootB = stageRoot(['fixture-ok']);
  const warnings = [];
  const result = await initPlugins({
    dataDir,
    config: pluginConfig({
      roots: [rootA, rootB],
      enabled: ['fixture-ok'],
      approved: { 'fixture-ok': approve('fixture-ok') }
    }),
    builtinToolNames: BUILTIN_TOOL_NAMES,
    bundledRoot: null,
    log: { warn: (message) => warnings.push(String(message)) }
  });

  assert.equal(result.statuses.filter((item) => item.id === 'fixture-ok').length, 1);
  assert.equal(result.toolDefs.length, 2);
  // 只该有"重复 id"这一条警告；没有别的理由去打扰日志
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /多个根目录/);
});

test('拒绝加载后不残留上一轮的注册表（下一次 load 会整体替换）', async () => {
  const root = stageRoot(['fixture-ok']);
  await load(pluginConfig({
    roots: [root], enabled: ['fixture-ok'], approved: { 'fixture-ok': approve('fixture-ok') }
  }));
  assert.equal(pluginToolDefs().length, 2);

  // 第二轮不启用任何插件
  await load(pluginConfig({ roots: [root] }));
  assert.deepEqual(pluginToolDefs(), []);
});

test('重新装载时调用上一轮插件的 deactivate（同进程重载不能把插件状态漏掉）', async () => {
  const root = stageRoot(['fixture-deactivate']);
  const config = pluginConfig({
    roots: [root], enabled: ['fixture-deactivate'], approved: { 'fixture-deactivate': approve('fixture-deactivate') }
  });
  await load(config);
  const kvFile = path.join(dataDir, 'plugin-state', 'fixture-deactivate', 'kv.json');
  assert.equal(fs.existsSync(kvFile), false, '装载阶段不该写状态');

  await load(config);   // 第二轮会把第一轮的实例卸载
  const written = JSON.parse(fs.readFileSync(kvFile, 'utf8'));
  assert.equal(written.deactivated, true);
});

test('缺少 builtinToolNames 时直接抛错（宁可没有插件，也不要放弃重名预检）', async () => {
  await assert.rejects(
    initPlugins({ dataDir, config: pluginConfig(), log: null }),
    /builtinToolNames/
  );
});

test('返回的状态对象可安全 JSON 序列化（控制台要直接下发，函数/Map 会被静默丢掉）', async () => {
  const root = stageRoot(['fixture-ok', 'fixture-throwing']);
  const result = await load(pluginConfig({
    roots: [root],
    enabled: ['fixture-ok', 'fixture-throwing'],
    approved: { 'fixture-ok': approve('fixture-ok'), 'fixture-throwing': approve('fixture-throwing') }
  }));

  assert.deepEqual(JSON.parse(JSON.stringify(result.statuses)), result.statuses);
  for (const status of pluginRuntimeStatuses()) {
    for (const value of Object.values(status)) {
      assert.notEqual(typeof value, 'function');
      assert.equal(value instanceof Map, false);
    }
  }
});

test('工具实现不随状态对象外泄（状态里只有元数据）', async () => {
  const root = stageRoot(['fixture-ok']);
  await load(pluginConfig({
    roots: [root], enabled: ['fixture-ok'], approved: { 'fixture-ok': approve('fixture-ok') }
  }));
  const status = pluginRuntimeStatuses().find((item) => item.id === 'fixture-ok');
  assert.equal('registered' in status, false);
  assert.equal('deactivate' in status, false);
});

test('enabledPluginIds 同时认数组与 {id:true} 映射，并丢掉非字符串项', () => {
  assert.deepEqual(enabledPluginIds({ plugins: { enabled: ['a', 'b'] } }), ['a', 'b']);
  assert.deepEqual(enabledPluginIds({ plugins: { enabled: { a: true, b: false } } }), ['a']);
  assert.deepEqual(enabledPluginIds({ plugins: { enabled: [1, null, 'a'] } }), ['1', 'a']);
  assert.deepEqual(enabledPluginIds({}), []);
});

test('pluginRoots：额外根排在固定根之前（额外根用来覆盖自带的同名插件），并去重', () => {
  const roots = pluginRoots({
    dataDir: '/data',
    bundledRoot: '/repo/plugins',
    config: { plugins: { roots: ['extra', '/abs/extra', 'extra', '  '] } }
  });
  assert.deepEqual(roots, [
    path.resolve('/data', 'extra'),
    path.normalize('/abs/extra'),
    path.normalize('/repo/plugins')
  ]);
});

test('pluginRoots：bundledRoot 传 null 时只剩额外根（用例隔离靠它）', () => {
  assert.deepEqual(pluginRoots({ dataDir: '/data', bundledRoot: null, config: {} }), []);
  assert.deepEqual(
    pluginRoots({ dataDir: '/data', bundledRoot: null, config: { plugins: { roots: ['extra'] } } }),
    [path.resolve('/data', 'extra')]
  );
});

test('固定的那个插件根就是 <仓库根>/plugins（插件是代码，不进 data/）', () => {
  const roots = pluginRoots({ dataDir, config: {} });
  assert.deepEqual(roots, [BUNDLED_PLUGIN_ROOT]);
  assert.equal(BUNDLED_PLUGIN_ROOT, path.join(REPO_ROOT, 'plugins'));
  // 数据目录**不该**出现在插件根里：data/ 是记忆与聊天记录，插件是代码。
  assert.equal(roots.some((item) => item.startsWith(path.join(dataDir, 'plugins'))), false);
});

test('仓库自带的 plugins/hello 会被扫到，但没启用就是 disabled（这就是"随版本分发"的形态）', async () => {
  const result = await initPlugins({
    dataDir,
    config: {},
    builtinToolNames: BUILTIN_TOOL_NAMES
    // 不传 bundledRoot：走真实默认值，验证"仓库 plugins/ 是默认根之一"。
  });
  const hello = result.statuses.find((item) => item.id === 'hello');
  assert.ok(hello, 'plugins/hello 应该被发现（它是随版本分发的官方示例插件）');
  assert.equal(hello.status, PLUGIN_STATUS.DISABLED);
  assert.deepEqual(hello.tools, ['hello_count', 'hello_recent']);
  assert.deepEqual(hello.capabilities, ['chat:read', 'chat:send', 'storage']);
  assert.deepEqual(result.toolDefs, []);
});

test('listPluginDirs 跳过隐藏目录、下划线目录、node_modules 与非目录', () => {
  const root = fs.mkdtempSync(path.join(dataDir, 'scan-'));
  stagedRoots.push(root);
  fs.mkdirSync(path.join(root, 'real-plugin'));
  fs.mkdirSync(path.join(root, '.hidden'));
  fs.mkdirSync(path.join(root, '_scratch'));
  fs.mkdirSync(path.join(root, 'node_modules'));
  fs.writeFileSync(path.join(root, 'loose.json'), '{}');

  assert.deepEqual(listPluginDirs(root).map((item) => item.id), ['real-plugin']);
  assert.deepEqual(listPluginDirs(path.join(root, 'does-not-exist')), []);
});

test('插件根里的 _host 与 loader.js 不会被当成插件（装载器扫不到自己人）', () => {
  const ids = listPluginDirs(BUNDLED_PLUGIN_ROOT).map((item) => item.id);
  assert.equal(ids.includes('_host'), false);
  assert.equal(ids.includes('loader'), false);
  assert.ok(ids.includes('hello'));
});

test('deploy.sh 用 protect 而不是 exclude 处理 plugins/（两个方向都会坏事）', () => {
  const deploy = fs.readFileSync(path.join(REPO_ROOT, 'deploy.sh'), 'utf8');
  // 必须有一条 protect 规则：让接收端独有的第三方插件不被 rsync --delete 删掉
  assert.match(
    deploy,
    /--filter='protect \/plugins\/\*\*\*'/,
    'deploy.sh 缺少 protect /plugins/*** —— 服务器上自装的插件会在下一次更新时被静默删除'
  );
  // 且不能改成 exclude：exclude 会**连传输一起挡掉**，仓库自带的插件从此再也收不到更新
  assert.doesNotMatch(
    deploy,
    /--exclude=\/plugins\//,
    "plugins/ 不能用 --exclude：那会让随版本分发的插件永远更新不了"
  );
});
