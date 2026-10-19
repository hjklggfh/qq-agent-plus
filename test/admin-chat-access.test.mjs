import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_CONFIG } from '../src/core/config.js';
import { executeAdminChatAccessCommand, parseAdminChatAccessCommand } from '../src/features/admin-chat-access.js';

test('管理员功能指令只修改指定名单，保留原有会话权限', () => {
  let config = structuredClone(DEFAULT_CONFIG);
  config.admin.ownerUin = '123456';
  config.allow.groups = ['100001', '100002'];
  config.allow.private = ['123456', '200001'];
  config.haiguiTang.allowedChats = ['group:100001'];
  config.groupGame.chats = ['group:100002'];
  const original = structuredClone(config);
  const changes = [];
  const options = {
    actorId: '123456', getConfig: () => config,
    updateConfig: (patch) => { config = { ...config, ...Object.fromEntries(Object.entries(patch).map(([key, value]) => [key, { ...config[key], ...value }])) }; },
    onChange: (...args) => changes.push(args)
  };
  const run = (text) => executeAdminChatAccessCommand(parseAdminChatAccessCommand(text), options);
  assert.match(run('功能 查看 group:100001'), /海龟汤：已授权（全局关闭）/);
  assert.deepEqual(config, original);
  assert.match(run('功能 开启 group:100003 海龟汤'), /已开启/);
  assert.deepEqual(config.haiguiTang.allowedChats, ['group:100001', 'group:100003']);
  assert.deepEqual(config.allow.groups, original.allow.groups);
  assert.deepEqual(config.groupGame.chats, original.groupGame.chats);
  assert.match(run('功能 关闭 group:100001 基础聊天'), /基础聊天：已关闭/);
  assert.deepEqual(config.allow.groups, ['100002']);
  assert.deepEqual(config.deny.groups, ['100001']);
  assert.deepEqual(config.allow.private, original.allow.private);
  assert.deepEqual(changes, [['海龟汤', 'group:100003'], ['基础聊天', 'group:100001']]);
});

test('管理员指令拒绝越权、无效目标和不支持的会话类型', () => {
  let config = structuredClone(DEFAULT_CONFIG);
  config.admin.ownerUin = '123456';
  config.allow.private = ['123456'];
  let writes = 0;
  const options = { actorId: '999999', getConfig: () => config, updateConfig: () => { writes++; } };
  assert.equal(executeAdminChatAccessCommand(parseAdminChatAccessCommand('功能 开启 group:100001 海龟汤'), options), null);
  options.actorId = '123456';
  for (const text of ['功能 关闭 private:123456 基础聊天', '功能 关闭 private:123456 E站',
    '功能 开启 private:200001 群游戏', '功能 开启 group:100001 未知功能', '功能 开启 group:abc 海龟汤']) {
    assert.ok(executeAdminChatAccessCommand(parseAdminChatAccessCommand(text), options));
  }
  assert.equal(writes, 0);
  assert.equal(parseAdminChatAccessCommand('你好'), null);
});

test('开放模式仅移除拒绝项，不建立限制其他会话的允许名单', () => {
  let config = structuredClone(DEFAULT_CONFIG);
  config.admin.ownerUin = '123456';
  config.allowAllWhenEmpty = true;
  config.deny.groups = ['100001'];
  const options = {
    actorId: '123456', getConfig: () => config,
    updateConfig: (patch) => { config = { ...config, ...Object.fromEntries(Object.entries(patch).map(([key, value]) => [key, { ...config[key], ...value }])) }; }
  };
  executeAdminChatAccessCommand(parseAdminChatAccessCommand('功能 开启 group:100001 基础聊天'), options);
  assert.deepEqual(config.allow.groups, []);
  assert.deepEqual(config.deny.groups, []);
  assert.equal(config.allowAllWhenEmpty, true);
  config.allow.groups = ['100001'];
  executeAdminChatAccessCommand(parseAdminChatAccessCommand('功能 关闭 group:100001 基础聊天'), options);
  assert.deepEqual(config.allow.groups, ['100001']);
  assert.deepEqual(config.deny.groups, ['100001']);
});

test('JM 管理员覆盖层不改原有群名单', () => {
  let config = structuredClone(DEFAULT_CONFIG);
  config.admin.ownerUin = '123456';
  config.allow.private = ['123456'];
  const legacyGroups = { '100001': { name: '原有群' } };
  const options = {
    actorId: '123456', getConfig: () => config,
    updateConfig: (patch) => { config = { ...config, jm: { ...config.jm, ...patch.jm } }; },
    jmChatAllowed: (target) => !config.jm.deniedChats.includes(target)
      && (config.jm.allowedChats.includes(target) || target === 'group:100001'),
    jmConfiguredGroups: () => Object.keys(legacyGroups)
  };
  assert.match(executeAdminChatAccessCommand(parseAdminChatAccessCommand('功能 列表'), options), /group:100001/);
  executeAdminChatAccessCommand(parseAdminChatAccessCommand('功能 关闭 group:100001 JM'), options);
  assert.deepEqual(config.jm.deniedChats, ['group:100001']);
  assert.deepEqual(legacyGroups, { '100001': { name: '原有群' } });
  executeAdminChatAccessCommand(parseAdminChatAccessCommand('功能 开启 group:100001 JM'), options);
  assert.deepEqual(config.jm.deniedChats, []);
  assert.deepEqual(legacyGroups, { '100001': { name: '原有群' } });
});
