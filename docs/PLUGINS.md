# 插件系统（工具插件）

给机器人加"模型可以调用的新工具"，而不用改主仓代码。

> **要写插件、或要把别处写好的插件改过来？先看 [PLUGIN-API.md](PLUGIN-API.md)** ——
> 那是接口速查（字段/成员/能力/返回契约一张表），外加「从别的接口迁过来」的逐条对照表
> 与 11 个真实的坑。本篇讲的是**设计与理由**，那篇讲的是**照着抄什么**。
> 两篇的关键清单都由 `test/plugin-api-doc.test.mjs` 与代码逐项对齐。

插件的产物只有一样：**给模型的工具**。它不能加控制台页面、不能挂消息钩子、不能注册定时器
或后台常驻服务 —— 这些能力是刻意留白的（见文末「已知限制」），因为"插件只碰工具表"这一条
让整套接线可以完全走既有链路：装载发生在 `createApp()` 之前，插件工具与内置工具在同一张表里，
编排器、实验调度器、控制台会话视图读到的形状完全一致。

> **先读这一句**：插件是**同一进程里的可信代码**，不是沙箱。能力清单的作用是
> "声明 + 可见 + 变更需重新确认"，不是隔离 —— 插件仍然能 `import` Node 内置模块做任何事。
> 装第三方插件之前，请确认你信任它的作者。

---

## 1. 插件放在哪

| 位置 | 用途 | 进 git | 升级时 |
| --- | --- | --- | --- |
| `<仓库根>/plugins/<id>/` | 随版本分发的插件、官方示例 | 是 | `deploy.sh` 同步更新 |
| `config.json` 的 `plugins.roots` 指向的目录 | 你自己装的第三方插件 | 否 | **不受影响**（放安装目录之外） |
| `<安装目录>/plugins/<id>/` | 图省事直接丢进去 | 否 | 靠 `deploy.sh` 的 protect 规则保住 |

**推荐做法**：把自装插件放在安装目录**外面**，例如 `/mnt/data/qq-agent/plugins`（与
`app/`、`data/` 平级），然后在 `config.json` 里指过去：

```json
{ "plugins": { "roots": ["/mnt/data/qq-agent/plugins"] } }
```

这条路完全不经过 `deploy.sh` 的 `rsync -a --delete`，是零语义依赖的稳妥做法。

**关于 `<安装目录>/plugins/`**：`deploy.sh` 对它加了一条
`--filter='protect /plugins/***'`。protect 只作用于 `--delete` 阶段，所以：
- 发送端里有的文件照常传输更新（仓库自带的插件因此跟版本走）；
- 接收端独有的文件不删（你丢进去的第三方插件活得过每一次更新）。

副作用要知道：以后某个自带插件从仓库里删掉，它在安装目录里的那份会**留下来**（不会自动清理）。
没在 `plugins.enabled` 里启用就不生效。

**`data/` 下不放插件。** `data/` 是记忆与聊天记录（整个目录被 `.gitignore`），插件是代码，
两者不该混在一起。

## 2. 快速上手

装官方示例（它随仓库分发，所以只要启用就行）。**在控制台里点三下**：底部导航 →「插件」→
「启用」→「确认这份能力」，然后重启服务。想手改配置也行：

```json
{
  "plugins": {
    "enabled": ["hello"],
    "approved": {
      "hello": {
        "version": "1.0.0",
        "capabilities": ["chat:read", "chat:send", "storage"],
        "tools": ["hello_count", "hello_recent"]
      }
    }
  }
}
```

`capabilities` 与 `tools` 必须**排序后逐字一致**（宿主就是这么比的）。不想手抄就先只写
`enabled: ["hello"]`，重启后从启动日志或控制台看到它停在 `pending-approval` 并列出待确认清单，
照抄即可。

然后重启：

```bash
systemctl --user restart qq-agent-linux.service
```

启动日志应出现 `[plugin] 插件：已加载 1 个（工具 2 个）…`。跟机器人说「用 hello_count 打个招呼」，
它会调这个工具并发出一条「你好，这是第 1 次被叫到。」；再叫一次计数变 2；重启服务后继续累加
（说明 `data/plugin-state/hello/kv.json` 真的在持久化）。

## 3. 目录结构

```
plugins/
├── loader.js            ← 装载器入口：发现 / 校验 / 审批比对 / 动态 import / 收集工具
├── _host/               ← 宿主侧支撑模块（下划线开头，扫描时自动跳过，不会被当成插件）
│   ├── manifest.js       manifest 校验与能力快照
│   ├── capabilities.js   能力白名单
│   ├── context.js        能力门面（收窄 ctx）、工具执行包装
│   ├── storage.js        每插件键值存储
│   ├── http.js           受限网络请求
│   └── registry.js       运行时工具注册表
├── README.md
└── hello/               ← 一个插件 = 一个目录
    ├── plugin.json
    └── index.js
```

插件目录名必须等于 manifest 里的 `id`。以 `.` 或 `_` 开头的目录会被跳过。

## 4. `plugin.json`

```json
{
  "id": "weather",
  "name": "天气查询",
  "version": "1.0.0",
  "apiVersion": 1,
  "entry": "index.js",
  "description": "查天气，可选。",
  "capabilities": ["chat:send", "http"],
  "tools": [
    { "name": "weather_now", "timeoutMs": 10000 },
    { "name": "weather_forecast" }
  ]
}
```

| 字段 | 必填 | 规则 |
| --- | --- | --- |
| `id` | 是 | `^[a-z][a-z0-9-]{1,38}$`，且**必须等于目录名** |
| `name` | 是 | 展示名，≤60 字 |
| `version` | 是 | 严格 `x.y.z`（不支持 `-beta` / `+build` 后缀） |
| `apiVersion` | 是 | 必须是**数字** `1`。写成字符串 `"1"` 会被拒绝 |
| `entry` | 是 | 插件目录内的相对路径，扩展名只能是 `.js` / `.mjs`；不许绝对路径、不许越出目录（符号链接绕出也会被拦） |
| `description` | 否 | ≤600 字 |
| `capabilities` | 否 | 缺省 = 零能力。取值见第 6 节，未知能力直接拒绝该插件 |
| `tools` | 是 | 1~32 项，见下 |

工具项：

| 字段 | 规则 |
| --- | --- |
| `name` | `^[a-zA-Z0-9_-]{1,64}$`；**不许以 `qq_` 开头**（旧架构 MCP 工具命名，宿主有用例禁止）；同一插件内不许重复；**全宿主唯一**（与内置工具、与其它插件都不许撞名） |
| `timeoutMs` | 1000~120000，缺省 15000 |

manifest 里出现宿主不认识的键**只警告不拒绝**（跨版本前向兼容）；缺字段、类型错、值非法一律拒绝
**该插件**，不连累其它插件与主链路。

`tools` 是**权威声明**：`activate()` 注册的工具集必须与它**完全相等**。多注册一个会在注册时报错，
少注册一个会在装载末尾报错 —— 两种情况都整个插件拒绝加载。这样"控制台展示的工具清单"与
"模型真正看到的工具"永远一致，能力快照也因此有意义。

## 5. 入口 `index.js`

```js
export async function activate(api) {
  api.registerTool({
    name: 'weather_now',
    description: '查当前天气。city 传城市名。',
    parameters: {
      type: 'object',
      properties: { city: { type: 'string' } },
      required: ['city']
    },
    async execute(toolCtx, args) {
      const data = await toolCtx.fetch(`https://api.example.com/now?city=${encodeURIComponent(args.city)}`);
      if (data.statusCode !== 200) return { error: `上游返回 ${data.statusCode}` };
      return `当前天气：${data.body}`;
    }
  });

  return {
    async deactivate() {
      // 可选。同进程重载/退出时调用。
      // 这里不要再发消息或发网络请求：卸载发生在进程收尾阶段，成败已经没人能处理。
    }
  };
}
```

`activate(api)` 的 `api`：

| 成员 | 说明 |
| --- | --- |
| `api.id` / `api.name` / `api.version` / `api.apiVersion` | manifest 里的值 |
| `api.capabilities` | 冻结的能力数组 |
| `api.log` | `debug/info/warn/error`，每条自动带 `[plugin:<id>]` 前缀 |
| `api.registerTool(def)` | 注册工具，`def` = `{ name, description, parameters, execute }` |
| `api.config` | 本插件设置（`plugins.settings.<id>`）的**非凭据**深拷贝 |
| `api.kv` / `api.stateDir` | 声明了 `storage` 才有 |
| `api.secret(name)` | 声明了 `secrets` 才有 |

**未声明的能力，属性根本不存在**（不是"存在但报错"）。所以插件用错能力时会当场 `TypeError`
并作为工具错误回到模型，而不是静默获得权限。

`activate` **抛错**（或入口 import 抛错）= 整个插件加载失败、状态记 `failed`、一个工具都不注入，
其余插件照常。

## 6. 能力清单

| capability | 门面上多出 | 边界 |
| --- | --- | --- |
| *（总是）* | `chatKey` `kind` `chatId` `selfId` `selfNickname` `botName` `session` `signal` `log` `capabilities` `pluginId/Name/Version` | `session` 只有 `{id, rounds}` 快照 —— 不是活对象 |
| `chat:send` | `send(messages, options?)` | `messages` 是字符串或字符串数组（≤5 条、每条 ≤3000 字）；**chatKey 由宿主绑死**，发不到别的会话；与内置 `send_message` 一样计入会话留档并广播 `session-update`。**不支持** `replyToMessageId` / `atUserId`（传了就报错，不会静默忽略） |
| `chat:read` | `recent(limit?)` | 只读**当前会话**，默认 20、上限 100；只给 `{id, mid, at, senderId, senderName, self, text}` |
| `chat:send-image` | `sendImage(source, options?)` | 见第 9 节 |
| `storage` | `kv` `dir` | 见第 7 节 |
| `http` | `fetch(url, options?)` | 见第 8 节 |
| `secrets` | `secret(name)` | 见第 10 节 |

## 7. `storage`

落点 `<数据目录>/plugin-state/<id>/kv.json`。**故意与插件代码目录分开**：升级时你会整目录替换
`plugins/<id>/`，状态放里面会被一起换没。

| 方法 | 说明 |
| --- | --- |
| `kv.get(key)` | 没有则 `null`；返回**深拷贝** |
| `kv.set(key, value)` | 值必须是 JSON 可序列化的 |
| `kv.delete(key)` | 返回是否删掉了 |
| `kv.list()` | 键名数组（不含值） |
| `kv.all()` | 整份深拷贝 |
| `kv.sizeBytes()` / `kv.updatedAt()` | 占用字节数 / 最后写入时间 |
| `kv.dir` | 状态目录绝对路径，插件可自行写额外文件 |

限制：键名 `^[a-zA-Z0-9_.:-]{1,64}$`；单值 ≤32KB；最多 200 个键；整份文件 ≤512KB。
超限的写入会**抛错并且不落盘、也不留在内存里**（不会出现"读得到但重启就没了"）。
写入是原子的（tmp + rename + 0600，类 Unix 上）。`kv.json` 坏掉时会被备份成 `kv.json.broken-<时间戳>`
并按空读 —— 不会被当成合法状态继续用。

## 8. `http`

```js
const res = await toolCtx.fetch(url, {
  method: 'POST',                       // GET/HEAD/POST/PUT/PATCH/DELETE，缺省 GET
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(payload),        // 字符串或 Buffer，≤64KB
  maxBytes: 262144,                     // 响应体上限，缺省 256KB，最大 1MB
  timeoutMs: 20000                      // 缺省 20s，最大 30s
});
// → { url, statusCode, headers, body（UTF-8 文本）, truncated, redirects }
```

安全边界（复用宿主 `web_fetch` 的同一套防护）：

- 只允许 `http` / `https`；URL 不许带用户名密码；
- **DNS 级拒绝内网 / 本机 / 链路本地地址**（含 `169.254.169.254` 这类云元数据服务），
  并发请求到**已校验的那个 IP**、保留 Host 与 SNI，从根上消除 DNS rebinding；
- **不继承** `security.allowPrivateImageHosts` 这个运维逃生口 —— 插件是第三方代码；
- 请求头最多 24 个，`host` / `content-length` / `connection` / `transfer-encoding` / `upgrade` /
  `keep-alive` / `te` / `trailer` / `proxy-authorization` 由宿主管理、插件不能设置；
  头的值不许含 CR/LF（防头注入）；
- 重定向最多 5 跳，每跳重新校验；**跨源跳转自动摘掉 `authorization` 与 `cookie`**；
- 响应体有上限，超了会断开并给出 `truncated: true`。

拒绝是 `PluginHttpError`（策略问题：method/头/body/URL/内网目标）；真正的网络失败原样冒泡 ——
两者分得开。

## 9. 发送图片（`chat:send-image`）

```js
// ① 发自己状态目录里的文件（需要同时声明 storage 能力）
await toolCtx.sendImage({ path: path.join(toolCtx.dir, 'tmp', 'a.png') }, { label: '初音ミク' });
// ② 发一个公网图片地址（由协议端自行下载）
await toolCtx.sendImage({ url: 'https://example.com/a.png' });

// → { sent: true, messageId: 123, bytes: 4096 }
```

| 参数 | 说明 |
| --- | --- |
| `{ path }` | **必须是该插件自己状态目录之内**的文件（`<数据目录>/plugin-state/<插件 id>/`）。宿主读出来按既有约定拼成 `base64://` 发送。**需要同时声明 `storage`** —— 状态目录是路径守卫的边界 |
| `{ url }` | 公网 http(s) 图片地址，按内置表情发远程图的**同一道守卫**校验（拒绝内网/本机/非法协议），由协议端去下载 |
| `options.label` | 可选，写进留档与日志的短标签（截到 40 字） |

- **`{ path }` 的目录守卫不是洁癖**：不限制的话，插件可以把宿主的任意文件当"图片"发到群里 ——
  最直接的例子就是 `data/config.json`（里面有明文 API Key 与控制台令牌）。所以路径先 `realpath`
  再判包含，`../` 与符号链接绕行都挡得住；单张上限 12MB。
- 发送走既有的发送队列：禁言预检、限频、outbox 记账、「可确认未送达才重试」与异常捕获全部继承；
  成功后与内置工具一样进 `session.sent` 并广播 `session-update`。
- **不支持** `replyToMessageId` / `atUserId`（理由与 `send()` 相同：内置的目标校验是模块私有的，
  抄一份就会出现第二份口径）。
- 留档文案是 `[图片:标签]`，与内置表情的 `[表情包:…]` **分开** —— 那张"我发过什么"的清单
  模型自己也会读到，把插画记成表情包会污染它的上下文。

## 10. `secrets`

`plugins.settings.<id>` 下存凭据：

```json
{
  "plugins": {
    "settings": {
      "weather": { "apiKey": "sk-…", "mode": "fast" }
    }
  }
}
```

- `api.config` 拿到的是**非凭据**视图：`apiKey` 这类字段整条消失，`mode` 保留。
- `api.secret('apiKey')` 读凭据。
- **字段名必须是"凭据样"的**（含 `apikey` / `api_key` / 以 `token` 结尾 / `secret` / `password` /
  `authorization` / `cookie` / `bearer` 之一）。原因：宿主的脱敏是**按字段名**生效的，
  名字不含关键词的字段会**明文下发到控制台、明文写进审计日志**。所以 `secret('mode')`
  会被拒绝，并告诉你把字段改名。
- 只能读自己那段；名字不许含点号（防止穿透到别的段）。
- 这些字段在 `/api/config` 响应与审计日志里始终被抹掉。

## 11. 工具返回值

与内置工具**逐字同一份契约**，返回值照原样交给 `tools-core` 的执行包装：

| 返回 | 结果 |
| --- | --- |
| `'文本'` | `content = '文本'` |
| `{ content: '文本' }` | 同上 |
| `{ content: '文本', isError: true }` | 标记为错误 |
| `{ error: '原因' }` | 等价于 `isError: true` |
| 其它 | `isError: true` + "返回值不合法" |

**成功时不要带 `isError: false`** —— 内置工具的 `ok()` 就是 `{ content }`，多一个字段会让会话
留档与审计里出现内置工具没有的键。

`content` 超过 64KB 会被截断并附一句说明（免得一次工具调用把上下文撑爆）。

## 12. 超时的真实语义

`execute` 被 `Promise.race` 裹着，超时后宿主**不再等它**，返回一条"执行超时"的工具错误。

但要说清楚：**宿主杀不掉插件里已经在跑的代码**。超时那一刻会 abort `toolCtx.signal`，
插件应当监听它并收尾：

```js
async execute(toolCtx, args) {
  const res = await toolCtx.fetch(url, { signal: toolCtx.signal });  // fetch 已默认带上它
  ...
}
```

## 13. 启用、停用与"重新确认"

### 12.1 在控制台里做（推荐）

控制台底部导航的 **插件** 页把这三件事都搬上来了，不用手抄 JSON：

- 列出所有插件：id / 名称 / 版本、状态与原因、声明的能力（带风险等级）、工具名、目录路径；
- **启用 / 停用** 按钮 —— 只改配置，页面会明说"重启服务后生效"；
- **确认这份能力** 按钮（只在 `pending-approval` 时出现）—— 指纹由服务端**从盘上的 manifest
  现算**，不采信浏览器送来的内容（否则一个被篡改的请求就能替一个要 `http` + `secrets` 的插件
  签下"只有 storage"的确认）；
- **设置** 按钮 —— 编辑 `plugins.settings.<id>`（JSON），**整体替换**语义：
  界面里没写的键（包括凭据）会被清空，编辑器上方会把这个后果写出来。
  页面从来拿不到凭据明文（`GET /api/plugins` 只给字段名），所以凭据要重填。

页面上的状态取值与下表一致，另多一个 `missing`：**已启用但盘上找不到这个 id** ——
这是最容易犯的错（拼错一个字母，重启后什么都没有），所以单独列出来点名，而不是让它凭空消失。

对应的接口（都走路由表，因此共享同一套鉴权）：

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| GET | `/api/plugins` | 现状：根目录、启用清单、能力目录、每个插件的状态 |
| POST | `/api/plugins/toggle` | `{ id, enabled }` → 写 `plugins.enabled`，回 `restartRequired` |
| POST | `/api/plugins/approve` | `{ id }` → 从盘上现算指纹写进 `plugins.approved` |
| GET | `/api/plugins/settings?id=` | 读某个插件的设置（非凭据视图 + 凭据字段名） |
| POST | `/api/plugins/settings` | `{ id, settings }` → 整体替换那个插件的设置 |

### 12.2 直接改 `config.json`

```json
{
  "plugins": {
    "enabled": ["weather"],
    "roots": [],
    "approved": {
      "weather": { "version": "1.0.0", "capabilities": ["chat:send", "http"], "tools": ["weather_now", "weather_forecast"] }
    },
    "settings": { "weather": { "apiKey": "sk-…" } }
  }
}
```

`capabilities` 与 `tools` 必须**排序后逐字一致**（宿主就是这么比的）。不想手抄就先只写
`enabled: ["weather"]`，重启后启动日志或控制台的插件页会给出待确认清单，照抄即可。

### 12.3 口径

- 改 `enabled` 需要**重启**才生效（装载发生在 `createApp()` 之前，运行期不能热插拔）。
- **能力快照是 fail-closed 的**：插件的 `version`、`capabilities` 或 `tools` 有一处变化，
  它就会退回 `pending-approval` 并**不加载**，直到重新确认。
  少了这条，插件换个版本号就能悄悄多拿一个 `chat:send`、或给模型多塞一个工具。
- 停用（从 `enabled` 里去掉）不会删数据：`plugin-state/<id>/` 原样保留。

插件状态取值：

| 状态 | 含义 |
| --- | --- |
| `loaded` | 已加载，工具已注入 |
| `disabled` | 没在 `enabled` 里 |
| `pending-approval` | 缺审批记录，或版本/能力/工具与审批不一致，或配置已就绪但还没重启 |
| `invalid` | manifest 本身不合法（id/version/entry/capabilities/tools 等） |
| `failed` | 入口 import 或 `activate` 抛错、工具集与声明不符、工具名冲突 |
| `missing` | 已启用，但在任何插件根里都没找到这个 id（只在控制台的插件页出现） |

**任何非 `loaded` 的插件都不会注入任何工具** —— 宁可模型少一个工具，也不要一个必然报错的工具。

## 14. 排查

启动日志：

```
[plugin] 插件：已加载 1 个（工具 2 个），未加载 2 个（1 未启用 / 1 待确认 / 0 异常）
[plugin:broken] invalid：entry 越出插件目录：../outside.mjs
```

- 「装好了但没生效」→ 先看状态是不是 `pending-approval`（能力快照不一致），这是最常见的。
- 「工具名冲突」→ 与内置工具或别的插件撞名了，改名。工具名必须全宿主唯一。
- 「调过去报未知工具」→ 该插件不是 `loaded`。
- 想验证"坏插件不会拖垮机器人"：随便改坏某个插件的语法，重启后它应该是 `failed`，
  而机器人照常聊天。

## 15. 已知限制（刻意的）

- **插件不能加控制台页面**：控制台是零构建 + `ui/index.html` 静态清单，且
  `test/ui-modules.test.mjs` 做文件↔清单双向校验、服务端静态分发只有一段写死 `ui/` 的
  catch-all。第三方页面要动这两处，风险与收益不成比例。
  （插件自己的**管理**页是控制台的一部分，见第 13 节 —— 那是宿主实现，不是插件提供的。）
- **不能挂消息钩子**（收到消息 / 触发前 / 发送前后）。
- **不能注册定时器或后台常驻服务**，只能在一次工具调用里做事。
- **没有提示词注入能力**：插件不能往系统提示词里加段落。这条是实践中撞到的硬限制 ——
  一个"按会话分级过滤图片"的插件本来想用提示词告诉模型「分级是按会话的、只有主人能改」，
  在本项目里只能把这条规则**写进工具描述**（那是模型唯一能看到插件文字的地方），
  或者干脆靠工具自己核身份、拒绝时把原因讲清楚。
- 上面四条都是"能力"维度的留白：以后要加是往 `capabilities.js` 里加一项、在
  `context.js` 里接一个门面字段，而不是重写装载器。**这个边界已经被真实需求推动过一次**：
  `chat:send-image` 就是为"把图发到群里"这类插件加的（见第 9 节）—— 原先 v1 只发文本，
  一个 Pixiv 取图插件因此完全用不了。
- 插件与宿主**同进程**，没有沙箱（见文首）。由此有一条必须知道的推论：
  **同进程代码可以绕过门面自己发网络请求**。例如 Pixiv 那个插件用全局 `fetch` +
  undici `ProxyAgent`（为了带 `Referer` 与支持 HTTP 代理），它声明了 `http` 能力，
  但宿主的 SSRF 防护对它**不生效**。门面是"声明 + 可见"，不是围栏 ——
  装第三方插件前请确认你信得过它的作者，需要审计就去看它的源码里怎么发请求。
- `chat:send` 暂不支持引用 / @（内置 `send_message` 的目标校验是模块私有的，抄一份就会出现
  第二份口径，而它守的正是"回复到别的会话"这类事故）。`chat:send-image` 同理。
- 控制台的启停 / 确认 / 改设置都**只改配置**，要重启才生效（装载只在启动时发生一次）。
  页面会把这句话写出来、响应里也回 `restartRequired`，而不是让人以为点了就该立刻生效。

## 16. 写测试

宿主的契约用例在：

```bash
node test/plugin-manifest.test.mjs     # manifest 校验与能力快照（表驱动，逐字段）
node test/plugin-loader.test.mjs       # 发现/审批/失败隔离/重名冲突/重载/部署保护规则
node test/plugin-tools.test.mjs        # 工具注入、能力门面收窄、超时、返回值归一
node test/plugin-storage.test.mjs      # 存储上限与原子写、设置/凭据视图
node test/plugin-http.test.mjs         # 网络能力的拒绝路径（不发真实请求）
node test/plugin-console-api.test.mjs  # 控制台 API：启停/确认/设置，含"凭据不许出进程"
```

夹具在 `test/fixtures/plugins/`，其中一批是**故意写坏**的插件（manifest 非法、入口抛错、
注册未声明的工具……），它们是"坏插件不许进来"这条契约的测试数据，`eslint.config.mjs` 里
已把 `test/fixtures/**` 排除在 lint 之外。
