// 插件管理页（控制台）。
//
// 页面分成**两块**，这个划分是刻意的：
//   ① `#plugin-page`   —— 插件列表。只放按钮，没有输入控件，由 setHtmlIfChanged 自动重画，
//                        与"正在输入时别整块重画"那套守卫完全不冲突。
//   ② `#plugin-settings-box` —— 某个插件的设置编辑器（JSON）。**只在用户点开时渲染**，
//                        列表刷新不碰它，所以不存在"重拉把正在编辑的内容冲掉"的问题。
// 把可编辑控件放在自动刷新的容器里，是这个控制台踩过好几次的坑
//（ui-preserve-editable.test.mjs 那 5 条用例全是它），这里从结构上绕开。
//
// 渲染要点：
//   - 后端在 `GET /api/plugins` 里已经把**凭据剥离**（只给字段名），所以页面永远拿不到明文；
//   - 状态、原因、能力、工具全部由服务端算好，页面不做二次推导（免得两边口径漂移）。
import { api } from '../core/api.js';
import { $, esc } from '../core/dom.js';
import { askForConfirmation, setBoxError, setHtmlIfChanged } from '../core/dom-util.js';
import { state } from '../core/state.js';

const LIST_BOX = '#plugin-page';
const SETTINGS_BOX = '#plugin-settings-box';
const NOTE_BOX = '#plugin-note';
const ROOTS_BOX = '#plugin-roots-box';

/** 每个状态的展示口径（标签 + 修饰类）。键与服务端 PLUGIN_STATUS 一一对应。 */
const STATUS_META = {
  loaded: { label: '已装载', cls: 'is-loaded', hint: '工具已注入模型工具表' },
  disabled: { label: '未启用', cls: 'is-off', hint: '没在 plugins.enabled 里' },
  'pending-approval': { label: '待确认', cls: 'is-pending', hint: '能力/工具快照没确认，或改动后需要重新确认' },
  invalid: { label: '声明不合法', cls: 'is-bad', hint: 'manifest 本身有问题，插件被拒绝' },
  failed: { label: '加载失败', cls: 'is-bad', hint: '入口报错或工具名冲突' },
  missing: { label: '找不到', cls: 'is-bad', hint: '已启用但盘上没这个 id' }
};

/** 能力风险等级 → 徽标文案。与 plugins/_host/capabilities.js 的 risk 字段对应。 */
const RISK_LABEL = { low: '低', medium: '中', high: '高' };

function statusMeta(status) {
  return STATUS_META[status] || { label: String(status || '未知'), cls: 'is-off', hint: '' };
}

function pageData() {
  if (!state.pluginPage || typeof state.pluginPage !== 'object') {
    state.pluginPage = {
      plugins: [], capabilities: [], roots: [], rootInfo: [], enabled: [],
      maxRoots: 5, editing: '', rootsEditing: false, note: ''
    };
  }
  const data = state.pluginPage;
  if (!Array.isArray(data.rootInfo)) data.rootInfo = [];
  if (typeof data.maxRoots !== 'number') data.maxRoots = 5;
  return data;
}

function note(text, kind = '') {
  const el = $(NOTE_BOX);
  if (!el) return;
  el.textContent = String(text || '');
  el.className = `hint${kind ? ` ${kind}` : ''}`;
}

function capabilityChip(cap, catalog) {
  const meta = catalog.find((item) => item.id === cap) || {};
  const risk = RISK_LABEL[meta.risk] || '?';
  const title = meta.summary ? `${meta.summary}（风险：${risk}）` : `风险：${risk}`;
  return `<span class="chip plugin-cap" title="${esc(title)}">${esc(meta.label || cap)}</span>`;
}

/**
 * 插件来源徽标。
 *
 * 这个标记不是装饰：`随版本发布` 的那个根由 `deploy.sh` 同步，升级时会覆盖或合并同名文件；
 * 而"自建根"完全不经过 rsync —— "加/删插件不必发版本"这条路走的正是后者。只显示路径不足以
 * 让人分辨这两者，所以服务端算了 `bundled` 下发（见 plugins/console-routes.js 的 isBundledRoot）。
 */
function sourceBadge(item) {
  if (!item?.root) return '';
  return item.bundled
    ? '<span class="chip plugin-src is-bundled" title="随版本发布：这个目录由 deploy.sh 同步，升级时会覆盖或合并同名文件">随版本发布</span>'
    : '<span class="chip plugin-src is-own" title="自建根：deploy.sh 不碰这里，所以加/删插件都不必发版本">自建</span>';
}

/** 插件根清单（带"随版本发布 / 自建 / 目录不存在"标记）。 */
function rootListHtml() {
  const data = pageData();
  const info = Array.isArray(data.rootInfo) ? data.rootInfo : [];
  if (!info.length) return '（还没有插件根）';
  return info.map((entry) => {
    const bundled = entry.bundled
      ? '<span class="chip plugin-src is-bundled">随版本发布</span>'
      : '<span class="chip plugin-src is-own">自建</span>';
    const missing = entry.exists ? '' : '<span class="chip plugin-src is-bad">目录不存在</span>';
    return `<div class="plugin-root-row">${bundled}${missing}<code>${esc(entry.path)}</code></div>`;
  }).join('');
}

function pluginRow(item, catalog) {
  const meta = statusMeta(item.status);
  const caps = (item.capabilities || []).length
    ? (item.capabilities || []).map((cap) => capabilityChip(cap, catalog)).join('')
    : '<span class="hint">无（纯计算）</span>';
  const tools = (item.tools || []).length
    ? (item.tools || []).map((name) => `<code>${esc(name)}</code>`).join(' ')
    : '<span class="hint">—</span>';

  const canToggle = item.status !== 'missing' && item.status !== 'invalid';
  const toggleLabel = item.enabled ? '停用' : '启用';
  const actions = [];
  if (canToggle) {
    actions.push(`<button class="btn btn-small" data-plugin-action="toggle" data-plugin-id="${esc(item.id)}" data-plugin-next="${item.enabled ? 'false' : 'true'}">${toggleLabel}</button>`);
  }
  if (item.status === 'pending-approval') {
    actions.push(`<button class="btn btn-small" data-plugin-action="approve" data-plugin-id="${esc(item.id)}">确认这份能力</button>`);
  }
  // 盘上没有这个 id 时"设置"必然失败（服务端找不到它），所以那种行只留「移除」。
  if (item.status !== 'missing') {
    actions.push(`<button class="btn btn-small" data-plugin-action="settings" data-plugin-id="${esc(item.id)}">设置</button>`);
  }
  // 「移除」= 清掉 启用/确认/设置 三处记录，**不删插件目录**（目录路径就显示在上面，
  // 可能在随版本发布的那个根里，删了下次部署又回来 —— 与其做一个会被自己撤销的动作，
  // 不如告诉你确切路径）。
  actions.push(`<button class="btn btn-small" data-plugin-action="remove" data-plugin-id="${esc(item.id)}">移除</button>`);
  // 不可逆的那个动作只在真有状态目录时才给（服务端算的 stateDirExists）。
  if (item.stateDirExists) {
    actions.push(`<button class="btn btn-small btn-danger" data-plugin-action="remove" data-plugin-id="${esc(item.id)}" data-plugin-purge="true">移除并删数据</button>`);
  }

  const restart = item.needsRestart
    ? '<div class="hint">配置已就绪，<b>重启服务后生效</b></div>'
    : '';
  const reason = item.reason
    ? `<div class="hint ${item.status === 'loaded' || item.status === 'disabled' ? '' : 'error'}">${esc(item.reason)}</div>`
    : '';

  return `<tr>
    <td>
      <div class="plugin-id"><code>${esc(item.id)}</code> <span class="hint">${esc(item.version || '')}</span>${sourceBadge(item)}</div>
      <div class="plugin-name">${esc(item.name || '')}</div>
      ${item.description ? `<div class="hint">${esc(item.description)}</div>` : ''}
      ${item.dir ? `<div class="plugin-dir" title="${esc(item.dir)}">${esc(item.dir)}</div>` : ''}
    </td>
    <td><span class="plugin-status ${meta.cls}" title="${esc(meta.hint)}">${esc(meta.label)}</span>${restart}${reason}</td>
    <td><div class="asset-tags">${caps}</div></td>
    <td class="plugin-tools">${tools}</td>
    <td class="plugin-actions">${actions.join(' ')}</td>
  </tr>`;
}

function renderPluginPage() {
  const box = $(LIST_BOX);
  if (!box) return false;
  const data = pageData();
  const items = Array.isArray(data.plugins) ? data.plugins : [];

  const head = `<div class="asset-toolbar">
    <div class="asset-search">
      <b>插件</b>
      <span class="hint">${items.length} 个</span>
    </div>
    <div class="asset-toolbar-actions">
      <button class="btn btn-small" data-plugin-action="reload">刷新</button>
    </div>
  </div>
  <div class="hint">
    <b>加插件：</b>把插件目录放进任一插件根（<b>目录名必须等于 plugin.json 里的 id</b>）
    → 点「刷新」→ 启用 → 确认这份能力 → 重启服务。<br>
    <b>删插件：</b>点「移除」清掉配置记录（<b>不删插件目录</b>，路径写在每行下面），
    目录请自行删除；数据目录默认保留，要一起删就点「移除并删数据」。<br>
    启用 / 确认 / 改设置 / 改插件根都<b>只改配置</b>，装载发生在下一次启动 —— 所以都要重启才生效。
  </div>`;

  if (!items.length) {
    return setHtmlIfChanged(box, `${head}<div class="empty-hint">还没有插件。
      把插件目录放进下面的插件根里（一个插件 = 一个目录，含 plugin.json 与入口文件，
      目录名要等于 plugin.json 里的 id），然后点「刷新」。写法见 docs/PLUGINS.md 与 docs/PLUGIN-API.md。</div>`, { force: true });
  }

  const rows = items.map((item) => pluginRow(item, data.capabilities || [])).join('');
  const table = `<div class="asset-table-wrap"><table class="asset-table plugin-table">
    <thead><tr><th>插件</th><th>状态</th><th>能力</th><th>工具</th><th>操作</th></tr></thead>
    <tbody>${rows}</tbody>
  </table></div>`;

  return setHtmlIfChanged(box, `${head}${table}`, { force: true });
}

/** 设置编辑器：只渲染当前选中的那个插件。文本域在**自动刷新容器之外**，不会被列表刷新冲掉。 */
function renderSettingsEditor(payload) {
  const box = $(SETTINGS_BOX);
  if (!box) return;
  const data = pageData();
  if (!data.editing) {
    box.innerHTML = '';
    return;
  }
  const item = (data.plugins || []).find((entry) => entry.id === data.editing) || {};
  const settings = payload?.settings ?? item.settings ?? {};
  const secretFields = payload?.secretFields ?? item.secretFields ?? [];
  const secrets = secretFields.length
    ? `<div class="hint error">这个插件配过凭据：${secretFields.map((name) => `<code>${esc(name)}</code>`).join('、')}。
       凭据的<b>值</b>不会下发到页面（这是设计如此）。保存时会<b>整体替换</b>这段设置，
       所以没写进下面的凭据会被清空 —— 要保留就重新填一份。</div>`
    : '';

  box.innerHTML = `<div class="plugin-settings">
    <div class="asset-toolbar">
      <div class="asset-search"><b>设置：</b><code>${esc(data.editing)}</code></div>
      <div class="asset-toolbar-actions">
        <button class="btn btn-small" data-plugin-action="settings-save">保存</button>
        <button class="btn btn-small" data-plugin-action="settings-close">关闭</button>
      </div>
    </div>
    ${secrets}
    <textarea id="plugin-settings-text" spellcheck="false" rows="14"
      aria-label="插件设置 JSON">${esc(JSON.stringify(settings, null, 2))}</textarea>
    <div class="hint">这段就是 <code>config.json</code> 里 <code>plugins.settings.${esc(data.editing)}</code> 的内容，
    整体替换（不是深合并）。凭据字段名要写成凭据样（含 apikey / 以 token 结尾 / secret / password），
    否则宿主不会把它当密钥脱敏。</div>
  </div>`;
}

/**
 * 插件根编辑器（在**自动刷新容器之外**，与设置编辑器同一个理由：别把正在输入的内容冲掉）。
 *
 * 渲染时机刻意**不放在 refresh() 里** —— 它只在进页面、点「编辑插件根」、保存/取消之后重画。
 * 否则用户正在输入一个新路径时后台一刷新，输入就没了（这个控制台踩过好几次的那个坑）。
 */
function renderRootsEditor() {
  const box = $(ROOTS_BOX);
  if (!box) return;
  const data = pageData();
  if (data.rootsEditing !== true) {
    box.innerHTML = `<div class="plugin-roots">
      <div class="asset-toolbar">
        <div class="asset-search"><b>插件根</b>
          <span class="hint">${(data.roots || []).length} / ${data.maxRoots} 个</span></div>
        <div class="asset-toolbar-actions">
          <button class="btn btn-small" data-plugin-action="roots-edit">编辑插件根</button>
        </div>
      </div>
      <div class="hint">放进这些目录的插件不会被 deploy.sh 碰到（标「自建」的那些更是一点都不碰），
      所以加/删插件都不必发版本。重启服务后新根里的插件才会被装载。</div>
      ${rootListHtml()}
    </div>`;
    return;
  }
  box.innerHTML = `<div class="plugin-roots">
    <div class="asset-toolbar">
      <div class="asset-search"><b>编辑插件根</b></div>
      <div class="asset-toolbar-actions">
        <button class="btn btn-small" data-plugin-action="roots-save">保存</button>
        <button class="btn btn-small" data-plugin-action="roots-cancel">取消</button>
      </div>
    </div>
    <textarea id="plugin-roots-text" spellcheck="false" rows="5"
      aria-label="插件根，一行一个">${esc((data.roots || []).join('\n'))}</textarea>
    <div class="hint">一行一个，最多 ${data.maxRoots} 个。绝对路径按原样用；
    相对路径是相对数据目录解析的（例如写 <code>my-plugins</code> 等于数据目录下的 my-plugins）。
    安装目录里的那个 plugins 根<b>自动包含</b>，不用写进来，也删不掉它。</div>
    ${rootListHtml()}
  </div>`;
}

/** 把服务端下发的整份快照写进 state。`GET /api/plugins` 与各写入路由的响应是同一个形状。 */
function applyPayload(payload) {
  const data = pageData();
  data.plugins = Array.isArray(payload?.plugins) ? payload.plugins : [];
  data.capabilities = Array.isArray(payload?.capabilities) ? payload.capabilities : [];
  data.roots = Array.isArray(payload?.roots) ? payload.roots : [];
  data.rootInfo = Array.isArray(payload?.rootInfo) ? payload.rootInfo : [];
  data.enabled = Array.isArray(payload?.enabled) ? payload.enabled : [];
  if (typeof payload?.maxRoots === 'number') data.maxRoots = payload.maxRoots;
  return data;
}

async function refresh() {
  try {
    const payload = await api('/api/plugins');
    const data = applyPayload(payload);
    // 正在编辑的插件没了（被删/改名）就把编辑器收起来，免得停在一个不存在的 id 上。
    if (data.editing && !data.plugins.some((item) => item.id === data.editing)) {
      data.editing = '';
      renderSettingsEditor(null);
    }
    renderPluginPage();
  } catch (error) {
    // 列表拉取失败要**绕过去重**写错误（setBoxError 会清掉 __renderedHtml）：
    // 否则数据没变时下一次成功渲染会被判成"没变化"而跳过，页面永远停在错误提示上。
    setBoxError($(LIST_BOX), `<div class="empty-hint">读取插件列表失败：${esc(error?.message ?? error)}</div>`);
  }
}

async function post(path, body) {
  return api(path, { method: 'POST', body: JSON.stringify(body) });
}

async function handleAction(action, id, el) {
  const data = pageData();
  if (action === 'reload') {
    note('');
    await refresh();
    return;
  }
  if (action === 'toggle') {
    const next = el?.dataset?.pluginNext === 'true';
    // askForConfirmation 返回 Promise（不是 window.confirm），必须 await ——
    // 不 await 的话拿到的永远是 truthy 的 Promise，等于"从来不问就停用"。
    if (!next && !(await askForConfirmation(`停用插件 ${id}？它的数据会保留，重启后不再装载。`))) return;
    const result = await post('/api/plugins/toggle', { id, enabled: next });
    data.editing = data.editing === id ? '' : data.editing;
    renderSettingsEditor(null);
    note(result?.restartRequired ? `${id} 已${next ? '启用' : '停用'}，重启服务后生效。` : `${id} 状态未变化。`, 'success');
    await refresh();
    return;
  }
  if (action === 'approve') {
    const result = await post('/api/plugins/approve', { id });
    const caps = (result?.approved?.capabilities || []).join('、') || '（无能力）';
    const tools = (result?.approved?.tools || []).join('、') || '（无工具）';
    note(`已确认 ${id}@${result?.approved?.version ?? '?'}：能力 ${caps}；工具 ${tools}。重启服务后生效。`, 'success');
    await refresh();
    return;
  }
  if (action === 'remove') {
    const purge = el?.dataset?.pluginPurge === 'true';
    const message = purge
      ? `移除插件 ${id} 并删除它的数据？\n\n会清掉它的「启用 / 能力确认 / 设置」三处配置记录；插件目录不会删。\n在 plugin-state 下的数据会被永久删除，不可恢复。`
      : `移除插件 ${id} 的配置记录？\n\n会清掉它的「启用 / 能力确认 / 设置」三处记录；插件目录不会删，数据目录也会保留。`;
    // askForConfirmation 返回 Promise，必须 await（不 await 等于"从来不问就删"）。
    if (!await askForConfirmation(message)) return;
    const result = await post('/api/plugins/remove', { id, purgeState: purge });
    data.editing = data.editing === id ? '' : data.editing;
    renderSettingsEditor(null);
    const removed = result?.removed || {};
    const tail = removed.purgeError
      ? `，但数据目录没删掉：${removed.purgeError}`
      : (removed.purged ? '，数据已删除' : '，数据目录保留');
    note(`${id} 的配置记录已移除${tail}。${result?.restartRequired ? '重启服务后它的工具会真的消失。' : ''}`, 'success');
    await refresh();
    return;
  }
  if (action === 'roots-edit') {
    data.rootsEditing = true;
    renderRootsEditor();
    return;
  }
  if (action === 'roots-cancel') {
    data.rootsEditing = false;
    renderRootsEditor();
    return;
  }
  if (action === 'roots-save') {
    const area = $('#plugin-roots-text');
    if (!area) return;
    const roots = String(area.value || '').split('\n').map((line) => line.trim()).filter(Boolean);
    if (roots.length > data.maxRoots) {
      note(`最多 ${data.maxRoots} 个插件根（现在是 ${roots.length} 个）。`, 'error');
      return;
    }
    const result = await post('/api/plugins/roots', { roots });
    applyPayload(result);
    data.rootsEditing = false;
    renderRootsEditor();
    note(`插件根已保存（${(result?.roots || []).length} 个）。新根里的插件会立刻出现在列表里，但要重启服务才会装载。`, 'success');
    await refresh();
    return;
  }
  if (action === 'settings') {
    if (data.editing === id) {
      data.editing = '';
      renderSettingsEditor(null);
      return;
    }
    data.editing = id;
    note('');
    const payload = await api(`/api/plugins/settings?id=${encodeURIComponent(id)}`);
    renderSettingsEditor(payload);
    return;
  }
  if (action === 'settings-close') {
    data.editing = '';
    renderSettingsEditor(null);
    return;
  }
  if (action === 'settings-save') {
    const area = $('#plugin-settings-text');
    if (!area) return;
    let parsed = null;
    try {
      parsed = JSON.parse(String(area.value || '{}'));
    } catch (error) {
      note(`JSON 不合法：${error?.message ?? error}`, 'error');
      return;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      note('设置必须是一个 JSON 对象（用 {} 包起来）。', 'error');
      return;
    }
    const result = await post('/api/plugins/settings', { id: data.editing, settings: parsed });
    // 用服务端回给的那份重画：保存会剥掉凭据，页面上该显示"凭据没了"而不是用户刚敲的原文。
    renderSettingsEditor(result);
    note(`${data.editing} 的设置已保存${result?.secretFields?.length ? '（凭据已剥离，明文不入库到页面）' : ''}。`, 'success');
    await refresh();
  }
}

/**
 * 页面入口（switchTab 调用）。永不抛：这是 tab 切换路径，抛出去会变成未捕获错误
 * （ui-smoke 会当场判红），而且用户只是切了个页签。
 * 事件绑定也在这里做（幂等）：列表每次重画都会换掉按钮节点，所以只在视图容器上委托一次。
 */
async function loadPluginPage() {
  bindPluginPageEvents();
  try {
    await refresh();
  } catch (error) {
    setBoxError($(LIST_BOX), `<div class="empty-hint">插件页渲染失败：${esc(error?.message ?? error)}</div>`);
  }
  // 插件根编辑器**不在 refresh() 里重画**（否则正在输入的路径会被后台刷新冲掉），
  // 所以在这里单独画一次：拉取失败也要能编辑根（那正是"我加的根怎么没生效"时要看的地方）。
  renderRootsEditor();
}

/** 事件委托只挂一次。绑在 `.view` 容器上，这样列表重画不需要重新绑定。 */
let bound = false;
function bindPluginPageEvents() {
  if (bound) return;
  const box = $(LIST_BOX);
  const host = box?.closest?.('.view');
  if (!host) return;
  bound = true;
  host.addEventListener('click', (event) => {
    const target = event.target?.closest?.('[data-plugin-action]');
    if (!target || !host.contains(target)) return;
    event.preventDefault();
    const action = String(target.dataset.pluginAction || '');
    const id = String(target.dataset.pluginId || '');
    handleAction(action, id, target).catch((error) => {
      note(`${action} 失败：${error?.message ?? error}`, 'error');
    });
  });
}

// 尾部集中导出，与 ui/ 其余文件同一写法
//（test/ui-module-graph.test.mjs 只认这种 `export { ... }` 形式，认不出 `export function`）。
export { loadPluginPage };
