import { api } from '../core/api.js';
import { $, esc } from '../core/dom.js';
import { state } from '../core/state.js';

const NOVEL_SOURCE_LABELS = {
  pixiv: 'Pixiv 小说（二游同人主力，自动抗语C/群宣过滤）',
  cool18: 'Cool18 禁忌书屋（免登录全站中文 R-18）',
  esjzone: 'ESJZone（免登录日轻 / R-18 里轻长篇）',
  telegram: 'Telegram 频道（需东京端登录授权后生效）'
};

function formatChannelsText(channels) {
  const list = Array.isArray(channels) && channels.length ? channels : [
    { id: 'px_novels', label: '蓝P官能文学社', aliases: ['蓝p', 'px'], enabled: true, summaryMode: 'clean' },
    { id: 'happylibrary', label: '开心书库', aliases: ['开心', 'happy'], enabled: true, summaryMode: 'clean' }
  ];
  return list.map((c) => {
    const id = String(c.id || '').trim();
    const label = String(c.label || id).trim();
    const aliases = Array.isArray(c.aliases) ? c.aliases.join(',') : '';
    const mode = c.summaryMode === 'minimal' ? 'minimal' : 'clean';
    return `${id}|${label}|${aliases}|${mode}`;
  }).join('\n');
}

function parseChannelsText(rawText, fallbackMode = 'clean') {
  const lines = String(rawText || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const channels = [];
  for (const line of lines) {
    const parts = line.split('|').map((p) => p.trim());
    const id = String(parts[0] || '').replace(/^@+/, '').toLowerCase();
    if (!id) continue;
    const label = parts[1] || id;
    const aliases = (parts[2] || '').split(/[,，\s]+/).map((a) => a.trim()).filter(Boolean);
    const mode = parts[3] === 'minimal' ? 'minimal' : (parts[3] === 'clean' ? 'clean' : fallbackMode);
    channels.push({ id, label, aliases, enabled: true, summaryMode: mode });
  }
  return channels;
}

function renderNovelSearchSection(config) {
  const s = config.novelSearch || {};
  const mode = s.summaryMode === 'minimal' ? 'minimal' : 'clean';
  const pixivCookieStatus = s.hasPixivCookie
    ? '（已单独保存，留空保留）'
    : (s.hasGlobalPixivCookie ? '（当前自动复用 PID 搜索中的 Pixiv Cookie）' : '（未配置：游客模式仅搜全年龄，填 PHPSESSID 可解锁全站 R-18）');

  return `<h3>小说检索（Pixiv / 禁忌书屋 / ESJZone / TG 频道多源聚合）</h3>
    <p class="hint">发送“/搜小说 关键词”、“/P站小说 关键词”、“/禁忌书屋 关键词”、“/ESJ 关键词”或“/小说最新”，支持 #标签 组合与 -避雷词（如“/搜小说 #纯爱 #校园 -NTR”）。由东京中转检索并自动去广告/过滤语C水帖，以合并转发卡片展示；群友回复序号即可合成 UTF-8 .txt 上传群文件。</p>
    <div class="field"><label><input id="novel-search-enabled" type="checkbox" ${s.enabled ? 'checked' : ''}> 启用小说检索</label></div>
    <div class="field"><label>启用的书源</label>
      <div>${Object.entries(NOVEL_SOURCE_LABELS).map(([key, label]) => `<label style="margin-right:12px;display:inline-block"><input id="novel-search-source-${key}" type="checkbox" ${(s.sources?.[key] ?? true) ? 'checked' : ''}> ${esc(label)}</label>`).join('')}</div>
    </div>
    <div class="field"><label>允许使用的群号（每行一个，空名单表示所有群均不允许）</label><textarea id="novel-search-groups" rows="3" placeholder="每行一个群号">${esc((s.allowedGroups || []).join('\n'))}</textarea></div>
    <div class="field"><label><input id="novel-search-private" type="checkbox" ${s.allowPrivate ? 'checked' : ''}> 允许私聊使用小说检索（仍受宿主私聊白名单限制）</label></div>
    <div class="field"><label><input id="novel-search-normalize-txt" type="checkbox" ${s.normalizeTxt !== false ? 'checked' : ''}> 自动检测 GBK/GB18030 等编码并将 .txt 转为 UTF-8 防乱码</label></div>
    <div class="field-row">
      <div class="field"><label>默认卡片展示模式</label>
        <select id="novel-search-summary-mode">
          <option value="clean" ${mode === 'clean' ? 'selected' : ''}>去广告后保留标签与简短简介（推荐）</option>
          <option value="minimal" ${mode === 'minimal' ? 'selected' : ''}>极简纯净（仅书名、格式大小与标签）</option>
        </select>
      </div>
      <div class="field"><label>每页展示条数（5—10）</label><input id="novel-search-page-size" type="number" min="5" max="10" value="${esc(s.pageSize ?? 8)}"></div>
      <div class="field"><label>单文件体积上限（MB，1—100）</label><input id="novel-search-max-mb" type="number" min="1" max="100" value="${esc(s.maxFileSizeMb ?? 30)}"></div>
    </div>
    <div class="field-row">
      <div class="field"><label>Pixiv 最小字数过滤（防语C水帖，0—20000）</label><input id="novel-search-pixiv-min-chars" type="number" min="0" max="20000" value="${esc(s.pixivMinChars ?? 1500)}"></div>
      <div class="field"><label>ESJ 单次合并最大章数（1—200）</label><input id="novel-search-esj-max-chapters" type="number" min="1" max="200" value="${esc(s.esjMaxChapters ?? 80)}"></div>
      <div class="field"><label>检索超时（秒，10—180）</label><input id="novel-search-timeout" type="number" min="10" max="180" value="${esc(s.timeoutSeconds ?? 60)}"></div>
    </div>
    <div class="field-row">
      <div class="field"><label>搜索冷却（秒，0—3600）</label><input id="novel-search-cooldown" type="number" min="0" max="3600" value="${esc(s.cooldownSeconds ?? 8)}"></div>
      <div class="field"><label>下载冷却（秒，0—3600）</label><input id="novel-search-dl-cooldown" type="number" min="0" max="3600" value="${esc(s.downloadCooldownSeconds ?? 10)}"></div>
    </div>
    <div class="field">
      <label id="novel-search-pixiv-cookie-label" for="novel-search-pixiv-cookie">Pixiv Cookie（可选，填浏览器 PHPSESSID 解锁全站 R-18 小说）${esc(pixivCookieStatus)}</label>
      <input id="novel-search-pixiv-cookie" type="password" autocomplete="new-password" placeholder="粘贴 PHPSESSID 值或完整 Cookie，留空则游客全年龄模式">
      <label><input id="novel-search-clear-pixiv-cookie" type="checkbox"> 清除已保存的 Pixiv Cookie</label>
    </div>
    <div class="field">
      <label>Telegram 频道白名单（每行一个：<code>频道用户名|显示名|别名1,别名2|clean或minimal</code>）</label>
      <textarea id="novel-search-channels" rows="3" placeholder="px_novels|蓝P官能文学社|蓝p,px|clean">${esc(formatChannelsText(s.channels))}</textarea>
    </div>
    <h4 style="margin:14px 0 8px">东京小说中转连接</h4>
    <div class="field"><label>本机中转地址（经 SSH 隧道映射）</label><input id="novel-search-relay-url" type="url" value="${esc(s.relayUrl || 'http://127.0.0.1:3224')}"></div>
    <div class="field">
      <label id="novel-search-token-label" for="novel-search-relay-token">中转 Bearer 令牌${s.hasRelayToken ? '（已保存，留空保留）' : '（未配置）'}</label>
      <input id="novel-search-relay-token" type="password" autocomplete="new-password" placeholder="粘贴东京 relay-token">
      <label><input id="novel-search-clear-token" type="checkbox"> 清除已保存的令牌</label>
    </div>
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px">
      <button type="button" class="btn" id="novel-search-check-health">检测东京中转状态</button>
      <button type="button" class="btn" id="novel-search-refresh">刷新记录</button>
    </div>
    <div id="novel-search-health-result" class="hint" style="margin-top:8px"></div>
    <div id="novel-search-history" style="overflow-wrap:anywhere;margin-top:8px"></div>`;
}

async function saveNovelSearchSettings() {
  const summaryMode = $('#novel-search-summary-mode').value === 'minimal' ? 'minimal' : 'clean';
  const patch = {
    enabled: $('#novel-search-enabled').checked,
    allowPrivate: $('#novel-search-private').checked,
    normalizeTxt: $('#novel-search-normalize-txt').checked,
    allowedGroups: [...new Set($('#novel-search-groups').value.split(/[\s,，]+/).filter(Boolean))],
    sources: Object.fromEntries(Object.keys(NOVEL_SOURCE_LABELS).map((key) => [key, $(`#novel-search-source-${key}`).checked])),
    summaryMode,
    pageSize: Number($('#novel-search-page-size').value),
    maxFileSizeMb: Number($('#novel-search-max-mb').value),
    pixivMinChars: Number($('#novel-search-pixiv-min-chars').value),
    esjMaxChapters: Number($('#novel-search-esj-max-chapters').value),
    cooldownSeconds: Number($('#novel-search-cooldown').value),
    downloadCooldownSeconds: Number($('#novel-search-dl-cooldown').value),
    timeoutSeconds: Number($('#novel-search-timeout').value),
    relayUrl: $('#novel-search-relay-url').value.trim(),
    channels: parseChannelsText($('#novel-search-channels').value, summaryMode)
  };
  const token = $('#novel-search-relay-token').value.trim();
  if (token || $('#novel-search-clear-token').checked) {
    patch.relayToken = $('#novel-search-clear-token').checked ? '' : token;
  }
  const pixivCookie = $('#novel-search-pixiv-cookie').value.trim();
  if (pixivCookie || $('#novel-search-clear-pixiv-cookie').checked) {
    patch.pixivCookie = $('#novel-search-clear-pixiv-cookie').checked ? '' : pixivCookie;
  }
  try {
    const result = await api('/api/novel-search/settings', { method: 'POST', body: JSON.stringify(patch) });
    state.config.novelSearch = result.settings;
    $('#novel-search-relay-token').value = '';
    $('#novel-search-clear-token').checked = false;
    $('#novel-search-token-label').textContent = `中转 Bearer 令牌${result.settings.hasRelayToken ? '（已保存，留空保留）' : '（未配置）'}`;
    $('#novel-search-pixiv-cookie').value = '';
    $('#novel-search-clear-pixiv-cookie').checked = false;
    const pStatus = result.settings.hasPixivCookie
      ? '（已单独保存，留空保留）'
      : (result.settings.hasGlobalPixivCookie ? '（当前自动复用 PID 搜索中的 Pixiv Cookie）' : '（未配置：游客模式仅搜全年龄，填 PHPSESSID 可解锁全站 R-18）');
    $('#novel-search-pixiv-cookie-label').textContent = `Pixiv Cookie（可选，填浏览器 PHPSESSID 解锁全站 R-18 小说）${pStatus}`;
    $('#cfg-save-result').textContent = '小说检索设置已保存，立即生效。';
  } catch (error) {
    $('#cfg-save-result').textContent = error.message;
    throw error;
  }
}

function bindNovelSearchSection() {
  const refresh = async () => {
    const box = $('#novel-search-history');
    if (!box) return;
    try {
      const data = await api('/api/novel-search');
      const rows = Array.isArray(data?.history) ? data.history : [];
      if (!rows.length) {
        box.innerHTML = '<p class="hint">暂无小说检索或下载记录。</p>';
        return;
      }
      box.innerHTML = rows.slice(0, 15).map((r) => {
        const status = r.status === 'ok' ? '成功' : `失败：${r.error || '未知错误'}`;
        const extra = r.action === 'download'
          ? (r.size ? ` · ${(r.size / 1024).toFixed(0)} KB${r.cacheHit ? '（缓存）' : ''}` : '')
          : (Number.isFinite(r.count) ? ` · ${r.count} 本` : '');
        return `<div class="hint">[${esc((r.at || '').slice(0, 19).replace('T', ' '))}] ${esc(r.action || '')} · ${esc(r.chatKey || '')} · ${esc(r.query || '')}${esc(extra)} · ${esc(status)}</div>`;
      }).join('');
    } catch (error) {
      box.innerHTML = `<p class="hint">加载记录失败：${esc(error.message)}</p>`;
    }
  };

  $('#novel-search-refresh')?.addEventListener('click', refresh);
  $('#novel-search-check-health')?.addEventListener('click', async () => {
    const out = $('#novel-search-health-result');
    if (!out) return;
    out.textContent = '正在检测东京小说中转状态…';
    try {
      const h = await api('/api/novel-search/health');
      const webList = Array.isArray(h?.webSources) ? h.webSources.join(' / ') : 'pixiv / cool18 / esjzone';
      const tgState = h?.authorized ? '已登录授权' : '未登录（不影响免登录书源）';
      const cacheMb = Number.isFinite(h?.cacheBytes) ? `${(h.cacheBytes / (1024 * 1024)).toFixed(1)} MB` : '0 MB';
      out.textContent = `中转正常 · 免登录书源：${webList} · Telegram：${tgState} · 东京缓存：${cacheMb}`;
    } catch (error) {
      out.textContent = `中转不可用：${error.message}`;
    }
  });
  void refresh();
}

export { renderNovelSearchSection, saveNovelSearchSettings, bindNovelSearchSection };
