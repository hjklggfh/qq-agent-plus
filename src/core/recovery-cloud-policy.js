export const CLOUD_RECOVERY_POLICY = Object.freeze({ outageMs: 600000, ioFailureMs: 300000, graceMs: 600000,
  cooldownMs: 3600000, dailyReboots: 2, maxGapMs: 180000, baselineMaxAgeMs: 86400000 });

// This state machine only nominates an action; a fresh ECS status and last health
// recheck are required before reserving and issuing the normal reboot.
export function cloudRecoveryDecision(previous, sample, serviceState, now = Date.now(), policy = CLOUD_RECOVERY_POLICY) {
  const state = structuredClone(previous || {});
  state.serverReboots = (state.serverReboots || []).filter(time => Number.isFinite(time) && now - time < 86400000);
  if (state.cloudLastAt && (now < state.cloudLastAt || now - state.cloudLastAt > policy.maxGapMs)) {
    delete state.hostFailureAt; delete state.ioFailureAt;
    if (now < state.cloudLastAt) delete state.baselineAt;
  }
  state.cloudLastAt = now;
  if (sample.reachable) {
    if (state.knownBoot && state.knownBoot !== sample.bootId) { delete state.serverAttempted; delete state.hostFailureAt; delete state.ioFailureAt; }
    state.knownBoot = sample.bootId; state.baselineAt = now; state.baselineUptime = sample.uptimeSeconds;
    state.suppressed = sample.recoverySuppressed === true || (sample.serviceState === 'inactive' && sample.serviceResult === 'success');
  }
  if (state.serverReboots.some(time => now - time < policy.graceMs)) return { state, candidate: false, reason: 'server-reboot-grace' };
  if (state.cloudGraceUntil > now) return { state, candidate: false, reason: 'cloud-transition-grace' };
  if (sample.consoleHealthy || sample.externalHealthy) {
    delete state.hostFailureAt; delete state.ioFailureAt;
    return { state, candidate: false, reason: 'healthy' };
  }
  if (!state.knownBoot || !state.baselineAt || now - state.baselineAt > policy.baselineMaxAgeMs || state.baselineUptime < 600 || state.suppressed) {
    delete state.hostFailureAt; delete state.ioFailureAt;
    return { state, candidate: false, reason: 'no-eligible-host-baseline' };
  }
  if (state.serverAttempted) return { state, candidate: false, reason: 'server-recovery-held-no-repeat' };
  if (state.serverReboots.length >= policy.dailyReboots || state.serverReboots.some(time => now - time < policy.cooldownMs)) return { state, candidate: false, reason: 'server-reboot-limit' };
  if (!sample.reachable) {
    delete state.ioFailureAt; state.hostFailureAt ??= now;
    return { state, candidate: now - state.hostFailureAt >= policy.outageMs, reason: 'host-unreachable' };
  }
  delete state.hostFailureAt;
  const full = (sample.ioPressure || []).find(line => line.startsWith('full '));
  const pressure = Number(full?.match(/\bavg60=([0-9.]+)/)?.[1]);
  if (!Number.isFinite(pressure) || pressure < 20 || !serviceState.attempted) {
    delete state.ioFailureAt; return { state, candidate: false, reason: 'insufficient-host-failure-evidence' };
  }
  state.ioFailureAt ??= now;
  return { state, candidate: now - state.ioFailureAt >= policy.ioFailureMs, reason: 'service-unrecovered-io-stalled' };
}

export function ecsAllowsRecovery(status, full) {
  return status?.status === 'Running' && full?.status === 'Running'
    && ['Ok', 'Impaired'].includes(full.health) && full.scheduledEvents === 0;
}
