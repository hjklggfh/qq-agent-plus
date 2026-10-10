import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { PLUGIN_ID_PATTERN, resolveEntryPath, PluginManifestError } from './manifest.js';

export const MARKET_MANIFEST_FILES = Object.freeze(['skill.json', 'plugin.json']);
export const MARKET_API_VERSION = 1;
export const MAX_MARKET_MANIFEST_BYTES = 128 * 1024;
export const MAX_MARKET_TOOLS = 64;

function fail(message, pluginDir = '') {
  throw new PluginManifestError(message, { pluginDir });
}

function plain(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function readMarketManifest(dir) {
  let file = '';
  for (const name of MARKET_MANIFEST_FILES) {
    const candidate = path.join(dir, name);
    try {
      const stat = fs.statSync(candidate);
      if (stat.isFile()) { file = candidate; break; }
    } catch { /* try the other supported name */ }
  }
  if (!file) fail('找不到 skill.json 或 plugin.json', dir);
  const stat = fs.statSync(file);
  if (stat.size > MAX_MARKET_MANIFEST_BYTES) fail(`市场清单超过 ${MAX_MARKET_MANIFEST_BYTES} 字节`, dir);
  let text = fs.readFileSync(file, 'utf8');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  try { return JSON.parse(text); } catch (error) {
    fail(`市场清单不是合法 JSON：${error?.message ?? error}`, dir);
  }
}

export function normalizeMarketManifest(raw, { dir, expectedId = '' } = {}) {
  if (!plain(raw)) fail('市场清单必须是对象', dir);
  const id = String(raw.id ?? expectedId).trim();
  if (!PLUGIN_ID_PATTERN.test(id)) fail(`非法市场扩展 id：${id}`, dir);
  if (expectedId && id !== expectedId) fail(`清单 id ${id} 与目录名 ${expectedId} 不一致`, dir);
  const name = String(raw.name ?? id).trim().slice(0, 120);
  const version = String(raw.version ?? '0.0.0').trim();
  const apiVersion = Number(raw.apiVersion ?? MARKET_API_VERSION);
  if (apiVersion !== MARKET_API_VERSION) fail(`不支持的市场 API 版本：${apiVersion}`, dir);
  const entry = String(raw.entry ?? 'index.js').trim();
  let entryPath;
  try { entryPath = resolveEntryPath(dir, entry); } catch (error) { fail(error.message, dir); }
  const rawPermissions = Array.isArray(raw.permissions) ? raw.permissions : raw.capabilities;
  const permissions = Array.isArray(rawPermissions)
    ? [...new Set(rawPermissions.map((item) => String(item).trim()).filter(Boolean))].sort()
    : [];
  const settings = plain(raw.settings) ? structuredClone(raw.settings) : {};
  const promptSections = Array.isArray(raw.prompt?.sections)
    ? raw.prompt.sections.filter((section) => plain(section) && String(section.content ?? '').trim())
      .map((section) => ({
        id: String(section.id ?? '').trim(),
        title: String(section.title ?? '').trim(),
        priority: Number.isFinite(Number(section.priority)) ? Number(section.priority) : 50,
        content: String(section.content).trim()
      })).filter((section) => section.content).slice(0, 32)
    : [];
  return {
    id, name, version, apiVersion, entry, entryPath, dir,
    category: String(raw.category ?? '').trim(),
    description: String(raw.description ?? '').trim().slice(0, 4000),
    permissions, settings, configSchema: plain(raw.configSchema) ? structuredClone(raw.configSchema) : {},
    promptSections
  };
}

export function marketManifestFingerprint(manifest = {}) {
  const stable = {
    id: String(manifest.id ?? ''),
    version: String(manifest.version ?? ''),
    apiVersion: Number(manifest.apiVersion ?? 0),
    entry: String(manifest.entry ?? ''),
    permissions: [...(manifest.permissions || [])].map(String).sort(),
    promptSections: (manifest.promptSections || []).map((item) => ({
      id: String(item.id ?? ''), title: String(item.title ?? ''),
      priority: Number(item.priority ?? 50), content: String(item.content ?? '')
    }))
  };
  const digest = crypto.createHash('sha256').update(JSON.stringify(stable)).digest('hex');
  return { ...stable, digest };
}

export function marketFingerprintMatches(approved, current) {
  if (!plain(approved)) return false;
  const currentFp = marketManifestFingerprint(current);
  if (approved.digest) return String(approved.digest) === currentFp.digest;
  const old = marketManifestFingerprint(approved);
  return old.digest === currentFp.digest;
}
