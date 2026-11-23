import { api } from '../core/api.js';
import { $, esc } from '../core/dom.js';
import { state } from '../core/state.js';

const RESOURCE_SOURCE_LABELS = {
  shionlib: '书音的图书馆（免费 Gal 库）',
  kungal: '鲲 Galgame（公开资源与网盘库）',
  shinnku: '真红小站（失落小站直链归档库）',
  touchgal: 'TouchGal 资源站（直链/网盘）',
  vndb: 'VNDB（权威原名/别名库）',
  bangumi: 'Bangumi 番组计划（中文资料/封面）',
  dlsite: 'DLsite（同人黄油 RJ 库）',
  steam: 'Steam 商店',
  animetrace: 'AnimeTrace（Galgame 截图识作品）',
  web: '全网搜索兜底'
};

function renderResourceSearchSection(config) {
  const s = config.resourceSearch || {};
  const hasGlobalDs = Boolean(config.providerKeyPresence?.deepseek || s.hasGlobalDeepseekKey);
  const dsKeyStatus = s.hasDeepseekApiKey
    ? '（已单独保存，留空保留）'
    : (hasGlobalDs ? '（当前自动复用「模型 API」中的 DeepSeek Key）' : '（尚未配置，可在模型 API 或此处填写）');
  const hasTokyoRelay = Boolean((config.imageSearch?.relayUrl && config.imageSearch?.hasRelayToken) || s.hasTokyoRelay);
  const relayHint = hasTokyoRelay
    ? `（已自动复用以图搜图东京中转 ${config.imageSearch?.relayUrl || s.tokyoRelayUrl || 'http://127.0.0.1:3220'}）`
    : (s.effectiveProxyUrl ? `（当前生效本机代理 ${s.effectiveProxyUrl}）` : '（留空则优先复用以图搜图东京中转 3220 或 Pixiv/E站本机隧道）');
  return `<h3>资源检索（DeepSeek 后台多轮深度检索）</h3>
    <p class="hint">发送“/找资源 游戏名”、“/求资源 游戏名”或“/搜黄油 游戏名”，也支持模糊剧情描述或附带/引用回复一张游戏截图发送“/找资源”。后台由 DeepSeek 主导多轮检索（最高 8 轮，结合高并发多站爬取与东京受控外网读页，不加载聊天人设与群聊历史，不阻塞前台正常聊天），完成后以合并转发卡片返回免费资源与正版参考。</p>
    <div class="field"><label><input id="resource-search-enabled" type="checkbox" ${s.enabled ? 'checked' : ''}> 启用资源检索</label></div>
    <div class="field"><label>并发检索站点（建议勾选多个站点，避免单一站点漏搜或找错）</label>
      <div>${Object.entries(RESOURCE_SOURCE_LABELS).map(([key, label]) => `<label style="margin-right:12px;display:inline-block"><input id="resource-search-source-${key}" type="checkbox" ${(s.sources?.[key] ?? true) ? 'checked' : ''}> ${esc(label)}</label>`).join('')}</div>
    </div>
    <div class="field"><label>允许使用的群号（每行一个，空名单表示所有群均不允许）</label><textarea id="resource-search-groups" rows="3" placeholder="每行一个群号">${esc((s.allowedGroups || []).join('\n'))}</textarea></div>
    <div class="field"><label><input id="resource-search-private" type="checkbox" ${s.allowPrivate ? 'checked' : ''}> 允许私聊使用资源检索（仍受宿主私聊白名单限制）</label></div>
    <div class="field"><label><input id="resource-search-images" type="checkbox" ${s.includeImages !== false ? 'checked' : ''}> 合并转发卡片内附带作品封面预览图（已自动压缩转码；如某群图片风控严可关闭）</label></div>
    <div class="field"><label><input id="resource-search-safe-group-links" type="checkbox" ${s.safeGroupLinks === true ? 'checked' : ''}> 群聊链接加 [.] 混淆防风控（默认关闭，直接发送完整链接；如遇某群吞消息/风控再勾选开启，私聊始终发完整链接）</label></div>
    <div class="field-row">
      <div class="field"><label>检索总超时（秒，15—300）</label><input id="resource-search-timeout" type="number" min="15" max="300" value="${esc(s.timeoutSeconds ?? 150)}"></div>
      <div class="field"><label>最多展示免费资源条数（1—10）</label><input id="resource-search-max-results" type="number" min="1" max="10" value="${esc(s.maxResults ?? 5)}"></div>
      <div class="field"><label>同会话冷却（秒，0—3600）</label><input id="resource-search-cooldown" type="number" min="0" max="3600" value="${esc(s.cooldownSeconds ?? 15)}"></div>
    </div>
    <h4 style="margin:14px 0 8px">后台 DeepSeek、东京隧道与站点可选凭据</h4>
    <div class="field-row">
      <div class="field"><label>DeepSeek API 地址</label><input id="resource-search-ds-url" type="url" value="${esc(s.deepseekBaseUrl || 'https://api.deepseek.com/v1')}"></div>
      <div class="field"><label>DeepSeek 模型</label><input id="resource-search-ds-model" value="${esc(s.deepseekModel || 'deepseek-chat')}"></div>
    </div>
    <div class="field">
      <label id="resource-search-ds-key-label" for="resource-search-ds-key">专用 DeepSeek API Key${esc(dsKeyStatus)}</label>
      <input id="resource-search-ds-key" type="password" autocomplete="new-password" placeholder="留空则默认复用全局 DeepSeek 密钥">
      <label><input id="resource-search-clear-ds-key" type="checkbox"> 清除已单独保存的 DeepSeek Key</label>
    </div>
    <div class="field">
      <label id="resource-search-proxy-label" for="resource-search-proxy-url">海外站点（DLsite / Steam / Yahoo日本）本机代理地址${esc(relayHint)}</label>
      <input id="resource-search-proxy-url" type="url" placeholder="例如 http://127.0.0.1:3222（留空自动复用东京搜图中转或已有本机隧道）" value="${esc(s.proxyUrl || '')}">
    </div>
    <div class="field-row">
      <div class="field"><label>TouchGal 域名</label><input id="resource-search-tg-domain" value="${esc(s.touchgalDomain || 'www.touchgal.ink')}"></div>
      <div class="field"><label>书音图书馆域名</label><input id="resource-search-shion-domain" value="${esc(s.shionlibDomain || 'shionlib.com')}"></div>
    </div>
    <div class="field">
      <label id="resource-search-tg-token-label" for="resource-search-tg-token">TouchGal 登录 Token（可选，用于解锁 TouchGal 站内 R18 直链）${s.hasTouchgalToken ? '（已保存，留空保留）' : '（未配置）'}</label>
      <input id="resource-search-tg-token" type="password" autocomplete="new-password" placeholder="浏览器 Cookie 中的 kun-galgame-patch-moe-token，可留空">
      <label><input id="resource-search-clear-tg-token" type="checkbox"> 清除已保存的 TouchGal Token</label>
    </div>
    <button type="button" class="btn" id="resource-search-refresh">刷新任务记录</button>
    <div id="resource-search-history" style="overflow-wrap:anywhere;margin-top:8px"></div>`;
}

async function saveResourceSearchSettings() {
  const patch = {
    enabled: $('#resource-search-enabled').checked,
    allowPrivate: $('#resource-search-private').checked,
    includeImages: $('#resource-search-images').checked,
    safeGroupLinks: $('#resource-search-safe-group-links') ? $('#resource-search-safe-group-links').checked : false,
    allowedGroups: [...new Set($('#resource-search-groups').value.split(/[\s,，]+/).filter(Boolean))],
    sources: Object.fromEntries(Object.keys(RESOURCE_SOURCE_LABELS).map((key) => [key, $(`#resource-search-source-${key}`).checked])),
    timeoutSeconds: Number($('#resource-search-timeout').value),
    maxResults: Number($('#resource-search-max-results').value),
    cooldownSeconds: Number($('#resource-search-cooldown').value),
    deepseekBaseUrl: $('#resource-search-ds-url').value.trim(),
    deepseekModel: $('#resource-search-ds-model').value.trim(),
    proxyUrl: $('#resource-search-proxy-url') ? $('#resource-search-proxy-url').value.trim() : '',
    touchgalDomain: $('#resource-search-tg-domain').value.trim(),
    shionlibDomain: $('#resource-search-shion-domain').value.trim()
  };
  const dsKey = $('#resource-search-ds-key').value.trim();
  if (dsKey || $('#resource-search-clear-ds-key').checked) {
    patch.deepseekApiKey = $('#resource-search-clear-ds-key').checked ? '' : dsKey;
  }
  const tgToken = $('#resource-search-tg-token').value.trim();
  if (tgToken || $('#resource-search-clear-tg-token').checked) {
    patch.touchgalToken = $('#resource-search-clear-tg-token').checked ? '' : tgToken;
  }
  try {
    const result = await api('/api/resource-search/settings', { method: 'POST', body: JSON.stringify(patch) });
    state.config.resourceSearch = result.settings;
    $('#resource-search-ds-key').value = '';
    $('#resource-search-clear-ds-key').checked = false;
    const hasGlobalDs = Boolean(state.config.providerKeyPresence?.deepseek || result.settings.hasGlobalDeepseekKey);
    const dsStatus = result.settings.hasDeepseekApiKey
      ? '（已单独保存，留空保留）'
      : (hasGlobalDs ? '（当前自动复用「模型 API」中的 DeepSeek Key）' : '（尚未配置，可在模型 API 或此处填写）');
    $('#resource-search-ds-key-label').textContent = `专用 DeepSeek API Key${dsStatus}`;
    $('#resource-search-tg-token').value = '';
    $('#resource-search-clear-tg-token').checked = false;
    $('#resource-search-tg-token-label').textContent = `TouchGal 登录 Token（可选，用于解锁 TouchGal 站内 R18 直链）${result.settings.hasTouchgalToken ? '（已保存，留空保留）' : '（未配置）'}`;
    $('#cfg-save-result').textContent = '资源检索设置已保存，立即生效。';
  } catch (error) {
    $('#cfg-save-result').textContent = error.message;
    throw error;
  }
}

function bindResourceSearchSection() {
  const refresh = async () => {
    const box = $('#resource-search-history');
    if (!box) return;
    try {
      const data = await api('/api/resource-search');
      if ($('#resource-search-history') !== box) return;
      const statusText = {
        running: '运行中',
        interrupted: '重启中断，未自动重试',
        done: '已完成',
        'no-result': '未检出可用资源',
        cancelled: '已取消',
        failed: '失败',
        'send-unknown': '发送结果未确认，请检查会话'
      };
      box.innerHTML = `<p>${data.running ? '正在后台检索资源' : '当前空闲'}</p>${(data.history || []).slice(0, 20).map((row) => `<p>${esc(row.startedAt)} · ${esc(row.chatKey)} · 关键词：${esc(row.query || '')} · ${esc(statusText[row.status] || row.status)}${row.error ? `（${esc(row.error)}）` : ''}${(row.sources || []).map((s) => ` · ${esc(s.source)}:${esc(s.count)}条`).join('')}</p>`).join('') || '<p class="muted">暂无资源检索记录</p>'}`;
    } catch (error) {
      if ($('#resource-search-history') === box) box.textContent = error.message;
    }
  };
  $('#resource-search-refresh')?.addEventListener('click', refresh);
  refresh();
}

export { renderResourceSearchSection, saveResourceSearchSettings, bindResourceSearchSection };
