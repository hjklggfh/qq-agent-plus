import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { TrpgManager, rollDice, validateAsset } from '../src/features/trpg/manager.js';
import { validateTrpgPatch } from '../src/features/trpg/config.js';

function fixture(t, enabled = true) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-trpg-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const cfg = { trpg: { enabled, maxPlayers: 6, allowedGroups: ['100001'], allowedPrivate: ['123456'] } };
  let allowed = true, rolls = 0;
  const manager = new TrpgManager({ dataDir: dir, getConfig: () => cfg, canRun: () => allowed, rng: () => { rolls++; return 11; } });
  return { manager, cfg, dir, deny: () => { allowed = false; }, rolls: () => rolls };
}
const HOST = '123456', OTHER = '234567', CHAT = 'group:100001';
function begin(m, chat = CHAT) {
  m.command(chat, HOST, '/跑团 开团 mist-harbor');
  m.command(chat, HOST, '/跑团 加入 traveler');
  m.command(chat, HOST, '/跑团 开始');
}
function context(m, id = 100, senderId = HOST) {
  return { chatKey: CHAT, triggerEntries: [{ id, senderId, ts: Date.now() + 1, text: '/跑团 行动 我检查门锁' }] };
}

test('未开启时不创建数据，管理页仍可查看示例，配置严格校验', (t) => {
  const f = fixture(t, false);
  assert.equal(fs.existsSync(path.join(f.dir, 'trpg')), false);
  assert.equal(f.manager.snapshot().worlds[0].id, 'mist-harbor');
  assert.equal(fs.existsSync(path.join(f.dir, 'trpg')), false);
  assert.throws(() => f.manager.command(CHAT, HOST, '/跑团 列表'), /未开启/);
  assert.equal(fs.existsSync(f.manager.file), false);
  assert.throws(() => validateTrpgPatch({ enabled: 'true' }), /布尔/);
  assert.throws(() => validateTrpgPatch({ maxPlayers: 7 }), /1—6/);
  assert.throws(() => validateAsset('characters', { name: 'a', description: 'b', attributes: { 力量: 11 } }), /-5—10/);
});

test('单人开团、快照隔离与重启恢复；禁用和暂停不丢数据', (t) => {
  const f = fixture(t);
  begin(f.manager);
  const before = f.manager.current(CHAT);
  assert.equal(before.players.length, 1);
  f.manager.saveAsset('worlds', { id: 'mist-harbor', name: '修改后的世界', description: '改动' });
  assert.equal(f.manager.current(CHAT).world.name, '雾港来信');
  const restored = new TrpgManager({ dataDir: f.dir, getConfig: () => f.cfg, canRun: () => true });
  assert.equal(restored.current(CHAT).id, before.id);
  restored.command(CHAT, HOST, '/跑团 暂停');
  assert.throws(() => restored.command(CHAT, HOST, '/跑团 行动 开门'), /在册玩家/);
  restored.command(CHAT, HOST, '/跑团 继续');
  f.cfg.trpg.enabled = false;
  assert.equal(restored.narratorActive(CHAT), false);
  assert.equal(restored.actionContext(CHAT, context(restored).triggerEntries), null);
  assert.equal(restored.current(CHAT).status, 'playing');
});

test('会话、角色归属、团主和人数边界；旁观者不能行动', (t) => {
  const f = fixture(t);
  const card = f.manager.saveAsset('characters', { name: '秘密角色', description: '私人描述' }, { scope: CHAT, ownerId: HOST });
  assert.equal(f.manager.assets('characters', 'private:123456').some((c) => c.id === card.id), false);
  f.manager.command(CHAT, HOST, '/跑团 开团 mist-harbor');
  assert.throws(() => f.manager.command(CHAT, OTHER, `/跑团 加入 ${card.id}`), /自己的卡/);
  f.manager.command(CHAT, HOST, `/跑团 加入 ${card.id}`);
  assert.throws(() => f.manager.command(CHAT, OTHER, '/跑团 开始'), /团主/);
  f.cfg.trpg.maxPlayers = 1;
  assert.throws(() => f.manager.command(CHAT, OTHER, '/跑团 加入 traveler'), /人数已满/);
  f.manager.command(CHAT, HOST, '/跑团 开始');
  assert.equal(f.manager.actionContext(CHAT, context(f.manager, 101, OTHER).triggerEntries), null);
  assert.throws(() => f.manager.command(CHAT, OTHER, '/跑团 行动 开门'), /在册玩家/);
  assert.throws(() => f.manager.saveAsset('characters', { ...card, description: '覆盖' }, { scope: CHAT, ownerId: OTHER }), /只能编辑/);
  f.deny();
  assert.throws(() => f.manager.tool(context(f.manager), 'trpg_roll', { checkId: 'a', expression: '1d20' }), /未获授权/);
});

test('骰点有界、真实明细、同一检定重复调用和重启均不会重掷', (t) => {
  const f = fixture(t); begin(f.manager);
  assert.deepEqual(rollDice('2d6+3', () => 4), { expression: '2d6+3', rolls: [4, 4], modifier: 3, total: 11 });
  for (const expr of ['0d20', '21d20', '1d1', '1d1001', '1d20;exit']) assert.throws(() => rollDice(expr));
  const ctx = context(f.manager);
  const args = { checkId: 'door', expression: '1d20+2' };
  const a = f.manager.tool(ctx, 'trpg_roll', args);
  assert.equal(a.total, 13);
  assert.deepEqual(f.manager.tool(ctx, 'trpg_roll', args), a);
  assert.equal(f.rolls(), 1);
  assert.throws(() => f.manager.tool(ctx, 'trpg_roll', { ...args, expression: '2d20' }), /更换参数/);
  const restored = new TrpgManager({ dataDir: f.dir, getConfig: () => f.cfg, canRun: () => true, rng: () => { throw new Error('不得再次掷骰'); } });
  assert.deepEqual(restored.tool(ctx, 'trpg_roll', args), a);
});

test('状态更新乐观锁、输入校验与失败原子性，不能修改团外玩家', (t) => {
  const f = fixture(t); begin(f.manager);
  const ctx = context(f.manager);
  const rev = f.manager.current(CHAT).revision;
  const update = { checkId: 'turn', expectedRevision: rev, summary: '门锁后发现一张纸条', location: '灯塔门口', players: [{ userId: HOST, hp: 8, inventory: ['纸条'] }] };
  const result = f.manager.tool(ctx, 'trpg_update', update);
  assert.equal(result.saved, true);
  assert.equal(f.manager.current(CHAT).players[0].hp, 8);
  assert.deepEqual(f.manager.tool(ctx, 'trpg_update', update), result);
  assert.throws(() => f.manager.tool(ctx, 'trpg_update', { ...update, checkId: 'stale' }), /版本已变化/);
  const bad = { ...update, checkId: 'bad', expectedRevision: result.revision, players: [{ userId: OTHER, hp: 0 }] };
  assert.throws(() => f.manager.tool(ctx, 'trpg_update', bad), /不在本团/);
  assert.equal(f.manager.current(CHAT).revision, result.revision);
  assert.throws(() => f.manager.tool(ctx, 'trpg_update', { ...bad, players: [{ userId: HOST, hp: 1000 }] }), /HP/);
  assert.equal(f.manager.current(CHAT).players[0].hp, 8);
});

test('普通闲聊不注入跑团；旧团行动不能用于新团；暂停后工具立即失效', (t) => {
  const f = fixture(t); begin(f.manager);
  assert.equal(f.manager.narratorActive(CHAT), true);
  assert.equal(f.manager.narratorActive('private:123456'), false);
  assert.equal(f.manager.prompt(CHAT, [{ text: '你好', senderId: HOST }]), '');
  const ctx = context(f.manager);
  assert.match(f.manager.prompt(CHAT, ctx.triggerEntries), /跑团主持任务/);
  assert.equal(f.manager.prompt(CHAT, ctx.triggerEntries).includes('receipts'), false);
  f.manager.command(CHAT, HOST, '/跑团 暂停');
  assert.equal(f.manager.narratorActive(CHAT), false);
  assert.throws(() => f.manager.tool(ctx, 'trpg_state', {}), /仅可/);
  f.manager.command(CHAT, HOST, '/跑团 结束');
  assert.equal(f.manager.narratorActive(CHAT), false);
  begin(f.manager);
  const old = [{ ...ctx.triggerEntries[0], ts: 1 }];
  assert.equal(f.manager.actionContext(CHAT, old), null);
});

test('文档中的角色卡和世界观示例可直接验证并保存', (t) => {
  const f = fixture(t);
  for (const filename of ['character', 'world', 'tactical-character', 'tactical-world', 'narrative-world-with-creation']) {
    const input = JSON.parse(fs.readFileSync(new URL(`../docs/examples/trpg/${filename}.json`, import.meta.url), 'utf8'));
    const saved = f.manager.saveAsset(input.kind, input.asset);
    assert.ok(saved.id);
    assert.equal(saved.name, input.asset.name);
    assert.deepEqual(validateAsset(input.kind, saved), validateAsset(input.kind, input.asset));
  }
});

test('损坏存档拒绝覆盖；导出后仅可删除已结束的团', (t) => {
  const f = fixture(t); begin(f.manager);
  const c = f.manager.current(CHAT);
  assert.throws(() => f.manager.manageCampaign(c.id, 'delete', c.revision), /仅可删除/);
  f.manager.manageCampaign(c.id, 'end', c.revision);
  const ended = f.manager.snapshot().campaigns[0];
  assert.throws(() => f.manager.manageCampaign(c.id, 'delete', c.revision), /版本/);
  f.manager.manageCampaign(c.id, 'delete', ended.revision);
  assert.equal(f.manager.snapshot().campaigns.length, 0);
  fs.writeFileSync(f.manager.file, '{broken');
  const restored = new TrpgManager({ dataDir: f.dir, getConfig: () => f.cfg, canRun: () => true });
  assert.throws(() => restored.saveAsset('worlds', { name: 'a', description: 'b' }));
  assert.equal(fs.readFileSync(f.manager.file, 'utf8'), '{broken');
});

test('跑团独立白名单默认拒绝，群与私聊隔离，移出后停止并保留存档', (t) => {
  const f = fixture(t);
  f.cfg.trpg = { enabled: true };
  assert.throws(() => begin(f.manager), /白名单/);
  assert.equal(fs.existsSync(f.manager.file), false);
  f.cfg.trpg.allowedPrivate = ['100001'];
  assert.throws(() => begin(f.manager), /白名单/);
  f.cfg.trpg.allowedGroups = ['100001'];
  begin(f.manager);
  assert.equal(f.manager.narratorActive(CHAT), true);
  f.cfg.trpg.allowedGroups = [];
  assert.equal(f.manager.narratorActive(CHAT), false);
  assert.equal(f.manager.isAction(CHAT, HOST, '开门'), false);
  assert.throws(() => f.manager.tool(context(f.manager), 'trpg_state', {}), /白名单/);
  f.manager.command(CHAT, HOST, '暂停跑团');
  const c = f.manager.current(CHAT);
  assert.throws(() => f.manager.command(CHAT, HOST, '继续跑团'), /白名单/);
  assert.throws(() => f.manager.manageCampaign(c.id, 'resume', c.revision), /白名单/);
  f.manager.command(CHAT, HOST, '退出游戏');
  assert.equal(f.manager.current(CHAT).status, 'paused');
  f.manager.command(CHAT, HOST, '/跑团 结束');
  assert.equal(f.manager.current(CHAT), null);
  assert.equal(f.manager.snapshot().campaigns[0].status, 'ended');
  for (const bad of ['123456', ['*'], [123456], ['group:100001'], [' 100001'], ['1234']]) {
    assert.throws(() => validateTrpgPatch({ allowedGroups: bad }), /白名单/);
  }
  validateTrpgPatch({ allowedGroups: [], allowedPrivate: ['123456'] });
});

test('在册玩家普通消息在开局和重启后自动成为行动，控制指令和旁观者不成为行动', (t) => {
  const f = fixture(t);
  begin(f.manager, 'private:123456');
  assert.equal(f.manager.isAction('private:123456', HOST, '我检查门锁'), true);
  assert.equal(f.manager.isAction('private:123456', OTHER, '我检查门锁'), false);
  for (const control of ['退出游戏', '暂停跑团', '跑团状态', '/跑团 状态', '/跑团 掷骰 1d20']) {
    assert.equal(f.manager.isAction('private:123456', HOST, control), false);
  }
  const restored = new TrpgManager({ dataDir: f.dir, getConfig: () => f.cfg, canRun: () => true });
  const entries = [{ id: 100, ts: Date.now() + 1, senderId: HOST, text: '我检查门锁', eventKind: 'trpg-action' }];
  assert.match(restored.prompt('private:123456', entries), /跑团主持任务/);
  assert.equal(restored.actionContext('private:123456', [{ ...entries[0], self: true }]), null);
  restored.command('private:123456', HOST, '退出游戏');
  assert.equal(restored.isAction('private:123456', HOST, '我检查门锁'), false);
  assert.equal(restored.current('private:123456').status, 'paused');
  restored.command('private:123456', HOST, '/跑团 结束');
  assert.equal(restored.commandText('private:123456', '退出游戏'), '');
});
