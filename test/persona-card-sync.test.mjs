// 换人设时改群名片：纯决策（planGroupCard）+ 状态机（墓碑/原名/忘掉）。
// I/O 那半截（sender.setCard / getGroupMemberInfo）不在这里打桩，由项目里的
// sender.setCard 既有用例负责（工具 set_group_card 走同一条路径）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

// 必须在 import 业务模块之前指定数据目录：config-legacy 在模块求值时读取该环境变量。
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'persona-card-sync-'));
process.env.QQ_AGENT_DATA_DIR = dataDir;

const {
  planGroupCard, activateChatProfile, resolveChatProfile, clearChatProfile,
  chatCardState, rememberChatCard, forgetChatCard, activeAltChats, personaSwitchConfig
} = await import('../src/core/persona-switch.js');

process.on('exit', () => { try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ } });

const settings = personaSwitchConfig({
  enabled: true,
  idleMinutes: 30,
  cooldownSeconds: 0,
  altModel: 'claude-sonnet-5-5',
  altRoleText: '你是克劳德',
  altName: 'Claude'
});
const T0 = 1_700_000_000_000;
const MIN = 60_000;

test('planGroupCard：切到第二人设只改一次，名字没变就不重复调接口', () => {
  assert.deepEqual(
    planGroupCard({ altActive: true, card: '', altName: 'Claude', homeName: 'Gemi本咪' }),
    { card: 'Claude', remember: true, forget: false }
  );
  // 已经是这个名字：不动（避免每轮都发一次 set_group_card）
  assert.equal(planGroupCard({ altActive: true, card: 'Claude', altName: 'Claude' }), null);
  // 没配第二人设的名字：不动
  assert.equal(planGroupCard({ altActive: true, card: '', altName: '  ' }), null);
});

test('planGroupCard：没改过名片就绝不碰它；改过就改回原名', () => {
  // 我们从没改过名片 → 别人手设的名字不该被覆盖
  assert.equal(planGroupCard({ altActive: false, card: '', homeName: 'Gemi本咪' }), null);
  // 改过 → 用捕获到的原名还原
  assert.deepEqual(
    planGroupCard({ altActive: false, card: 'Claude', homeCard: '老名字', homeName: 'Gemi本咪' }),
    { card: '老名字', remember: false, forget: true }
  );
  // 没捕获到原名 → 退回机器人名字
  assert.deepEqual(
    planGroupCard({ altActive: false, card: 'Claude', homeCard: '', homeName: 'Gemi本咪' }),
    { card: 'Gemi本咪', remember: false, forget: true }
  );
  // 原名就是当前名字 / 完全不知道该改回什么 → 只清记录，不再改
  assert.deepEqual(
    planGroupCard({ altActive: false, card: 'Claude', homeCard: 'Claude' }),
    { card: '', remember: false, forget: true }
  );
  assert.deepEqual(
    planGroupCard({ altActive: false, card: 'Claude', homeCard: '', homeName: '' }),
    { card: '', remember: false, forget: true }
  );
});

test('planGroupCard：开关关掉时什么都不做', () => {
  assert.equal(planGroupCard({ altActive: true, card: '', altName: 'Claude', enabled: false }), null);
  assert.equal(planGroupCard({ altActive: false, card: 'Claude', homeCard: 'x', enabled: false }), null);
});

test('planGroupCard：刚失败过就退避十分钟，不撞同一堵墙', () => {
  const now = 1_700_000_000_000;
  assert.equal(
    planGroupCard({ altActive: true, card: '', altName: 'Claude', failedAt: now - 60_000, now }),
    null,
    '一分钟前刚失败过 → 这一轮跳过'
  );
  assert.deepEqual(
    planGroupCard({ altActive: true, card: '', altName: 'Claude', failedAt: now - 11 * 60_000, now }),
    { card: 'Claude', remember: true, forget: false },
    '超过退避窗口 → 再试一次'
  );
});

test('值班期间改过名片：闲置过期后留下墓碑，下一轮才知道要改回去', () => {
  const chat = 'group:9001';
  assert.deepEqual(chatCardState(chat), { card: '', homeCard: '', failedAt: 0 });

  activateChatProfile(chat, 'alt', T0, settings);
  rememberChatCard(chat, 'Claude', 'Gemi本咪');
  assert.deepEqual(chatCardState(chat), { card: 'Claude', homeCard: 'Gemi本咪', failedAt: 0 });
  assert.deepEqual(activeAltChats(T0 + MIN).map((x) => x.chatKey), [chat]);

  // 闲置过期：人设回默认，但名片记录要留着
  assert.equal(resolveChatProfile(chat, T0 + 31 * MIN, settings).profile, 'home');
  assert.deepEqual(chatCardState(chat), { card: 'Claude', homeCard: 'Gemi本咪', failedAt: 0 });
  // 墓碑不算"正在值班"
  assert.deepEqual(activeAltChats(T0 + 31 * MIN), []);

  // 下一轮据此算出"改回原名"
  const state = chatCardState(chat);
  assert.deepEqual(
    planGroupCard({ altActive: false, card: state.card, homeCard: state.homeCard, homeName: 'Gemi本咪' }),
    { card: 'Gemi本咪', remember: false, forget: true }
  );

  // 改回去并清记录：记录没了，后续轮次不再重复改名片
  forgetChatCard(chat);
  assert.deepEqual(chatCardState(chat), { card: '', homeCard: '', failedAt: 0 });
  assert.equal(planGroupCard({ altActive: false, card: chatCardState(chat).card }), null);
});

test('管理员在控制台叫回：状态清掉但名片记录留着，等下一轮改回', () => {
  const chat = 'group:9002';
  activateChatProfile(chat, 'alt', T0, settings);
  rememberChatCard(chat, 'Claude', 'Gemi本咪');

  assert.equal(clearChatProfile(chat), true, '叫回正在值班的会话应返回 true');
  assert.equal(resolveChatProfile(chat, T0 + MIN, settings).profile, 'home');
  assert.deepEqual(chatCardState(chat), { card: 'Claude', homeCard: 'Gemi本咪', failedAt: 0 });

  forgetChatCard(chat);
  // 再叫回一次：已经不在了，返回 false（控制台据此提示"本来就没在值班"）
  assert.equal(clearChatProfile(chat), false);
});

test('没改过名片的会话：切回/叫回都不留记录', () => {
  const chat = 'group:9003';
  activateChatProfile(chat, 'alt', T0, settings);
  assert.equal(clearChatProfile(chat), true);
  assert.deepEqual(chatCardState(chat), { card: '', homeCard: '', failedAt: 0 });
  assert.equal(clearChatProfile(chat), false);
});

test('第二人设没配好时不会残留名片记录', () => {
  const notReady = personaSwitchConfig({ enabled: true, altModel: '', altRoleText: '' });
  const chat = 'group:9004';
  assert.equal(activateChatProfile(chat, 'alt', T0, notReady).changed, false);
  assert.deepEqual(chatCardState(chat), { card: '', homeCard: '', failedAt: 0 });
});
