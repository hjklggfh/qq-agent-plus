# Repository Instructions

When adding or changing an experimental feature, follow
[`docs/EXPERIMENTAL_FEATURE_STANDARD.md`](docs/EXPERIMENTAL_FEATURE_STANDARD.md).

In particular:

- treat each experimental feature as an independently owned module;
- keep the experiment settings page limited to enable/disable and graduation;
- give any feature with operational UI its own page;
- keep runtime enablement separate from the persistent `graduated` state;
- preserve data while disabled and never auto-retry unknown external writes.

## 本地访问 Web 控制台（给用户/协作者的入口）

控制台默认只监听服务器本机 `127.0.0.1:3210`，不对外开放。两条等价入口：

- **Windows（无需 Node）**：仓库根目录 `console-tunnel.bat`。双击即用；首次运行输入
  `user@host` 并记住（写入 `.console-tunnel.cfg`，已 gitignore），自动通过 SSH 读取服务器上的
  控制台令牌并免登录打开浏览器；`test` 子命令只做连通性自检（返回 `TEST_OK` / 非零退出），
  `forget` 清除记住的地址。
- **macOS / Linux / 本机有 Node**：`SSHHOST=user@host node src/ops.js console --open`
  （`console --print` 只打印 ssh 命令）。

两者行为必须保持一致：同样经 `ssh -L` 隧道转发 3210（控制台）/ 5099（SnowLuma WebUI）/
6081（QQ 扫码登录），不要求服务器开放任何公网端口。改其一请同步改另一个。

## 部署与运维（给 AI 协作者）

要部署、更新或排查线上实例时，先读：`docs/LINUX.md`（部署、控制台、数据与备份、连接排查）、
`docs/OPS.md`（`src/ops.js` 的运维入口）、`docs/BAOTA.md`（宝塔 / aaPanel 面板环境）。五条硬约束：

- **不要以 root 部署**：`deploy-all.sh` 直接拒绝 root，`deploy.sh` 也要求以服务用户身份运行。
- **不要用 PM2 或面板的 Node 项目启动**：进程由 systemd 用户服务托管，`manage.sh` 依赖
  `systemctl --user`。
- **`manage.sh` 必须在安装目录（含 `.deployment.json` 的那一层）里执行**；在源码 checkout 里跑会
  报 `Deployed Node.js runtime is unavailable` —— 那是目录不对，不要因此重跑 `deploy.sh`。
- **`install-timers` 现在装四个定时器**：backup（每周日 04:10）、process-guard（每 10 分钟）、
  health（每 5 分钟巡检；连续 3 次失败私聊 owner，恢复补发）、audit-prune（每月 1 日 04:20 清理审计日志）。
- **更新时 `--install-dir` / `--data-dir` 必须与现有安装一致**：`deploy.sh` 会在部署开始前把全部参数
  与 `.deployment.json` 记录做强校验（`scripts/verify-deployment-target.mjs`），`--data-dir` / `--service` /
  `--repository` / `--branch` 不符直接拒绝（此时什么都没动，无需回滚）；数据目录迁移需同时给
  `--allow-path-change` 并设 `QQ_AGENT_ALLOW_PATH_CHANGE=1`。`--host` / `--port` 可省略（沿用
  `config.json` 里的现值并打印提示），它们的真相源是 `config.json`，与部署记录不一致只会提示漂移。

## 控制台前端（ui/）约定

控制台是**原生 ES module**（无构建工具，见 `docs/adr/0001-no-build-tools.md`；
2026-10-01 从 classic script 转过来，见 `docs/adr/0005-ui-es-modules.md`）。
动 `ui/` 时守四条：

- **跨文件引用一律 `import`**：每个文件顶部显式列出它用到的外部名字，尾部 `export` 出被别的文件
  用到的名字。**不许再有"靠全局共享的名字"** —— `test/ui-module-graph.test.mjs` 会当场判红
  （未解析引用只剩浏览器内建才放行）。新增文件要同时进 `ui/index.html` 的清单（`test/ui-modules.test.mjs` 盯）。
- **接管渲染入口走 `QARegistry`**（`ui/core/registry.js`）：`onTransform` / `onAfter` / `override`；
  原实现用 `QARegistry.base(name)` 取回。**不要**写 `window[name] = wrapped` 或裸赋值
  `refreshStatus = ...` —— 契约用例判红；而且模块绑定只读，那样写连"碰巧生效"都不会有。
- **改跨文件的可变状态要挂 `state`**（`ui/core/state.js`）：`state.x = …`。模块级 `let` + `export`
  是禁止的（import 绑定只读，别人一写就 `TypeError`），契约用例有两条专门盯这件事。
  另外 `state.x = …` 写在**模块顶层**就等于"求值期读 state"，环上会踩 TDZ 白屏 —— 要初始化就写进 `state.js`，
  要延后的就放进 `init()`（它挂在 `DOMContentLoaded` 之后）。
- **改了 `ui/` 就跑一遍 `docs/UI-SMOKE.md`**：自动化只覆盖"渲染不抛 + 钩子接上了"，
  布局与事件只有人能看。
- **安全网**：`node test/render-test.mjs`/ `node test/scroll-test.mjs`（19）/
  `node test/usage-e2e.mjs`/
  `node --test test/ui-smoke.test.mjs test/ui-module-graph.test.mjs test/ui-real-modules.test.mjs test/ui-registry.test.mjs test/ui-modules.test.mjs`。
  前四个是"剥掉 import/export 按 classic 跑"的 vm 沙箱，`ui-real-modules` 才是真模块语义
  （求值顺序、TDZ 只有它看得见），别把两层的用途混了。

## 插件（plugins/）约定

插件是**只贡献工具**的扩展点（写法与能力清单见 [`docs/PLUGINS.md`](docs/PLUGINS.md)）。动它时守五条：

- **宿主代码在 `plugins/loader.js` 与 `plugins/_host/`，插件本体是 `plugins/<id>/`。**
  两者同处一个目录，所以新增**子目录**等于新增一个插件 —— 宿主侧的支撑目录必须以 `_`（或 `.`）
  开头才会被跳过，这条由 `test/plugin-loader.test.mjs` 钉住。
- **插件工具只加在 `src/tools/tools.js` 这个薄包装层，不许进 `tools-core.js`**：
  `test/experimental-tool-scheduler.test.mjs` 对 `tools-core` 的**全部**工具断言零个
  `unclassified`，插件工具无法预先分类，加进去就会红。
- **不给插件原始 ctx。** 一切宿主能力都要经过 `plugins/_host/context.js` 的收窄门面，且
  必须存在 `plugins/_host/capabilities.js` 的白名单里；没声明的能力**连属性都不许有**。
  新增能力 = 清单加一项 + 门面接一个字段 + `docs/PLUGINS.md` 补一节。
  已有的外发能力只有两个：`chat:send`（文本）与 `chat:send-image`（图片）。
  后者两条硬规则别动：① `{ path }` 的图片**必须在插件自己的状态目录之内**
  （`realpath` 后判包含）—— 不设这条守卫，插件就能把宿主的 `data/config.json`
  （含明文 Key 与控制台令牌）当图片发到群里；② `SendQueue.image()` 的 outbox **payload
  里不许带 base64**（那是会被 `beginSend` 写进 sqlite 的字段，几 MB 的图会把数据目录写胖）。
- **能力指纹必须幂等**：`manifestFingerprint(manifestFingerprint(m))` 要等于
  `manifestFingerprint(m)`（控制台存的就是指纹本身，装载器拿它比对）。改指纹口径时
  先想这条，否则所有已装插件会集体停在 `pending-approval`。
- **别把插件放进 `data/`**：那里是记忆与聊天记录（整个目录被 gitignore）。`deploy.sh` 对
  `plugins/` 用的是 `--filter='protect /plugins/***'` 而**不是** `--exclude` ——
  换成 exclude 会让随版本分发的插件再也收不到更新，有一个用例专门盯这两个方向。
- **控制台侧的入口是 `plugins/console-routes.js`**（`installPluginRoutes(app)`，由 `src/server.js`
  调用）。它只走 `app.addRoute`（**不要**传 `auth:false`，免鉴权只允许 `/healthz` 与 `/api/login`），
  写入一律经 `app.updateConfig`。三条不能破的口径：页面拿不到凭据明文、
  `approve` 的指纹**从盘上现算**（不采信请求体）、启停/确认/改设置都只写配置并回 `restartRequired`
  （装载只在启动时发生一次，整个系统不做热插拔）。
  前端页面在 `ui/pages/plugins.js`：可编辑控件放在**自动刷新容器之外**（列表用
  `setHtmlIfChanged` 重画，编辑器是独立一块），这是为了绕开"整块重画冲掉正在输入的内容"那套坑。

宿主侧代码在 `plugins/` 下，所以 `eslint`、CI 的 `node --check`、`ops scan --strict`
（要跑两次：`src` 与 `plugins`）以及 `test/layout.test.mjs` 的 import 扫描都已把该目录纳入。
另外 `ops.js` 的未定义调用扫描器**不认识解构参数**，会把 `handler(...)` 报成可疑调用让 CI 判红 ——
被调用的回调要从 `options` 显式取别名（`plugins/_host/context.js` 与 `manifest.js` 各有一处）。

## 发布节奏

- **影响使用的紧急问题**（部署失败、消息发不出/收不到、数据或安全问题）：修完测完即发补丁版。
- **不影响使用的**（文案、观感、边角误报、体验优化、内部加固）：先合入 `main`、同步到服务器自测，
  然后**攒着** —— 攒够一批或与下个功能版一起发。一天最多一版为宜。
- **默认只部署到自有服务器**：改完推 `main`、同步到线上跑着看，不推 tag、不发 Release；
  攒够了再一起发。别为了单个修复开一期版本。
- **版本号接着当前 minor 的补丁位走**（2026-09-28 定）：即使这一批装了新功能，也发
  `0.7.x` 的下一位，不跳 minor（例如不做 0.8.0）——一批功能+修复 = 补丁位 +1。
- 发版流程见 [`docs/AUTO_UPDATE.md`](docs/AUTO_UPDATE.md)：推 `v*` tag → 工作流先跑与 CI 相同的检查、
  再建**草稿** Release → 填说明后发布。不要另用 `gh release create`：同一个 tag 会多出重复草稿。

