// 插件加载器：发现 → 校验 → 审批比对 → 动态 import → activate → 收集工具。
//
// 调用时机很重要：src/server.js 在 **createApp() 之前** await initPlugins()。
// 原因是 Orchestrator 在构造时就抓一次工具表（orchestrator.js:374 `this.toolDefs =
// buildToolDefs()`），插件工具必须在那之前就位。反过来说，因为插件只贡献"工具"，
// 我们**完全不需要**碰 app.start()/stop() 那串手写启停链，也不需要碰 POST /api/config
// 里的逐特性 diff/回滚链 —— 那两处是这份代码库里最难扩展的地方。
//
// 隔离口径（每一条都对应一种"一个坏插件拖垮整个机器人"的真实路径）：
//   - manifest 坏 / entry 缺失 / import 抛错 / activate 抛错 / 工具集与声明不符 /
//     工具名与内置或别的插件重名 → **只把这一个插件标成失败**，其余照常，主链路照常；
//   - 加载失败的插件**不注入任何工具**（宁可模型少一个工具，也不要一个必然报错的工具）；
//   - 插件是同一进程里的可信代码（能力清单是"声明+可见+需重新确认"，不是沙箱）——
//     这一点在 docs/PLUGINS.md 与 SECURITY 口径里写明，不假装隔离。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { getConfig } from '../src/core/config.js';
import {
  PluginManifestError,
  fingerprintMatches,
  manifestFingerprint,
  normalizeManifest,
  readManifest
} from './_host/manifest.js';
import { PLUGIN_CAPABILITY_IDS } from './_host/capabilities.js';
import { buildPluginApi, runPluginTool } from './_host/context.js';
import { clearPluginRegistry, setPluginRegistry } from './_host/registry.js';

/** 状态取值。控制台与运维都按这几个值判断，别在别处另写字符串字面量。 */
export const PLUGIN_STATUS = Object.freeze({
  LOADED: 'loaded',
  DISABLED: 'disabled',
  PENDING_APPROVAL: 'pending-approval',
  INVALID: 'invalid',
  FAILED: 'failed'
});

/**
 * 插件根目录。
 *
 * **只有一个固定根：<仓库根>/plugins。** 插件是代码，不是运行时数据，所以它和 src/ 平级、
 * 进版本库，而不是住在 `data/`（那里是记忆与聊天记录，整个目录都被 .gitignore）。
 *
 * 那"服务器上自装的第三方插件怎么才不会被 `deploy.sh` 的 `rsync -a --delete` 删掉"？
 * 两条路，都不需要把代码放进数据目录：
 *   ① 推荐：把插件放在**安装目录之外**（`app/` 外面，rsync 根本够不到），
 *      再用 config.json 的 `plugins.roots` 指过去（支持绝对路径），例如
 *      `/mnt/data/qq-agent/plugins` —— 与 app/、data/ 平级。零额外语义依赖。
 *   ② 兜底：直接丢进安装目录的 `plugins/`。deploy.sh 为此加了一条
 *      `--filter='protect /plugins/***'`：发送端里有的文件照常更新（仓库自带的插件
 *      因此跟版本走），接收端独有的文件在 --delete 阶段受保护、不会被删。
 */
export const PLUGIN_ROOT_NAME = 'plugins';

/** 仓库根（`plugins/loader.js` 的上一层）。 */
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 唯一的固定插件根：<仓库根>/plugins。 */
export const BUNDLED_PLUGIN_ROOT = path.join(REPO_ROOT, PLUGIN_ROOT_NAME);

export const MAX_ENTRY_DESCRIPTION_LENGTH = 4000;
export const MAX_SCHEMA_BYTES = 32 * 1024;

let activePlugins = [];

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function errorText(error) {
  return String(error?.message ?? error);
}

/** 已启用插件 id 集合。配置里是数组（migrateConfig 会归一），这里再兜一层类型。 */
export function enabledPluginIds(config = {}) {
  const raw = config?.plugins?.enabled;
  if (Array.isArray(raw)) {
    // null/undefined 要**丢掉**而不是 String() 成 'null'：后者会变成一个永远匹配不到
    // 目录的"插件 id"，在状态列表与日志里冒充一个真实条目。手改配置很容易留下 null。
    return raw
      .filter((id) => id !== null && id !== undefined && String(id).trim() !== '')
      .map((id) => String(id).trim());
  }
  if (isPlainObject(raw)) return Object.keys(raw).filter((id) => raw[id] === true);
  return [];
}

/**
 * 插件根目录列表 = 唯一的固定根（<仓库根>/plugins）+ 配置里的额外根。
 *
 * 额外根是为了"插件代码放在别处"（例如安装目录之外的挂载盘，或开发时的另一个 checkout）：
 * `plugins.roots` 支持绝对路径，相对路径按数据目录解析。
 *
 * 顺序即优先级（先扫到的赢）：**额外根排在固定根之前** —— 让"用我自己的那份覆盖仓库自带的
 * 同名插件"成为可能。反过来（自带的优先）会让用户装了却静默不生效，那是最难查的一类偏差。
 *
 * `bundledRoot` 可显式传 null 关掉固定根（用例需要隔离时才这么做）。
 */
export function pluginRoots({ dataDir, config = {}, bundledRoot = BUNDLED_PLUGIN_ROOT } = {}) {
  const roots = [];
  const extra = config?.plugins?.roots;
  if (Array.isArray(extra)) {
    for (const item of extra) {
      const text = String(item ?? '').trim();
      if (!text) continue;
      roots.push(path.isAbsolute(text)
        ? path.normalize(text)
        : path.resolve(String(dataDir ?? '.'), text));
    }
  }
  if (bundledRoot) roots.push(path.normalize(String(bundledRoot)));
  return [...new Set(roots)];
}

/**
 * 列出某个根下的插件目录。
 *
 * 跟随符号链接（`statSync` 而不是 dirent.isDirectory）：开发插件时最常见的做法是把
 * 仓库里的插件目录软链到 data/plugins/ 下，不跟随会让"明明放好了却扫不到"变成一个
 * 很难查的问题。目录名不合法（含点、大写下划线等）直接跳过 —— 那不是插件，别报错刷屏。
 */
export function listPluginDirs(root) {
  let entries = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];   // 根目录不存在是正常情形（没人装过插件）
  }
  const dirs = [];
  for (const entry of entries) {
    const name = String(entry.name || '');
    if (!name || name.startsWith('.') || name.startsWith('_') || name === 'node_modules') continue;
    const full = path.join(root, name);
    let stat = null;
    try {
      stat = fs.statSync(full);   // 跟随符号链接
    } catch {
      continue;
    }
    if (!stat.isDirectory()) continue;
    dirs.push({ id: name, dir: full });
  }
  dirs.sort((a, b) => a.id.localeCompare(b.id));
  return dirs;
}

function validateToolSchema(name, parameters) {
  if (!isPlainObject(parameters)) {
    throw new PluginManifestError(`工具 ${name} 的 parameters 必须是 JSON Schema 对象`);
  }
  if (parameters.type !== undefined && parameters.type !== 'object') {
    throw new PluginManifestError(`工具 ${name} 的 parameters.type 必须是 'object'`);
  }
  if (parameters.properties !== undefined && !isPlainObject(parameters.properties)) {
    throw new PluginManifestError(`工具 ${name} 的 parameters.properties 必须是对象`);
  }
  const bytes = Buffer.byteLength(JSON.stringify(parameters), 'utf8');
  if (bytes > MAX_SCHEMA_BYTES) {
    throw new PluginManifestError(`工具 ${name} 的 parameters 超过 ${MAX_SCHEMA_BYTES} 字节`);
  }
}

/**
 * 加载一个插件目录。
 *
 * 返回状态对象（永远不抛）：调用方只按 status 判断。这样 initPlugins 的循环里不需要
 * try/catch，也不会因为一个插件把整轮扫描带停。
 */
async function loadPluginDir({ id, dir, dataDir, config, log, reservedToolNames, enableSet }) {
  const base = {
    id,
    dir,
    name: '',
    version: '',
    apiVersion: null,
    capabilities: [],
    tools: [],
    status: PLUGIN_STATUS.INVALID,
    reason: '',
    loadedAt: 0
  };

  // ── 1. manifest ──
  let manifest = null;
  try {
    const raw = readManifest(dir);
    manifest = normalizeManifest(raw, {
      pluginDir: dir,
      expectedId: id,
      capabilityNames: PLUGIN_CAPABILITY_IDS,
      warn: (message) => log?.warn?.(`[plugin:${id}] ${message}`)
    });
  } catch (error) {
    return {
      ...base,
      reason: errorText(error),
      detail: error instanceof PluginManifestError ? error.message : ''
    };
  }

  const meta = {
    ...base,
    name: manifest.name,
    version: manifest.version,
    apiVersion: manifest.apiVersion,
    capabilities: [...manifest.capabilities],
    tools: manifest.tools.map((tool) => tool.name),
    description: manifest.description,
    fingerprint: manifestFingerprint(manifest)
  };

  // ── 2. 启用？──
  // 未启用的插件**不加载、不校验工具名冲突**（它没进模型工具表，冲突也就不存在）。
  // 但 manifest 仍然照常校验：控制台要能告诉人"这个插件本身是坏的"。
  if (!enableSet.has(id)) {
    return { ...meta, status: PLUGIN_STATUS.DISABLED, reason: '未在 plugins.enabled 里启用' };
  }

  // ── 3. 能力快照重确认 ──
  const approved = config?.plugins?.approved?.[id];
  if (!isPlainObject(approved)) {
    return {
      ...meta,
      status: PLUGIN_STATUS.PENDING_APPROVAL,
      reason: '缺少能力确认记录：插件声明的能力与工具还没有被管理员确认过'
    };
  }
  if (!fingerprintMatches(approved, manifest)) {
    return {
      ...meta,
      status: PLUGIN_STATUS.PENDING_APPROVAL,
      reason: `插件的能力/工具快照与已确认的不一致（已确认 ${approved.version ?? '?'}，`
        + `当前 ${manifest.version}）—— 升级后新增能力必须重新确认`
    };
  }

  // ── 4. 工具名冲突预检（在真的 import 之前，尽量别执行坏插件的代码）──
  const collisions = [];
  for (const tool of manifest.tools) {
    if (reservedToolNames.has(tool.name)) collisions.push(tool.name);
  }
  if (collisions.length) {
    return {
      ...meta,
      status: PLUGIN_STATUS.FAILED,
      reason: `工具名与已有工具冲突：${collisions.join(', ')}（工具名必须全宿主唯一）`
    };
  }

  // ── 5. 动态 import + activate ──
  const registered = new Map();
  let deactivate = null;
  try {
    // 走 file:// URL：Windows 上绝对路径（D:\...）直接喂给 import() 会被当成 scheme，
    // pathToFileURL 是唯一跨平台正确的做法。
    const module = await import(pathToFileURL(manifest.entryPath).href);
    const activate = module?.activate;
    if (typeof activate !== 'function') {
      return {
        ...meta,
        status: PLUGIN_STATUS.FAILED,
        reason: `入口没有导出 activate(api) 函数（导出的是：${Object.keys(module || {}).join(', ') || '（空）'}）`
      };
    }
    const api = buildPluginApi({
      manifest,
      config,
      dataDir,
      log,
      registerTool: (def) => {
        const name = String(def?.name ?? '').trim();
        if (!name) throw new PluginManifestError('registerTool 收到没有 name 的工具');
        if (registered.has(name)) throw new PluginManifestError(`工具 ${name} 被注册了两次`);
        const declared = manifest.tools.find((tool) => tool.name === name);
        if (!declared) {
          throw new PluginManifestError(
            `工具 ${name} 没有写在 manifest.tools 里（manifest 声明的工具就是模型会看到的全部工具，`
            + `运行期不能新增）`
          );
        }
        const description = String(def.description ?? '').trim();
        if (!description) throw new PluginManifestError(`工具 ${name} 缺少 description`);
        if (description.length > MAX_ENTRY_DESCRIPTION_LENGTH) {
          throw new PluginManifestError(`工具 ${name} 的 description 超过 ${MAX_ENTRY_DESCRIPTION_LENGTH} 字`);
        }
        validateToolSchema(name, def.parameters);
        if (typeof def.execute !== 'function') {
          throw new PluginManifestError(`工具 ${name} 缺少 execute 函数`);
        }
        registered.set(name, {
          description,
          parameters: def.parameters,
          handler: def.execute,
          timeoutMs: declared.timeoutMs
        });
      }
    });
    const returned = await activate(api);
    if (isPlainObject(returned) && typeof returned.deactivate === 'function') {
      deactivate = returned.deactivate;
    }
  } catch (error) {
    // activate 里抛错、入口语法错、import 期副作用抛错都落到这里。注册了半个工具集也一并丢掉。
    return {
      ...meta,
      status: PLUGIN_STATUS.FAILED,
      reason: `加载失败：${errorText(error)}`,
      detail: String(error?.stack ?? '').split('\n').slice(0, 6).join('\n')
    };
  }

  // ── 6. 工具集必须与 manifest 声明完全相等 ──
  const declaredNames = manifest.tools.map((tool) => tool.name).sort();
  const registeredNames = [...registered.keys()].sort();
  const missing = declaredNames.filter((name) => !registered.has(name));
  const extra = registeredNames.filter((name) => !declaredNames.includes(name));
  if (missing.length || extra.length) {
    const parts = [];
    if (missing.length) parts.push(`声明了但没注册：${missing.join(', ')}`);
    if (extra.length) parts.push(`注册了但没声明：${extra.join(', ')}`);
    return {
      ...meta,
      status: PLUGIN_STATUS.FAILED,
      reason: `manifest.tools 与 activate 实际注册的工具不一致（${parts.join('；')}）`
    };
  }

  // 到这里才算装载成功：把工具名全部占住，后续插件不能再用。
  for (const name of registeredNames) reservedToolNames.add(name);

  return {
    ...meta,
    status: PLUGIN_STATUS.LOADED,
    loadedAt: Date.now(),
    registered,
    deactivate
  };
}

/**
 * 状态对象对外投影：只留可序列化的元数据。
 *
 * 内部那份 status 带着 `registered`（工具实现 Map）与 `deactivate`（函数）—— 它们绝不能
 * 进注册表/控制台：前者让 console 层握住插件实现，后者在 JSON 里会被静默丢掉
 * （"看着有、实际没有"，正是这个仓库最不想要的中间态）。
 * `detail`（截断的堆栈）同样只进日志：控制台要的是"哪个插件坏了、为什么"，
 * 不是宿主的绝对路径与调用栈。
 */
function publicStatus(status) {
  return {
    id: status.id,
    name: status.name || status.id,
    version: status.version || '',
    apiVersion: status.apiVersion ?? null,
    description: status.description ?? '',
    dir: status.dir,
    capabilities: [...(status.capabilities || [])],
    tools: [...(status.tools || [])],
    status: status.status,
    reason: status.reason ?? '',
    loadedAt: Number(status.loadedAt) || 0
  };
}

function buildPluginToolDef({ manifest, toolName, entry, dataDir, log }) {
  return {
    name: toolName,
    description: entry.description,
    parameters: entry.parameters,
    // 与内置工具的 feature 标记同一套语义：过滤链按它认"这是哪个功能的工具"。
    // 插件工具**不需要**在 orchestrator 的过滤链里加分支 —— 未启用的插件它的工具
    // 根本不在数组里（装载期就决定了），所以那串硬编码 name 判定不用动。
    feature: `plugin:${manifest.id}`,
    pluginId: manifest.id,
    pluginName: manifest.name,
    pluginVersion: manifest.version,
    async execute(hostCtx, args) {
      return runPluginTool({
        manifest,
        toolName,
        handler: entry.handler,
        timeoutMs: entry.timeoutMs,
        hostCtx,
        args,
        // 每次调用现读配置。⚠️ 但要分清**热的是哪一半**：这里读到的 config 只喂给
        // `readPluginSecret`，所以 `toolCtx.secret(name)` 是现读的（改了凭据立刻生效）；
        // 而插件的**设置**只能通过 `api.config` 拿，那是 activate 时的非凭据快照 ——
        // 改 `plugins.settings.<id>` 必须重启才生效。别把这条写成"设置也不用重启"
        //（2026-10-08 修正：原注释就是这么写的，与实现不符）。
        config: getConfig(),
        dataDir,
        log
      });
    }
  };
}

/**
 * 扫描全部插件根并装载。
 *
 * `builtinToolNames` 是**必填**的：内置工具名是"插件不许覆盖"的底线。没有它就等于放弃
 * 重名预检，而"插件覆盖了内置 send_message"在工具表里完全看不出来（模型调的是内置的名字、
 * 跑的是插件的实现）—— 这种静默失效宁可不启动插件也不要放过。所以缺失时直接抛，
 * 由 server.js 的 try/catch 记一条 error 并以"没有插件"启动（机器人本身照常工作）。
 *
 * 为什么是注入而不是在这里 import tools-core：那会把 OneBot 协议栈（ws 等）拖进插件加载器，
 * 让"装载插件"这件事依赖整个消息链路是否可加载。插件系统不该有这种耦合。
 *
 * 除上面那条参数校验外，本函数永不抛：单个插件加载失败只标成失败状态。
 */
export async function initPlugins({
  dataDir,
  config = null,
  log = null,
  builtinToolNames = null,
  bundledRoot = BUNDLED_PLUGIN_ROOT
} = {}) {
  if (!Array.isArray(builtinToolNames)) {
    throw new Error('initPlugins 需要 builtinToolNames（内置工具名数组）：没有它无法阻止插件覆盖内置工具');
  }
  const cfg = config ?? getConfig();
  const roots = pluginRoots({ dataDir, config: cfg, bundledRoot });
  const enableSet = new Set(enabledPluginIds(cfg));

  // 内置工具名先占住：插件不许覆盖内置工具（覆盖会让模型调用一个语义完全不同的实现，
  // 而这在工具表里完全看不出来）。
  const reserved = new Set(builtinToolNames.map((name) => String(name)).filter(Boolean));

  const statuses = [];
  const seen = new Set();
  const loaded = [];

  for (const root of roots) {
    for (const item of listPluginDirs(root)) {
      if (seen.has(item.id)) {
        log?.warn?.(`[plugin] 插件 id ${item.id} 在多个根目录里出现，已忽略 ${item.dir}`);
        continue;
      }
      seen.add(item.id);
      const status = await loadPluginDir({
        id: item.id,
        dir: item.dir,
        dataDir,
        config: cfg,
        log,
        reservedToolNames: reserved,
        enableSet
      });
      statuses.push(status);
      if (status.status === PLUGIN_STATUS.LOADED) loaded.push(status);
    }
  }

  const toolDefs = [];
  const summaries = [];
  for (const status of loaded) {
    for (const toolName of [...status.registered.keys()].sort()) {
      const entry = status.registered.get(toolName);
      toolDefs.push(buildPluginToolDef({
        manifest: {
          id: status.id,
          name: status.name,
          version: status.version,
          capabilities: status.capabilities
        },
        toolName,
        entry,
        dataDir,
        log
      }));
    }
    summaries.push({
      id: status.id,
      name: status.name,
      version: status.version,
      description: status.description ?? '',
      capabilities: status.capabilities,
      tools: [...status.registered.keys()].sort(),
      loadedAt: status.loadedAt
    });
  }

  // 卸载上一个"当前生效"的集合（同进程内重复 init，例如测试或运维重载）。
  await releaseActivePlugins();

  const publicStatuses = statuses.map(publicStatus);
  setPluginRegistry({ toolDefs, statuses: publicStatuses, plugins: summaries });
  activePlugins = loaded;

  const failed = statuses.filter((item) => item.status !== PLUGIN_STATUS.LOADED
    && item.status !== PLUGIN_STATUS.DISABLED);
  if (loaded.length || failed.length) {
    log?.info?.(`[plugin] 插件：已加载 ${loaded.length} 个（工具 ${toolDefs.length} 个）`
      + `，未加载 ${statuses.length - loaded.length} 个`
      + (statuses.length ? `（${statuses.filter((s) => s.status === PLUGIN_STATUS.DISABLED).length} 未启用 / `
        + `${statuses.filter((s) => s.status === PLUGIN_STATUS.PENDING_APPROVAL).length} 待确认 / `
        + `${failed.length} 异常）` : ''));
  }
  for (const item of failed) {
    const write = item.status === PLUGIN_STATUS.PENDING_APPROVAL ? 'warn' : 'error';
    log?.[write]?.(`[plugin:${item.id}] ${item.status}：${item.reason}`);
  }

  return { roots, statuses: publicStatuses, toolDefs, plugins: summaries };
}

/** 调用所有已加载插件的 deactivate()（有就调，抛错只记日志）。 */
export async function releaseActivePlugins() {
  const list = activePlugins;
  activePlugins = [];
  for (const item of list) {
    if (typeof item.deactivate !== 'function') continue;
    try {
      await item.deactivate();
    } catch (error) {
      // 卸载期的异常不该影响进程退出/重载：它已经没有任何宿主能力可用，
      // 最坏是插件自己没清干净（v1 的插件不允许注册定时器，所以影响面有限）。
      console.warn(`[plugin:${item.id}] deactivate 抛错：${errorText(error)}`);
    }
  }
}

/** 清空注册表（测试与运维用）。 */
export async function resetPlugins() {
  await releaseActivePlugins();
  clearPluginRegistry();
}
