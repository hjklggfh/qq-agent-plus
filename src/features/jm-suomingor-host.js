import path from 'node:path';

import { activate as activateJm } from './jm-suomingor/index.js';
import { promptSections as jmPromptSections, isChatAllowed as jmChatAllowed, configuredJmGroups } from './jm-suomingor/legacy-index.js';
import { registerBuiltinFeature } from './feature-registry.js';

const ALLOWED_ONEBOT_CALLS = new Set([
  'upload_group_file', 'upload_private_file', 'get_group_file_system_info',
  'get_group_root_files', 'delete_group_file', 'get_group_member_info',
  'get_group_info'
]);

let initialized = false;
let deactivation = null;
let runtimeState = null;
let featureHandleMessage = null;
let featureIsDirectMessage = null;

function responseFromFetch(response, url) {
  return response.arrayBuffer().then((bytes) => ({
    statusCode: response.status,
    url: response.url || url,
    headers: Object.fromEntries(response.headers || []),
    body: Buffer.from(bytes)
  }));
}

function scopedOnebot(onebot, chatKey) {
  const [kind, id] = String(chatKey || '').split(':');
  const ensureGroup = (params = {}) => {
    if (kind !== 'group' || String(params.group_id ?? '') !== id) {
      throw new Error('JM OneBot 操作只能作用于当前群');
    }
  };
  return {
    async call(action, params = {}, timeoutMs) {
      const name = String(action || '');
      if (!ALLOWED_ONEBOT_CALLS.has(name)) throw new Error(`JM 不允许调用 OneBot 方法：${name}`);
      if (name === 'upload_private_file') {
        if (kind !== 'private' || String(params.user_id ?? '') !== id) {
          throw new Error('JM 私聊文件只能发送到当前私聊');
        }
      } else {
        ensureGroup(params);
      }
      return onebot.call(name, params, timeoutMs);
    },
    async sendSegments(targetKind, targetId, segments) {
      if (String(targetKind) !== kind || String(targetId) !== id) {
        throw new Error('JM 消息只能发送到当前会话');
      }
      if (!Array.isArray(segments) || segments.length > 20) throw new Error('JM 消息段数量超限');
      for (const segment of segments) {
        if (!['text', 'image', 'file'].includes(String(segment?.type || ''))) {
          throw new Error(`JM 不允许发送消息段：${segment?.type || ''}`);
        }
      }
      return onebot.sendSegments(kind, id, segments);
    }
  };
}

function hostToolContext(ctx, runtime) {
  const chatKey = String(ctx?.chatKey || '');
  const sender = runtime.sender;
  return {
    ...ctx,
    sessionId: ctx?.session?.id || '',
    fetch: runtime.fetch,
    send: async (messages) => {
      const list = Array.isArray(messages) ? messages : [messages];
      const result = await sender.sendTextBatch(chatKey, list, {
        runId: ctx?.session?.leaseId,
        signal: ctx?.signal,
        preserveCode: false
      });
      return {
        sent: Array.isArray(result?.sent) ? result.sent.length : 0,
        failed: Array.isArray(result?.failed) ? result.failed.length : 0
      };
    },
    forward: async (nodes, label = '') => sender.forward(chatKey, { nodes, label }, {
      runId: ctx?.session?.leaseId,
      signal: ctx?.signal
    }),
    onebot: scopedOnebot(runtime.onebot, chatKey)
  };
}

/**
 * 初始化 JM 宿主内置功能。
 *
 * 工具仍然复用原 skill 的实现，但注册在内置工具表中，不经过插件目录、
 * plugins.enabled 或能力审批。配置从顶层 config.jm 读取。
 */
export function initJmFeature({ dataDir, getConfig, onebot, sender, log = console } = {}) {
  if (initialized && runtimeState) {
    runtimeState.dataDir = String(dataDir || '');
    runtimeState.getConfig = getConfig || (() => ({}));
    runtimeState.onebot = onebot;
    runtimeState.sender = sender;
    return { handleMessage: featureHandleMessage, isDirectMessage: featureIsDirectMessage, deactivate: deactivation, isChatAllowed: jmChatAllowed, configuredGroups: configuredJmGroups };
  }
  initialized = true;

  const runtime = {
    dataDir: String(dataDir || ''),
    getConfig: getConfig || (() => ({})),
    onebot,
    sender,
    fetch: async (url, options = {}) => {
      const { responseType: _responseType, ...requestInit } = options || {};
      const response = await fetch(url, requestInit);
      return responseFromFetch(response, url);
    }
  };
  runtimeState = runtime;
  const defs = [];
  const logInfo = typeof log === 'function' ? log : (...args) => console.info(...args);
  const logWarn = typeof log === 'function' ? log : (...args) => console.warn(...args);
  const api = {
    config: () => ({
      ...(runtime.getConfig()?.jm || {}),
      dataDir: runtime.dataDir,
      downloadDir: path.join(runtime.dataDir, 'plugin-state', 'jm-suomingor')
    }),
    stateDir: path.join(runtime.dataDir, 'plugin-state', 'jm-suomingor'),
    fetch: runtime.fetch,
    log: { info: logInfo, warn: logWarn },
    registerTool(def) {
      const name = String(def.name || '').trim();
      if (!name) throw new Error('JM 内置工具缺少名称');
      defs.push({
        name,
        feature: 'jm',
        description: String(def.description || '').trim(),
        parameters: def.parameters || { type: 'object', properties: {} },
        async execute(ctx, args) {
          return def.execute(hostToolContext(ctx, runtime), args);
        }
      });
    }
  };

  const activated = activateJm(api);
  featureHandleMessage = (ctx, message) => activated?.handleMessage?.(hostToolContext(ctx, runtime), message);
  featureIsDirectMessage = (message) => activated?.isDirectMessage?.(message) === true;
  deactivation = async () => {
    await activated?.deactivate?.();
    initialized = false;
    runtimeState = null;
    deactivation = null;
    featureHandleMessage = null;
    featureIsDirectMessage = null;
    registerBuiltinFeature({ toolDefs: [], promptSections: [] });
  };
  registerBuiltinFeature({
    toolDefs: defs,
    // 关闭时连提示词一起摘掉，避免模型在功能关闭后仍尝试调用 JM 工具。
    promptSections: runtime.getConfig()?.jm?.enabled === false ? [] : jmPromptSections()
  });
  return {
    handleMessage: featureHandleMessage,
    isDirectMessage: featureIsDirectMessage,
    deactivate: deactivation,
    isChatAllowed: jmChatAllowed,
    configuredGroups: configuredJmGroups
  };
}

