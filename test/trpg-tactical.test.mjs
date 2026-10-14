import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { TrpgManager, validateAsset } from '../src/features/trpg/manager.js';
import { PATHWAYS, TACTICAL_RULESET, abilitiesOf, limitsOf } from '../src/features/trpg/catalog.js';
import { currentUnit, lineOfSight, pathTo, startCombat, combatAction } from '../src/features/trpg/combat.js';

const CHAT = 'group:100001', HOST = '123456', OTHER = '234567';
function fixture(t, count = 1, route = 1) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-tactical-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const cfg = { trpg: { enabled: true, allowedGroups: ['100001'], allowedPrivate: ['123456'], maxPlayers: 6 } };
  let value = 19, id = 100;
  const rng = (min, max) => Math.min(max - 1, Math.max(min, value));
  const manager = new TrpgManager({ dataDir: dir, getConfig: () => cfg, canRun: () => true, rng });
  manager.command(CHAT, HOST, '/跑团 开团', id++);
  for (const user of [HOST, OTHER].slice(0, count)) {
    manager.command(CHAT, user, '/跑团 建角', id++);
    for (const text of [String(route), `玩家${user}`, '记者，寻找失踪工人，与队伍合作', '2', '1']) manager.receive(CHAT, user, text, id++);
  }
  manager.command(CHAT, HOST, '/跑团 开始', id++);
  const input = (text, actor = HOST) => manager.receive(CHAT, actor, text, id++);
  const context = (actor = HOST, text = '观察场景') => ({ chatKey: CHAT, triggerEntries: [{ id: id++, senderId: actor, ts: Date.now() + 1, eventKind: 'trpg-action', text }] });
  const tool = (name, args, actor = HOST) => manager.tool(context(actor), name, { checkId: `check-${id}`, expectedRevision: manager.current(CHAT).revision, ...args });
  return { manager, cfg, dir, input, context, tool, rng, setRoll: (v) => { value = v; }, nextId: () => id++ };
}

test('22途径共110个序列节点，能力逐级解锁，卡片不能伪造高序列或超额属性', () => {
  assert.equal(PATHWAYS.length, 22);
  assert.equal(new Set(PATHWAYS.map((p) => p.id)).size, 22);
  const skills = PATHWAYS.flatMap((p) => p.sequences.flatMap((s) => s.abilities));
  assert.equal(skills.length, 110);
  assert.equal(new Set(skills.map((s) => s.id)).size, 110);
  for (const p of PATHWAYS) {
    assert.deepEqual(p.sequences.map((s) => s.sequence), [9, 8, 7, 6, 5]);
    assert.equal(abilitiesOf({ progress: { pathway: p.id, sequence: 5 } }).length, 5);
  }
  const card = { name: '自建', description: '调查员', hp: 10, pathway: 'fool', attributes: { 力量: 0, 敏捷: 1, 感知: 2, 交涉: 1 } };
  assert.equal(validateAsset('characters', card).sequence, 9);
  assert.throws(() => validateAsset('characters', { ...card, sequence: 5 }), /序列9/);
  assert.throws(() => validateAsset('characters', { ...card, attributes: { 力量: 2, 敏捷: 2, 感知: 2, 交涉: 2 } }), /总和/);
});

test('真实建角向导按QQ隔离，重启保留草稿，确认后自动入团且不会替换他人卡', (t) => {
  const f = fixture(t);
  assert.equal(f.manager.current(CHAT).ruleset, TACTICAL_RULESET);
  assert.equal(f.manager.current(CHAT).players[0].progress.sequence, 9);
  f.manager.command(CHAT, HOST, '退出游戏');
  f.manager.command(CHAT, OTHER, '/跑团 建角');
  f.manager.receive(CHAT, OTHER, '7', f.nextId());
  const restored = new TrpgManager({ dataDir: f.dir, getConfig: () => f.cfg, canRun: () => true });
  assert.ok(restored.handlesInput(CHAT, OTHER));
  assert.match(restored.receive(CHAT, OTHER, '1', f.nextId()).reply, /暴君/);
  for (const text of ['新水手', '装卸工，协助救人', '3', '1']) restored.receive(CHAT, OTHER, text, f.nextId());
  assert.equal(restored.current(CHAT).players.length, 2);
  assert.equal(restored.current(CHAT).players[1].progress.pathway, 'tyrant');
  assert.equal(restored.current(CHAT).players[0].character.name, `玩家${HOST}`);
});

test('探索数字按玩家与菜单绑定，并行意图统一结算，重发不再扣血或推进时间', (t) => {
  const f = fixture(t, 2);
  f.tool('trpg_options', { players: [HOST, OTHER].map((userId) => ({ userId, options: [{ label: userId === HOST ? '比对工资单' : '警戒楼梯', minutes: 10, attribute: '感知', dc: 12, risk: '失败可能轻伤', failureDamage: 1 }] })) });
  const oldId = f.manager.current(CHAT).choices[HOST].id;
  f.setRoll(1);
  assert.match(f.input('1').reply, /等待/);
  assert.equal(f.manager.current(CHAT).players[0].hp, 9);
  assert.throws(() => f.input('1'), /已提交/);
  assert.equal(f.manager.current(CHAT).players[0].hp, 9);
  const last = f.input('1', OTHER);
  assert.equal(last.narrative, true);
  const c = f.manager.current(CHAT);
  assert.equal(c.resolved[0].text, '比对工资单');
  assert.equal(c.resolved[1].text, '警戒楼梯');
  assert.equal(c.clock, 10, '同一时段并行耗时只取最大值');
  f.tool('trpg_scene', { sceneId: 'next', name: '下一场景', safe: true });
  assert.throws(() => f.input(`${oldId}:1`), /失效/);
});

test('战术资源禁止模型直接改写；规则工具版本校验及操作回执跨重启去重', (t) => {
  const f = fixture(t);
  for (const change of [{ userId: HOST, hp: 100 }, { userId: HOST, inventory: ['万能物品'] }, { userId: HOST, progress: {} }]) {
    assert.throws(() => f.tool('trpg_update', { summary: '测试', location: '码头', players: [change] }), /规则工具/);
  }
  const ctx = f.context(), args = { checkId: 'scene-once', expectedRevision: f.manager.current(CHAT).revision, sceneId: 'safe', name: '安全出口', safe: true };
  const result = f.manager.tool(ctx, 'trpg_scene', args);
  assert.deepEqual(f.manager.tool(ctx, 'trpg_scene', args), result);
  const restored = new TrpgManager({ dataDir: f.dir, getConfig: () => f.cfg, canRun: () => true });
  assert.deepEqual(restored.tool(ctx, 'trpg_scene', args), result);
  assert.throws(() => f.tool('trpg_scene', { ...args, checkId: 'stale' }), /版本/);
});

test('地图墙体、拐角、占位、距离、灵性与回合必须由程序校验，失败不落盘', (t) => {
  const f = fixture(t, 2);
  f.tool('trpg_encounter', { width: 8, height: 8, walls: ['B1', 'A2'], players: [{ userId: HOST, at: 'A1' }, { userId: OTHER, at: 'A3' }], enemies: [{ name: '守卫', at: 'H8', attack: -1, hp: 8 }] });
  const c = f.manager.current(CHAT), b = c.combat;
  assert.equal(lineOfSight(b, { x: 0, y: 0 }, { x: 1, y: 1 }), false);
  assert.equal(pathTo(b, b.units[0], { x: 2, y: 0 }, 3), null);
  const actor = currentUnit(c).userId, other = actor === HOST ? OTHER : HOST;
  assert.throws(() => f.input('1', other), /还没轮到/);
  const before = JSON.stringify(f.manager.current(CHAT));
  f.input('我攻击遥远的守卫', actor);
  const ctx = f.context(actor, '我攻击遥远的守卫');
  const pending = f.manager.current(CHAT).pendingCombat;
  ctx.triggerEntries[0].id = Number(pending.messageId);
  assert.throws(() => f.manager.tool(ctx, 'trpg_battle_action', { checkId: 'far', expectedRevision: f.manager.current(CHAT).revision, action: { kind: 'attack', target: 'e:1' } }), /距离|视线/);
  assert.equal(f.manager.current(CHAT).combat.units[0].main, JSON.parse(before).combat.units[0].main);
});

test('真实攻击、掩体、消耗行动、敌方回合和胜负结算可恢复', (t) => {
  const f = fixture(t);
  f.tool('trpg_encounter', { players: [{ userId: HOST, at: 'A1' }], cover: [{ at: 'B1', value: 1 }], enemies: [{ name: '守卫', at: 'B1', hp: 8, attack: -1, defense: 10 }] });
  const c = f.manager.current(CHAT);
  assert.equal(currentUnit(c).userId, HOST);
  const first = combatAction(c, HOST, { kind: 'attack', target: 'e:1' }, f.rng);
  assert.match(first, /真实|d20=/);
  assert.throws(() => combatAction(c, HOST, { kind: 'attack', target: 'e:1' }), /行动已用完|目标无效/);
  assert.equal(c.combat.units[0].main, 0);
  assert.ok(c.combat.units[1].hp < 8);
  combatAction(c, HOST, { kind: 'end' }, f.rng);
  assert.equal(c.combat.round, 2);
  assert.equal(c.players[0].hp, 8, '敌人使用配置的伤害，不暗增伤害');
});

test('110个已定义能力均能执行对应效果并扣除资源，不产生越界HP或重复行动', (t) => {
  const f = fixture(t);
  for (const route of PATHWAYS) for (const sequence of route.sequences) {
    const c = f.manager.current(CHAT), p = c.players[0], s = sequence.abilities[0];
    p.progress.pathway = route.id; p.progress.sequence = sequence.sequence; p.hp = 5;
    startCombat(c, { cover: [{ at: 'A1', value: 1 }], objects: s.effect === 'phase' ? [{ at: 'B1', kind: 'door', label: '普通门' }] : [],
      enemies: [{ name: '测试对手', at: s.effect === 'phase' ? 'D1' : 'B1', hp: 40, attack: -1 }] }, f.rng);
    c.combat.lastAttack = { source: 'e:1', damage: 1 };
    const target = ['ward', 'buff', 'heal', 'cleanse', 'hide', 'insight', 'dash'].includes(s.effect) ? `p:${HOST}` : 'e:1';
    combatAction(c, HOST, { kind: 'ability', ability: s.id, at: 'C1', target, confirmFriendlyFire: true }, f.rng);
    assert.equal(p.progress.spirit, 6 - s.cost, s.id);
    assert.ok(c.combat.units.every((u) => u.hp >= 0 && u.hp <= u.maxHp), s.id);
    assert.equal(c.combat.units[0][s.action === '辅助' ? 'bonus' : 'main'], 0, s.id);
  }
});

test('防御跨过自己的结束回合，失控立即限行动，倒地占位不能用物品复活', (t) => {
  const f = fixture(t, 2), c = f.manager.current(CHAT);
  const deterministic = (min, max) => max === 21 ? 12 : max - 1;
  startCombat(c, { players: [{ userId: HOST, at: 'A1' }, { userId: OTHER, at: 'A2' }], enemies: [{ name: '守卫', at: 'B1', hp: 40, attack: -1 }] }, f.rng);
  combatAction(c, HOST, { kind: 'defend' }, deterministic);
  combatAction(c, HOST, { kind: 'end' }, deterministic);
  combatAction(c, OTHER, { kind: 'end' }, deterministic);
  assert.equal(c.players[0].hp, 10, '敌人攻击合计11，防御加值应使攻击未命中');
  assert.ok(c.combat.units[0].effects.some((e) => e.type === 'ward'));
  c.players[0].progress.pollution = 5; c.players[0].progress.overuse = 3;
  combatAction(c, HOST, { kind: 'ability', ability: 'fool-9' }, f.rng);
  assert.equal(c.players[0].progress.pollution, 6);
  assert.equal(currentUnit(c).main, 0);
  assert.equal(currentUnit(c).remaining, 1);
  const ally = c.combat.units[1], enemy = c.combat.units[2];
  ally.hp = 0; enemy.at = { ...ally.at }; currentUnit(c).bonus = 1;
  const count = c.players[0].inventory.length;
  assert.throws(() => combatAction(c, HOST, { kind: 'item', item: '绷带', target: ally.id }, f.rng), /占用/);
  assert.equal(ally.hp, 0);
  assert.equal(c.players[0].inventory.length, count);
});

test('安全休整需全员同意，资源有上限且同一游戏日最多净化2点', (t) => {
  const f = fixture(t, 2);
  f.tool('trpg_scene', { sceneId: 'safe', name: '安全休整', safe: true });
  for (const actor of [HOST, OTHER]) f.manager.command(CHAT, actor, '/跑团 休整');
  assert.match(f.input('1').reply, /等待全体/);
  assert.equal(f.manager.current(CHAT).clock, 0);
  assert.match(f.input('1', OTHER).reply, /休整1游戏小时/);
  assert.equal(f.manager.current(CHAT).clock, 60);
  assert.equal(f.manager.current(CHAT).players[0].progress.spirit, 6);
});

test('主持结算期间不会被后续消息覆盖，恢复结算不重掷，自由战斗意图可取消重选', (t) => {
  const f = fixture(t);
  f.tool('trpg_scene', { sceneId: 'safe', name: '安全处', safe: true, journal: [{ id: 'previous', text: '已完成的前置任务', status: 'done' }] });
  f.input('检查工资单');
  const c = f.manager.current(CHAT);
  assert.throws(() => f.input('1'), /等待裁判结算/);
  assert.throws(() => f.manager.command(CHAT, HOST, '/跑团 下一章'), /待结算/);
  assert.deepEqual(f.manager.current(CHAT).resolved, c.resolved);
  assert.equal(f.input('继续结算').narrative, true);
  f.tool('trpg_check', { userId: HOST, attribute: '感知', dc: 12, minutes: 10 });
  const roll = f.manager.current(CHAT).resolved[0].roll;
  f.input('继续结算');
  assert.deepEqual(f.manager.current(CHAT).resolved[0].roll, roll);
  assert.throws(() => f.tool('trpg_check', { userId: HOST, attribute: '感知', dc: 12, minutes: 10 }), /已结算/);
  f.tool('trpg_update', { summary: '已核对工资单，下一步进入仓库。', location: '仓库' });
  f.tool('trpg_encounter', { enemies: [{ name: '守卫', at: 'H8', hp: 8, attack: -1 }] });
  assert.equal(f.input('向前移动').narrative, true);
  assert.throws(() => f.input('3'), /仍待裁判/);
  f.input('继续结算');
  const pending = f.manager.current(CHAT).pendingCombat;
  const ctx = f.context(); ctx.triggerEntries[0].id = Number(pending.messageId);
  f.manager.tool(ctx, 'trpg_battle_action', { checkId: 'recovery', expectedRevision: f.manager.current(CHAT).revision, action: { kind: 'move', at: 'B1' } });
  assert.deepEqual(currentUnit(f.manager.current(CHAT)).at, { x: 1, y: 0 });
  f.input('再往前走');
  f.manager.command(CHAT, HOST, '/跑团 菜单');
  assert.equal(f.manager.current(CHAT).pendingCombat, null);
  assert.equal(currentUnit(f.manager.current(CHAT)).remaining, 2);
});

test('同一入站消息跨重启不重复移动或消耗，正式结束与场外指令不扩权', (t) => {
  const f = fixture(t);
  f.tool('trpg_encounter', { enemies: [{ name: '远处敌人', at: 'H8', hp: 8, attack: -1 }] });
  const id = f.nextId();
  f.manager.receive(CHAT, HOST, '3', id);
  const next = f.nextId();
  f.manager.receive(CHAT, HOST, '1', next);
  const before = f.manager.current(CHAT);
  const restored = new TrpgManager({ dataDir: f.dir, getConfig: () => f.cfg, canRun: () => true });
  assert.equal(restored.receive(CHAT, HOST, '1', next).duplicate, true);
  assert.deepEqual(restored.current(CHAT).combat, before.combat);
  assert.throws(() => restored.receive(CHAT, HOST, '2', next), /同一消息/);
  const ctx = f.context(HOST, '场外：问个规则');
  assert.throws(() => f.manager.tool(ctx, 'trpg_scene', { checkId: 'ooc', expectedRevision: f.manager.current(CHAT).revision, sceneId: 'fake', name: '跳过战斗', safe: true }), /场外/);
});

test('自由探索检定与穿门执行真实消耗，已有结果不能换checkId重掷', (t) => {
  const f = fixture(t, 1, 3);
  f.input('我接受可能轻伤的风险，检查门锁'); f.setRoll(1);
  const result = f.tool('trpg_check', { userId: HOST, attribute: '感知', dc: 12, minutes: 15, failureDamage: 2 });
  assert.match(result.result, /失败/);
  assert.equal(f.manager.current(CHAT).players[0].hp, 8);
  assert.equal(f.manager.current(CHAT).clock, 15);
  assert.throws(() => f.tool('trpg_check', { userId: HOST, attribute: '感知', dc: 12, minutes: 15 }), /已结算/);
  f.tool('trpg_update', { summary: '门锁已检查，角色受轻伤，准备选择其他方法。', location: '仓库门前' });
  f.input('我使用穿门，前往已经看清的门后走廊'); f.setRoll(19);
  const args = { userId: HOST, ability: 'door-9', ordinaryDoor: true, doorThicknessCm: 21, destinationKnown: true, destination: '门后走廊' };
  assert.throws(() => f.tool('trpg_explore', args), /20厘米/);
  assert.equal(f.manager.current(CHAT).players[0].progress.spirit, 6);
  assert.match(f.tool('trpg_explore', { ...args, doorThicknessCm: 10 }).result, /到达门后走廊/);
  assert.equal(f.manager.current(CHAT).players[0].progress.spirit, 4);
  assert.throws(() => f.tool('trpg_explore', { ...args, doorThicknessCm: 10 }), /已经结算/);
});

test('远程攻击消耗实际弹药，撤离不伪造胜利，全队倒地仍可求援恢复战役', (t) => {
  const f = fixture(t);
  const c = f.manager.current(CHAT);
  c.players[0].inventory.push('左轮手枪', '子弹');
  startCombat(c, { enemies: [{ name: '强敌', at: 'D1', hp: 40, attack: -1 }] }, f.rng);
  combatAction(c, HOST, { kind: 'attack', weapon: 'ranged', target: 'e:1' }, f.rng);
  assert.equal(c.players[0].inventory.includes('子弹'), false);
  combatAction(c, HOST, { kind: 'end' }, f.rng);
  assert.throws(() => combatAction(c, HOST, { kind: 'attack', weapon: 'ranged', target: 'e:1' }, f.rng), /子弹/);
  assert.equal(currentUnit(c).main, 1);
  const escape = f.manager.current(CHAT);
  startCombat(escape, { enemies: [{ name: '远敌', at: 'H8', hp: 8, attack: -1 }] }, f.rng);
  combatAction(escape, HOST, { kind: 'retreat' }, f.rng);
  assert.equal(escape.combat.status, 'retreated');
  f.tool('trpg_encounter', { enemies: [{ name: '压倒性敌人', at: 'B1', hp: 40, attack: 5, damage: 5 }] });
  assert.equal(f.manager.current(CHAT).players[0].hp, 5);
  f.input('结束回合');
  assert.equal(f.manager.current(CHAT).combat.status, 'defeated');
  const menu = f.manager.current(CHAT).choices[HOST].id;
  assert.equal(f.input(`${menu}:1`).narrative, true);
  assert.equal(f.manager.current(CHAT).players[0].hp, 1);
  assert.equal(f.manager.current(CHAT).combat.status, 'rescued');
});

test('暂离不阻塞其他玩家，归队保留角色；NPC关系与能力说明进入持久上下文', (t) => {
  const f = fixture(t, 2);
  f.input('1');
  assert.equal(f.manager.command(CHAT, OTHER, '/跑团 暂离', f.nextId()).narrative, true);
  assert.equal(f.manager.current(CHAT).players[1].away, true);
  assert.equal(f.manager.current(CHAT).resolved.length, 1);
  f.tool('trpg_scene', { sceneId: 'safe', name: '互助会', safe: true, npcs: [{ id: 'peggy', name: '佩姬', location: '茶棚', attitude: 1, notes: '调查员帮助了工人，愿意合作' }] });
  f.manager.command(CHAT, OTHER, '/跑团 归队');
  const restored = new TrpgManager({ dataDir: f.dir, getConfig: () => f.cfg, canRun: () => true });
  assert.equal(restored.current(CHAT).players[1].progress.sequence, 9);
  assert.equal(restored.current(CHAT).npcs[0].attitude, 1);
  assert.match(restored.prompt(CHAT, f.context().triggerEntries), /fool-9/);
});

test('多次看护休整不越过每天2点净化上限', (t) => {
  const f = fixture(t);
  for (let i = 0; i < 6; i++) {
    f.manager.command(CHAT, HOST, '/跑团 能力');
    f.input('1');
    f.tool('trpg_update', { summary: '已执行一次观察并保存真实资源，等待玩家。', location: '码头' });
  }
  assert.equal(f.manager.current(CHAT).players[0].progress.pollution, 3);
  f.tool('trpg_scene', { sceneId: 'rest', name: '安全处', safe: true, clockPaused: true });
  for (let i = 0; i < 3; i++) { f.manager.command(CHAT, HOST, '/跑团 休整'); f.input('1'); }
  assert.equal(f.manager.current(CHAT).players[0].progress.pollution, 1);
  assert.equal(f.manager.current(CHAT).players[0].progress.cleanseUsed, 2);
});

test('成长需真实记录、配方材料、安全与本人确认，四次晋升后锁定序列5', (t) => {
  const f = fixture(t);
  assert.throws(() => { f.manager.command(CHAT, HOST, '/跑团 晋升'); f.input('1'); }, /安全|条件/);
  for (let next = 8; next >= 5; next--) {
    const needed = limitsOf(f.manager.current(CHAT).players[0]).digestion;
    for (let j = 0; j < needed; j++) {
      const scene = `s-${next}-${j}`, event = `event-${next}-${j}`;
      f.tool('trpg_scene', { sceneId: scene, name: '完成冒险后的安全地', safe: true, journal: [{ id: event, text: '基于证据修正判断并帮助受害者', status: 'done' }] });
      f.tool('trpg_reward', { userId: HOST, eventId: event, evidence: '有实际风险的扮演，承认占卜边界并核对证据', kind: 'digestion' });
      assert.throws(() => f.tool('trpg_reward', { userId: HOST, eventId: event, evidence: '重复', kind: 'digestion' }), /已发放|已奖励|上限/);
      if (j % 2 === 1) f.manager.command(CHAT, HOST, '/跑团 下一章');
    }
    for (const kind of ['recipe', 'material', ...(next === 5 ? ['ritual'] : [])]) f.tool('trpg_reward', { userId: HOST, eventId: `event-${next}-${needed - 1}`, evidence: '完成当前组织委托并取得相应准备', kind, sequence: next });
    f.manager.command(CHAT, HOST, '/跑团 晋升');
    assert.match(f.input('1').reply, new RegExp(`晋升序列${next}`));
    assert.equal(f.manager.current(CHAT).players[0].progress.sequence, next);
    assert.equal(abilitiesOf(f.manager.current(CHAT).players[0]).length, 10 - next);
  }
  f.manager.command(CHAT, HOST, '/跑团 晋升');
  assert.throws(() => f.input('1'), /条件|上限/);
  assert.equal(f.manager.current(CHAT).players[0].progress.sequence, 5);
});

test('退出保存暂停，正式结团须团主二次确认，战斗/成长状态跨重启保持', (t) => {
  const f = fixture(t);
  f.manager.command(CHAT, HOST, '退出游戏');
  const before = f.manager.current(CHAT);
  assert.equal(before.status, 'paused');
  const restored = new TrpgManager({ dataDir: f.dir, getConfig: () => f.cfg, canRun: () => true });
  restored.command(CHAT, HOST, '继续跑团', f.nextId());
  assert.deepEqual(restored.current(CHAT).players, before.players);
  restored.command(CHAT, HOST, '结束战役');
  assert.equal(restored.current(CHAT).status, 'playing');
  assert.throws(() => restored.command(CHAT, OTHER, '/跑团 确认结束'), /团主/);
  restored.command(CHAT, HOST, '/跑团 确认结束');
  assert.equal(restored.current(CHAT), null);
});

test('v1存档首次写入前自动备份，旧团不自动转换或清空，禁用不触盘', (t) => {
  const f = fixture(t);
  const old = f.manager.snapshot();
  old.version = 1; delete old.wizards; delete old.settings;
  old.campaigns[0].ruleset = undefined; delete old.campaigns[0].players[0].progress;
  fs.writeFileSync(f.manager.file, JSON.stringify(old));
  const raw = fs.readFileSync(f.manager.file, 'utf8');
  const restored = new TrpgManager({ dataDir: f.dir, getConfig: () => f.cfg, canRun: () => true });
  restored.snapshot();
  assert.equal(fs.readFileSync(f.manager.file, 'utf8'), raw);
  restored.command(CHAT, HOST, '/跑团 暂停');
  const backups = fs.readdirSync(path.dirname(f.manager.file)).filter((f) => f.includes('.v1-'));
  assert.equal(backups.length, 1);
  assert.equal(fs.readFileSync(path.join(path.dirname(f.manager.file), backups[0]), 'utf8'), raw);
  assert.equal(JSON.parse(fs.readFileSync(f.manager.file, 'utf8')).version, 2);
  assert.equal(restored.current(CHAT).ruleset, undefined);
});
