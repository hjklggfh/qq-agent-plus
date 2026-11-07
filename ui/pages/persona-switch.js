// 第二人设（按群召唤）设置页：正文 / 模型 / 触发词，以及"哪些群正在值班"。
//
// 落盘的两块配置（见 src/core/config-legacy.js）：
//   - personaSwitch：编排器**实际读**的那份（开关、模型、正文、触发词、闲置时长）；
//   - altPersona  ：只剩 botName / selfNickname 还在被读（群内展示名），其余字段是历史形状。
// 所以这个页面只写 personaSwitch，外加 altPersona 的两个显示名字段 —— 正文只存一份，
// 免得同一段 15KB 的文本在 config.json 里出现两次、还不知道哪份生效。
'use strict';

import { closeModelModal, modelModalShell } from '../app.js';
import { api } from '../core/api.js';
import { $, esc } from '../core/dom.js';
import { state } from '../core/state.js';

const DEFAULT_CALL_WORDS = 'claude, 克劳德';
const DEFAULT_HOME_WORDS = 'gemi, 哈基米';

/** 数组配置 → 输入框里的逗号分隔文本（空数组回落到默认词，别显示成空白）。 */
function wordsOf(value, fallback) {
  const list = Array.isArray(value) ? value.map((v) => String(v ?? '').trim()).filter(Boolean) : [];
  return esc(list.length ? list.join(', ') : fallback);
}

function profileOf(value) {
  return value === 'grounded' ? 'grounded' : 'legacy';
}

/** 第二人设是否真的会生效：开关 + 模型 + 正文，三者缺一不可（与 altPersonaReady 同口径）。 */
function readyHint(s) {
  if (s.enabled !== true) return '功能未启用：下面填的东西会保存，但不会触发切换。';
  if (!String(s.altModel || '').trim()) return '还差模型：填一个当前渠道里存在的模型 id，否则第二人设不会生效。';
  if (!String(s.altRoleText || '').trim()) return '还差正文：粘一份第二人设的角色设定，否则第二人设不会生效。';
  return '已就绪：群友按呼叫方式点名时，这个群会临时切到第二人设，闲置到时间后自动交还。';
}

function renderPersonaSwitchSection(config) {
  const c = config || state.config || {};
  const s = c.personaSwitch || {};
  const alt = c.altPersona || {};
  const verbs = Array.isArray(s.callVerbs) && s.callVerbs.length
    ? s.callVerbs.join(' / ')
    : '呼叫 / 叫 / 喊 / 出来 / 换 / 值班 / 接管 / 救命 / 在吗 / 来';
  return `
    <h3 id="settings-persona-switch">第二人设（按群召唤）</h3>
    <div class="hint">
      给机器人第二种人格：群友在群里点名召唤时，这个群临时换成人设与模型；闲置超时后自动交还默认人设。
      <strong>记忆是分开的</strong> —— 第二人设有自己的印象库（<code>data/memory-alt</code>），从空白开始，
      看不到默认人设记过的群印象。默认关闭，打开后也只影响被召唤过的群。
    </div>
    <div class="checkbox-row">
      <input type="checkbox" id="cfg-alt-enabled" ${s.enabled === true ? 'checked' : ''} />
      <label for="cfg-alt-enabled">启用按群召唤的第二人设</label>
    </div>
    <div class="hint" id="alt-persona-ready" style="margin:-4px 0 12px">${esc(readyHint(s))}</div>

    <div class="checkbox-row">
      <input type="checkbox" id="cfg-alt-rename-card" ${s.renameGroupCard !== false ? 'checked' : ''} />
      <label for="cfg-alt-rename-card">换人设时同步改群名片</label>
    </div>
    <div class="hint" style="margin:-4px 0 12px">
      切到这个群时把它自己的群名片改成第二人设的名字（<strong>${esc(s.altName || 'Claude')}</strong>），
      交还（闲置/叫回/模型自己交还）时改回<strong>原来的名片</strong> —— 第一次切走时会先记下它当时叫什么，
      记不到就用「机器人名字」（现在是 <strong>${esc(c.persona?.botName || '未设置')}</strong>）。
      只影响群聊，私聊没有群名片；没有群名片管理权限时会失败并记一条日志，不影响聊天。
    </div>

    <div class="checkbox-row">
      <input type="checkbox" id="cfg-alt-switch-avatar" ${s.switchAvatar !== false ? 'checked' : ''} />
      <label for="cfg-alt-switch-avatar">换人设时同步改头像</label>
    </div>
    <div class="hint" style="margin:-4px 0 12px">
      头像是<strong>账号级</strong>的（所有群和私聊共用一张），所以做不到"这个群 Claude、那个群 Gemi"：
      规则是<strong>只要有任意会话在第二人设值班，就换成第二人设的头像；全部交还后换回默认那张</strong>。
      图片留空就不换。填宿主机上的<strong>绝对路径</strong>或 <strong>URL</strong>（也接受 base64），例如
      <code>/mnt/data/qq-agent/data/avatar-claude.png</code>。
    </div>
    <div class="field-row">
      <div class="field"><label>第二人设头像</label>
        <input type="text" id="cfg-alt-avatar" value="${esc(s.altAvatar || '')}" placeholder="/mnt/data/qq-agent/data/avatar-claude.png" /></div>
      <div class="field"><label>默认人设头像</label>
        <input type="text" id="cfg-alt-avatar-home" value="${esc(s.homeAvatar || '')}" placeholder="/mnt/data/qq-agent/data/avatar-home.png" /></div>
    </div>

    <div class="field-row">
      <div class="field"><label>第二人设名字</label>
        <input type="text" id="cfg-alt-name" maxlength="40" value="${esc(s.altName || 'Claude')}" />
        <div class="hint">只用于控制台展示与提示词里的自称，可随时改。</div></div>
      <div class="field"><label>模型</label>
        <div style="display:flex;gap:6px;align-items:center">
          <input type="text" id="cfg-alt-model" value="${esc(s.altModel || '')}" placeholder="点击右侧从模型目录里选" style="flex:1" />
          <button type="button" class="btn btn-small" id="alt-model-pick">选择模型</button>
        </div>
        <div class="hint" id="alt-model-hint"></div></div>
      <div class="field"><label>群内展示名（可选）</label>
        <input type="text" id="cfg-alt-botname" value="${esc(alt.botName || '')}" placeholder="留空则用上面的名字" /></div>
    </div>

    <div class="field-row">
      <div class="field"><label>闲置多少分钟后交还（分钟）</label>
        <input type="number" id="cfg-alt-idle" min="1" max="1440" value="${esc(Number(s.idleMinutes) || 30)}" />
        <div class="hint">从它<strong>最后一次真正发出消息</strong>算起，期间每发一次续期。</div></div>
      <div class="field"><label>切换冷却（秒）</label>
        <input type="number" id="cfg-alt-cooldown" min="0" max="3600" value="${esc(Number(s.cooldownSeconds) || 0)}" />
        <div class="hint">防止群里来回横跳：冷却内不会再次切换。</div></div>
    </div>

    <div class="field">
      <label>角色设定（第二人设正文）</label>
      <textarea id="cfg-alt-roletext" class="persona-role-text" style="min-height:220px"
        placeholder="这里粘第二人设的角色卡正文。空着就不会生效。">${esc(s.altRoleText || '')}</textarea>
    </div>
    <div class="field">
      <label>管理员附加规则（可选；排在平台规则之后）</label>
      <textarea id="cfg-alt-customrules" class="persona-role-text" style="min-height:90px"
        placeholder="例如：被问到是不是换了人时别装傻，直接说现在是「克劳德」在值班">${esc(s.altCustomRules || '')}</textarea>
    </div>
    <div class="field-row">
      <div class="field"><label>交流策略</label>
        <select id="cfg-alt-profile">
          <option value="legacy" ${profileOf(s.altBehaviorProfile) !== 'grounded' ? 'selected' : ''}>原版群友</option>
          <option value="grounded" ${profileOf(s.altBehaviorProfile) === 'grounded' ? 'selected' : ''}>自然可靠</option>
        </select></div>
      <div class="field"><label>呼叫它的词（逗号分隔）</label>
        <input type="text" id="cfg-alt-callwords" value="${wordsOf(s.callWords, DEFAULT_CALL_WORDS)}" />
        <div class="hint">光提到名字不算：还要有下面的呼叫动词，或者直接 @/引用机器人。</div></div>
      <div class="field"><label>叫回默认人设的词（逗号分隔）</label>
        <input type="text" id="cfg-alt-homewords" value="${wordsOf(s.homeWords, DEFAULT_HOME_WORDS)}" /></div>
    </div>
    <div class="hint">呼叫动词：${esc(verbs)}。另外：正文里让它输出 <code>[SWITCH_TO_GEMINI]</code> 时也会立刻交还（这个标签会被剥掉，不会发到群里）。</div>

    <h4 style="margin-top:18px">正在值班的群</h4>
    <div class="hint">这里显示当前处于第二人设的会话。改人设或想让它立刻回来时，点「叫回默认人设」。</div>
    <div id="alt-persona-active"><div class="hint">正在读取…</div></div>
    <div class="field-row" style="margin-top:8px">
      <button class="btn btn-small" id="alt-persona-refresh">刷新</button>
      <span class="muted" id="alt-persona-status"></span>
    </div>`;
}

function renderActive(data) {
  const active = Array.isArray(data?.active) ? data.active : [];
  if (!active.length) {
    return `<div class="hint">${data?.enabled === true ? '当前没有会话在第二人设值班。' : '功能未启用。'}</div>`;
  }
  return active.map((item) => {
    const left = Math.max(0, Math.round(((Number(item.expiresAt) || 0) - Date.now()) / 60000));
    const title = String(item.name || item.chatKey || '');
    const sub = `${item.chatKey || ''} · ${left > 0 ? `闲置 ${left} 分钟后交还` : '下一次判定时交还'}`;
    return `
      <div class="field" style="padding:8px 0;border-bottom:1px solid rgba(127,127,127,.18)">
        <div>
          <span class="session-chat">${esc(title)}</span>
          <span class="chip ok" style="margin-left:8px">值班中 · ${esc(data?.altName || '第二人设')}</span>
        </div>
        <div class="hint" style="display:flex;gap:10px;align-items:center;margin-top:4px">
          <span>${esc(sub)}</span>
          <button class="btn btn-small" data-clear-alt="${esc(item.chatKey || '')}">叫回默认人设</button>
        </div>
      </div>`;
  }).join('');
}

/**
 * 模型 id 与「当前渠道」的对照提示。
 * 为什么需要：第二人设**只换模型名、不换渠道**（见 llm.js 的 model 参数）。
 * 模型目录里能选的模型是"所有已添加的提供商"的并集，所以完全可能出现
 * "在这里选了 A 家的 claude，但机器人正跑在 B 家" —— 请求会打到 B 家并以 404 失败。
 * 这条提示就是提前把这个坑说出来，而不是等群里召唤时才炸。
 */
function syncAltModelHint() {
  const box = $('#alt-model-hint');
  if (!box) return;
  const model = String($('#cfg-alt-model')?.value ?? '').trim();
  if (!model) { box.innerHTML = '还没选模型：点「选择模型」从模型目录里挑一个（也可以直接粘贴 id）。'; return; }
  const providers = Array.isArray(state.providers) ? state.providers : [];
  if (!providers.length) {
    box.innerHTML = `当前模型：<code>${esc(model)}</code>（模型目录还没加载，无法核对渠道）`;
    return;
  }
  const currentPid = String(state.config?.api?.provider || '');
  const current = providers.find((p) => p.id === currentPid) || null;
  const nameOf = (p) => String(p?.displayName || p?.id || '');
  const has = (p) => Array.isArray(p?.models) && p.models.includes(model);
  if (current && has(current)) {
    box.innerHTML = `<span class="chip ok">当前渠道有它</span> ${esc(nameOf(current))} · <code>${esc(model)}</code>`;
    return;
  }
  const other = providers.find((p) => p.id !== currentPid && has(p));
  if (other) {
    box.innerHTML = `<span class="chip warn">渠道不匹配</span> 它属于「${esc(nameOf(other))}」，但第二人设不换渠道 ——
      请求仍会打到「${esc(nameOf(current) || '当前渠道')}」，大概率 404。要么切到那个渠道，要么换一个本渠道的模型。`;
    return;
  }
  box.innerHTML = `<span class="chip warn">目录里没有</span> 当前渠道的模型列表里没有 <code>${esc(model)}</code>
    （列表可能是旧的：先到「模型 API」点一次「获取列表」再核对；确认无误也可以直接保存）。`;
}

/** 从模型目录里挑一个模型写进草稿（**不提交**：这页统一走底部「保存设置」）。 */
function openAltModelPicker() {
  const providers = Array.isArray(state.providers) ? state.providers : [];
  const hint = $('#alt-model-hint');
  if (!providers.length) {
    if (hint) hint.textContent = '模型目录为空：请先到「模型 API」页签选服务预设或填地址，再点「获取列表」添加。';
    return;
  }
  const currentModel = String($('#cfg-alt-model')?.value ?? '').trim();
  const overlay = modelModalShell({
    head: '选择第二人设的模型',
    body: `
      <div class="model-modal-left" id="mm-left"></div>
      <div class="model-modal-right" id="mm-right"></div>`,
    foot: `<button class="btn" id="mm-cancel">取消</button>`
  });
  const left = overlay.querySelector('#mm-left');
  const right = overlay.querySelector('#mm-right');
  // 从当前渠道开始选：第二人设不换渠道，先看对的那一列。
  let activePid = String(state.config?.api?.provider || '') || providers[0].id;
  if (!providers.some((p) => p.id === activePid)) activePid = providers[0].id;
  function renderLeft() {
    left.innerHTML = providers.map((p) =>
      `<div class="mm-prov ${p.id === activePid ? 'active' : ''}" data-pid="${esc(p.id)}">${esc(p.displayName || p.id)}</div>`).join('');
    left.querySelectorAll('.mm-prov').forEach((el) => {
      el.addEventListener('click', () => { activePid = el.dataset.pid; renderLeft(); renderRight(); });
    });
  }
  function renderRight() {
    const p = providers.find((x) => x.id === activePid);
    if (!p) { right.innerHTML = ''; return; }
    const names = p.modelNames || {};
    const isCurrentChannel = p.id === String(state.config?.api?.provider || '');
    right.innerHTML = p.models.map((m) => `
      <div class="mm-model" data-model="${esc(m)}">
        <span class="mm-check">${m === currentModel ? '✓' : ''}</span>
        <span>${esc(names[m] || m)}</span>
        <span class="muted" style="font-size:11px">${esc(m)}</span>
      </div>`).join('') || '<div class="muted" style="padding:10px">该提供商下没有模型</div>';
    if (!isCurrentChannel) {
      right.insertAdjacentHTML('afterbegin',
        '<div class="hint" style="padding:6px 8px">这一列不是当前渠道：选中后请求仍会打到当前渠道，多半 404。</div>');
    }
    right.querySelectorAll('.mm-model').forEach((el) => {
      el.addEventListener('click', () => {
        if (!$('#cfg-alt-model')) { closeModelModal(overlay); return; }
        $('#cfg-alt-model').value = el.dataset.model || '';
        closeModelModal(overlay);
        syncAltModelHint();
        syncReadyHint();
      });
    });
  }
  renderLeft();
  renderRight();
  overlay.querySelector('#mm-cancel').addEventListener('click', () => closeModelModal(overlay));
}

/** 只刷新"是否就绪"那一行（改了开关/模型/正文时用，不整页重画）。 */
function syncReadyHint() {
  const box = $('#alt-persona-ready');
  if (!box) return;
  box.textContent = readyHint({
    enabled: $('#cfg-alt-enabled')?.checked === true,
    altModel: $('#cfg-alt-model')?.value ?? '',
    altRoleText: $('#cfg-alt-roletext')?.value ?? ''
  });
}

/** 拉一次"谁在值班"。页面被重画后元素就没了，回来时按 id 现查，不缓存节点。 */
async function loadPersonaSwitchStatus() {
  const box = $('#alt-persona-active');
  if (!box) return;
  const status = $('#alt-persona-status');
  try {
    const data = await api('/api/persona-switch');
    const target = $('#alt-persona-active');
    if (!target) return;
    target.innerHTML = renderActive(data);
    if (status) status.textContent = `读取于 ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}`;
  } catch (e) {
    const target = $('#alt-persona-active');
    if (target) target.innerHTML = `<div class="hint">读取失败：${esc(e.message)}</div>`;
    if (status) status.textContent = '';
  }
}

async function clearActive(chatKey, button) {
  if (!chatKey) return;
  if (button) { button.disabled = true; button.textContent = '叫回中…'; }
  try {
    await api('/api/persona-switch/clear', { method: 'POST', body: JSON.stringify({ chatKey }) });
    await loadPersonaSwitchStatus();
  } catch (e) {
    if (button) { button.disabled = false; button.textContent = '叫回默认人设'; }
    const status = $('#alt-persona-status');
    if (status) status.textContent = `叫回失败：${e.message}`;
  }
}

/** 渲染后绑定：刷新按钮、逐行「叫回」，并立刻拉一次状态。 */
function bindPersonaSwitchSection() {
  $('#alt-persona-refresh')?.addEventListener('click', () => { loadPersonaSwitchStatus(); });
  $('#alt-persona-active')?.addEventListener('click', (event) => {
    const button = event.target?.closest?.('[data-clear-alt]');
    if (!button) return;
    clearActive(button.dataset.clearAlt || '', button);
  });
  $('#alt-model-pick')?.addEventListener('click', () => openAltModelPicker());
  // 勾选/改模型时只更新那两行提示，不整页重画 —— 重画会冲掉正在输入的正文。
  const syncHints = () => { syncReadyHint(); syncAltModelHint(); };
  for (const sel of ['#cfg-alt-enabled', '#cfg-alt-model', '#cfg-alt-roletext']) {
    const node = $(sel);
    if (!node) continue;
    node.addEventListener('input', syncHints);
    node.addEventListener('change', syncHints);
  }
  syncHints();
  loadPersonaSwitchStatus();
}

export { bindPersonaSwitchSection, renderPersonaSwitchSection };
