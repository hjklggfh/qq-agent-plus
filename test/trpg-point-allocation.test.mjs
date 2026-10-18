import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { TrpgManager, validateAsset } from '../src/features/trpg/manager.js';
import { parseAllocation, validateAllocation } from '../src/features/trpg/attribute-allocation.js';
import { BUILD_STYLES } from '../src/features/trpg/catalog.js';

const CHAT = 'group:100001', HOST = '123456', OTHER = '234567';
const tenPoints = { attributes: ['力量', '敏捷', '防御'], points: 10, min: 0, max: 10 };
function setup(t, profile, name = '临江最后一日·万佳福超市【完整剧本·含剧透】') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-point-allocation-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const cfg = { trpg: { enabled: true, allowedGroups: ['100001'], allowedPrivate: [], maxPlayers: 6 } };
  const restore = () => new TrpgManager({ dataDir: dir, getConfig: () => cfg, canRun: () => true });
  const m = restore();
  const world = m.saveAsset('worlds', { name, description: '本案真相保密，不放进建角提示。', opening: '你们滞留在建筑里。', ...(profile ? { characterCreation: profile } : {}) });
  m.command(CHAT, HOST, '/跑团 开团 ' + world.id);
  let mid = 100;
  const input = (text, user = HOST, manager = m) => manager.receive(CHAT, user, text, ++mid);
  const prepare = (user = HOST) => { m.command(CHAT, user, '/跑团 建角'); for (const text of ['顾客', '林澜', '与队友合作逃生']) input(text, user); };
  return { m, dir, world, restore, input, prepare };
}

test('已导入的临江旧世界和旧快照直接使用力量敏捷防御10点，保存和重启不回到四属性', (t) => {
  const f = setup(t);
  const copied = setup(t, { attributePresets: structuredClone(BUILD_STYLES) });
  copied.prepare();
  assert.equal(copied.m.snapshot().wizards[`${CHAT}|${HOST}`].stage, 'allocation');
  assert.deepEqual(f.m.snapshot().worlds.find((w) => w.id === f.world.id).characterCreation.attributeAllocation, tenPoints);
  f.prepare();
  const draft = () => f.m.snapshot().wizards[`${CHAT}|${HOST}`];
  assert.equal(draft().stage, 'allocation');
  const panel = f.m.command(CHAT, HOST, '/跑团 建角').reply;
  assert.match(panel, /自由分配属性点[\s\S]*力量[\s\S]*敏捷[\s\S]*防御[\s\S]*10点/);
  assert.doesNotMatch(panel, /感知|交涉|均衡|序列9/);
  const before = fs.readFileSync(f.m.file, 'utf8');
  for (const bad of ['4 3 2', '4 3 4', '-1 5 6', '11 0 -1', '4.5 2.5 3', '力量4 敏捷3 感知3', '力量4力量3防御3']) assert.throws(() => f.input(bad));
  assert.equal(fs.readFileSync(f.m.file, 'utf8'), before);
  assert.match(f.input('力量4 敏捷3 防御3').reply, /自由分配10点：力量4、敏捷3、防御3/);
  const restored = f.restore();
  assert.match(f.input('1', HOST, restored).reply, /已加入/);
  const p = f.restore().current(CHAT).players[0];
  assert.deepEqual(p.character.attributes, { 力量: 4, 敏捷: 3, 防御: 3 });
  assert.equal(Object.hasOwn(p, 'progress'), false);
  restored.command(CHAT, HOST, '/跑团 开始');
  assert.match(restored.prompt(CHAT, [{ id: 1000, senderId: HOST, ts: Date.now() + 1, text: '行动', eventKind: 'trpg-action' }]), /attributeAllocation/);
});

test('不同世界独立使用各自属性、总点数及上下限，显式固定方案或禁用配置优先', (t) => {
  const profile = { hp: 8, inventory: ['急救包'], attributeAllocation: { attributes: ['学识', '意志'], points: 6, min: 1, max: 5 } };
  const f = setup(t, profile, '星际旅途');
  f.prepare();
  assert.throws(() => f.input('0 6'), /1—5/);
  f.input('1 5');
  assert.match(f.input('3').reply, /学识[\s\S]*意志/);
  f.input('{"学识":2,"意志":4}'); f.input('1');
  const p = f.m.current(CHAT).players[0];
  assert.deepEqual(p.character.attributes, { 学识: 2, 意志: 4 });
  assert.equal(p.hp, 8); assert.deepEqual(p.inventory, ['急救包']);
  const explicit = setup(t, { attributePresets: [{ name: '原世界方案', attributes: { 体能: 2 } }] });
  explicit.prepare(); assert.equal(explicit.m.snapshot().wizards[`${CHAT}|${HOST}`].stage, 'style');
  const disabled = setup(t, { attributeAllocation: null });
  disabled.prepare(); assert.equal(disabled.m.snapshot().wizards[`${CHAT}|${HOST}`].stage, 'confirm');
  disabled.input('1'); assert.deepEqual(disabled.m.current(CHAT).players[0].character.attributes, {});
});

test('升级前临江草稿在方案/确认步骤转入自由加点，保留人物背景且不误消费回复', (t) => {
  const f = setup(t);
  const data = JSON.parse(fs.readFileSync(f.m.file, 'utf8'));
  data.wizards[`${CHAT}|${HOST}`] = { campaignId: f.m.current(CHAT).id, worldId: f.world.id, ruleset: 'narrative', stage: 'confirm', page: 0,
    profile: {}, role: '收银员', name: '原姓名', background: '原背景', style: 1 };
  fs.writeFileSync(f.m.file, JSON.stringify(data));
  const restored = f.restore();
  assert.match(f.input('1', HOST, restored).reply, /已同步本世界属性规则/);
  const w = restored.snapshot().wizards[`${CHAT}|${HOST}`];
  assert.equal(w.stage, 'allocation'); assert.equal(w.name, '原姓名'); assert.equal(w.background, '原背景');
  assert.equal(restored.current(CHAT).players.length, 0);
  f.input('4 3 3', HOST, restored); f.input('1', HOST, restored);
  assert.equal(restored.current(CHAT).players[0].character.name, '原姓名');
});

test('团主设置当前世界加点规则，旧角色本人重分而不丢HP物品，不能绕过入团或开局校验', (t) => {
  const f = setup(t, { hp: 9, inventory: ['手机'], attributePresets: [{ name: '旧方案', attributes: { 力量: 0, 敏捷: 1, 感知: 2, 交涉: 1 } }] }, '其他世界');
  f.prepare(); f.input('1'); f.input('1');
  const before = f.m.current(CHAT).players[0];
  assert.throws(() => f.m.command(CHAT, OTHER, '/跑团 设置加点 力量 敏捷 防御 | 10'), /团主/);
  f.m.command(CHAT, HOST, '/跑团 设置加点 力量 敏捷 防御 | 10');
  assert.throws(() => f.m.command(CHAT, HOST, '/跑团 开始'), /重新加点/);
  assert.throws(() => f.m.command(CHAT, OTHER, '/跑团 加入 traveler'), /本世界只使用/);
  f.m.command(CHAT, HOST, '/跑团 重新加点');
  f.input('4 3 3'); f.input('1');
  const after = f.m.current(CHAT).players[0];
  assert.equal(after.character.id, before.character.id); assert.equal(after.character.name, before.character.name);
  assert.equal(after.character.description, before.character.description); assert.equal(after.hp, before.hp); assert.deepEqual(after.inventory, before.inventory);
  assert.deepEqual(after.character.attributes, { 力量: 4, 敏捷: 3, 防御: 3 });
  assert.equal(f.m.current(CHAT).players.length, 1);
  f.m.command(CHAT, HOST, '/跑团 开始');
  assert.throws(() => f.m.command(CHAT, HOST, '/跑团 重新加点'), /待开始或已暂停/);
  f.m.command(CHAT, HOST, '/跑团 暂停');
  f.m.command(CHAT, HOST, '/跑团 设置加点 力量 敏捷 防御 | 9');
  assert.throws(() => f.m.command(CHAT, HOST, '/跑团 继续'), /重新加点/);
  const invalid = f.m.current(CHAT);
  assert.throws(() => f.m.manageCampaign(invalid.id, 'resume', invalid.revision), /重新加点/);
  f.m.command(CHAT, HOST, '/跑团 设置加点 力量 敏捷 防御 | 10');
  f.m.command(CHAT, HOST, '/跑团 重新加点');
  f.input('6 2 2');
  assert.throws(() => f.m.command(CHAT, HOST, '/跑团 继续'), /待确认/);
  const pending = f.m.current(CHAT);
  assert.throws(() => f.m.manageCampaign(pending.id, 'resume', pending.revision), /待确认/);
  const restored = f.restore();
  f.input('1', HOST, restored);
  restored.command(CHAT, HOST, '/跑团 继续');
  assert.equal(restored.current(CHAT).status, 'playing');
  assert.equal(restored.current(CHAT).players[0].hp, before.hp);
  assert.deepEqual(restored.current(CHAT).players[0].inventory, before.inventory);
});

test('点数规则及输入严格校验，名称前缀、零值、JSON与命名格式可正确分配', () => {
  const raw = { name: '世界', description: '背景' };
  for (const rule of [null, [], { attributes: [], points: 10 }, { attributes: ['a', 'a'], points: 10 }, { attributes: ['a'], points: 11, max: 10 }, { attributes: ['a'], points: 0 }, { attributes: ['a'], points: 5, min: 6 }, { attributes: ['a'], points: 5, max: 11 }, { attributes: ['__proto__'], points: 5 }, { attributes: ['a'], points: 5, extra: true }]) assert.throws(() => validateAllocation(rule));
  assert.throws(() => validateAsset('worlds', { ...raw, characterCreation: { attributeAllocation: tenPoints, attributePresets: [{ name: '方案', attributes: { a: 1 } }] } }), /不能同时/);
  const rule = validateAllocation({ attributes: ['力', '力量'], points: 10 });
  assert.deepEqual(parseAllocation('力量=10 力=0', rule), { 力: 0, 力量: 10 });
  assert.deepEqual(parseAllocation('0,10', rule), { 力: 0, 力量: 10 });
  for (const bad of ['1e1 0', '1.0 9', '{"力":5,"力量":5,"额外":0}', '{"力":5}', '力5力5', '力5力量5x', '[5,5]']) assert.throws(() => parseAllocation(bad, rule));
});

test('多人自由加点草稿隔离，取消和重新加点不修改其他玩家；同一确认不重复创建', (t) => {
  const f = setup(t);
  f.prepare(HOST); f.prepare(OTHER);
  f.input('4 3 3'); f.input('2 5 3', OTHER);
  const otherDraft = f.m.snapshot().wizards[`${CHAT}|${OTHER}`];
  f.input('3'); f.input('6 2 2');
  assert.deepEqual(f.m.snapshot().wizards[`${CHAT}|${OTHER}`], otherDraft);
  const id = 5000;
  f.m.receive(CHAT, HOST, '1', id);
  assert.equal(f.m.receive(CHAT, HOST, '1', id).duplicate, true);
  f.input('1', OTHER);
  const players = f.m.current(CHAT).players;
  assert.equal(players.length, 2);
  assert.deepEqual(players[0].character.attributes, { 力量: 6, 敏捷: 2, 防御: 2 });
  assert.deepEqual(players[1].character.attributes, { 力量: 2, 敏捷: 5, 防御: 3 });
  f.m.command(CHAT, HOST, '/跑团 重新加点'); f.input('0');
  assert.deepEqual(f.m.current(CHAT).players, players);
});
