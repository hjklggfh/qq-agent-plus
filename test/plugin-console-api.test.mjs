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

/** 仓库自带插件的审批指纹（它们不在 fixtures 里，`approve()` 只认 fixtures）。 */
function approveRepo(id) {
  const dir = path.join(REPO_ROOT, 'plugins', id);
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

// ── 插件根（"自行添加插件"的落点，2026-10-08 三期）─────────────────────────
//
// 这一组钉的是"加/删插件不必发版本"这条路：插件放安装目录之外的根 → rsync 不碰它 →
// 只改配置 + 重启即可。所以"根的写入"必须干净（trim、丢空行、上限、拒绝控制字符），
// 而"谁能被加到根里"必须能被页面看出来（rootInfo.bundled）。

test('POST /api/plugins/roots：写入前 trim、丢空行，并回带 rootInfo（含 bundled 与 exists）', async () => {
  const { call } = setup();
  const { res, json } = await call('POST', '/api/plugins/roots', {
    body: { roots: ['  /srv/qq/plugins  ', '', '   ', '/srv/qq/extra'] }
  });
  assert.equal(res.statusCode, 200);
  // json.roots 是**生效的**全部根（额外根 + 随版本发布的那个），配置里只存额外根。
  // 注意 `pluginRoots()` 会对绝对路径做 path.normalize —— Windows 下 `/srv/x` 会变成 `\srv\x`，
  // 所以要拿 path.normalize 过一遍再比，否则这条断言只有 Linux 上过得去。
  const norm = (value) => path.normalize(value);
  assert.deepEqual(json.roots, [norm('/srv/qq/plugins'), norm('/srv/qq/extra'), path.join(REPO_ROOT, 'plugins')]);
  assert.deepEqual(getConfig().plugins.roots, ['/srv/qq/plugins', '/srv/qq/extra'], '配置里只该存额外根，且是干净的两条');
  // 随版本发布的那一个根永远在（且排在最后），页面靠 bundled/exists 分辨"哪个根是 deploy 管的"
  const bundled = json.rootInfo.filter((item) => item.bundled);
  assert.equal(bundled.length, 1, `应恰好一个随版本发布的根，实际 ${JSON.stringify(json.rootInfo)}`);
  assert.equal(bundled[0].path, path.join(REPO_ROOT, 'plugins'));
  assert.equal(bundled[0].exists, true);
  assert.equal(json.rootInfo.find((item) => item.path === norm('/srv/qq/plugins')).bundled, false);
  assert.equal(json.rootInfo.find((item) => item.path === norm('/srv/qq/plugins')).exists, false, '不存在的根要如实标出来');
  assert.equal(json.maxRoots, 5, '上限由服务端下发，界面不该抄一份');
});

test('POST /api/plugins/roots：超上限 / 非数组 / 控制字符都拒绝，且一个字都不写进配置', async () => {
  const { call } = setup({ roots: ['/keep'] });
  const tooMany = await call('POST', '/api/plugins/roots', {
    body: { roots: ['/a', '/b', '/c', '/d', '/e', '/f'] }
  });
  assert.equal(tooMany.res.statusCode, 400);
  assert.match(tooMany.json.error, /最多 5 个插件根/);

  const notArray = await call('POST', '/api/plugins/roots', { body: { roots: '/srv/qq' } });
  assert.equal(notArray.res.statusCode, 400);
  assert.match(notArray.json.error, /必须是数组/);

  const control = await call('POST', '/api/plugins/roots', { body: { roots: ['/srv/qq\nrm -rf'] } });
  assert.equal(control.res.statusCode, 400);
  assert.match(control.json.error, /控制字符/);

  assert.deepEqual(getConfig().plugins.roots, ['/keep'], '被拒的请求不该改动配置');
});

test('POST /api/plugins/roots：传空数组等于"只用随版本发布的那个根"', async () => {
  const { call } = setup({ roots: ['/srv/qq/plugins'] });
  const { res, json } = await call('POST', '/api/plugins/roots', { body: { roots: [] } });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(json.roots, [path.join(REPO_ROOT, 'plugins')]);
  assert.deepEqual(getConfig().plugins.roots, []);
});

// ── 移除（把三处记录一起清掉）─────────────────────────────────────────────

test('POST /api/plugins/remove：清掉 enabled/approved/settings，且不碰别的插件、不删目录', async () => {
  // 「另一个插件」用夹具而不是仓库自带的那个：2026-10-08 把 pixiv-illust 挪到自建插件仓库之后，
  // 仓库里只剩 hello 一个（再拿它当"另一个"就没意义了）。
  const otherRoot = stageRoot(['fixture-ok']);
  const { call } = setup({
    roots: [otherRoot],
    enabled: ['hello', 'fixture-ok'],
    approved: { hello: approveRepo('hello'), 'fixture-ok': approve('fixture-ok') },
    settings: { hello: { keep: 1 }, 'fixture-ok': { ownerIds: '123' } }
  });
  const { res, json } = await call('POST', '/api/plugins/remove', { body: { id: 'hello' } });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(json.removed.wasEnabled, true);
  assert.deepEqual(json.removed.hadApproval, true);
  assert.deepEqual(json.removed.hadSettings, true);
  assert.equal(json.removed.purged, false, '没要求就别删数据');

  const plugins = getConfig().plugins;
  assert.deepEqual(plugins.enabled, ['fixture-ok'], '只摘掉这一个 id');
  assert.equal(plugins.approved.hello, undefined, '确认记录要删掉（否则残留一份没人看的快照）');
  assert.equal(plugins.settings.hello, undefined, '设置记录要删掉');
  assert.ok(plugins.approved['fixture-ok'], '别的插件的确认记录不许被牵连');
  assert.ok(plugins.settings['fixture-ok'], '别的插件的设置不许被牵连');
  // 插件目录本身不删：它可能在随版本发布的那个根里，删了下次部署又回来
  assert.ok(fs.existsSync(path.join(REPO_ROOT, 'plugins', 'hello')));
});

test('POST /api/plugins/remove：只有显式 purgeState 才删状态目录，删不掉也如实报出来', async () => {
  const stateDir = path.join(dataDir, 'plugin-state', 'hello');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'kv.json'), '{"count":1}');

  const plain = setup({ enabled: ['hello'] });
  const before = await plain.call('POST', '/api/plugins/remove', { body: { id: 'hello' } });
  assert.equal(before.json.removed.purged, false);
  assert.ok(fs.existsSync(stateDir), '不勾"删数据"时数据必须留着（重装还能接上）');

  const purging = setup({ enabled: ['hello'] });
  const after = await purging.call('POST', '/api/plugins/remove', { body: { id: 'hello', purgeState: true } });
  assert.equal(after.json.removed.purged, true);
  assert.equal(after.json.removed.purgeError, '');
  assert.equal(fs.existsSync(stateDir), false, '勾了就该真的删掉');
});

test('POST /api/plugins/remove：盘上找不到的 id 也认（清残留），完全没记录的 id 才拒绝', async () => {
  // "配置里写着启用、盘上没有"是最该能被清掉的一种残留 —— 页面显示成「找不到」，
  // 而除了移除它没有别的出口。
  const { call } = setup({ enabled: ['ghost-plugin'] });
  const { res, json } = await call('POST', '/api/plugins/remove', { body: { id: 'ghost-plugin' } });
  assert.equal(res.statusCode, 200);
  assert.equal(json.removed.wasEnabled, true);
  assert.deepEqual(getConfig().plugins.enabled, []);

  const unknown = await call('POST', '/api/plugins/remove', { body: { id: 'never-existed' } });
  assert.equal(unknown.res.statusCode, 400);
  assert.match(unknown.json.error, /找不到插件 never-existed/);
});

test('GET /api/plugins：每个插件报出来源根与"有没有状态目录"，missing 行也能带出 enabled', async () => {
  fs.mkdirSync(path.join(dataDir, 'plugin-state', 'hello'), { recursive: true });
  const { call } = setup({ enabled: ['hello', 'ghost-plugin'] });
  const { json } = await call('GET', '/api/plugins');

  const hello = json.plugins.find((item) => item.id === 'hello');
  assert.equal(hello.bundled, true);
  assert.equal(hello.root, path.join(REPO_ROOT, 'plugins'));
  assert.equal(hello.stateDirExists, true);

  const ghost = json.plugins.find((item) => item.id === 'ghost-plugin');
  assert.equal(ghost.status, 'missing');
  assert.equal(ghost.bundled, false);
  assert.equal(ghost.root, '');
  assert.equal(ghost.enabled, true, 'missing 行也要能看出它"配置里是启用的"');
});

test('Pixiv 设置页：按会话分级从状态文件读写，不混进 config.json', async () => {
  const stateDir = path.join(dataDir, 'plugin-state', 'pixiv-illust');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'chat-ratings.json'), JSON.stringify({ 'group:123': ['safe'] }));
  const { call } = setup({ enabled: ['pixiv-illust'], settings: { 'pixiv-illust': { ratings: ['safe'] } } });
  const got = await call('GET', '/api/plugins/settings', { url: '/api/plugins/settings?id=pixiv-illust' });
  assert.equal(got.res.statusCode, 200);
  assert.deepEqual(got.json.settings.chatRatings, { 'group:123': ['safe'] });

  const saved = await call('POST', '/api/plugins/settings', {
    body: {
      id: 'pixiv-illust',
      settings: {
        ratings: ['safe'],
        chatRatings: { 'group:123': ['safe', 'r18', 'r18g'], 'private:456': ['safe', 'r18'] }
      }
    }
  });
  assert.equal(saved.res.statusCode, 200);
  assert.deepEqual(saved.json.settings.chatRatings, {
    'group:123': ['safe', 'r18', 'r18g'], 'private:456': ['safe', 'r18']
  });
  assert.deepEqual(getConfig().plugins.settings['pixiv-illust'], { ratings: ['safe'] });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(stateDir, 'chat-ratings.json'), 'utf8')), saved.json.settings.chatRatings);
});

test('Pixiv 设置页：拒绝非法会话键和分级，不写入文件', async () => {
  const stateDir = path.join(dataDir, 'plugin-state', 'pixiv-illust');
  fs.mkdirSync(stateDir, { recursive: true });
  const file = path.join(stateDir, 'chat-ratings.json');
  fs.writeFileSync(file, JSON.stringify({ 'group:keep': ['safe'] }));
  const { call } = setup({ enabled: ['pixiv-illust'], settings: { 'pixiv-illust': {} } });
  for (const chatRatings of [{ nope: ['safe'] }, { 'group:1': ['unsafe'] }, { 'group:1': [] }]) {
    const result = await call('POST', '/api/plugins/settings', { body: { id: 'pixiv-illust', settings: { chatRatings } } });
    assert.equal(result.res.statusCode, 400);
  }
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { 'group:keep': ['safe'] });
});

test('Pixiv 设置页：隐藏并清理旧版误写进全局设置的会话键', async () => {
  const stateDir = path.join(dataDir, 'plugin-state', 'pixiv-illust');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'chat-ratings.json'), JSON.stringify({ 'group:123': ['safe'] }));
  const { call } = setup({
    enabled: ['pixiv-illust'],
    settings: {
      'pixiv-illust': {
        ratings: ['safe'],
        'group:123': ['safe', 'r18'],
        'private:456': ['safe']
      }
    }
  });
  const got = await call('GET', '/api/plugins/settings', { url: '/api/plugins/settings?id=pixiv-illust' });
  assert.deepEqual(got.json.settings, { ratings: ['safe'], chatRatings: { 'group:123': ['safe'] } });

  const saved = await call('POST', '/api/plugins/settings', {
    body: {
      id: 'pixiv-illust',
      settings: {
        ratings: ['safe'],
        chatRatings: { 'group:123': ['safe'] },
        'group:123': ['r18'],
        'private:456': ['r18']
      }
    }
  });
  assert.equal(saved.res.statusCode, 200);
  assert.deepEqual(getConfig().plugins.settings['pixiv-illust'], { ratings: ['safe'] });
});
