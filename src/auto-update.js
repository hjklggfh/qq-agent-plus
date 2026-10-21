import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { normalizeUpdateNetworkSettings } from './update-network.js';

const STATE_FILE = 'auto-update.json';
const REQUEST_FILE = 'auto-update-request.json';
const ACTIVE_STATES = new Set(['queued', 'checking', 'testing', 'deploying']);
const REQUEST_MODES = new Set(['manual', 'scheduled', 'probe']);
// 活跃状态超过这个时长还不动，就当它卡住了：不再抑制"发现新版本"提示，让人能再点一次
const PENDING_TTL_MS = 30 * 60 * 1000;
const STATE_LOCK_WAIT_MS = 5_000;
const STATE_LOCK_STALE_MS = 30_000;
const lockSleep = new globalThis.Int32Array(new globalThis.SharedArrayBuffer(4));

function cleanText(value, max = 1200) {
  return String(value ?? '')
    .replace(/\bBearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/([?&](?:token|key|secret|password|authorization)=)[^&\s]+/gi, '$1[redacted]')
    .replace(/\0/g, '')
    .trim()
    .slice(0, max);
}

function readObject(file, fallback = {}) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed
      : fallback;
  } catch {
    return fallback;
  }
}

function writeObject(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temp, file);
  fs.chmodSync(file, 0o600);
}

function updateError(message, httpStatus = 409) {
  return Object.assign(new Error(message), { httpStatus });
}

export function autoUpdatePaths(dataDir) {
  const root = path.resolve(dataDir);
  return {
    state: path.join(root, STATE_FILE),
    stateLock: path.join(root, `${STATE_FILE}.lock`),
    request: path.join(root, REQUEST_FILE),
    lock: path.join(root, '.auto-update.lock'),
    repository: path.join(root, 'update-repository.git'),
    workRoot: path.join(root, 'update-work')
  };
}

// The agent and the independent updater both call writeAutoUpdateState. Keep the
// read/merge/write in one cross-process critical section; the updater's own
// .auto-update.lock only prevents two updater instances from deploying together.
function withStateLock(dataDir, action) {
  const lock = autoUpdatePaths(dataDir).stateLock;
  fs.mkdirSync(path.dirname(lock), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + STATE_LOCK_WAIT_MS;
  const stale = (directory) => {
    let age;
    try { age = Date.now() - fs.statSync(directory).mtimeMs; }
    catch (error) { if (error?.code === 'ENOENT') return false; throw error; }
    if (age <= STATE_LOCK_STALE_MS) return false;
    try {
      const pid = Number(fs.readFileSync(path.join(directory, 'owner'), 'utf8'));
      if (Number.isInteger(pid) && pid > 0) {
        try { process.kill(pid, 0); return false; }
        catch (error) { if (error?.code !== 'ESRCH') return false; }
      }
    } catch (error) { if (error?.code !== 'ENOENT') throw error; }
    return true;
  };
  while (true) {
    try {
      fs.mkdirSync(lock, { mode: 0o700 });
      fs.writeFileSync(path.join(lock, 'owner'), String(process.pid), { mode: 0o600 });
      break;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }
    // A dead process may leave the directory behind. A separate takeover
    // directory serializes stale-lock removal so two waiters cannot remove
    // each other's newly acquired lock.
    const takeover = `${lock}.takeover`;
    try {
      if (stale(lock)) {
        try {
          fs.mkdirSync(takeover, { mode: 0o700 });
          try {
            if (stale(lock)) {
              fs.rmSync(lock, { recursive: true, force: true });
            }
          } finally { fs.rmdirSync(takeover); }
        } catch (error) {
          if (error?.code !== 'EEXIST' && error?.code !== 'ENOENT') throw error;
        }
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    if (Date.now() >= deadline) throw new Error('自动更新状态文件正被其他进程写入，请稍后重试');
    Atomics.wait(lockSleep, 0, 0, 10);
  }
  try {
    return action();
  } finally {
    fs.rmSync(lock, { recursive: true, force: true });
  }
}

export function readAutoUpdateState(dataDir) {
  return readObject(autoUpdatePaths(dataDir).state, {
    version: 1,
    status: 'idle',
    mode: '',
    phase: '',
    startedAt: 0,
    updatedAt: 0,
    completedAt: 0,
    lastCheckAt: 0,
    lastSuccessAt: 0,
    currentRevision: '',
    targetRevision: '',
    error: '',
    autoDisabled: false,
    connectivity: {
      status: 'unknown',
      checkedAt: 0,
      attempts: 0,
      latencyMs: 0,
      repository: '',
      branch: '',
      revision: '',
      error: ''
    },
    notification: {
      pending: false,
      ownerUin: '',
      sentAt: 0,
      error: ''
    }
  });
}

export function writeAutoUpdateState(dataDir, patchOrFactory) {
  return withStateLock(dataDir, () => {
    const current = readAutoUpdateState(dataDir);
    const patch = typeof patchOrFactory === 'function' ? patchOrFactory.call(null, current) : patchOrFactory;
    if (patch == null) return current;
    const next = {
      ...current,
      ...patch,
      version: 1,
      updatedAt: Date.now(),
      connectivity: {
        ...(current.connectivity || {}),
        ...(patch.connectivity || {})
      },
      notification: {
        ...(current.notification || {}),
        ...(patch.notification || {})
      }
    };
    writeObject(autoUpdatePaths(dataDir).state, next);
    return next;
  });
}

export function writeAutoUpdateRequest(dataDir, mode = 'manual') {
  const normalizedMode = REQUEST_MODES.has(mode) ? mode : 'scheduled';
  const request = {
    version: 1,
    mode: normalizedMode,
    requestedAt: Date.now()
  };
  writeObject(autoUpdatePaths(dataDir).request, request);
  return request;
}

/**
 * 有没有一个"已经提交、还没跑完"的更新。
 * 控制台的「发现新版本」提示要用它：用户点过「立即更新」之后就别再弹同一个版本了 ——
 * 部署完成前 deployed-revision 还是旧的，光比版本永远会认为"有新版本没装"，
 * 于是每次刷新都弹一遍，看起来像"更新没生效"（2026-09-21 反馈）。
 * 超过 PENDING_TTL_MS 还停在活跃状态就当卡住了，返回 null，让人能再点一次。
 * @returns {{status: string, mode: string, version: string, revision: string, updatedAt: number} | null}
 */
export function autoUpdatePending(dataDir) {
  const state = readAutoUpdateState(dataDir);
  const status = String(state.status || '');
  if (!ACTIVE_STATES.has(status)) return null;
  // 基准是"最近一次进度"：
  //   progressAt —— requestManual 与更新器**每个阶段**都写（正常更新会一直续期）；
  //   startedAt  —— 兜底（老版本更新器没写 progressAt）；
  //   updatedAt  —— 最后兜底。
  // ⚠️ 不能直接用 updatedAt 当主基准：checkForUpdate 存提示也会调 writeAutoUpdateState，
  //    控制台一开就把基准推到现在，于是"卡住 30 分钟就放开"永远不成立（更新器被 kill 后
  //    提示被永久压住、手动更新按钮一直是灰的）。只用 startedAt 也不够：慢机器上一轮正常
  //    更新就可能超过 30 分钟（npm ci 10 分钟 + 单测 20 分钟 + 部署 20 分钟），会被误判成卡住。
  const base = Number(state.progressAt || 0) || Number(state.startedAt || 0) || Number(state.updatedAt || 0);
  if (!base || Date.now() - base > PENDING_TTL_MS) return null;
  return {
    status,
    mode: String(state.mode || ''),
    version: String(state.targetVersion || ''),
    revision: String(state.targetRevision || ''),
    startedAt: Number(state.startedAt || 0),
    progressAt: Number(state.progressAt || 0),
    updatedAt: Number(state.updatedAt || 0)
  };
}

export function consumeAutoUpdateRequest(dataDir) {
  const file = autoUpdatePaths(dataDir).request;
  const request = readObject(file, null);
  try { fs.unlinkSync(file); } catch { /* no request */ }
  if (
    !request
    || !REQUEST_MODES.has(request.mode)
    || Date.now() - Number(request.requestedAt || 0) > 60 * 60 * 1000
  ) {
    return null;
  }
  return request;
}

/**
 * Auto update shares the application's one global administrator.
 *
 * The updater runner can execute directly against config.json before the main
 * process has had a chance to migrate an old install. Therefore legacy owner
 * paths are read only when the file has no admin section at all. Once admin
 * exists—even with an intentionally empty ownerUin—it is the sole truth.
 */
export function autoUpdateOwner(config = {}) {
  const hasAdmin = Boolean(
    config.admin
    && typeof config.admin === 'object'
    && !Array.isArray(config.admin)
  );
  if (hasAdmin) return String(config.admin.ownerUin || '').trim();
  return String(
    config.autoUpdate?.ownerUin
    || config.incidentPilot?.ownerUin
    || config.identityPilot?.friendProposal?.ownerUin
    || ''
  ).trim();
}

export function sanitizeUpdateError(error) {
  return cleanText(error?.message ?? error ?? '更新失败');
}

export class AutoUpdateManager {
  constructor({
    appDir,
    dataDir,
    config,
    updateConfig,
    notify,
    notifyAvailable = () => true,
    emit = null,
    runSystemctl = null,
    log = console.log
  }) {
    this.appDir = path.resolve(appDir);
    this.dataDir = path.resolve(dataDir);
    this.config = config;
    this.updateConfig = updateConfig;
    this.notify = notify;
    this.notifyAvailable = notifyAvailable;
    this.emit = typeof emit === 'function' ? emit : () => {};
    this.runSystemctl = runSystemctl || ((args) => spawnSync(
      'systemctl',
      ['--user', ...args],
      { encoding: 'utf8', timeout: 15_000 }
    ));
    this.log = log;
    this.notificationTimer = null;
    this.notificationKickoff = null;
    this.notificationTask = null;
  }

  deployment() {
    const value = readObject(path.join(this.appDir, '.deployment.json'), null);
    if (!value?.service || path.resolve(value.root || '') !== this.appDir) return null;
    return value;
  }

  serviceName() {
    const deployment = this.deployment();
    return deployment
      ? String(deployment.updateService || `${deployment.service}-update`)
      : '';
  }

  installed() {
    return Boolean(this.serviceName())
      && fs.existsSync(path.join(this.appDir, 'scripts', 'auto-update.mjs'));
  }

  serviceActive() {
    if (!this.installed()) return false;
    const result = this.runSystemctl([
      '--quiet',
      'is-active',
      `${this.serviceName()}.service`
    ]);
    return result?.status === 0;
  }

  status() {
    const cfg = this.config();
    const settings = cfg.autoUpdate || {};
    const network = normalizeUpdateNetworkSettings(settings);
    const state = readAutoUpdateState(this.dataDir);
    const intervalMs = Math.max(1, Number(settings.intervalHours) || 6) * 60 * 60 * 1000;
    // 与「发现新版本」提示用同一套判据（autoUpdatePending）：一处说"在跑"、另一处说"卡住"
    // 会让用户卡在"提示弹出来了、按钮却是灰的"。基准见 autoUpdatePending 的注释。
    const busy = this.serviceActive() || autoUpdatePending(this.dataDir) !== null;
    let deployedRevision = '';
    try {
      deployedRevision = fs.readFileSync(
        path.join(this.dataDir, 'deployed-revision'),
        'utf8'
      ).trim();
    } catch { /* not deployed through deploy.sh yet */ }
    return {
      installed: this.installed(),
      enabled: settings.enabled === true && state.autoDisabled !== true,
      busy,
      ownerUin: autoUpdateOwner(cfg),
      repository: String(settings.repository || ''),
      branch: String(settings.branch || 'main'),
      intervalHours: Number(settings.intervalHours) || 6,
      ...network,
      nextCheckAt: settings.enabled === true
        ? Math.max(Date.now(), Number(state.lastCheckAt || 0) + intervalMs)
        : 0,
      ...state,
      // 以 data/deployed-revision 为准：那是每次部署都会重写的"这台机器现在跑的版本"，
      // 而 state.currentRevision 只是"上一次更新器自己部署时"的快照。反过来会让控制台
      // 显示与实际不符的版本（2026-09-29 实测：线上跑的是未提交树 source-…，控制台却显示
      // 4 天前的提交 cd4e1003）。文件缺失（没走 deploy.sh 部署过）才回落到状态里的值。
      currentRevision: deployedRevision || state.currentRevision
    };
  }

  configure(options = {}) {
    const current = this.config();
    const autoUpdate = current.autoUpdate || {};
    const next = {
      ...autoUpdate,
      intervalHours: options.intervalHours ?? autoUpdate.intervalHours ?? 6
    };
    // ownerUin is accepted only as a backwards-compatible API alias. Route it
    // immediately into admin.ownerUin; autoUpdate.ownerUin remains a config
    // compatibility mirror maintained by the central config layer.
    const adminPatch = options.ownerUin === undefined
      ? null
      : { ownerUin: String(options.ownerUin || '').trim() };
    for (const key of [
      'branch',
      'networkRetries',
      'retryBaseMs',
      'retryMaxMs',
      'connectivityTimeoutSeconds',
      'fetchTimeoutSeconds',
      'forceHttp11',
      'disableOnFailure'
    ]) {
      if (options[key] !== undefined) next[key] = options[key];
    }
    const cfg = this.updateConfig({
      autoUpdate: next,
      ...(adminPatch ? { admin: adminPatch } : {})
    });
    this.emit('auto-update', this.status());
    return cfg.autoUpdate;
  }

  resume({ ownerUin, intervalHours = 6 } = {}) {
    const current = this.config();
    const adminPatch = ownerUin === undefined
      ? null
      : { ownerUin: String(ownerUin || '').trim() };
    const cfg = this.updateConfig({
      autoUpdate: {
        ...(current.autoUpdate || {}),
        enabled: true,
        intervalHours
      },
      ...(adminPatch ? { admin: adminPatch } : {})
    });
    // 更新正在跑时不要把它写成 idle：那会清掉"已提交未跑完"的抑制与 busy 判据，
    // 让控制台一边显示在跑、一边又能再点一次（直接调接口才会遇到，2026-09-22 审查发现）
    if (!this.serviceActive() && !autoUpdatePending(this.dataDir)) {
      writeAutoUpdateState(this.dataDir, {
        status: 'idle',
        phase: '',
        error: '',
        autoDisabled: false,
        completedAt: Date.now(),
        lastCheckAt: 0
      });
    }
    this.emit('auto-update', this.status());
    return cfg.autoUpdate;
  }

  pause() {
    const cfg = this.updateConfig({
      autoUpdate: {
        ...(this.config().autoUpdate || {}),
        enabled: false
      }
    });
    if (!this.serviceActive()) {
      writeAutoUpdateState(this.dataDir, {
        status: 'disabled',
        phase: '',
        completedAt: Date.now()
      });
    }
    this.emit('auto-update', this.status());
    return cfg.autoUpdate;
  }

  requestManual({ version = '' } = {}) {
    if (!this.installed()) {
      throw updateError('自动更新服务尚未安装，请先用 deploy.sh 部署当前版本');
    }
    let cfg = this.config();
    const probeOnly = cfg.autoUpdate?.nextAction === 'probe';
    if (probeOnly) {
      cfg = this.updateConfig({
        autoUpdate: {
          ...(cfg.autoUpdate || {}),
          nextAction: ''
        }
      });
    }
    const ownerUin = autoUpdateOwner(cfg);
    if (!probeOnly) {
      if (!/^\d{5,15}$/.test(ownerUin)) {
        throw updateError('请先配置全局管理员 QQ', 400);
      }
      if (
        cfg.allowAllWhenEmpty !== true
        && !(cfg.allow?.private || []).map(String).includes(ownerUin)
      ) {
        throw updateError('全局管理员 QQ 必须同时加入私聊白名单', 400);
      }
    }
    const current = this.status();
    if (current.busy) throw updateError('已有更新任务正在运行');

    const mode = probeOnly ? 'probe' : 'manual';
    writeAutoUpdateRequest(this.dataDir, mode);
    // 记下这次要更到哪个版本：控制台的「发现新版本」提示要用它判断"这个版本的更新
    // 已经提交过了，别再弹"（更新器跑到能解析 tag 的阶段才会自己写 targetVersion，
    // 在那之前状态里是空的，只靠版本号比对会一直弹）。
    const targetVersion = mode === 'manual' ? cleanText(version, 64).trim() : '';
    writeAutoUpdateState(this.dataDir, {
      status: 'queued',
      mode,
      phase: probeOnly ? 'connectivity' : 'queued',
      startedAt: Date.now(),
      completedAt: 0,
      error: '',
      // 没带版本也要显式清空：不然上一次的版本会留在状态里，前端拿它比对会误判
      targetVersion,
      progressAt: Date.now(),
      ...(probeOnly ? {
        connectivity: {
          status: 'queued',
          checkedAt: 0,
          attempts: 0,
          latencyMs: 0,
          repository: String(cfg.autoUpdate?.repository || ''),
          branch: String(cfg.autoUpdate?.branch || 'main'),
          revision: '',
          error: ''
        }
      } : {})
    });
    const result = this.runSystemctl([
      '--no-block',
      'start',
      `${this.serviceName()}.service`
    ]);
    if (result?.status !== 0) {
      const message = cleanText(result?.stderr || '无法启动自动更新服务');
      if (probeOnly) {
        writeAutoUpdateState(this.dataDir, {
          status: 'idle',
          mode: 'probe',
          phase: 'complete',
          completedAt: Date.now(),
          error: '',
          autoDisabled: false,
          connectivity: {
            status: 'failed',
            checkedAt: Date.now(),
            attempts: 0,
            latencyMs: 0,
            error: message
          },
          notification: { pending: false, deliveryUnknown: false }
        });
        throw updateError(message);
      }
      const policy = normalizeUpdateNetworkSettings(cfg.autoUpdate || {});
      if (policy.disableOnFailure) {
        this.updateConfig({
          autoUpdate: {
            ...(this.config().autoUpdate || {}),
            enabled: false
          }
        });
      }
      writeAutoUpdateState(this.dataDir, {
        status: 'failed',
        phase: 'launch',
        completedAt: Date.now(),
        error: message,
        autoDisabled: policy.disableOnFailure,
        notification: {
          pending: true,
          attemptId: randomUUID(),
          deliveryUnknown: false,
          ownerUin,
          sentAt: 0,
          error: ''
        }
      });
      this.resumeNotifications();
      throw updateError(message);
    }
    this.emit('auto-update', this.status());
    return this.status();
  }

  start() {
    this.stop();
    this.notificationTimer = setInterval(() => {
      this.resumeNotifications();
    }, 30_000);
    this.notificationTimer.unref?.();
    this.notificationKickoff = setTimeout(() => {
      this.notificationKickoff = null;
      this.resumeNotifications();
    }, 2_000);
    this.notificationKickoff.unref?.();
  }

  stop() {
    clearInterval(this.notificationTimer);
    clearTimeout(this.notificationKickoff);
    this.notificationTimer = null;
    this.notificationKickoff = null;
  }

  resumeNotifications() {
    if (this.notificationTask) return this.notificationTask;
    this.notificationTask = this.#notifyPending()
      .catch((error) => this.log(`[auto-update] 管理员通知失败：${error?.message ?? error}`))
      .finally(() => { this.notificationTask = null; });
    return this.notificationTask;
  }

  async handlePendingFailure() {
    const state = readAutoUpdateState(this.dataDir);
    const policy = normalizeUpdateNetworkSettings(this.config().autoUpdate || {});
    if (
      state.status === 'failed'
      && state.autoDisabled === true
      && policy.disableOnFailure
      && this.config().autoUpdate?.enabled === true
    ) {
      this.updateConfig({
        autoUpdate: {
          ...(this.config().autoUpdate || {}),
          enabled: false
        }
      });
    }
    await this.resumeNotifications();
    return this.status();
  }

  async #notifyPending() {
    const state = readAutoUpdateState(this.dataDir);
    if (!state.notification?.pending || !this.notify || !this.notifyAvailable()) return state;
    const sameNotification = (current, expected) =>
      JSON.stringify(current.notification || {}) === JSON.stringify(expected || {});
    const ownerUin = String(
      state.notification.ownerUin || autoUpdateOwner(this.config())
    ).trim();
    if (!/^\d{5,15}$/.test(ownerUin)) {
      return writeAutoUpdateState(this.dataDir, (current) => sameNotification(current, state.notification) ? {
        notification: {
          ...current.notification,
          error: '未配置有效的全局管理员 QQ'
        }
      } : null);
    }
    const mode = state.mode === 'manual' ? '手动更新' : '定时更新';
    const currentEnabled = this.config().autoUpdate?.enabled === true;
    const action = state.autoDisabled === true
      ? '自动更新已停止。'
      : currentEnabled
        ? '自动更新保持启用，将在后续检查周期继续重试。'
        : '自动更新原本处于暂停状态，本次失败未改变开关。';
    const text = [
      '【QQ Agent 更新部署失败】',
      `方式：${mode}`,
      `阶段：${state.phase || 'unknown'}`,
      ...(state.targetRevision
        ? [`目标版本：${String(state.targetRevision).slice(0, 12)}`]
        : []),
      `结果：${cleanText(state.error || '未知错误', 600)}`,
      '',
      action,
      '处理入口：控制台 → 控制 → 更新部署'
    ].join('\n');
    let claimed = false;
    let sendingNotification = null;
    try {
      // 发送前先把状态落成"结果未知"：这条链路没有 outbox 那样的 sending 落盘，原来
      // 发送途中崩溃/重启的话 pending 还是 true，重启 resumeNotifications 会把同一条
      // 失败通知再发一遍。先落 unknown（pending=false）；确定没发出去的情况由下面的
      // catch 恢复成 pending 等重试，其余失败保持 unknown 等人工确认。
      const sending = writeAutoUpdateState(this.dataDir, (current) => {
        if (!sameNotification(current, state.notification)) return null;
        claimed = true;
        sendingNotification = { ...current.notification, pending: false, deliveryUnknown: true, ownerUin, error: '' };
        return { notification: sendingNotification };
      });
      if (!claimed) return sending; // a newer failure replaced this notification before we claimed it
      await this.notify(text, ownerUin);
      const updated = writeAutoUpdateState(this.dataDir, (current) =>
        sameNotification(current, sendingNotification) ? {
        notification: {
          ...current.notification,
          pending: false,
          ownerUin,
          sentAt: Date.now(),
          error: '',
          // 这一条已经确认发出去了，之前那条"结果未知"的标记不能留着 ——
          // 否则 data/auto-update.json 会一直显示"需人工确认"，与 docs/AUTO_UPDATE.md 的语义对不上。
          deliveryUnknown: false
        }
      } : null);
      this.emit('auto-update', this.status());
      return updated;
    } catch (error) {
      // 发送失败要分清"确定没发出去"和"结果未知"：只有前者能自动重试。这条通知走
      // onebot.sendText，超时属于结果未知。此前 pending 一直留着，于是 30 秒一次的定时器
      // 会把同一条【更新部署失败】反复发给管理员（项目规则：结果未知不外发重试）。
      const definitelyNotSent = error?.beforeWrite === true;
      if (claimed) writeAutoUpdateState(this.dataDir, (current) =>
        sameNotification(current, sendingNotification) ? {
        notification: {
          ...current.notification,
          pending: definitelyNotSent,
          ownerUin,
          error: cleanText(error?.message ?? error, 500),
          // 发送前已经把 deliveryUnknown 落成 true：确定没发出去时要显式归位 false，
          // 否则"未连接"这种可重试的失败也会被标成结果未知
          deliveryUnknown: !definitelyNotSent
        }
      } : null);
      throw error;
    }
  }
}
