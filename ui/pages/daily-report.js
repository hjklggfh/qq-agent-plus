import { api } from '../core/api.js';
import { $, esc } from '../core/dom.js';
import { state } from '../core/state.js';

// 第四列 = 旧配置缺这个键时的默认值（额度默认关闭，其余沿用历史行为默认开启）。
const REPORT_CONTENT_OPTIONS = [
  ['tokens', 'Token 用量', '输入、输出、缓存命中和调用次数', true],
  ['cost', '按量费用', '统计窗口内的会话留档与当前价格，含估算、未定价与固定支出说明', true],
  ['quota', '反代额度', 'Antigravity 面板的 Gemini / Claude 剩余额度，发报告时先刷新', false],
  ['status', 'Agent 与 QQ 状态', '运行模式、暂停状态和 QQ 连接', true],
  ['uptime', '运行时长', '服务器和 Agent 已运行时长', true],
  ['cpu', 'CPU 与系统负载', 'CPU 核数及 1 / 5 / 15 分钟负载', true],
  ['memory', '内存与 Swap', '可用内存、Agent 占用和 Swap 已用', true],
  ['disk', '磁盘空间', '数据目录所在磁盘的容量和可用空间', true],
  ['io', 'I/O 压力', '最近一分钟 I/O 停顿压力，不可读取时明确提示', true]
];

function renderDailyReportSection(config) {
  const s = state.dailyReportDraft || config.dailyReport || {};
  const quota = s.quota || {};
  const hasPassword = quota.hasWebPassword ?? Boolean(config.dailyReport?.quota?.hasWebPassword);
  return `<h3>每晚汇报</h3>
    <p class="hint">每天按北京时间私聊全局管理员，统计截至发送时刻的完整 24 小时（例：23:00 发送统计昨天 23:00 到今天 23:00）。费用按同一窗口的会话留档计算；生成报告不额外调用模型。</p>
    <div class="field"><label><input id="daily-report-enabled" type="checkbox" ${s.enabled ? 'checked' : ''}> 启用每晚汇报</label></div>
    <div class="field"><label for="daily-report-time">汇报时间（北京时间）</label><input id="daily-report-time" type="time" value="${esc(s.time || '23:00')}" required></div>
    <h3>发送内容</h3><p class="hint">勾选需要发送的项目，至少保留一项。保存后用于下一次定时汇报。</p>
    <div class="field-row">${REPORT_CONTENT_OPTIONS.map(([key, label, help, fallback]) => `<div class="field">
      <label><input id="daily-report-content-${key}" type="checkbox" ${(s.content?.[key] ?? fallback) ? 'checked' : ''}> ${label}</label>
      <div class="hint">${help}</div></div>`).join('')}</div>
    <h3>反代额度来源</h3>
    <p class="hint">勾选「反代额度」才会读取。报告生成时会先让面板刷新一次，取的就是发报告那一刻的额度；读取失败会在报告里写明原因，不会影响其他内容。</p>
    <div class="field"><label for="daily-report-quota-baseUrl">面板地址</label>
      <input id="daily-report-quota-baseUrl" value="${esc(quota.baseUrl || 'http://127.0.0.1:18045')}" placeholder="http://127.0.0.1:18045"></div>
    <div class="field"><label for="daily-report-quota-webPassword">面板网页密码</label>
      <input id="daily-report-quota-webPassword" type="password" value="" autocomplete="new-password"
        placeholder="${hasPassword ? '已保存，留空则不修改' : '未设置'}"></div>
    <p class="hint">这是 Antigravity 面板的网页登录密码，不是模型 API Key；只存在服务器 data/config.json，控制台不回显。</p>
    <p class="hint">接收人为“设置 → 全局管理员 QQ”。暂停或观察模式下不发送；发送结果未知时当天不会自动重发。停用会保留配置和发送记录。</p>
    <div id="daily-report-hint" class="hint" role="status">正在读取最近发送状态…</div>
    <h3>内容预览</h3><p class="hint">使用当前勾选内容和服务器当前数据生成预览，无需先保存，不发送 QQ。额度来源以已保存的设置为准。</p>
    <button id="daily-report-preview" class="btn" type="button">预览发送内容</button>
    <pre id="daily-report-preview-result" class="hint" style="white-space:pre-wrap;overflow-wrap:anywhere" role="status"></pre>`;
}

function dailyReportFormPatch() {
  const quota = { baseUrl: $('#daily-report-quota-baseUrl').value.trim() };
  const password = $('#daily-report-quota-webPassword').value.trim();
  // 留空 = 前端没有新密码，不放进补丁，服务端沿用已保存的那一份。
  if (password) quota.webPassword = password;
  return { enabled: $('#daily-report-enabled').checked, time: $('#daily-report-time').value,
    content: Object.fromEntries(REPORT_CONTENT_OPTIONS.map(([key]) => [key, $(`#daily-report-content-${key}`).checked])),
    quota };
}

function bindDailyReportSection() {
  const statusNode = $('#daily-report-hint');
  api('/api/daily-report').then(status => {
    if (!statusNode.isConnected) return;
    statusNode.textContent = status.error || (status.last
      ? `最近记录：${status.last.day} · ${status.last.outcome === 'sent' ? '已发送' : '发送结果待核对，当天不自动重发'}`
      : '尚无发送记录。');
  }).catch(error => { statusNode.textContent = `状态读取失败：${error.message}`; });
  for (const id of ['enabled', 'time', 'quota-baseUrl', 'quota-webPassword',
    ...REPORT_CONTENT_OPTIONS.map(([key]) => `content-${key}`)]) {
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
  const config = state.config?.dailyReport;
  if (config) {
    config.enabled = dailyReport.enabled;
    config.time = dailyReport.time;
    config.content = dailyReport.content;
    config.quota = { ...(config.quota || {}), baseUrl: dailyReport.quota.baseUrl,
      hasWebPassword: Boolean(dailyReport.quota.webPassword || config.quota?.hasWebPassword) };
  }
  state.dailyReportDraft = null;
  $('#cfg-save-result').textContent = '汇报设置已保存，立即生效。';
}

export { renderDailyReportSection, bindDailyReportSection, saveDailyReportSettings };
