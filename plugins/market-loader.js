import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { getConfig } from '../src/core/config.js';
import { runPluginTool } from './_host/context.js';
import { mergePluginRegistry, pluginToolDefs } from './_host/registry.js';
import {
  marketFingerprintMatches, marketManifestFingerprint, normalizeMarketManifest, readMarketManifest
} from './_host/market-manifest.js';
import { buildMarketApi } from './_host/market-api.js';

export const MARKET_STATUS = Object.freeze({ LOADED: 'loaded', DISABLED: 'disabled', PENDING_APPROVAL: 'pending-approval', INVALID: 'invalid', FAILED: 'failed' });
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function plain(value) { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }
function errText(error) { return String(error?.message ?? error); }
function rootsOf(config) {
  const roots = Array.isArray(config?.plugins?.marketRoots) ? config.plugins.marketRoots : [];
  return [...new Set(roots.map((item) => String(item ?? '').trim()).filter(Boolean).map((item) => path.isAbsolute(item) ? path.normalize(item) : path.resolve(String(config?.dataDir || path.join(ROOT, 'data')), item)))];
}
function dirs(root) {
  try { return fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith('.') && !e.name.startsWith('_')).map((e) => ({ id: e.name, dir: path.join(root, e.name) })).sort((a, b) => a.id.localeCompare(b.id)); } catch { return []; }
}
function safeToolName(id, toolId) {
  const prefix = String(id).replace(/[^a-zA-Z0-9_-]/g, '_');
  const suffix = String(toolId).replace(/[^a-zA-Z0-9_-]/g, '_');
  return `${prefix}__${suffix}`.slice(0, 64);
}
function validateParameters(parameters, id) {
  if (!plain(parameters) || (parameters.type !== undefined && parameters.type !== 'object')) {
    throw new Error(`工具 ${id} 的 parameters 必须是 object JSON Schema`);
  }
  const bytes = Buffer.byteLength(JSON.stringify(parameters), 'utf8');
  if (bytes > 32 * 1024) throw new Error(`工具 ${id} 的 parameters 过大`);
}
function configFor(cfg, id, manifest) {
  const user = cfg?.plugins?.marketSettings?.[id];
  const source = plain(user) ? user : {};
  return { ...(plain(manifest.settings) ? manifest.settings : {}), ...source };
}

// 市场包经常只有 skill.json + index.js，没有 package.json。宿主本身是 ESM，
// 但 Node 会按市场目录最近的 package.json 把这个 .js 当 CommonJS；临时补一个
// package.json 只影响本次导入，导入完成后立即删除，不改写市场包内容。
function temporaryEsmPackage(dir, entryPath) {
  if (path.extname(entryPath).toLowerCase() !== '.js') return null;
  let current = path.resolve(dir);
  while (true) {
    const file = path.join(current, 'package.json');
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (parsed?.type === 'module') return null;
      if (parsed?.type === 'commonjs') break;
      // An unrelated package.json does not define the package type; continue
      // looking for a nearer explicit type before creating a local marker.
    } catch { /* no package file in this scope */ }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  const file = path.join(dir, 'package.json');
  try {
    if (fs.existsSync(file)) return null;
    fs.writeFileSync(file, JSON.stringify({ private: true, type: 'module' }), { mode: 0o600 });
    return file;
  } catch { return null; }
}

async function loadOne(item, { config, log, enabled, reserved }) {
  const base = { id: item.id, dir: item.dir, name: item.id, version: '', status: MARKET_STATUS.INVALID, reason: '', tools: [], capabilities: [] };
  let manifest;
  try { manifest = normalizeMarketManifest(readMarketManifest(item.dir), { dir: item.dir, expectedId: item.id }); } catch (error) { return { ...base, reason: errText(error) }; }
  const fp = marketManifestFingerprint(manifest);
  const meta = { ...base, name: manifest.name, version: manifest.version, description: manifest.description, capabilities: manifest.permissions, fingerprint: fp };
  if (!enabled.has(item.id)) return { ...meta, status: MARKET_STATUS.DISABLED, reason: '未在 plugins.marketEnabled 中启用' };
  if (!marketFingerprintMatches(config?.plugins?.marketApproved?.[item.id], manifest)) return { ...meta, status: MARKET_STATUS.PENDING_APPROVAL, reason: '缺少或不匹配的市场扩展审批快照' };
  const registered = new Map();
  let temporaryPackage = null;
  try {
    temporaryPackage = temporaryEsmPackage(manifest.dir, manifest.entryPath);
    const module = await import(`${pathToFileURL(manifest.entryPath).href}?qqAgentMarket=${Date.now()}`);
    if (typeof module?.setup !== 'function') throw new Error('入口没有导出 setup(api)');
    const registerTool = (def) => {
      const id = String(def?.id ?? def?.name ?? '').trim();
      if (!id || registered.has(id)) throw new Error(`工具 id 无效或重复：${id}`);
      const name = safeToolName(manifest.id, id);
      if (reserved.has(name)) throw new Error(`工具名冲突：${name}`);
      const description = String(def?.description ?? def?.name ?? id).trim();
      validateParameters(def?.parameters, id);
      if (!description) throw new Error(`工具 ${id} 缺少 description`);
      if (typeof def?.execute !== 'function') throw new Error(`工具 ${id} 缺少 execute`);
      registered.set(id, { name, description, parameters: def.parameters, handler: def.execute, category: String(def.category || manifest.category || 'market') });
    };
    const api = buildMarketApi({ manifest, config: configFor(config, manifest.id, manifest), log, registerTool });
    await module.setup(api);
    if (typeof module.available === 'function') {
      const availability = await module.available(api);
      if (availability === false || availability?.ok === false) throw new Error('市场扩展报告当前不可用');
    }
    if (!registered.size) throw new Error('setup 没有注册工具');
    for (const entry of registered.values()) reserved.add(entry.name);
    return {
      ...meta,
      status: MARKET_STATUS.LOADED,
      loadedAt: Date.now(),
      tools: [...registered.values()].map((entry) => entry.name),
      registered,
      module,
      manifest
    };
  } catch (error) { return { ...meta, status: MARKET_STATUS.FAILED, reason: `加载失败：${errText(error)}` }; }
  finally { if (temporaryPackage) { try { fs.rmSync(temporaryPackage, { force: true }); } catch { /* best effort */ } } }
}

export async function initMarketExtensions({ config = null, log = null, dataDir = '' } = {}) {
  const cfg = config ?? getConfig();
  const enabled = new Set(Array.isArray(cfg?.plugins?.marketEnabled) ? cfg.plugins.marketEnabled.map(String) : []);
  const reserved = new Set(pluginToolDefs().map((tool) => String(tool.name)));
  const statuses = [];
  const loaded = [];
  const seen = new Set();
  for (const root of rootsOf({ ...cfg, dataDir })) for (const item of dirs(root)) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    const status = await loadOne(item, { config: cfg, log, enabled, reserved });
    statuses.push(status);
    if (status.status === MARKET_STATUS.LOADED) loaded.push(status);
  }
  const defs = [];
  const summaries = [];
  for (const status of loaded) {
    for (const entry of status.registered.values()) {
      defs.push({
        name: entry.name, description: entry.description, parameters: entry.parameters,
        feature: `market:${status.id}`, pluginId: status.id, pluginName: status.name, pluginVersion: status.version,
        async execute(hostCtx, args) {
          return runPluginTool({ manifest: { id: status.id, name: status.name, version: status.version, capabilities: [] }, toolName: entry.name, handler: entry.handler, timeoutMs: 30000, hostCtx, args, dataDir, config: cfg, log });
        }
      });
    }
    summaries.push({ id: status.id, name: status.name, version: status.version, description: status.description, capabilities: status.capabilities, tools: [...status.registered.values()].map((e) => e.name), loadedAt: status.loadedAt, market: true });
  }
  mergePluginRegistry({
    toolDefs: defs,
    statuses: statuses.map(({ registered, module, manifest, ...publicStatus }) => ({ ...publicStatus, market: true })),
    plugins: summaries,
    promptSections: loaded.flatMap((status) => status.manifest.promptSections || [])
  });
  for (const status of statuses.filter((item) => item.status !== MARKET_STATUS.LOADED && item.status !== MARKET_STATUS.DISABLED)) log?.warn?.(`[market:${status.id}] ${status.status}：${status.reason}`);
  if (loaded.length) log?.info?.(`[market] 已加载 ${loaded.length} 个市场扩展（工具 ${defs.length} 个）`);
  return { roots: rootsOf({ ...cfg, dataDir }), statuses, toolDefs: defs, plugins: summaries };
}
