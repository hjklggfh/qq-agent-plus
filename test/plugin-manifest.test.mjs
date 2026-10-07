// 插件 manifest 校验的契约用例。
//
// 口径：manifest 是**外部输入**，每一条拒绝路径都对应一种"坏插件悄悄拿到不该有的东西"或
// "坏插件拖垮整轮扫描"的真实可能。所以这里不做抽样，按字段逐个钉住。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  MAX_TOOLS_PER_PLUGIN,
  PluginManifestError,
  fingerprintMatches,
  manifestFingerprint,
  normalizeManifest,
  readManifest,
  resolveEntryPath
} from '../plugins/_host/manifest.js';
import { PLUGIN_CAPABILITY_IDS } from '../plugins/_host/capabilities.js';

const ENTRY_SOURCE = 'export async function activate() {}\n';

// 每个用例都会造临时目录，逐个写 t.after 太啰嗦，也容易漏。统一登记、进程退出时清。
const TEMP_DIRS = [];
process.on('exit', () => {
  for (const dir of TEMP_DIRS) {
    // Windows 上可能还被句柄占着：清理失败不影响用例结论（临时目录本来就在 os.tmpdir 下）。
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 忽略 */ }
  }
});

/**
 * 造一个临时插件目录。
 *
 * 结构刻意是 root/p/ ：需要"越出插件目录"的用例把文件放在 root/ 下，
 * 这样清理时只删 root，不会碰到 os.tmpdir() 里的别的东西。
 */
function makePlugin({ manifest, files = { 'index.mjs': ENTRY_SOURCE } } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-plugin-manifest-'));
  TEMP_DIRS.push(root);
  const dir = path.join(root, 'p');
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    const full = path.join(dir, name);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  if (manifest !== undefined) {
    fs.writeFileSync(
      path.join(dir, 'plugin.json'),
      typeof manifest === 'string' ? manifest : JSON.stringify(manifest, null, 2)
    );
  }
  return { root, dir };
}

function baseManifest(override = {}) {
  return {
    id: 'demo',
    name: 'Demo',
    version: '1.0.0',
    apiVersion: 1,
    entry: 'index.mjs',
    capabilities: ['storage'],
    tools: [{ name: 'demo_tool' }],
    ...override
  };
}

function normalize(manifest, { expectedId = 'demo', files, warn = null } = {}) {
  const { dir } = makePlugin({ manifest, files });
  return normalizeManifest(manifest, {
    pluginDir: dir,
    expectedId,
    capabilityNames: PLUGIN_CAPABILITY_IDS,
    warn
  });
}

test('接受合法 manifest 并归一：能力排序、超时给默认值、id 与目录名一致', (t) => {
  const { dir } = makePlugin({
    manifest: baseManifest({ capabilities: ['storage', 'chat:send'] })
  });
  t.after(() => fs.rmSync(path.dirname(dir), { recursive: true, force: true }));

  const result = normalizeManifest(baseManifest({ capabilities: ['storage', 'chat:send'] }), {
    pluginDir: dir,
    expectedId: 'demo',
    capabilityNames: PLUGIN_CAPABILITY_IDS
  });

  assert.equal(result.id, 'demo');
  assert.equal(result.version, '1.0.0');
  // capabilities 排序后再进指纹，否则"声明顺序不同"会被当成能力变更、反复要求重新确认。
  assert.deepEqual(result.capabilities, ['chat:send', 'storage']);
  assert.equal(result.tools.length, 1);
  assert.equal(result.tools[0].name, 'demo_tool');
  assert.equal(result.tools[0].timeoutMs, 15000);
  assert.equal(result.entryPath, fs.realpathSync(path.join(dir, 'index.mjs')));
});

test('缺 capabilities 视作"零能力"而不是报错（纯计算插件是合法的）', () => {
  const manifest = baseManifest();
  delete manifest.capabilities;
  const result = normalize(manifest);
  assert.deepEqual(result.capabilities, []);
});

test('未知顶层键只警告不拒绝（跨版本前向兼容）', () => {
  const warnings = [];
  const manifest = baseManifest({ futureField: { anything: true }, another: 1 });
  normalize(manifest, { warn: (message) => warnings.push(message) });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /不认识的键/);
  assert.match(warnings[0], /futureField/);
});

const REJECT_CASES = [
  ['manifest 顶层不是对象', [], /顶层必须是对象/],
  ['缺少 id', baseManifest({ id: '' }), /缺少 id/],
  ['id 含大写', baseManifest({ id: 'Demo' }), /id Demo 不合法/],
  ['id 以数字开头', baseManifest({ id: '1demo' }), /id 1demo 不合法/],
  ['id 含下划线', baseManifest({ id: 'de_mo' }), /id de_mo 不合法/],
  ['id 太长', baseManifest({ id: `d${'x'.repeat(40)}` }), /不合法/],
  ['id 与目录名不一致', baseManifest({ id: 'other' }), /与插件目录名/],
  ['缺少 name', baseManifest({ name: '   ' }), /缺少 name/],
  ['name 过长', baseManifest({ name: 'x'.repeat(61) }), /name 超过/],
  ['缺少 version', baseManifest({ version: '' }), /缺少 version/],
  ['version 不是 x.y.z', baseManifest({ version: '1.0' }), /version 1\.0 不合法/],
  ['apiVersion 不是整数', baseManifest({ apiVersion: '1' }), /apiVersion 必须是整数/],
  ['apiVersion 不匹配', baseManifest({ apiVersion: 99 }), /apiVersion 99 与/],
  ['entry 为空', baseManifest({ entry: '' }), /entry 必须是非空字符串/],
  ['entry 是绝对路径', baseManifest({ entry: '/etc/passwd.mjs' }), /必须是插件目录内的相对路径/],
  ['entry 带 scheme', baseManifest({ entry: 'file:///etc/x.mjs' }), /必须是插件目录内的相对路径/],
  ['entry 扩展名不对', baseManifest({ entry: 'index.txt' }), /只允许 \.js \/ \.mjs/],
  ['entry 文件不存在', baseManifest({ entry: 'nope.mjs' }), /入口文件不存在/],
  ['entry 越出插件目录', baseManifest({ entry: '../outside.mjs' }), /越出插件目录/],
  ['capabilities 不是数组', baseManifest({ capabilities: 'storage' }), /capabilities 必须是数组/],
  ['capabilities 含非字符串', baseManifest({ capabilities: [1] }), /每一项都必须是非空字符串/],
  ['capabilities 重复', baseManifest({ capabilities: ['storage', 'storage'] }), /capabilities 里重复/],
  ['capabilities 有未知能力', baseManifest({ capabilities: ['root:all'] }), /未知能力 root:all/],
  ['tools 不是数组', baseManifest({ tools: {} }), /tools 必须是非空数组/],
  ['tools 为空', baseManifest({ tools: [] }), /tools 必须是非空数组/],
  ['tools 超过上限', baseManifest({
    tools: Array.from({ length: MAX_TOOLS_PER_PLUGIN + 1 }, (_v, i) => ({ name: `t_${i}` }))
  }), /tools 最多/],
  ['tools 项不是对象', baseManifest({ tools: ['demo_tool'] }), /每一项都必须是对象/],
  ['工具名缺失', baseManifest({ tools: [{}] }), /tools\[\]\.name 必须是非空字符串/],
  ['工具名含非法字符', baseManifest({ tools: [{ name: 'demo tool' }] }), /不合法：只允许/],
  ['工具名带 qq_ 前缀', baseManifest({ tools: [{ name: 'qq_mark_read' }] }), /不许以 qq_ 开头/],
  ['工具名重复', baseManifest({ tools: [{ name: 'demo_tool' }, { name: 'demo_tool' }] }), /工具名重复/],
  ['timeoutMs 不是数字', baseManifest({ tools: [{ name: 'demo_tool', timeoutMs: 'fast' }] }), /timeoutMs 不是数字/],
  ['timeoutMs 太小', baseManifest({ tools: [{ name: 'demo_tool', timeoutMs: 10 }] }), /timeoutMs 必须在/],
  ['timeoutMs 太大', baseManifest({ tools: [{ name: 'demo_tool', timeoutMs: 999999 }] }), /timeoutMs 必须在/],
  ['description 不是字符串', baseManifest({ description: 42 }), /description 必须是字符串/],
  ['description 过长', baseManifest({ description: 'x'.repeat(601) }), /description 超过/]
];

for (const [label, manifest, pattern] of REJECT_CASES) {
  test(`拒绝：${label}`, () => {
    assert.throws(() => normalize(manifest), pattern);
  });
}

test('所有拒绝路径都抛 PluginManifestError（调用方靠类型区分"坏插件"与"宿主 bug"）', () => {
  assert.throws(() => normalize(baseManifest({ id: 'BAD' })), PluginManifestError);
});

test('readManifest 对读不到的 manifest 抛 PluginManifestError 而不是裸 ENOENT', () => {
  const { dir } = makePlugin({});
  assert.throws(() => readManifest(dir), PluginManifestError);
});

test('readManifest 对非法 JSON 给出可读原因', () => {
  const { dir } = makePlugin({ manifest: '{ "id": "demo", }' });
  assert.throws(() => readManifest(dir), /不是合法 JSON/);
});

test('readManifest 容忍 UTF-8 BOM（Windows 编辑器存盘的常见形态）', () => {
  const { dir } = makePlugin({});
  fs.writeFileSync(
    path.join(dir, 'plugin.json'),
    `\uFEFF${JSON.stringify(baseManifest())}`
  );
  const parsed = readManifest(dir);
  assert.equal(parsed.id, 'demo');
});

test('resolveEntryPath 拒绝指向插件目录之外的符号链接', (t) => {
  const { root, dir } = makePlugin({});
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const outside = path.join(root, 'outside.mjs');
  fs.writeFileSync(outside, ENTRY_SOURCE);
  // Windows 上建符号链接需要权限，拿不到就跳过这一条（不能因为平台差异判红）。
  try {
    fs.symlinkSync(outside, path.join(dir, 'link.mjs'));
  } catch {
    t.skip('当前环境不允许创建符号链接');
    return;
  }
  assert.throws(() => resolveEntryPath(dir, 'link.mjs'), /越出插件目录/);
});

test('指纹只由 version / capabilities / tools 决定，改文案不触发重新确认', () => {
  const before = baseManifest({ description: '旧说明' });
  const after = baseManifest({ description: '新说明', name: '改了名字' });
  assert.equal(fingerprintMatches(before, after), true);

  assert.equal(fingerprintMatches(before, baseManifest({ version: '1.0.1' })), false);
  assert.equal(fingerprintMatches(before, baseManifest({ capabilities: [] })), false);
  assert.equal(fingerprintMatches(before, baseManifest({ tools: [{ name: 'other_tool' }] })), false);
});

test('指纹对声明顺序不敏感（否则改一次书写顺序就要管理员重新确认）', () => {
  const a = baseManifest({ capabilities: ['storage', 'chat:send'], tools: [{ name: 'b_tool' }, { name: 'a_tool' }] });
  const b = baseManifest({ capabilities: ['chat:send', 'storage'], tools: [{ name: 'a_tool' }, { name: 'b_tool' }] });
  assert.equal(fingerprintMatches(a, b), true);
});

test('指纹必须是幂等的（控制台存的就是指纹本身，装载器要能拿它比对）', () => {
  const manifest = baseManifest({
    capabilities: ['storage', 'chat:send'],
    tools: [{ name: 'b_tool', timeoutMs: 3000 }, { name: 'a_tool' }]
  });
  const once = manifestFingerprint(manifest);
  const twice = manifestFingerprint(once);
  assert.deepEqual(twice, once);
  // 幂等之后，fingerprintMatches 才可能在"审批对象 vs manifest"之间成立
  assert.equal(fingerprintMatches(once, manifest), true);
});

test('manifestFingerprint 对畸形输入不抛（配置里的坏快照要能和它比对）', () => {
  assert.deepEqual(manifestFingerprint(null), { version: '', capabilities: [], tools: [] });
  assert.deepEqual(manifestFingerprint({ tools: [null, { name: 'x' }] }), {
    version: '',
    capabilities: [],
    tools: ['x']
  });
});
