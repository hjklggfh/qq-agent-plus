import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BackgroundTaskRegistry } from '../src/core/background-tasks.js';
import { observeTask, scheduleTaskObservation, taskObservation } from '../src/core/task-observation.js';

test('lifecycle is idempotent, config-scoped and serialized across start/reconfigure/stop', async () => {
  const cfg = { task: { enabled: false, time: '23:00' } }; const calls = [];
  const registry = new BackgroundTaskRegistry({ config: () => cfg });
  registry.register({ id: 'task', name: 'Task', configKey: 'task', enabled: c => c.task.enabled,
    start: async () => { calls.push('start'); }, stop: async () => { calls.push('stop'); },
    reconfigure: async () => { calls.push('configure'); } });
  await Promise.all([registry.start(), registry.start()]);
  assert.deepEqual(calls, []);
  assert.equal(registry.snapshot()[0].state, 'disabled');
  cfg.task.enabled = true;
  await Promise.all([registry.reconcile(), registry.reconcile()]);
  assert.deepEqual(calls, ['start']);
  cfg.unrelated = { enabled: true };
  await registry.reconcile();
  assert.deepEqual(calls, ['start']);
  cfg.task.time = '22:00'; await registry.reconcile();
  assert.deepEqual(calls, ['start', 'configure']);
  cfg.task.enabled = false; await registry.reconcile();
  assert.deepEqual(calls, ['start', 'configure', 'stop']);
  await registry.stop();
  assert.equal(registry.snapshot()[0].state, 'stopped');
  cfg.task.enabled = true;
  await registry.reconcile();
  assert.equal(registry.snapshot()[0].state, 'stopped', 'config update after stop never restarts tasks');
});

test('failed start is cleaned up, isolated and never automatically retried by status polling', async () => {
  let failures = 0; let stops = 0; let healthy = 0;
  const registry = new BackgroundTaskRegistry({ config: () => ({}) });
  registry.register({ id: 'broken', name: 'Broken', start: () => { failures++; throw new Error('secret-token'); }, stop: () => { stops++; } });
  registry.register({ id: 'healthy', name: 'Healthy', start: () => { healthy++; }, stop: () => {} });
  await registry.start(); await registry.reconcile();
  assert.equal(failures, 1); assert.equal(stops, 1); assert.equal(healthy, 1);
  const status = registry.snapshot();
  assert.equal(status[0].state, 'error'); assert.equal(status[1].state, 'waiting');
  assert.doesNotMatch(JSON.stringify(status), /secret-token/);
});

test('status exposes only safe scalar summaries and stop errors never prevent other cleanup', async () => {
  let cleaned = false;
  const registry = new BackgroundTaskRegistry({ config: () => ({}) });
  registry.register({ id: 'one', name: 'One', start: () => {}, stop: () => { throw new Error('failure'); },
    status: () => ({ running: true, nextRunAt: 100, privateMessage: 'private', apiKey: 'secret', needsReview: true }) });
  registry.register({ id: 'two', name: 'Two', start: () => {}, stop: () => { cleaned = true; } });
  await registry.start();
  const summary = registry.snapshot();
  assert.equal(summary[0].state, 'running'); assert.equal(summary[0].nextRunAt, 100);
  assert.equal(summary[0].needsReview, true);
  assert.doesNotMatch(JSON.stringify(summary), /privateMessage|apiKey|secret/);
  await registry.stop(); assert.equal(cleaned, true);
});

test('registration rejects duplicates and late additions', async () => {
  const registry = new BackgroundTaskRegistry({ config: () => ({}) });
  const entry = { id: 'task', name: 'Task', start: () => {}, stop: () => {} };
  registry.register(entry);
  assert.throws(() => registry.register(entry), /duplicate/);
  await registry.start(); assert.throws(() => registry.register({ ...entry, id: 'other' }), /after startup/);
});

test('observations preserve results, distinguish failure recovery and never retain exception data', async () => {
  const owner = {}; let clock = 100;
  scheduleTaskObservation(owner, 'poll', 200);
  assert.equal(observeTask(owner, 'poll', () => 42, () => clock), 42);
  assert.equal(taskObservation(owner, 'poll').lastSuccessAt, 100);
  clock = 110;
  const error = Object.assign(new Error('https://private/?token=secret'), { code: 'ECONNREFUSED' });
  await assert.rejects(observeTask(owner, 'poll', () => Promise.reject(error), () => clock), error);
  assert.equal(taskObservation(owner, 'poll').failureCode, 'network');
  assert.equal(taskObservation(owner, 'poll').lastSuccessAt, 100);
  assert.doesNotMatch(JSON.stringify(taskObservation(owner, 'poll')), /private|secret|token/);
  const registry = new BackgroundTaskRegistry({ config: () => ({}) });
  registry.register({ id: 'poll', name: 'Poll', start: () => {}, stop: () => {}, status: () => taskObservation(owner, 'poll') });
  await registry.start();
  assert.equal(registry.snapshot()[0].state, 'error');
  assert.match(registry.snapshot()[0].failureReason, /网络连接失败/);
  clock = 120;
  assert.equal(await observeTask(owner, 'poll', async () => 'ok', () => clock), 'ok');
  assert.equal(registry.snapshot()[0].state, 'waiting');
  assert.equal(registry.snapshot()[0].lastSuccessAt, 120);
  assert.equal(registry.snapshot()[0].lastErrorAt, 110, 'recovery keeps the last failure visible');
  assert.equal(taskObservation({}, 'poll').lastRunAt, undefined, 'process owners are isolated');
  await registry.stop();
  assert.equal(registry.snapshot()[0].nextRunAt, null, 'a stopped task has no planned check');
});

test('cancellation is not a failure, scalar validation and failure allowlist reject raw status errors', async () => {
  const owner = {};
  assert.throws(() => observeTask(owner, 'poll', () => { throw new DOMException('cancel', 'AbortError'); }));
  assert.equal(taskObservation(owner, 'poll').lastErrorAt, undefined);
  const registry = new BackgroundTaskRegistry({ config: () => ({}) });
  registry.register({ id: 'poll', name: 'Poll', start: () => {}, stop: () => {},
    status: () => ({ failureCode: '__proto__', failureReason: 'secret', error: 'secret', nextRunAt: Infinity, lastSuccessAt: -1 }) });
  await registry.start();
  const summary = registry.snapshot()[0];
  assert.equal(summary.nextRunAt, null); assert.equal(summary.lastSuccessAt, null);
  assert.equal(summary.failureReason, '');
  assert.doesNotMatch(JSON.stringify(summary), /secret|__proto__/);
  await registry.stop();
});
