import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PUZZLES } from '../src/features/haigui-tang/puzzles.js';
import { haiguiTangCommand } from '../src/features/haigui-tang/command.js';
import { validateHaiguiTangPatch } from '../src/features/haigui-tang/config.js';
import { HaiguiTangManager } from '../src/features/haigui-tang/manager.js';

function fixture(overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'haigui-tang-'));
  const config = { enabled: true, allowedChats: ['group:12345'], includeDark: false, maxStars: 3,
    sessionHours: 3, hintLimit: 3, revealAfterQuestions: 5, showRules: true, avoidRepeat: true, ...overrides };
  const sent = [];
  const manager = new HaiguiTangManager({
    dataDir: dir, getConfig: () => ({ haiguiTang: config }),
    send: async (_chatKey, messages) => { sent.push(...messages); },
    complete: async () => ({ message: { content: '{"answer":"是","solved":false}' } }),
    rng: () => 0
  });
  return { dir, config, sent, manager };
}

test('题库和指令边界', () => {
  assert.equal(PUZZLES.length, 112);
  assert.equal(new Set(PUZZLES.map((p) => p.id)).size, PUZZLES.length);
  assert.ok(PUZZLES.every((p) => p.soup && p.answer && p.stars >= 3 && p.stars <= 5));
  assert.deepEqual(haiguiTangCommand('海龟汤 简单'), { kind: 'start', stars: 3 });
  assert.deepEqual(haiguiTangCommand('海龟汤'), { kind: 'menu' });
  assert.deepEqual(haiguiTangCommand('2', false, true), { kind: 'start', stars: 4 });
  assert.deepEqual(haiguiTangCommand('退出', false, true), { kind: 'stop' });
  assert.deepEqual(haiguiTangCommand('退出', true), { kind: 'stop' });
  assert.deepEqual(haiguiTangCommand('退出海龟汤', true), { kind: 'stop' });
  assert.equal(haiguiTangCommand('2'), null);
  assert.equal(haiguiTangCommand('退出'), null);
  assert.equal(haiguiTangCommand('提示'), null);
  assert.deepEqual(haiguiTangCommand('提示', true), { kind: 'hint' });
  assert.equal(haiguiTangCommand('今天是不是周一', false), null);
  assert.throws(() => validateHaiguiTangPatch({ allowedChats: ['group:bad'] }));
});

test('开局前显示按设置过滤的题数，选择难度后才出题', async (t) => {
  const x = fixture({ maxStars: 5, includeDark: true });
  t.after(() => fs.rmSync(x.dir, { recursive: true, force: true }));
  await x.manager.handle(haiguiTangCommand('海龟汤'), 'group:12345', 1);
  assert.equal(x.manager.isActive('group:12345'), false);
  assert.equal(x.manager.isSelecting('group:12345'), true);
  for (const [label, level] of [['简单', 3], ['中等', 4], ['困难', 5]]) {
    const count = PUZZLES.filter((puzzle) => puzzle.stars === level).length;
    assert.ok(x.sent[0].includes(`${label}（${level} 星，${count} 道）`));
  }
  assert.ok(!PUZZLES.some((puzzle) => x.sent[0].includes(puzzle.answer)));
  const restored = new HaiguiTangManager({
    dataDir: x.dir, getConfig: () => ({ haiguiTang: x.config }),
    send: async (_chatKey, messages) => { x.sent.push(...messages); }, rng: () => 0
  });
  assert.equal(restored.isSelecting('group:12345'), true);
  await restored.handle(haiguiTangCommand('2', false, restored.isSelecting('group:12345')), 'group:12345', 2);
  assert.equal(restored.isSelecting('group:12345'), false);
  assert.equal(restored.isActive('group:12345'), true);
  assert.equal(PUZZLES.find((puzzle) => puzzle.id === restored.chats['group:12345'].puzzleId)?.stars, 4);
});

test('零题难度不会出题，退出可取消选题或结束当前局', async (t) => {
  const x = fixture({ maxStars: 5, includeDark: false });
  t.after(() => fs.rmSync(x.dir, { recursive: true, force: true }));
  await x.manager.handle({ kind: 'menu' }, 'group:12345', 1);
  assert.ok(x.sent[0].includes('困难（5 星，0 道）'));
  const unavailable = await x.manager.handle({ kind: 'start', stars: 5 }, 'group:12345', 2);
  assert.ok(unavailable.error);
  assert.equal(x.manager.isSelecting('group:12345'), true);
  await x.manager.handle({ kind: 'stop' }, 'group:12345', 3);
  assert.equal(x.manager.isSelecting('group:12345'), false);
  assert.ok(x.sent.at(-1).includes('已退出海龟汤选题'));
  await x.manager.handle({ kind: 'start', stars: 3 }, 'group:12345', 4);
  assert.equal(x.manager.isActive('group:12345'), true);
  await x.manager.handle({ kind: 'stop' }, 'group:12345', 5);
  assert.equal(x.manager.isActive('group:12345'), false);
  assert.ok(x.sent.at(-1).includes('已退出海龟汤'));
});

test('开局、问答与重启恢复只发送公开文字', async (t) => {
  const x = fixture();
  t.after(() => fs.rmSync(x.dir, { recursive: true, force: true }));
  await x.manager.handle({ kind: 'start' }, 'group:12345', 1);
  const puzzle = PUZZLES.find((p) => p.id === x.manager.chats['group:12345'].puzzleId);
  assert.ok(puzzle);
  assert.ok(x.sent[0].includes(puzzle.soup));
  assert.ok(!x.sent[0].includes(puzzle.answer));
  await x.manager.handle({ kind: 'ask', question: '是不是因为天气？' }, 'group:12345', 2);
  assert.equal(x.sent[1], '是');
  assert.equal(x.manager.chats['group:12345'].asked, 1);
  const restored = new HaiguiTangManager({
    dataDir: x.dir, getConfig: () => ({ haiguiTang: x.config }),
    send: async (_chatKey, messages) => { x.sent.push(...messages); },
    complete: async () => ({ message: { content: '{"answer":"无关","solved":false}' } })
  });
  await restored.handle({ kind: 'status' }, 'group:12345', 3);
  assert.ok(x.sent[2].includes('已问 1 题'));
  assert.ok(!x.sent[2].includes(puzzle.answer));
});

test('模型输出不能直接发出汤底；猜中和主动公布受宿主控制', async (t) => {
  const x = fixture({ revealAfterQuestions: 2 });
  t.after(() => fs.rmSync(x.dir, { recursive: true, force: true }));
  await x.manager.handle({ kind: 'start' }, 'group:12345', 1);
  const puzzle = PUZZLES.find((p) => p.id === x.manager.chats['group:12345'].puzzleId);
  x.manager.complete = async () => ({ message: { content: `{"answer":"不是","solved":false,"leak":${JSON.stringify(puzzle.answer)}}` } });
  await x.manager.handle({ kind: 'ask', question: '是不是随便猜的？' }, 'group:12345', 2);
  assert.equal(x.sent.at(-1), '不是');
  await x.manager.handle({ kind: 'reveal' }, 'group:12345', 3);
  assert.ok(!x.sent.at(-1).includes(puzzle.answer));
  await x.manager.handle({ kind: 'reveal' }, 'group:12345', 4);
  assert.ok(x.sent.at(-1).includes(puzzle.answer));
  assert.equal(x.manager.isActive('group:12345'), false);
});

test('关闭后保留进度且阻止后续问答', async (t) => {
  const x = fixture();
  t.after(() => fs.rmSync(x.dir, { recursive: true, force: true }));
  await x.manager.handle({ kind: 'start' }, 'group:12345', 1);
  x.config.enabled = false;
  x.manager.sync();
  assert.equal(x.manager.isActive('group:12345'), false);
  const count = x.sent.length;
  await x.manager.handle({ kind: 'ask', question: '是不是……' }, 'group:12345', 2);
  assert.equal(x.sent.length, count);
  assert.ok(fs.existsSync(path.join(x.dir, 'haigui-tang', 'state.json')));
});

test('控制台自定义题只外发汤面，汤底留在当前局', async (t) => {
  const x = fixture();
  t.after(() => fs.rmSync(x.dir, { recursive: true, force: true }));
  const result = await x.manager.handle({ kind: 'custom', soup: '一盏灯每夜都亮，某晚却没有亮。为什么？', answer: '灯泡坏了。' }, 'group:12345', 1);
  assert.deepEqual(result, {});
  assert.ok(x.sent[0].includes('一盏灯每夜都亮'));
  assert.ok(!x.sent[0].includes('灯泡坏了'));
  assert.equal(x.manager.chats['group:12345'].custom.answer, '灯泡坏了。');
  assert.ok((await x.manager.handle({ kind: 'custom', soup: '另一个汤面', answer: '另一个汤底' }, 'group:12345', 2)).error);
});
