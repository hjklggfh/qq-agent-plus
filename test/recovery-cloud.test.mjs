import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { ecsSignedRequest, ecsInstanceState, ecsFullState, ecsReboot } from '../src/core/recovery-ecs.js';
import { cloudRecoveryDecision, ecsAllowsRecovery } from '../src/core/recovery-cloud-policy.js';

const credentials = { accessKeyId: 'testAccessKey', accessKeySecret: 'testSecretNotARealCredential', regionId: 'cn-hangzhou', instanceId: 'i-test' };
function transport(body, statusCode = 200, calls = []) {
  return (options, callback) => {
    calls.push(options); const request = new EventEmitter();
    request.end = () => queueMicrotask(() => { const res = new EventEmitter(); res.statusCode = statusCode; res.destroy = () => {};
      callback(res); res.emit('data', Buffer.from(JSON.stringify(body))); res.emit('end'); });
    return request;
  };
}

test('签名固定阿里云HTTPS目标和操作白名单，编码稳定，不允许强制重启', () => {
  const a = ecsSignedRequest(credentials, 'DescribeInstanceStatus', { RegionId: 'cn-hangzhou', 'InstanceId.1': 'i-test' }, { now: new Date(0), nonce: 'fixed' });
  const b = ecsSignedRequest(credentials, 'DescribeInstanceStatus', { 'InstanceId.1': 'i-test', RegionId: 'cn-hangzhou' }, { now: new Date(0), nonce: 'fixed' });
  assert.deepEqual(a, b); assert.equal(a.hostname, 'ecs.cn-hangzhou.aliyuncs.com');
  assert.match(a.headers.authorization, /^ACS3-HMAC-SHA256 /); assert.doesNotMatch(JSON.stringify(a), /testSecretNotARealCredential/);
  assert.throws(() => ecsSignedRequest(credentials, 'DeleteInstance', {}), /not allowed/);
  assert.throws(() => ecsSignedRequest(credentials, 'RebootInstance', { ForceStop: 'true' }), /not allowed/);
});

test('只读状态严格匹配实例；DryRun预检不执行重启，真实调用必须显式确认', async () => {
  assert.deepEqual(await ecsInstanceState(credentials, { send: transport({ InstanceStatuses: { InstanceStatus: [{ InstanceId: 'i-test', Status: 'Running' }] } }) }), { status: 'Running' });
  await assert.rejects(ecsInstanceState(credentials, { send: transport({ InstanceStatuses: { InstanceStatus: [{ InstanceId: 'i-other', Status: 'Running' }] } }) }), /missing/);
  assert.deepEqual(await ecsFullState(credentials, { send: transport({ InstanceFullStatusSet: { InstanceFullStatusType: [{ InstanceId: 'i-test', Status: { Name: 'Running' }, HealthStatus: { Name: 'Ok' } }] } }) }), { status: 'Running', health: 'Ok', scheduledEvents: 0 });
  const calls = [];
  assert.equal((await ecsReboot(credentials, { send: transport({ Code: 'DryRunOperation' }, 412, calls) })).dryRunPassed, true);
  assert.match(calls[0].path, /DryRun=true/); assert.match(calls[0].path, /ForceStop=false/);
  await assert.rejects(ecsReboot(credentials, { dryRun: false, send: transport({}) }), /confirmation/);
  assert.equal((await ecsReboot(credentials, { dryRun: false, confirm: true, send: transport({ RequestId: 'test-request-1234' }, 200, calls) })).accepted, true);
  assert.match(calls[1].path, /DryRun=false/); assert.match(calls[1].path, /ForceStop=false/);
});

test('API拒绝或重定向不重试，不暴露服务器错误正文中的秘密', async () => {
  const calls = [];
  await assert.rejects(ecsInstanceState(credentials, { send: transport({ Code: 'Forbidden.RAM', Message: 'secret-content' }, 403, calls) }), error => error.code === 'Forbidden.RAM' && !error.message.includes('secret-content'));
  assert.equal(calls.length, 1);
  await assert.rejects(ecsInstanceState(credentials, { send: transport({}, 302, calls) }), /HTTP302/); assert.equal(calls.length, 2);
});

const now = 1800000000000;
const healthy = { reachable: true, bootId: 'boot1', uptimeSeconds: 9000, consoleHealthy: true, serviceState: 'active', recoverySuppressed: false };
function cloudSequence(sample, minutes, previous = cloudRecoveryDecision({}, healthy, {}, now).state, start = now + 60000, service = {}) {
  let decision;
  for (let i = 0; i <= minutes; i++) { decision = cloudRecoveryDecision(previous, sample, service, start + i * 60000); previous = decision.state; }
  return decision;
}

test('需已有正常主机基线，SSH和HTTP同时连续不可用十分钟才提名云端重启', () => {
  assert.equal(cloudSequence({ reachable: false }, 9).candidate, false);
  assert.equal(cloudSequence({ reachable: false }, 10).candidate, true);
  assert.equal(cloudSequence({ reachable: false, externalHealthy: true }, 20).candidate, false);
  assert.equal(cloudSequence({ reachable: false }, 20, {}).candidate, false);
  assert.equal(cloudSequence({ ...healthy, consoleHealthy: false, ioPressure: ['full avg60=99.0'] }, 10).candidate, false, '先恢复服务');
  assert.equal(cloudSequence({ ...healthy, consoleHealthy: false, ioPressure: ['full avg60=25.0'] }, 5, undefined, now + 60000, { attempted: true }).candidate, true);
});

test('维护、暂停、部署、显式停止、开机、监控中断、冷却和未知结果均阻止误重启', () => {
  assert.equal(ecsAllowsRecovery({ status: 'Running' }, { status: 'Running', health: 'Ok', scheduledEvents: 0 }), true);
  for (const full of [{ status: 'Stopped', health: 'Ok', scheduledEvents: 0 }, { status: 'Running', health: 'Maintaining', scheduledEvents: 0 }, { status: 'Running', health: 'Ok', scheduledEvents: 1 }]) assert.equal(ecsAllowsRecovery({ status: 'Running' }, full), false);
  for (const sample of [{ ...healthy, recoverySuppressed: true }, { ...healthy, serviceState: 'inactive', serviceResult: 'success' }, { ...healthy, uptimeSeconds: 100 }]) {
    const baseline = cloudRecoveryDecision({}, sample, {}, now).state;
    assert.equal(cloudSequence({ reachable: false }, 15, baseline).candidate, false);
  }
  const previous = cloudSequence({ reachable: false }, 9).state;
  assert.equal(cloudRecoveryDecision(previous, { reachable: false }, {}, now + 30 * 60000).candidate, false);
  assert.equal(cloudSequence({ reachable: false }, 10, { ...previous, serverAttempted: true }).candidate, false);
  assert.equal(cloudSequence({ reachable: false }, 10, { ...previous, serverReboots: [now] }).candidate, false);
  assert.equal(cloudSequence({ reachable: false }, 10, { ...previous, serverReboots: [now - 3700000, now - 7200000] }).candidate, false);
  assert.equal(cloudSequence({ reachable: false }, 10, { ...previous, serverReboots: [now + 3600000] }).candidate, false, '时钟回退保留未来的冷却记录');
  assert.equal(cloudSequence({ reachable: false }, 10, { ...previous, cloudGraceUntil: now + 3600000 }).candidate, false);
});
