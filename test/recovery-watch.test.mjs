import assert from 'node:assert/strict';
import test from 'node:test';
import { recoveryDecision } from '../src/core/recovery-watch.js';

const healthy = { reachable: true, bootId: 'boot1', uptimeSeconds: 9000, consoleHealthy: true, onebotConnected: true, serviceState: 'active' };
const failed = { ...healthy, consoleHealthy: false };
const base = 1800000000000;
function advance(sample, minutes, previous = {}, start = base) {
  let decision;
  for (let i = 0; i <= minutes; i++) { decision = recoveryDecision(previous, sample, start + i * 60000); previous = decision.state; }
  return decision;
}

test('健康、高IO但服务正常、单纯QQ掉线均不重启', () => {
  for (const sample of [healthy, { ...healthy, ioPressure: ['full avg60=99.0'] }, { ...healthy, onebotConnected: false }]) {
    assert.equal(advance(sample, 10).action, 'none');
  }
});
test('持续五分钟故障才重启，动作前保存保留位，同一故障未知不重发', () => {
  assert.equal(advance(failed, 4).action, 'none');
  const decision = advance(failed, 5);
  assert.equal(decision.action, 'restart-service'); assert.equal(decision.state.attempted, true); assert.equal(decision.state.restarts.length, 1);
  assert.equal(advance(failed, 30, decision.state, base + 6 * 60000).action, 'none');
});
test('开机十分钟、显式停止、监测中断、时钟回退均不立即恢复', () => {
  assert.equal(advance({ ...failed, uptimeSeconds: 100 }, 10).reason, 'boot-grace');
  assert.equal(advance({ ...failed, serviceState: 'inactive', serviceResult: 'success' }, 10).reason, 'service-intentionally-stopped-or-suppressed');
  const previous = advance(failed, 4).state;
  assert.equal(recoveryDecision(previous, failed, base + 20 * 60000).action, 'none');
  assert.equal(recoveryDecision(previous, failed, base - 60000).action, 'none');
});
test('SSH或整机无法连接只记录，云凭据未配置时绝不重启服务器', () => {
  for (const sample of [{ reachable: false }, { reachable: false, externalHealthy: true }]) {
    const decision = advance(sample, 30);
    assert.equal(decision.action, 'none'); assert.equal(decision.state.restarts.length, 0);
  }
  const state = advance(failed, 4).state;
  const gap = recoveryDecision(state, { reachable: false }, base + 5 * 60000);
  assert.equal(gap.state.failureAt, undefined);
  assert.equal(recoveryDecision(gap.state, failed, base + 6 * 60000).action, 'none');
});
test('恢复后新故障仍受一小时冷却和24小时两次上限约束，换boot不清除限额', () => {
  const first = advance(failed, 5);
  const recovered = recoveryDecision(first.state, healthy, base + 6 * 60000);
  assert.equal(advance(failed, 5, recovered.state, base + 7 * 60000).reason, 'restart-limit');
  const second = advance(failed, 5, recovered.state, base + 61 * 60000);
  assert.equal(second.action, 'restart-service');
  const recovered2 = recoveryDecision(second.state, healthy, base + 67 * 60000);
  assert.equal(advance({ ...failed, bootId: 'boot2' }, 5, recovered2.state, base + 130 * 60000).reason, 'restart-limit');
});
