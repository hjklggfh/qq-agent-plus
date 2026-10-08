// 插件运行时门面：把宿主的原始 ctx 按 manifest 声明的能力**收窄**成插件能看到的那一份。
//
// 这是整套设计里最要紧的一段。宿主给内置工具的 ctx（orchestrator.js 里那个对象）带着
// sender / store / memory / onebot / session / emit —— 那是全权限。插件**永远拿不到它**，
// 只会拿到这里按 capability 现拼的对象：
//
//   capabilities 里没写的能力，门面上**根本不存在那个属性**（不是"存在但会报错"）。
//   插件写了 http 却只声明了 storage，它在 `toolCtx.fetch` 上是 undefined，
//   第一次调用就 TypeError 并作为工具错误回到模型 —— 而不是静默获得能力。
//
// 另外两条刻意的收窄（都写在 docs/PLUGINS.md 里当契约）：
//   ① send() 只接受 messages，不支持 replyToMessageId/atUserId。内置 send_message 的
//      目标校验（messageTargetError，tools-core.js:252）是模块私有的，抄一份就会出现
//      第二份口径 —— 而它守的正是"回复/上级到别的会话"这类事故。等它被导出再开放。
//   ② session 只给 {id, rounds} 快照，不给活的 session 对象：那是宿主的状态机，
//      插件改它等于绕过额度、审计与发送记账。
import fs from 'node:fs';
import path from 'node:path';
import { normalizeMessageList } from '../../src/core/util.js';
import { SECRET_KEY_EXCLUDE, SECRET_KEY_PATTERN } from '../../src/core/secret-keys.js';
import { validateImageUrl } from '../../src/llm/safe-fetch.js';
import { pluginFetch } from './http.js';
import { PluginKvStore, pluginStateDir } from './storage.js';

export const DEFAULT_RECENT_LIMIT = 20;
export const MAX_RECENT_LIMIT = 100;
export const MAX_SEND_MESSAGES = 5;
export const MAX_SEND_TEXT_LENGTH = 3000;
export const MAX_RESULT_BYTES = 64 * 1024;
/** 插件能发的单张图片上限。与内置链路读图的量级一致（safeFetchBinary 默认 12MB）。 */
export const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
/** 一条合并转发里最多几"条"（每个条目在卡片里是一个气泡）。 */
// 合并转发包含一个说明文字节点；允许最多 20 张图 + 1 个文字节点。
export const MAX_FORWARD_ITEMS = 21;
/** 合并转发里图片的**合计**上限：一条转发里的图会一起进同一个请求体，逐张各 12MB 会失控。 */
// 16MB 二进制图片合计给 base64/JSON 和 OneBot WebSocket 留出余量；插件默认只用 8MB。
export const MAX_FORWARD_BYTES = 16 * 1024 * 1024;
export const SECRET_NAME_PATTERN = /^[a-zA-Z0-9_.-]{1,64}$/;

/** 审计用的凭据容器名（与 secret-keys.js 的 SECRET_CONTAINER 同口径）。 */
const SECRET_CONTAINER = /^(keys|providerkeys|ttskeys)$/i;

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function secretKeyName(key) {
  if (/^has[A-Z]/.test(key)) return false;
  if (SECRET_KEY_EXCLUDE.test(key)) return false;
  return SECRET_KEY_PATTERN.test(key) || SECRET_CONTAINER.test(key);
}

/**
 * 发送**之后**的记账（进 session.sent + 广播 session-update），失败绝不上抛。
 *
 * 与内置工具的 `afterSent()`（tools-core.js）同一条原则，也是这个仓库复审里修过两次的那类
 * bug：消息**已经送达**之后，记账抛错不能改判成"发送失败" —— 那会让模型以为没发出去而重发，
 * 群里就多一条一模一样的内容。
 */
function afterDelivered(hostCtx, session, entry) {
  try {
    if (Array.isArray(session?.sent)) {
      session.sent.push(entry);
      if (typeof hostCtx.emit === 'function') hostCtx.emit('session-update', session.id);
    }
  } catch (error) {
    console.warn('[plugin] 消息已送达但会话记账失败（该条仍算已发出）:', error?.message ?? error);
  }
}

/**
 * 插件自己那一段设置（`plugins.settings.<id>`）的**非密钥**视图。
 *
 * 密钥类字段整条删除（不留空串）：插件拿到的是一份可以随便改的副本，
 * 里面不该有凭据 —— 要凭据得走 `secret(name)`（需要 secrets 能力），
 * 这样"插件读了密钥"这件事在能力清单上是可见的。
 */
export function readPluginSettings(config = {}, pluginId = '') {
  const id = String(pluginId ?? '');
  const section = config?.plugins?.settings;
  const raw = isPlainObject(section) ? section[id] : null;
  if (!isPlainObject(raw)) return {};
  const clone = JSON.parse(JSON.stringify(raw));
  const walk = (node) => {
    if (!isPlainObject(node)) return;
    for (const key of Object.keys(node)) {
      if (secretKeyName(key)) { delete node[key]; continue; }
      const value = node[key];
      if (isPlainObject(value)) walk(value);
      else if (Array.isArray(value)) {
        for (const item of value) if (isPlainObject(item)) walk(item);
      }
    }
  };
  walk(clone);
  return clone;
}

/**
 * 列出插件设置里**凭据类的字段名**（只给名字，绝不给值）。
 *
 * 给控制台显示"这个插件配过哪些凭据"用。名字本身不是秘密 —— `/api/config` 下发的也是
 * 名字 + `hasXxx` 布尔（`sanitizeConfigSecrets` 的口径），这里与它保持一致：
 * 让运维看得见"凭据配了没有"，同时一个字符的明文都不出宿主进程。
 *
 * 只扫一层：`plugins.settings.<id>` 是给人写的扁平配置，凭据就该是顶层键
 * （`readPluginSecret` 也只认顶层键，两处口径必须一致，否则会出现"列得出来却读不到"）。
 */
export function pluginSecretFieldNames(config = {}, pluginId = '') {
  const id = String(pluginId ?? '');
  const section = config?.plugins?.settings;
  const raw = isPlainObject(section) ? section[id] : null;
  if (!isPlainObject(raw)) return [];
  return Object.keys(raw).filter((key) => secretKeyName(key)).sort();
}

/**
 * 读取插件自己的某个凭据（需要 secrets 能力）。
 *
 * 只解析 `plugins.settings.<id>.<name>` 这一个**拍平**的键：不接受 `a.b` 这种路径，
 * 免得"名字里带点"变成穿透到别的插件/宿主的入口。找不到返回空串（不是 null），
 * 让插件写成"没配就报错"而不是"undefined 拼进 URL"。
 */
export function readPluginSecret(config = {}, pluginId = '', name = '') {
  const id = String(pluginId ?? '');
  const key = String(name ?? '');
  if (!SECRET_NAME_PATTERN.test(key)) {
    throw new Error(`凭据名不合法：${JSON.stringify(name)}（只允许字母/数字/下划线/点/短横线，长度 1~64）`);
  }
  if (key.includes('.')) {
    throw new Error(`凭据名不能含点号：${key}（凭据是 plugins.settings.${id} 下的顶层键）`);
  }
  if (secretKeyName(key) !== true) {
    // 这条守卫不是洁癖，它是有承重的：宿主的脱敏（core/secret-keys.js 的
    // sanitizeConfigSecrets / redactSecretFields）**按字段名**判定要不要抹掉值。
    // 如果这里放行一个名字不含关键词的字段，插件就能读出（而控制台的 /api/config 也会
    // 原样回显）一个明文凭据 —— 那是运维根本没打算交出去的东西。
    // 所以要求是"要么把字段名起成凭据样（apiKey / token / apiSecret / password…），
    // 要么走 api.config 读非凭据设置"。
    throw new Error(
      `凭据名「${key}」不像凭据字段：宿主的脱敏按字段名生效，名字不含 `
      + 'apikey / api_key / token / secret / password / authorization / cookie / bearer 的字段会明文下发到控制台。'
      + `请把 plugins.settings.${id} 里的这个字段改名成凭据样（例如 apiKey），`
      + '非凭据的设置走 api.config。'
    );
  }
  const section = config?.plugins?.settings;
  const raw = isPlainObject(section) ? section[id] : null;
  if (!isPlainObject(raw)) return '';
  const value = raw[key];
  return value === undefined || value === null ? '' : String(value);
}

function pluginLogger(baseLog, manifest) {
  const scope = `plugin:${manifest.id}`;
  const fallback = () => {};
  if (!baseLog || typeof baseLog !== 'object') {
    return { debug: fallback, info: fallback, warn: fallback, error: fallback };
  }
  // 走宿主 logger 的四个级别，但每条都带上插件 id：日志里要能一眼看出是哪个插件在说话。
  const wrap = (level) => (typeof baseLog[level] === 'function'
    ? (...args) => baseLog[level](`[${scope}]`, ...args)
    : fallback);
  return {
    debug: wrap('debug'),
    info: wrap('info'),
    warn: wrap('warn'),
    error: wrap('error')
  };
}

/** 插件工具名 → 插件自己的 logger（manager 在装载期缓存一份，避免每轮重建）。 */
export { pluginLogger };

/**
 * 构造交给 `activate(api)` 的 api 对象。
 *
 * registerTool 只收集，不注入 —— 收集完由 manager 与 manifest.tools 做**集合相等**校验，
 * 不一致就整个插件拒绝加载。这样"manifest 里声明的工具"就是模型真正会看到的工具，
 * 控制台展示的能力/工具快照才有意义。
 */
export function buildPluginApi({
  manifest,
  config = {},
  dataDir = '',
  log = null,
  registerTool = null
} = {}) {
  const capabilities = Object.freeze([...(manifest.capabilities || [])]);
  const api = {
    id: manifest.id,
    name: manifest.name,
    version: manifest.version,
    apiVersion: manifest.apiVersion,
    capabilities,
    log: pluginLogger(log, manifest),
    config: readPluginSettings(config, manifest.id),
    registerTool: typeof registerTool === 'function' ? registerTool : () => {}
  };
  if (capabilities.includes('storage')) {
    api.kv = new PluginKvStore({ dataDir, pluginId: manifest.id });
    api.stateDir = api.kv.stateDir;
  }
  if (capabilities.includes('secrets')) {
    api.secret = (name) => readPluginSecret(config, manifest.id, name);
  }
  return api;
}

/**
 * 构造交给插件工具的 toolCtx。
 *
 * 每个字段的存在性都由 manifest.capabilities 决定；未声明的能力连属性都没有。
 */
export function buildPluginToolContext({
  manifest,
  hostCtx = {},
  config = {},
  dataDir = '',
  log = null,
  signal = null
} = {}) {
  const capabilities = manifest.capabilities || [];
  const toolCtx = {
    // ── 总是可见：只读的会话标识与本次运行的取消信号 ──
    pluginId: manifest.id,
    pluginName: manifest.name,
    pluginVersion: manifest.version,
    capabilities: Object.freeze([...capabilities]),
    chatKey: String(hostCtx.chatKey ?? ''),
    kind: String(hostCtx.kind ?? ''),
    chatId: String(hostCtx.chatId ?? ''),
    selfId: String(hostCtx.selfId ?? ''),
    selfNickname: String(hostCtx.selfNickname ?? ''),
    botName: String(hostCtx.botName ?? ''),
    signal: signal ?? hostCtx.signal ?? null,
    log: pluginLogger(log, manifest),
    // 快照，不是活对象：插件改它不影响宿主的状态机（见文件头 ②）。
    session: Object.freeze({
      id: String(hostCtx.session?.id ?? ''),
      rounds: Number(hostCtx.session?.rounds) || 0
    })
  };

  if (capabilities.includes('chat:send')) {
    const sender = hostCtx.sender;
    const session = hostCtx.session;
    const chatKey = String(hostCtx.chatKey ?? '');
    toolCtx.send = async (messages, options = {}) => {
      if (!sender || typeof sender.sendTextBatch !== 'function') {
        throw new Error('宿主发送队列不可用');
      }
      // 明确报错而不是静默忽略：插件作者写了 atUserId 却没生效，是那种"看起来工作了"的
      // 最难查的偏差（见文件头 ①，目标校验目前是 tools-core 私有的）。
      if (options.replyToMessageId !== undefined || options.atUserId !== undefined) {
        throw new Error('插件的 send() 暂不支持 replyToMessageId/atUserId；需要在同一会话内引用/@ 时请改用内置工具');
      }
      const list = normalizeMessageList(messages)
        .slice(0, MAX_SEND_MESSAGES)
        .map((text) => String(text).slice(0, MAX_SEND_TEXT_LENGTH));
      if (!list.length) throw new Error('消息内容为空');
      // chatKey 由宿主绑死：插件无法把消息发到别的会话（这是 chat:send 最要紧的一条约束）。
      const result = await sender.sendTextBatch(chatKey, list, {
        runId: session?.leaseId,
        signal: toolCtx.signal,
        preserveCode: false
      });
      // 与内置 send_message 同一套记账：不记账的话控制台会话视图与"我发过什么"会与
      // 模型看到的上下文分叉（内置工具也在这里 push + 广播 session-update）。
      if (Array.isArray(result?.sent)) {
        for (const item of result.sent) {
          afterDelivered(hostCtx, session, { type: 'text', text: item.text, at: item.at });
        }
      }
      return {
        sent: Array.isArray(result?.sent) ? result.sent.length : 0,
        failed: Array.isArray(result?.failed) ? result.failed.length : 0
      };
    };
  }

  if (capabilities.includes('chat:send-image')) {
    const sender = hostCtx.sender;
    const session = hostCtx.session;
    const chatKey = String(hostCtx.chatKey ?? '');
    // 路径守卫要用状态目录做包含判定，所以在这里独立算一次（不依赖下面 storage 块的先后）。
    const ownDir = pluginStateDir(dataDir, manifest.id);
    toolCtx.sendImage = async (source, options = {}) => {
      if (!sender || typeof sender.image !== 'function') throw new Error('宿主发送队列不可用');
      if (!isPlainObject(source)) throw new Error('sendImage 需要 { path } 或 { url }');
      // 与 send() 同一口径：目标校验（replyToMessageId/atUserId 是否属于本会话）是内置工具
      // 私有的，抄一份就会出现第二份口径 —— 明确报错，而不是静默忽略。
      if (options.replyToMessageId !== undefined || options.atUserId !== undefined) {
        throw new Error('插件的 sendImage() 暂不支持 replyToMessageId/atUserId；需要引用/@ 时请改用内置工具');
      }
      let url = '';
      let bytes = 0;
      if (typeof source.path === 'string' && source.path.trim()) {
        if (!capabilities.includes('storage')) {
          throw new Error('用 { path } 发图需要同时声明 storage 能力（图片必须放在插件自己的状态目录里）');
        }
        const abs = path.resolve(String(source.path).trim());
        let realDir = '';
        try { realDir = fs.realpathSync(ownDir); } catch { throw new Error(`插件状态目录还不存在：${ownDir}`); }
        let real = '';
        try { real = fs.realpathSync(abs); } catch { throw new Error(`图片文件不存在：${abs}`); }
        const rel = path.relative(realDir, real);
        // ⚠️ 这条守卫是硬要求：不限制目录的话，插件可以把宿主的任意文件当"图片"发到群里
        //（最直接的例子就是 data/config.json —— 里面有明文 API Key 与控制台令牌）。
        if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
          throw new Error(`sendImage 只接受插件自己状态目录里的文件：${abs} 不在 ${realDir} 之内`);
        }
        const stat = fs.statSync(real);
        if (!stat.isFile()) throw new Error(`不是普通文件：${real}`);
        if (stat.size > MAX_IMAGE_BYTES) {
          throw new Error(`图片超过 ${MAX_IMAGE_BYTES} 字节上限（实际 ${stat.size}）`);
        }
        bytes = stat.size;
        // base64:// 是本地图片的既有约定（内置表情那条路用的就是它）。
        url = `base64://${fs.readFileSync(real).toString('base64')}`;
      } else if (typeof source.url === 'string' && source.url.trim()) {
        const raw = String(source.url).trim();
        // 与内置表情发送远程图同一道守卫：只收公网 http(s)，拒绝内网/本机与非法协议。
        await validateImageUrl(raw);
        url = raw;
      } else {
        throw new Error('sendImage 需要 { path }（状态目录内的文件）或 { url }（公网图片地址）');
      }
      const result = await sender.image(chatKey, {
        url,
        bytes,
        label: String(options.label ?? '')
      }, {
        runId: session?.leaseId,
        signal: toolCtx.signal
      });
      afterDelivered(hostCtx, session, {
        type: 'image',
        text: `[图片${bytes ? `:${Math.max(1, Math.round(bytes / 1024))}KB` : ''}]`,
        at: new Date().toLocaleTimeString('zh-CN', { hour12: false })
      });
      return { sent: true, messageId: result?.message_id ?? null, bytes };
    };
  }

  if (capabilities.includes('chat:send-forward')) {
    const sender = hostCtx.sender;
    const session = hostCtx.session;
    const chatKey = String(hostCtx.chatKey ?? '');
    const ownDir = pluginStateDir(dataDir, manifest.id);
    let realDir = '';
    /**
     * 把若干条内容打包成**一条**「聊天记录」发出去 —— 群聊里多张图不再刷屏。
     *
     * 条目形状与 sendImage 完全同一套：`{ text }` / `{ path }` / `{ url }`。
     * 每个条目在卡片里是**一个气泡**（所以每条一个 node，而不是全塞进一个 node）——
     * 那才是"聊天记录"该有的样子；全塞一个 node 的话只有一个气泡里堆四张图。
     *
     * ⚠️ `{ path }` 沿用与 sendImage **逐字相同**的路径守卫（realpath 后判包含）：不设这条，
     * 插件就能把 data/config.json（含明文凭据）当"聊天记录里的一张图"发到群里。
     * ⚠️ node 的显示名/QQ 号由**宿主**填死，插件不能借这个能力伪装成别人说话。
     */
    toolCtx.sendForward = async (options = {}) => {
      if (!sender || typeof sender.forward !== 'function') {
        throw new Error('这个宿主版本还不支持合并转发（发送队列里没有 forward）');
      }
      if (!isPlainObject(options)) throw new Error('sendForward 需要 { items: [...] }');
      // 与 sendImage 同一口径：转发动作本身不接受引用/@，明确报错而不是静默忽略。
      if (options.replyToMessageId !== undefined || options.atUserId !== undefined) {
        throw new Error('插件的 sendForward() 不支持 replyToMessageId/atUserId；需要引用/@ 时请改用内置工具');
      }
      const items = Array.isArray(options.items) ? options.items : [];
      if (!items.length) throw new Error('sendForward 至少要有一条内容');
      if (items.length > MAX_FORWARD_ITEMS) {
        throw new Error(`合并转发最多 ${MAX_FORWARD_ITEMS} 条（实际 ${items.length}）`);
      }
      const nodes = [];
      let bytes = 0;
      for (const item of items) {
        if (!isPlainObject(item)) {
          throw new Error('sendForward 的每条内容都要是对象：{ text } / { path } / { url }');
        }
        let segment = null;
        if (typeof item.text === 'string' && item.text.trim()) {
          segment = { type: 'text', data: { text: String(item.text).slice(0, MAX_SEND_TEXT_LENGTH) } };
        } else if (typeof item.path === 'string' && item.path.trim()) {
          if (!capabilities.includes('storage')) {
            throw new Error('用 { path } 发图需要同时声明 storage 能力（图片必须放在插件自己的状态目录里）');
          }
          if (!realDir) {
            try { realDir = fs.realpathSync(ownDir); } catch { throw new Error(`插件状态目录还不存在：${ownDir}`); }
          }
          const abs = path.resolve(String(item.path).trim());
          let real = '';
          try { real = fs.realpathSync(abs); } catch { throw new Error(`图片文件不存在：${abs}`); }
          const rel = path.relative(realDir, real);
          if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
            throw new Error(`sendForward 只接受插件自己状态目录里的文件：${abs} 不在 ${realDir} 之内`);
          }
          const stat = fs.statSync(real);
          if (!stat.isFile()) throw new Error(`不是普通文件：${real}`);
          if (stat.size > MAX_IMAGE_BYTES) {
            throw new Error(`图片超过 ${MAX_IMAGE_BYTES} 字节上限（实际 ${stat.size}）`);
          }
          bytes += stat.size;
          if (bytes > MAX_FORWARD_BYTES) {
            throw new Error(`合并转发里的图片合计超过 ${MAX_FORWARD_BYTES} 字节上限`);
          }
          segment = { type: 'image', data: { file: `base64://${fs.readFileSync(real).toString('base64')}` } };
        } else if (typeof item.url === 'string' && item.url.trim()) {
          const raw = String(item.url).trim();
          // 与内置表情发远程图同一道守卫：只收公网 http(s)，拒绝内网/本机与非法协议。
          await validateImageUrl(raw);
          segment = { type: 'image', data: { file: raw } };
        } else {
          throw new Error('sendForward 的每条内容需要 { text }、{ path }（状态目录内的文件）或 { url }（公网图片地址）');
        }
        nodes.push({
          type: 'node',
          data: {
            // 显示名统一由宿主填：插件无法伪装成别人（这是"聊天记录"这类卡片最容易出问题的地方）
            name: String(hostCtx.selfNickname || hostCtx.botName || '机器人').slice(0, 40),
            uin: String(hostCtx.selfId ?? ''),
            content: [segment]
          }
        });
      }
      const result = await sender.forward(chatKey, {
        nodes,
        label: String(options.label ?? '')
      }, {
        runId: session?.leaseId,
        signal: toolCtx.signal
      });
      afterDelivered(hostCtx, session, {
        type: 'forward',
        text: `[聊天记录:${nodes.length} 条]`,
        at: new Date().toLocaleTimeString('zh-CN', { hour12: false })
      });
      return { sent: true, messageId: result?.message_id ?? null, count: nodes.length };
    };
  }

  if (capabilities.includes('chat:read')) {
    const store = hostCtx.store;
    const chatKey = String(hostCtx.chatKey ?? '');
    toolCtx.recent = (limit = DEFAULT_RECENT_LIMIT) => {
      if (!store || typeof store.recent !== 'function') throw new Error('宿主消息存储不可用');
      const want = Math.min(MAX_RECENT_LIMIT, Math.max(1, Number(limit) || DEFAULT_RECENT_LIMIT));
      const entries = store.recent(chatKey, { limit: want }) || [];
      // 只给文本与发言人标识：不给图片二进制、不给别的会话、不给翻页游标。
      return entries.map((entry) => ({
        id: entry?.id ?? null,
        mid: entry?.mid ?? null,
        at: Number(entry?.ts) || 0,
        senderId: String(entry?.senderId ?? ''),
        senderName: String(entry?.senderName ?? ''),
        self: entry?.self === true,
        text: String(entry?.text ?? '')
      }));
    };
  }

  if (capabilities.includes('storage')) {
    toolCtx.kv = new PluginKvStore({ dataDir, pluginId: manifest.id });
    toolCtx.dir = toolCtx.kv.stateDir;
  }

  if (capabilities.includes('http')) {
    toolCtx.fetch = (url, options = {}) => pluginFetch(url, {
      ...options,
      signal: options.signal ?? toolCtx.signal ?? undefined
    });
  }

  if (capabilities.includes('secrets')) {
    toolCtx.secret = (name) => readPluginSecret(config, manifest.id, name);
  }

  return toolCtx;
}

function normalizeToolResult(raw) {
  if (typeof raw === 'string') return { content: raw };
  if (isPlainObject(raw)) {
    if (typeof raw.content === 'string') {
      // 与内置工具**逐字同一份契约**：成功时不带 isError 字段（tools-core 的 `ok()` 就是
      // `{ content }`），只有失败才带 `isError: true`。若成功也写 `isError: false`，会话留档与
      // 审计里就会多出一个内置工具没有的字段 —— 而"插件工具与内置工具同形"是这套系统刻意
      // 维持的性质（编排器、实验调度器、控制台都按同一形状读结果）。
      return raw.isError === true
        ? { content: raw.content, isError: true }
        : { content: raw.content };
    }
    // `{error: '...'}` 是最自然的写法，直接认；其余形态一律按作者写错了报出去，
    // 而不是把 undefined 塞进上下文让模型看到一条空结果。
    if (typeof raw.error === 'string') return { content: raw.error, isError: true };
  }
  return {
    content: '插件工具返回值不合法：必须是字符串，或 { content: string, isError?: boolean }。',
    isError: true,
    errorCode: 'PLUGIN_TOOL_BAD_RESULT'
  };
}

function capResultContent(result) {
  const bytes = Buffer.byteLength(result.content, 'utf8');
  if (bytes <= MAX_RESULT_BYTES) return result;
  const keep = Math.max(0, Math.floor(MAX_RESULT_BYTES / 2));
  return {
    ...result,
    content: `${result.content.slice(0, keep)}\n（插件返回内容超过 ${MAX_RESULT_BYTES} 字节，已截断）`,
    truncated: true
  };
}

/**
 * 执行一个插件工具。
 *
 * 由 loader.js 在装载期把 handler/超时/manifest 都绑好，注册表里存的是这个包装；
 * 于是宿主（tools-core 的 executeTool）走的是与内置工具**完全相同**的一条路径：
 * 按名查表 → 解析 JSON 参数（含容错修复）→ 与 ctx.signal 竞速 → 返回 { content, isError }。
 *
 * 超时：Promise.race 只能"不再等它"，**没法强杀**插件里的同步/未响应取消的异步工作。
 * 所以 toolCtx.signal 会在超时时被 abort，插件应当据此收尾；文档里把这条写明，
 * 不假装宿主能终止第三方代码。
 *
 * ⚠️ 形参写成 `options` + 逐个显式取别名，**不是**解构参数。原因是 `src/ops.js` 的
 * 未定义调用扫描器不认识解构参数，会把 `handler(...)` 报成"可疑未定义调用"，
 * 而 CI 门禁 `ops scan --strict` 会因此判红（`src/console/router.js` 顶部有同款注释，
 * "显式取别名而不是解构参数"是本仓既有的让路写法）。
 */
export async function runPluginTool(options = {}) {
  const manifest = options.manifest;
  const toolName = options.toolName;
  const handler = options.handler;
  const timeoutMs = options.timeoutMs;
  const hostCtx = options.hostCtx ?? {};
  const args = options.args ?? {};
  const config = options.config ?? {};
  const dataDir = options.dataDir ?? '';
  const log = options.log ?? null;
  const parentSignal = hostCtx.signal ?? null;
  parentSignal?.throwIfAborted?.();
  const controller = new AbortController();
  const onParentAbort = () => controller.abort(parentSignal?.reason ?? new Error('Run cancelled'));
  if (parentSignal) {
    if (parentSignal.aborted) onParentAbort();
    else parentSignal.addEventListener('abort', onParentAbort, { once: true });
  }
  let timedOut = false;
  // 刻意**不** unref 这个定时器：unref 过的定时器不持有事件循环，如果此刻没有别的
  // 活跃句柄（例如插件返回了一个永不 resolve 的 promise），进程会在超时前就退出，
  // 超时保护等于不存在。它是有界的（≤ MAX_TOOL_TIMEOUT_MS）且一定在 finally 里清掉。
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error(`插件工具 ${toolName} 超过 ${timeoutMs}ms 未返回`));
  }, timeoutMs);

  try {
    const toolCtx = buildPluginToolContext({
      manifest,
      hostCtx,
      config,
      dataDir,
      log,
      signal: controller.signal
    });
    const raw = await Promise.race([
      Promise.resolve().then(() => handler(toolCtx, args)),
      new Promise((resolve, reject) => {
        controller.signal.addEventListener('abort', () => {
          reject(controller.signal.reason ?? new Error('已取消'));
        }, { once: true });
      })
    ]);
    return capResultContent(normalizeToolResult(raw));
  } catch (error) {
    if (parentSignal?.aborted && !timedOut) throw error;   // 宿主取消：交给上层按原有取消语义处理
    const message = String(error?.message ?? error);
    return capResultContent({
      content: timedOut
        ? `插件工具 ${toolName} 执行超时（${timeoutMs}ms），已放弃等待。`
        : `插件工具 ${toolName} 执行失败：${message}`,
      isError: true,
      errorCode: timedOut ? 'PLUGIN_TOOL_TIMEOUT' : 'PLUGIN_TOOL_FAILED'
    });
  } finally {
    clearTimeout(timer);
    if (parentSignal) parentSignal.removeEventListener?.('abort', onParentAbort);
  }
}
