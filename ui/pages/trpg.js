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
  const pathways = state.trpgCatalog?.pathways || [];
  return `<form class="trpg-card trpg-editor" data-trpg-form="${kind}">
    <h3>${world ? '世界观' : '角色卡'}</h3>
    <input name="id" type="hidden">
    <label>名称<input name="name" maxlength="60" required placeholder="${world ? '雾港来信' : '你的角色名'}"></label>
    <label>${world ? '背景设定' : '外貌、性格、经历和能力'}<textarea name="description" rows="6" maxlength="12000" required placeholder="直接粘贴设定文本"></textarea></label>
    ${world ? `<label>规则模式<select name="ruleset"><option value="narrative">通用轻量叙事（按世界建角）</option><option value="lotm-tactical-v1">诡秘战术长期战役（序列9—5）</option></select></label><label>开场<textarea name="opening" rows="3" maxlength="4000" placeholder="玩家抵达时发生的第一幕"></textarea></label><label>世界规则与风格<textarea name="rules" rows="3" maxlength="4000" placeholder="时代、魔法边界、禁忌、剧情风格等"></textarea></label>
      <label>建角说明（选填，公开给玩家）<textarea name="creationPrompt" rows="2" maxlength="1200" placeholder="例如：普通现代人，无超能力，说明为何来到超市。"></textarea></label>
      <label>可选职业／身份（选填，每行一个）<textarea name="creationRoles" rows="3" placeholder="收银员\n保安\n顾客"></textarea></label>
      <details><summary>建角初始属性与物品（通用叙事，选填）</summary><label>初始配置（JSON）<textarea name="creationDefaults" rows="4" placeholder='{"hp":10,"inventory":["手机"],"backgroundPrompt":"填写人物经历和与队伍的联系"}'></textarea></label><p class="hint">可配置hp、inventory、backgroundPrompt、attributePresets。默认HP10、通用四属性方案、空背包；不会自动生成诡秘途径或灵性。诡秘战术模式使用固定建角规则，请留空这些自定义项。</p></details>`
    : `<label>途径<select name="pathway"><option value="">旧叙事角色（无结构化途径）</option>${pathways.map((p) => `<option value="${esc(p.id)}">${esc(p.name)} · 序列9 ${esc(p.sequences[0].name)}</option>`).join('')}</select></label><div class="hint">选择途径后：新角色HP10，四属性-1至2且总和≤4，最高成长至序列5。QQ发送 /跑团 建角 可用编号引导，无需填写JSON。</div><label>初始生命值<input name="hp" type="number" min="1" max="1000" value="10" required></label><label>属性修正值（JSON）<textarea name="attributes" rows="3">{"力量":0,"敏捷":1,"感知":2,"交涉":1}</textarea></label><label>初始物品（每行一个单位）<textarea name="inventory" rows="3" placeholder="提灯\n绷带"></textarea></label>`}
    <div class="trpg-actions"><button class="btn btn-primary" type="submit">保存${world ? '世界观' : '角色卡'}</button><button class="btn" type="button" data-trpg-action="new" data-kind="${kind}">新建</button>
    <label class="btn trpg-import">导入 JSON / TXT<input type="file" accept=".json,.txt,.md" data-trpg-import="${kind}"></label></div>
    <div class="hint">支持设定纯文本及本页导出的 JSON。角色卡也可导入酒馆 JSON 的基础描述；不导入脚本、插件或 PNG 卡。</div>
    <div id="trpg-${kind}-list"></div>
  </form>`;
}

function renderTrpgBattle(c) {
  const b = c.combat;
  if (!b) return '';
  const current = b.units.find((u) => u.id === b.order[b.cursor]);
  let cells = '';
  for (let y = 0; y < b.height; y++) for (let x = 0; x < b.width; x++) {
    const same = (p) => p.x === x && p.y === y;
    const unit = b.units.find((u) => !u.escaped && u.hp > 0 && same(u.at));
    const wall = b.walls.some(same), hazard = b.hazards.find((v) => same(v.at));
    const object = b.objects.find((v) => !v.used && same(v.at)), cover = b.cover.some((v) => same(v.at));
    const label = `${String.fromCharCode(65 + x)}${y + 1}`;
    cells += `<div class="trpg-cell ${unit ? unit.side === 'players' ? 'trpg-ally' : 'trpg-enemy' : wall ? 'trpg-wall' : hazard ? 'trpg-hazard' : ''}" title="${esc(label + ' ' + (unit?.name || object?.label || hazard?.label || (cover ? '掩体' : '空地')))}"><small>${label}</small><b>${esc(unit ? unit.name.slice(0, 2) : wall ? '#' : object ? '?' : hazard ? '!' : cover ? '+' : '·')}</b></div>`;
  }
  return `<section class="trpg-battle"><p>第${esc(b.round)}轮 · ${esc({ active: '战斗中', won: '胜利', defeated: '全队倒地，可求援', retreated: '已撤离', rescued: '已获救' }[b.status])} · 当前 ${esc(current?.name || '—')}</p><div class="trpg-board" style="grid-template-columns:repeat(${Number(b.width)},minmax(0,1fr))">${cells}</div><p class="hint">蓝色队友／红色敌人 · #墙 · +掩体 · !危险 · ?互动。实际行动由对应QQ玩家选择，工作台不代替玩家操作。</p><div>${b.units.map((u) => `<span class="trpg-unit">${esc(u.name)} HP${esc(u.hp)}/${esc(u.maxHp)}</span>`).join('')}</div></section>`;
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
    ${(c.players || []).map((p) => `<p>${esc(p.character.name)}（${esc(p.userId)}） · HP ${esc(p.hp)}/${esc(p.character.hp + (p.progress ? (9 - p.progress.sequence) * 2 : 0))} · ${esc(p.condition || '正常')}
      ${p.progress ? `<br><b>${p.away ? '暂离 · ' : ''}序列${esc(p.progress.sequence)} · 灵性${esc(p.progress.spirit)}/${6 + (9 - p.progress.sequence) * 2} · 污染${esc(p.progress.pollution)}/6 · 消化${esc(p.progress.digestion)}/${6 + (9 - p.progress.sequence) * 2}</b>` : ''}<br><span class="muted">背包：${esc(p.inventory.join('、') || '无')}</span></p>`).join('')}
    ${c.ruleset ? `<p class="hint">第${esc(c.chapter)}章 · 游戏内累计${esc(c.clock)}分钟 · 危险累计${esc(c.dangerClock || 0)}分钟${c.clockPaused ? '（暂停）' : ''} · ${c.safe ? '安全休整' : '冒险场景'} · 场景${esc(c.scene?.name || '')}</p>${renderTrpgBattle(c)}<details><summary>任务、NPC与成长证据</summary>${(c.journal || []).map((j) => `<p>${j.status === 'done' ? '✓' : '○'} ${esc(j.text)}</p>`).join('') || '<p>暂无任务日志</p>'}${(c.npcs || []).map((n) => `<p>${esc(n.name)} · ${esc(n.location)} · 态度${esc(n.attitude)}<br><span class="hint">${esc(n.notes)}</span></p>`).join('')}${(c.rewards || []).slice(-10).map((r) => `<p class="hint">${esc(r.userId)} · ${esc(r.kind)} · ${esc(r.evidence)}</p>`).join('')}</details>` : ''}
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
  if (kind === 'worlds') {
    const { prompt = '', roles = [], ...defaults } = asset?.characterCreation || {};
    form.elements.namedItem('creationPrompt').value = prompt;
    form.elements.namedItem('creationRoles').value = roles.join('\n');
    form.elements.namedItem('creationDefaults').value = Object.keys(defaults).length ? JSON.stringify(defaults, null, 2) : '';
  }
  if (kind === 'characters' && asset?.pathway) {
    const p = (state.trpgCatalog?.pathways || []).find((p) => p.id === asset.pathway || p.name === asset.pathway);
    if (!p) throw new Error('无法识别途径，请刷新页面加载22途径目录');
    form.elements.namedItem('pathway').value = p.id;
  }
  form.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
}

async function handleTrpgClick(target) {
  const { trpgAction: action, kind, id } = target.dataset;
  if (action === 'refresh') { await refreshTrpgData(); return; }
  if (action === 'settings') {
    const parseIds = (selector) => [...new Set($(selector).value.split(/[\s,，;；]+/).filter(Boolean))];
    await trpgPost('settings', { enabled: $('#trpg-enabled').checked, maxPlayers: Number($('#trpg-max').value), allowedGroups: parseIds('#trpg-groups'), allowedPrivate: parseIds('#trpg-private') });
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
  if (kind === 'worlds') {
    const defaults = get('creationDefaults').trim() ? JSON.parse(get('creationDefaults')) : {};
    if (!defaults || typeof defaults !== 'object' || Array.isArray(defaults)) throw new Error('建角初始配置需为JSON对象');
    if (Object.hasOwn(defaults, 'prompt') || Object.hasOwn(defaults, 'roles')) throw new Error('建角说明和职业请填写上方专用字段');
    const profile = { ...defaults, ...(get('creationPrompt').trim() ? { prompt: get('creationPrompt').trim() } : {}), ...(get('creationRoles').trim() ? { roles: get('creationRoles').split('\n').map((s) => s.trim()).filter(Boolean) } : {}) };
    Object.assign(asset, { opening: get('opening'), rules: get('rules'), ...(get('ruleset') === 'lotm-tactical-v1' ? { ruleset: get('ruleset') } : {}), ...(Object.keys(profile).length ? { characterCreation: profile } : {}) });
  }
  else Object.assign(asset, { hp: Number(get('hp')), attributes: JSON.parse(get('attributes')), inventory: get('inventory').split('\n').map((s) => s.trim()).filter(Boolean), ...(get('pathway') ? { pathway: get('pathway'), sequence: 9 } : {}) });
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
    try { state.trpgCatalog = await api('/api/trpg/catalog'); } catch { state.trpgCatalog = null; }
    host.dataset.ready = 'true';
    host.innerHTML = `<header><h2>跑团工作台</h2><p class="muted">按世界建角 · 自定义职业与背景 · 诡秘战术与长期成长 · 真实骰点</p></header>
      <section class="trpg-card"><div class="trpg-actions"><label><input type="checkbox" id="trpg-enabled"> 开启跑团</label><label>人数上限 <input type="number" id="trpg-max" min="1" max="6" value="6"></label><button class="btn btn-primary" data-trpg-action="settings">保存设置</button><button class="btn" data-trpg-action="refresh">刷新存档</button></div>
      <div class="trpg-grid trpg-allowlists"><label for="trpg-groups">群聊白名单（群号）<textarea id="trpg-groups" rows="3" placeholder="每行一个群号，也可用逗号分隔"></textarea></label><label for="trpg-private">私聊白名单（QQ号）<textarea id="trpg-private" rows="3" placeholder="每行一个QQ号，也可用逗号分隔"></textarea></label></div>
      <p class="hint">只有白名单中的群聊／私聊可以开团，还需满足全局授权与时段。空名单禁止开团；移出名单立即停止并保留存档。退出游戏＝保存暂停；结束战役＝团主确认归档。规则引擎接收编号与结算战斗，剧情生成计入原有模型预算。</p></section>
      <p id="trpg-notice" role="status" aria-live="polite"></p>
      <details class="trpg-card"><summary>如何开始？</summary><pre class="trpg-pre">/跑团 列表
/跑团 开团
/跑团 建角
/跑团 开始
我举起提灯，观察码头上的脚印
/跑团 状态
/跑团 暂停
/跑团 继续
/跑团 成长
/跑团 能力
退出游戏</pre><p>先保存允许的群号／QQ号，再用 /跑团 开团 世界ID 选择世界；省略ID会使用内置诡秘战役。每名玩家发送建角指令：通用世界填写职业/身份或选择世界预设，诡秘战术世界才选择途径。输入姓名、背景、属性并确认后自动加入。普通世界的职业、能力和资源按世界设定叙事，不会自动获得诡秘机制；诡秘战术团的编号、探索意图与回合由程序结算。</p></details>
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
      $('#trpg-groups').value = (state.trpgData?.settings?.allowedGroups || []).join('\n');
      $('#trpg-private').value = (state.trpgData?.settings?.allowedPrivate || []).join('\n');
      host.dataset.settingsLoaded = 'true';
    }
  } catch (error) { trpgNotice(error.message); }
}

export { loadTrpgPage };
