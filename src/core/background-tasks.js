import { TASK_FAILURE_REASONS } from './task-observation.js';

const timestamp = value => Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : null;

// Owns lifecycle coordination, not business schedules or external-write retries.
export class BackgroundTaskRegistry {
  constructor({ config, now = () => Date.now(), log = () => {} }) {
    this.config = config;
    this.now = now;
    this.log = log;
    this.entries = new Map();
    this.active = false;
    this.chain = Promise.resolve();
  }
  register(definition) {
    if (this.active) throw new Error('Cannot register a background task after startup');
    if (!/^[a-z][a-z0-9-]*$/.test(definition.id) || this.entries.has(definition.id)
      || typeof definition.start !== 'function' || typeof definition.stop !== 'function') throw new Error('Invalid or duplicate background task');
    this.entries.set(definition.id, { definition, started: false, fingerprint: null, error: false, changedAt: 0,
      lastErrorAt: 0, failureReason: '' });
    return this;
  }
  enqueue(operation) {
    const result = this.chain.then(operation);
    this.chain = result.catch(() => {});
    return result;
  }
  start() {
    return this.enqueue(async () => {
      if (this.active) return;
      this.active = true;
      await this.sync();
    });
  }
  reconcile() { return this.enqueue(() => this.active ? this.sync() : undefined); }
  async sync() {
    const config = this.config();
    for (const entry of this.entries.values()) {
      const def = entry.definition;
      const wanted = def.enabled ? def.enabled(config) === true : true;
      const fingerprint = JSON.stringify(def.configKey ? config[def.configKey] || {} : {});
      if (fingerprint === entry.fingerprint) continue;
      // Record before invoking a hook: a failed start is not automatically replayed.
      entry.fingerprint = fingerprint;
      const operation = !wanted ? '停止' : !entry.started ? '启动' : '配置同步';
      try {
        if (!wanted) {
          if (entry.started || entry.error) await def.stop();
          entry.started = false;
        } else if (!entry.started) {
          await def.start();
          entry.started = true;
        } else if (def.reconfigure) await def.reconfigure();
        entry.error = false;
      } catch (error) {
        entry.error = true;
        entry.lastErrorAt = this.now();
        entry.failureReason = `${operation}失败，请检查服务日志`;
        // Best-effort cleanup of a partially started scheduler, without retrying it.
        try { await def.stop(); } catch { /* Other tasks must remain manageable. */ }
        entry.started = false;
        this.log(`[background] ${def.id} lifecycle failed:`, error?.message || error);
      }
      entry.changedAt = this.now();
    }
  }
  stop() {
    return this.enqueue(async () => {
      this.active = false;
      await Promise.allSettled([...this.entries.values()].reverse().map(async entry => {
        try { await entry.definition.stop(); entry.error = false; }
        catch (error) {
          entry.error = true; entry.lastErrorAt = this.now(); entry.failureReason = '停止失败，请检查服务日志';
          this.log(`[background] ${entry.definition.id} stop failed:`, error?.message || error);
        }
        finally { entry.started = false; entry.fingerprint = null; entry.changedAt = this.now(); }
      }));
    });
  }
  snapshot() {
    const config = this.config();
    return [...this.entries.values()].map(entry => {
      const def = entry.definition;
      let detail = {};
      let failed = entry.error;
      try { detail = def.status?.() || {}; } catch { failed = true; detail.failureCode = 'status'; }
      failed ||= detail.failed === true;
      const enabled = def.enabled ? def.enabled(config) === true : true;
      const detailErrorAt = timestamp(detail.lastErrorAt) || 0;
      const lifecycleFailure = entry.error || entry.lastErrorAt > detailErrorAt;
      const failureReason = detail.failureCode === 'status' ? '状态读取失败，请检查服务日志'
        : lifecycleFailure ? entry.failureReason : Object.hasOwn(def.failureReasons || {}, detail.failureCode)
          ? def.failureReasons[detail.failureCode] : Object.hasOwn(TASK_FAILURE_REASONS, detail.failureCode)
            ? TASK_FAILURE_REASONS[detail.failureCode] : '';
      // Only an explicit scalar allowlist crosses the API boundary.
      return { id: def.id, name: def.name, featureId: def.featureId || null,
        enabled, state: failed ? 'error' : !this.active ? 'stopped' : !enabled ? 'disabled'
          : detail.running === true ? 'running' : entry.started ? 'waiting' : 'stopped',
        changedAt: entry.changedAt, nextRunAt: this.active && enabled ? timestamp(detail.nextRunAt) : null,
        nextKind: detail.nextKind === 'schedule' ? 'schedule' : 'check',
        lastRunAt: timestamp(detail.lastRunAt), needsReview: detail.needsReview === true,
        lastSuccessAt: timestamp(detail.lastSuccessAt),
        successKind: detail.successKind === 'delivery' ? 'delivery' : 'check',
        lastErrorAt: Math.max(detailErrorAt, entry.lastErrorAt) || null,
        failureReason,
        schedule: def.schedule || '', error: failed ? '后台任务异常，请查看失败原因与服务日志' : '' };
    });
  }
}
