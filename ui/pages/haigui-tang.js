import { api } from '../core/api.js';
import { $, esc } from '../core/dom.js';
import { state } from '../core/state.js';

function renderHaiguiTangSection(config) {
  const s = config.haiguiTang || {};
  return `<h3>海龟汤</h3>
  <p class="hint">内置 112 道谜题。启用并填写会话后，发送「海龟汤」开局；问「是不是……」，发送「提示」「公布答案」「换题」或「结束海龟汤」。每次判断会调用一次聊天模型。</p>
  <div class="field"><label><input id="ht-enabled" type="checkbox" ${s.enabled ? 'checked' : ''}> 启用海龟汤</label></div>
  <div class="field"><label>允许的会话（每行一个 group:群号 或 private:QQ号；留空表示没有会话可玩）</label><textarea id="ht-chats" rows="4">${esc((s.allowedChats || []).join('\n'))}</textarea></div>
  <div class="field-row"><div class="field"><label><input id="ht-dark" type="checkbox" ${s.includeDark !== false ? 'checked' : ''}> 包含黑暗向题目</label></div>
  <div class="field"><label><input id="ht-rules" type="checkbox" ${s.showRules !== false ? 'checked' : ''}> 开局附玩法说明</label></div>
  <div class="field"><label><input id="ht-repeat" type="checkbox" ${s.avoidRepeat !== false ? 'checked' : ''}> 同一会话尽量不重复出题</label></div></div>
  <div class="field-row"><div class="field"><label>难度上限（星）</label><input id="ht-stars" type="number" min="3" max="5" value="${esc(s.maxStars ?? 5)}"></div>
  <div class="field"><label>一局闲置期限（小时）</label><input id="ht-hours" type="number" min="1" max="24" value="${esc(s.sessionHours ?? 3)}"></div>
  <div class="field"><label>每局最多提示</label><input id="ht-hints" type="number" min="0" max="10" value="${esc(s.hintLimit ?? 3)}"></div>
  <div class="field"><label>直接公布答案前建议先问（题）</label><input id="ht-reveal" type="number" min="0" max="30" value="${esc(s.revealAfterQuestions ?? 5)}"></div></div>
  <p class="hint">关闭功能会保留已经玩过的题和当前进度。进行中的题目、答案不会显示在控制台状态里。</p>
  <button class="btn" type="button" id="ht-refresh">刷新状态</button><p id="ht-status" class="hint"></p>
  <h4>自定义出题</h4><p class="hint">仅控制台管理员填写汤面和汤底。汤底只存在服务器进度里，不会出现在 QQ 的开局消息中。目标会话必须已启用且没有进行中的局。</p>
  <div class="field"><label>目标会话</label><input id="ht-custom-chat" placeholder="group:群号"></div>
  <div class="field"><label>汤面（最多 500 字）</label><textarea id="ht-custom-soup" rows="3" maxlength="500"></textarea></div>
  <div class="field"><label>汤底（最多 2000 字）</label><textarea id="ht-custom-answer" rows="4" maxlength="2000"></textarea></div>
  <button class="btn" type="button" id="ht-custom-start">向目标会话出题</button><p id="ht-custom-result" class="hint"></p>`;
}

async function saveHaiguiTangSettings() {
  const patch = {
    enabled: $('#ht-enabled').checked,
    allowedChats: [...new Set($('#ht-chats').value.split(/[\s,，]+/).filter(Boolean))],
    includeDark: $('#ht-dark').checked,
    showRules: $('#ht-rules').checked,
    avoidRepeat: $('#ht-repeat').checked,
    maxStars: Number($('#ht-stars').value),
    sessionHours: Number($('#ht-hours').value),
    hintLimit: Number($('#ht-hints').value),
    revealAfterQuestions: Number($('#ht-reveal').value)
  };
  try {
    const data = await api('/api/haigui-tang/settings', { method: 'POST', body: JSON.stringify(patch) });
    state.config.haiguiTang = data.settings;
    $('#cfg-save-result').textContent = '海龟汤设置已保存。';
  } catch (error) { $('#cfg-save-result').textContent = error.message; throw error; }
}

function bindHaiguiTangSection() {
  const refresh = async () => {
    const target = $('#ht-status');
    if (!target) return;
    try {
      const data = await api('/api/haigui-tang');
      if ($('#ht-status') === target) target.textContent = `题库 ${data.puzzleCount} 道 · 进行中 ${data.running.length} 局`;
    } catch (error) { if ($('#ht-status') === target) target.textContent = error.message; }
  };
  $('#ht-refresh')?.addEventListener('click', refresh);
  $('#ht-custom-start')?.addEventListener('click', async () => {
    const chatKey = $('#ht-custom-chat').value.trim();
    const soup = $('#ht-custom-soup').value.trim();
    const answer = $('#ht-custom-answer').value.trim();
    const target = $('#ht-custom-result');
    if (!chatKey || !soup || !answer) { target.textContent = '请填写目标会话、汤面和汤底。'; return; }
    if (!window.confirm(`确定向 ${chatKey} 发送自定义海龟汤汤面吗？`)) return;
    try {
      await api('/api/haigui-tang/custom', { method: 'POST', body: JSON.stringify({ chatKey, soup, answer }) });
      target.textContent = '已发送自定义汤面。';
      $('#ht-custom-answer').value = '';
      await refresh();
    } catch (error) { target.textContent = error.message; }
  });
  void refresh();
}

export { renderHaiguiTangSection, saveHaiguiTangSettings, bindHaiguiTangSection };
