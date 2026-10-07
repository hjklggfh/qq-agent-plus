# ADR 0006：工具插件系统（plugins/）

- 状态：已定
- 日期：2026-10-08

## 背景

"给模型加一个工具"在这份代码库里原先要同时改五处：`src/tools/tools-core.js` 的单个巨型
数组、`src/core/orchestrator.js` 里那串按工具名硬编码的过滤分支、`src/llm/prompt.js` 的教学
文案、`src/pilots/experimental-tool-scheduler.js` 的三张分类集合，以及若干用例。第三方无法扩展，
第一方扩展开销也在持续变大。

同时有三条已知的"最难扩展的地方"，动它们会牵动一大片：

1. `src/console/app.js` 的 `app.start()` / `app.stop()` 是手写启停链（没有管理器注册表，
   而且它已经漏了三个子系统的 stop）；
2. `POST /api/config` 尾部是逐特性的 `JSON.stringify` 比较 + 动态启停 + 失败回滚链；
3. `ui/` 是零构建 + `ui/index.html` 静态清单，且 `test/ui-modules.test.mjs` 做
   文件 ↔ 标签的**双向**校验，服务端静态分发只有一段写死 `ui/` 的 catch-all。

## 决策

1. **插件只贡献"给模型的工具"。** 不能加控制台页面、不能挂消息钩子、不能注册定时器或
   后台常驻服务。这不是保守，而是让接线绕开上面三条：装载退化成 `createApp()` **之前**的
   一次纯启动步骤（`Orchestrator` 构造时就抓一次工具表，见 `orchestrator.js` 的
   `this.toolDefs = buildToolDefs()`），于是既不需要碰启停链、也不需要碰
   `POST /api/config` 的 diff/回滚链、更不需要碰 UI 清单与静态分发。
2. **插件是代码，放仓库根的 `plugins/`**（与 `src/` 平级、进版本库）。**不放 `data/`**：
   那是记忆与聊天记录，整个目录被 `.gitignore`，把代码混进去会让"这台机器装了什么"变成
   一件要去数据目录翻的事。自装的第三方插件走 `config.plugins.roots`（支持绝对路径）
   指到安装目录之外 —— 那条路完全不经过 `deploy.sh` 的 rsync，是零语义依赖的做法。
3. **`deploy.sh` 用 `--filter='protect /plugins/***'`，不能用 `--exclude`。**
   `exclude` 会连传输一起挡掉，仓库自带的插件从此再也收不到更新；`protect` 只作用于
   `--delete` 阶段，因此"自带的跟版本走、自装的不被删"两个目标同时成立。
   代价：以后从仓库删掉某个自带插件时，安装目录里那份会留下来（没启用就不生效）。
4. **宿主代码在 `plugins/loader.js` 与 `plugins/_host/`，插件本体是 `plugins/<id>/`。**
   装载器只把子**目录**当插件、且跳过 `.` / `_` 开头的名字，所以它扫不到自己人
   （`test/plugin-loader.test.mjs` 钉住这条）。
5. **声明式能力清单 + 收窄门面。** manifest 声明 `chat:send` / `chat:read` / `storage` /
   `http` / `secrets`；宿主按声明现拼一份门面，**没声明的能力连属性都不存在**。
   插件永远拿不到 orchestrator 的原始 ctx（那里面有 `sender` / `store` / `memory` /
   `onebot` 与活的 `session`）。`chat:send` 的 `chatKey` 由宿主绑死；`http` 复用
   `web_fetch` 的 SSRF 核心（DNS 级拒内网、请求发往已校验 IP、跨源跳转摘凭据）。
6. **能力指纹 fail-closed，且必须幂等。** `plugins.approved[<id>]` 记
   `{version, capabilities, tools}`；任一变化就退回 `pending-approval` 并**不加载**。
   `manifestFingerprint` 必须满足 `f(f(m)) === f(m)` —— 控制台存的就是指纹本身，
   装载器拿它和当前 manifest 比对（原先只认 `tools:[{name}]` 形态，指纹对象里的
   `tools:['name']` 会被读成空串，结果**每个装好的插件都停在 pending-approval**）。
7. **插件工具只加在 `src/tools/tools.js` 这个既有的薄包装层，不进 `tools-core.js`。**
   `test/experimental-tool-scheduler.test.mjs` 对 `tools-core` 的**全部**工具断言零个
   `unclassified`，而插件工具无法预先分类；留在包装层还有个好处：注册表默认为空，
   没跑过 `initPlugins()` 时工具表与升级前逐字一致（用例钉住），因此既有的 11 个
   直接用 `buildToolDefs()` 的用例一行都不用改。
8. **不假装沙箱。** 插件是同一进程里的可信代码，能力清单的语义是
   "声明 + 可见 + 变更需重新确认"，不是隔离。这一点写进 `docs/PLUGINS.md` 的开头，
   而不是留给人猜。
9. **控制台只改配置，不热插拔。** 页面上的启用 / 确认能力 / 改设置都只写 `config.json`，
   响应里明确回 `restartRequired`，页面上把"重启后生效"写出来 —— 装载只在启动时发生一次，
   与其做一个半可逆的热插拔，不如把语义讲清楚。

## 被否掉的方案

- **把插件放在 `data/plugins/`**：白捡一个"`deploy.sh` 的 rsync 排除已经覆盖 `data/`"，
  但代价是把代码塞进数据目录（备份语义混淆、要反复解释"data/ 里除了聊天记录还有代码"）。
  用一条 rsync 规则换回干净的模型，值。
- **给插件开控制台页面能力**：要动静态分发 + 放开 `ui-modules` 的双向清单门禁，
  风险与收益不成比例。留白写成"能力维度"的扩展点（加一项 capability + 门面接一个字段）。
- **进程隔离 / Worker 沙箱**：插件就拿不到 `sender` / `store`，只能走 IPC，大多数功能做不了。
- **让 `activate()` 动态决定工具集**（manifest 只写能力不写工具名）：能力快照就无法覆盖
  "给模型多塞一个工具"，而那正是最需要拦住的一类变更。

## 后果

**好的**

- 新增一个工具 = 一个目录 + 两个文件，不改主仓任何一行；主仓自带的扩展开销也降下来了。
- 一个坏插件（manifest 非法 / 入口抛错 / `activate` 抛错 / 工具集与声明不符 / 工具名冲突）
  只把它自己标成失败，其余插件与主链路照常 —— 每条路径都有用例。
- 能力清单让"这个插件能做什么"在启用**之前**就是可读的，且升级后新增能力必须重新确认。

**代价 / 已知限制**

- 插件不能加页面、不能挂消息钩子、不能注册定时器；`chat:send` 暂不支持引用 / @
  （内置 `send_message` 的目标校验是模块私有的，抄一份就会出现第二份口径，
  而它守的正是"回复到别的会话"这类事故）。
- 插件与宿主同进程，没有隔离。
- `plugins/` 目录同时承载宿主代码与插件本体，靠 `_` 前缀区分；新增宿主支撑目录必须记得加前缀。
- 装载失败**不会**在页面上自动重试：改了 manifest 要重启才能看到新状态（页面会把
  `pending-approval` + 原因显示出来，但状态本身是启动快照 + 现场扫盘的合成）。

## 顺带修掉的既有缺陷

写这一版时被用例抓出来的、**与插件无关但确实存在**的问题：

1. `SECRET_KEY_PATTERN` 原先只认 `^token$` / `accesstoken` / `access_token`，
   **`apiToken` / `webhookToken` / `botToken` 这类驼峰名一个都不匹配** —— 它们会被明文下发到
   控制台、明文写进审计日志（与 2026-09-30 补 `authorization` / `cookie` 是同一类漏网）。
   补后缀 `token$`；刻意锚成"以 token 结尾"而不是"含 token"，避开
   `maxRunTokens` / `contextWindowTokens` / `tokenSaver` 这批非凭据字段。
2. `deepMerge` 会把请求体里的**自有** `__proto__` 键当普通键赋值（`JSON.parse` 能造出这种键，
   `Object.entries` 枚举得到，而 `out[key] = …` 走的正是 `Object.prototype.__proto__` 那个
   setter），等于让请求体改写配置段的原型。这是所有配置写入路径的必经口
   （`POST /api/config` 也收任意 patch），在唯一的关口挡掉。
3. `test/layout.test.mjs` 的相对 import 扫描匹配**任意**相对路径字符串，把插件夹具里
   manifest 的 `entry: '../outside.mjs'`（数据，不是 import）判红。收紧成只认真 import 语法
   （`from '…'` / 裸 `import '…'` / `import('…')` / `new URL('…', import.meta.url)`），
   并把新的 `plugins/` 纳入扫描范围。
4. `plugins/` 是宿主代码所在地，因此同时纳入 `eslint`、CI 的 `node --check`、
   `ops scan --strict`（原先只扫 `src/`，等于"靠没被扫到而干净"）与 `ops audit` 的两节。
   顺带发现 `ops.js` 的未定义调用扫描器不认识解构参数，会把 `handler(...)` 报成可疑调用 ——
   被调用的回调改为从 `options` 显式取别名（`src/console/router.js` 顶部早有同款注释）。

## 验证

- 新增 `test/plugin-{manifest,loader,tools,storage,http,console-api}.test.mjs` 共 **164 例**。
- **零回归**的判据不是"我跑了一遍全绿"，而是建了一个 HEAD 基线 worktree，对 36 个既有
  用例文件（含全部 `ui-*` 与脱敏相关用例）做**失败集合差集**：两棵树各 36 条失败、逐条一致
  （全部是沙箱 `spawnSync` EPERM 的环境性失败），差集为空。
- 门禁：`eslint` 退出码 0；`ops scan --strict`（`src` 与 `plugins` 各一次）均为 0；
  `ops audit` 输出与基线逐行一致；`docs-index` / `ui-modules` / `ui-module-graph` /
  `ui-registry` / `ui-smoke` / `ui-real-modules` / `static-cache` / `layout` 全绿。
- **未能在这里验证的一项**：`rsync --filter='protect …'` 的语义（本机没有 rsync）。
  按 rsync 文档实现（protect 只影响 `--delete` 阶段），并用两个方向的用例钉住
  "必须是 protect、不能退化成 exclude"，但真正的验证要在 Linux 上跑一次部署。
