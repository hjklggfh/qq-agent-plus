import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { observeTask, scheduleTaskObservation } from '../core/task-observation.js';
import { todayKey, minuteOfDayInZone } from '../core/util.js';
import { DEFAULT_ANTIGRAVITY_QUOTA, fetchAntigravityQuota, formatQuotaLines, quotaSourceConfig, validateQuotaSource } from './antigravity-quota.js';

export const DEFAULT_DAILY_REPORT_CONTENT = Object.freeze({
  tokens: true, cost: true, status: true, uptime: true, cpu: true, memory: true, disk: true, io: true,
  // 反代额度默认关闭：不是每套部署都有 Antigravity 面板，开了却没配密码会多一行"读取失败"。
  quota: false
});
export const DEFAULT_DAILY_REPORT_CONFIG = Object.freeze({ enabled: false, time: '23:00',
  content: DEFAULT_DAILY_REPORT_CONTENT, quota: DEFAULT_ANTIGRAVITY_QUOTA });

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
    if (key === 'quota') validateQuotaSource(value);
  }
}

export function dailyReportConfig(raw = {}) {
  try { validateDailyReportPatch(raw); return { ...DEFAULT_DAILY_REPORT_CONFIG, ...raw,
    content: { ...DEFAULT_DAILY_REPORT_CONTENT, ...raw.content },
    quota: quotaSourceConfig(raw.quota) }; }
  catch { return { ...DEFAULT_DAILY_REPORT_CONFIG, content: { ...DEFAULT_DAILY_REPORT_CONTENT },
    quota: quotaSourceConfig(DEFAULT_ANTIGRAVITY_QUOTA) }; }
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

// 统计窗口固定为"截至发送时刻的完整 24 小时"：报告设在 23:00，覆盖的就是
// 昨天 23:00 到今天 23:00；不是"当天零点到现在"那种越跑越短的口径。
export const REPORT_WINDOW_MS = 24 * 60 * 60 * 1000;
export function reportWindow(now) {
  return { start: now - REPORT_WINDOW_MS, end: now };
}

function beijingStamp(momentMs) {
  return new Date(momentMs + 8 * 3600000).toISOString().slice(5, 16).replace('T', ' ');
}

export function formatDailyReport({ now, stats, host, connected, runtime, content = DEFAULT_DAILY_REPORT_CONTENT, quota = null }) {
  const selected = { ...DEFAULT_DAILY_REPORT_CONTENT, ...content };
  const t = stats.totals;
  const window = reportWindow(now);
  const lines = [`每日用量与服务器报告 · ${todayKey(now)}`,
    `统计：北京时间 ${beijingStamp(window.start)} — ${beijingStamp(window.end)}（完整 24 小时）`];
  if (selected.tokens) lines.push(
    `Token：${t.totalTokens || 0}（输入 ${t.promptTokens || 0} / 输出 ${t.completionTokens || 0}）`,
    `缓存命中：${t.cachedTokens || 0}（已包含在输入中）；调用 ${t.runs || 0} 次`);
  if (selected.cost) {
    lines.push(`按量费用：${money(t.cost)}（配置价格 ${money(t.actualCost)} / 估算 ${money(t.estimateCost)}）`);
    if (t.unpricedCalls) lines.push(`未定价：${t.unpricedCalls} 次、${t.unpricedTokens || 0} Token，未计入费用，不代表免费`);
    if (t.flatCalls) lines.push(`包月/固定计费：${t.flatCalls} 次，固定支出单列，不按天重复计费`);
    for (const item of stats.billing?.flatItems || []) lines.push(`固定支出：${money(item.amount)}/${item.period === 'day' ? '日' : '月'}（非本窗口按量费用）`);
    if (t.localCalls) lines.push(`本地/不按量计费：${t.localCalls} 次`);
    lines.push('费用按该 24 小时窗口内的会话留档与当前价格计算；不含服务器租金及第三方非模型服务费用。');
  }
  if (selected.quota) {
    // 额度在报告生成时向面板刷新一次；读取失败也留一行说明，不留白。
    const quotaLines = formatQuotaLines(quota);
    if (quotaLines.length) lines.push('', ...quotaLines);
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
  /** 额度读取失败不阻断报告：失败也返回结构，由 formatQuotaLines 写清原因。 */
  async collectQuota(source, signal) {
    const reader = this.options.fetchQuota || fetchAntigravityQuota;
    try { return await reader(source, { signal }); }
    catch (error) {
      if (signal?.aborted) throw error;
      return { ok: false, accounts: [], refreshedAt: null, error: String(error?.message || error).slice(0, 120) };
    }
  }
  async preview(patch = {}, now = Date.now()) {
    validateDailyReportPatch(patch);
    const settings = this.settings();
    const content = { ...settings.content, ...patch.content };
    validateDailyReportPatch({ content });
    const patchQuota = patch.quota && typeof patch.quota === 'object' ? patch.quota : {};
    const quotaSource = quotaSourceConfig({
      baseUrl: patchQuota.baseUrl || settings.quota.baseUrl,
      // 空密码 = 前端没有新输入，沿用已保存的那一份。
      webPassword: patchQuota.webPassword || settings.quota.webPassword
    });
    const [stats, host, quota] = await Promise.all([
      this.options.usage(reportWindow(now)), this.options.host(),
      content.quota ? this.collectQuota(quotaSource) : null
    ]);
    return { text: formatDailyReport({ now, stats, host, connected: this.options.available(),
      runtime: this.options.config().runtime, content, quota }), generatedAt: now };
  }
  status() {
    try {
      this.last = JSON.parse(fs.readFileSync(path.join(this.options.dataDir, 'daily-report.json'), 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') this.error = '报告状态文件不可读，请人工核查；不会自动重发。';
    }
    // 面板密码不下发给浏览器：只回"有没有配"，前端据此显示占位提示。
    const settings = this.settings();
    const { webPassword, ...quotaRest } = settings.quota;
    return { settings: { ...settings, quota: { ...quotaRest, hasWebPassword: Boolean(webPassword) } },
      last: this.last, error: this.error };
  }
  start() {
    if (this.timer) return;
    const tick = () => {
      scheduleTaskObservation(this, 'daily-report', Date.now() + 30000);
      this.tick().catch(() => {});
    };
    this.timer = setInterval(tick, 30000);
    this.timer.unref?.();
    tick();
  }
  enforce() { if (!this.settings().enabled) this.controller?.abort(); }
  async stop() {
    clearInterval(this.timer); this.timer = null;
    this.controller?.abort(); await this.pending?.catch(() => {});
  }
  tick(now = Date.now()) {
    if (this.pending) return this.pending;
    this.pending = observeTask(this, 'daily-report', () => this.run(now)).then(() => { this.error = ''; }, error => {
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
    const [stats, host, quota] = await Promise.all([
      this.options.usage(reportWindow(now)),
      this.options.host(),
      // 额度按"发报告这一刻"取：先让面板刷新，再读。
      this.settings().content.quota ? this.collectQuota(this.settings().quota, signal) : null
    ]);
    signal.throwIfAborted();
    const current = this.options.config();
    if (!this.settings().enabled || this.settings().time !== settings.time || current.runtime?.mode !== 'active'
      || current.runtime?.paused || current.admin?.ownerUin !== owner || !this.options.available()) return;
    const text = formatDailyReport({ now, stats, host, connected: this.options.available(), runtime: current.runtime,
      content: this.settings().content, quota });
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
