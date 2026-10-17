import { api } from '../core/api.js';
import { $, esc } from '../core/dom.js';
import { state } from '../core/state.js';

const SEARCH_LABELS = { google: 'Google Lens', yandex: 'Yandex', trace: 'trace.moe（动画截图）' };

function renderImageSearchSection(config) {
  const s = config.imageSearch || {};
  return `<h3>以图搜图</h3>
    <p class="hint">发送“搜图＋一张图片”，或回复图片发送“搜图”。可指定：搜图 Google、搜图 Yandex、搜图 trace.moe、搜图 全部。明确指令不调用聊天模型。</p>
    <div class="field"><label><input id="image-search-enabled" type="checkbox" ${s.enabled ? 'checked' : ''}> 启用以图搜图</label></div>
    <div class="field"><label>东京中转地址</label><input id="image-search-url" type="url" placeholder="http://127.0.0.1:3220" value="${esc(s.relayUrl || '')}"><div class="hint">推荐通过 SSH 隧道连接东京。地址和令牌按部署文档填写。</div></div>
    <div class="field"><label id="image-search-token-label" for="image-search-token">中转令牌${s.hasRelayToken ? '（已保存，留空保留）' : '（尚未保存）'}</label><input id="image-search-token" type="password" autocomplete="new-password" placeholder="留空保留原令牌"><label><input id="image-search-clear-token" type="checkbox"> 清除已保存的令牌</label></div>
    <div class="field-row"><div class="field"><label>默认平台</label><select id="image-search-default">${Object.entries(SEARCH_LABELS).map(([key, label]) => `<option value="${key}" ${(s.defaultPlatform || 'google') === key ? 'selected' : ''}>${label}</option>`).join('')}</select></div>
    <div class="field"><label><input id="image-search-fallback" type="checkbox" ${s.fallback !== false ? 'checked' : ''}> 失败或无结果时尝试其他已开启的平台</label></div></div>
    <div class="field">${Object.entries(SEARCH_LABELS).map(([key, label]) => `<label><input id="image-search-platform-${key}" type="checkbox" ${s.platforms?.[key] !== false ? 'checked' : ''}> ${label}</label>`).join(' ')}</div>
    <div class="field"><label>允许使用的群号（每行一个，空名单表示所有群均不允许）</label><textarea id="image-search-groups" rows="3">${esc((s.allowedGroups || []).join('\n'))}</textarea></div>
    <div class="field"><label><input id="image-search-private" type="checkbox" ${s.allowPrivate ? 'checked' : ''}> 允许私聊搜图（仍受宿主私聊白名单限制）</label></div>
    <div class="field"><label><input id="image-search-images" type="checkbox" ${s.sendImages ? 'checked' : ''}> 返回匹配图片及来源链接（合并转发，最多3张）</label><div class="hint">优先匹配图原文件，失败时尝试缩略图并标明；动画返回预览帧。图片总计最多8MB，原图防盗链或过大时仍保留链接。</div></div>
    <div class="field-row"><div class="field"><label>每个平台超时（秒）</label><input id="image-search-timeout" type="number" min="10" max="90" value="${esc(s.timeoutSeconds ?? 45)}"></div>
    <div class="field"><label>每个平台最多返回</label><input id="image-search-limit" type="number" min="1" max="5" value="${esc(s.limit ?? 3)}"></div>
    <div class="field"><label>同会话冷却（秒）</label><input id="image-search-cooldown" type="number" min="0" max="3600" value="${esc(s.cooldownSeconds ?? 15)}"></div>
    <div class="field"><label>动画最低相似度（0.8—1）</label><input id="image-search-similarity" type="number" min="0.8" max="1" step="0.01" value="${esc(s.traceMinSimilarity ?? 0.9)}"></div></div>
    <p class="hint">搜图会把选中的图片提交给实际查询的平台。“搜图 全部”查询全部已开启的平台。相似网页不代表原创出处；动画时间对应匹配片源，低于门槛不作为识别结果。</p>
    <button type="button" class="btn" id="image-search-health">测试已保存的中转连接</button>
    <button type="button" class="btn" id="image-search-refresh">刷新任务记录</button>
    <p class="hint" id="image-search-health-result"></p><div id="image-search-history" style="overflow-wrap:anywhere"></div>`;
}

async function saveImageSearchSettings() {
  const patch = {
    enabled: $('#image-search-enabled').checked,
    relayUrl: $('#image-search-url').value.trim(),
    defaultPlatform: $('#image-search-default').value,
    fallback: $('#image-search-fallback').checked,
    allowPrivate: $('#image-search-private').checked,
    sendImages: $('#image-search-images').checked,
    allowedGroups: [...new Set($('#image-search-groups').value.split(/[\s,，]+/).filter(Boolean))],
    platforms: Object.fromEntries(Object.keys(SEARCH_LABELS).map((key) => [key, $(`#image-search-platform-${key}`).checked])),
    timeoutSeconds: Number($('#image-search-timeout').value),
    limit: Number($('#image-search-limit').value),
    cooldownSeconds: Number($('#image-search-cooldown').value),
    traceMinSimilarity: Number($('#image-search-similarity').value)
  };
  const token = $('#image-search-token').value.trim();
  if (token || $('#image-search-clear-token').checked) patch.relayToken = $('#image-search-clear-token').checked ? '' : token;
  try {
    const result = await api('/api/image-search/settings', { method: 'POST', body: JSON.stringify(patch) });
    state.config.imageSearch = result.settings;
    $('#image-search-token').value = '';
    $('#image-search-token-label').textContent = `中转令牌${result.settings.hasRelayToken ? '（已保存，留空保留）' : '（尚未保存）'}`;
    $('#image-search-clear-token').checked = false;
    $('#cfg-save-result').textContent = '搜图设置已保存，立即生效。';
  } catch (error) {
    $('#cfg-save-result').textContent = error.message;
    throw error;
  }
}

function bindImageSearchSection() {
  const refresh = async () => {
    const box = $('#image-search-history');
    if (!box) return;
    try {
      const data = await api('/api/image-search');
      if ($('#image-search-history') !== box) return;
      box.innerHTML = `<p>${data.running ? '正在搜图' : '当前空闲'}</p>${data.history.slice(0, 20).map((row) => `<p>${esc(row.startedAt)} · ${esc(row.chatKey)} · ${esc({ running: '运行中', interrupted: '重启中断，未自动重试', done: '已完成', 'no-result': '无可靠结果', cancelled: '已取消', failed: '失败', 'send-unknown': '发送结果未确认，请检查会话' }[row.status] || row.status)}${(row.platforms || []).map((p) => ` · ${esc(SEARCH_LABELS[p.platform] || p.platform)}：${esc(p.count)}条`).join('')}</p>`).join('') || '<p class="muted">暂无搜图记录</p>'}`;
    } catch (error) { if ($('#image-search-history') === box) box.textContent = error.message; }
  };
  $('#image-search-refresh')?.addEventListener('click', refresh);
  $('#image-search-health')?.addEventListener('click', async () => {
    const label = $('#image-search-health-result');
    label.textContent = '正在检查…';
    try {
      const data = await api('/api/image-search/health');
      label.textContent = `中转连接正常；${data.googleConfigured ? '已配置 Google 浏览器（不代表 Google 当前可搜）' : '尚未配置 Google 浏览器'}；${data.busy ? '中转忙碌' : '中转空闲'}`;
    } catch (error) { label.textContent = error.message; }
  });
  refresh();
}

export { renderImageSearchSection, saveImageSearchSettings, bindImageSearchSection };
