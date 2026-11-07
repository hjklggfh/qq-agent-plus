// 换人设时改头像：纯决策（planAvatar）+ 状态记录。
// 头像是账号级的 —— 这里钉住的规则是"有任意会话在值班就用第二人设的脸，全部交还就换回默认"。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'persona-avatar-sync-'));
process.env.QQ_AGENT_DATA_DIR = dataDir;

const {
  planAvatar, avatarState, markAvatarApplied, markAvatarFailed, personaSwitchConfig
} = await import('../src/core/persona-switch.js');

process.on('exit', () => { try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ } });

const ALT = '/data/avatar-claude.png';
const HOME = '/data/avatar-home.png';
const NOW = 1_700_000_000_000;

test('planAvatar：没配图片就什么都不做（也不写状态）', () => {
  assert.equal(planAvatar({ anyDuty: true, state: {}, altAvatar: '', homeAvatar: '' }), null);
  assert.equal(planAvatar({ anyDuty: false, state: {}, altAvatar: ALT, homeAvatar: '' }), null);
  assert.equal(planAvatar({ anyDuty: true, state: {}, altAvatar: '', homeAvatar: HOME }), null);
});

test('planAvatar：有人在值班 → 第二人设的脸；全部交还 → 默认那张', () => {
  assert.deepEqual(
    planAvatar({ anyDuty: true, state: {}, altAvatar: ALT, homeAvatar: HOME, now: NOW }),
    { mode: 'alt', file: ALT }
  );
  assert.deepEqual(
    planAvatar({ anyDuty: false, state: {}, altAvatar: ALT, homeAvatar: HOME, now: NOW }),
    { mode: 'home', file: HOME }
  );
  // 已经是这副脸：不重复上传
  assert.equal(planAvatar({ anyDuty: true, state: { mode: 'alt', at: NOW - 60000 }, altAvatar: ALT, homeAvatar: HOME, now: NOW }), null);
  assert.equal(planAvatar({ anyDuty: false, state: { mode: 'home', at: NOW - 60000 }, altAvatar: ALT, homeAvatar: HOME, now: NOW }), null);
});

test('planAvatar：开关关掉 / 刚失败过 / 距离上次太近都不动', () => {
  assert.equal(planAvatar({ anyDuty: true, state: {}, altAvatar: ALT, homeAvatar: HOME, enabled: false, now: NOW }), null);
  // 失败退避（默认 10 分钟）
  assert.equal(
    planAvatar({ anyDuty: true, state: { mode: 'home', failAt: NOW - 60000 }, altAvatar: ALT, homeAvatar: HOME, now: NOW }),
    null
  );
  assert.deepEqual(
    planAvatar({ anyDuty: true, state: { mode: 'home', failAt: NOW - 11 * 60000 }, altAvatar: ALT, homeAvatar: HOME, now: NOW }),
    { mode: 'alt', file: ALT }
  );
  // 节流（默认 20 秒）
  assert.equal(
    planAvatar({ anyDuty: true, state: { mode: 'home', at: NOW - 5000 }, altAvatar: ALT, homeAvatar: HOME, now: NOW }),
    null
  );
  assert.deepEqual(
    planAvatar({ anyDuty: true, state: { mode: 'home', at: NOW - 25000 }, altAvatar: ALT, homeAvatar: HOME, now: NOW }),
    { mode: 'alt', file: ALT }
  );
});

test('头像状态记录：成功记 mode+时间，失败只记时间不改 mode', () => {
  assert.deepEqual(avatarState(), { mode: '', at: 0, failAt: 0 });

  markAvatarApplied('alt', NOW);
  assert.deepEqual(avatarState(), { mode: 'alt', at: NOW, failAt: 0 });

  markAvatarFailed(NOW + 1000);
  assert.deepEqual(avatarState(), { mode: 'alt', at: NOW, failAt: NOW + 1000 });

  // 成功后清掉失败标记
  markAvatarApplied('home', NOW + 2000);
  assert.deepEqual(avatarState(), { mode: 'home', at: NOW + 2000, failAt: 0 });
});

test('开关默认开着，但图片为空时等于没开', () => {
  const cfg = personaSwitchConfig({ enabled: true });
  assert.equal(cfg.switchAvatar, true);
  assert.equal(cfg.altAvatar, '');
  assert.equal(cfg.homeAvatar, '');
  assert.equal(planAvatar({ anyDuty: true, altAvatar: cfg.altAvatar, homeAvatar: cfg.homeAvatar }), null);
  // 显式关掉
  assert.equal(personaSwitchConfig({ switchAvatar: false }).switchAvatar, false);
});
