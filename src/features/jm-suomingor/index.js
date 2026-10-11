import { AsyncLocalStorage } from 'node:async_hooks';
import path from 'node:path';
import { setup as setupLegacy, activate as activateLegacy, deactivate as deactivateLegacy } from './legacy-index.js';
import { handleMessage as handleLegacyMessage, dispose as disposeLegacy } from './legacy-index.js';
import { classifyJmDirectCommand } from './direct-command.js';

const TOOL_PREFIX = 'jm_';

function responseFromHost(result, fallbackUrl) {
  const body = Buffer.isBuffer(result?.body)
    ? result.body
    : result?.body instanceof Uint8Array
      ? Buffer.from(result.body)
      : Buffer.from(String(result?.body ?? ''), 'utf8');
  return {
    status: Number(result?.statusCode) || 0,
    url: String(result?.url || fallbackUrl || ''),
    headers: result?.headers || {},
    async arrayBuffer() {
      return body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength);
    },
    async text() {
      return body.toString('utf8');
    }
  };
}

function legacyContext(toolCtx) {
  const sender = {
    async sendTextBatch(chatKey, messages) {
      if (String(chatKey) !== String(toolCtx.chatKey)) throw new Error('JM 只能发送到当前会话');
      const list = Array.isArray(messages) ? messages : [messages];
      const result = await toolCtx.send(list);
      return { sent: result?.sent ? list.slice(0, result.sent).map((text) => ({ text })) : [], failed: result?.failed || 0 };
    }
  };
  return {
    ...toolCtx,
    sessionId: toolCtx.session?.id || '',
    triggerEntries: Array.isArray(toolCtx.triggerEntries) ? toolCtx.triggerEntries : [],
    sender,
    onebot: toolCtx.onebot || null,
  };
}

export function activate(api) {
  const fetchContext = new AsyncLocalStorage();
  const toolRunners = new Map();
  const readConfig = () => (typeof api.config === 'function' ? api.config() : (api.config || {}));
  const bridge = {
    config: () => ({
      ...readConfig(),
      dataDir: readConfig().dataDir || (api.stateDir ? path.resolve(api.stateDir, '..', '..') : ''),
      downloadDir: readConfig().downloadDir || api.stateDir || ''
    }),
    fetch: async (url, options = {}) => {
      const toolFetch = fetchContext.getStore();
      if (typeof toolFetch !== 'function') throw new Error('JM 网络请求只能在工具执行期间使用');
      const result = await toolFetch(url, { ...options, responseType: 'bytes' });
      return responseFromHost(result, url);
    },
    log: (...args) => api.log.info(...args),
    warn: (...args) => api.log.warn(...args),
    registerTool(def) {
      const name = `${TOOL_PREFIX}${String(def.id || '').trim()}`;
      const runner = async (toolCtx, args) => fetchContext.run(toolCtx.fetch, async () => {
        const ctx = legacyContext(toolCtx);
        await import('./legacy-index.js').then((mod) => mod.hooks?.['before-tool']?.(ctx));
        return def.execute(ctx, args);
      });
      toolRunners.set(name, runner);
      api.registerTool({
        name,
        description: String(def.description || '').trim(),
        parameters: def.parameters || { type: 'object', properties: {} },
        async execute(toolCtx, args) { return runner(toolCtx, args); }
      });
    }
  };

  setupLegacy(bridge);
  activateLegacy();
  return {
    async handleMessage(toolCtx, message) {
      const directCtx = { ...toolCtx, triggerEntries: [{ ...message, self: false }] };
      const direct = classifyJmDirectCommand(message?.text);
      const directTool = (name, args = {}) => {
        const runner = toolRunners.get(name);
        return runner ? runner(directCtx, args) : null;
      };
      if (direct?.tool) {
        const result = await directTool(direct.tool, direct.args);
        if (result?.isError && result.content) await toolCtx.send([String(result.content)]);
        return true;
      }
      return handleLegacyMessage({
        ...legacyContext(directCtx),
        runTool: async (name, args) => {
          const runner = toolRunners.get(String(name));
          if (!runner) throw new Error(`JM 工具不存在：${name}`);
          return runner(directCtx, args);
        }
      }, message);
    },
    async deactivate() {
      deactivateLegacy();
      disposeLegacy();
    }
  };
}
