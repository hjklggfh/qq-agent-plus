import { switchTab } from '../app.js';
import { api } from '../core/api.js';
import { $, esc } from '../core/dom.js';
import { FEATURE_CATALOG } from '../core/feature-catalog.js';
import { fmtTime } from '../core/format.js';
import { state } from '../core/state.js';

const BACKGROUND_STATE_LABELS = { waiting: '等待调度', running: '执行中', disabled: '已关闭', stopped: '未启动', error: '异常' };

function renderFeatureCenter() {
  return `<div id="feature-center"><h3>功能管理</h3>
    <p class="hint">集中查看功能开关和后台任务。进入各功能设置可调整开关、范围和计划；已有配置与历史记录保持原样。</p>
    <div class="field-row"><div class="field"><label for="feature-center-search">查找功能</label>
      <input id="feature-center-search" type="search" placeholder="功能名称或用途" value="${esc(state.featureCenterQuery)}"></div>
      <div class="field"><label for="feature-center-filter">显示范围</label><select id="feature-center-filter">
      ${[['all', '全部功能'], ['enabled', '已启用'], ['disabled', '已关闭'], ['attention', '异常或待核对']].map(([value, name]) => `<option value="${value}" ${state.featureCenterFilter === value ? 'selected' : ''}>${name}</option>`).join('')}</select></div></div>
    <button id="feature-center-refresh" type="button" class="btn">刷新状态</button>
    <p id="feature-center-note" class="hint" role="status"></p>
    <div id="feature-center-list" class="feature-center-grid"></div>
    <h3>后台任务</h3><p class="hint">检查完成表示调度检查正常结束，不代表已发送消息；发送成功以功能记录为准。进程内检查时间在重启后重新积累。发送结果待核对时不会在这里自动重试。</p>
    <div id="background-task-list" class="feature-center-grid"></div>
    <p id="feature-external-tasks" class="hint"></p></div>`;
}

function openFeatureSettings(id) {
  const feature = FEATURE_CATALOG.find(item => item.id === id);
  if (!feature) return;
  state.settingsSection = feature.section || feature.id;
  switchTab('settings');
}

function updateFeatureCenter() {
  const box = $('#feature-center-list');
  if (!box) return;
  const data = state.featureCenterData;
  const features = data?.features || FEATURE_CATALOG.map(item => ({ ...item, enabled: state.config?.[item.configKey]?.enabled === true }));
  const tasks = data?.tasks || [];
  const query = state.featureCenterQuery.trim().toLowerCase();
  const selected = features.filter(feature => {
    const relevant = tasks.filter(task => task.featureId === feature.id);
    const attention = relevant.some(task => task.state === 'error' || task.needsReview);
    return (!query || `${feature.name} ${feature.description} ${feature.category}`.toLowerCase().includes(query))
      && (state.featureCenterFilter === 'all' || (state.featureCenterFilter === 'enabled' && feature.enabled)
      || (state.featureCenterFilter === 'disabled' && !feature.enabled) || (state.featureCenterFilter === 'attention' && attention));
  });
  box.innerHTML = selected.map(feature => {
    const relevant = tasks.filter(task => task.featureId === feature.id);
    const summary = relevant.map(task => task.needsReview ? '发送结果待核对' : BACKGROUND_STATE_LABELS[task.state] || '状态未知').join(' · ');
    return `<article class="feature-center-card"><div class="feature-center-heading"><strong>${esc(feature.name)}</strong><span>${feature.enabled ? '已启用' : '已关闭'}</span></div>
      <small class="muted">${esc(feature.category)}</small><p>${esc(feature.description)}</p>
      ${summary ? `<p class="hint">后台：${esc(summary)}</p>` : '<p class="hint">按请求触发或由会话规则控制</p>'}
      <button class="btn btn-small" type="button" data-feature-open="${esc(feature.id)}">打开设置</button></article>`;
  }).join('') || '<p class="hint">没有符合条件的功能。</p>';
  $('#background-task-list').innerHTML = tasks.map(task => `<article class="feature-center-card">
    <div class="feature-center-heading"><strong>${esc(task.name)}</strong><span>${esc(BACKGROUND_STATE_LABELS[task.state] || '状态未知')}</span></div>
    <p class="hint">${esc(task.schedule)}</p>
    <p class="hint">${task.nextKind === 'schedule' ? '下次调度' : '下次检查'}：${task.nextRunAt ? esc(fmtTime(task.nextRunAt)) : task.enabled === false || ['disabled', 'stopped'].includes(task.state) ? '未安排' : '暂未提供时间'}</p>
    <p class="hint">${task.successKind === 'delivery' ? '最近发送成功' : '最近检查完成'}：${task.lastSuccessAt ? esc(fmtTime(task.lastSuccessAt)) : '尚无记录'}</p>
    ${task.lastRunAt ? `<p class="hint">最近执行：${esc(fmtTime(task.lastRunAt))}</p>` : ''}
    ${task.failureReason ? `<p class="hint error">最近失败${task.lastErrorAt ? `（${esc(fmtTime(task.lastErrorAt))}）` : ''}：${esc(task.failureReason)}</p>` : ''}
    ${task.needsReview ? '<p class="hint">有发送结果待核对，请到功能页查看。</p>' : ''}
    ${task.error && !task.failureReason ? `<p class="hint error">${esc(task.error)}</p>` : ''}
    ${task.featureId ? `<button class="btn btn-small" type="button" data-feature-open="${esc(task.featureId)}">打开设置</button>` : '<small class="muted">系统任务，随应用启动和停止</small>'}</article>`).join('') || '<p class="hint">后台状态尚未加载。</p>';
  $('#feature-external-tasks').textContent = (data?.external || []).join('；');
}

async function loadFeatureCenter({ quiet = false } = {}) {
  const note = $('#feature-center-note');
  if (!note || note.dataset.loading) return;
  note.dataset.loading = '1';
  const requestId = ++state.featureCenterRequest;
  if (!quiet) note.textContent = '正在读取功能和后台任务状态…';
  try {
    const data = await api('/api/features');
    if (!Array.isArray(data.features) || !Array.isArray(data.tasks)) throw new Error('服务未返回功能状态');
    if (!note.isConnected || requestId !== state.featureCenterRequest) return;
    state.featureCenterData = data;
    updateFeatureCenter();
    const mode = data.runtime?.paused ? '已暂停' : data.runtime?.mode === 'observe' ? '观察模式' : '启用模式';
    note.textContent = `已刷新 ${fmtTime(data.observedAt)} · ${data.features.length} 个功能 · ${data.tasks.length} 项后台任务 · ${mode}。各任务沿用自己的执行规则。`;
  } catch (error) { if (note.isConnected) note.textContent = `状态读取失败：${error.message}`; }
  finally { delete note.dataset.loading; }
}

function bindFeatureCenter() {
  updateFeatureCenter();
  $('#feature-center-search').addEventListener('input', event => { state.featureCenterQuery = event.target.value; updateFeatureCenter(); });
  $('#feature-center-filter').addEventListener('change', event => { state.featureCenterFilter = event.target.value; updateFeatureCenter(); });
  $('#feature-center-refresh').addEventListener('click', () => loadFeatureCenter());
  $('#feature-center').addEventListener('click', event => {
    const button = event.target.closest('[data-feature-open]');
    if (button) openFeatureSettings(button.dataset.featureOpen);
  });
  loadFeatureCenter();
}

export { renderFeatureCenter, bindFeatureCenter, loadFeatureCenter };
