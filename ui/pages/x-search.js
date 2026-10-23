import { api } from '../core/api.js';
import { $, esc } from '../core/dom.js';
import { state } from '../core/state.js';

function renderXSearchSection(config) {
  const s = config.xSearch || {};
  return `<h3>X 账号检索 · 试用版</h3>
  <p class="hint">发送「X @用户名」或完整 X／Twitter 个人主页链接，返回最近 5 条帖子的合并转发卡片；「X下一页」查看更早帖子。当前仅按用户名精确查询，昵称模糊搜索尚未接入。不调用聊天模型。</p>
  <div class="field"><label><input id="x-search-enabled" type="checkbox" ${s.enabled ? 'checked' : ''}> 启用 X 账号检索</label></div>
  <div class="field"><label>API 根地址</label><input id="x-search-base" type="url" value="${esc(s.apiBaseUrl || 'https://api.x.com')}"><div class="hint">默认使用官方 API；可填写兼容官方 /2/users 接口的 HTTPS 中转根地址。Token 会发送给此地址。</div></div>
  <div class="field"><label for="x-search-token" id="x-search-token-label">Bearer Token（${s.hasBearerToken ? '已保存' : '未配置'}）</label><input id="x-search-token" type="password" autocomplete="new-password" placeholder="留空保留现有 Token"><label><input id="x-search-clear-token" type="checkbox"> 清除已存 Token</label></div>
  <div class="field-row"><div class="field"><label><input id="x-search-images" type="checkbox" ${s.includeImages !== false ? 'checked' : ''}> 附带图片缩略图</label></div>
  <div class="field"><label><input id="x-search-replies" type="checkbox" ${s.includeReplies ? 'checked' : ''}> 包含回复</label></div>
  <div class="field"><label><input id="x-search-reposts" type="checkbox" ${s.includeReposts ? 'checked' : ''}> 包含转帖</label></div></div>
  <div class="field-row"><div class="field"><label>查询超时（秒）</label><input id="x-search-timeout" type="number" min="5" max="60" value="${esc(s.timeoutSeconds ?? 20)}"></div>
  <div class="field"><label>每人查询冷却（秒）</label><input id="x-search-cooldown" type="number" min="5" max="300" value="${esc(s.cooldownSeconds ?? 15)}"></div></div>
  <p class="hint">API 读取可能产生费用。公开帖子按时间倒序，最多两张缩略图／帖，视频仅显示封面和链接；敏感标记帖子仅提供链接。首次查询有 60 秒内存缓存，翻页状态 10 分钟过期，按群聊／私聊与发送者隔离。</p>
  <h3>试查账号</h3><p class="hint">先保存配置。点击试查会使用已保存配置读取 X API，可能计费；只在网页展示，不发送 QQ。</p>
  <div class="field-row"><div class="field"><label>用户名</label><input id="x-search-preview-user" placeholder="例如 XDevelopers" maxlength="16"></div><button class="btn" id="x-search-preview" type="button">试查最近帖子</button></div>
  <div id="x-search-preview-result" class="hint" role="status"></div>`;
}

async function saveXSearchSettings() {
  const patch = { enabled: $('#x-search-enabled').checked, apiBaseUrl: $('#x-search-base').value.trim().replace(/\/$/, ''),
    includeImages: $('#x-search-images').checked, includeReplies: $('#x-search-replies').checked, includeReposts: $('#x-search-reposts').checked,
    timeoutSeconds: Number($('#x-search-timeout').value), cooldownSeconds: Number($('#x-search-cooldown').value) };
  if ($('#x-search-clear-token').checked) patch.bearerToken = '';
  else if ($('#x-search-token').value.trim()) patch.bearerToken = $('#x-search-token').value.trim();
  try {
    const data = await api('/api/x-search/settings', { method: 'POST', body: JSON.stringify(patch) });
    state.config.xSearch = data.settings;
    $('#x-search-token-label').textContent = `Bearer Token（${data.settings.hasBearerToken ? '已保存' : '未配置'}）`;
    $('#x-search-token').value = ''; $('#x-search-clear-token').checked = false;
    $('#cfg-save-result').textContent = 'X 设置已保存，立即生效。';
  } catch (error) { $('#cfg-save-result').textContent = error.message; throw error; }
}

function bindXSearchSection() {
  $('#x-search-preview')?.addEventListener('click', async () => {
    const button = $('#x-search-preview'); const box = $('#x-search-preview-result');
    const username = $('#x-search-preview-user').value.trim();
    button.disabled = true; box.textContent = '正在查询…';
    try {
      const { page } = await api('/api/x-search/preview', { method: 'POST', body: JSON.stringify({ username }) });
      box.innerHTML = `<p>${esc(page.user.name)} @${esc(page.user.username)} · ${esc(page.fetchedAt)}</p>${page.posts.length
        ? page.posts.map((post) => `<p>${esc(post.createdAt)}<br>${esc(post.sensitive ? '敏感内容，请查看原帖' : post.text.slice(0, 1800))}<br><a href="${esc(post.url)}" target="_blank" rel="noopener noreferrer">查看原帖</a></p>`).join('') : '<p>没有可显示的帖子。</p>'}`;
    } catch (error) { box.textContent = error.message; }
    finally { button.disabled = false; }
  });
}

export { renderXSearchSection, saveXSearchSettings, bindXSearchSection };
