import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { DailyReportManager, dailyReportConfig, formatDailyReport, validateDailyReportPatch } from '../src/features/daily-report.js';

const evening = Date.parse('2026-10-23T23:00:00+08:00');
const host = { cpuCount: 2, load: [0.1, 0.2, 0.3], uptime: 3600, processUptime: 600,
  rss: 100, memoryAvailable: 1024, memoryTotal: 2048, swapUsed: null, disk: null, io: null };
const stats = { totals: { totalTokens: 150, promptTokens: 100, completionTokens: 50, cachedTokens: 80,
  runs: 2, cost: 0.12, actualCost: 0.1, estimateCost: 0.02, unpricedCalls: 1, unpricedTokens: 50,
  flatCalls: 1 }, billing: { flatItems: [{ amount: 68, period: 'month' }] } };

function fixture(t, extra = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-report-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const cfg = { dailyReport: { enabled: true, time: '23:00' }, admin: { ownerUin: '123456' }, runtime: { mode: 'active', paused: false } };
  const sent = [];
  const manager = new DailyReportManager({ dataDir, config: () => cfg, available: () => true,
    usage: window => { assert.equal(window.start, Date.parse('2026-10-23T00:00:00+08:00')); return stats; },
    host: async () => host, send: async (...args) => { sent.push(args); }, ...extra });
  return { manager, cfg, dataDir, sent };
}

test('Shanghai scheduling, concurrent ticks, persisted reservation and restart deduplication', async t => {
  const f = fixture(t);
  await f.manager.tick(evening - 1);
  assert.equal(f.sent.length, 0);
  f.manager.options.send = async (...args) => {
    const state = JSON.parse(fs.readFileSync(path.join(f.dataDir, 'daily-report.json'), 'utf8'));
    assert.equal(state.outcome, 'unknown', 'reserve before network write');
    f.sent.push(args);
  };
  await Promise.all([f.manager.tick(evening), f.manager.tick(evening)]);
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0][0], '123456');
  assert.match(f.sent[0][1], /00:00—23:00/);
  assert.equal(f.manager.status().last.outcome, 'sent');
  const restarted = new DailyReportManager(f.manager.options);
  await restarted.tick(evening + 60000);
  assert.equal(f.sent.length, 1);
});

test('unknown send outcome stays held across retries and process restart', async t => {
  let calls = 0;
  const f = fixture(t, { send: async () => { calls++; throw new Error('timeout'); } });
  await f.manager.tick(evening);
  await new DailyReportManager(f.manager.options).tick(evening + 60000);
  assert.equal(calls, 1);
  assert.equal(f.manager.status().last.outcome, 'unknown');
});

test('disabled, paused, observe, missing owner and disconnected modes have no writes', async t => {
  for (const block of ['disabled', 'paused', 'observe', 'owner', 'disconnected']) {
    const f = fixture(t);
    if (block === 'disabled') f.cfg.dailyReport.enabled = false;
    if (block === 'paused') f.cfg.runtime.paused = true;
    if (block === 'observe') f.cfg.runtime.mode = 'observe';
    if (block === 'owner') f.cfg.admin.ownerUin = '';
    if (block === 'disconnected') f.manager.options.available = () => false;
    await f.manager.tick(evening);
    assert.equal(f.sent.length, 0);
    assert.equal(fs.existsSync(path.join(f.dataDir, 'daily-report.json')), false);
  }
});

test('late reconnect can report today, but does not replay yesterday', async t => {
  const f = fixture(t);
  await f.manager.tick(evening + 300000);
  assert.equal(f.sent.length, 1);
  await f.manager.tick(Date.parse('2026-10-24T00:01:00+08:00'));
  assert.equal(f.sent.length, 1);
});

test('corrupt state fails closed; collection failure does not reserve delivery', async t => {
  const f = fixture(t);
  const file = path.join(f.dataDir, 'daily-report.json');
  fs.writeFileSync(file, 'broken');
  await assert.rejects(f.manager.tick(evening));
  assert.equal(f.sent.length, 0);
  assert.ok(f.manager.status().error);
  fs.unlinkSync(file);
  f.manager.options.host = async () => { throw new Error('read failure'); };
  await assert.rejects(f.manager.tick(evening));
  assert.equal(fs.existsSync(file), false);
});

test('disabling during collection cancels pending delivery', async t => {
  let release;
  const f = fixture(t, { host: () => new Promise(resolve => { release = resolve; }) });
  const pending = f.manager.tick(evening);
  // State read awaits I/O before collection starts.
  while (!release) await new Promise(resolve => setImmediate(resolve));
  f.cfg.dailyReport.enabled = false;
  f.manager.enforce();
  release(host);
  await assert.rejects(pending);
  assert.equal(f.sent.length, 0);
  assert.equal(fs.existsSync(path.join(f.dataDir, 'daily-report.json')), false);
});

test('report separates cache, estimates, unpriced tokens and fixed monthly fees', () => {
  const text = formatDailyReport({ now: evening, stats, host, connected: true, runtime: { mode: 'active' } });
  assert.match(text, /Token：150（输入 100 \/ 输出 50）/);
  assert.match(text, /已包含在输入中/);
  assert.match(text, /¥0.1200（配置价格 ¥0.1000 \/ 估算 ¥0.0200）/);
  assert.match(text, /未计入费用，不代表免费/);
  assert.match(text, /¥68.0000\/月（非本日按量费用）/);
  assert.match(text, /磁盘：采集不可用/);
  assert.match(text, /非 CPU 使用率/);
});

test('configuration is opt-in and malformed values fail closed', () => {
  assert.equal(dailyReportConfig().enabled, false);
  assert.equal(dailyReportConfig({ enabled: true, time: '25:00' }).enabled, false);
  for (const value of [null, [], { enabled: 'yes' }, { time: '3:00' }, { secret: true }]) {
    assert.throws(() => validateDailyReportPatch(value));
  }
  validateDailyReportPatch({ enabled: true, time: '23:00' });
});

test('a new Shanghai day permits one new report; clock rollback cannot replay', async t => {
  const windows = [];
  const f = fixture(t, { usage: window => { windows.push(window); return stats; } });
  await f.manager.tick(evening);
  await f.manager.tick(evening + 86400000);
  await f.manager.tick(evening);
  assert.equal(f.sent.length, 2);
  assert.equal(windows[1].start, Date.parse('2026-10-24T00:00:00+08:00'));
});

test('stopping during collection aborts quietly without blocking application shutdown', async t => {
  let release;
  const f = fixture(t, { host: () => new Promise(resolve => { release = resolve; }) });
  const pending = f.manager.tick(evening);
  const rejection = assert.rejects(pending);
  while (!release) await new Promise(resolve => setImmediate(resolve));
  const stopped = f.manager.stop();
  release(host);
  await stopped;
  await rejection;
  assert.equal(f.sent.length, 0);
});
