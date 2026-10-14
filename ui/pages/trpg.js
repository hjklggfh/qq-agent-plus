import { api } from '../core/api.js';
import { $, esc } from '../core/dom.js';
import { state } from '../core/state.js';
import { askForConfirmation } from '../core/dom-util.js';

const TRPG_STATUS = { recruiting: '等待加入', playing: '游戏中', paused: '已暂停', ended: '已结束' };

function trpgNotice(value) { const box = $('#trpg-notice'); if (box) box.textContent = value; }
async function trpgPost(route, body) { return api(`/api/trpg/${route}`, { method: 'POST', body: JSON.stringify(body) }); }

function trpgDownload(name, value) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function trpgEditor(kind) {
  const world = kind === 'worlds';
  return `<form class="trpg-card trpg-editor" data-trpg-form="${kind}">
    <h3>${world ? '世界观' : '角色卡'}</h3>
    <input name="id" type="hidden">
    <label>名称<input name="name" maxlength="60" required placeholder="${world ? '雾港来信' : '你的角色名'}"></label>
    <label>${world ? '背景设定' : '外貌、性格、经历和能力'}<textarea name="description" rows="6" maxlength="12000" required placeholder="直接粘贴设定文本"></textarea></label>
    ${world ? '<label>开场<textarea name="opening" rows="3" maxlength="4000" placeholder="玩家抵达时发生的第一幕"></textarea></label><label>世界规则与风格<textarea name="rules" rows="3" maxlength="4000" placeholder="时代、魔法边界、禁忌、剧情风格等"></textarea></label>'
    : '<label>初始生命值<input name="hp" type="number" min="1" max="1000" value="10" required></label><label>属性修正值（JSON，-5至10）<textarea name="attributes" rows="3">{"力量":0,"敏捷":1,"感知":2,"交涉":1}</textarea></label><label>初始物品（每行一项）<textarea name="inventory" rows="3" placeholder="提灯\n绳索"></textarea></label>'}
    <div class="trpg-actions"><button class="btn btn-primary" type="submit">保存${world ? '世界观' : '角色卡'}</button><button class="btn" type="button" data-trpg-action="new" data-kind="${kind}">新建</button>
    <label class="btn trpg-import">导入 JSON / TXT<input type="file" accept=".json,.txt,.md" data-trpg-import="${kind}"></label></div>
    <div class="hint">支持设定纯文本及本页导出的 JSON。角色卡也可导入酒馆 JSON 的基础描述；不导入脚本、插件或 PNG 卡。</div>
    <div id="trpg-${kind}-list"></div>
  </form>`;
}

function renderTrpgLists() {
  const data = state.trpgData || {};
  for (const kind of ['worlds', 'characters']) {
    const box = $(`#trpg-${kind}-list`);
    if (!box) continue;
    box.innerHTML = (data[kind] || []).map((a) => `<div class="trpg-list-item"><div><b>${esc(a.name)}</b><div class="hint">ID：${esc(a.id)} · ${a.scope ? `会话 ${esc(a.scope)} · 创建者 ${esc(a.ownerId)}` : '公共模板'}</div></div><div class="trpg-actions">
      ${['edit', 'export', 'delete'].map((action, i) => `<button class="btn" type="button" data-trpg-action="${action}" data-kind="${kind}" data-id="${esc(a.id)}">${['编辑', '导出', '删除'][i]}</button>`).join('')}</div></div>`).join('') || '<p class="muted">还没有卡片，可以在上方创建或导入。</p>';
  }
  const campaigns = $('#trpg-campaigns');
  if (!campaigns) return;
  campaigns.innerHTML = (data.campaigns || []).slice().reverse().map((c) => `<article class="trpg-card"><h3>${esc(c.title)} <span class="muted">${esc(TRPG_STATUS[c.status] || c.status)}</span></h3>
    <div class="hint">${esc(c.chatKey)} · 团主 ${esc(c.hostId)} · 存档 ${esc(c.id)} · 版本 ${esc(c.revision)}</div>
    <p>地点：${esc(c.location || '未定')}</p><p class="trpg-pre">${esc(c.summary || c.world?.opening || '尚未开始')}</p>
    ${(c.players || []).map((p) => `<p>${esc(p.character.name)}（${esc(p.userId)}） · HP ${esc(p.hp)}/${esc(p.character.hp)} · ${esc(p.condition || '正常')}<br><span class="muted">背包：${esc(p.inventory.join('、') || '无')}</span></p>`).join('')}
    <div class="trpg-actions"><button class="btn" data-trpg-action="export-campaign" data-id="${esc(c.id)}">导出存档</button>
    ${c.status === 'playing' ? `<button class="btn" data-trpg-action="pause" data-id="${esc(c.id)}">暂停</button>` : ''}
    ${c.status === 'paused' ? `<button class="btn" data-trpg-action="resume" data-id="${esc(c.id)}">继续</button>` : ''}
    <button class="btn" data-trpg-action="${c.status === 'ended' ? 'delete-campaign' : 'end'}" data-id="${esc(c.id)}">${c.status === 'ended' ? '删除存档' : '结束本团'}</button></div>
    <details><summary>最近事件与骰点</summary><pre class="trpg-pre">${esc((c.events || []).slice(-15).map((e) => `${new Date(e.at).toLocaleString('zh-CN')} ${e.type} ${e.content}`).join('\n') || '暂无事件')}</pre></details></article>`).join('') || '<div class="trpg-card muted">暂无存档。先在 QQ 中发送 /跑团 列表，再选择世界观开团。</div>';
}

async function refreshTrpgData() {
  state.trpgData = await api('/api/trpg');
  renderTrpgLists();
}

function fillTrpgForm(kind, asset) {
  const form = $(`[data-trpg-form="${kind}"]`);
  if (!form) return;
  form.reset();
  form.elements.namedItem('id').value = asset?.id || '';
  for (const [key, value] of Object.entries(asset || {})) {
    const input = form.elements.namedItem(key);
    if (input) input.value = key === 'attributes' ? JSON.stringify(value, null, 2) : key === 'inventory' ? value.join('\n') : value;
  }
  form.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
}

async function handleTrpgClick(target) {
  const { trpgAction: action, kind, id } = target.dataset;
  if (action === 'refresh') { await refreshTrpgData(); return; }
  if (action === 'settings') {
    await trpgPost('settings', { enabled: $('#trpg-enabled').checked, maxPlayers: Number($('#trpg-max').value) });
    await refreshTrpgData(); trpgNotice('跑团设置已保存，立即生效。'); return;
  }
  if (action === 'new') { fillTrpgForm(kind, null); return; }
  const asset = (state.trpgData?.[kind] || []).find((a) => a.id === id);
  if (action === 'edit') { fillTrpgForm(kind, asset); return; }
  if (action === 'export') {
    const { scope: _scope, ownerId: _owner, id: _id, ...card } = asset;
    trpgDownload(`${asset.name}.json`, { format: 'qq-agent-trpg', version: 1, kind, asset: card }); return;
  }
  if (action === 'delete') {
    if (!await askForConfirmation('删除此卡片？已有团内的卡片快照会保留。')) return;
    await trpgPost('delete-asset', { kind, id, confirm: true });
  } else {
    const c = (state.trpgData?.campaigns || []).find((a) => a.id === id);
    if (!c) return;
    if (action === 'export-campaign') { trpgDownload(`跑团-${c.id}.json`, { format: 'qq-agent-trpg-save', version: 1, campaign: c }); return; }
    if (!await askForConfirmation(`${action === 'delete-campaign' ? '永久删除存档？建议先导出。' : '确认改变本团状态？正在生成的回复可能被中止。'}`)) return;
    await trpgPost('campaign', { id, action: action === 'delete-campaign' ? 'delete' : action, revision: c.revision, confirm: true });
  }
  await refreshTrpgData(); trpgNotice('操作完成。');
}

async function submitTrpgCard(form) {
  const kind = form.dataset.trpgForm;
  const get = (name) => form.elements.namedItem(name)?.value || '';
  const asset = { name: get('name'), description: get('description') };
  if (get('id')) asset.id = get('id');
  if (kind === 'worlds') Object.assign(asset, { opening: get('opening'), rules: get('rules') });
  else Object.assign(asset, { hp: Number(get('hp')), attributes: JSON.parse(get('attributes')), inventory: get('inventory').split('\n').map((s) => s.trim()).filter(Boolean) });
  const saved = await trpgPost('asset', { kind, asset });
  form.elements.namedItem('id').value = saved.id;
  await refreshTrpgData(); trpgNotice(`已保存「${saved.name}」。已有存档使用原快照，新开团才使用新设定。`);
}

async function importTrpgCard(input) {
  const file = input.files?.[0];
  if (!file) return;
  if (file.size > 128 * 1024) throw new Error('导入文件最多128KB');
  const raw = await file.text();
  const kind = input.dataset.trpgImport;
  let asset;
  if (/\.json$/i.test(file.name)) {
    const parsed = JSON.parse(raw);
    if (parsed.kind && parsed.kind !== kind) throw new Error('卡片类型不符，请在对应编辑器导入');
    asset = parsed.asset || parsed;
    if (kind === 'characters' && parsed.data?.name) {
      asset = { name: parsed.data.name, description: [parsed.data.description, parsed.data.personality, parsed.data.scenario].filter(Boolean).join('\n\n') };
    }
  } else asset = { name: file.name.replace(/\.[^.]+$/, ''), description: raw };
  fillTrpgForm(kind, { ...asset, id: '' });
  trpgNotice('已导入编辑器，检查内容后点击保存。脚本、提示词覆盖及扩展字段不会导入。');
  input.value = '';
}

async function loadTrpgPage() {
  const host = $('#trpg-page');
  if (!host) return;
  if (!host.dataset.ready) {
    host.dataset.ready = 'true';
    host.innerHTML = `<header><h2>跑团工作台</h2><p class="muted">单人或1—6人小团 · 自定义角色与世界 · 真实骰点 · 持久化存档</p></header>
      <section class="trpg-card"><div class="trpg-actions"><label><input type="checkbox" id="trpg-enabled"> 开启跑团</label><label>人数上限 <input type="number" id="trpg-max" min="1" max="6" value="6"></label><button class="btn btn-primary" data-trpg-action="settings">保存设置</button><button class="btn" data-trpg-action="refresh">刷新存档</button></div><p class="hint">仅在机器人已授权的私聊或群内使用。关闭后保留所有卡片和存档；剧情生成使用当前聊天模型并计入原有预算。</p></section>
      <p id="trpg-notice" role="status" aria-live="polite"></p>
      <details class="trpg-card"><summary>如何开始？</summary><pre class="trpg-pre">/跑团 列表
/跑团 开团 mist-harbor
/跑团 加入 traveler
/跑团 开始
/跑团 行动 我举起提灯，观察码头上的脚印
/跑团 状态
/跑团 暂停
/跑团 继续</pre><p>世界观决定背景、风格和开场；角色卡决定人物与初始属性、物品。默认以1d20加属性检定，通常难度12；HP归零表示失去行动能力，由剧情决定后续。聊天中的 /跑团 世界 名称 | 设定 和 /跑团 角色 名称 | 描述 可快速建卡。</p></details>
      <div class="trpg-grid">${trpgEditor('worlds')}${trpgEditor('characters')}</div><h2>游戏存档</h2><div id="trpg-campaigns" class="trpg-grid"></div>`;
    host.addEventListener('click', (event) => {
      const target = event.target.closest('[data-trpg-action]');
      if (!target) return;
      target.disabled = true;
      handleTrpgClick(target).catch((e) => trpgNotice(e.message)).finally(() => { target.disabled = false; });
    });
    host.addEventListener('submit', (event) => {
      const form = event.target.closest('[data-trpg-form]');
      if (!form) return;
      event.preventDefault();
      const button = form.querySelector('[type="submit"]');
      button.disabled = true;
      submitTrpgCard(form).catch((e) => trpgNotice(e.message)).finally(() => { button.disabled = false; });
    });
    host.addEventListener('change', (event) => {
      if (event.target.matches('[data-trpg-import]')) importTrpgCard(event.target).catch((e) => trpgNotice(e.message));
    });
  }
  try {
    await refreshTrpgData();
    if (!host.dataset.settingsLoaded) {
      $('#trpg-enabled').checked = state.trpgData?.settings?.enabled === true;
      $('#trpg-max').value = state.trpgData?.settings?.maxPlayers || 6;
      host.dataset.settingsLoaded = 'true';
    }
  } catch (error) { trpgNotice(error.message); }
}

export { loadTrpgPage };
