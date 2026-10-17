import { api } from '../core/api.js';
import { $, esc } from '../core/dom.js';
import { state } from '../core/state.js';

function pixivRatingRow(chat = 'group:', ratings = ['safe']) {
  const [kind, id] = chat.split(':');
  return `<div class="field-row pixiv-chat-row"><div class="field"><label>会话类型</label><select class="pixiv-chat-kind"><option value="group" ${kind !== 'private' ? 'selected' : ''}>群聊</option><option value="private" ${kind === 'private' ? 'selected' : ''}>私聊</option></select></div><div class="field"><label>群号／QQ号</label><input class="pixiv-chat-id" inputmode="numeric" value="${esc(id || '')}"></div><div class="field"><label>允许的分级</label>${['safe', 'r18', 'r18g'].map((r) => `<label><input type="checkbox" class="pixiv-chat-${r}" ${ratings.includes(r) ? 'checked' : ''}>${r === 'safe' ? '全年龄' : r.toUpperCase()}</label>`).join(' ')}<button class="btn pixiv-chat-remove" type="button">删除覆盖</button></div></div>`;
}
function renderPixivSection(config) {
  const s = config.pixiv || {};
  return `<h3>PID 搜索</h3><p class="hint">Agent 内置 Pixiv 功能。发送“PID 作品号”或完整作品链接，无需聊天模型；“PID 作品号 21-40”取指定页。关键词请求仍可由模型调用。</p>
  <div class="field"><label><input id="pixiv-enabled" type="checkbox" ${s.enabled ? 'checked' : ''}> 启用 PID 搜索</label></div>
  <div class="field"><label>默认允许分级</label>${['safe', 'r18', 'r18g'].map((r) => `<label><input id="pixiv-rating-${r}" type="checkbox" ${(s.ratings || ['safe']).includes(r) ? 'checked' : ''}> ${esc({ safe: '全年龄', r18: 'R18', r18g: 'R18G' }[r])}</label>`).join(' ')}</div>
  <div class="field"><label>按会话设置分级</label><div id="pixiv-chat-ratings">${Object.entries(s.chatRatings || {}).map(([chat, ratings]) => pixivRatingRow(chat, ratings)).join('')}</div><button class="btn" type="button" id="pixiv-chat-add">添加群聊／私聊覆盖</button><div class="hint">没有单独设置的会话沿用默认。删除覆盖后点击保存，恢复默认分级。仍受宿主聊天白名单约束；旧会话分级自动带入，保存立即生效。</div></div>
  <div class="field"><label>无法确认作品分级时</label><select id="pixiv-unknown"><option value="deny" ${s.unknownRatingPolicy !== 'adult-only' ? 'selected' : ''}>拒绝发送，提示核实作品</option><option value="adult-only" ${s.unknownRatingPolicy === 'adult-only' ? 'selected' : ''}>仅在同时允许 R18、R18G 的会话发送，并标明未知</option></select></div>
  <div class="field-row"><div class="field"><label>每次最多页数</label><input id="pixiv-max-pages" type="number" min="1" max="100" value="${esc(s.maxPages ?? 100)}"></div>
  <div class="field"><label>每批最多图片数</label><input id="pixiv-batch-pages" type="number" min="1" max="20" value="${esc(s.pagesPerBatch ?? 10)}"></div>
  <div class="field"><label>每批图片总大小（MB）</label><input id="pixiv-batch-mb" type="number" min="0.25" max="8" step="0.25" value="${esc((s.forwardBudgetBytes ?? 4194304) / 1048576)}"></div>
  <div class="field"><label>任务最长时间（秒）</label><input id="pixiv-timeout" type="number" min="30" max="600" value="${esc(s.taskTimeoutSeconds ?? 300)}"></div></div>
  <div class="field"><label>图片尺寸</label><select id="pixiv-size">${['original', 'regular', 'small', 'thumb', 'mini'].map((v) => `<option value="${v}" ${(s.imageSize || 'regular') === v ? 'selected' : ''}>${v === 'original' ? '原图（更慢、更大）' : v}</option>`).join('')}</select><div class="hint">多页按大小分成多张合并卡片；缺页会明确提示，发送未确认立即停止，不自动补发。</div></div>
  <details><summary>网络与图片处理</summary><p class="hint">使用现有 Pixiv 下载链路，与以图搜图中转相互独立。默认作品详情接口在当前网络不可用时可填写自有接口，必须包含 {pid}。</p>
  <div class="field"><label>作品详情接口（可留空）</label><input id="pixiv-metadata" value="${esc(s.metadataUrlTemplate || '')}" placeholder="https://example.com/illust/{pid}"></div>
  <div class="field"><label>关键词接口</label><input id="pixiv-search" value="${esc(s.loliconApiUrl || 'https://api.lolicon.app/setu/v2')}"></div>
  <div class="field"><label>图片地址模板</label><input id="pixiv-image-template" value="${esc(s.imageUrlTemplate || 'https://pixiv.re/{pid}.png')}"></div>
  <div class="field"><label>Pixiv Cookie${s.hasCookie ? '（已保存）' : ''}</label><input id="pixiv-cookie" type="password" autocomplete="new-password" placeholder="留空保留"><label><input id="pixiv-clear-cookie" type="checkbox"> 清除 Cookie</label></div>
  <div class="field"><label>自选 HTTP 代理${s.hasProxyUrl ? '（已保存）' : ''}</label><input id="pixiv-proxy" type="password" autocomplete="new-password" placeholder="留空保留"><label><input id="pixiv-clear-proxy" type="checkbox"> 清除代理</label></div>
  <div class="field-row"><div class="field"><label>单张下载上限（MB）</label><input id="pixiv-max-image" type="number" min="0.25" max="16" step="0.25" value="${esc((s.maxImageBytes ?? 5242880) / 1048576)}"></div>
  <div class="field"><label>超过多少 KB 压缩（0为不压缩）</label><input id="pixiv-compress" type="number" min="0" max="16384" value="${esc((s.downsampleOverBytes ?? 819200) / 1024)}"></div>
  <div class="field"><label>压缩后最长边（像素）</label><input id="pixiv-edge" type="number" min="256" max="4096" value="${esc(s.downsampleMaxEdge ?? 1200)}"></div></div></details>
  <h4>核实作品分级</h4><p class="hint">仅在你已核实作品内容后标记。它只影响该 PID，不会放开整个群；会话仍须允许对应分级。</p>
  <div class="field-row"><div class="field"><label>作品 PID</label><input id="pixiv-mark-pid" inputmode="numeric"></div><div class="field"><label>核实分级</label><select id="pixiv-mark-rating"><option value="safe">全年龄</option><option value="r18">R18</option><option value="r18g">R18G</option><option value="clear">清除人工标记</option></select></div></div>
  <button class="btn" type="button" id="pixiv-mark-save">保存作品标记</button><p id="pixiv-mark-result" class="hint"></p>
  <button class="btn" type="button" id="pixiv-refresh">刷新任务与作品标记</button> <button class="btn" type="button" id="pixiv-cancel">取消当前任务</button>
  <div id="pixiv-records" style="overflow-wrap:anywhere"></div>`;
}
async function savePixivSettings() {
  try {
    const chatRatings = {};
    for (const row of $('#pixiv-chat-ratings').querySelectorAll('.pixiv-chat-row')) {
      const id = row.querySelector('.pixiv-chat-id').value.trim();
      if (!id) continue;
      if (!/^\d{5,15}$/.test(id)) throw new Error('群号／QQ号必须为5到15位数字');
      const chat = `${row.querySelector('.pixiv-chat-kind').value}:${id}`;
      if (chat in chatRatings) throw new Error('同一会话不能重复添加覆盖');
      const ratings = ['safe', 'r18', 'r18g'].filter((r) => row.querySelector(`.pixiv-chat-${r}`).checked);
      if (!ratings.length) throw new Error('每个会话至少允许一种分级；恢复默认请删除覆盖');
      chatRatings[chat] = ratings;
    }
    const patch = { enabled: $('#pixiv-enabled').checked, ratings: ['safe', 'r18', 'r18g'].filter((r) => $(`#pixiv-rating-${r}`).checked),
      chatRatings, unknownRatingPolicy: $('#pixiv-unknown').value, maxPages: Number($('#pixiv-max-pages').value), pagesPerBatch: Number($('#pixiv-batch-pages').value),
      forwardBudgetBytes: Math.round(Number($('#pixiv-batch-mb').value) * 1048576), taskTimeoutSeconds: Number($('#pixiv-timeout').value), imageSize: $('#pixiv-size').value,
      metadataUrlTemplate: $('#pixiv-metadata').value.trim(), loliconApiUrl: $('#pixiv-search').value.trim(), imageUrlTemplate: $('#pixiv-image-template').value.trim(),
      maxImageBytes: Math.round(Number($('#pixiv-max-image').value) * 1048576), downsampleOverBytes: Math.round(Number($('#pixiv-compress').value) * 1024), downsampleMaxEdge: Number($('#pixiv-edge').value) };
    for (const [field, id] of [['cookie', 'cookie'], ['proxyUrl', 'proxy']]) {
      if ($(`#pixiv-clear-${id}`).checked) patch[field] = '';
      else if ($(`#pixiv-${id}`).value.trim()) patch[field] = $(`#pixiv-${id}`).value.trim();
    }
    const data = await api('/api/pixiv/settings', { method: 'POST', body: JSON.stringify(patch) });
    state.config.pixiv = data.settings;
    $('#pixiv-cookie').value = ''; $('#pixiv-proxy').value = '';
    $('#pixiv-clear-cookie').checked = false; $('#pixiv-clear-proxy').checked = false;
    $('#cfg-save-result').textContent = 'PID 搜索设置已保存，立即生效。';
  } catch (error) { $('#cfg-save-result').textContent = error.message; throw error; }
}
function bindPixivSection() {
  $('#pixiv-chat-add')?.addEventListener('click', () => $('#pixiv-chat-ratings').insertAdjacentHTML('beforeend', pixivRatingRow()));
  $('#pixiv-chat-ratings')?.addEventListener('click', (event) => { if (event.target.closest('.pixiv-chat-remove')) event.target.closest('.pixiv-chat-row')?.remove(); });
  const refresh = async () => {
    const box = $('#pixiv-records'); if (!box) return;
    try {
      const data = await api('/api/pixiv');
      if ($('#pixiv-records') !== box) return;
      box.innerHTML = `<p>${data.running ? '任务运行中' : '当前空闲'}</p><p>人工作品标记：${Object.entries(data.overrides).map(([pid, row]) => `${esc(pid)}：${esc(row.rating)}`).join('；') || '无'}</p>${data.history.slice(0, 20).map((r) => `<p>${esc(r.startedAt)} · ${esc(r.chatKey)} · ${esc({ done: '已完成', partial: '部分完成', failed: '失败', running: '运行中', cancelled: '已取消或超时', interrupted: '重启中断，未自动重试', 'send-unknown': '发送未确认，已停止' }[r.status] || r.status)} · 已发送${esc(r.pages?.length || 0)}页，未取到${esc(r.failedPages?.length || 0)}页 ${esc(r.note || '')}</p>`).join('')}`;
    } catch (error) { if ($('#pixiv-records') === box) box.textContent = error.message; }
  };
  $('#pixiv-refresh')?.addEventListener('click', refresh);
  $('#pixiv-cancel')?.addEventListener('click', async () => { await api('/api/pixiv/cancel', { method: 'POST', body: '{}' }); await refresh(); });
  $('#pixiv-mark-save')?.addEventListener('click', async () => {
    if (!window.confirm('确认已核实该作品的分级，并保存此 PID 的人工标记？')) return;
    try { await api('/api/pixiv/rating', { method: 'POST', body: JSON.stringify({ pid: $('#pixiv-mark-pid').value.trim(), rating: $('#pixiv-mark-rating').value }) }); $('#pixiv-mark-result').textContent = '作品标记已保存。'; await refresh(); }
    catch (error) { $('#pixiv-mark-result').textContent = error.message; }
  });
  void refresh();
}
export { renderPixivSection, savePixivSettings, bindPixivSection };
