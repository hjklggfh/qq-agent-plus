import { api } from '../core/api.js';
import { $, esc } from '../core/dom.js';
import { state } from '../core/state.js';

function renderEhentaiSection(config) {
  const s = config.ehentai || {};
  return `<h3>E-Hentai 检索</h3>
  <p class="hint">公开 E-Hentai；默认关闭。发送“e站tag：标签”“e站搜索：关键词”或“e站每日排行榜”。列表每页 10 条，回复“下一页”“第2页”或序号。序号会把该画廊完整打包为 PDF 并发送到当前会话。</p>
  <div class="field"><label><input id="eh-enabled" type="checkbox" ${s.enabled ? 'checked' : ''}> 启用 E站检索</label></div>
  <div class="field"><label>允许的会话（每行一个 group:群号 或 private:QQ号；管理员私聊自动允许）</label><textarea id="eh-chats" rows="4">${esc((s.allowedChats || []).join('\n'))}</textarea></div>
  <div class="field-row"><div class="field"><label>PDF 保留小时</label><input id="eh-keep" type="number" min="1" max="168" value="${esc(s.keepHours ?? 24)}"></div>
  <div class="field"><label>PDF 最多页数</label><input id="eh-pages" type="number" min="1" max="1000" value="${esc(s.maxPdfPages ?? 500)}"></div>
  <div class="field"><label>PDF 最大 MB</label><input id="eh-mb" type="number" min="1" max="512" value="${esc(Math.round((s.maxPdfBytes ?? 268435456) / 1048576))}"></div></div>
  <div class="field"><label>Python 路径（可选；共用 JM 的 Python/Pillow PDF 生成器）</label><input id="eh-python" value="${esc(s.pythonPath || '')}"></div>
  <div class="field"><label>E站专用本机代理（服务器直连不可用时填写）</label><input id="eh-proxy" placeholder="http://127.0.0.1:3223" value="${esc(s.proxyUrl || '')}"></div>
  <div class="field"><label>主站直连 IP（每行一个；无 SNI HTTP/2，仍严格校验证书）</label><textarea id="eh-ips" rows="2">${esc((s.directIps || ['172.66.132.196', '172.66.140.62']).join('\n'))}</textarea></div>
  <p class="hint">本地 PDF 到期每小时清理；仅清理 E站自有目录。群内上传后的文件不受本地清理影响。</p>
  <button class="btn" type="button" id="eh-refresh">刷新状态</button> <button class="btn" type="button" id="eh-cancel">取消当前任务</button><p id="eh-status" class="hint"></p>`;
}

async function saveEhentaiSettings() {
  const patch = {
    enabled: $('#eh-enabled').checked,
    allowedChats: [...new Set($('#eh-chats').value.split(/[\s,，]+/).filter(Boolean))],
    keepHours: Number($('#eh-keep').value), maxPdfPages: Number($('#eh-pages').value),
    maxPdfBytes: Math.round(Number($('#eh-mb').value) * 1048576),
    pythonPath: $('#eh-python').value.trim(), proxyUrl: $('#eh-proxy').value.trim(),
    directIps: [...new Set($('#eh-ips').value.split(/[\s,，]+/).filter(Boolean))]
  };
  try {
    const data = await api('/api/ehentai/settings', { method: 'POST', body: JSON.stringify(patch) });
    state.config.ehentai = data.settings;
    $('#cfg-save-result').textContent = 'E站设置已保存。';
  } catch (error) { $('#cfg-save-result').textContent = error.message; throw error; }
}

function bindEhentaiSection() {
  const refresh = async () => {
    const target = $('#eh-status');
    if (!target) return;
    try {
      const data = await api('/api/ehentai');
      if ($('#eh-status') === target) target.textContent = `${data.running ? '正在处理 PDF 或检索' : '当前空闲'} · 活跃列表 ${data.cachedLists}`;
    } catch (error) { if ($('#eh-status') === target) target.textContent = error.message; }
  };
  $('#eh-refresh')?.addEventListener('click', refresh);
  $('#eh-cancel')?.addEventListener('click', async () => { await api('/api/ehentai/cancel', { method: 'POST', body: '{}' }); await refresh(); });
  void refresh();
}
export { renderEhentaiSection, saveEhentaiSettings, bindEhentaiSection };
