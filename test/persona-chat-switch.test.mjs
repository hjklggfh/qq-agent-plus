import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

// 必须在 import 业务模块之前指定数据目录：config-legacy 在模块求值时读取该环境变量。
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'persona-chat-switch-'));
process.env.QQ_AGENT_DATA_DIR = dataDir;

const {
  matchSwitchRequest, stripSwitchTags, activateChatProfile, resolveChatProfile,
  touchAltProfile, personaSwitchConfig, altPersonaReady, activeAltChats, clearChatProfile
} = await import('../src/core/persona-switch.js');

process.on('exit', () => { try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ } });

const settings = personaSwitchConfig({
  enabled: true,
  idleMinutes: 30,
  cooldownSeconds: 0,
  altModel: 'claude-sonnet-5-5-low',
  altRoleText: '你是克劳德',
  altName: 'Claude'
});
const T0 = 1_700_000_000_000;
const MIN = 60_000;

test('触发识别：要关键词 + 呼叫语境，闲聊提到模型名不触发', () => {
  assert.equal(matchSwitchRequest('呼叫克劳德出来', { settings }), 'alt');
  assert.equal(matchSwitchRequest('叫哈基米回来', { settings }), 'home');
  assert.equal(matchSwitchRequest('克劳德', { mention: true, settings }), 'alt');
  assert.equal(matchSwitchRequest('Claude 的上下文比 Gemini 长', { settings }), null);
  assert.equal(matchSwitchRequest('叫克劳德还是叫哈基米', { settings }), null);
  assert.equal(matchSwitchRequest('', { settings }), null);
});

// 2026-11-07 线上故障：默认人设名字叫「Gemi本咪」，@ 的文本里带着它 → 同时命中 home(gemi) 与
// alt(claude)，被"拿不准不切"判死，表现为怎么叫都不切换。修法：先把机器人自己的名字剔掉再匹配。
test('触发识别：@ 文本里带着机器人名字（Gemi本咪）时仍能切到第二人设', () => {
  const ignore = ['Gemi本咪', 'Gemini'];
  // 不带 ignore：复现故障 —— 同时命中两边，不切
  assert.equal(matchSwitchRequest('@Gemi本咪 让Claude出来逛逛', { mention: true, settings }), null);
  assert.equal(matchSwitchRequest('@Gemi本咪 呼叫克劳德', { mention: true, settings }), null);
  // 带 ignore：只剩 alt
  assert.equal(matchSwitchRequest('@Gemi本咪 让Claude出来逛逛', { mention: true, settings, ignore }), 'alt');
  assert.equal(matchSwitchRequest('@Gemi本咪 呼叫克劳德', { mention: true, settings, ignore }), 'alt');
  assert.equal(matchSwitchRequest('@Gemi本咪 切换Claude模式', { mention: true, settings, ignore }), 'alt');
  // 只有 @、没提任何人设 → 不切（以前会被误判成切 home）
  assert.equal(matchSwitchRequest('@Gemi本咪 在吗', { mention: true, settings, ignore }), null);
  assert.equal(matchSwitchRequest('@Gemi本咪', { mention: true, settings, ignore }), null);
  // 叫回默认人设的词没被误伤
  assert.equal(matchSwitchRequest('@Gemi本咪 叫哈基米回来', { mention: true, settings, ignore }), 'home');
  // 两边都真提到（不是自己的名字）时仍然不切
  assert.equal(matchSwitchRequest('@Gemi本咪 叫克劳德还是叫哈基米', { mention: true, settings, ignore }), null);
});

// 对称的坑：第二人设值班时群名片就是「Claude」，@ 的文本里带着它 → 同时命中两边。
// 值班期间把第二人设的名字也剔掉，才能用 @ 叫回默认人设。
test('触发识别：第二人设值班时 @Claude 叫回默认人设也能生效', () => {
  const onDutyIgnore = ['Gemi本咪', 'Gemini', 'Claude'];
  assert.equal(matchSwitchRequest('@Claude 叫哈基米回来', { mention: true, settings, ignore: onDutyIgnore }), 'home');
  assert.equal(matchSwitchRequest('@Claude 回来吧', { mention: true, settings, ignore: onDutyIgnore }), null, '没提任何人设 → 不切');
  // 值班期间再叫一次自己：剔掉名字后还剩「呼叫克劳德」→ 仍然是 alt（刷新计时）
  assert.equal(matchSwitchRequest('@Claude 呼叫克劳德', { mention: true, settings, ignore: onDutyIgnore }), 'alt');
});

test('控制标签会被剥离，普通文本原样返回', () => {
  assert.deepEqual(stripSwitchTags('这里交还给猫。[SWITCH_TO_GEMINI]'), { text: '这里交还给猫。', switchTo: 'home' });
  assert.deepEqual(stripSwitchTags('  [switch_to_gemini]  '), { text: '', switchTo: 'home' });
  assert.deepEqual(stripSwitchTags('正常的一句话'), { text: '正常的一句话', switchTo: null });
});

test('第二人设未配置正文或模型时不生效', () => {
  const empty = personaSwitchConfig({ enabled: true, altModel: '', altRoleText: '' });
  assert.equal(altPersonaReady(empty), false);
  assert.equal(resolveChatProfile('group:1', T0, empty).profile, 'home');
});

test('按会话切换、最后一次发言后 30 分钟过期', () => {
  const chat = 'group:123';
  assert.equal(resolveChatProfile(chat, T0, settings).profile, 'home');
  assert.equal(activateChatProfile(chat, 'alt', T0, settings).changed, true);
  assert.equal(resolveChatProfile(chat, T0 + 10 * MIN, settings).profile, 'alt');
  touchAltProfile(chat, T0 + 20 * MIN);
  assert.equal(resolveChatProfile(chat, T0 + 40 * MIN, settings).profile, 'alt');
  assert.equal(resolveChatProfile(chat, T0 + 51 * MIN, settings).profile, 'home');
  assert.equal(resolveChatProfile(chat, T0 + 52 * MIN, settings).profile, 'home');
});

test('会话之间互不影响', () => {
  activateChatProfile('group:a', 'alt', T0, settings);
  assert.equal(resolveChatProfile('group:a', T0 + MIN, settings).profile, 'alt');
  assert.equal(resolveChatProfile('group:b', T0 + MIN, settings).profile, 'home');
  const active = activeAltChats(T0 + MIN).map((item) => item.chatKey);
  assert.ok(active.includes('group:a'));
  assert.ok(!active.includes('group:b'));
  clearChatProfile('group:a');
  assert.equal(resolveChatProfile('group:a', T0 + MIN, settings).profile, 'home');
});

test('冷却时间内的反复切换被拒绝', () => {
  const cool = personaSwitchConfig({ ...settings, cooldownSeconds: 120 });
  const chat = 'group:cool';
  assert.equal(activateChatProfile(chat, 'alt', T0, cool).changed, true);
  assert.equal(activateChatProfile(chat, 'home', T0 + 30_000, cool).reason, 'cooldown');
  assert.equal(activateChatProfile(chat, 'home', T0 + 121_000, cool).changed, true);
  assert.equal(resolveChatProfile(chat, T0 + 121_000, cool).profile, 'home');
});

// 线上日志里那条"切换"曾误导排查：本来就没在值班、又切 home，也会 changed:true。
test('本来没在值班时再切默认人设：不算一次切换', () => {
  const result = activateChatProfile('group:nobody', 'home', T0, settings);
  assert.deepEqual(result, { changed: false, reason: 'already' });
});

// 冷却只该拦"来回切着玩"，不该拦"他下班"：模型自己输出交还标签、额度用完被交还都一样。
test('交还可以跳过冷却', () => {
  const cool = personaSwitchConfig({ ...settings, cooldownSeconds: 120 });
  const chat = 'group:force-home';
  assert.equal(activateChatProfile(chat, 'alt', T0, cool).changed, true);
  assert.equal(activateChatProfile(chat, 'home', T0 + 30_000, cool).reason, 'cooldown');
  assert.equal(activateChatProfile(chat, 'home', T0 + 30_000, cool, { force: true }).changed, true);
  assert.equal(resolveChatProfile(chat, T0 + 30_000, cool).profile, 'home');
});
