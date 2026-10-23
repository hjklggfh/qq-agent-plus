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
    this.entries.set(definition.id, { definition, started: false, fingerprint: null, error: false, changedAt: 0 });
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
        catch (error) { entry.error = true; this.log(`[background] ${entry.definition.id} stop failed:`, error?.message || error); }
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
      try { detail = def.status?.() || {}; } catch { failed = true; }
      failed ||= detail.failed === true;
      const enabled = def.enabled ? def.enabled(config) === true : true;
      // Only an explicit scalar allowlist crosses the API boundary.
      return { id: def.id, name: def.name, featureId: def.featureId || null,
        enabled, state: failed ? 'error' : !this.active ? 'stopped' : !enabled ? 'disabled'
          : detail.running === true ? 'running' : entry.started ? 'waiting' : 'stopped',
        changedAt: entry.changedAt, nextRunAt: Number(detail.nextRunAt) || null,
        lastRunAt: Number(detail.lastRunAt) || null, needsReview: detail.needsReview === true,
        schedule: def.schedule || '', error: failed ? '后台任务管理异常，请查看服务日志' : '' };
    });
  }
}
