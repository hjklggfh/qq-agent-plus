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
