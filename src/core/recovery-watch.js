// Independent recovery worker. Public operations are exposed through src/ops.js.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const RECOVERY_POLICY = Object.freeze({ failureMs: 5 * 60000, bootGraceSeconds: 600,
  cooldownMs: 3600000, dailyRestarts: 2, maxSampleGapMs: 180000 });

export function recoveryDecision(previous, sample, now = Date.now(), policy = RECOVERY_POLICY) {
  const state = structuredClone(previous || {});
  const events = (state.restarts || []).filter(time => time <= now && now - time < 86400000);
  state.restarts = events;
  if (state.lastAt && (now < state.lastAt || now - state.lastAt > policy.maxSampleGapMs)) { delete state.failureAt; delete state.attempted; }
  state.lastAt = now;
  if (!sample?.reachable) { delete state.failureAt; return { state, action: 'none', reason: sample?.externalHealthy ? 'ssh-unavailable-service-healthy' : 'host-unreachable-cloud-reboot-not-configured' }; }
  if (state.bootId !== sample.bootId) { state.bootId = sample.bootId; delete state.failureAt; delete state.attempted; }
  if (sample.uptimeSeconds < policy.bootGraceSeconds) { delete state.failureAt; delete state.attempted; return { state, action: 'none', reason: 'boot-grace' }; }
  if (sample.serviceState === 'inactive' && sample.serviceResult === 'success') { delete state.failureAt; return { state, action: 'none', reason: 'service-intentionally-stopped' }; }
  if (sample.consoleHealthy || sample.externalHealthy) { delete state.failureAt; delete state.attempted; return { state, action: 'none', reason: sample.onebotConnected === false ? 'qq-disconnected-only' : 'healthy' }; }
  state.failureAt ??= now;
  if (now - state.failureAt < policy.failureMs) return { state, action: 'none', reason: 'confirming-failure' };
  if (state.attempted) return { state, action: 'none', reason: 'service-recovery-attempted-cloud-reboot-not-configured' };
  if (events.length >= policy.dailyRestarts || events.some(time => now - time < policy.cooldownMs)) return { state, action: 'none', reason: 'restart-limit' };
  // Reserve before the external write. A lost SSH reply must never cause a repeat restart.
  state.attempted = true; state.restarts.push(now);
  return { state, action: 'restart-service', reason: 'persistent-console-failure' };
}

function command(binary, args, input = '', timeout = 15000) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let output = ''; let settled = false;
    const timer = setTimeout(() => { child.kill('SIGKILL'); finish(new Error('recovery command timeout')); }, timeout);
    const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(timer); if (error) reject(error); else resolve(value); };
    child.stdout.on('data', chunk => { output += chunk.toString(); if (output.length > 65536) { child.kill('SIGKILL'); finish(new Error('recovery response too large')); } });
    child.stderr.resume(); child.stdin.on('error', () => {});
    child.once('error', () => finish(new Error('recovery command unavailable')));
    child.once('close', code => finish(code === 0 ? null : new Error('recovery command failed'), output));
    child.stdin.end(input);
  });
}

async function read(file) { try { return await fs.promises.readFile(file, 'utf8'); } catch { return ''; } }

export async function recoverySnapshot(env = process.env) {
  const service = env.QQ_AGENT_SERVICE || 'qq-agent-linux.service';
  if (!/^[a-zA-Z0-9_-]+\.service$/.test(service)) throw new Error('Invalid recovery service');
  const port = Number(env.QQ_AGENT_CONSOLE_PORT || 3210);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid recovery port');
  const values = await Promise.all([read('/proc/uptime'), read('/proc/sys/kernel/random/boot_id'), read('/proc/meminfo'),
    read('/proc/vmstat'), read('/proc/pressure/io'), read('/proc/diskstats'),
    command('systemctl', ['--user', 'show', service, '--property=MainPID,ActiveState,Result'], '', 3000).catch(() => '')]);
  const [uptime, bootId, memory, vm, pressure, disks, serviceText] = values;
  const serviceInfo = Object.fromEntries(serviceText.trim().split('\n').map(line => line.split('=')));
  const fields = text => Object.fromEntries(text.trim().split('\n').map(line => line.trim().split(/[:\s]+/)).filter(row => row.length > 1).map(row => [row[0], Number(row[1])]));
  const mem = fields(memory); const stats = fields(vm); const pid = Number(serviceInfo.MainPID) || 0;
  const processIo = pid ? fields(await read(`/proc/${pid}/io`)) : {};
  const processStatus = pid ? fields(await read(`/proc/${pid}/status`)) : {};
  let health = null;
  try {
    const response = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(4000), redirect: 'error' });
    if (response.ok) health = await response.json();
  } catch { /* A bounded failed health probe is itself a diagnostic result. */ }
  return { at: new Date().toISOString(), reachable: true, bootId: bootId.trim(), uptimeSeconds: Number(uptime.split(' ')[0]) || 0,
    consoleHealthy: health?.ok === true, onebotConnected: health?.onebotConnected === true,
    pid, serviceState: serviceInfo.ActiveState || 'unknown', serviceResult: serviceInfo.Result || 'unknown', rssKiB: processStatus.VmRSS || 0, processReadBytes: processIo.read_bytes || 0, processWriteBytes: processIo.write_bytes || 0,
    memTotalKiB: mem.MemTotal, memAvailableKiB: mem.MemAvailable, swapUsedKiB: (mem.SwapTotal || 0) - (mem.SwapFree || 0),
    swapInPages: stats.pswpin, swapOutPages: stats.pswpout,
    ioPressure: pressure.trim().split('\n').filter(Boolean),
    disks: disks.trim().split('\n').flatMap(line => { const row = line.trim().split(/\s+/); return /^(?:[vs]d[a-z]+|nvme\d+n\d+)$/.test(row[2])
      ? [{ name: row[2], reads: Number(row[3]), readSectors: Number(row[5]), writes: Number(row[7]), writeSectors: Number(row[9]), inFlight: Number(row[11]), ioMs: Number(row[12]) }] : []; }) };
}

function writeState(directory, state) {
  const temp = path.join(directory, `state-${process.pid}.tmp`);
  fs.writeFileSync(temp, JSON.stringify(state), { mode: 0o600 }); fs.renameSync(temp, path.join(directory, 'state.json'));
}

function record(directory, sample) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const date = new Date().toISOString().slice(0, 10);
  const file = path.join(directory, `samples-${date}.jsonl`);
  if (!fs.existsSync(file) || fs.statSync(file).size < 2 * 1024 * 1024) fs.appendFileSync(file, JSON.stringify(sample) + '\n', { mode: 0o600 });
  const files = fs.readdirSync(directory).filter(name => /^samples-\d{4}-\d{2}-\d{2}\.jsonl$/.test(name)).sort();
  for (const name of files.slice(0, -7)) fs.unlinkSync(path.join(directory, name));
}

export async function recoveryTarget(args = [], env = process.env) {
  let input = ''; for await (const chunk of process.stdin) { input += chunk; if (input.length > 1024) throw new Error('Recovery request too large'); }
  const request = JSON.parse(input);
  if (request.action === 'probe') {
    const snapshot = await recoverySnapshot(env);
    if (args.includes('--confirm')) {
      if (!env.QQ_RECOVERY_DIR) throw new Error('QQ_RECOVERY_DIR required');
      record(path.resolve(env.QQ_RECOVERY_DIR), snapshot);
    }
    process.stdout.write(JSON.stringify(snapshot)); return 0;
  }
  if (request.action !== 'restart-service' || !args.includes('--confirm')) throw new Error('Unsupported or unconfirmed recovery action');
  const service = env.QQ_AGENT_SERVICE || 'qq-agent-linux.service';
  if (!/^[a-zA-Z0-9_-]+\.service$/.test(service)) throw new Error('Invalid recovery service');
  // Inhibit recovery during standard deployments; never bypass an operator's explicit stop/pause.
  const snapshot = await recoverySnapshot(env);
  if (snapshot.uptimeSeconds < 600 || snapshot.consoleHealthy) { process.stdout.write(JSON.stringify({ skipped: true })); return 0; }
  if (env.QQ_AGENT_DATA_DIR && fs.existsSync(path.join(env.QQ_AGENT_DATA_DIR, '.deploy.lock'))) throw new Error('Deployment in progress');
  if (snapshot.serviceState === 'inactive' && snapshot.serviceResult === 'success') throw new Error('Agent intentionally stopped');
  if (env.QQ_AGENT_DATA_DIR) {
    const cfg = JSON.parse(await fs.promises.readFile(path.join(env.QQ_AGENT_DATA_DIR, 'config.json'), 'utf8'));
    if (cfg.runtime?.paused === true || cfg.runtime?.mode === 'observe') throw new Error('Agent intentionally paused or observing');
  }
  await command('systemctl', ['--user', 'restart', '--no-block', service], '', 5000);
  process.stdout.write(JSON.stringify({ accepted: true })); return 0;
}

export async function recoveryWatch(args = [], env = process.env) {
  const confirm = args.includes('--confirm');
  for (const name of ['QQ_RECOVERY_HOST', 'QQ_RECOVERY_KEY', 'QQ_RECOVERY_KNOWN_HOSTS', 'QQ_RECOVERY_DIR']) if (!env[name]) throw new Error(`${name} required`);
  if (!/^[a-zA-Z0-9_-]+@[a-zA-Z0-9.-]+$/.test(env.QQ_RECOVERY_HOST)) throw new Error('Invalid recovery SSH host');
  const sshArgs = ['-i', env.QQ_RECOVERY_KEY, '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
    '-o', `UserKnownHostsFile=${env.QQ_RECOVERY_KNOWN_HOSTS}`, '-o', 'ConnectTimeout=5', '-o', 'ConnectionAttempts=1', env.QQ_RECOVERY_HOST];
  const remote = action => command('ssh', sshArgs, JSON.stringify({ action }), 20000).then(raw => JSON.parse(raw));
  const directory = path.resolve(env.QQ_RECOVERY_DIR);
  let previous = {}; try { previous = JSON.parse(fs.readFileSync(path.join(directory, 'state.json'), 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw new Error('Recovery state invalid; refusing recovery'); }
  const external = async () => {
    if (!env.QQ_RECOVERY_HEALTH_URL) return false;
    try { const res = await fetch(env.QQ_RECOVERY_HEALTH_URL, { signal: AbortSignal.timeout(4000), redirect: 'error' }); return res.ok && (await res.json()).ok === true; } catch { return false; }
  };
  const [snapshot, externalHealthy] = await Promise.all([remote('probe').catch(() => ({ reachable: false })), external()]);
  const sample = { ...snapshot, externalHealthy };
  const decision = recoveryDecision(previous, sample);
  let result = { action: decision.action, reason: decision.reason, serverRebootEnabled: false };
  if (confirm) {
    record(directory, { at: new Date().toISOString(), ...sample, ...result });
    writeState(directory, decision.state);
    if (decision.action === 'restart-service') {
      // At most one request per incident. Unknown outcomes are held rather than retried.
      try { result = { ...result, recovery: await remote('restart-service') }; }
      catch { result = { ...result, recovery: 'unknown-no-retry' }; }
    }
  }
  process.stdout.write(JSON.stringify({ ...result, confirmed: confirm, reachable: sample.reachable, consoleHealthy: sample.consoleHealthy }) + '\n');
  return 0;
}

// Minimal worker deployment on a remote monitoring host needs no application dependencies.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const worker = process.argv[2] === 'target' ? recoveryTarget : process.argv[2] === 'watch' ? recoveryWatch : null;
  if (!worker) throw new Error('Expected target or watch');
  worker(process.argv.slice(3)).catch(() => { process.stderr.write('Recovery worker failed; no further action taken\n'); process.exitCode = 1; });
}
