import { pluginFetch } from './http.js';
import { readPluginSettings, pluginLogger } from './context.js';

function configAccessor(value) {
  const fn = () => value;
  Object.assign(fn, value);
  return fn;
}

function responseLike(raw) {
  const body = String(raw?.body ?? '');
  const headers = Object.freeze({ ...(raw?.headers || {}) });
  const status = Number(raw?.statusCode || 0);
  return {
    ok: status >= 200 && status < 300,
    status,
    statusCode: status,
    url: String(raw?.url || ''),
    headers,
    truncated: raw?.truncated === true,
    async text() { return body; },
    async json() { return JSON.parse(body); },
    async arrayBuffer() {
      const bytes = Buffer.from(body, 'utf8');
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    }
  };
}

function callableLog(logger) {
  const log = (...args) => logger.info(...args);
  for (const level of ['debug', 'info', 'warn', 'error']) log[level] = (...args) => logger[level](...args);
  return log;
}

export function buildMarketApi({ manifest, config = {}, log = null, registerTool }) {
  const settings = readPluginSettings({ plugins: { settings: { [manifest.id]: config } } }, manifest.id);
  const logger = pluginLogger(log, manifest);
  const api = {
    id: manifest.id,
    name: manifest.name,
    version: manifest.version,
    apiVersion: manifest.apiVersion,
    config: configAccessor(settings),
    log: callableLog(logger),
    registerTool
  };
  if (manifest.permissions.includes('web_fetch') || manifest.permissions.includes('http')) {
    api.fetch = async (url, options = {}) => responseLike(await pluginFetch(url, options));
  }
  return api;
}
