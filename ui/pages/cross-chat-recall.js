import { $, $$, esc } from '../core/dom.js';
import { state } from '../core/state.js';
import { api } from '../core/api.js';
import { askForConfirmation } from '../core/dom-util.js';

function recallRuleRow(key, rule = {}) {
  return `<div class="recall-rule-row" data-chatkey="${esc(key)}" style="display:flex;flex-wrap:wrap;gap:12px;align-items:center;margin:10px 0">
    <strong style="overflow-wrap:anywhere">${esc(key.startsWith('group:') ? '群 ' : '私聊 ')}${esc(key.split(':')[1])}</strong>
    <label><input type="checkbox" data-rule="allowSource" ${rule.allowSource !== false ? 'checked' : ''}>提供回忆</label>
    <label><input type="checkbox" data-rule="allowTarget" ${rule.allowTarget !== false ? 'checked' : ''}>使用别处回忆</label>
    <label><input type="checkbox" data-rule="privacy" ${rule.privacy === true ? 'checked' : ''}>独立隐私</label>
    <button type="button" class="btn btn-small" data-recall-remove>移除规则</button></div>`;
}
function renderRecallControls(cfg) {
  const rules = cfg.memory?.crossChat?.chats || {};
  return `<h3>各窗口的回忆范围</h3>
    <div class="hint">全局聊天隐私优先。关闭“提供回忆”后，该窗口内容不用于别处；关闭“使用别处回忆”后，该窗口仅使用自身内容。“独立隐私”同时隔离两个方向。移除规则恢复默认，保存设置后生效。</div>
    <div id="recall-rules">${Object.entries(rules).map(([key, rule]) => recallRuleRow(key, rule)).join('')}</div>
    <div class="field-row">
      <div class="field"><label for="recall-rule-kind">会话类型</label><select id="recall-rule-kind"><option value="group">群聊</option><option value="private">私聊</option></select></div>
      <div class="field"><label for="recall-rule-id">群号或QQ号</label><input id="recall-rule-id" inputmode="numeric" maxlength="15" placeholder="填写数字账号"></div>
    </div>
    <button type="button" class="btn btn-small" id="recall-rule-add">添加窗口规则</button>
    <span class="muted" id="recall-rule-hint" role="status"></span>
    <h3>回忆记录与纠错</h3>
    <div class="hint">查看实际带入的片段、来源时间、注入字符和去重节省量。记录随原运行留档，管理员可查看；纠错只排除后续回忆，不改原聊天记录或撤回已发送内容。</div>
    <button type="button" class="btn btn-small" id="recall-traces-refresh">刷新记录</button>
    <div id="recall-traces" style="overflow-wrap:anywhere"></div>
    <div id="recall-trace-detail" style="overflow-wrap:anywhere"></div>
    <div id="recall-exclusions" style="overflow-wrap:anywhere"></div>`;
}
function readRecallRules(fallback = {}) {
  if (!$('#recall-rules')) return fallback;
  const rules = {};
  $$('.recall-rule-row', $('#recall-rules')).forEach(row => {
    rules[row.dataset.chatkey] = Object.fromEntries(['allowSource', 'allowTarget', 'privacy'].map(key => [key, row.querySelector(`[data-rule="${key}"]`).checked]));
  });
  return rules;
}
function bindRuleRemove() {
  $$('[data-recall-remove]').forEach(button => { button.onclick = () => button.closest('.recall-rule-row').remove(); });
}
async function loadRecallTrace(id) {
  const serial = (state.recallDetailSerial || 0) + 1;
  state.recallDetailSerial = serial;
  try {
    const result = await api(`/api/recall-traces/${encodeURIComponent(id)}`);
    if (state.recallDetailSerial !== serial || !$('#recall-trace-detail')) return;
    $('#recall-trace-detail').innerHTML = `<h4>${esc(result.chatKey)} · ${esc(new Date(result.startedAt).toLocaleString())}</h4>`
      + (result.recall?.entries || []).map(entry => `<section style="margin:12px 0">
        <div class="muted">${entry.mode === 'tool' ? '追加检索' : '自动回忆'} · ${entry.injectedChars}字符 · 复用${entry.skipped}条 · 查询：${esc(entry.query || '近期片段')}</div>
        ${entry.fragments.map(ref => `<article style="margin:10px 0;padding:10px;border:1px solid var(--border);border-radius:8px">
          <div class="muted">${esc(ref.chatKey)} #${ref.id} · ${esc(new Date(ref.ts).toLocaleString())} · ${ref.self ? '机器人回复' : `QQ ${esc(ref.userId)}`} · ${ref.reused ? '沿用旧上下文' : '本轮注入'}</div>
          <p style="white-space:pre-wrap;overflow-wrap:anywhere">${esc(ref.text)}</p>
          <button type="button" class="btn btn-small" data-recall-exclude="incorrect" data-session="${esc(id)}" data-source="${esc(ref.chatKey)}" data-id="${ref.id}">这条记错了</button>
          <button type="button" class="btn btn-small" data-recall-exclude="never" data-session="${esc(id)}" data-source="${esc(ref.chatKey)}" data-id="${ref.id}">以后不再引用</button>
        </article>`).join('') || '<p class="muted">本次没有可用片段。</p>'}</section>`).join('');
    $$('[data-recall-exclude]').forEach(button => { button.onclick = () => updateRecallExclusion(button, 'exclude'); });
  } catch { if (state.recallDetailSerial === serial && $('#recall-trace-detail')) $('#recall-trace-detail').textContent = '记录加载失败，请重试。'; }
}
async function updateRecallExclusion(button, action) {
  if (!await askForConfirmation(action === 'exclude' ? '确认排除此片段？后续回忆不再使用它，当前在途聊天会停止；原记录保留，可恢复。' : '确认恢复此片段参与回忆？')) return;
  button.disabled = true;
  try {
    const result = await api('/api/recall-exclusions', { method: 'POST', body: JSON.stringify({
      action, confirm: true, sessionId: button.dataset.session, chatKey: button.dataset.source,
      id: Number(button.dataset.id), reason: button.dataset.recallExclude
    }) });
    if (state.config?.memory?.crossChat) state.config.memory.crossChat.excludedMessages = result.excludedMessages;
    await loadRecallTraces();
  } catch (error) { if ($('#recall-exclusions')) $('#recall-exclusions').textContent = `操作失败：${error.message}`; }
  finally { button.disabled = false; }
}
async function loadRecallTraces() {
  const serial = (state.recallListSerial || 0) + 1; state.recallListSerial = serial;
  try {
    const result = await api('/api/recall-traces');
    if (state.recallListSerial !== serial || !$('#recall-traces')) return;
    $('#recall-traces').innerHTML = (result.sessions || []).map(s => `<div style="margin:10px 0;display:flex;flex-wrap:wrap;gap:8px">
      <span>${esc(s.chatKey)} · ${esc(new Date(s.startedAt).toLocaleString())} · 注入${s.chars}字符 · 去重省${s.savedChars}字符</span>
      <button type="button" class="btn btn-small" data-recall-detail="${esc(s.id)}">查看片段</button></div>`).join('') || '<p class="muted">暂无回忆记录，启用后随正常聊天积累。</p>';
    $('#recall-exclusions').innerHTML = '<h4>已排除的片段</h4>' + ((result.excludedMessages || []).map(ref => `<div style="margin:8px 0">
      ${esc(ref.chatKey)} #${ref.id} · ${ref.reason === 'incorrect' ? '记忆纠错' : '不再引用'}
      <button type="button" class="btn btn-small" data-recall-restore data-source="${esc(ref.chatKey)}" data-id="${ref.id}">恢复引用</button></div>`).join('') || '<p class="muted">暂无排除项。</p>');
    $$('[data-recall-detail]').forEach(button => { button.onclick = () => loadRecallTrace(button.dataset.recallDetail); });
    $$('[data-recall-restore]').forEach(button => { button.onclick = () => updateRecallExclusion(button, 'restore'); });
  } catch { if (state.recallListSerial === serial && $('#recall-traces')) $('#recall-traces').textContent = '回忆记录加载失败，可点击刷新重试。'; }
}
function bindRecallControls() {
  if (!$('#recall-rule-add')) return;
  bindRuleRemove();
  $('#recall-rule-add').onclick = () => {
    const id = $('#recall-rule-id').value.trim();
    if (!/^\d{1,15}$/.test(id)) { $('#recall-rule-hint').textContent = '请填写数字群号或QQ号'; return; }
    const key = `${$('#recall-rule-kind').value}:${id}`;
    if (Object.hasOwn(readRecallRules(), key)) { $('#recall-rule-hint').textContent = '已存在该窗口规则'; return; }
    $('#recall-rules').insertAdjacentHTML('beforeend', recallRuleRow(key)); bindRuleRemove();
    $('#recall-rule-id').value = ''; $('#recall-rule-hint').textContent = '规则已添加，保存设置后生效';
  };
  $('#recall-traces-refresh').onclick = loadRecallTraces;
  loadRecallTraces();
}

export { renderRecallControls, readRecallRules, bindRecallControls, loadRecallTraces };
