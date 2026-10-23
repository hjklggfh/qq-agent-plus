import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { shanghaiDayStart, todayKey, minuteOfDayInZone } from '../core/util.js';

export const DEFAULT_DAILY_REPORT_CONTENT = Object.freeze({
  tokens: true, cost: true, status: true, uptime: true, cpu: true, memory: true, disk: true, io: true
});
export const DEFAULT_DAILY_REPORT_CONFIG = Object.freeze({ enabled: false, time: '23:00', content: DEFAULT_DAILY_REPORT_CONTENT });

export function validateDailyReportPatch(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('每日报告设置须为对象');
  for (const [key, value] of Object.entries(patch)) {
    if (!Object.hasOwn(DEFAULT_DAILY_REPORT_CONFIG, key)) throw new Error(`未知每日报告设置：${key}`);
    if (key === 'enabled' && typeof value !== 'boolean') throw new Error('每日报告开关须为布尔值');
    if (key === 'time' && (typeof value !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value))) throw new Error('汇报时间须为 HH:MM');
    if (key === 'content') {
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('发送内容须为对象');
      for (const [name, checked] of Object.entries(value)) {
        if (!Object.hasOwn(DEFAULT_DAILY_REPORT_CONTENT, name) || typeof checked !== 'boolean') throw new Error('发送内容选项无效');
      }
      if (!Object.values({ ...DEFAULT_DAILY_REPORT_CONTENT, ...value }).some(Boolean)) throw new Error('请至少选择一项发送内容');
    }
  }
}

export function dailyReportConfig(raw = {}) {
  try { validateDailyReportPatch(raw); return { ...DEFAULT_DAILY_REPORT_CONFIG, ...raw,
    content: { ...DEFAULT_DAILY_REPORT_CONTENT, ...raw.content } }; }
  catch { return { ...DEFAULT_DAILY_REPORT_CONFIG }; }
}

// 只读当前运行主机；Linux 使用 MemAvailable，避免把可回收缓存全算作占用。
export async function reportHostSnapshot(dataDir) {
  const host = { cpuCount: os.cpus().length, load: os.loadavg(), uptime: os.uptime(),
    processUptime: process.uptime(), rss: process.memoryUsage().rss,
    memoryTotal: os.totalmem(), memoryAvailable: os.freemem(), swapUsed: null, disk: null, io: null };
  try {
    const text = await fs.promises.readFile('/proc/meminfo', 'utf8');
    const mem = Object.fromEntries([...text.matchAll(/^(\w+):\s+(\d+)/gm)].map(m => [m[1], Number(m[2]) * 1024]));
    host.memoryAvailable = mem.MemAvailable ?? host.memoryAvailable;
    host.swapUsed = Math.max(0, mem.SwapTotal - mem.SwapFree);
  } catch { /* 非 Linux 主机降级为 os 指标。 */ }
  try {
    const info = await fs.promises.statfs(dataDir);
    host.disk = { total: info.blocks * info.bsize, available: info.bavail * info.bsize };
  } catch { /* 不把采集失败当作磁盘正常。 */ }
  try {
    const text = await fs.promises.readFile('/proc/pressure/io', 'utf8');
    host.io = Number(text.match(/^full .*?avg60=([\d.]+)/m)?.[1]);
    if (!Number.isFinite(host.io)) host.io = null;
  } catch { /* PSI 不可用。 */ }
  return host;
}

const gib = bytes => `${(bytes / 1073741824).toFixed(2)} GiB`;
const money = value => `¥${(Number(value) || 0).toFixed(4)}`;

export function formatDailyReport({ now, stats, host, connected, runtime, content = DEFAULT_DAILY_REPORT_CONTENT }) {
  const selected = { ...DEFAULT_DAILY_REPORT_CONTENT, ...content };
  const t = stats.totals;
  const clock = new Date(now + 8 * 3600000).toISOString().slice(11, 16);
  const lines = [`每日用量与服务器报告 · ${todayKey(now)}`,
    `统计：北京时间 00:00—${clock}（截至生成时，非完整全天）`];
  if (selected.tokens) lines.push(
    `Token：${t.totalTokens || 0}（输入 ${t.promptTokens || 0} / 输出 ${t.completionTokens || 0}）`,
    `缓存命中：${t.cachedTokens || 0}（已包含在输入中）；调用 ${t.runs || 0} 次`);
  if (selected.cost) {
    lines.push(`按量费用：${money(t.cost)}（配置价格 ${money(t.actualCost)} / 估算 ${money(t.estimateCost)}）`);
    if (t.unpricedCalls) lines.push(`未定价：${t.unpricedCalls} 次、${t.unpricedTokens || 0} Token，未计入费用，不代表免费`);
    if (t.flatCalls) lines.push(`包月/固定计费：${t.flatCalls} 次，固定支出单列，不按天重复计费`);
    for (const item of stats.billing?.flatItems || []) lines.push(`固定支出：${money(item.amount)}/${item.period === 'day' ? '日' : '月'}（非本日按量费用）`);
    if (t.localCalls) lines.push(`本地/不按量计费：${t.localCalls} 次`);
    lines.push('费用沿用总览今日成本口径；不含服务器租金及第三方非模型服务费用。');
  }
  if (['status', 'uptime', 'cpu', 'memory', 'disk', 'io'].some(key => selected[key])) lines.push('', '服务器当前状态');
  if (selected.status) lines.push(`Agent：${runtime?.paused ? '已暂停' : '运行中'} / ${runtime?.mode || '未知'}；QQ：${connected ? '已连接' : '未连接'}`);
  if (selected.uptime) lines.push(`主机运行 ${(host.uptime / 3600).toFixed(1)} 小时；Agent ${(host.processUptime / 3600).toFixed(1)} 小时`);
  if (selected.cpu) lines.push(`CPU：${host.cpuCount} 核；负载 1/5/15 分钟 ${host.load.map(n => n.toFixed(2)).join(' / ')}（非 CPU 使用率）`);
  if (selected.memory) lines.push(`内存：可用 ${gib(host.memoryAvailable)} / 总计 ${gib(host.memoryTotal)}；Agent RSS ${gib(host.rss)}`,
    `Swap 已用：${host.swapUsed == null ? '不可用' : gib(host.swapUsed)}`);
  if (selected.disk) lines.push(`数据目录所在磁盘：${host.disk ? `可用 ${gib(host.disk.available)} / 总计 ${gib(host.disk.total)}` : '采集不可用'}`);
  if (selected.io) lines.push(`I/O 压力 full avg60：${host.io == null ? '不可用' : `${host.io.toFixed(2)}%`}`);
  return lines.join('\n');
}

export class DailyReportManager {
  constructor(options) {
    this.options = options;
    this.timer = null;
    this.pending = null;
    this.controller = null;
    this.last = null;
    this.error = '';
  }
  settings() { return dailyReportConfig(this.options.config().dailyReport); }
  async preview(patch = {}, now = Date.now()) {
    validateDailyReportPatch(patch);
    const settings = this.settings();
    const content = { ...settings.content, ...patch.content };
    validateDailyReportPatch({ content });
    const [stats, host] = await Promise.all([
      this.options.usage({ start: shanghaiDayStart(now), end: now }), this.options.host()
    ]);
    return { text: formatDailyReport({ now, stats, host, connected: this.options.available(),
      runtime: this.options.config().runtime, content }), generatedAt: now };
  }
  status() {
    try {
      this.last = JSON.parse(fs.readFileSync(path.join(this.options.dataDir, 'daily-report.json'), 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') this.error = '报告状态文件不可读，请人工核查；不会自动重发。';
    }
    return { settings: this.settings(), last: this.last, error: this.error };
  }
  start() {
    if (this.timer) return;
    this.timer = setInterval(() => { this.tick().catch(() => {}); }, 30000);
    this.timer.unref?.();
    this.tick().catch(() => {});
  }
  enforce() { if (!this.settings().enabled) this.controller?.abort(); }
  async stop() {
    clearInterval(this.timer); this.timer = null;
    this.controller?.abort(); await this.pending?.catch(() => {});
  }
  tick(now = Date.now()) {
    if (this.pending) return this.pending;
    this.pending = this.run(now).then(() => { this.error = ''; }, error => {
      this.error = '报告生成或状态读写失败，本次未确认发送；请检查本地状态与磁盘。';
      throw error;
    }).finally(() => { this.pending = null; });
    return this.pending;
  }
  async run(now) {
    const cfg = this.options.config();
    const settings = this.settings();
    const [hours, minutes] = settings.time.split(':').map(Number);
    const owner = String(cfg.admin?.ownerUin || '');
    if (!settings.enabled || minuteOfDayInZone(now) < hours * 60 + minutes
      || !/^\d{5,15}$/.test(owner) || cfg.runtime?.mode !== 'active' || cfg.runtime?.paused
      || !this.options.available()) return;
    const file = path.join(this.options.dataDir, 'daily-report.json');
    let state;
    try { state = JSON.parse(await fs.promises.readFile(file, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw new Error('每日报告状态不可读，停止发送'); }
    if (state !== undefined && (!state || !/^\d{4}-\d{2}-\d{2}$/.test(state.day)
      || !['unknown', 'sent'].includes(state.outcome))) throw new Error('每日报告状态无效，停止发送');
    this.last = state || null;
    const day = todayKey(now);
    // Future keys also suppress delivery after a clock rollback.
    if (state?.day >= day) return;
    this.controller = new AbortController();
    const signal = AbortSignal.any([this.controller.signal, AbortSignal.timeout(60000)]);
    const [stats, host] = await Promise.all([
      this.options.usage({ start: shanghaiDayStart(now), end: now }),
      this.options.host()
    ]);
    signal.throwIfAborted();
    const current = this.options.config();
    if (!this.settings().enabled || this.settings().time !== settings.time || current.runtime?.mode !== 'active'
      || current.runtime?.paused || current.admin?.ownerUin !== owner || !this.options.available()) return;
    const text = formatDailyReport({ now, stats, host, connected: this.options.available(), runtime: current.runtime,
      content: this.settings().content });
    const save = async record => {
      const temp = `${file}.${process.pid}.tmp`;
      const handle = await fs.promises.open(temp, 'w', 0o600);
      try { await handle.writeFile(JSON.stringify(record)); await handle.sync(); }
      finally { await handle.close(); }
      await fs.promises.rename(temp, file);
      this.last = record;
    };
    // Persist before any QQ write; restart or unknown delivery must never replay.
    const record = { day, at: now, outcome: 'unknown', owner };
    await save(record);
    try {
      signal.throwIfAborted();
      const latest = this.options.config();
      if (!this.settings().enabled || latest.runtime?.mode !== 'active' || latest.runtime?.paused
        || latest.admin?.ownerUin !== owner || !this.options.available()) return;
      await this.options.send(owner, text, signal, `daily-report:${day}`);
      await save({ ...record, outcome: 'sent' });
    } catch {
      // Conservative hold, including partial delivery: no automatic repeat today.
      this.last = record;
    } finally { this.controller = null; }
  }
}
