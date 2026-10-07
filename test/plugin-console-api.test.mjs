// 插件控制台 API 的契约用例（二期）。
//
// 测法：不起端口、不起 sqlite —— 用一个**假 app**（只实现 addRoute / auditWrite / emit）
// 收下路由，再直接调 handler，req/res 都是最小假件。这与 test/console-router.test.mjs
// 同一路子，好处是能把"路由层到底做了什么"钉死，而不被整条消息链路拖进来。
//
// 这里最要紧的两条：
//   ① `GET /api/plugins` **一个字符的凭据明文都不许出**（含断言整份响应里搜不到那个密钥串）；
//   ② `POST /api/plugins/approve` 的指纹必须**从盘上的 manifest 现算**，不采信请求体 ——
//      否则页面（或被篡改的请求）能替一个要 root 权限的插件签下"只有 storage"的确认。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, 'fixtures', 'plugins');
const REPO_ROOT = path.resolve(HERE, '..');

// 用例自己造临时数据目录：**不许**碰仓库里的 data/（那里可能是真配置，含 Key）。
// ESM 的静态 import 先于文件体执行，所以 src 模块必须在这之后动态 import。
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-plugin-api-'));
process.env.QQ_AGENT_DATA_DIR = dataDir;
process.on('exit', () => {
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* Windows 句柄占用 */ }
});

const { describePlugins, installPluginRoutes, MAX_SETTINGS_BYTES } =
  await import('../plugins/console-routes.js');
const { getConfig, setRuntimeConfig, DEFAULT_CONFIG } = await import('../src/core/config.js');
const { manifestFingerprint, normalizeManifest, readManifest } = await import('../plugins/_host/manifest.js');
const { PLUGIN_CAPABILITY_IDS } = await import('../plugins/_host/capabilities.js');

const BUILTIN_TOOL_NAMES = ['send_message', 'send_sticker', 'web_fetch', 'finish'];

const stagedRoots = [];
function stageRoot(ids) {
  const root = fs.mkdtempSync(path.join(dataDir, 'root-'));
  stagedRoots.push(root);
  for (const id of ids) fs.cpSync(path.join(FIXTURES, id), path.join(root, id), { recursive: true });
  return root;
}

function approve(id) {
  const dir = path.join(FIXTURES, id);
  return manifestFingerprint(normalizeManifest(readManifest(dir), {
    pluginDir: dir, expectedId: id, capabilityNames: PLUGIN_CAPABILITY_IDS
  }));
}

/** 每例从一个干净配置开始，避免互相污染（getConfig 是进程级缓存）。 */
function resetConfig(plugins = {}) {
  setRuntimeConfig({
    ...structuredClone(DEFAULT_CONFIG),
    plugins: { enabled: [], roots: [], approved: {}, settings: {}, ...plugins }
  });
}

// ── 假 app / 假 req / 假 res ──────────────────────────────────────────────

function fakeRes() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    headersSent: false,
    writableEnded: false,
    setHeader(name, value) { this.headers[String(name).toLowerCase()] = value; },
    end(data = '') { this.body = String(data); this.writableEnded = true; }
  };
}

/** 既是普通对象、又是异步可迭代（readJsonBody 用的是 for await ... of req）。 */
function fakeReq(url, method = 'GET', body = undefined) {
  // 允许直接给字符串：要构造带**自有** `__proto__` 键的请求体只能靠原始 JSON 文本
  //（对象字面量里的 `__proto__` 会被解释成设置原型，JSON.stringify 出来是 `{}`）。
  const chunks = body === undefined ? []
    : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body), 'utf8')];
  return {
    url,
    method,
    headers: {},
    async *[Symbol.asyncIterator]() { for (const chunk of chunks) yield chunk; }
  };
}

function fakeApp() {
  const routes = [];
  const audits = [];
  const events = [];
  return {
    routes,
    audits,
    events,
    addRoute(method, routePath, handler, opts) {
      routes.push({ method, path: routePath, handler, opts: opts || {} });
    },
    auditWrite(action, target, payload) { audits.push({ action, target, payload }); },
    emit(type, payload) { events.push({ type, payload }); }
  };
}

function setup(plugins = {}, options = {}) {
  resetConfig(plugins);
  const app = fakeApp();
  installPluginRoutes(app, { dataDir, builtinToolNames: BUILTIN_TOOL_NAMES, ...options });
  const call = async (method, routePath, { body, url } = {}) => {
    const route = app.routes.find((item) => item.method === method && item.path === routePath);
    assert.ok(route, `没有注册路由 ${method} ${routePath}`);
    const req = fakeReq(url ?? routePath, method, body);
    const res = fakeRes();
    await route.handler(req, res);
    let json = null;
    try { json = JSON.parse(res.body); } catch { /* 非 JSON 响应 */ }
    return { res, json, route };
  };
  return { app, call };
}

test.after(() => {
  for (const root of stagedRoots) {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* 忽略 */ }
  }
});

// ── describePlugins（纯函数）────────────────────────────────────────────

test('describePlugins：仓库自带的 plugins/hello 被扫到且默认未启用', () => {
  resetConfig();
  const { roots, plugins } = describePlugins({ dataDir, config: getConfig(), builtinToolNames: BUILTIN_TOOL_NAMES });
  assert.deepEqual(roots, [path.join(REPO_ROOT, 'plugins')]);
  const hello = plugins.find((item) => item.id === 'hello');
  assert.ok(hello, '应该发现 plugins/hello');
  assert.equal(hello.status, 'disabled');
  assert.deepEqual(hello.tools, ['hello_count', 'hello_recent']);
  assert.deepEqual(hello.capabilities, ['chat:read', 'chat:send', 'storage']);
});

test('describePlugins：已启用且审批一致、但本进程没见过它 → pending-approval 且 needsRestart', () => {
  const root = stageRoot(['fixture-ok']);
  resetConfig({ roots: [root], enabled: ['fixture-ok'], approved: { 'fixture-ok': approve('fixture-ok') } });
  const { plugins } = describePlugins({ dataDir, config: getConfig(), builtinToolNames: BUILTIN_TOOL_NAMES });
  const item = plugins.find((entry) => entry.id === 'fixture-ok');
  assert.equal(item.status, 'pending-approval');
  assert.equal(item.needsRestart, true);
  assert.equal(item.loadedInProcess, false);
  assert.equal(item.approvedMatches, true);
  assert.match(item.reason, /重启后生效/);
});

test('describePlugins：本进程装载结果优先（loaded 就是 loaded）', () => {
  const root = stageRoot(['fixture-ok']);
  resetConfig({ roots: [root], enabled: ['fixture-ok'], approved: { 'fixture-ok': approve('fixture-ok') } });
  const { plugins } = describePlugins({
    dataDir,
    config: getConfig(),
    builtinToolNames: BUILTIN_TOOL_NAMES,
    runtimeStatuses: [{ id: 'fixture-ok', status: 'loaded', reason: '' }]
  });
  const item = plugins.find((entry) => entry.id === 'fixture-ok');
  assert.equal(item.status, 'loaded');
  assert.equal(item.loadedInProcess, true);
  assert.equal(item.needsRestart, false);
});

test('describePlugins：审批指纹不一致 → pending-approval（升级后必须重新确认）', () => {
  const root = stageRoot(['fixture-ok']);
  const stale = approve('fixture-ok');
  stale.version = '0.9.0';
  resetConfig({ roots: [root], enabled: ['fixture-ok'], approved: { 'fixture-ok': stale } });
  const { plugins } = describePlugins({ dataDir, config: getConfig(), builtinToolNames: BUILTIN_TOOL_NAMES });
  const item = plugins.find((entry) => entry.id === 'fixture-ok');
  assert.equal(item.status, 'pending-approval');
  assert.equal(item.approvedMatches, false);
  assert.match(item.reason, /重新确认/);
});

test('describePlugins：已启用但盘上没有 → 单列成 missing 并点名（不让它凭空消失）', () => {
  resetConfig({ enabled: ['typo-id'] });
  const { plugins } = describePlugins({ dataDir, config: getConfig(), builtinToolNames: BUILTIN_TOOL_NAMES });
  const item = plugins.find((entry) => entry.id === 'typo-id');
  assert.equal(item.status, 'missing');
  assert.match(item.reason, /没找到这个 id/);
});

test('describePlugins：manifest 坏 → invalid；工具名撞内置 → failed', () => {
  const root = stageRoot(['fixture-bad-json', 'fixture-collides-builtin']);
  resetConfig({
    roots: [root],
    enabled: ['fixture-bad-json', 'fixture-collides-builtin'],
    approved: { 'fixture-collides-builtin': approve('fixture-collides-builtin') }
  });
  const { plugins } = describePlugins({ dataDir, config: getConfig(), builtinToolNames: BUILTIN_TOOL_NAMES });
  assert.equal(plugins.find((entry) => entry.id === 'fixture-bad-json').status, 'invalid');
  const collide = plugins.find((entry) => entry.id === 'fixture-collides-builtin');
  assert.equal(collide.status, 'failed');
  assert.match(collide.reason, /与已有工具冲突：send_message/);
});

// ── 安装 ────────────────────────────────────────────────────────────────

test('installPluginRoutes：缺 addRoute 直接抛；重复安装幂等（不会注册两份路由）', () => {
  assert.throws(() => installPluginRoutes({}), /addRoute/);
  const { app } = setup();
  const before = app.routes.length;
  installPluginRoutes(app, { dataDir, builtinToolNames: BUILTIN_TOOL_NAMES });
  assert.equal(app.routes.length, before, '重复安装不该再注册一遍');
});

test('所有插件路由都用鉴权默认值（不许写 auth:false）', () => {
  const { app } = setup();
  assert.ok(app.routes.length >= 5);
  for (const route of app.routes) {
    assert.equal(route.opts.auth, undefined,
      `${route.method} ${route.path} 不该显式传 auth（路由表默认 true；免鉴权只允许 /healthz 与 /api/login）`);
  }
});

// ── GET /api/plugins ────────────────────────────────────────────────────

test('GET /api/plugins：给出根目录、启用清单、能力目录与每个插件的状态', async () => {
  const { call } = setup();
  const { res, json } = await call('GET', '/api/plugins');
  assert.equal(res.statusCode, 200);
  assert.deepEqual(json.roots, [path.join(REPO_ROOT, 'plugins')]);
  assert.deepEqual(json.enabled, []);
  assert.ok(json.capabilities.some((item) => item.id === 'chat:send' && item.risk === 'medium'));
  assert.ok(json.plugins.some((item) => item.id === 'hello'));
});

test('GET /api/plugins：凭据明文一个字符都不出现（名字可以给，值不行）', async () => {
  resetConfig({
    settings: { hello: { apiKey: 'sk-MUST-NOT-LEAK', mode: 'fast' } }
  });
  const app = fakeApp();
  installPluginRoutes(app, { dataDir, builtinToolNames: BUILTIN_TOOL_NAMES });
  const route = app.routes.find((item) => item.method === 'GET' && item.path === '/api/plugins');
  const res = fakeRes();
  await route.handler(fakeReq('/api/plugins'), res);

  assert.equal(res.body.includes('sk-MUST-NOT-LEAK'), false, '凭据明文泄漏进了响应');
  const json = JSON.parse(res.body);
  const hello = json.plugins.find((item) => item.id === 'hello');
  assert.equal('apiKey' in hello.settings, false);
  assert.equal(hello.settings.mode, 'fast');
  assert.deepEqual(hello.secretFields, ['apiKey']);
});

// ── POST /api/plugins/toggle ────────────────────────────────────────────

test('toggle：启用写进配置并明确回 restartRequired', async () => {
  const { app, call } = setup();
  const { res, json } = await call('POST', '/api/plugins/toggle', { body: { id: 'hello', enabled: true } });
  assert.equal(res.statusCode, 200);
  assert.equal(json.ok, true);
  assert.equal(json.changed, true);
  assert.equal(json.restartRequired, true);
  assert.deepEqual(json.enabled, ['hello']);
  assert.deepEqual(getConfig().plugins.enabled, ['hello']);
  assert.ok(app.audits.some((item) => item.action === 'plugin.toggle' && item.target === 'hello'));
  assert.ok(app.events.some((item) => item.type === 'plugin-update' && item.payload.action === 'enable'));
});

test('toggle：停用从配置里移除，且不删该插件的设置与状态', async () => {
  const { call } = setup({ enabled: ['hello'], settings: { hello: { mode: 'fast' } } });
  const { json } = await call('POST', '/api/plugins/toggle', { body: { id: 'hello', enabled: false } });
  assert.deepEqual(json.enabled, []);
  assert.deepEqual(getConfig().plugins.enabled, []);
  // 停用只动 enabled：数据保留（换回来还是那份配置）
  assert.deepEqual(getConfig().plugins.settings.hello, { mode: 'fast' });
});

test('toggle：重复启用是 no-op（changed:false、不谎报 restartRequired）', async () => {
  const { call } = setup({ enabled: ['hello'] });
  const { json } = await call('POST', '/api/plugins/toggle', { body: { id: 'hello', enabled: true } });
  assert.equal(json.changed, false);
  assert.equal(json.restartRequired, false);
});

test('toggle：启用一个盘上不存在的 id 当场拒绝（不等到重启才发现拼错）', async () => {
  const { call } = setup();
  const { res, json } = await call('POST', '/api/plugins/toggle', { body: { id: 'no-such-plugin', enabled: true } });
  assert.equal(res.statusCode, 400);
  assert.match(json.error, /找不到插件 no-such-plugin/);
  assert.deepEqual(getConfig().plugins.enabled, []);
});

test('toggle：manifest 不合法的插件不许启用', async () => {
  const root = stageRoot(['fixture-bad-json']);
  const { call } = setup({ roots: [root] });
  const { res, json } = await call('POST', '/api/plugins/toggle', { body: { id: 'fixture-bad-json', enabled: true } });
  assert.equal(res.statusCode, 400);
  assert.match(json.error, /manifest 不合法/);
});

test('toggle：非法 id 与空请求体都被拒（400，不写配置）', async () => {
  const { call } = setup();
  for (const body of [{ id: '../etc/passwd', enabled: true }, { id: 'BAD', enabled: true }, { enabled: true }, {}]) {
    const { res, json } = await call('POST', '/api/plugins/toggle', { body });
    assert.equal(res.statusCode, 400, `应拒绝 ${JSON.stringify(body)}`);
    assert.match(json.error, /插件 id 不合法/);
  }
  assert.deepEqual(getConfig().plugins.enabled, []);
});

// ── POST /api/plugins/approve ───────────────────────────────────────────

test('approve：指纹从盘上的 manifest 现算并写进配置', async () => {
  const root = stageRoot(['fixture-ok']);
  const { call } = setup({ roots: [root], enabled: ['fixture-ok'] });
  const { res, json } = await call('POST', '/api/plugins/approve', { body: { id: 'fixture-ok' } });

  assert.equal(res.statusCode, 200);
  assert.equal(json.restartRequired, true);
  assert.deepEqual(json.approved, approve('fixture-ok'));
  assert.deepEqual(getConfig().plugins.approved['fixture-ok'], approve('fixture-ok'));
});

test('approve：**不采信请求体里的能力/工具**（否则能替插件签下一份假的确认）', async () => {
  const root = stageRoot(['fixture-ok']);
  const { call } = setup({ roots: [root], enabled: ['fixture-ok'] });
  const { json } = await call('POST', '/api/plugins/approve', {
    body: {
      id: 'fixture-ok',
      approved: { version: '9.9.9', capabilities: [], tools: [] },
      capabilities: [],
      tools: []
    }
  });
  const stored = getConfig().plugins.approved['fixture-ok'];
  assert.deepEqual(stored, approve('fixture-ok'));
  assert.deepEqual(json.approved, approve('fixture-ok'));
  assert.equal(stored.version, '1.0.0');
  assert.ok(stored.capabilities.includes('storage'));
  // 请求体里那几个字段一个都没进快照（自有属性检查：`'x' in obj` 会把原型链上的也算上，
  // 所以这里必须用 hasOwnProperty）
  assert.equal(Object.prototype.hasOwnProperty.call(stored, 'approved'), false);
  assert.deepEqual(Object.keys(stored).sort(), ['capabilities', 'tools', 'version']);
});

test('原型污染：请求体里带自有 __proto__ 键不能改写配置段的原型', async () => {
  const { call } = setup({ settings: { hello: { keep: 1 } } });
  const raw = '{"id":"hello","settings":{"__proto__":{"polluted":true},"mode":"fast"}}';
  const { res } = await call('POST', '/api/plugins/settings', { body: raw });
  assert.equal(res.statusCode, 200);

  const stored = getConfig().plugins.settings.hello;
  assert.equal(stored.mode, 'fast');
  assert.equal(stored.keep, undefined, '整体替换：没提交的键该没了');
  // 真正的断言：原型没有被换掉，也没有通过原型链拿到攻击者给的值
  assert.equal(stored.polluted, undefined);
  assert.equal(Object.getPrototypeOf(stored), Object.prototype);
  assert.equal({}.polluted, undefined, 'Object.prototype 被污染了');
  assert.equal(getConfig().polluted, undefined);
});

test('approve：manifest 不合法 / 找不到插件都被拒', async () => {
  const root = stageRoot(['fixture-bad-json']);
  const { call } = setup({ roots: [root], enabled: ['fixture-bad-json'] });
  const bad = await call('POST', '/api/plugins/approve', { body: { id: 'fixture-bad-json' } });
  assert.equal(bad.res.statusCode, 400);
  assert.match(bad.json.error, /manifest 不合法/);

  const missing = await call('POST', '/api/plugins/approve', { body: { id: 'nope-plugin' } });
  assert.equal(missing.res.statusCode, 400);
  assert.match(missing.json.error, /找不到插件/);
});

// ── 设置读写 ────────────────────────────────────────────────────────────

test('GET settings：只给非凭据视图 + 凭据字段名', async () => {
  resetConfig({ settings: { hello: { apiKey: 'sk-SECRET', mode: 'fast' } } });
  const app = fakeApp();
  installPluginRoutes(app, { dataDir, builtinToolNames: BUILTIN_TOOL_NAMES });
  const route = app.routes.find((item) => item.method === 'GET' && item.path === '/api/plugins/settings');
  const res = fakeRes();
  await route.handler(fakeReq('/api/plugins/settings?id=hello', 'GET'), res);

  assert.equal(res.body.includes('sk-SECRET'), false);
  const json = JSON.parse(res.body);
  assert.deepEqual(json.settings, { mode: 'fast' });
  assert.deepEqual(json.secretFields, ['apiKey']);
});

test('POST settings：整体替换（删掉的键真的没了，不会被深合并留在服务端）', async () => {
  const { call } = setup({ settings: { hello: { a: 1, b: 2 } } });
  const { res, json } = await call('POST', '/api/plugins/settings', {
    body: { id: 'hello', settings: { a: 1 } }
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(getConfig().plugins.settings.hello, { a: 1 });
  assert.equal(json.settings.b, undefined);
});

test('POST settings：凭据可以写进去，但响应里只有名字没有值；has* 派生位不落盘', async () => {
  const { call } = setup();
  const { res, json } = await call('POST', '/api/plugins/settings', {
    body: { id: 'hello', settings: { apiKey: 'sk-WRITE-ONLY', mode: 'fast' } }
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.includes('sk-WRITE-ONLY'), false);
  assert.deepEqual(json.secretFields, ['apiKey']);
  assert.deepEqual(json.settings, { mode: 'fast' });
  // 落盘的确实有那把 Key（插件要读得到），而 hasApiKey 这类派生位不许被持久化
  assert.equal(getConfig().plugins.settings.hello.apiKey, 'sk-WRITE-ONLY');
  assert.equal('hasApiKey' in getConfig().plugins.settings.hello, false);
});

test('POST settings：非对象 / 超大 / 未知插件都被拒（400，不写配置）', async () => {
  const { call } = setup({ settings: { hello: { keep: 1 } } });
  const cases = [
    [{ id: 'hello', settings: 'nope' }, /settings 必须是 JSON 对象/],
    [{ id: 'hello', settings: [1, 2] }, /settings 必须是 JSON 对象/],
    [{ id: 'hello' }, /settings 必须是 JSON 对象/],
    [{ id: 'hello', settings: { blob: 'x'.repeat(MAX_SETTINGS_BYTES + 10) } }, /超过 .* 字节上限/],
    [{ id: 'nope-plugin', settings: {} }, /找不到插件/]
  ];
  for (const [body, pattern] of cases) {
    const { res, json } = await call('POST', '/api/plugins/settings', { body });
    assert.equal(res.statusCode, 400, `应拒绝 ${JSON.stringify(body).slice(0, 60)}`);
    assert.match(json.error, pattern);
  }
  // 被拒的请求一个字都没写进配置
  assert.deepEqual(getConfig().plugins.settings.hello, { keep: 1 });
});

test('错误路径都留了审计（写失败也不影响响应）', async () => {
  const { app, call } = setup();
  await call('POST', '/api/plugins/toggle', { body: { id: 'no-such-plugin', enabled: true } });
  assert.ok(app.audits.some((item) => item.payload?.ok === false));
});
