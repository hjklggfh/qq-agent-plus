import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { DEFAULT_DAILY_REPORT_CONTENT, DailyReportManager, dailyReportConfig, formatDailyReport, validateDailyReportPatch } from '../src/features/daily-report.js';

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
    usage: window => { assert.equal(window.end - window.start, 86400000, '固定 24 小时窗口'); return stats; },
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
  assert.match(f.sent[0][1], /统计：北京时间 10-22 23:00 — 10-23 23:00（完整 24 小时）/);
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
  assert.match(text, /¥68.0000\/月（非本窗口按量费用）/);
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
  const old = dailyReportConfig({ enabled: true, time: '23:00' });
  assert.equal(old.enabled, true);
  assert.deepEqual(old.content, DEFAULT_DAILY_REPORT_CONTENT);
  assert.throws(() => validateDailyReportPatch({ content: { cost: 'yes' } }));
  assert.throws(() => validateDailyReportPatch({ content: { unknown: true } }));
  assert.throws(() => validateDailyReportPatch({ content: Object.fromEntries(Object.keys(DEFAULT_DAILY_REPORT_CONTENT).map(k => [k, false])) }), /至少/);
});

test('content selection governs both scheduled text and read-only preview without reserving or sending', async t => {
  const content = Object.fromEntries(Object.keys(DEFAULT_DAILY_REPORT_CONTENT).map(k => [k, k === 'tokens']));
  const f = fixture(t);
  f.cfg.dailyReport.content = content;
  const preview = await f.manager.preview({ content }, evening);
  assert.match(preview.text, /Token：150/);
  assert.doesNotMatch(preview.text, /按量费用|服务器当前状态|CPU：|内存：|固定支出/);
  assert.equal(f.sent.length, 0);
  assert.equal(fs.existsSync(path.join(f.dataDir, 'daily-report.json')), false);
  await f.manager.tick(evening);
  assert.equal(f.sent[0][1], preview.text);
  const costOnly = await f.manager.preview({ content: { tokens: false, cost: true } }, evening);
  assert.match(costOnly.text, /按量费用/);
  assert.doesNotMatch(costOnly.text, /Token：150|CPU：/);
  assert.deepEqual(f.cfg.dailyReport.content, content, 'preview never changes saved selection');
});

test('a new Shanghai day permits one new report; clock rollback cannot replay', async t => {
  const windows = [];
  const f = fixture(t, { usage: window => { windows.push(window); return stats; } });
  await f.manager.tick(evening);
  await f.manager.tick(evening + 86400000);
  await f.manager.tick(evening);
  assert.equal(f.sent.length, 2);
  // 第二天的窗口紧接第一天的结束：24 小时滚动，不留缝也不重叠。
  assert.equal(windows[1].start, windows[0].end);
  assert.equal(windows[1].end, evening + 86400000);
});

test('the statistics window is the full 24 hours ending at the report moment', async t => {
  const seen = [];
  const f = fixture(t, { usage: window => { seen.push(window); return stats; } });
  const preview = await f.manager.preview({}, evening);
  assert.equal(seen[0].end, evening);
  assert.equal(seen[0].start, evening - 86400000);
  assert.match(preview.text, /10-22 23:00 — 10-23 23:00（完整 24 小时）/);
  await f.manager.tick(evening + 5 * 60000);
  assert.equal(seen[1].end, evening + 5 * 60000, '延迟发送时窗口仍是到发送那一刻');
  assert.equal(seen[1].start, evening + 5 * 60000 - 86400000);
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

const quotaOnly = { tokens: false, cost: false, status: false, uptime: false, cpu: false,
  memory: false, disk: false, io: false, quota: true };
const quotaFixture = {
  ok: true,
  refreshedAt: evening,
  error: '',
  accounts: [{
    email: 'someone@gmail.com', tier: 'PRO', current: true, disabled: false,
    groups: [{ name: 'Gemini Models', buckets: [
      { window: '5h', remaining: 0.9891, resetAt: Date.parse('2026-11-04T05:54:15Z') },
      { window: 'weekly', remaining: 0.978, resetAt: Date.parse('2026-11-10T14:54:15Z') }
    ] }]
  }]
};

test('quota section is fetched when scheduled, uses the run-time snapshot and honors selection', async t => {
  const seen = [];
  const f = fixture(t, { fetchQuota: async (source, options) => { seen.push({ source, options }); return quotaFixture; } });
  f.cfg.dailyReport.content = { ...quotaOnly };
  f.cfg.dailyReport.quota = { baseUrl: 'http://127.0.0.1:18045', webPassword: 'panel-pass' };
  await f.manager.tick(evening);
  assert.equal(seen.length, 1, 'scheduled report reads quota once');
  assert.equal(seen[0].source.baseUrl, 'http://127.0.0.1:18045');
  assert.equal(seen[0].source.webPassword, 'panel-pass');
  const text = f.sent[0][1];
  assert.match(text, /反代额度（10-23 23:00）/);
  assert.match(text, /som\*\*\*@gmail\.com \[PRO\] · 当前使用/);
  assert.match(text, /Gemini Models：5小时 剩98\.9%（11-04 13:54）｜每周 剩97\.8%（11-10 22:54）/);
  assert.doesNotMatch(text, /服务器当前状态|Token：/);
});

test('a quota failure is reported in-line and never blocks the report', async t => {
  const f = fixture(t, { fetchQuota: async () => { throw new Error('panel offline'); } });
  f.cfg.dailyReport.content = { ...quotaOnly };
  await f.manager.tick(evening);
  assert.equal(f.sent.length, 1, 'report still sent');
  assert.match(f.sent[0][1], /反代额度：读取失败（panel offline）/);
});

test('quota is skipped entirely when the option is off', async t => {
  let called = 0;
  const f = fixture(t, { fetchQuota: async () => { called++; return quotaFixture; } });
  f.cfg.dailyReport.content = { ...quotaOnly, quota: false, tokens: true };
  await f.manager.tick(evening);
  assert.equal(called, 0);
  assert.doesNotMatch(f.sent[0][1], /反代额度/);
});

test('status never echoes the panel password', async t => {
  const f = fixture(t);
  f.cfg.dailyReport.quota = { baseUrl: 'http://127.0.0.1:18045', webPassword: 'panel-secret' };
  const status = f.manager.status();
  assert.equal(status.settings.quota.hasWebPassword, true);
  assert.equal('webPassword' in status.settings.quota, false);
  assert.doesNotMatch(JSON.stringify(status), /panel-secret/);
});

test('quota settings are validated as part of the report patch', () => {
  assert.throws(() => validateDailyReportPatch({ quota: { baseUrl: 'ftp://bad' } }), /http/);
  assert.throws(() => validateDailyReportPatch({ quota: { unknown: 'x' } }), /未知/);
  validateDailyReportPatch({ quota: { baseUrl: 'http://127.0.0.1:18045', webPassword: 'x' } });
  assert.equal(dailyReportConfig({ enabled: true, time: '23:00' }).quota.baseUrl, 'http://127.0.0.1:18045');
});
