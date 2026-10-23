import { api } from '../core/api.js';
import { $, esc } from '../core/dom.js';
import { state } from '../core/state.js';

const REPORT_CONTENT_OPTIONS = [
  ['tokens', 'Token 用量', '输入、输出、缓存命中和调用次数'],
  ['cost', '今日费用', '沿用总览今日成本，含估算、未定价与固定支出说明'],
  ['status', 'Agent 与 QQ 状态', '运行模式、暂停状态和 QQ 连接'],
  ['uptime', '运行时长', '服务器和 Agent 已运行时长'],
  ['cpu', 'CPU 与系统负载', 'CPU 核数及 1 / 5 / 15 分钟负载'],
  ['memory', '内存与 Swap', '可用内存、Agent 占用和 Swap 已用'],
  ['disk', '磁盘空间', '数据目录所在磁盘的容量和可用空间'],
  ['io', 'I/O 压力', '最近一分钟 I/O 停顿压力，不可读取时明确提示']
];

function renderDailyReportSection(config) {
  const s = state.dailyReportDraft || config.dailyReport || {};
  return `<h3>每晚汇报</h3>
    <p class="hint">每天按北京时间私聊全局管理员，统计当天零点至汇报时刻。费用与总览“今日成本”使用相同口径；生成报告不额外调用模型。</p>
    <div class="field"><label><input id="daily-report-enabled" type="checkbox" ${s.enabled ? 'checked' : ''}> 启用每晚汇报</label></div>
    <div class="field"><label for="daily-report-time">汇报时间（北京时间）</label><input id="daily-report-time" type="time" value="${esc(s.time || '23:00')}" required></div>
    <h3>发送内容</h3><p class="hint">勾选需要发送的项目，至少保留一项。保存后用于下一次定时汇报。</p>
    <div class="field-row">${REPORT_CONTENT_OPTIONS.map(([key, label, help]) => `<div class="field">
      <label><input id="daily-report-content-${key}" type="checkbox" ${s.content?.[key] !== false ? 'checked' : ''}> ${label}</label>
      <div class="hint">${help}</div></div>`).join('')}</div>
    <p class="hint">接收人为“设置 → 全局管理员 QQ”。暂停或观察模式下不发送；发送结果未知时当天不会自动重发。停用会保留配置和发送记录。</p>
    <div id="daily-report-hint" class="hint" role="status">正在读取最近发送状态…</div>
    <h3>内容预览</h3><p class="hint">使用当前勾选内容和服务器当前数据生成预览，无需先保存，不发送 QQ。</p>
    <button id="daily-report-preview" class="btn" type="button">预览发送内容</button>
    <pre id="daily-report-preview-result" class="hint" style="white-space:pre-wrap;overflow-wrap:anywhere" role="status"></pre>`;
}

function dailyReportFormPatch() {
  return { enabled: $('#daily-report-enabled').checked, time: $('#daily-report-time').value,
    content: Object.fromEntries(REPORT_CONTENT_OPTIONS.map(([key]) => [key, $(`#daily-report-content-${key}`).checked])) };
}

function bindDailyReportSection() {
  const statusNode = $('#daily-report-hint');
  api('/api/daily-report').then(status => {
    if (!statusNode.isConnected) return;
    statusNode.textContent = status.error || (status.last
      ? `最近记录：${status.last.day} · ${status.last.outcome === 'sent' ? '已发送' : '发送结果待核对，当天不自动重发'}`
      : '尚无发送记录。');
  }).catch(error => { statusNode.textContent = `状态读取失败：${error.message}`; });
  for (const id of ['enabled', 'time', ...REPORT_CONTENT_OPTIONS.map(([key]) => `content-${key}`)]) {
    $(`#daily-report-${id}`).addEventListener('change', () => { state.dailyReportDraft = dailyReportFormPatch(); });
  }
  $('#daily-report-preview').addEventListener('click', async () => {
    const button = $('#daily-report-preview'); const box = $('#daily-report-preview-result');
    button.disabled = true; box.textContent = '正在生成预览…';
    try {
      const result = await api('/api/daily-report/preview', { method: 'POST', body: JSON.stringify(dailyReportFormPatch()) });
      box.textContent = result.text;
    } catch (error) { box.textContent = `预览失败：${error.message}`; }
    finally { button.disabled = false; }
  });
}

async function saveDailyReportSettings() {
  const dailyReport = dailyReportFormPatch();
  await api('/api/config', { method: 'POST', body: JSON.stringify({ dailyReport }) });
  state.config.dailyReport = dailyReport;
  state.dailyReportDraft = null;
  $('#cfg-save-result').textContent = '汇报设置已保存，立即生效。';
}

export { renderDailyReportSection, bindDailyReportSection, saveDailyReportSettings };
