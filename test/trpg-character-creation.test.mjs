import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { TrpgManager, validateAsset } from '../src/features/trpg/manager.js';

const CHAT = 'group:100001', HOST = '123456', OTHER = '234567';
function fixture(t, profile) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-world-creation-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const cfg = { trpg: { enabled: true, allowedGroups: ['100001'], allowedPrivate: ['123456'], maxPlayers: 6 } };
  const restore = () => new TrpgManager({ dataDir: dir, getConfig: () => cfg, canRun: () => true });
  const manager = restore();
  const world = manager.saveAsset('worlds', { name: '临江最后一日·万佳福超市', description: '现代末日生存。主持秘密：SECRET_UNDISCOVERED_TRUTH', opening: '你们滞留超市，门外响起警报。', ...(profile ? { characterCreation: profile } : {}) });
  let mid = 100;
  const input = (text, user = HOST, m = manager) => m.receive(CHAT, user, text, ++mid);
  const begin = (m = manager) => m.command(CHAT, HOST, '/跑团 开团 ' + world.id, ++mid);
  const finish = (user = HOST, m = manager) => { for (const s of ['阿澜', '寻找家人，与同伴互助', '2', '1']) input(s, user, m); };
  return { dir, cfg, manager, world, restore, input, begin, finish };
}

test('其他世界无需补配置即可建角，公开开场引导身份，不泄露主持真相或诡秘资源', (t) => {
  const f = fixture(t), m = f.manager;
  assert.match(f.begin().reply, /建角.*当前世界/);
  const start = m.command(CHAT, HOST, '/跑团 建角');
  assert.match(start.reply, /临江最后一日.*万佳福超市/);
  assert.match(start.reply, /滞留超市/);
  assert.doesNotMatch(start.reply, /SECRET_UNDISCOVERED_TRUTH|愚者|途径|序列9|灵性/);
  assert.equal(m.handlesInput(CHAT, HOST), true);
  f.input('超市收银员');
  f.finish();
  const c = m.current(CHAT), p = c.players[0];
  assert.equal(c.players.length, 1);
  assert.match(p.character.description, /职业\/身份：超市收银员/);
  assert.equal(p.hp, 10);
  assert.deepEqual(p.inventory, []);
  for (const k of ['pathway', 'sequence']) assert.equal(Object.hasOwn(p.character, k), false);
  assert.equal(Object.hasOwn(p, 'progress'), false);
  assert.equal(m.handlesInput(CHAT, HOST), false);
  assert.throws(() => m.command(CHAT, HOST, '/跑团 建角'), /已经加入/);
  m.command(CHAT, HOST, '/跑团 开始');
  assert.equal(m.isAction(CHAT, HOST, '检查货架'), true);
  assert.match(m.prompt(CHAT, [{ id: 1000, senderId: HOST, ts: Date.now() + 1, text: '检查货架', eventKind: 'trpg-action' }]), /超市收银员/);
});

test('世界职业菜单可分页/自填，属性物品来自开团快照，双人草稿与重启隔离', (t) => {
  const profile = { prompt: '普通现代人，无超能力。', roles: Array.from({ length: 14 }, (_, i) => `身份${i + 1}`), backgroundPrompt: '描述你为何滞留超市', hp: 8, inventory: ['手机', '矿泉水'], attributePresets: [{ name: '求生者', attributes: { 体能: 1, 观察: 2, 沟通: 0 } }] };
  const f = fixture(t, profile), m = f.manager;
  f.begin();
  const start = m.command(CHAT, HOST, '/跑团 建角');
  assert.match(start.reply, /普通现代人/);
  f.input('7'); f.input('7');
  m.command(CHAT, OTHER, '/跑团 建角');
  f.input('9', OTHER); f.input('维修工', OTHER);
  m.saveAsset('worlds', { ...f.world, characterCreation: { ...profile, roles: ['新模板身份'], hp: 20, inventory: ['新道具'] } });
  const restored = f.restore();
  assert.match(f.input('1', HOST, restored).reply, /身份13/);
  for (const [actor, name] of [[HOST, '林澜'], [OTHER, '李明']]) {
    assert.match(f.input(name, actor, restored).reply, /描述你为何滞留超市/);
    f.input('与家人失联，愿意合作求生', actor, restored);
    f.input('1', actor, restored); f.input('1', actor, restored);
  }
  const players = f.restore().current(CHAT).players;
  assert.equal(players.length, 2);
  assert.match(players[0].character.description, /身份13/);
  assert.match(players[1].character.description, /维修工/);
  for (const p of players) {
    assert.equal(p.hp, 8);
    assert.deepEqual(p.inventory, ['手机', '矿泉水']);
    assert.deepEqual(p.character.attributes, { 体能: 1, 观察: 2, 沟通: 0 });
  }
});

test('旧诡秘草稿不能串入普通世界，未绑定草稿重新提示且不把当前消息当新答案', (t) => {
  const f = fixture(t), m = f.manager;
  m.command(CHAT, HOST, '/跑团 开团');
  m.command(CHAT, HOST, '/跑团 建角'); f.input('1');
  const oldDraft = m.snapshot().wizards[`${CHAT}|${HOST}`];
  m.command(CHAT, HOST, '/跑团 结束战役'); m.command(CHAT, HOST, '/跑团 确认结束');
  assert.deepEqual(m.snapshot().wizards, {});
  f.begin();
  const data = JSON.parse(fs.readFileSync(m.file, 'utf8'));
  data.wizards[`${CHAT}|${HOST}`] = oldDraft;
  fs.writeFileSync(m.file, JSON.stringify(data));
  let restored = f.restore();
  assert.match(f.input('旧姓名', HOST, restored).reply, /重新开始建角/);
  assert.equal(restored.snapshot().wizards[`${CHAT}|${HOST}`].stage, 'role');
  assert.equal(restored.current(CHAT).players.length, 0);
  const legacy = JSON.parse(fs.readFileSync(m.file, 'utf8'));
  legacy.wizards[`${CHAT}|${OTHER}`] = { stage: 'confirm', page: 0, pathway: 'fool', name: '旧卡', background: '不应创建', style: 0, join: false };
  fs.writeFileSync(m.file, JSON.stringify(legacy));
  restored = f.restore();
  assert.match(restored.command(CHAT, OTHER, '/跑团 建角').reply, /重新开始建角/);
  assert.equal(restored.snapshot().wizards[`${CHAT}|${OTHER}`].stage, 'role');
  assert.equal(restored.snapshot().characters.some((p) => p.name === '旧卡'), false);
});

test('必须先选世界开团；取消、人数变化和开场清理不生成多余角色', (t) => {
  const f = fixture(t), m = f.manager;
  assert.throws(() => m.command(CHAT, HOST, '/跑团 建角'), /先.*开团.*世界ID/);
  assert.deepEqual(m.snapshot().wizards, {});
  f.begin(); m.command(CHAT, HOST, '/跑团 建角'); f.input('0');
  assert.equal(m.handlesInput(CHAT, HOST), false);
  for (const actor of [HOST, OTHER]) {
    m.command(CHAT, actor, '/跑团 建角');
    for (const s of ['顾客', '新角色', '合作逃生', '1']) f.input(s, actor);
  }
  f.cfg.trpg.maxPlayers = 1;
  f.input('1');
  const count = m.snapshot().characters.length;
  assert.match(f.input('1', OTHER).reply, /人数已满/);
  assert.equal(m.snapshot().characters.length, count);
  f.cfg.trpg.maxPlayers = 2;
  m.command(CHAT, OTHER, '/跑团 建角');
  m.command(CHAT, HOST, '/跑团 开始');
  assert.deepEqual(m.snapshot().wizards, {});
  assert.equal(m.handlesInput(CHAT, OTHER), false);
});

test('旧版通用世界不变；自定义建角配置严格校验，不能覆盖诡秘引擎', () => {
  const world = { name: '世界', description: '背景' };
  assert.equal(Object.hasOwn(validateAsset('worlds', world), 'characterCreation'), false);
  const bad = [null, [], { roles: ['a', 'a'] }, { roles: ['a'.repeat(61)] }, { roles: Array(31).fill('a') }, { prompt: 1 }, { hp: 0 }, { hp: 1001 }, { inventory: Array(31).fill('水') }, { script: 'ignored?' }, { attributePresets: [] }, { attributePresets: [{ name: '方案', attributes: { 体能: 11 } }] }, { attributePresets: [{ name: '方案', attributes: { '体能': 1, ' 体能': 2 } }] }];
  for (const profile of bad) assert.throws(() => validateAsset('worlds', { ...world, characterCreation: profile }));
  assert.throws(() => validateAsset('worlds', { ...world, ruleset: 'lotm-tactical-v1', characterCreation: { roles: ['保安'] } }), /固定途径/);
});

test('删除同会话旧存档不清理当前草稿；私聊建角与群聊隔离且确认重发不重复建卡', (t) => {
  const f = fixture(t), m = f.manager;
  f.begin(); m.command(CHAT, HOST, '/跑团 结束');
  const old = m.snapshot().campaigns.find((c) => c.status === 'ended');
  f.begin(); m.command(CHAT, HOST, '/跑团 建角'); f.input('顾客');
  const draft = m.snapshot().wizards[`${CHAT}|${HOST}`];
  m.manageCampaign(old.id, 'delete', old.revision);
  assert.deepEqual(m.snapshot().wizards[`${CHAT}|${HOST}`], draft);
  const privateChat = `private:${HOST}`;
  m.command(privateChat, HOST, '/跑团 开团 ' + f.world.id);
  m.command(privateChat, HOST, '/跑团 建角');
  m.receive(privateChat, HOST, '医护人员', 900);
  m.receive(privateChat, HOST, '林医生', 901);
  m.receive(privateChat, HOST, '寻找家人', 902);
  m.receive(privateChat, HOST, '1', 903);
  const confirm = m.receive(privateChat, HOST, '1', 904);
  assert.match(confirm.reply, /已加入/);
  assert.equal(m.receive(privateChat, HOST, '1', 904).duplicate, true);
  assert.equal(m.current(privateChat).players.length, 1);
  assert.match(m.current(privateChat).players[0].character.description, /医护人员/);
  assert.deepEqual(m.snapshot().wizards[`${CHAT}|${HOST}`], draft);
  assert.equal(m.current(CHAT).players.length, 0);
});
