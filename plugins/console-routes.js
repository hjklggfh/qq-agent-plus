// 插件的控制台 API。
//
// 一期只做了内核（改 config.json + 重启），二期把"启停 / 确认能力 / 改设置"搬进控制台：
// 让运维在页面上就能看到"装了哪些插件、各自什么状态、为什么没生效"，不用手抄 JSON 快照。
//
// 接线方式沿用 `src/console/manual-friend-review-route.js` 那个先例：只依赖 `app.addRoute`
// 与 `app.auditWrite` / `app.emit` 这几个公开句柄，鉴权、405、未命中 404 全部继承路由表
// （`auth` 默认 true，**不要**给这些路由加 auth:false —— 有用例钉住只有 /healthz 与 /api/login
// 可以免鉴权）。
//
// 本模块放在 `plugins/` 顶层（与 loader.js 平级）而不是 `_host/` 下：它是这个子系统的
// 第二个入口。装载器只把子**目录**当插件，所以这个文件不会被当成插件。
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, MAX_PLUGIN_ROOTS, getConfig, updateConfig } from '../src/core/config.js';
import { PLUGIN_ID_PATTERN, fingerprintMatches, manifestFingerprint, normalizeManifest, readManifest } from './_host/manifest.js';
import { PLUGIN_CAPABILITY_IDS, capabilitySummary } from './_host/capabilities.js';
import { pluginSecretFieldNames, readPluginSettings } from './_host/context.js';
import { pluginRuntimeStatuses } from './_host/registry.js';
import { pluginStateDir } from './_host/storage.js';
import { BUNDLED_PLUGIN_ROOT, enabledPluginIds, listPluginDirs, pluginRoots } from './loader.js';

/** 设置对象序列化后的体积上限。插件设置是给人写的扁平配置，64KB 已经非常宽裕。 */
export const MAX_SETTINGS_BYTES = 64 * 1024;
export const MAX_REQUEST_BYTES = 256 * 1024;
/** 单个插件根路径的长度上限。路径由人填，给个上限免得 config.json 被写成垃圾场。 */
export const MAX_ROOT_LENGTH = 512;

const PIXIV_PLUGIN_ID = 'pixiv-illust';
const PIXIV_CHAT_RATINGS_FILE = 'chat-ratings.json';
const CHAT_RATING_KEY = /^(?:group|private):[0-9]+$/;
const CHAT_RATING_TOKENS = new Set(['safe', 'r18', 'r18g']);
const MAX_CHAT_RATING_ENTRIES = 512;

/** 状态取值与 loader 的 PLUGIN_STATUS 一致，另加一个只在这里出现的 `missing`。 */
const STATUS = Object.freeze({
  LOADED: 'loaded',
  DISABLED: 'disabled',
  PENDING_APPROVAL: 'pending-approval',
  INVALID: 'invalid',
  FAILED: 'failed',
  /** 已启用，但在任何插件根里都没找到这个 id —— 通常是拼错或目录名不对。 */
  MISSING: 'missing'
});

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function pixivChatRatingsPath(dataDir) {
  return path.join(pluginStateDir(dataDir, PIXIV_PLUGIN_ID), PIXIV_CHAT_RATINGS_FILE);
}

function normalizePixivChatRatings(value) {
  if (!isPlainObject(value)) throw new Error('chatRatings 必须是 JSON 对象');
  const entries = Object.entries(value);
  if (entries.length > MAX_CHAT_RATING_ENTRIES) {
    throw new Error(`chatRatings 最多 ${MAX_CHAT_RATING_ENTRIES} 个会话`);
  }
  const out = {};
  for (const [key, rawTokens] of entries) {
    if (!CHAT_RATING_KEY.test(key)) {
      throw new Error(`chatRatings 会话标识不合法：${JSON.stringify(key)}（应为 group:群号 或 private:QQ号）`);
    }
    if (!Array.isArray(rawTokens) || rawTokens.length === 0) {
      throw new Error(`chatRatings.${key} 必须是至少包含一项的数组`);
    }
    const tokens = [...new Set(rawTokens.map((token) => String(token).trim().toLowerCase()))];
    if (tokens.some((token) => !CHAT_RATING_TOKENS.has(token))) {
      throw new Error(`chatRatings.${key} 只能使用 safe / r18 / r18g`);
    }
    out[key] = tokens;
  }
  return out;
}

function readPixivChatRatings(dataDir) {
  const file = pixivChatRatingsPath(dataDir);
  try {
    return normalizePixivChatRatings(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch (error) {
    if (error?.code === 'ENOENT') return {};
    throw new Error(`读取 Pixiv 会话分级失败：${errorText(error)}`);
  }
}

function writePixivChatRatings(dataDir, value) {
  const normalized = normalizePixivChatRatings(value);
  const file = pixivChatRatingsPath(dataDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(normalized, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, file);
  } finally {
    try { fs.rmSync(tmp, { force: true }); } catch { /* ignore cleanup failure */ }
  }
  return normalized;
}

function pluginSettingsView(config, id, dataDir) {
  const settings = readPluginSettings(config, id);
  if (id === PIXIV_PLUGIN_ID) {
    // 早期版本曾把 group:/private: 键误写进 config.json。它们现在由独立的
    // chat-ratings.json 管理，隐藏旧字段避免用户继续编辑错误位置；下次保存
    // 时整体替换设置也会把这些字段清掉。
    for (const key of Object.keys(settings)) {
      if (CHAT_RATING_KEY.test(key)) delete settings[key];
    }
    settings.chatRatings = readPixivChatRatings(dataDir);
  }
  return settings;
}

/**
 * 这个根是不是"随版本发布的那一个"（`<安装目录>/plugins`）。
 *
 * 页面上必须能分辨它和用户自己加的根：前者会被 `deploy.sh` 的 rsync 覆盖/合并
 * （同名 id 会把两边文件混在一起），后者 rsync 根本不碰 —— 而"加插件不必发版"这条路
 * 走的正是后者。只显示路径不足以让人分辨，所以这个判断要在服务端做。
 */
function isBundledRoot(root) {
  return path.normalize(String(root ?? '')) === path.normalize(BUNDLED_PLUGIN_ROOT);
}

function errorText(error) {
  return String(error?.message ?? error);
}

async function readJsonBody(req, maxBytes = MAX_REQUEST_BYTES) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw new Error('请求体过大');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return isPlainObject(value) ? value : {};
  } catch {
    throw new Error('请求体必须是 JSON');
  }
}

function json(res, status, value) {
  if (res.headersSent || res.writableEnded) return;
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(value));
}

function requirePluginId(raw) {
  const id = String(raw ?? '').trim();
  if (!PLUGIN_ID_PATTERN.test(id)) {
    throw new Error(`插件 id 不合法：${JSON.stringify(raw)}（小写字母开头，只含小写字母/数字/短横线）`);
  }
  return id;
}

/**
 * 现场扫描插件根并描述每个插件的状态。
 *
 * 为什么 GET 要**重新扫盘**而不是只报启动时的状态：最常见的用法是"我把插件拷进去了，
 * 刷新看看" —— 只报启动快照的话，新插件在页面上根本不存在，只能重启一次才能看见、
 * 再重启一次才能生效。这里只做发现 + manifest 校验，**不 import、不 activate**（那仍然
 * 只在进程启动时做一次），所以扫盘的代价只是几次 readdir/readFile。
 *
 * 状态推导（顺序即优先级）：
 *   1. manifest 坏 → invalid
 *   2. 工具名与内置或先被占用的插件冲突 → failed
 *   3. 没启用 → disabled
 *   4. 缺审批记录 / 指纹不一致 → pending-approval
 *   5. 否则用本进程的真实装载结果（loaded / failed）；本进程没见过它 → pending-approval
 *
 * `needsRestart` 单独给：它表示"配置这一侧已经就绪，但当前进程还没把它装载起来" ——
 * 页面上"重启后生效"的提示靠它，而不是靠猜状态。
 */
export function describePlugins({
  dataDir = DATA_DIR,
  config = {},
  runtimeStatuses = [],
  builtinToolNames = []
} = {}) {
  const roots = pluginRoots({ dataDir, config });
  const enabledSet = new Set(enabledPluginIds(config));
  const reserved = new Set(builtinToolNames.map((name) => String(name)).filter(Boolean));
  const seen = new Set();
  const out = [];

  for (const root of roots) {
    for (const item of listPluginDirs(root)) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      out.push(describeOne({
        id: item.id,
        dir: item.dir,
        root,
        dataDir,
        config,
        enabledSet,
        reserved,
        runtime: runtimeStatuses.find((entry) => entry.id === item.id) || null
      }));
    }
  }

  // 已启用却没扫到：这类"配置里写着、盘上没有"最容易让人以为"启用了但没生效"。
  // 单独列出来并点名，比让它在页面上凭空消失好得多。
  for (const id of enabledSet) {
    if (seen.has(id)) continue;
    out.push({
      id,
      name: id,
      version: '',
      apiVersion: null,
      description: '',
      dir: '',
      root: '',
      bundled: false,
      stateDirExists: fs.existsSync(pluginStateDir(dataDir, id)),
      capabilities: [],
      tools: [],
      status: STATUS.MISSING,
      reason: `已启用，但在任何插件根里都没找到这个 id（检查拼写，或目录名是否等于 id）：${roots.join('、')}`,
      approved: null,
      approvedMatches: false,
      needsRestart: false,
      loadedInProcess: false,
      enabled: true,
      settings: {},
      secretFields: []
    });
  }

  out.sort((a, b) => a.id.localeCompare(b.id));
  // 每个根自己也要带上"是不是随版本发布的那个"与"目录到底存不存在"：路径写错了却看不出
  // 原因（"我加了根，怎么一个插件都没有"）是这套东西最容易卡住人的一处。
  const rootInfo = roots.map((item) => ({
    path: item,
    bundled: isBundledRoot(item),
    exists: fs.existsSync(item)
  }));
  return { roots, rootInfo, plugins: out };
}

function describeOne({ id, dir, root, dataDir, config, enabledSet, reserved, runtime }) {
  const base = {
    id,
    name: id,
    version: '',
    apiVersion: null,
    description: '',
    dir,
    // 这个插件是从哪个根扫到的、那个根是不是随版本发布的那一个（见 isBundledRoot）。
    root: String(root ?? ''),
    bundled: isBundledRoot(root),
    capabilities: [],
    tools: [],
    status: STATUS.INVALID,
    reason: '',
    approved: isPlainObject(config?.plugins?.approved?.[id]) ? config.plugins.approved[id] : null,
    approvedMatches: false,
    needsRestart: false,
    loadedInProcess: Boolean(runtime && runtime.status === STATUS.LOADED),
    enabled: enabledSet.has(id),
    // 「移除并删除数据」这个不可逆的动作只在真的有状态目录时才该出现（页面靠它决定）。
    // 顺带：它也是"这个插件到底跑没跑过"的一个诚实指标。
    stateDirExists: fs.existsSync(pluginStateDir(dataDir, id)),
    settings: pluginSettingsView(config, id, dataDir),
    secretFields: pluginSecretFieldNames(config, id)
  };

  let manifest = null;
  try {
    manifest = normalizeManifest(readManifest(dir), {
      pluginDir: dir,
      expectedId: id,
      capabilityNames: PLUGIN_CAPABILITY_IDS
    });
  } catch (error) {
    return { ...base, status: STATUS.INVALID, reason: errorText(error) };
  }

  const meta = {
    ...base,
    name: manifest.name,
    version: manifest.version,
    apiVersion: manifest.apiVersion,
    description: manifest.description,
    capabilities: [...manifest.capabilities],
    tools: manifest.tools.map((tool) => tool.name)
  };

  // 与装载器同一套重名规则：内置工具先占住，然后按扫描顺序逐个占。
  const collisions = manifest.tools.map((tool) => tool.name).filter((name) => reserved.has(name));
  if (collisions.length) {
    return {
      ...meta,
      status: STATUS.FAILED,
      reason: `工具名与已有工具冲突：${collisions.join(', ')}（工具名必须全宿主唯一）`
    };
  }
  for (const tool of manifest.tools) reserved.add(tool.name);

  if (!enabledSet.has(id)) {
    return { ...meta, status: STATUS.DISABLED, reason: '未在 plugins.enabled 里启用' };
  }

  const matches = base.approved
    ? fingerprintMatches(base.approved, manifest)
    : false;
  if (!matches) {
    return {
      ...meta,
      approvedMatches: false,
      status: STATUS.PENDING_APPROVAL,
      reason: base.approved
        ? `能力/工具快照与已确认的不一致（已确认 ${base.approved.version ?? '?'}，当前 ${manifest.version}）—— 升级后必须重新确认`
        : '缺少能力确认记录：这个插件声明的能力与工具还没有被确认过'
    };
  }

  // 审批一致：真相以本进程的装载结果为准。
  if (!runtime) {
    return {
      ...meta,
      approvedMatches: true,
      needsRestart: true,
      status: STATUS.PENDING_APPROVAL,
      reason: '配置已就绪，但当前进程还没装载它 —— 重启后生效'
    };
  }
  return {
    ...meta,
    approvedMatches: true,
    needsRestart: runtime.status !== STATUS.LOADED,
    status: runtime.status,
    reason: runtime.reason || ''
  };
}

/**
 * 所有写入都走 `app.updateConfig` → `updateConfig`：它是全部写入路径的必经口，
 * 归一化、上限夹紧、`has*` 派生位剥离与凭据归属校验都在那里，路由层不该另立一套。
 */
function writePluginConfig(patch) {
  return updateConfig({ plugins: patch });
}

/**
 * 安装控制台路由。幂等：重复调用同一路径会抛（router.add 不去重，重复注册会让先注册的那条
 * 永远匹配不到）。用 Symbol 打标做单例，与 `experimental-multimodal-context.js` 同一手法。
 */
const INSTALLED = Symbol.for('qq-agent.plugin-console-routes');

export function installPluginRoutes(app, options = {}) {
  if (typeof app?.addRoute !== 'function') {
    throw new Error('插件控制台路由需要 app.addRoute（createApp 的路由入口）');
  }
  if (app[INSTALLED]) return app;
  Object.defineProperty(app, INSTALLED, { value: true, enumerable: false });

  const dataDir = options.dataDir ?? DATA_DIR;
  const builtinToolNames = Array.isArray(options.builtinToolNames) ? options.builtinToolNames : [];

  function snapshot(config) {
    return describePlugins({
      dataDir,
      config,
      runtimeStatuses: pluginRuntimeStatuses(),
      builtinToolNames
    });
  }

  function fail(res, action, id, status, error) {
    app.auditWrite?.(`plugin.${action}`, String(id ?? ''), { ok: false, error: errorText(error) });
    json(res, status, { error: errorText(error) });
  }

  /**
   * 插件页要的全部内容（`GET /api/plugins` 与各写入路由的响应共用同一份形状）。
   *
   * 写入之后直接把最新快照回给界面，而不是让界面再发一次 GET：少一次往返，
   * 也避开"保存成功但列表还是旧的"那种一闪而过的中间态。
   */
  function pluginsPayload(config) {
    const { roots, rootInfo, plugins } = snapshot(config);
    return {
      roots,
      rootInfo,
      // 上限由服务端下发：界面不该抄一份常量（抄了就会两边漂移）。
      maxRoots: MAX_PLUGIN_ROOTS,
      enabled: enabledPluginIds(config),
      capabilities: capabilitySummary(),
      plugins
    };
  }

  // ── 列表 ──
  app.addRoute('GET', '/api/plugins', (req, res) => {
    json(res, 200, pluginsPayload(getConfig()));
  });

  // ── 插件根（"自行添加插件"的落点）──
  // 放在安装目录之外的根完全不经过 deploy.sh 的 rsync，所以"加插件不必发版本"靠它最稳。
  // 只写配置：新增的根会立刻被扫到并显示出来，但要等重启才会真的装载（装载只在启动时做一次）。
  app.addRoute('POST', '/api/plugins/roots', async (req, res) => {
    try {
      const body = await readJsonBody(req);
      if (!Array.isArray(body.roots)) throw new Error('roots 必须是数组（可以是空数组）');
      if (body.roots.length > MAX_PLUGIN_ROOTS) {
        throw new Error(`最多 ${MAX_PLUGIN_ROOTS} 个插件根（收到 ${body.roots.length} 个）`);
      }
      const roots = [];
      for (const item of body.roots) {
        const text = String(item ?? '').trim();
        if (!text) continue;
        if (text.length > MAX_ROOT_LENGTH) {
          throw new Error(`插件根路径超过 ${MAX_ROOT_LENGTH} 字符：${text.slice(0, 60)}…`);
        }
        if (/[\u0000-\u001f]/.test(text)) {
          throw new Error('插件根路径里不能有控制字符（换行、制表符等）');
        }
        roots.push(text);
      }
      writePluginConfig({ roots });
      app.emit?.('plugin-update', { id: '', action: 'roots' });
      app.auditWrite?.('plugin.roots', '', { req, after: { roots } });
      json(res, 200, { ok: true, ...pluginsPayload(getConfig()) });
    } catch (error) {
      fail(res, 'roots', '', 400, error);
    }
  });

  // ── 移除（把三处记录一起清掉）──
  // 刻意**不删插件目录**：目录可能在随版本发布的那一个根里，删了下次部署又会回来 ——
  // 与其做一个会被自己撤销的动作，不如把确切路径告诉使用者、让人自己删。
  // 状态目录默认保留（重装时数据还在），只有显式要求才清。
  app.addRoute('POST', '/api/plugins/remove', async (req, res) => {
    let id = '';
    try {
      const body = await readJsonBody(req);
      id = requirePluginId(body.id);
      const purgeState = body.purgeState === true;
      const config = getConfig();
      const { plugins } = snapshot(config);
      const target = plugins.find((item) => item.id === id);
      if (!target) throw new Error(`找不到插件 ${id}（它既不在任何插件根里，也没有启用记录）`);

      const wasEnabled = enabledPluginIds(config).includes(id);
      const hadApproval = isPlainObject(config?.plugins?.approved?.[id]);
      const hadSettings = isPlainObject(config?.plugins?.settings?.[id]);
      // 设成 null 会被 config-legacy 的 plugins 归一化删掉（approved / settings 各有一段清理），
      // 所以这就是"删掉一个键"的正规写法，不用另造 __replace__ 之类的通道。
      writePluginConfig({
        enabled: enabledPluginIds(config).filter((item) => item !== id),
        approved: { [id]: null },
        settings: { [id]: null }
      });

      let purged = false;
      let purgeError = '';
      if (purgeState) {
        try {
          fs.rmSync(pluginStateDir(DATA_DIR, id), { recursive: true, force: true });
          purged = true;
        } catch (error) {
          // 数据没删掉不该让整个移除失败：配置那三处已经清了，如实报出来让人自己去看。
          purgeError = errorText(error);
        }
      }

      app.emit?.('plugin-update', { id, action: 'remove' });
      app.auditWrite?.('plugin.remove', id, {
        req,
        after: { wasEnabled, hadApproval, hadSettings, purged }
      });
      json(res, 200, {
        ok: true,
        removed: { id, wasEnabled, hadApproval, hadSettings, purged, purgeError, dir: target.dir },
        // 它可能还在当前进程里跑着（装载只在启动时发生一次），那种情况要重启才真的摘掉工具。
        restartRequired: target.loadedInProcess === true,
        ...pluginsPayload(getConfig())
      });
    } catch (error) {
      fail(res, 'remove', id, 400, error);
    }
  });

  // ── 启用 / 停用 ──
  // 只改配置，不热插拔：装载发生在 createApp() 之前（Orchestrator 构造时就抓一次工具表），
  // 所以这里明确回 restartRequired，让界面把话说明白，而不是让人以为"点了就该生效"。
  app.addRoute('POST', '/api/plugins/toggle', async (req, res) => {
    try {
      const body = await readJsonBody(req);
      const id = requirePluginId(body.id);
      const enabled = body.enabled === true;
      const config = getConfig();
      const { plugins } = snapshot(config);

      if (enabled) {
        // 启用一个盘上不存在的 id 是最容易犯的错（拼错一个字母，重启后什么都没有）。
        // 现场扫盘就能发现，没必要等到重启之后。
        const found = plugins.find((item) => item.id === id);
        if (!found || found.status === STATUS.MISSING) {
          throw new Error(`找不到插件 ${id}：确认目录名与 manifest 里的 id 一致，且它落在插件根里`);
        }
        if (found.status === STATUS.INVALID) {
          throw new Error(`插件 ${id} 的 manifest 不合法，先修好再启用：${found.reason}`);
        }
      }

      const current = enabledPluginIds(config);
      const next = enabled
        ? [...new Set([...current, id])]
        : current.filter((item) => item !== id);
      if (next.length === current.length && enabled === current.includes(id)) {
        json(res, 200, { ok: true, changed: false, enabled: current, restartRequired: false });
        return;
      }
      writePluginConfig({ enabled: next });
      app.emit?.('plugin-update', { id, action: enabled ? 'enable' : 'disable' });
      app.auditWrite?.('plugin.toggle', id, { req, after: { enabled } });
      json(res, 200, { ok: true, changed: true, enabled: next, restartRequired: true });
    } catch (error) {
      fail(res, 'toggle', '', 400, error);
    }
  });

  // ── 确认能力（写审批快照）──
  // 这是"能力清单变更需重新确认"那条 fail-closed 规则的操作面：从**盘上的 manifest** 现算指纹，
  // 而不是信任客户端送来的内容 —— 否则页面（或被篡改的请求）可以替一个要求 root 权限的插件
  // 签下"只有 storage"的确认。
  app.addRoute('POST', '/api/plugins/approve', async (req, res) => {
    let id = '';
    try {
      const body = await readJsonBody(req);
      id = requirePluginId(body.id);
      const config = getConfig();
      const { plugins } = snapshot(config);
      const target = plugins.find((item) => item.id === id);
      if (!target) throw new Error(`找不到插件 ${id}`);
      if (target.status === STATUS.INVALID) {
        throw new Error(`插件 ${id} 的 manifest 不合法，无法确认：${target.reason}`);
      }
      const manifest = normalizeManifest(readManifest(target.dir), {
        pluginDir: target.dir,
        expectedId: id,
        capabilityNames: PLUGIN_CAPABILITY_IDS
      });
      const fingerprint = manifestFingerprint(manifest);
      writePluginConfig({ approved: { [id]: fingerprint } });
      app.emit?.('plugin-update', { id, action: 'approve' });
      app.auditWrite?.('plugin.approve', id, { req, after: fingerprint });
      json(res, 200, {
        ok: true,
        approved: fingerprint,
        // 确认本身不会让它立刻跑起来：装载只在启动时发生一次。
        restartRequired: true
      });
    } catch (error) {
      fail(res, 'approve', id, 400, error);
    }
  });

  // ── 读取 / 写入某个插件自己的设置 ──
  app.addRoute('GET', '/api/plugins/settings', (req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      const id = requirePluginId(url.searchParams.get('id'));
      const config = getConfig();
      json(res, 200, {
        id,
        settings: pluginSettingsView(config, id, dataDir),
        secretFields: pluginSecretFieldNames(config, id),
        signature: String(config?.plugins?.approved?.[id]?.version ?? '')
      });
    } catch (error) {
      fail(res, 'settings.read', '', 400, error);
    }
  });

  app.addRoute('POST', '/api/plugins/settings', async (req, res) => {
    let id = '';
    try {
      const body = await readJsonBody(req);
      id = requirePluginId(body.id);
      if (!isPlainObject(body.settings)) throw new Error('settings 必须是 JSON 对象');
      const encoded = JSON.stringify(body.settings);
      if (Buffer.byteLength(encoded, 'utf8') > MAX_SETTINGS_BYTES) {
        throw new Error(`settings 超过 ${MAX_SETTINGS_BYTES} 字节上限`);
      }
      const config = getConfig();
      const { plugins } = snapshot(config);
      if (!plugins.some((item) => item.id === id)) throw new Error(`找不到插件 ${id}`);

      // 整体替换（`__replace__`）而不是深合并：界面编辑的是"这一个插件的完整设置"，
      // 深合并会让"删掉一个键"永远删不掉（旧值还在服务端，下次刷新又冒出来）。
      // 注意客户端拿到的本来就是**剥掉凭据**的视图，所以它提交时不会带上真实密钥；
      // 用 __replace__ 会把没提交的凭据一起清掉 —— 这正是这里要的语义（"按我看到的这份为准"），
      // 而界面必须在保存前把"已配置的凭据会被清空"讲清楚（见 ui/pages/plugins.js）。
      const nextSettings = { ...body.settings };
      let chatRatings;
      if (id === PIXIV_PLUGIN_ID && Object.prototype.hasOwnProperty.call(nextSettings, 'chatRatings')) {
        chatRatings = normalizePixivChatRatings(nextSettings.chatRatings);
        delete nextSettings.chatRatings;
      }
      if (id === PIXIV_PLUGIN_ID) {
        for (const key of Object.keys(nextSettings)) {
          if (CHAT_RATING_KEY.test(key)) delete nextSettings[key];
        }
      }
      writePluginConfig({ settings: { [id]: { __replace__: nextSettings } } });
      if (id === PIXIV_PLUGIN_ID && chatRatings !== undefined) writePixivChatRatings(dataDir, chatRatings);
      app.emit?.('plugin-update', { id, action: 'settings' });
      app.auditWrite?.('plugin.settings', id, { req, after: { keys: Object.keys(body.settings) } });
      const after = getConfig();
      json(res, 200, {
        ok: true,
        restartRequired: true,
        settings: pluginSettingsView(after, id, dataDir),
        secretFields: pluginSecretFieldNames(after, id),
        note: 'settings 是整体替换：客户端没提交的键（含凭据）已被清空'
      });
    } catch (error) {
      fail(res, 'settings', id, 400, error);
    }
  });

  return app;
}
