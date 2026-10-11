import { AsyncLocalStorage } from 'node:async_hooks';
import path from 'node:path';
import { setup as setupLegacy, activate as activateLegacy, deactivate as deactivateLegacy } from './legacy-index.js';

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

export async function activate(api) {
  const fetchContext = new AsyncLocalStorage();
  const bridge = {
    config: () => ({
      ...(api.config || {}),
      dataDir: api.stateDir ? path.resolve(api.stateDir, '..', '..') : '',
      downloadDir: api.config?.downloadDir || api.stateDir || ''
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
      api.registerTool({
        name,
        description: String(def.description || '').trim(),
        parameters: def.parameters || { type: 'object', properties: {} },
        async execute(toolCtx, args) {
          return fetchContext.run(toolCtx.fetch, async () => {
            const ctx = legacyContext(toolCtx);
            // 原 skill 的 before-tool 钩子负责记录指令来源，供白名单和群管理权限校验使用。
            // AsyncLocalStorage 会把本次工具的网络门面传给后台任务，避免不同会话并行下载时
            // 互相覆盖全局 fetch 上下文。
            await import('./legacy-index.js').then((mod) => mod.hooks?.['before-tool']?.(ctx));
            return def.execute(ctx, args);
          });
        }
      });
    }
  };

  setupLegacy(bridge);
  activateLegacy();
  return {
    async deactivate() {
      deactivateLegacy();
    }
  };
}
