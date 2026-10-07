// 插件 manifest（plugin.json）的读取、校验与归一。
//
// 口径：**校验失败就拒绝这一个插件**（fail-closed），但不连累主链路与其它插件。
// 这里刻意不 import 配置模块 —— 校验是纯函数，便于单测直接喂坏数据。
//
// 三条来自仓库既有门禁、不能违反的规则：
//   ① 工具名不许带 `qq_` 前缀（test/selftest.mjs 会断言模型请求里的工具名不含它，
//      那是旧架构 MCP 工具的命名残留）；
//   ② 工具名必须能被 OpenAI function 接受（^[a-zA-Z0-9_-]{1,64}$）；
//   ③ manifest 里声明的工具名与语义必须**静态可审计** —— 因此 `tools[]` 是权威声明，
//      activate() 注册的工具集必须与它完全相等（见 manager.js）。这样"升级插件悄悄多给模型
//      一个工具"会被能力快照重确认拦住，而不是静默生效。
import fs from 'node:fs';
import path from 'node:path';

export const MANIFEST_FILENAME = 'plugin.json';

/** 宿主实现的插件 API 版本。manifest.apiVersion 必须严格等于它。 */
export const PLUGIN_API_VERSION = 1;

// 插件 id 同时是插件目录名、状态目录名与配置键，所以先把它限死在小写字母/数字/短横线。
// 上限 38 是为了给工具名前缀留余地时仍不超 64。
export const PLUGIN_ID_PATTERN = /^[a-z][a-z0-9-]{1,38}$/;

/** OpenAI function name 允许的字符集。 */
export const TOOL_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

/** 旧架构 MCP 工具的前缀，仓库有测试钉住"工具名不带它"。 */
export const FORBIDDEN_TOOL_PREFIX = 'qq_';

export const VERSION_PATTERN = /^\d+\.\d+\.\d+$/;

export const MIN_TOOL_TIMEOUT_MS = 1000;
export const MAX_TOOL_TIMEOUT_MS = 120000;
export const DEFAULT_TOOL_TIMEOUT_MS = 15000;
export const MAX_TOOLS_PER_PLUGIN = 32;
export const MAX_MANIFEST_BYTES = 64 * 1024;
export const MAX_NAME_LENGTH = 60;
export const MAX_DESCRIPTION_LENGTH = 600;

/**
 * manifest 里本宿主认识的键。
 *
 * 提到模块级并导出，是为了让三处共用同一个事实源：这里的"未知键告警"、
 * `docs/PLUGIN-API.md` 的字段表、以及 `test/plugin-api-doc.test.mjs` 的"文档不许漂移"断言。
 * 以前这个集合藏在 `normalizeManifest` 的闭包里，文档只能靠人抄 —— 抄错就是
 * 「作者按文档写、宿主却当未知键忽略」那类最难查的偏差。
 */
export const MANIFEST_KNOWN_KEYS = Object.freeze([
  'id', 'name', 'version', 'apiVersion', 'entry',
  'capabilities', 'tools', 'description'
]);

/** 入口文件的扩展名。仓库源码用 .js，插件是独立产物，也允许 .mjs。 */
const ENTRY_EXTENSIONS = new Set(['.mjs', '.js']);

/** manifest 校验失败。带上插件目录，方便控制台/日志直接告诉人"是哪个插件坏了"。 */
export class PluginManifestError extends Error {
  constructor(message, { pluginDir = '', cause = null } = {}) {
    super(message);
    this.name = 'PluginManifestError';
    this.pluginDir = pluginDir;
    if (cause) this.cause = cause;
  }
}

function fail(message, options) {
  throw new PluginManifestError(message, options);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

/**
 * 读 + 解析 plugin.json。
 * 用 statSync 先量体积：manifest 是给人看的配置文件，几十 KB 已经离谱，
 * 再大就没必要读进内存（也顺便防"把整个 node_modules 的 lock 当 manifest"这类事故）。
 */
export function readManifest(pluginDir) {
  const file = path.join(pluginDir, MANIFEST_FILENAME);
  let stat = null;
  try {
    stat = fs.statSync(file);
  } catch (error) {
    fail(`读不到 ${MANIFEST_FILENAME}：${error?.message ?? error}`, { pluginDir, cause: error });
  }
  if (!stat.isFile()) fail(`${MANIFEST_FILENAME} 不是普通文件`, { pluginDir });
  if (stat.size > MAX_MANIFEST_BYTES) {
    fail(`${MANIFEST_FILENAME} 超过 ${MAX_MANIFEST_BYTES} 字节（${stat.size}）`, { pluginDir });
  }
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    fail(`读不动 ${MANIFEST_FILENAME}：${error?.message ?? error}`, { pluginDir, cause: error });
  }
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    fail(`${MANIFEST_FILENAME} 不是合法 JSON：${error?.message ?? error}`, { pluginDir, cause: error });
  }
  return parsed;
}

/**
 * 把入口路径解析成插件目录内的绝对路径。
 *
 * 拒绝绝对路径与任何越出插件目录的形态（`../`、符号链接绕出）—— 插件 manifest 是
 * 外部输入，绝不能靠它把宿主的 import() 引到任意文件（例如指向 data/config.json 旁边的
 * 某个 .js，或以 `file:///etc/...` 形态越界）。
 *
 * 判序要紧：**先按字面路径判包含，再解 realpath、再判一次**。
 *   - 只判一次（在 realpath 之后）会有个副作用：`../outside.mjs` 指向一个不存在的文件时
 *     报的是"入口文件不存在"，等于用错误信息确认了"宿主外面有没有那个文件"；
 *   - 只判字面路径则拦不住"插件目录里一个指到外面的符号链接"，所以 realpath 之后必须再判一次。
 */
export function resolveEntryPath(pluginDir, entry) {
  if (!nonEmptyString(entry)) {
    fail('entry 必须是非空字符串', { pluginDir });
  }
  const raw = String(entry).trim();
  if (path.isAbsolute(raw) || /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(raw)) {
    fail(`entry 必须是插件目录内的相对路径（收到 ${raw}）`, { pluginDir });
  }
  const ext = path.extname(raw).toLowerCase();
  if (!ENTRY_EXTENSIONS.has(ext)) {
    fail(`entry 只允许 .js / .mjs（收到 ${raw}）`, { pluginDir });
  }
  const realDir = fs.realpathSync(pluginDir);
  const candidate = path.resolve(realDir, raw);
  if (!isInside(realDir, candidate)) {
    fail(`entry 越出插件目录：${raw}`, { pluginDir });
  }
  let realEntry = '';
  try {
    realEntry = fs.realpathSync(candidate);
  } catch (error) {
    fail(`入口文件不存在：${raw}（${error?.message ?? error}）`, { pluginDir, cause: error });
  }
  const stat = fs.statSync(realEntry);
  if (!stat.isFile()) fail(`入口不是普通文件：${raw}`, { pluginDir });
  if (!isInside(realDir, realEntry)) {
    fail(`entry 越出插件目录：${raw}`, { pluginDir });
  }
  return realEntry;
}

/** child 是否就是 parent 本身或位于 parent 之内（两边都必须是已解析的绝对路径）。 */
function isInside(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function normalizeTools(rawTools, { pluginDir, capabilityNames }) {
  if (!Array.isArray(rawTools) || rawTools.length === 0) {
    fail('tools 必须是非空数组（插件至少要给模型一个工具）', { pluginDir });
  }
  if (rawTools.length > MAX_TOOLS_PER_PLUGIN) {
    fail(`tools 最多 ${MAX_TOOLS_PER_PLUGIN} 个（收到 ${rawTools.length}）`, { pluginDir });
  }
  const seen = new Map();
  const tools = [];
  for (const entry of rawTools) {
    if (!isPlainObject(entry)) fail('tools 的每一项都必须是对象', { pluginDir });
    const name = nonEmptyString(entry.name) ? String(entry.name).trim() : '';
    if (!name) fail('tools[].name 必须是非空字符串', { pluginDir });
    if (!TOOL_NAME_PATTERN.test(name)) {
      fail(`工具名 ${name} 不合法：只允许字母/数字/下划线/短横线，长度 1~64`, { pluginDir });
    }
    if (name.startsWith(FORBIDDEN_TOOL_PREFIX)) {
      fail(`工具名 ${name} 不许以 ${FORBIDDEN_TOOL_PREFIX} 开头（旧架构 MCP 工具命名，宿主测试禁止）`, { pluginDir });
    }
    if (seen.has(name)) fail(`tools 里工具名重复：${name}`, { pluginDir });
    seen.set(name, true);

    let timeoutMs = DEFAULT_TOOL_TIMEOUT_MS;
    if (entry.timeoutMs !== undefined) {
      const value = Number(entry.timeoutMs);
      if (!Number.isFinite(value)) fail(`工具 ${name} 的 timeoutMs 不是数字`, { pluginDir });
      if (value < MIN_TOOL_TIMEOUT_MS || value > MAX_TOOL_TIMEOUT_MS) {
        fail(`工具 ${name} 的 timeoutMs 必须在 ${MIN_TOOL_TIMEOUT_MS}~${MAX_TOOL_TIMEOUT_MS} 之间`, { pluginDir });
      }
      timeoutMs = Math.round(value);
    }
    tools.push({ name, timeoutMs });
  }
  // capabilityNames 目前不参与工具级校验，参数留着是为了将来"按能力限定工具"时不改签名。
  void capabilityNames;
  return tools;
}

/**
 * 校验并归一 manifest。
 *
 * 未知顶层键**只警告不拒绝**：manifest 是跨版本契约，拒绝未知键会让"新插件装到旧宿主上"
 * 直接报一个看不懂的错；而缺字段/类型错/值非法仍然一律拒绝。
 *
 * ⚠️ 形参写成 `options` + 显式取别名，而不是解构参数：`src/ops.js` 的未定义调用扫描器
 * 不认识解构参数，会把 `warn(...)` 报成"可疑未定义调用"，CI 门禁 `ops scan --strict`
 * 会判红（`src/console/router.js` 顶部有同款注释）。
 */
export function normalizeManifest(raw, options = {}) {
  const pluginDir = options.pluginDir ?? '';
  const expectedId = options.expectedId ?? '';
  const capabilityNames = options.capabilityNames ?? null;
  const warn = options.warn ?? null;
  if (!isPlainObject(raw)) fail('manifest 顶层必须是对象', { pluginDir });

  const declaredId = nonEmptyString(raw.id) ? String(raw.id).trim() : '';
  if (!declaredId) fail('缺少 id', { pluginDir });
  if (!PLUGIN_ID_PATTERN.test(declaredId)) {
    fail(`id ${declaredId} 不合法：必须以小写字母开头，只含小写字母/数字/短横线，长度 2~39`, { pluginDir });
  }
  // 目录名与 id 必须一致：状态目录、配置键都按 id 走，两者不一致会让"看到的是哪个插件"
  // 变得没法判断（也是防止同名插件互相覆盖状态）。
  if (expectedId && declaredId !== expectedId) {
    fail(`id (${declaredId}) 与插件目录名 (${expectedId}) 不一致`, { pluginDir });
  }

  if (!nonEmptyString(raw.name)) fail('缺少 name', { pluginDir });
  const name = String(raw.name).trim();
  if (name.length > MAX_NAME_LENGTH) fail(`name 超过 ${MAX_NAME_LENGTH} 字`, { pluginDir });

  if (!nonEmptyString(raw.version)) fail('缺少 version', { pluginDir });
  const version = String(raw.version).trim();
  if (!VERSION_PATTERN.test(version)) {
    fail(`version ${version} 不合法：必须是 x.y.z 形态`, { pluginDir });
  }

  // 必须先判类型再判值：`Number('1') === 1` 会把字符串 "1" 放过去，而
  // `"apiVersion": "1.0"` 这种写法（把版本号当字符串写）正是最容易出现的作者错误 ——
  // 它在 JSON 里是 string 而不是 number，静默接受等于让版本协商形同虚设。
  if (typeof raw.apiVersion !== 'number' || !Number.isInteger(raw.apiVersion)) {
    fail('apiVersion 必须是整数', { pluginDir });
  }
  const apiVersion = raw.apiVersion;
  if (apiVersion !== PLUGIN_API_VERSION) {
    fail(`apiVersion ${apiVersion} 与本宿主的 ${PLUGIN_API_VERSION} 不匹配`, { pluginDir });
  }

  const entryPath = resolveEntryPath(pluginDir, raw.entry);

  const declaredCapabilities = raw.capabilities === undefined ? [] : raw.capabilities;
  if (!Array.isArray(declaredCapabilities)) fail('capabilities 必须是数组', { pluginDir });
  const capabilities = [];
  const seenCapability = new Set();
  for (const item of declaredCapabilities) {
    if (!nonEmptyString(item)) fail('capabilities 里每一项都必须是非空字符串', { pluginDir });
    const key = String(item).trim();
    if (seenCapability.has(key)) fail(`capabilities 里重复：${key}`, { pluginDir });
    if (Array.isArray(capabilityNames) && !capabilityNames.includes(key)) {
      fail(`未知能力 ${key}（本宿主支持：${capabilityNames.join(', ')}）`, { pluginDir });
    }
    seenCapability.add(key);
    capabilities.push(key);
  }
  capabilities.sort();

  const tools = normalizeTools(raw.tools, { pluginDir, capabilityNames: capabilities });

  let description = '';
  if (raw.description !== undefined) {
    if (typeof raw.description !== 'string') fail('description 必须是字符串', { pluginDir });
    description = raw.description.trim();
    if (description.length > MAX_DESCRIPTION_LENGTH) {
      fail(`description 超过 ${MAX_DESCRIPTION_LENGTH} 字`, { pluginDir });
    }
  }

  if (typeof warn === 'function') {
    const known = new Set(MANIFEST_KNOWN_KEYS);
    const unknown = Object.keys(raw).filter((key) => !known.has(key));
    if (unknown.length) warn(`manifest 里有本宿主不认识的键（已忽略）：${unknown.join(', ')}`);
  }

  return {
    id: declaredId,
    name,
    version,
    apiVersion,
    description,
    entry: String(raw.entry).trim(),
    entryPath,
    capabilities,
    tools
  };
}

/**
 * 能力快照：审批（plugins.approved）与实际加载比对的唯一口径。
 *
 * 只放**会改变插件对宿主的影响力**的字段：版本号、能力清单、工具名清单。
 * 描述、备注、超时都不进指纹 —— 改文案不该要求管理员重新确认。
 *
 * ⚠️ 这个函数必须是**幂等**的：`manifestFingerprint(manifestFingerprint(m))` 要等于
 * `manifestFingerprint(m)`。因为控制台存下来的就是指纹对象本身，装载器拿它和当前
 * manifest 比对 —— 一次比对要能吃两种输入（完整 manifest 的 `tools:[{name}]`
 * 与指纹的 `tools:['name']`）。原先只认前者，于是指纹对象里的工具名全被读成空串、
 * 过滤后就没了，结果**每个装好的插件都停在 pending-approval**
 * （2026-10-08 写用例时抓到；这条不变量由 plugin-manifest.test.mjs 钉住）。
 */
export function manifestFingerprint(manifest = {}) {
  // 兜 null：这个函数要能安全地喂进"配置里的坏快照"，它抛错会把一次正常的插件扫描
  // 变成启动期异常（而坏快照本该只让那个插件停在 pending-approval）。
  const source = isPlainObject(manifest) ? manifest : {};
  const capabilities = Array.isArray(source.capabilities) ? [...source.capabilities] : [];
  const tools = Array.isArray(source.tools)
    ? source.tools.map((tool) => {
        if (typeof tool === 'string') return tool;
        return String(tool?.name ?? '');
      }).filter(Boolean)
    : [];
  return {
    version: String(source.version ?? ''),
    capabilities: capabilities.map(String).sort(),
    tools: tools.sort()
  };
}

/** 两个指纹是否等价。用于"审批快照是否仍然匹配当前插件"。 */
export function fingerprintMatches(approved, current) {
  const a = manifestFingerprint(approved);
  const b = manifestFingerprint(current);
  if (a.version !== b.version) return false;
  if (a.capabilities.length !== b.capabilities.length) return false;
  if (a.tools.length !== b.tools.length) return false;
  for (let i = 0; i < a.capabilities.length; i += 1) {
    if (a.capabilities[i] !== b.capabilities[i]) return false;
  }
  for (let i = 0; i < a.tools.length; i += 1) {
    if (a.tools[i] !== b.tools[i]) return false;
  }
  return true;
}
