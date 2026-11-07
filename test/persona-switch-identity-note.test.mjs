import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

// 提示词构建会读配置（getConfig），数据目录必须在 import 之前指定。
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'persona-switch-note-'));
process.env.QQ_AGENT_DATA_DIR = dataDir;

const { DEFAULT_CONFIG, setRuntimeConfig } = await import('../src/core/config.js');
const { buildUserPrompt } = await import('../src/llm/prompt.js');

process.on('exit', () => { try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ } });

const HOUR = 3600 * 1000;
const CHAT = 'group:123';

function fakeStore() {
  const now = Date.now();
  const rows = [
    { id: 11, ts: now - 120_000, senderId: '12345', senderName: '甲', text: '随便聊两句', self: false },
    { id: 12, ts: now - 60_000, senderId: '12345', senderName: '甲', text: '上一张卡的口癖在这儿', self: false },
    { id: 13, ts: now - 30_000, senderId: '9', senderName: '我', text: '我是上一张卡说的', self: true }
  ];
  return {
    recent: (_chatKey, { limit = 10 } = {}) => rows.slice(-Math.max(1, Number(limit) || 10))
  };
}

function promptWith(extra = {}) {
  setRuntimeConfig(structuredClone(DEFAULT_CONFIG));
  return buildUserPrompt({
    chatKey: CHAT,
    kind: 'group',
    chatId: '123',
    chatName: '测试群',
    triggerEntries: [{
      id: 14, ts: Date.now() - 10_000, senderId: '12345', senderName: '甲', text: '在吗', self: false
    }],
    store: fakeStore(),
    // 只关心"旧记录要不要弱化"这一句，记忆与回忆都用空实现占位
    memory: { formatForPrompt: () => '', formatHandoffForPrompt: () => '' },
    recallText: '',
    ...extra
  });
}

test('默认人设下不注入"人设刚换过"的提醒（提示词与升级前一致）', () => {
  assert.doesNotMatch(promptWith(), /刚换过/);
  // 显式传 0 / undefined 也一样
  assert.doesNotMatch(promptWith({ personaSwitchedAt: 0 }), /刚换过/);
  assert.doesNotMatch(promptWith({ personaSwitchedAt: null }), /刚换过/);
});

test('刚切到第二人设（24 小时内）会提醒旧记录的口癖不算数', () => {
  const text = promptWith({ personaSwitchedAt: Date.now() - 5 * 60 * 1000 });
  assert.match(text, /刚换过/);
  // 提醒必须紧跟在【过去状态】段头后面，模型才不会把旧口癖当成本轮风格
  assert.match(text, /【过去状态】（注意：【角色设定】刚换过/);
});

test('切过去超过 24 小时后提醒自动消失', () => {
  assert.doesNotMatch(promptWith({ personaSwitchedAt: Date.now() - 25 * HOUR }), /刚换过/);
});
