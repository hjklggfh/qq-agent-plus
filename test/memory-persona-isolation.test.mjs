import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

// 必须在 import 业务模块之前指定数据目录：config-legacy 在模块求值时读取该环境变量。
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-persona-isolation-'));
process.env.QQ_AGENT_DATA_DIR = dataDir;

const { MemoryStore } = await import('../src/memory/memory.js');
const { DEFAULT_CONFIG, setRuntimeConfig } = await import('../src/core/config.js');
const { ALT_MEMORY_ROOT, memoryStoreForChat, memoryStoreForProfile, resolveProfileForChat } =
  await import('../src/memory/memory-routing.js');
const { activateChatProfile, clearChatProfile, personaSwitchConfig } = await import('../src/core/persona-switch.js');
const { globalMemoryStoreForIdentity } = await import('../src/memory/memory-runtime-integration.js');

process.on('exit', () => { try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ } });

const CHAT = 'group:1001';
const OTHER = 'group:2002';
const T0 = 1_700_000_000_000;

const altSettings = personaSwitchConfig({
  enabled: true,
  idleMinutes: 30,
  cooldownSeconds: 0,
  altModel: 'claude-sonnet-5-5-low',
  altRoleText: '你是克劳德',
  altName: 'Claude'
});

function configWithAlt(enabled = true) {
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.personaSwitch.enabled = enabled;
  cfg.personaSwitch.altModel = altSettings.altModel;
  cfg.personaSwitch.altRoleText = altSettings.altRoleText;
  return cfg;
}

/**
 * 主实例 + 第二人设实例，等价于 console/app.js 里的装配方式。
 * tag 让每个用例落在自己的子目录里：记忆是落盘状态，共用一个根目录会互相串味。
 */
function buildStores(tag = '') {
  const base = tag ? path.join(dataDir, tag) : dataDir;
  return {
    base,
    main: new MemoryStore({ root: path.join(base, 'memory'), bind: false }),
    alt: new MemoryStore({ root: path.join(base, 'memory-alt'), bind: false, migrate: false })
  };
}

test('两个实例的根目录各自独立，主实例默认仍是 data/memory', () => {
  const main = new MemoryStore({ bind: false });
  const alt = new MemoryStore({ root: ALT_MEMORY_ROOT, bind: false, migrate: false });
  assert.equal(main.root, path.join(dataDir, 'memory'));
  assert.equal(alt.root, ALT_MEMORY_ROOT);
  assert.notEqual(main.root, alt.root);
  assert.equal(alt.people.root, alt.root);
});

test('第二实例不抢走 IdentityStore 的全局记忆来源', () => {
  setRuntimeConfig(configWithAlt(false));
  const main = new MemoryStore();
  assert.equal(globalMemoryStoreForIdentity(), main, '主实例应当完成绑定');
  const alt = new MemoryStore({ root: ALT_MEMORY_ROOT, bind: false, migrate: false });
  assert.notEqual(alt, main);
  assert.equal(globalMemoryStoreForIdentity(), main, '第二实例 bind:false 后仍应指向主实例');
});

test('印象写入/查询/提示词注入在两个实例间互不可见', () => {
  setRuntimeConfig(configWithAlt(true));
  const { main, alt } = buildStores('t3');

  main.append(CHAT, 'memberImpression', '主实例记的印象', { userId: '90001', target: '小明' });
  alt.append(CHAT, 'memberImpression', '第二人设记的印象', { userId: '90002', target: '小红' });

  assert.match(main.formatForPrompt(CHAT), /主实例记的印象/);
  assert.doesNotMatch(main.formatForPrompt(CHAT), /第二人设记的印象/);

  assert.match(alt.formatForPrompt(CHAT), /第二人设记的印象/);
  assert.doesNotMatch(alt.formatForPrompt(CHAT), /主实例记的印象/);

  assert.deepEqual(main.query(CHAT).memberImpression.map((item) => item.content), ['主实例记的印象']);
  assert.deepEqual(alt.query(CHAT).memberImpression.map((item) => item.content), ['第二人设记的印象']);

  assert.deepEqual(main.members(CHAT).map((m) => m.userId), ['90001']);
  assert.deepEqual(alt.members(CHAT).map((m) => m.userId), ['90002']);
  // 只清主实例，不影响第二实例
  main.clear(CHAT);
  assert.deepEqual(main.members(CHAT), []);
  assert.equal(alt.members(CHAT).length, 1);
});

test('第二人设的群印象从空白开始（不继承主实例已有记忆）', () => {
  setRuntimeConfig(configWithAlt(true));
  const { main, alt } = buildStores('t4');
  main.append(OTHER, 'memberImpression', '默认人设在这个群的老印象', { userId: '90003', target: '阿强' });
  assert.match(main.formatForPrompt(OTHER), /老印象/);
  assert.equal(alt.formatForPrompt(OTHER), '', '第二人设第一次来这个群应当什么都不记得');
  assert.deepEqual(alt.query(OTHER).memberImpression, []);
  assert.deepEqual(alt.members(OTHER), []);
});

test('会话交接与整理计时同样分库', () => {
  setRuntimeConfig(configWithAlt(true));
  const { main, alt } = buildStores('t5');

  alt.setHandoff(CHAT, { topic: '第二人设的交接', summary: '只写进 memory-alt' }, { sourceSessionId: 's-alt' });
  assert.equal(main.getHandoff(CHAT), null);
  assert.match(alt.getHandoff(CHAT).summary, /memory-alt/);
  assert.match(alt.formatHandoffForPrompt(CHAT), /第二人设的交接/);
  assert.equal(main.formatHandoffForPrompt(CHAT), '');

  main.markConsolidated(CHAT, T0);
  assert.equal(alt.consolidationState(CHAT).lastConsolidatedAt, 0);
  assert.ok(main.consolidationState(CHAT).lastConsolidatedAt > 0);

  // listChats 只报自己那份目录里的会话
  alt.setHandoff(OTHER, { topic: '另一个群' });
  assert.deepEqual(alt.listChats().sort(), [CHAT, OTHER].sort());
  assert.deepEqual(main.listChats(), [CHAT]);
});

test('两套记忆的文件系统根目录确实分开，备份也落在各自的 root 下', () => {
  setRuntimeConfig(configWithAlt(true));
  const { base, main, alt } = buildStores('t6');
  main.append(CHAT, 'memberImpression', '主库条目', { userId: '91001', target: '甲' });
  alt.append(CHAT, 'memberImpression', '副库条目', { userId: '91001', target: '甲' });

  const mainFile = path.join(base, 'memory', 'people', '91001.json');
  const altFile = path.join(base, 'memory-alt', 'people', '91001.json');
  assert.ok(fs.existsSync(mainFile), '主库应写在自己的 people 目录');
  assert.ok(fs.existsSync(altFile), '第二人设库应写在 memory-alt/people');
  assert.match(fs.readFileSync(mainFile, 'utf8'), /主库条目/);
  assert.match(fs.readFileSync(altFile, 'utf8'), /副库条目/);
  assert.doesNotMatch(fs.readFileSync(altFile, 'utf8'), /主库条目/);

  // 删人前会拍快照：快照目录必须跟着各自的 root 走，不能混进主库的 backups
  alt.removeMember('', '91001');
  assert.ok(fs.existsSync(path.join(base, 'memory-alt', 'backups', 'consolidation', '91001')));
  assert.ok(!fs.existsSync(path.join(base, 'memory', 'backups', 'consolidation', '91001')));
});

test('按会话路由：功能关闭或不在值班时一律回主实例', () => {
  setRuntimeConfig(configWithAlt(false));
  const { main, alt } = buildStores('t7');
  assert.equal(resolveProfileForChat(CHAT), 'home');
  assert.equal(memoryStoreForChat({ main, alt }, CHAT), main);
  assert.equal(memoryStoreForChat({ main, alt: null }, CHAT), main);
});

test('按会话路由：第二人设值班的会话取第二实例，其它会话不受影响', () => {
  setRuntimeConfig(configWithAlt(true));
  const { main, alt } = buildStores('t8');
  const at = T0 + 60_000;

  activateChatProfile(CHAT, 'alt', T0, altSettings);
  assert.equal(resolveProfileForChat(CHAT, { now: at }), 'alt');
  assert.equal(resolveProfileForChat(OTHER, { now: at }), 'home');
  assert.equal(memoryStoreForChat({ main, alt }, CHAT, { profile: 'alt' }), alt);
  assert.equal(memoryStoreForChat({ main, alt }, CHAT, { now: at }), alt);
  assert.equal(memoryStoreForChat({ main, alt }, OTHER, { now: at }), main);
  assert.equal(memoryStoreForProfile({ main, alt }, 'alt'), alt);
  assert.equal(memoryStoreForProfile({ main, alt }, 'home'), main);

  // 值班结束（闲置超时）后自动回主实例，不需要额外清理
  assert.equal(resolveProfileForChat(CHAT, { now: T0 + 31 * 60_000 }), 'home');
  assert.equal(memoryStoreForChat({ main, alt }, CHAT, { now: T0 + 31 * 60_000 }), main);

  clearChatProfile(CHAT);
});
