// 控制台首页。复用状态、用量和异常接口；每块数据独立降级。
import { switchTab } from '../app.js';
import { api } from '../core/api.js';
import { $, esc } from '../core/dom.js';
import { fmtTime, fmtTokens } from '../core/format.js';
import { state } from '../core/state.js';

const number = (value) => Number(value) || 0;
const percent = (used, total) => total > 0 ? Math.min(100, Math.max(0, used / total * 100)) : 0;
const size = (bytes) => `${(number(bytes) / 1073741824).toFixed(1)} GB`;
const money = (value) => `¥${number(value).toFixed(3)}`;

function lastSevenDays() {
  const today = new Date();
  return Array.from({ length: 7 }, (_, index) => {
    const date = new Date(today.getTime() - (6 - index) * 86400000);
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en', {
      timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit'
    }).formatToParts(date).map((part) => [part.type, part.value]));
    return `${parts.year}-${parts.month}-${parts.day}`;
  });
}

function card(label, value, detail, className = '') {
  return `<div class="overview-card ${className}"><span>${esc(label)}</span><strong>${esc(value)}</strong><small>${esc(detail)}</small></div>`;
}

function renderTrend(stats) {
  if (!stats) return '<div class="overview-empty">用量数据暂不可用</div>';
  const byDay = new Map((stats.days || []).map((day) => [day.day, day]));
  const days = lastSevenDays().map((key) => ({ key, ...byDay.get(key) }));
  const max = Math.max(1, ...days.map((day) => number(day.runs)));
  return `<div class="overview-chart" role="img" aria-label="近 7 天模型调用次数">
    ${days.map((day) => `<div class="overview-chart-day" title="${esc(day.key)}：${number(day.runs)} 次模型调用 · ${money(day.cost)}">
      <strong>${number(day.runs) || ''}</strong><div class="overview-chart-track"><i style="height:${Math.max(number(day.runs) ? 6 : 2, percent(number(day.runs), max))}%"></i></div>
      <span>${esc(day.key.slice(5))}</span>
    </div>`).join('')}
  </div>`;
}

function renderIncidents(data) {
  if (!data) return '<div class="overview-empty">异常数据暂不可用</div>';
  const incidents = (data.incidents || []).slice().sort((a, b) => number(b.lastAt) - number(a.lastAt)).slice(0, 5);
  if (!incidents.length) return '<div class="overview-empty">暂无异常记录</div>';
  return `<div class="overview-incidents">${incidents.map((item) => `<div class="overview-incident">
    <time>${esc(fmtTime(item.lastAt))}</time><span class="incident-severity severity-${esc(item.severity || 'info')}">${esc(item.severity || '信息')}</span>
    <span class="overview-incident-message" title="${esc(item.message || item.code || '')}">${esc(item.message || item.code || '未命名异常')}</span>
    <small>${esc(item.state === 'resolved' ? '已解决' : item.state === 'acknowledged' ? '已确认' : '待处理')}</small>
  </div>`).join('')}</div>`;
}

function resource(label, used, total, detail) {
  const ratio = percent(used, total);
  return `<div class="overview-resource"><div><span>${esc(label)}</span><strong>${ratio.toFixed(1)}%</strong></div>
    <div class="overview-resource-bar"><i style="width:${ratio.toFixed(1)}%"></i></div><small>${esc(detail)}</small></div>`;
}

function renderOverview({ status, usage, incidents, host, errors = [] }) {
  const box = $('#overview-page');
  if (!box) return;
  const ob = status?.onebot || {};
  const count = status?.incidentPilot?.counts || incidents?.status?.counts || {};
  const today = status?.usage || {};
  const total = usage?.totals || {};
  const connected = ob.connected === true;
  const mode = status?.orchestrator?.mode || 'observe';
  const paused = status?.paused === true;
  box.innerHTML = `<div class="overview-wrap">
    <div class="overview-heading"><div><h1>总览</h1><p>QQ Agent 的连接、用量与异常状态</p></div>
      <button type="button" class="btn btn-small" data-overview-refresh>↻ 刷新</button></div>
    ${errors.length ? `<div class="overview-notice" role="status">部分数据读取失败：${esc(errors.join('、'))}。可点击刷新重试。</div>` : ''}
    <div class="overview-cards">
      ${card('机器人', status ? (paused ? '已暂停' : mode === 'active' ? '运行中' : '观察中') : '状态未知', status ? `OneBot ${connected ? '已连接' : '未连接'}${ob.self?.nickname ? ` · ${ob.self.nickname}` : ''}` : '状态接口不可用', connected ? 'good' : 'warn')}
      ${card('今日运行', status ? `${number(today.runs)} 次` : '—', status ? `${fmtTokens(today.totalTokens)} token · 搜索 ${number(status.webSearchCount)} 次` : '今日数据暂不可用')}
      ${card('今日成本', status ? money(status.cost?.cost) : '—', number(today.unpricedRuns) || status?.cost?.unpriced ? '含未定价调用，金额仅供参考' : status?.cost?.costMode === 'subscription' ? '另有订阅费用' : '按模型价格统计')}
      ${card('待处理异常', status ? `${number(count.open)} 条` : '—', status?.incidentPilot?.active ? `严重 ${number(count.critical)} · 已确认 ${number(count.acknowledged)}` : '异常模块未启用或不可用', number(count.open) ? 'warn' : '')}
    </div>
    <div class="overview-grid">
      <section class="overview-panel"><div class="overview-panel-head"><div><h2>连接与身份</h2><p>当前 QQ 与模型配置</p></div><button type="button" class="overview-link" data-overview-go="control">查看控制 →</button></div>
        <dl class="overview-facts"><div><dt>OneBot</dt><dd>${status ? (connected ? '已连接' : '未连接') : '未知'}</dd></div>
        <div><dt>机器人</dt><dd>${esc(ob.self ? `${ob.self.nickname || '未命名'} · ${ob.self.userId || ''}` : '尚未读取身份')}</dd></div>
        <div><dt>模型</dt><dd>${esc(status?.orchestrator?.model || '未设置')}</dd></div>
        <div><dt>运行模式</dt><dd>${paused ? '暂停' : mode === 'active' ? '启用' : '观察'}${status?.version ? ` · v${esc(status.version)}` : ''}</dd></div></dl>
      </section>
      <section class="overview-panel"><div class="overview-panel-head"><div><h2>最近异常</h2><p>最近 5 条 · 待处理 ${number(count.open)}</p></div><button type="button" class="overview-link" data-overview-go="incidents">全部异常 →</button></div>
        ${renderIncidents(incidents)}</section>
    </div>
    <section class="overview-panel"><div class="overview-panel-head"><div><h2>近 7 天用量</h2><p>${usage ? `${number(total.runs)} 次模型调用 · ${fmtTokens(total.totalTokens)} token · ${money(total.cost)}` : '正在等待用量数据'}</p></div>
      <button type="button" class="overview-link" data-overview-go="usage">用量详情 →</button></div>${renderTrend(usage)}</section>
    <section class="overview-panel"><div class="overview-panel-head"><div><h2>主机资源</h2><p>${host ? `${esc(host.hostname)} · ${number(host.cpuCount)} 核 · 服务运行 ${Math.floor(number(host.processUptimeSeconds) / 3600)} 小时` : '主机数据暂不可用'}</p></div></div>
      ${host ? `<div class="overview-resources">
        <div class="overview-resource"><div><span>CPU 负载</span><strong>${number(host.loadAverage?.[0]).toFixed(2)}</strong></div><small>近 1 分钟 · ${number(host.cpuCount)} 核</small></div>
        ${resource('内存', host.memory?.used, host.memory?.total, `${size(host.memory?.used)} / ${size(host.memory?.total)}`)}
        ${host.disk ? resource('磁盘（数据目录所在分区）', host.disk.used, host.disk.total, `${size(host.disk.used)} / ${size(host.disk.total)}`) : '<div class="overview-resource muted">磁盘数据暂不可用</div>'}
      </div>` : '<div class="overview-empty">主机资源接口不可用</div>'}</section>
  </div>`;
  box.querySelector('[data-overview-refresh]')?.addEventListener('click', () => loadOverview());
  box.querySelectorAll('[data-overview-go]').forEach((button) => button.addEventListener('click', () => switchTab(button.dataset.overviewGo)));
}

async function loadOverview({ status } = {}) {
  const box = $('#overview-page');
  if (!box || state.tab !== 'overview') return;
  const token = ++state.overviewLoadSeq;
  if (!box.innerHTML) box.innerHTML = '<div class="overview-empty">正在加载总览…</div>';
  const results = await Promise.allSettled([
    status ? Promise.resolve(status) : api('/api/status'),
    api('/api/usage/stats?range=7'),
    api('/api/incidents?limit=5'),
    api('/api/overview/host')
  ]);
  if (token !== state.overviewLoadSeq || state.tab !== 'overview') return;
  const names = ['状态', '用量', '异常', '主机'];
  const values = results.map((result) => result.status === 'fulfilled' ? result.value : null);
  renderOverview({
    status: values[0], usage: values[1], incidents: values[2], host: values[3],
    errors: results.flatMap((result, index) => result.status === 'rejected' ? [names[index]] : [])
  });
}

export { loadOverview };
