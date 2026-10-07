# 插件接口速查（PLUGIN-API）

这份文件是**写给插件作者（人或 AI）的唯一一张对照表**：把 `plugin.json` 的字段、
`activate(api)` 的成员、`toolCtx` 的成员、能力清单、返回值契约一次列全。

它的存在有个具体原因：曾经有一个 1284 行的第三方插件交过来，它调的接口**本仓一个都没有**
（`setup(a)`、`registerTool({ id, name })`、`api.config()` 当函数、`api.fetch()`、
`ctx.sender.sendImage()`、`configSchema`、`prompt.sections`、`permissions`，
连 `import { DATA_DIR } from '../../src/config.js'` 指向的文件都不存在）。
那不是"作者水平问题"—— 是**没有一份权威对照表**，于是对手上的代码猜出了一套合理但不存在的接口。

所以这份文件里的关键内容**不是靠人抄的**：字段名、成员名、能力 id 都与代码同源，
并且由 [`test/plugin-api-doc.test.mjs`](../test/plugin-api-doc.test.mjs) 盯着 ——
本文件第 1 节的示例会被**真的装进宿主跑一遍**，成员清单会与代码逐项比对。
代码改了而这份文件没跟着改，CI 会红。

> **权威顺序**：代码 > `docs/PLUGINS.md`（教程与设计理由）> 本文件（速查）。
> 三者冲突时以代码为准，并请顺手修掉这份文件。相关代码：
> `plugins/_host/manifest.js`（字段校验）、`plugins/_host/context.js`（门面）、
> `plugins/_host/capabilities.js`（能力清单）、`plugins/loader.js`（装载与工具注册）。

---

## 1. 最小可装载骨架

一个插件 = 一个目录（目录名 = `plugin.json` 的 `id`），里面至少两个文件。
下面这两段**是被测试真装载过的**，可以整段抄走改：

<!-- plugin-api:example-manifest -->
```json
{
  "id": "example-plugin",
  "name": "示例插件",
  "version": "1.0.0",
  "apiVersion": 1,
  "entry": "index.js",
  "description": "演示一个最小可用的插件：注册一个工具，用它自己的键值存储计数。",
  "capabilities": ["storage"],
  "tools": [
    { "name": "example_ping", "timeoutMs": 5000 }
  ]
}
```
<!-- /plugin-api:example-manifest -->

<!-- plugin-api:example-entry -->
```js
export async function activate(api) {
  // api.log 的每条都会自动带上 [plugin:example-plugin] 前缀
  api.log.info(`已激活，状态目录 ${api.stateDir}`);

  api.registerTool({
    name: 'example_ping',            // 必须与 plugin.json 的 tools[].name 逐字一致
    description: '回一句问候，并报告被调用过多少次。who 传称呼，可以不给。',
    parameters: {
      type: 'object',
      properties: { who: { type: 'string', description: '称呼' } },
      required: []
    },
    async execute(toolCtx, args) {
      // kv 是**同步**的：不要写 await（写了也不会错，但会让人以为它是异步的）
      const n = Number(toolCtx.kv.get('count')) || 0;
      toolCtx.kv.set('count', n + 1);
      // 返回字符串 = 成功。失败请返回 { error: '原因' }
      return `你好，${args.who || '世界'}。这是第 ${n + 1} 次。`;
    }
  });

  return {
    async deactivate() {
      // 可选。⚠️ 这里**不要**发消息或发网络请求：卸载发生在进程收尾阶段，成败已经没人能处理。
    }
  };
}
```
<!-- /plugin-api:example-entry -->

装载成功后，控制台「插件」页会看到它停在 **待确认** ——
要经过"启用 + 确认这份能力"再重启才会真正装载（见第 8 节）。

---

## 2. `plugin.json` 字段

**宿主认识的键只有下面这些**；别的键会被**忽略并告警**（不会报错，所以写错了很难发现）：

<!-- plugin-api:manifest-keys -->
id name version apiVersion entry capabilities tools description
<!-- /plugin-api:manifest-keys -->

| 字段 | 必填 | 约束 |
| --- | --- | --- |
| `id` | ✅ | `^[a-z][a-z0-9-]{1,38}$`，且**必须等于目录名**（不一致直接拒绝该插件） |
| `name` | ✅ | 展示名，≤ 60 字 |
| `version` | ✅ | `^\d+\.\d+\.\d+$`（必须是三段数字，`1.0` 不行） |
| `apiVersion` | ✅ | 必须是**数字** `1`（写 `"1"` 或 `1.0` 都会被拒） |
| `entry` | ✅ | 入口文件，相对插件目录、必须在目录内、`.js` / `.mjs` |
| `description` | ❌ | ≤ 600 字。控制台会显示，请写给人看 |
| `capabilities` | ❌ | 缺省 = 零能力。取值见第 5 节；**未知能力直接拒绝该插件** |
| `tools` | ✅ | 非空数组，≤ 32 项。每项 `{ name, timeoutMs? }`，见下 |

`tools[]` 的规则：

- `name`：`^[a-zA-Z0-9_-]{1,64}$`，**全宿主唯一**，不许 `qq_` 前缀（那是内置工具的保留前缀）。
- `timeoutMs`：1000~120000，缺省 15000。
- **manifest 声明的工具就是模型能看到的全部工具**。`activate` 里注册的工具集合必须与它
  **完全相等**：少注册一个、多注册一个、或在运行期想加一个，都会让**整个插件**被拒绝加载。
  这是刻意的 —— 能力快照要能覆盖"给模型多塞一个工具"。

整个文件 ≤ 64KB。

---

## 3. `activate(api)` 的 `api`

入口必须导出 `activate`，可以返回 `{ deactivate }`（可选）。`api` 的成员：

<!-- plugin-api:api-members -->
id name version apiVersion capabilities log config registerTool kv stateDir secret
<!-- /plugin-api:api-members -->

| 成员 | 何时存在 | 说明 |
| --- | --- | --- |
| `api.id` / `api.name` / `api.version` / `api.apiVersion` | 总是 | manifest 里的值 |
| `api.capabilities` | 总是 | 冻结的数组 |
| `api.log` | 总是 | `debug/info/warn/error`，每条自动带 `[plugin:<id>]` 前缀。**不是**可调用的函数 |
| `api.config` | 总是 | 本插件设置（`plugins.settings.<id>`）的**非凭据**深拷贝。**是对象，不是函数**。进程启动时读一次 —— 改设置要重启 |
| `api.registerTool(def)` | 总是 | 见第 4 节 |
| `api.kv` / `api.stateDir` | 声明 `storage` 才有 | `stateDir` = `<数据目录>/plugin-state/<id>/`（绝对路径） |
| `api.secret(name)` | 声明 `secrets` 才有 | 读配置里的凭据；名字要过凭据判定 |

**未声明的能力，属性根本不存在**（不是"存在但一调就报错"）。用错能力会当场
`TypeError`，作为工具错误回到模型。

`activate` **抛错**（或入口 `import` 期间抛错）= 整个插件 `failed`、一个工具都不注入，其余插件照常。

---

## 4. 工具定义与返回值契约

`api.registerTool(def)` 的 `def`：

```js
{
  name: 'example_ping',        // 必填，必须已在 manifest.tools 里声明过
  description: '…',            // 必填，≤ 4000 字。这是模型唯一能看到的说明，写清楚"什么时候用它"
  parameters: { /* JSON Schema（object 根） */ },
  async execute(toolCtx, args) { /* … */ }
}
```

`execute` 的返回值（与内置工具**逐字同一份契约**）：

| 返回 | 结果 |
| --- | --- |
| `'文本'` | 成功 |
| `{ content: '文本' }` | 成功 |
| `{ content: '文本', isError: true }` | 失败（**成功时不要写 `isError: false`**，内置工具不带这个字段） |
| `{ error: '原因' }` | 失败（最自然的失败写法） |
| 其它 | 判为"返回值不合法"并按错误返回模型 |

- 结果超过 64KB 会被截断（保留前半 + 一句说明）。
- `args` 由宿主解析（含 JSON 容错修复），可能是 `{}`；**所有字段都当可选处理**。
- **超时**：超过 `timeoutMs` 后宿主只是"不再等"，**无法强杀**插件里的同步代码或
  不响应取消的异步工作。届时 `toolCtx.signal` 会被 abort，插件应当据此收尾。
  所以：长任务要么分段、要么自己检查 `toolCtx.signal.aborted`。

---

## 5. 能力清单

**这是白名单，只有这六个**：

<!-- plugin-api:capability-ids -->
chat:send chat:read chat:send-image storage http secrets
<!-- /plugin-api:capability-ids -->

| capability | 控制台显示 | 门面上多出 | 风险 | 一句话边界 |
| --- | --- | --- | --- | --- |
| `chat:send` | 发送消息 | `send(messages, options?)` | 中 | 文本发言（≤5 条、每条 ≤3000 字）。`chatKey` 由宿主绑死，发不到别的会话；**不支持** `replyToMessageId` / `atUserId`（传了就报错） |
| `chat:read` | 读取聊天记录 | `recent(limit?)` | 低 | 只读**当前会话**最近消息，默认 20 / 上限 100，返回 `{id, mid, at, senderId, senderName, self, text}` |
| `chat:send-image` | 发送图片 | `sendImage(source, options?)` | 中 | `{ path }` 必须是**该插件状态目录内**的文件（要同时声明 `storage`）、单张 ≤12MB；或 `{ url }` 公网图片地址。见第 6 节 |
| `storage` | 持久化存储 | `kv` `dir` | 低 | 自己的键值存储与状态目录。键 ≤64 字符，单值 ≤32KB，≤200 键，文件 ≤512KB |
| `http` | 发起网络请求 | `fetch(url, options?)` | 中 | 只回**文本**（不是二进制）。GET/HEAD/POST/PUT/PATCH/DELETE，头 ≤24，请求体 ≤64KB，响应默认 256KB / 上限 1MB，超时默认 20s / 上限 30s，重定向 ≤5，**拒绝内网与本机地址** |
| `secrets` | 读取自己的凭据 | `secret(name)` | 高 | 读本插件设置里的凭据。名字要过凭据判定（`token` 结尾、`apiKey`、`keys` 容器等） |

`chat:send` 与 `chat:send-image` 是**两个**能力：管理员应当能分开决定给不给"往群里贴图"。
声明了却不用不报错，但会让管理员多确认一项 —— 请只声明真的用到的。

---

## 6. `toolCtx`（工具执行上下文）

`execute(toolCtx, args)` 的 `toolCtx`。**它不是宿主的内部 ctx** ——
没有 `store`、没有 `sender`、没有 `session.sent`、没有 `emit`，这些是刻意不给的。

<!-- plugin-api:toolctx-members -->
pluginId pluginName pluginVersion capabilities chatKey kind chatId selfId selfNickname botName signal log session send recent sendImage kv dir fetch secret
<!-- /plugin-api:toolctx-members -->

| 成员 | 何时存在 | 说明 |
| --- | --- | --- |
| `pluginId` `pluginName` `pluginVersion` | 总是 | manifest 里的值 |
| `capabilities` | 总是 | 冻结数组 |
| `chatKey` `kind` `chatId` `selfId` `selfNickname` `botName` | 总是 | **只读快照**。`chatKey` 形如 `group:123` / `private:456` |
| `signal` | 总是 | 本次运行的取消信号（超时/中止时会 abort） |
| `log` | 总是 | 同 `api.log` |
| `session` | 总是 | 冻结的 `{ id, rounds }` 快照 —— **不是活对象**，改它不影响宿主 |
| `send(messages, options?)` | `chat:send` | 结果 `{ sent, failed }`。成功会自动进会话留档 |
| `recent(limit?)` | `chat:read` | 见第 5 节 |
| `sendImage(source, options?)` | `chat:send-image` | 结果 `{ sent: true, messageId, bytes }`。见下 |
| `kv` `dir` | `storage` | `dir` = 状态目录绝对路径，`kv` 同步方法 `get/set/delete/list/all/sizeBytes/updatedAt` |
| `fetch(url, options?)` | `http` | 见第 5 节 |
| `secret(name)` | `secrets` | 见第 5 节 |

**`sendImage` 的两条硬规则**（写成代码就是这样）：

```js
await toolCtx.sendImage({ path: path.join(toolCtx.dir, 'tmp', 'a.png') }, { label: '初音ミク' });
await toolCtx.sendImage({ url: 'https://example.com/a.png' });
```

- `{ path }` 的路径先 `realpath` 再判是否落在**你自己的状态目录**之内 ——
  `../` 与符号链接绕行都挡得住，`os.tmpdir()` 会被拒。**这条守卫是硬要求**：
  否则插件能把宿主的 `data/config.json`（含明文 API Key 与控制台令牌）当图片发到群里。
  所以临时图请落在 `<toolCtx.dir>/tmp/`。
- `{ url }` 走内置表情发远程图的同一道守卫（拒内网/本机/非法协议）。
- 留档文案是 `[图片:标签]`，与内置表情的 `[表情包:…]` 分开；记账（进 `session.sent`、
  广播 `session-update`）由门面做，**插件不要自己再记一遍**。

---

## 7. 状态与文件

| 想放什么 | 放哪 |
| --- | --- |
| 键值状态 | `toolCtx.kv`（落 `<stateDir>/kv.json`，原子写 0600） |
| 自己的其它文件（JSON、缓存、临时图） | `<toolCtx.dir>/…`，建议临时文件放 `<dir>/tmp/` |
| 插件代码 | 插件目录本身（`<安装目录>/plugins/<id>/`） |

- 状态目录与**代码目录分开**：升级时你会整目录替换插件代码，数据不该跟着没。
  所以**别把状态写进插件目录**，换了插件版本就丢。
- 插件根默认是安装目录的 `plugins/`；`config.json` 的 `plugins.roots` 可以再加最多 5 个根，
  用来放不随版本分发的自建插件。
- 同一目录里出现**重复 id** 时，装载器会告警并按先到的那个加载。

---

## 8. 失败与启停语义

- **`activate` 抛错** → 该插件 `failed`，工具一个都不注入，其它插件不受影响。
- **工具抛错** → 该次工具调用返回错误给模型，插件继续可用。
- **`deactivate`**（可选）→ 只在同进程重载/退出时调用。**不要在里面发消息或发网络请求。**
- **不做热插拔**：控制台的启用 / 确认能力 / 改设置**都只改 `config.json`**，
  响应里回 `restartRequired`，页面上也把"重启后生效"写出来。装载只在启动时发生一次。
- **能力变更要重新确认**：manifest 的 `version` / `capabilities` / `tools` 三者构成"能力指纹"。
  改动它们之后，插件会回到 `pending-approval`，需要管理员在控制台再确认一次 ——
  改描述、改超时、"改设置"都不会触发重新确认。
- 插件状态只可能是这六种之一：`loaded` / `disabled` / `pending-approval` / `invalid` /
  `failed` / `missing`。

---

## 9. 明确**没有**的东西（别再找了）

| 你可能想要 | 现状 |
| --- | --- |
| 往系统提示词里注入段落 | **没有**。把规则写进工具的 `description`（那是模型唯一能看到插件文字的地方），或让工具自己核身份/兜底 |
| 注册控制台页面 / 设置界面 schema | **没有**。设置是 `config.json` 里的一段 JSON，控制台只有一个文本框；`configSchema` 这类字段本仓不认识 |
| 挂消息钩子（收到消息 / 触发前 / 发送前后） | **没有**。插件只在工具调用里做事 |
| 注册定时器 / 后台常驻服务 | **没有** |
| 调用**别的插件** / 被别的插件调用 | **没有**。跨插件协作在本仓不存在 |
| 工具的展示名 / 图标 / 分类（`id` + `name` 分离） | **没有**。`name` 就是模型看到的函数名，只有一个名字 |
| `enabledByDefault` / `permissions` / `requires` 这类字段 | **没有**。默认值与依赖请自己写在代码与 README 里 |
| 引用 / @ 一条消息 | `send()` 与 `sendImage()` 都**不支持** `replyToMessageId` / `atUserId` |
| 进程隔离 / 沙箱 | **没有**。插件与宿主**同进程**，是可信代码。能力清单的语义是"声明 + 可见 + 变更需重新确认"，**不是**围栏 |
| 绕过门面自己发网络请求 | 技术上做得到（同进程），但那就**绕过了宿主的 SSRF 防护**。若你这么做，必须在 README 里如实写明，并保证请求目标不来自模型的任意输入 |

---

## 10. 从别的接口迁过来：逐条对照

如果你手上的插件是按**另一套**接口写的（很常见：对方按自己的假设写了一套合理的 API），
按下表逐条改。左边这一列在本仓**全部不存在**。

| 你原来写的 | 本仓的正确写法 |
| --- | --- |
| `export function setup(a)` | `export async function activate(api)` |
| `import { DATA_DIR } from '../../src/config.js'`（或 `src/util.js` 之类） | 删除。**本仓是 `src/core/…`**，而且插件不该 import 宿主内部；数据目录用 `api.stateDir` / `toolCtx.dir` |
| `a.registerTool({ id: 'x', name: '展示名' })` | `api.registerTool({ name: 'x', description, parameters, execute })` —— `name` 就是模型看到的函数名 |
| `registerTool({ category, icon })` | 删掉，本仓没有这些字段 |
| manifest 里不写工具、运行期注册 | **必须在 `tools` 里静态声明**，且与注册集合完全相等 |
| `api.config()`（当函数调） | `api.config` 是**对象** |
| `api.log('…')` | `api.log.info('…')` |
| `api.warn('…')` | `api.log.warn('…')` |
| `api.fetch(url, opts)` | `toolCtx.fetch(url, opts)`（只回文本）；要二进制就自己 `fetch`，但要在 README 里写明绕过了 SSRF 防护 |
| `ctx.sender.sendText(...)` / `ctx.sender.sendImage(...)` | `toolCtx.send(...)` / `toolCtx.sendImage({ path \| url }, { label })` |
| `ctx.store.recent(chatKey, { includeSelf: false })` | `toolCtx.recent(6)`，`self` 由返回项上的布尔字段自己过滤（门面没有 `includeSelf` 选项） |
| `ctx.session.sent.push(...)` + `ctx.emit('session-update', …)` | **删掉**。门面已经记账，自己再记一遍会出现两条 |
| `ctx.chatKey` | `toolCtx.chatKey`（保留） |
| 直接写 `<数据目录>/*.json` | 写 `<toolCtx.dir>/…`（= `plugin-state/<id>/`） |
| 临时图放 `os.tmpdir()` | 放 `<toolCtx.dir>/tmp/`（否则 `sendImage({path})` 的守卫会拒绝） |
| `permissions: ["web_fetch"]` | `capabilities: ["http"]`（取值只有第 5 节那六个） |
| `enabledByDefault: true` | 没有对应物。默认值请写在代码里，并在 README 里告诉使用者要改什么 |
| `configSchema: { … }`（带 label/description） | 搬进 **README**（本仓不渲染它）；默认值写在代码的 `DEFAULTS` 里 |
| `prompt: { sections: [...] }` | 没有对应能力。把要点折进工具的 `description` |
| `export function available()`（探测依赖是否就绪） | 没有对应钩子，不会被调用 |
| `ctx.session.id` | `toolCtx.session.id`（快照） |

---

## 11. 十一个真实的坑

1. **`entry` 忘了写** → 插件 `invalid`，原因就一句 `entry 必须是非空字符串`。这是最常见的第一个错。
2. **`tools` 与注册集合不等** → 整个插件被拒。`manifest` 是"契约"，不是"提示"。
3. **工具名撞车** → 全宿主唯一。通用名（`set_rating`、`search`）请加插件前缀（`pixiv_set_rating`）。
4. **manifest 写了本仓不认识的键** → 只告警、被忽略。看起来"配了"，其实没生效。
5. **以为 `api.config` 是函数** → `api.config()` 会 `TypeError`（对象不可调用）。
6. **以为 `kv` 是异步** → 不是。同步方法，`await` 不会错，但别据此设计并发写。
7. **把状态写进插件目录** → 升级换掉插件目录时数据一起没。用 `toolCtx.dir`。
8. **临时文件放 `os.tmpdir()`** → 发图时被路径守卫拒绝（错误信息是"只接受插件自己状态目录里的文件"）。
9. **忘记声明用到的能力** → 属性不存在，`TypeError`。特别是：读最近消息要 `chat:read`，
  发图要 `chat:send-image`（且用 `{path}` 时还要 `storage`）。
10. **`ops scan --strict` 报"可疑未定义调用点"** → `src/ops.js` 的扫描器**不认识解构参数**。
    `function f({ cb }) { cb(); }` 会被判成可疑调用，CI 因此判红。被调用的回调要从对象里
    **显式取别名**：`const cb = options.cb;`。
11. **在注释里写 `from '…'`** → `test/layout.test.mjs` 会**连注释一起**正则扫相对 import，
    注释里的字面路径会被当成假 import 判红。写"从 `src/core/config.js` 取 `DATA_DIR`"
    这种不带 `from '…'` 形态的表述。

---

## 12. 交插件前的自检

```bash
# ① manifest 合法、工具集合一致（发现流程：应停在 pending-approval，而不是 invalid/failed）
node src/ops.js scan plugins --strict      # 未定义调用扫描（第 11 节第 10 条）
npx --no-install eslint .                  # 代码风格与未用变量
node --check plugins/<你的插件>/index.js   # 语法

# ② 真装载一遍（带审批），确认工具确实注入
node --test test/plugin-loader.test.mjs
```

上线后在服务器上：

```bash
bash manage.sh logs | grep -i plugin | tail -5
```

期望看到 `[plugin:<id>] 已激活…` 与 `插件：已加载 N 个（工具 M 个）…`。
控制台的「插件」页会给出每个插件的状态与原因 —— 状态是 `pending-approval` 时，
照页面上列出的能力清单核对一遍再确认。
