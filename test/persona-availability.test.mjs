// 召唤前探活：错误归类（硬失败才拦）＋缓存（成功 30 分钟 / 失败 5 分钟）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'persona-availability-'));
process.env.QQ_AGENT_DATA_DIR = dataDir;

const {
  classifyUnavailable, isHardUnavailable, probeModel, probeState, markProbeResult, resetProbeCache
} = await import('../src/core/persona-availability.js');

process.on('exit', () => { try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ } });

const T0 = 1_700_000_000_000;
const MIN = 60_000;

test('错误归类：额度/欠费/鉴权/模型不存在算硬失败', () => {
  assert.equal(classifyUnavailable(new Error('HTTP 402 Payment Required')), 'auth');
  assert.equal(classifyUnavailable(new Error('HTTP 401 unauthorized')), 'auth');
  assert.equal(classifyUnavailable(new Error('HTTP 403 forbidden')), 'auth');
  assert.equal(classifyUnavailable(new Error('余额不足，请充值')), 'quota');
  assert.equal(classifyUnavailable(new Error('insufficient_quota')), 'quota');
  assert.equal(classifyUnavailable(new Error('账号欠费')), 'quota');
  assert.equal(classifyUnavailable(new Error('HTTP 404 model_not_found')), 'model');
  assert.equal(classifyUnavailable(new Error('无此模型：claude-x')), 'model');
});

test('错误归类：限流/5xx/超时/网络抖动不算硬失败（别让一次抖动让它"今天不上班"）', () => {
  for (const msg of [
    'HTTP 429 Too Many Requests',
    'rate limit exceeded',
    'HTTP 500 internal error',
    '请求超时 timeout',
    '模型请求失败：ECONNRESET',
    'fetch failed'
  ]) {
    assert.equal(classifyUnavailable(new Error(msg)), '', msg);
    assert.equal(isHardUnavailable(new Error(msg)), false, msg);
  }
  assert.equal(isHardUnavailable(new Error('insufficient_quota')), true);
});

test('探针：成功放行并缓存，第二次不再调用', async () => {
  resetProbeCache();
  let calls = 0;
  const call = async () => { calls += 1; return { ok: true }; };

  assert.deepEqual(await probeModel({ model: 'm-ok', call, now: T0 }), { ok: true, reason: '', cached: false });
  assert.deepEqual(await probeModel({ model: 'm-ok', call, now: T0 + MIN }), { ok: true, reason: '', cached: true });
  assert.equal(calls, 1, '缓存命中时不该再发请求');
});

test('探针：硬失败拦下，并按 5 分钟缓存', async () => {
  resetProbeCache();
  let calls = 0;
  const fail = async () => { calls += 1; throw new Error('insufficient_quota'); };
  const ok = async () => { calls += 1; return {}; };

  assert.deepEqual(await probeModel({ model: 'm-dead', call: fail, now: T0 }), { ok: false, reason: 'quota', cached: false });
  // 5 分钟内：直接复用失败结论，不再打
  assert.deepEqual(await probeModel({ model: 'm-dead', call: ok, now: T0 + 4 * MIN }), { ok: false, reason: 'quota', cached: true });
  assert.equal(calls, 1);
  // 超过 5 分钟：重新探（这次成功）
  assert.deepEqual(await probeModel({ model: 'm-dead', call: ok, now: T0 + 6 * MIN }), { ok: true, reason: '', cached: false });
  assert.equal(calls, 2);
});

test('探针：软失败放行且不缓存（限流不该被记成"不可用"）', async () => {
  resetProbeCache();
  let calls = 0;
  const flaky = async () => { calls += 1; throw new Error('HTTP 429 Too Many Requests'); };
  assert.deepEqual(await probeModel({ model: 'm-flaky', call: flaky, now: T0 }), { ok: true, reason: 'transient', cached: false });
  // 没缓存 → 下次还会再探
  assert.deepEqual(await probeModel({ model: 'm-flaky', call: flaky, now: T0 + MIN }), { ok: true, reason: 'transient', cached: false });
  assert.equal(calls, 2);
  assert.equal(probeState('m-flaky', T0 + MIN), null);
});

test('探针：模型名为空直接判不可用（不浪费请求）', async () => {
  resetProbeCache();
  let calls = 0;
  const call = async () => { calls += 1; return {}; };
  assert.deepEqual(await probeModel({ model: '   ', call }), { ok: false, reason: 'model', cached: false });
  assert.equal(calls, 0);
});

test('探针缓存可以被显式标记（站岗中途挂掉时用）', () => {
  resetProbeCache();
  markProbeResult('m-x', { ok: false, reason: 'quota', now: T0 });
  assert.deepEqual(probeState('m-x', T0 + MIN), { ok: false, reason: 'quota', at: T0 });
  // 过期后读不到
  assert.equal(probeState('m-x', T0 + 6 * MIN), null);
});
