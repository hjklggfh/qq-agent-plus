import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { PrivateProactive, privateProactiveTargets, privateProactiveTimeAllowed } from '../src/core/private-proactive.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-agent-private-proactive-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test('target parsing and Shanghai quiet/work periods keep the audience narrow', () => {
  const targets = privateProactiveTargets({ targets: '12345:60/180,67890 bad', targetIdleMinMinutes: 30, cooldownMinutes: 120 });
  assert.deepEqual(targets.get('12345'), { idle: 60, cooldown: 180 });
  assert.deepEqual(targets.get('67890'), { idle: 30, cooldown: 120 });
  assert.equal(targets.size, 2);
  assert.equal(privateProactiveTargets({ targets: '' }), null);
  assert.equal(privateProactiveTargets({ targets: 'invalid' }).size, 0);
  const mondayTen = Date.UTC(2026, 9, 12, 2);
  assert.equal(privateProactiveTimeAllowed({}, mondayTen), false, 'work hours block');
  assert.equal(privateProactiveTimeAllowed({ liangwenfengEnabled: false }, mondayTen), true);
  assert.equal(privateProactiveTimeAllowed({ liangwenfengEnabled: false }, Date.UTC(2026, 9, 11, 17)), false, '01:00 Shanghai quiet');
});

test('private proactive only wakes allowed private chats, records sends and waits for a reply', async () => {
  const start = Date.UTC(2026, 9, 11, 22); // 06:00 Shanghai; custom quiet disabled below
  let now = start;
  let nextId = 1;
  const messages = new Map([
    ['private:12345', [{ id: nextId++, ts: now - 2 * 3600000, self: false }]],
    ['private:99999', [{ id: nextId++, ts: now - 2 * 3600000, self: false }]],
    ['group:12345', [{ id: nextId++, ts: now - 2 * 3600000, self: false }]]
  ]);
  const settings = {
    enabled: true, dryRun: false, quietRange: '', liangwenfengEnabled: false,
    targetIdleMinMinutes: 30, cooldownMinutes: 120, noRepeatWhenUnreplied: true,
    resendGuardMinutes: 0, replyGuardMinutes: 0, sendGapSec: 0,
    targetSendRange: '1-1', maxPerDay: 20
  };
  const cfg = { privateProactive: settings, allow: { private: ['12345', '99999'] } };
  const wakes = [];
  const store = {
    listChats: () => [...messages.keys()],
    unreadCount: () => 0,
    recent: (key, { limit, includeSelf = true, afterId = 0 }) =>
      (messages.get(key) || []).filter((m) => (includeSelf || !m.self) && m.id > afterId).slice(-limit)
  };
  const manager = new PrivateProactive({
    store, config: () => cfg, allowed: (key) => key === 'private:12345',
    canWake: () => false, now: () => now, random: () => 0,
    stateFile: path.join(tmp, 'state.json'), log: { info() {}, error() {} },
    wake: async (key, options) => {
      wakes.push({ key, options });
      messages.get(key).push({ id: nextId++, ts: now, self: true });
    }
  });
  manager.running = true;
  await manager.tick();
  assert.equal(wakes.length, 1);
  assert.equal(wakes[0].key, 'private:12345');
  assert.equal(wakes[0].options.proactive, true);
  now += 3 * 3600000;
  await manager.tick();
  assert.equal(wakes.length, 1, 'unreplied proactive send stays paused');
  messages.get('private:12345').push({ id: nextId++, ts: now - 40 * 60000, self: false });
  await manager.tick();
  assert.equal(wakes.length, 2, 'new incoming message lifts pause and cooldown');
  assert.equal(JSON.parse(fs.readFileSync(path.join(tmp, 'state.json'), 'utf8')).dayCount, 2);
});

test('dry run and empty allow list never call the model', async () => {
  let called = 0;
  const messages = [{ id: 1, ts: Date.UTC(2026, 9, 11), self: false }];
  const cfg = { privateProactive: { enabled: true, dryRun: true, quietRange: '', liangwenfengEnabled: false },
    allow: { private: ['12345'] } };
  const manager = new PrivateProactive({
    store: {
      listChats: () => ['private:12345'], unreadCount: () => 0,
      recent: (key, { includeSelf = true }) => includeSelf ? messages : messages.filter((m) => !m.self)
    },
    config: () => cfg, allowed: () => true, canWake: () => false,
    now: () => Date.UTC(2026, 9, 12, 8), random: () => 0,
    stateFile: path.join(tmp, 'dry-state.json'), log: { info() {}, error() {} },
    wake: async () => { called += 1; }
  });
  manager.running = true;
  await manager.tick();
  assert.equal(called, 0);
  cfg.privateProactive.dryRun = false;
  cfg.allow.private = [];
  await manager.tick();
  assert.equal(called, 0);
});

test('an interrupted wake keeps its reservation and does not resend before a reply', async () => {
  let now = Date.UTC(2026, 9, 12, 5);
  const messages = [{ id: 1, ts: now - 3600000, self: false }];
  const stateFile = path.join(tmp, 'interrupted-state.json');
  let called = 0;
  const manager = new PrivateProactive({
    store: {
      listChats: () => ['private:12345'], unreadCount: () => 0,
      recent: (key, { limit, includeSelf = true, afterId = 0 }) =>
        messages.filter((m) => (includeSelf || !m.self) && m.id > afterId).slice(-limit)
    },
    config: () => ({ privateProactive: {
      enabled: true, dryRun: false, quietRange: '', liangwenfengEnabled: false,
      replyGuardMinutes: 0, resendGuardMinutes: 0, sendGapSec: 0
    }, allow: { private: ['12345'] } }),
    allowed: () => true, canWake: () => false, now: () => now, random: () => 0,
    stateFile, log: { info() {}, error() {} },
    wake: async () => { called += 1; throw new Error('结果未知'); }
  });
  manager.running = true;
  await manager.tick();
  assert.equal(called, 1);
  assert.equal(JSON.parse(fs.readFileSync(stateFile, 'utf8')).friends['private:12345'].pending, true);
  now += 3 * 3600000;
  await manager.tick();
  assert.equal(called, 1, 'unknown send result must not retry');
});

test('invalid persistent state blocks sends rather than resetting counters', async () => {
  const stateFile = path.join(tmp, 'broken-state.json');
  fs.writeFileSync(stateFile, '{bad json');
  let called = 0;
  const manager = new PrivateProactive({
    store: { listChats: () => ['private:12345'] },
    config: () => ({ privateProactive: { enabled: true, dryRun: false, quietRange: '', liangwenfengEnabled: false } }),
    now: () => Date.UTC(2026, 9, 12, 5), stateFile, log: { info() {}, error() {} },
    wake: async () => { called += 1; }
  });
  manager.running = true;
  await assert.rejects(manager.tick());
  assert.equal(called, 0);
});
