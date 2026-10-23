import { api } from '../core/api.js';
import { $, esc } from '../core/dom.js';
import { state } from '../core/state.js';

function renderXSearchSection(config) {
  const s = config.xSearch || {};
  return `<h3>X 账号检索 · 试用版</h3>
  <p class="hint">发送「X @用户名」或完整 X／Twitter 个人主页链接，每页返回 5 条帖子的合并转发卡片；「X下一页」查看更早帖子。当前仅按用户名精确查询，昵称模糊搜索尚未接入。</p>
  <div class="field"><label><input id="x-search-enabled" type="checkbox" ${s.enabled ? 'checked' : ''}> 启用 X 账号检索</label></div>
  <div class="field"><label for="x-search-backend">数据来源</label><select id="x-search-backend"><option value="official" ${s.backend !== 'tokyo-browser' ? 'selected' : ''}>官方 API／兼容接口</option><option value="tokyo-browser" ${s.backend === 'tokyo-browser' ? 'selected' : ''}>东京浏览器登录态</option></select></div>
  <div id="x-search-official-fields" style="${s.backend === 'tokyo-browser' ? 'display:none' : ''}">
  <div class="field"><label>API 根地址</label><input id="x-search-base" type="url" value="${esc(s.apiBaseUrl || 'https://api.x.com')}"><div class="hint">默认使用官方 API；可填写兼容官方 /2/users 接口的 HTTPS 中转根地址。Token 会发送给此地址。</div></div>
  <div class="field"><label for="x-search-token" id="x-search-token-label">Bearer Token（${s.hasBearerToken ? '已保存' : '未配置'}）</label><input id="x-search-token" type="password" autocomplete="new-password" placeholder="留空保留现有 Token"><label><input id="x-search-clear-token" type="checkbox"> 清除已存 Token</label></div>
  </div>
  <div id="x-search-relay-fields" style="${s.backend === 'tokyo-browser' ? '' : 'display:none'}">
  <div class="field"><label for="x-search-relay-url">东京 SSH 隧道地址</label><input id="x-search-relay-url" value="${esc(s.relayUrl || 'http://127.0.0.1:3223')}"></div>
  <div class="field"><label for="x-search-relay-token" id="x-search-relay-token-label">中转令牌（${s.hasRelayToken ? '已保存' : '未配置'}）</label><input id="x-search-relay-token" type="password" autocomplete="new-password" placeholder="留空保留现有中转令牌"><label><input id="x-search-clear-relay-token" type="checkbox"> 清除中转令牌</label></div>
  <p class="hint">X 登录态只保存在东京，此处填写独立服务令牌，不是 X 密码或 Cookie。浏览器按需启动，每页 5 条，通过滚动公开时间线读取更早帖子；不支持回复或转帖筛选。网页限制可能使较早内容暂不可读。</p></div>
  <div class="field"><label><input id="x-search-translate" type="checkbox" ${s.translateChinese !== false ? 'checked' : ''}> 在非中文正文后附加中文翻译</label><div class="hint">调用当前聊天模型，可能产生费用和额外等待。保留原文并标注机器翻译；失败仍显示原文。</div></div>
  <div class="field-row"><div class="field"><label><input id="x-search-images" type="checkbox" ${s.includeImages !== false ? 'checked' : ''}> 附带图片缩略图</label></div>
  <div class="field"><label><input id="x-search-replies" type="checkbox" ${s.includeReplies ? 'checked' : ''}> 包含回复</label></div>
  <div class="field"><label><input id="x-search-reposts" type="checkbox" ${s.includeReposts ? 'checked' : ''}> 包含转帖</label></div></div>
  <div class="field-row"><div class="field"><label>查询超时（秒）</label><input id="x-search-timeout" type="number" min="5" max="60" value="${esc(s.timeoutSeconds ?? 45)}"></div>
  <div class="field"><label>每人查询冷却（秒）</label><input id="x-search-cooldown" type="number" min="5" max="300" value="${esc(s.cooldownSeconds ?? 15)}"></div></div>
  <p class="hint">官方 API 读取可能产生费用。公开帖子按时间倒序，最多四张配图缩略图／帖，视频仅显示封面和链接；敏感标记帖子保留提示并展示可读取的正文、翻译及配图。查询有 60 秒内存缓存，翻页状态 10 分钟过期，按群聊／私聊与发送者隔离。</p>
  <h3>试查账号</h3><p class="hint">先保存配置。点击试查使用所选来源读取第一页，并按设置翻译；可能计费，只在网页展示，不发送 QQ。</p>
  <div class="field-row"><div class="field"><label>用户名</label><input id="x-search-preview-user" placeholder="例如 XDevelopers" maxlength="16"></div><button class="btn" id="x-search-preview" type="button">试查最近帖子</button></div>
  <div id="x-search-preview-result" class="hint" role="status"></div>`;
}

async function saveXSearchSettings() {
  const patch = { enabled: $('#x-search-enabled').checked, backend: $('#x-search-backend').value,
    relayUrl: $('#x-search-relay-url').value.trim().replace(/\/$/, ''), apiBaseUrl: $('#x-search-base').value.trim().replace(/\/$/, ''),
    includeImages: $('#x-search-images').checked, translateChinese: $('#x-search-translate').checked, includeReplies: $('#x-search-replies').checked, includeReposts: $('#x-search-reposts').checked,
    timeoutSeconds: Number($('#x-search-timeout').value), cooldownSeconds: Number($('#x-search-cooldown').value) };
  if ($('#x-search-clear-token').checked) patch.bearerToken = '';
  else if ($('#x-search-token').value.trim()) patch.bearerToken = $('#x-search-token').value.trim();
  if ($('#x-search-clear-relay-token').checked) patch.relayToken = '';
  else if ($('#x-search-relay-token').value.trim()) patch.relayToken = $('#x-search-relay-token').value.trim();
  try {
    const data = await api('/api/x-search/settings', { method: 'POST', body: JSON.stringify(patch) });
    state.config.xSearch = data.settings;
    $('#x-search-token-label').textContent = `Bearer Token（${data.settings.hasBearerToken ? '已保存' : '未配置'}）`;
    $('#x-search-token').value = ''; $('#x-search-clear-token').checked = false;
    $('#x-search-relay-token').value = ''; $('#x-search-clear-relay-token').checked = false;
    $('#x-search-relay-token-label').textContent = `中转令牌（${data.settings.hasRelayToken ? '已保存' : '未配置'}）`;
    $('#cfg-save-result').textContent = 'X 设置已保存，立即生效。';
  } catch (error) { $('#cfg-save-result').textContent = error.message; throw error; }
}

function bindXSearchSection() {
  const backendChanged = () => {
    const browser = $('#x-search-backend').value === 'tokyo-browser';
    $('#x-search-official-fields').style.display = browser ? 'none' : '';
    $('#x-search-relay-fields').style.display = browser ? '' : 'none';
    $('#x-search-replies').disabled = browser; $('#x-search-reposts').disabled = browser;
  };
  $('#x-search-backend')?.addEventListener('change', backendChanged);
  backendChanged();
  $('#x-search-preview')?.addEventListener('click', async () => {
    const button = $('#x-search-preview'); const box = $('#x-search-preview-result');
    const username = $('#x-search-preview-user').value.trim();
    button.disabled = true; box.textContent = '正在查询…';
    try {
      const { page } = await api('/api/x-search/preview', { method: 'POST', body: JSON.stringify({ username }) });
      box.innerHTML = `<p>${esc(page.user.name)} @${esc(page.user.username)} · ${esc(page.fetchedAt)}</p>${page.posts.length
        ? page.posts.map((post) => `<p>${esc(post.createdAt)}<br>${post.sensitive ? '⚠️ 该帖被 X 标记为敏感内容。<br>' : ''}${esc(post.text.slice(0, 1800))}${post.translation ? `<br><br>中文翻译（机器翻译）：<br>${esc(post.translation)}` : post.translationUnavailable ? '<br>中文翻译暂不可用。' : ''}<br><a href="${esc(post.url)}" target="_blank" rel="noopener noreferrer">查看原帖</a></p>`).join('') : '<p>没有可显示的帖子。</p>'}`;
    } catch (error) { box.textContent = error.message; }
    finally { button.disabled = false; }
  });
}

export { renderXSearchSection, saveXSearchSettings, bindXSearchSection };
