# 改动清单（CHANGES）

本项目的开发起点是 revision `8dca708`（衍生关系见 NOTICE），之后叠加的改动集中在五块：**对话行为、发送链路健壮性、贴纸系统、主动发言、运维**。

这些改动当初是逐条以"补丁脚本"的形式打到部署机上的（脚本头部注释记录了当时的复现现象、失败模式与实测数字），后来沉淀进源码。下表"原补丁脚本"列即对应脚本名；没有对应脚本的是直接改源码/配置，标为「本仓库新增」。源码侧 diff 约 1.2 万行（含整文件重排），UI 侧只有两个小改动。

## 总表

| 功能 | 涉及文件 | 一句话说明 | 原补丁脚本 |
| --- | --- | --- | --- |
| 分条/多气泡发言 | `src/llm/prompt.js` | 一轮想说的分 2-3 条短句发，禁止用空格把两句连成一条 | `apply-chat-bubbles-patch.sh` |
| 提示词调优 | `src/llm/prompt.js`、`src/llm/qzone-interaction-prompt.js` | 明确"被点名默认要回、没被点名可以不回"等边界；表情/图库用法同步更新 | `apply-prompt-tune.sh` |
| 聊天关思考 | `src/llm/llm.js`、`src/core/orchestrator.js` | 按用途传 thinking 开关：聊天不带思考，判断/写作类保留 | `apply-chat-thinking-off.sh` |
| 看图先读情绪 | `src/llm/prompt.js`、`src/tools/tools-core.js` | 禁止描述画面，要求先给情绪定性再回话（v2 进一步收紧并给正反例） | `apply-vision-emotion.sh`、`apply-vision-emotion-v2.sh` |
| 自安排唤醒 `schedule_wake` | `src/core/orchestrator.js`、`src/tools/tools-core.js`、`src/llm/prompt.js`、`src/console/app.js` | 模型可以给自己安排一次"稍后主动开口" | `apply-schedule-wake-patch.sh` |
| 补话（说了没人接） | `src/core/orchestrator.js`、`src/llm/prompt.js` | 发过言、没人接、在发言时段内时，约 10 分钟后给一次补话机会 | `apply-followup-nudge.sh` |
| 提示词收尾自检 / 发言唯一通道 / 多气泡鼓励 / 闲聊带自己 / 表情清单常驻 | `src/llm/prompt.js` | 一批提示词层面的行为约束 | 本仓库新增（直接改源码） |
| 消息 id 归一化 | `src/tools/tools-core.js`、`src/core/store.js` | 把 `#123` 归一成纯数字 id；helper 与调用点绑定插入，避免"调用点有、定义没有" | `apply-message-id-normalize.sh` |
| 发送网络级重试 | `src/onebot/sender.js` | `fetch failed` 重试一次；限频等非网络错误不重试 | `apply-send-retry.sh` |
| 内联工具调用兜底 | `src/tools/inline-tools.js`（新增）、`src/core/orchestrator.js`、`src/features/daily-moments.js`、`src/identity/identity-pilot*.js`、`src/pilots/relationship-pilot.js`、`src/features/qzone-interactions.js`、`src/onebot/sticker-manager.js` | 模型把 tool call 写成文本（Hermes XML / 裸 JSON）时也能取到决定 | `apply-inline-toolcall-fallback.sh` |
| 发 QQ 系统表情 `send_face` | `src/onebot/onebot.js`、`src/onebot/sender.js`、`src/tools/tools-core.js`、`src/llm/prompt.js` | 按中文名发系统表情，支持"文字+表情"同一条混排 | `apply-send-face-patch.sh` |
| 系统表情标签 | `src/onebot/onebot.js`、`src/llm/prompt.js` | 来信里的系统表情标成 `[QQ表情N 名字]`，与表情库 id 区分 | `apply-face-label-clarity.sh` |
| 启动/重连补课 | `src/console/app.js` | 断线或重启期间丢的消息，从协议端拉最近历史补齐（按 mid 去重） | `apply-chat-catchup.sh` |
| 启动自检 + 静态扫描 | `src/ops.js`（`scan` 子命令） | 扫"调用点有、定义没有"的函数名，只记日志、不阻断启动 | 本仓库新增（由消息 id 归一化事故催生） |
| 已理解过的图直接回备注 | `src/tools/tools-core.js` | 库内图的备注直接复用，省一次视觉调用 | `apply-known-sticker-hint.sh` |
| 表情包自动收藏 | `src/onebot/sticker-manager.js`、`src/onebot/stickers.js`、`src/console/app.js`、`src/core/config-legacy.js` | 看别人发的图判断值不值得收；判断异步、不阻塞主流程 | `apply-sticker-autocollect.sh` |
| 收藏判断健壮性 | `src/onebot/sticker-manager.js` | 认内联提交；`max_tokens` 200 → 600；判定尝试 2 → 3 次 | `apply-sticker-judge-robust.sh`、`apply-judge-retry3.sh` |
| 优先 QQ 收藏表情 | `src/onebot/sticker-manager.js` | 值得收时优先加进 QQ 收藏（链接稳定），失败退回本地库 | `apply-sticker-qq-favorites.sh` |
| 表情同步防清空 | `src/onebot/stickers.js` | QQ 收藏列表为空/失败时不剪枝，避免本地库（含备注）被清空 | `apply-sticker-sync-guard.sh` |
| 找不到表情时的兜底 | `src/onebot/stickers.js`、`src/tools/tools-core.js` | 报错里带上有效 id；`findSticker` 加唯一命中的模糊匹配；提示直接用备注名选图 | `apply-sticker-lookup-help.sh` |
| 表情备注上限 | `src/onebot/sticker-manager.js` | 16 → 24 字 | `apply-sticker-note-length.sh` |
| `[表情包]` 标签与收藏规则收紧 | `src/console/app.js`、`src/llm/prompt.js`、`src/tools/tools-core.js`、`src/onebot/stickers.js`、`src/onebot/sticker-manager.js` | 表情包消息单独标注；只收真表情包，生活照/自拍不收 | `apply-sticker-label-and-rule.sh` |
| 提示词告知可攒表情 | `src/llm/prompt.js` | 工具一直有，只是没告诉模型 | `apply-sticker-collect-prompt.sh` |
| 主动开话题节奏 | `src/core/orchestrator.js` | 间隔 2.5-3.5 小时；"没有安静的群"不算消耗本轮（45 分钟后再看） | `apply-proactive-cadence.sh` |
| 主动判定间隔守卫 | `src/core/orchestrator.js` | "上次判定时间"落盘，重启后不足一个间隔就跳过 | `apply-proactive-interval-guard.sh` |
| 主动行为可观测 | `src/core/orchestrator.js` | 跳过原因、真正开话题都记日志；每次 tick 最多一行 | `apply-proactive-observability.sh` |
| 主动发言活跃时段 | `src/core/orchestrator.js` | 支持多个时间窗口（如 9-12 与 14-24）；窗口外不开口，也不浪费间隔 | `apply-proactive-quiet-hours.sh` |
| 空间互动专属活跃时段 | `src/features/qzone-interactions.js` | 动态互动单独设时段，不影响聊天回复 | `apply-qzone-active-hours.sh` |
| 空间互动失败退避 | `src/features/qzone-interactions.js` | 接口连续失败时指数退避，避免失败风暴 | `apply-qzone-fail-backoff.sh` |
| 空间互动抓取容错 | `src/features/qzone-interactions.js`、`ui/app.js` | 好友动态抓取失败（腾讯侧 `network busy` / 使用人数过多）先重试一次，仍失败也不再让整轮失败：评论检查与未读积压照跑；连续第 3 次才上报异常通知 | 本仓库新增 |
| 每日说说查重容错 | `src/features/daily-moments.js` | 空间列表读不到时跳过查重，不阻断发布 | `apply-moment-dedup-fix.sh` |
| 控制台端口探测修复 | `src/console/integrations.js` | 上游写死旧端口 15099/16081，与 Linux 全栈的 5099/6081 不一致导致误报"不可达" | `reapply-console-port-fix.sh` |
| 控制台自动登录 | `ui/app.js`、`src/console/app.js` | 地址栏带 `?token=` 免输令牌（成功后清掉 URL 明文）；登录 cookie 改 30 天 | `apply-autologin-patch.sh` |
| 会话列表轮询校准 | `ui/app.js` | 配置就绪后重新校准轮询间隔，消除每 4 秒重建列表的闪烁 | 本仓库新增（见 UI diff） |
| 只在源码变化时重启 | 部署脚本 `restart-if-changed.sh` | 每小时更新链不再无条件重启、打断正进行的对话 | `restart-if-changed.sh` |
| 运维工具集 | `src/ops.js`（单入口）、`docs/OPS.md` | 主机/服务自检、备份、进程看门狗、发送/登录线上验证、表情名导出、非交互部署、SSH 隧道、systemd 定时器安装 | 本仓库新增 |
| 本地回归测试 | `test/local/` | 定点验证发送重试、退避、内联兜底、贴纸查找 | 本仓库新增 |
| 省 Token 模式 | `src/core/token-saver.js`（新增）、`src/core/config-legacy.js`、`src/llm/prompt.js`、`src/core/orchestrator.js`、`src/memory/memory-global.js`、`src/features/daily-moments.js`、`src/features/qzone-interactions.js`、`ui/app.js`、`src/console/app.js` | 「设置 -> 省 Token」三档，只给上下文档位条数、单次运行轮数与预算、交接/印象注入字符数、表情清单条数**夹上限**，不改写用户设置；关掉即恢复原样 | 本仓库新增 |
| 关闭上游调试探针 | `src/*.js`、`ui/*.js` | 上游作者留在源码里的调试回复（指向其开发机私网地址）全部关掉 | `apply-disable-upstream-debug.sh` |

## 00. 工具插件系统（v0.7.9 起）

这一版加了插件系统：**给模型加新工具而不用改主仓代码**。插件的产物只有一样 —— 工具；
它不能加控制台页面、不能挂消息钩子、不能注册定时器。

- **插件布局与宿主代码**：`plugins/loader.js`（装载器）、`plugins/_host/*.js`（manifest 校验、
  能力门面、存储、受限网络、工具注册表）、`plugins/<id>/{plugin.json,index.js}`（插件本体），
  与 `src/` 平级、进版本库。`_host/` 与 `loader.js` 不会被当成插件（装载器只认子目录，
  且跳过 `.`/`_` 开头的名字）。相关文件：`plugins/**`、`src/server.js`、`src/tools/tools.js`、
  `src/core/config-legacy.js`、`src/core/secret-keys.js`、`deploy.sh`、`eslint.config.mjs`、
  `.github/workflows/ci.yml`、`test/layout.test.mjs`、`docs/PLUGINS.md`。
  失败模式：此前"给模型加一个工具"要同时改 `tools-core.js` 的巨型数组、`orchestrator.js` 的名字
  过滤链、`prompt.js` 的教学文案、实验调度器的分类集合与若干用例，且**没有**插件式注册口，
  第三方无法扩展。现行做法：插件工具只加在 `src/tools/tools.js` 这个既有的薄包装层
  （**不进** `tools-core.js` —— 那里有"零个 unclassified 工具"的断言），装载发生在
  `createApp()` 之前，因此 `Orchestrator` 构造时工具表已就位，运行期不需要热插拔，
  也就不必碰 `app.start()/stop()` 与 `POST /api/config` 那两处最硬的启停链。
- **声明式能力清单**：`chat:send` / `chat:read` / `storage` / `http` / `secrets`。
  失败模式：把宿主给内置工具的 ctx（含 `sender`/`store`/`memory`/`onebot`）直接交给第三方，
  等于把整条消息链路与全部凭据一并交出，而且"插件拿了什么"在代码里看不出来。
  现行做法：宿主按 manifest 现拼一份**收窄门面**，**没声明的能力连属性都不存在**；
  `send()` 的 chatKey 由宿主绑死、`fetch()` 复用 `web_fetch` 的 SSRF 核心（DNS 级拒内网、
  请求发往已校验 IP、跨源跳转摘凭据）、`secret()` 只读自己那段且要求字段名是"凭据样"的。
- **能力快照与重新确认（fail-closed）**：`plugins.approved[<id>] = {version, capabilities, tools}`。
  失败模式：没有这条，插件换个版本号就能悄悄多拿一个 `chat:send`、或给模型多塞一个工具。
  现行做法：指纹（版本 + 能力 + 工具名，排序后比对）与审批记录不一致就退回 `pending-approval`
  并**不加载**、一个工具都不注入。指纹函数必须**幂等** —— 控制台存的就是指纹本身。
- **失败隔离**：manifest 坏 / 入口 import 抛错 / `activate` 抛错 / 工具集与声明不符 /
  工具名与内置或别的插件重名 → 只把这一个插件标成失败，其余插件与主链路照常。
- **部署**：`deploy.sh` 对 `plugins/` 加 `--filter='protect /plugins/***'`（**不能**用
  `--exclude`：那会连传输一起挡掉，仓库自带的插件从此收不到更新）。失败模式：`rsync -a --delete`
  会删掉"安装目录里有、源码里没有"的文件，把用户自装的插件在每次更新时静默删除。
  protect 只作用于 `--delete` 阶段，因此自带插件照常更新、自装插件不被删。
  另推荐把自装插件放到安装目录之外，用 `config.plugins.roots` 指过去（零语义依赖）。
- **控制台插件页**：`plugins/console-routes.js`（新增）、`src/server.js`、`ui/pages/plugins.js`（新增）、
  `ui/index.html`、`ui/app.js`、`ui/style.css`、`src/console/app.js`（构建戳）、
  `test/plugin-console-api.test.mjs`（新增）。
  失败模式：一期只能手改 `config.json` 再重启，而且要自己从磁盘上的 manifest 抄那份
  `approved` 快照（抄错一个字母就停在 `pending-approval`，页面上还看不见为什么）。
  现行做法：底部导航新增「插件」页 —— 列出每个插件的状态/原因/能力（带风险等级）/工具/目录，
  可就地**启用、停用、确认能力、改设置**。三条硬约束：
  ① 页面**永远拿不到凭据明文**（`GET /api/plugins` 只给字段名，`test/plugin-console-api.test.mjs`
  直接断言整份响应里搜不到那个密钥串）；
  ② 确认能力的指纹由服务端**从盘上的 manifest 现算**，不采信请求体（否则一个被篡改的请求就能
  替一个要 `http` + `secrets` 的插件签下"只有 storage"的确认）；
  ③ 启停/确认/改设置都**只写配置**，响应回 `restartRequired`、页面把"重启后生效"写出来 ——
  装载只在启动时发生一次，不做半可逆的热插拔。
  设置是**整体替换**（`__replace__`）而不是深合并：界面编辑的是"这一个插件的完整设置"，
  深合并会让"删掉的键"永远删不掉。页面结构上把可编辑控件放在**自动刷新容器之外**，
  从根上避开"整块重画把正在输入的内容冲掉"那套坑（`test/ui-preserve-editable.test.mjs` 的 5 条用例全是它）。
- **能力扩展：发图片（`chat:send-image`）+ 一次真实插件移植**：`src/onebot/sender.js`、
  `plugins/_host/capabilities.js`、`plugins/_host/context.js`、`plugins/pixiv-illust/`（新增）、
  `test/delivery-integration.test.mjs`、`test/plugin-tools.test.mjs`、`test/pixiv-illust-plugin.test.mjs`（新增）、
  `docs/PLUGINS.md`。
  **失败模式**：v1 的插件只能发**文本**，而"取一张图发到群里"这类插件的核心价值恰恰是发图 ——
  一个别人写的 Pixiv 取图插件（1284 行，逻辑相当扎实：PID 索引不重复发、死图拉黑、按会话分级、
  代理支持、备选换图）因此在 v1 上完全用不了。它调的是一套**本仓不存在的接口**：
  `setup(a)` + `a.registerTool({ id, name })` + `api.config()`（函数）+ `api.fetch()` +
  原始 `ctx.sender.sendImage(...)`；连 `import { DATA_DIR } from '../../src/config.js'` 指向的文件
  都不存在（本项目是 `src/core/config.js`，从来没有过 `src/config.js`）—— 也就是说它在**任何版本**上
  都加载不起来，不是"差几个字段"的问题。
  **现行做法**：
  ① `SendQueue.image(chatKey, { url, bytes, label }, options)` —— 走既有的私有 `#deliver`，
  白拿禁言预检、outbox 记账、「可确认未送达才重试」与异常捕获。**payload 里只记体积与类型，
  绝不带 base64**：那是会被 `beginSend` 写进 outbox 表的字段，几 MB 的图会把数据目录写胖。
  ② 新能力 `chat:send-image`，门面 `sendImage({ path } | { url }, { label })`。
  `{ path }` 必须是**该插件自己状态目录之内**的文件（`realpath` 后判包含，`../` 与符号链接绕行都挡得住），
  单张 12MB 上限 —— 不设这条守卫的话，插件能把宿主的 `data/config.json`（含明文 API Key 与控制台令牌）
  当"图片"发到群里。`{ url }` 走内置表情发远程图的同一道守卫（拒内网/本机/非法协议）。
  ③ 顺手把「消息已送达但记账失败不能改判成发送失败」这条既有原则也用到门面的 `send()` 上
  （原先只有新增的 `sendImage` 有）—— 这是本仓复审里修过两次的那类 bug。
  ④ 移植保留了原作者的全部逻辑与注释，只改宿主接触面。它的网络请求仍由插件自己发出
  （全局 `fetch` + undici `ProxyAgent`，为了带 `Referer` 与支持 HTTP 代理），
  **所以宿主的 SSRF 防护对它不生效** —— 这一点如实写进了 `docs/PLUGINS.md` 的已知限制与插件 README，
  没有含糊过去（门面是"声明 + 可见"，不是围栏）。
  ⑤ **唯一的功能性差异**：本项目没有提示词注入能力，原作者想用 `prompt.sections` 教模型
  「分级是按会话的、只有主人能改」，改成折进 `pixiv_set_rating` 的 `description`
  （那是模型唯一能看到插件文字的地方）。
- **顺手修掉的三处既有缺陷**：
  ① `SECRET_KEY_PATTERN` 原先只认 `^token$` / `accesstoken` / `access_token`，
  **`apiToken` / `webhookToken` / `botToken` 这类驼峰名一个都不匹配** —— 它们会明文下发到
  控制台并明文写进审计日志（与 2026-09-30 补 `authorization`/`cookie` 是同一类）。
  现补后缀 `token$`；锚成"以 token 结尾"而不是"含 token"，是为了避开
  `maxRunTokens` / `contextWindowTokens` / `tokenSaver` 这批**非**凭据字段
  （放宽成包含匹配会把它们从下发的配置里删掉，设置页直接丢字段）。
  ② `test/layout.test.mjs` 的相对 import 扫描原先匹配**任意**相对路径字符串，
  于是插件夹具里 manifest 的 `entry: '../outside.mjs'`（数据，不是 import）被判红。
  现收紧成只认 `from '…'` / 裸 `import '…'` / `import('…')` / `new URL('…', import.meta.url)`，
  并把新的 `plugins/` 纳入扫描范围（它装着宿主代码，之前完全没被覆盖）。
  ③ `deepMerge` 会把请求体里**自有**的 `__proto__` 键当普通键赋值（`JSON.parse` 能造出这种键，
  `out[key] = …` 走的正是 `Object.prototype.__proto__` 那个 setter），等于让请求体改写配置段的
  原型。它是**所有**配置写入路径的必经口（`POST /api/config` 也收任意 patch），在唯一的关口挡掉
  （`__proto__` / `constructor` / `prototype` 三个键一律跳过）。
- **门禁同步**：`eslint.config.mjs` 纳入 `plugins/**`（并把故意写坏的 `test/fixtures/**` 排除）、
  CI 的 `node --check` 纳入 `plugins`、`ops scan --strict` 追加扫 `plugins/`
  （原先只扫 `src/`，等于"靠没被扫到而干净"）、`ops audit` 的语法与未定义调用两节也覆盖它。
- **验证方法**：`test/plugin-{manifest,loader,tools,storage,http,console-api}.test.mjs` 共 164 例；
  另建 HEAD 基线 worktree 对 36 个既有用例文件（含全部 `ui-*` 与脱敏相关用例）做失败集合差集，
  确认**零回归**（两棵树各 36 条失败，逐条一致，全部是沙箱 `spawnSync` EPERM 的环境性失败）。
- **已知限制（刻意）**：插件不能加控制台页面（控制台是零构建 + 静态清单双向校验 + 写死
  `ui/` 的静态分发）、不能挂消息钩子、不能注册定时器；`chat:send` 暂不支持引用 / @
  （内置的目标校验是模块私有的，抄一份就会出现第二份口径）。插件与宿主**同进程、无沙箱**。
  控制台的启停/确认/改设置只写配置，要重启才生效。
- **未能在这里验证的一项**：`rsync --filter='protect /plugins/***'` 的语义（开发机没有 rsync）。
  按 rsync 文档实现，并用两个方向的用例钉住"必须是 protect、不能退化成 exclude"，
  真正的验证要在 Linux 上跑一次部署。
- **升级影响**：**无需迁移**，默认 `plugins.enabled` 为空 = 与升级前逐字一致
  （`buildToolDefs()` 在注册表为空时返回的数组与 `tools-core` 完全相同，有用例钉住）。
  新的 `plugins` 配置段由 `DEFAULT_CONFIG` + `deepMerge` 自动补齐。

## 0. 切换服务预设时 API Key 跟随切换与四轮发布前审查修复（v0.7.8 起）

这一版的主体是控制台的一项日常操作：切换语音回复、语音转写、图片生成的服务预设时，已填过的 API Key
随服务一起切换，不再需要逐家重新获取并填写。围绕该功能建立的凭据记忆机制，在四轮发布前审查中修正了
20 处缺陷，其中 4 处为加固过程引入的回归。

- **切换服务预设时 Key 跟随切换**：`src/core/config-legacy.js`、`src/console/app.js`、
  `src/llm/tts-presets.js`、`src/llm/image-gen.js`、`ui/pages/settings-save.js`、`test/tts-config-api.test.mjs`
  （新增）、`test/asr-config-api.test.mjs`、`test/imagegen-api.test.mjs`（新增）、
  `test/asr-credential-binding.test.mjs`（新增）、`test/imagegen-key-binding.test.mjs`（新增）。
  失败模式：切换服务预设后 Key 输入框变为空白；重新填写后，先前那家服务的 Key 被覆盖，切换回去时无法
  取回，只能重新获取。根因是三类凭据此前只存单槽，任何一次填写都会覆盖上一次的值。
  现行做法：三类凭据改为按槽位记忆 —— 语音回复按服务标识、图片生成按主机名、语音转写按
  「服务 + 主机名」（转写含 `apiKey` / `secretId` / `secretKey` 三种）；映射由服务端独占写入，客户端提交的
  同名字段在保存前丢弃；每把凭据记录归属标记（`tts.apiKeyService` / `imageGen.apiKeyHost` /
  `asr.apiKeyProvider` + `asr.apiKeyHost`），运行期仅发送归属匹配的那一把 —— 将 A 家的 Key 发往 B 家不会
  报错，只会在对方后台留下一条 401 或一笔异常计费，因此该约束为强制校验。切换离开时当前凭据先归档至其
  所属槽位再置空（存量实例的 Key 仅存在于单一字段，直接置空即永久丢失）；控制台「显示」按钮按当前选中项
  回读，不再回显其他服务的明文。同一批另修：搜索服务的 Key 在保存设置页时被清空、控制台令牌可用整节替换
  绕过、`__replace__` 绕过「映射归服务端」、回显密钥越家、预算门禁在主动发言路径上失效、重试耗尽后重复
  投递、贴纸收藏失败不退 quota、记忆查询无返回上限、兜底模型切换将 Key 发往另一主机等 16 项。
- **语音回复单槽 Key 在「切换服务并填写新 Key」时丢失**：`src/console/app.js`、
  `test/review-2026-10-04.test.mjs`（新增）。失败模式：存量实例中，切换服务并填写新 Key 后，再切回原服务
  且不填 Key 时，原 Key 已不可用且无法取回。根因是归档逻辑原先只位于「未填写新 Key」的分支内 ——
  「切换服务并填写新 Key」这条常用路径完全绕过归档，旧 Key 留在单槽、归属标记却已指向新服务；此后切回原
  服务时归属比较判定为「他家的」，而归档位置已被新 Key 占用，于是跳过归档并直接置空。
  现行做法：归档提至两个分支之前无条件执行，与图片生成、语音转写同一口径；填写新 Key 的分支同时将单槽
  替换为新值，保证「单槽所载」与「归属标记所指」始终为同一把。
- **语音转写归档槽缺少类型守卫**：`src/console/app.js`、`src/core/config-legacy.js`。
  失败模式：`asr.keys` 中被手工改为标量的槽位（`{"tencent":"SCALAR"}`）在保存时被展开为
  `{0:'S',1:'C',…}` 的字符索引键并写入 `config.json`。根因是同一段代码中目标槽位已设「条目必须为对象」的
  守卫、归档槽位未设。现行做法：两处共用 `entryOf()`；`migrateConfig` 补充条目级归一，覆盖读盘路径。
- **异常日志筛选与人物印象搜索无响应**：`ui/core/dom-util.js`、`ui/app.js`、`ui/pages/features.js`、
  `test/ui-preserve-editable.test.mjs`（新增）。失败模式：异常处理页的状态与等级筛选选定后表格不刷新，
  人物印象页搜索框按回车无响应；期间异常日志页将未筛选的行作为筛选结果呈现。根因是整块重画前设有
  「焦点位于输入控件时暂不写入」的守卫（用以避免后台轮询覆盖正在输入的内容），但无法区分「后台轮询触发的
  重画」与「该控件自身触发的重画」。现行做法：新增 `options.force` 通道，由用户主动触发的刷新显式传入，
  后台轮询仍受原守卫保护；重画后将焦点归还至同一控件，光标置于末尾。
- **服务端纠正后的值被未保存的输入覆盖**：`ui/core/dom-util.js`。
  失败模式：好友管理页将 `99999` 填入上限为 `365` 的输入框，服务端存储 365，界面重画后仍显示 99999 ——
  存储值与显示值不一致。根因是「保留未保存输入」仅判断用户是否修改过该控件，未判断服务端本轮是否也修改了
  该值。现行做法：两个条件同时成立时才回填，服务端修改过的字段一律以服务端为准；同处一并修正同名控件更换
  类型、下拉选项消失时不强塞非法值的情形。
- **凭据与配置的边界**：`src/core/config-legacy.js`、`src/console/app.js`。
  ① `migrateConfig` 不再为归属未知的图片生成 Key 补记归属：合并路径补记等同于将其绑定到本次保存刚修改的
  地址，用户切回原地址时校验不通过、凭据被锁定；读盘阶段仍照常补记（移入 `loadConfig`），升级中的实例不受
  影响。② `asr.providerDefaulted` 改为在整节替换的有效体上删除：节点层的 `delete` 在 `__replace__` 下不作用于
  最终配置，替换体中的同名字段会落盘并永久屏蔽 `ASR_API_KEY` 环境变量。③ 配置段被提交为标量或数组时按
  「该段未修改」处理，不再导致整个 `/api/config` 返回 500。
- **其余修复**：`ui/core/dom-util.js`、`src/llm/llm.js`、`src/core/orchestrator.js`、
  `src/tools/audio-transcribe.js`、`src/tools/tools-core.js`、`src/onebot/sticker-manager.js`、`src/ops.js`、
  `deploy.sh`、`.github/workflows/release.yml`、`docs/OPS.md`。
  滑条回填服务端实际存储值后补发 `input` 事件（程序化写入 `.value` 不触发，滑块读数与填充色停留于旧值）；
  语音转写配额在下载、转码、超时失败时退还；模型重试耗尽后不再重复投递、响应为空时明确报错；当日预算耗尽
  的提示改为每个会话每天仅提示一次，主动发言路径不再重复播报；记忆查询补充返回条数上限并按最近观测时间
  排序；贴纸收藏的 `collect` 在失败时退还计数；`deploy.sh` 失败路径补上真实调用点锚点（原锚点位于函数定义
  处，任何改动均可通过校验）；发布流水线新增「tag 与 `package.json` 版本号一致」校验，版本号不符时中止发布。
- **升级影响**：**无破坏性变更，不需要迁移步骤，不需要修改任何配置**。存量凭据在读盘阶段自动补记归属，
  升级后照常生效。控制台行为变化：切换服务预设时已填写的 Key 随服务切换；异常日志页筛选与人物印象页搜索
  在触发后立即生效（此前需待焦点移开）；服务端纠正过的值在整块重画的表单中立即显示为纠正后的值（此前会
  短暂显示用户输入的原值）。部署侧无新增依赖，沿用上一版的 `npm ci` 流程即可。
  **一处口径变化**：模型 API 的凭据若同时存在「控制台写入的 providerKeys」与「老配置内联在
  providers[].apiKey 里的那份」，现在**以 providerKeys 为准**（此前是内联优先）。只在两份不一致
  且不一致的那份来自老配置时才会被察觉 —— 表现是「升级后实际发出的 Key 变了」，而实际生效的是
  控制台最后一次显式保存的那把。内联那份在下次重建列表时会被丢弃（成为不再使用的死数据）。
  设置 → 高级选项 → 模型 API 里重新保存一次 Key 即可把两份统一成同一把。

## 1. 控制台性能、删除/保存体验与巡检判据修正（v0.7.7 起）

这一版集中在控制台的响应速度与"整页重拉"体验，外加健康巡检判据的一次修正、两处依赖升级，
以及发布前审查补上的一批小项。

- **控制台响应性能**：`src/console/app.js`、`test/response-compression.test.mjs`（新增）。
  失败模式：① 每个页面的 JSON 响应都不压缩（会话载荷动辄上百 KB）；② 贴纸图片每次打开都全量重下，
  列表里几十张缩略图时尤其明显；③ 用量页每次打开都要遍历并 `JSON.parse` 全部会话文件，且旧缓存是
  20 秒单槽 —— 状态栏按 `today`、页面按 `7` 天来回刷，两个区间互相顶掉，几乎从不命中。
  现行做法：`json()` 对超过 1KB 的响应做 gzip（按 `Accept-Encoding` 协商、两侧都发 `Vary`、`q=0` 拒绝、
  异步 zlib 回调前先判 `headersSent/destroyed`）；贴纸图片按"本地库 `s-<id>` / 远程地址 `u-<sha1>`"两个分支
  发 `ETag` + 长缓存（本地 7 天 immutable、远程 24 小时），`If-None-Match` 命中回 304；用量统计加 mtime 预筛
  （早于窗口起点 6 小时的文件直接跳过）与**按区间分槽**的 60 秒缓存（上限 8 槽、淘汰最旧一槽）。
- **删除与保存不再整页重拉**：`ui/app.js`、`ui/pages/features.js`、`test/render-test.mjs`。
  失败模式：① 删一张图后整页刷新、滚动位置被顶回顶部 —— 服务端"先广播 SSE、后回 HTTP 响应"，删除回声
  先到就把状态清空重拉了；② 编辑/新增保存后整格重渲染两次 —— 保存请求自己的回声又触发一次重拉，
  身份、记忆两处编辑器还额外被 `identity-pilot-update` 回声穿透（该事件由身份库写库与记忆写库后的
  索引刷新广播）。
  现行做法：删除改为**就地摘除**（本地状态摘掉一条 + 概览计数减一 + 直接移除卡片节点，拿不到节点才退回
  重渲染），SSE 的 delete 事件同样就地过滤（幂等），并用"删除在途标记"挡住自己请求的回声（标记覆盖全部类别，
  stickers/slang 的概览计数同步递减）；保存侧用 `withAssetWrite` 在途守卫（**计数**语义，两次保存重叠时
  先完成的一次不会提前关闭另一次的在途窗口）+ `finishAssetMutation` 就地重拉并还原滚动位置；
  `asset-update` 与 `identity-pilot-update` 两个回声监听器都查这道守卫。
- **健康巡检判据修正**：`src/core/health-check.js`、`test/ops-health.test.mjs`、`docs/OPS.md`、`src/ops.js`。
  失败模式：旧判据"入站新 → 出站必须新"把两类正常行为当成"收发停止"（2026-10-01 清晨的静默期、
  2026-10-02 08:15 的"按响应概率决定不回"），连续 3 次误报私聊 owner。
  现行做法：判据改为"**到期的入站消息有没有被处理**"—— ① 停在 `pending` 且超过 60 分钟宽限
  （pacing 上限 45 分钟 + 一轮宽限）；② **重试耗尽（`failed`）且发生在最后一次成功出站之后**的
  （模型网关整体打挂时消息十几秒内全部转 failed，只看 pending 会静默漏报；偶发单条失败而之后仍有成功
  出站则不算停滞；观察窗口 6 小时外的历史旧账不追打）。`observe`、Agent 暂停、当日预算降级三种
  "故意不处理"显式跳过；不再因"还没有出站记录"提前放行。已知边界：发送结果待确认（`held` /
  outbox `sending|unknown`）的批次不在判据内，仍由控制台的"待核对"流程人工兜底。
- **依赖与 CI 升级**：`package.json`、`package-lock.json`、`deploy.sh`、`test/node-floor.test.mjs`（新增）、
  `.github/workflows/*`。`ws` 8.21.3 → 8.22.0、`undici` 6.28 → 8.11.2；undici 8 要求 Node ≥22.19，
  项目低限随之从 22.13 抬到 **22.19**（`engines`、`deploy.sh` 检查、README 徽章与文档口径同步，
  并加用例钉住"依赖的 engines 不得越过项目地板"）；Actions 换成 `checkout v7.0.1`、`setup-node v7.0.0`
  （仍按 commit SHA 钉住）。
- **发布前审查补项**（2026-10-02）：lockfile 根 `engines` 与 `package.json` 对齐（新增用例钉住）；
  黑话删除的 SSE 就地过滤同步概览计数；`src/core/sqlite.js` 的报错文案与运维帮助文档的巡检口径
  跟着新判据更新。
- **升级影响**：**运行期依赖有变化（ws/undici），手工 `git pull` 部署需重新 `npm ci`；Node 需 ≥22.19**
  （使用 `deploy.sh` 时其 `.runtime` 会装 22.23.2）。健康巡检判据变了：安静时段与"按概率不回"不再误报，
  但"消息重试耗尽且此后没有成功发出"会新增告警（这是修漏报）—— 包括低峰时段单条消息重试耗尽的场景，
  约 1 小时后也会告警；`docs/OPS.md` 与 `ops.js --help` 的
  第 3 项描述同步更新。控制台行为变化：删图与保存不再整页刷新，滚动位置保留。

## 2. 架构拆分、图片生成与三轮审查修复（v0.7.6 起）

这一版是 v0.7.5 之后的收口：控制台 UI 结构性拆分并全量转 ES module、加入图片生成与完整的密钥控制，
外加三轮对抗性审查的修复；同时让 WS 客户端兼容不回应 PING 的 NapCat 协议端。

- **图片生成 `generate_image`（Issue #21）**：`src/llm/image-gen.js`、`src/llm/image-gen-presets.js`（新增）、
  `src/core/image-type.js`（新增）、`src/core/quota.js`、`src/core/config-legacy.js`、`src/tools/tools-core.js`、
  `src/console/app.js`、`ui/pages/*`、`docs/CONFIG-EXAMPLES.md`。
  失败模式：原先只会"收图、发图"，不会画。现行做法：`generate_image` 工具（OpenAI 兼容
  `POST {baseUrl}/images/generations` 与 Pollinations 的 `GET /prompt/<提示词>` 两种请求形状），生成的图落进
  表情库后用现成的 `send_sticker` 发出。**内置服务预设**（`GET /api/imagegen/presets`）：Pollinations（免 Key）、
  智谱 CogView-3-Flash、硅基流动、魔搭、自定义 —— 免 Key 那家把 Key 栏置灰、鉴权守卫按预设放行且不发
  `Authorization`，402/429 翻译成"被限流 + 稍后再试或换一家"。三条硬约束：**Key 归属守卫**（跨域拒绝复用
  模型 Key，`imageGenKeyHost` 记主机、同域才复用且不回显模型 Key）、**唯一成本闸门** `maxPerHour`（默认 6）、
  **不发 `response_format`**。画图额度改为**事前原子 `tryConsume` + 失败 `refund`**：并发同毫秒、小时边界、
  prune 之后退款三条边界都推演过。预览 MIME 不再写死 png，按实际字节（智谱回 JPEG）；生成耗时实测 8~9 秒 /
  1024×1024（国内厂商按标识办法统一带"AI 生成"水印）。
- **控制台：密钥控制补齐与两处对齐根因**：`ui/pages/key-toggles.js`（新增）、`ui/pages/settings*.js`、
  `ui/core/dom-util.js`、`ui/style.css`。
  失败模式：① 需要按密钥控制的地方没控件（生图 Key 只有单向「显示」、语音回复/语音转文字/OneBot 两个令牌
  完全没有）→ 统一成 15 个密钥/令牌的「显示/隐藏」，明文只走各自的受守卫端点，OneBot 令牌的"保持不变"是
  留空（不是 `******`）；「显示」取明文**成功之后**才翻按钮状态，失败保持原样并把原因写进提示，没配提示位的
  开关也会现挂一个。② 设置页"有些输入框/文字/按钮没对齐"：`.field-row` 的 CSS grid 用 `align-items: end`，
  同一格里两个字段内容高度不同（单行提示 vs 两行提示）时矮的那格整块被压到底部（实测差 18px，16 个分区
  36 行里 4 行中招）；`.field label`（0,1,1）压过 `.checkbox-row`（0,1,0）把复选框行压成字段标题样式。
  两处根因都修掉后 46 个勾选/单选行偏差实测全 0。侧栏品牌行与部署卡片补上版本号显示（`/api/status.version`）。
- **UI 架构：拆分与 ESM 化**：`ui/app.js`、`ui/core/*`、`ui/pages/*`、`ui/index.html`、`test/render-test.mjs`。
  `ui/app.js` 13130 → 1019 行（拆出 `core/` 与 `pages/`，`bindSettingsEvents` 按域分四段），`ui/` 全量转
  ES module（249 条共享全局降到 0），去插件化改为注册表；模块清单在 `ui/index.html` 的
  `<script type="module">` 里显式列出，由契约用例双向校验（多写、少写都红）。ADR 0001~0005 记录取舍。
- **静态资源：真 304 + 内容哈希长缓存**（ADR 0001 补记）：`src/console/app.js`、`test/*`。
  实测证伪了 ADR 原话"静态资源已经解决了缓存问题"——此前只写 ETag、从不判 `If-None-Match`，
  每开一次控制台都把整套脚本整个重下一遍。现在 `If-None-Match` 命中即 304，下发 `index.html` 时把自家资源
  改写成 `?v=<内容 sha256 前 12 位>` 并给带令牌的请求长缓存（旧 URL 钉不住旧脚本）。
- **可观测性与限额（改进方案 #5/#6/#8/#9/#13）**：`src/core/audit-log.js`（新增）、`src/core/logger.js`（新增）、
  `src/core/budget.js`（新增）、`src/core/quota.js`（新增）、`src/console/app.js`、`ui/pages/*`。
  审计日志（写盘 0600，每次 append 都 chmod 兜底 btrfs）、结构化日志与 `x-trace-id`、每日预算、配额双闸
  （内存 + 落盘）、记忆可见性页。
- **运维与部署加固**：`deploy.sh`、`scripts/auto-update.mjs`、`src/ops.js`、`src/core/health-check.js`。
  `deploy.sh`：路径嵌套**双向**拒并且判定前用 `realpath -m` 归一化（归一化失败 fail-closed）、临时目录进
  EXIT trap、抢锁走互斥目录、接管陈旧锁补 5 分钟宽限并在互斥内**再判一次**（顺序：重判 → 删锁 → 重建）、
  trap 提前到抢锁之前；`auto-update`：空/坏锁宽限、接管原子化、互斥内二次判定、EEXIST 一律算忙碌；
  巡检两个本机探测加 10 秒超时；审计落盘 0600；备份单元把路径/服务名/保留份数显式带进 `Environment`
  （值整体加引号）；SSE 事件流加 1MiB 背压上限 + 20 秒共享心跳（`unref` + `stop` 清理）。
- **三轮对抗性审查的修复**（每条都做了"回退修复即变红"的用例）：
  - `deploy.sh` 陈旧锁的接管判据整个写反（`-z` 应为 `-n`）：属主已死且确实过期的锁被判成"另一个部署在跑"
    直接退出（SIGKILL 之后无人值守的自动更新永久卡死），而刚 mkdir 还没写 pid 的并发锁反被抢走；
  - 每日动态：群聊材料、抓回的网页正文、以及**模型整理的交接字段**（topic/summary/facts/nextStep）
    全部过 `sanitizeUserText` —— 伪造段头经模型写进交接就能绕过前一处修复直达那条提示词；
  - 用量页：搜索副行在"有总数、没有工具明细"时不再硬说"只抓了网页"，token 两张卡的主数字与副行补断言；
  - `ui` 四处：事件流反馈解析加守卫、用量文案去死逻辑、控制中更新检查说明随增量刷新、配置请求走共享 `api()`；
  - `release.yml` 的**孤儿 step**（只有 `name:`、没有 `run/uses`）会让 GitHub 判整份工作流非法 ——
    打 tag 时 Release 出不来；已删并新增 `test/workflow-steps.test.mjs` 逐 step 校验；
  - `ops audit` 的「关键补丁标记」里 `^function normalizeMid` 是 CJS 时代的锚点，对上 ESM 的
    `export function` 永远不命中（体检常驻一条假 NG）；顺带把整张标记表纳入用例，防标记再随实现漂移。
- **NapCat 兼容（Issue #22）**：`src/onebot/onebot.js`、`src/core/catchup-policy.js`（新增）。
  失败模式：NapCat 的 OneBot WS 服务端**不回应 WebSocket PING，而是直接销毁连接**（客户端看到
  `close code=1006`、全程 0 次 pong）；老实现每 30 秒 ping 一次 → 连接生命周期被压到约 30 秒
  （每轮 3~4 秒接收盲窗），而 close 回调一行日志都没有，只能靠 catchup 计数反推。
  现行做法：`onebot.wsHeartbeat: auto|on|off`（默认 auto —— 首次遇到"发 ping 就被断开"的对端后不再发送，
  改由 close/error 事件发现断线；会回 pong 的对端行为不变）；断开与重连都留日志；
  补课日志把"只补记录、不回复"的条数写出来，窗口可配（`onebot.catchupReplyWindowMs`，默认 30 分钟，
  `0` = 一律只补记录）。控制台「设置 → OneBot」有这两个控件。
- **升级影响**：全部默认值保持 —— 心跳 `auto` 对会回 pong 的协议端与旧行为一致，补课窗口仍是 30 分钟；
  新增配置键随默认值自动补齐，老配置无需手改；控制台新增「设置 → OneBot」的心跳/补课控件与若干密钥开关。
  NapCat 用户在默认配置下自愈（进程启动后最多断一次，之后不再发 ping）。

## 3. 群游戏、语音回复多供应商、定时提醒与群日报（v0.7.5 起）

- **群游戏：数字炸弹 / 谁是卧底 / 狼人杀**：`src/features/group-game.js`（新增管理器）、
  `src/features/games/{number-bomb,undercover,werewolf}.js`（新增三个插件）、`src/console/app.js`、
  `ui/app.js`、`src/core/config-legacy.js`、`src/llm/prompt.js`、`src/tools/tools-core.js`、
  `src/onebot/sender.js`、`src/core/access.js`、`src/core/store.js`。
  失败模式：群游戏既要"隐藏信息 + 轮次 + 超时"，又不能把玩家的牌面（身份、词、查验结果）露给主持模型 ——
  真人群里还有一串模拟不出来的情况：没参加的人插话、有人只潜水不发言、有人半路退出、有人 AFK 不交行动、
  白天谁也不想先开口。现行做法：**真相与话术分离**（身份/词/查验结果只走私聊，模型只看公开摘要）；
  需要私聊的游戏**先挂报名**（默认 45 秒，想玩的回「我玩」，到点人不够就散），不再把只是在群里插句话的
  围观者拉进局；白天三个出口谁先到算谁（固定讨论时长、超过半数存活玩家说「投吧」、全员发过言）；
  夜里 90 秒行动窗口，到点按已收到的结算（不点名、不催人）。
  **出局者的话一律不计入判定**（入场就返回 + 计票只认活人投票）并在出局那一刻私聊本人说明；
  有人反复私聊刷行动时按"每人每夜 4 条回执"夹住，超出静默。
  **游戏期间私聊豁免**：引擎发给本局在册玩家的私聊不受 `allow.private` 白名单限制（`deny` 仍优先、
  只在局内、失败不重试、内容全部是引擎文本），否则"整局都靠私聊"的狼人杀只有全员加白名单才玩得起来。
  **引擎私聊不进模型上下文**：发送侧落库时即打 `eventKind='game-secret'`，提示词历史、翻页工具、
  消息详情等所有出口统一过滤 —— 模型在私聊里不是上帝视角。
  **狼人杀**：6~9 人（6 人局 = 2 狼 / 1 预言家 / 1 女巫 / 2 民，7 人起加守卫，9 人 3 狼）；女巫两瓶药
  （解药救当晚被刀的人、毒药独立致命可一晚双死）各一次、一晚最多一瓶、不能自救、**同守同救必死**；
  狼刀定下之后才私聊询问女巫（提示里写明被刀的是谁），此后狼改刀会被拒。控制台实验页可选可开的游戏、
  报名与讨论时长、每局人数上限、结算是否公开身份等。
- **语音回复：四家适配（含豆包语音合成 2.0）**：`src/llm/tts-presets.js`、`src/llm/tts-doubao.js`（新增）、
  `src/llm/tts-http.js`（新增）、`src/console/app.js`、`ui/app.js`。
  失败模式：原先只支持 OpenAI 兼容一家；火山 v1 的鉴权（`Bearer;<token>`）与豆包 2.0 的 v3 流式
  （`X-Api-Key` / `X-Api-Resource-Id`、NDJSON 分片里 base64）形态完全不同，写死一种形态在别家必然失败。
  现行做法：OpenAI 兼容 / 火山 v1 / 豆包 2.0 / MiniMax 四家适配，控制台按服务商预设填地址、Key、模型与
  音色（豆包内置官方 2.0 音色清单 102 条，按控制台分类分组），支持试听；语音/图片类发送的超时 15s→60s
  （实测一条 7 秒语音协议端要 16.4s，原 15s 会把已发出的语音记成"结果未知"）。
- **声音复刻音色报「没开通」**（用户反馈，2026-09-30）：`src/llm/tts-doubao.js`、`src/llm/tts.js`、
  `src/llm/tts-presets.js`、`docs/CONFIG-EXAMPLES.md`、`ui/app.js`。
  失败模式：用户在自己的火山账号上复刻了声音、也开通了，调用却报没开通。生产账号实测对照（同一把 Key）：
  复刻音色（`S_` 开头）+ `seed-tts-2.0` → `55000000 resource ID is mismatched with speaker related resource`；
  换成复刻资源 `seed-icl-2.0` → `45000030 [resource_id=volc.seedicl.default] requested resource not granted`。
  根因是**资源按音色分家**：官方文档写明音色与资源必须配套（v3 资源 `seed-icl-2.0` = 声音复刻 2.0；
  v1 集群 `volcano_icl` = 声音复刻，标准音色才是 `volcano_tts`），而适配器只会照配置发默认值；
  用户看到的"没开通"是第二段的 45000030 —— 账号确实少了「声音复刻2.0字符版」
  （后付费音色还要单独开通「后付费音色服务」），但第一段的资源错配会先把人引偏。
  现行做法：新增 `doubaoResourceIdForVoice()`（v3）与 `volcClusterForVoice()`（v1）按音色前缀路由 ——
  `S_`/`icl_`（复刻）自动切复刻资源，`icl_*` 可走 v1 并发的 `volcano_icl_concurr`；用户显式填复刻资源时尊重
  （复刻 1.0 老音色）；官方投放音色 `ICL_uranus_*`（大写）不受影响（实测配 `seed-tts-2.0` 正常出音频）；
  45000030/55000000 的错误文案补上复刻场景的下一步。
  同时修掉文档里把 `ICL_uranus_*` 说成"自己克隆的音色"的错（那是火山自营音色，全表 201 个）。
- **画出图来（generate_image）**（Issue #21）：`src/llm/image-gen.js`（新增）、`src/tools/tools-core.js`、
  `src/core/config-legacy.js`、`src/core/config.js`、`src/core/orchestrator.js`、`src/llm/prompt.js`、
  `src/console/app.js`、`ui/app.js`、`docs/CONFIG-EXAMPLES.md`。
  失败模式：原先只会"收图、发图"，不会画 —— 群友让"画一张"时只能拿库里的旧图应付。
  现行做法：新增 `generate_image` 工具（OpenAI 兼容 `POST {baseUrl}/images/generations`），生成的图
  经 `addManual` 落进表情库、再用现成的 `send_sticker` 发出（零改动复用托管内联那条路）。
  配置 `imageGen` 默认关，控制台与语音回复同页、带「试画一张」。
  **三条评审抓出来的硬约束**：① **Key 归属守卫** —— 地址与聊天模型不同域时拒绝复用模型 Key
  （`resolveImageGenAuth`，"把 A 家的密钥发给 B 家"是这个项目修过的同类事故），同域或地址留空才复用；
  ② **唯一成本闸门** `maxPerHour`（默认 6，全局）—— 图片计费不进「用量」面板（那里只统计 token），
  所以闸门是唯一防线，且先查闸门再发请求（超限不花那笔钱）；③ 不发 `response_format`
  （新版 OpenAI 因未知参数 400），`b64_json` 与 `url` 两种响应都吃、`url` 走 SSRF 防护下载后落盘。
  关闭时不注入工具、提示词也不提画图。测试：适配器 6 例 + 端到端 4 例（真落库→真能发）+ 渲染 2 例 +
  编排器 1 例；4 条变异验证（跨域回退用模型 Key / 去掉体积上限 / 闸门恒放行 / 未开仍注入）——
  其中"体积上限"与"未开仍注入"头两次是**假绿**（变异后仍全绿），各补了用例才钉住。
  **2026-09-30 审查又补三处**（均为本批引入、未发布的缺陷）：① `available`/`hasApiKey` 这类
  "给界面看的派生结论"会被控制台整段展开回传写进 config.json，旧结论从此冒充当前状态 —— 按
  `IMAGEGEN_DERIVED_KEYS` 在 `migrateConfig` 里统一剔除（该口也是读盘必经，顺带清掉遗留脏字段）；
  ② 提示词原按 `enabled` 判断、而工具过滤按 `imageGenAvailable`，"勾了开关但没填模型"时会
  一边摘掉工具一边教模型去调 —— 两处口径统一为 `imageGenAvailable`；③ 控制台的「显示」按钮
  有控件无绑定（点了没反应），补 `GET /api/imagegen/key` 端点（守卫同 `/api/tts/key`）并接上事件。
  新增 `test/imagegen-config-api.test.mjs` 4 例 + 编排器/渲染各 1 例断言，三条修复各做变异验证（均如期变红）。
- **全量审查修复（针对改进方案 C0–#13 那 47 个提交）**：`deploy.sh`、`scripts/verify-deployment-target.mjs`、
  `src/core/health-check.js`、`src/core/secret-keys.js`、`src/core/redact.js`、`src/memory/memory-runtime-integration.js`、
  `src/ops.js`、`src/console/app.js`、`src/llm/prompt.js`、`ui/app.js`。
  这批提交本身测试很全，但整体过一遍仍抓出四处真问题（都做了代码实验复现，不是纸面推断）：
  ① **全新安装会被自己的预检挡住（P0）** —— `deploy.sh` 在调用校验器**之前**就
  `mkdir -p "$INSTALL_DIR" "$DATA_DIR"`（默认 `--data-dir` 就是 `$INSTALL_DIR/data`），
  无系统 Node 时还会下到 `$INSTALL_DIR/.runtime`；而校验器把"目录非空且无 `.deployment.json`"一律拒绝，
  于是按文档走的全新安装拿到一句自我循环的提示（"清空该目录后全新安装"，清空后下次仍被自己的 mkdir 挡住）。
  修法：校验器忽略**安装器自己创建**的条目（数据目录、`.runtime`；嵌套数据目录要求路径上每一层
  **在滤掉安装器产物之后**只含下一段，否则不整体忽略 —— 滤这一步是二审才补上的，漏掉它时
  "嵌套 `--data-dir` + 无系统 Node（下了 `.runtime`）"仍会被误拒），
  并放行**就地安装**（`--install-dir` 省略、即源码树干装时 rsync 源与目标同目录，不存在覆盖来历不明代码的风险）；
  同时把校验调用挪到"沿用端点"之后，`--host/--port` 才传得上、漂移提示不再是死分支。
  ② **数据目录迁移的逃生开关传不进去（P1）** —— 校验器要求 `--allow-path-change` + 环境变量双条件，
  但 `deploy.sh` 的参数解析**不认这个参数**（报 Unknown option），提示与 `docs/LINUX.md` 却让用户加它 →
  迁移永远做不成。修法：`deploy.sh` 接收并转发该参数。
  ③ **健康告警会静默丢失（P1）** —— 注入的通知器（`notify-owner` 的 `sendOwnerText`）**失败时返回
  `{ok:false}` 而不抛**，而 `health-check` 只 try/catch，于是"没发出去"被记成"已送达"、连击痕迹也被下轮整体重写抹掉；
  触发条件又是 `count === 3` 的硬相等，一次瞬时失败 = 整段故障期再也不告警（而告警通道正是最可能同因失败的 OneBot HTTP）。
  修法：`{ok:false}` 也算失败并记 `notifyError`，到达阈值后**每轮重试直到送达**（成功即清痕迹；
  送达判定用 `!= null` 而非真值，避免注入 `now = 0` 时被当成"没送过"而每轮重发）。
  ④ **审计日志会明文落盘密钥（P1）** —— 审计把**整份配置**写入 `audit-*.jsonl` 并由 `/api/audit` 读回，
  而脱敏只按字段名判（`SECRET_KEY_PATTERN` 不含 `authorization`/`x-api-key`/`cookie`/`auth`），
  按值扫（`redactText` 的 `Bearer …`/`sk-…` 规则）又只作用于 `error`。用户把凭据填进
  `api.extraBody`/`api.thinkingParams`/自定义 header（文档推荐的高级逃生口）时明文即落盘。
  修法：模式补上 header 类名字（仍**故意不含**裸 `key`，避免误伤 sortKey 这类业务字段），
  并把按值脱敏抽成 `redactSecretValue` 接到 `redactSecretFields` 的字符串分支上。
  另修 P2：`ops audit-prune` 的 help 与 `docs/OPS.md` 写了 `--data=目录` 但代码忽略它（会删**默认**目录的审计文件）。
  以上每条都补了用例并做变异验证（还原修复必红）；顺带补掉 `generate_image` 的两处接口不一致
  （提示词与工具注入的门不统一、控制台「显示」按钮没有对应路由点了没反应 —— 与上一条
  「画出图来」的 2026-09-30 审查补记是同一处缺陷，统合后只保留一处实现与一套用例）。
- **定时提醒**：`src/core/reminders.js`、`src/console/app.js`、`ui/app.js`。
  失败模式：提醒原来只在内存里、重启就丢；多条同时到点会叠着派发；派发前不预检会把提醒标成已发生却没真提醒。
  现行做法：落盘持久化、同会话多条合并、派发前预检（模型忙/会话在跑就排队），控制台新增"定时提醒"页
  （开关、待触发与最近完成列表、单条取消），`reminders.enabled` 同时门控 `remind` 工具与到期派发。
- **群日报**：`src/features/group-digest.js`、`src/console/app.js`。定时把最近 24 小时的群聊汇总发到指定群，
  发送时间的格式做了校验与兜底（配置写错时间不再静默不跑）。
- **对抗性审查修复（3 轮）**：`src/features/group-game.js`、`src/features/games/*`、`src/tools/tools-core.js`、
  `src/core/store.js`。修掉的问题包括：引擎私聊的 `game-secret` 标记原先只打在 ingest 回显侧，而存储按
  (chat_key, mid) 幂等、命中重复不回填 → 标记恒不生效（身份与查验结果会进模型上下文）；
  出局者反复发「不玩了」绕过配额（实测 20 条→20 条回执）；投票阶段「投自己」每次都回一条群消息；
  数字炸弹越界提示可无限刷；`tick` 推进的阶段不落盘导致任何重启都会重复"天亮了"、重发夜行动提示
  （改为发送成功后落盘 + tmp/rename 原子写）；退出的守卫仍然挡刀（`pending.guard` 存的是目标，作废时
  却拿提交者 uid 去比）；同一个人在两个群各一局时一条私聊被两局各执行一次；狼在锁刀前减员导致刀口永不
  锁定、女巫整夜收不到询问；名单没去重（模型把同一个人写两遍，他会拿 2~6 张身份）。
  配置侧补上 `maxPlayers`/`roundSeconds` 的默认值、`roundSeconds` 对狼人杀补 30 秒下限、
  `recruitSeconds` 显式写 `null`/空串按缺省 45 秒处理、名单报错区分"对不上"与"被人数上限截断"。
  测试侧新增 20 条用例（含数字炸弹边界、回执按夜重置、单一归属、原子写与损坏文件现状等），
  "tick 重入锁"那条原先是假绿、改成"报名溢出 + 慢发送"并做了突变验证；整局驱动从零断言加到 6 条。
- **控制台前端去插件化（UI 解耦 C2/C3）**：`ui/core/registry.js`（新增）、`ui/app.js`、
  `ui/stable-features.js`、`ui/status-refresh.js`、`ui/index.html`、`eslint.config.mjs`、
  `test/ui-registry.test.mjs`（新增）、`test/ui-contract.test.mjs`（新增）、`test/ui-smoke.test.mjs`、
  `test/{render-test,scroll-test,usage-e2e}.mjs`。
  失败模式：两个外挂文件原先靠**改写全局**接管渲染入口 —— `stable-features.js` 用
  `window[name] = wrapped` 包裹 5 个渲染函数、`status-refresh.js` 裸赋值 `refreshStatus = ...`。
  那只在"脚本顺序刚好、且双方都还是 classic script"时成立：ES module 的绑定只读、模块作用域
  也不挂 window，任何一步模块化都会让覆盖**静默失效**（页面照常渲染，只是那段改造不再生效，
  既没有报错也没有测试能发现）。现行做法：新增 `QARegistry`（`register` 底座 / `onTransform`
  HTML 变换链 / `onAfter` 副作用链 / `override` 整体接管 + `base` 取回原实现 / 钩子抛错只 warn），
  app.js 在载入时登记 8 个入口的底座并把三个被接管的入口改经 `dispatch` 分发；两个外挂文件改成
  显式注册。**契约冻死**：`test/ui-contract.test.mjs` 断言外挂文件引用的每个跨文件全局都在
  `uiSharedGlobals` 清单里、清单里每个名字都还有定义且确实被别的文件用到、且再无 `window[...] =`
  改写；`test/ui-smoke.test.mjs` 补一条"注册 transform/after/override 后输出真的被改写"（原来只有
  "渲染不抛"）。顺带清掉清单里只在自家文件使用的 `CONSOLE_MARKER`。
  同步文档：`docs/UI-SMOKE.md`（新增，UI 手工烟测清单）、`docs/adr/0001~0004`（新增，其中 0004 用
  实测记下"不抽 `core/lifecycle.js`"的原因：那 18 个符号的传递闭包是 357 个顶层声明里的 327 个）、
  AGENTS.md 的 UI 约定与定时器条数更正（三个→四个，audit-prune 早就加了）。
- **健康巡检误报"收发停止"（生产实测，2026-10-01 凌晨）**：`src/core/health-check.js`、`test/ops-health.test.mjs`。
  失败模式：`outbound-freshness` 的判据是"6 小时内没有任何出站消息＝可疑"，而**深夜/冷清时段群里本来就没人说话**，
  于是每次在安静时段部署（部署会重启服务、出站水位跟着停住）之后，恰好 6 小时越过阈值 → 连击 3 次 →
  私聊 owner 报"收发停止"。2026-10-01 06:24 实测就是这么误报的：那一夜 6.7 小时里**一条入站消息都没有**
  （最后一条入站 23:40:37、最后一条出站 23:40:53，都答完了），其余 6 项检查全绿。
  方案 §#7 只写了"observe 模式要跳过"，把其它静默期留给"连续 3 次"的抑制口径 —— 但抑制只压抖动，
  压不住"本来就没人的时段"。现行做法：判据改成"**有人说话而 bot 一条都没回**"才算故障 ——
  窗口内有入站消息且出站超时才失败；窗口内没有入站（或库里根本没有入站记录）记为**静默期**（ok，明细写明各自时间）。
  三处新用例（有入站且超时必红 / 无入站记静默 / 从来没有入站记静默）+ 2 条变异验证（拆掉两个静默期分支，对应用例如期变红）。

## 4. 思考控制与表情匹配（v0.7.4 起）

- **思考控制（按渠道翻译档位、每家独立、可按任务分设）**：`src/core/provider-presets.js`（新增）、
  `src/llm/llm.js`、`src/core/providers.js`、`src/console/app.js`、`ui/app.js`、`src/core/config-legacy.js`。
  失败模式：思考原先只有"开/关"两态、只写一种参数形态，而各家的开关根本不是同一个参数 —— Command Code 认
  `reasoning_effort`（且没有"关"档，`thinking` 字段被网关静默吞掉）、DeepSeek 官方认 `thinking.type=disabled`、
  通义认 `enable_thinking` + `thinking_budget`、OpenAI 用 `none` 当"关"……写死的形态在别的渠道上要么静默失效、
  要么被 400 拒绝。现行做法：语义层只表达意图（跟随服务商默认 / 关 / 低 / 中 / 高 / 最高），由渠道预设按
  baseUrl 主机名翻译成该家真实形态；档位表以官方文档/实测为准，个别未逐字核对的渠道在 `source` 里如实标注、
  由"参数被 400 拒绝就摘除重试"兜底（Command Code 官方无"关"档 → 不列「关」；智谱列「关」并注明
  GLM-5.3/4.7/4.5V 强制思考、选了也会被兜底忽略）。三处细分：**按供应商独立**（`api.thinkingByService[host]` 覆盖全局 `api.thinking`）、
  **按任务分设**（`{chat, judge, write, default}`：聊天 / 判断·总结 / 写作 / 其他，例如"聊天关、判断开"，
  带 `purpose` 的调用点在编排器、表情判断、身份/关系试航、空间互动等处）、**两条逃生口**（`extraBody` 直接并进
  请求体、优先级最高；`thinkingParams` 给不在预设内的渠道自定义档位映射；控制台里清空 JSON 要 `__replace__` 才真删）。
  能力实测（控制台按钮）只报实测到的事实：选"关掉"给"能不能关"的结论，选档位只报这一档能否通过、不含关闭结论；
  请求被 400 拒绝且错误提到 thinking/reasoning 参数时自动摘掉该参数重试一次。默认值不变（`thinking: 'on'`、
  跟随服务商默认），升级不影响既有实例。
- **表情匹配：send_sticker 报「找不到表情」（Issue #17）**：`src/onebot/stickers.js`。
  失败模式：`findSticker` 把标签与备注同池做双向包含、再要求唯一命中，别的表情的短标签擦边命中会把真正的备注
  命中一起否决 → 库里有也返回 null；模型把清单里「备注 [标签]（用过N次）（stickerId：…）」整行抄回来时同样匹配不上。
  现行做法：分级匹配（备注优先，只在同一级内要求唯一）id/md5/url → 备注精确相等 → 备注包含查询 → 查询包含备注 →
  标签；展示性修饰做成"由长到短"的形态阶梯、从最完整形态开始试（备注自身以括号结尾如「裂开（崩溃）」时不会被
  剥短形态劫持到别的条目）；能从「（stickerId：xxx）」里抠出 id 兜底。生产库 37 条清单行 + 截断行实测 66/66 命中。
- **OpenDesign（amr-link 网关）渠道预设**：`src/core/provider-presets.js`、`ui/app.js`、`docs/CONFIG-EXAMPLES.md`。
  失败模式：该网关虽属"聚合网关"一类，行为却与既有的 Command Code 预设不同 —— 四轮探针实测（2026-09-30）表明它
  **吞掉全部 thinking 类参数**（`thinking` / `enable_thinking` / `thinking_budget` / `reasoning` 均被忽略、请求成功
  但推理照跑），只认 `reasoning_effort`；且接受度**逐模型不同**：deepseek 系（v4-flash / v4-flash-vision-exp /
  v4-pro / v4.1-flash）六档全通且 `none` 真正关闭（推理 token 从 100+ 归零，各模型 3 次复现），
  glm-5.3 系只认 low/high/max，传 `none` 与 `medium` 直接 400。
  现行做法：off 映射为 `reasoning_effort: none`（不是历史默认的 `thinking.type` —— 实测会被吞掉），
  档位只列**两端都通过**的 low/high/max（同渠道内模型不同时取交集，与智谱条目同一约定）；`medium` 不进表，
  要它的用户走「额外请求参数」。glm 系的 400 由既有的"400 且文本含 reasoning → 摘参重试"兜底
  （实测该 400 原文命中该正则），故 `canDisable` 保持 `null` 而非 `false` —— 该发 none 让 deepseek 系真关掉。
  模型例：deepseek-v4.1-flash、glm-5.3-flash、kimi-k2.7-code、mimo-v2.6-pro。
- **工具报错写进 journal 并统一脱敏**：`src/core/orchestrator.js`、`src/core/redact.js`（新增）。
  失败模式：工具失败只进控制台异常面板，journal 里查不到，排查时容易漏（Issue #17 的补充建议）。现行做法：
  同一判定口径下补一行 `[tool] … 出错：…`，文本走统一脱敏（与 incident-pilot 入库同一套规则），并把
  `access_token` / `api_key` 这类带下划线前缀的参数名补进规则（旧规则只认 `?token=` / `?key=`，会漏掉本项目
  OneBot 实际写在查询串上的 `access_token`）。

## 5. 引用、记忆与人设（v0.7.3 起）

- **引用块带被引用那条的消息 id**：`src/core/util.js`（`formatQuoteRef` / `quotePrefixFor` / `textWithQuote`）、
  `src/onebot/onebot.js`、`src/llm/prompt.js`、`src/tools/tools-core.js`、`src/console/app.js`。
  失败模式：引用块里只有说话人名和原文、没有消息 id，且机器人自己被引用时显示的是群名片名（历史行里却是「我」）——
  模型定位不到被引用那条、也认不出那是自己说的话，于是对"谁在回谁、哪条在前"给出错误回答（Issue #16）。
  现行做法：统一渲染成 `[引用#102·说话人：原文]`，引用自己的消息标「我」；实时消息、历史记录、翻页工具、
  消息详情、控制台消息接口共用同一套渲染。形态里不放空白（`sanitizeUserText` 会折叠方括号内空白，
  老的前缀判定 `startsWith('[引用 ')` 因此在真实存档上从未命中，历史行会重复贴一次引用、「引用」标签也一直没生效）。
- **过去状态的边界说明与翻页补偿**：`src/llm/prompt.js`、`src/tools/tools-core.js`。
  失败模式：历史只带最近 N 条却没有任何说明，模型把"没看到"当成"不存在"；`pastStateCount` 少算触发批，
  `get_recent_messages` 翻页开头会重复触发批那几条。现行做法：写明条数、`#消息id` 通常随时间递增可核对先后
  （被补课的旧消息/跳号时以行序为准）、更早的用工具往前翻；补偿按"触发批 + 过去状态"计。
  「有历史但这次没带」不再误报"这是你第一次参与这个会话"。
- **emoji 被切成半个导致整次模型请求 400**：`src/core/util.js`（`safeSlice` / `stripLoneSurrogates`）、
  `src/llm/llm.js`（请求前兜底清理）、`src/core/orchestrator.js`、`src/llm/prompt.js`、`src/tools/tools-core.js`、
  `src/console/app.js`。失败模式：记忆"新建印象"把该群友的发言按 200 字符切片，正好切出半个 emoji（孤立代理项），
  模型网关把整次请求判成 400 Bad Request —— 该群友永远建不出印象，控制台只显示"1 位失败（已保留原印象）"。
  实测：原样请求 400，剥掉孤立代理项后同一请求 200 并成功产出印象。现行做法：截断一律走 `safeSlice`（不切断代理对），
  并在请求出口统一清掉孤立代理项。
- **人物记忆的"发现新人"门槛改为控制台可设**：`ui/app.js`、`src/core/orchestrator.js`。
  失败模式：自动整理只在"最近 2000 条里发言 ≥ discoverMinMessages（默认 20 条）"的零印象群友里挑人，
  门槛高于群里多数人的实际活跃度时，新记忆永远不会产生（实测某群：已有印象者 225/127/45 条，
  其余人 16/11/8 条全部够不到门槛）。现行做法：控制台「记忆整理」可设「发现新人的最少发言条数」与
  「单次最多发现几人」，默认值不变。
- **换人设不再残留上一张卡**：`src/llm/prompt.js`、`src/console/app.js`、`ui/app.js`、`roles/*.md`。
  失败模式：换卡 26 小时后仍在用旧卡的口癖（实测：群 433397830 最近 30 条里它自己 8 条带"喵"，群友 0 条，
  而当前卡明文写着"不要：可以哦，喵～"），根因是"自我锚定"——自己上一条的口气、各群的交接/checkpoint、
  表情库里的旧人设道具都在提示词里。现行做法：`persona.changedAt` 由控制台在内容真变时打点，
  24 小时内【过去状态】等段落自动加"旧记录不作数"提示；新增按钮「换人设后清空交接」
  （`POST /api/persona/reset-handoffs`，需确认；不动聊天记录与人物印象）；平台提示词里写死的默认人设元素全部中性化。
- **表情库区分"QQ 收藏表情"与"本地图库"**：`src/onebot/sticker-manager.js`、`src/onebot/stickers.js`、
  `src/tools/tools-core.js`、`src/console/app.js`。失败模式：库里的收藏项存的是消息图片的临时链接，
  发出去是普通图片、链接过期后是坏图；`collect_sticker` 直接进本地库、不判断"是不是表情包"。现行做法：
  收藏即落盘（`sticker-assets/`），清单标出来源与发送形态（〔QQ收藏表情〕/〔本地图库·发出去是图片〕），
  发送前探活、失效不发并给出可照做的提示；QQ 收藏夹上限 500（非会员）因此本地库保留。

## 6. 语音转写与视频（v0.7.2 起）

- **多供应商语音转写**：`src/llm/asr-openai.js`、`asr-local.js`（本机 whisper.cpp）、`src/llm/seed-asr.js`（火山 Seed-ASR）、
  `asr-dashscope.js`（阿里云百炼）、`asr-baidu.js`、`asr-tencent.js`（TC3 签名）、`asr-iflytek.js`（签名 WSS 分帧）+
  `src/tools/audio-transcribe.js`（路由/分片/配额/非语音提示）。四家国内云的短语音接口单次 ≤60 秒，
  统一按 55 秒无损分片再拼接；OpenAI 兼容服务超过 20MB 才切片（25MB 上传上限）。失败模式：长音频被服务端整条拒掉、
  分片中途失败丢掉已计费的前几片、纯音乐/音效被 ASR"编"出一段像模像样的假文本 —— 分别用分片、进度写进错误、
  停顿比例判据（≥3 秒且近静音 <5%）处理，命中时把"别把上面的文字当作事实讲"一并交给模型。
- **QQ 语音是 SILK**：`src/llm/silk.js`。真实字节是 `.#!SILK_V3`（文件名写着 `.amr`、CDN 回 `content-type: audio/mp3`，
  都不可信），ffmpeg 没有 SILK 解码器 → 一律 "Invalid data found"。协议端的 `get_record` 不会转码
  （实测传 `out_format=mp3/wav` 仍返回同一个 CDN URL），因此用 `silk-wasm`（WASM，延迟加载）在本地解成
  16k 单声道 PCM。协议端只给文件名、没给 URL 时，语音走 `get_record`、群/私聊文件走
  `get_group_file_url` / `get_private_file_url` 换地址。
- **视频"看画面 + 听声音"**：`src/onebot/onebot.js`（video 段与视频类文件段各留 audio/video 两条）、
  `src/tools/image-downsample.js`（`convertVideoToFrameStrip`：ffprobe 取时长 → 均匀抽 4 帧拼 2×2 JPEG）、
  `src/tools/tools-core.js`（`get_message_images` 按 kind 分流）。失败模式：只采音轨时模型会回"视频只能听声音"
  （用户实测反馈），画面根本没进过模型的眼睛。

## 7. 对话行为

- **分条发言（多气泡）**：`src/llm/prompt.js`。失败形态有两种：一是"把想说的全塞进一条长消息"，二是"用空格把两句连成一条"。补丁注释记录，v1 之前实测 90% 的情况只发一条；v2 在尾部加了"别把一轮压成一句点评"，并明确"一轮常见 2-3 条短句、单条多数 ≤30 字、别一口气刷 4 条以上"。配套的 `humanRhythm` / 主体性文本属于上游自带内容，未通过脚本改动。
- **提示词调优**：`src/llm/prompt.js`、`src/llm/qzone-interaction-prompt.js`。把"被 @ 或直接提问时优先判断是否需要回应"改成"被 @、点名或直接提问时默认要回一句（可以短、可以敷衍、可以怼回去），只有明显与你无关、对方 @ 别人、或纯刷屏误 @ 时才不回"（v0.6.3 起把其中的"可以怼回去"进一步软化为"也可以就回一句不痛不痒的"）；同时统一了"图库可以自己攒"的用法说明。
- **聊天关思考**：`src/llm/llm.js`、`src/core/orchestrator.js`。聊天主调用传 `purpose:'chat'`，不携带 thinking 字段；判断/写作类调用不传，走 `default:'on'`。配置 `api.thinking = {chat:'off', default:'on'}`；脚本幂等，写配置前才停服务。
- **看图先读情绪**：`src/llm/prompt.js`、`src/tools/tools-core.js`。模型看表情包/图片时容易去"描述画面"；改成先定性情绪再回话，v2 进一步收紧并给出正反例。顺手修了一个缺失：看库内表情时只给了 `desc`，没给模型自己写的 `localNote`。

## 8. 发送链路健壮性

- **消息 id 归一化**：`src/tools/tools-core.js`、`src/core/store.js`。模型常把提示词里的 `#123` 连 `#` 一起传回来，而 OneBot 只认纯数字 id。关键教训：`tools-core.js` 用到的 `normalizeMid` 必须在同一个文件里定义（`store.js` 里那份是模块私有、没有 export），早先只替换调用点没插 helper，结果每次 `send_message` / `send_sticker` / `send_face` 都抛 `normalizeMid is not defined`，机器人一个字都发不出去。所以脚本把"插 helper"和"替换调用点"绑在一起，并且在最后自检两者必须同时存在。
- **发送网络级重试**：`src/onebot/sender.js`。协议端重启或连接被掐时会抛 `fetch failed`，原来直接丢消息（用户视角是"它没回我"）；网络层错误重试一次即可救回，限频/参数类错误不重试（重试也没用）。回归用例见 `test/local/test-sender-retry.mjs`。
- **内联工具调用兜底**：新增 `src/tools/inline-tools.js`，并接入编排器之外的所有判断类模块（空间互动 / 每日说说 / 身份评估 / 关系评估 / 表情收藏判断）。失败模式：模型有时不返回原生 `tool_calls`，而是写成 `<tool_call><function=...>` 文本或带 `name` 的 JSON，这些模块只认原生结构 → 决定被当成"没提交"丢掉（线上出现过"关系评估模型未提交唯一的 submit_relationship_events 结果"、以及"模型两次都没提交决定，这次跳过"）。做法是把编排器里的解析器抽成共享模块，新增 `resolveToolCalls(message)` 统一成 OpenAI 结构，其余代码照旧读 `call.function.name / arguments`。
- **启动/重连补课**：`src/console/app.js`。服务重启或协议端断线期间，消息事件会丢——消息根本没进库，也就永远没人回。做法：连上 OneBot（含重连）后从协议端拉一次最近历史，把库里没有的消息按 mid 去重补进来；≤30 分钟的按新消息处理（会触发回应），更早的只补进记录、不吵人。
- **自检与静态扫描**：`src/ops.js scan`（原为 `ops/check-undefined-calls.sh` + `ops/scan-undefined-calls.py`，现已并入项目代码）。上面那次"整夜发不出一个字"的事故表现像"静默/掉线"，很难查；于是加了一个只记日志、永远 `exit 0`、不阻断启动的自检，挂在服务启动链上，另配 `src/ops.js audit` 的补丁标记检查做部署验收。

## 9. 贴纸（表情包）系统

- **自动收藏**：`src/onebot/sticker-manager.js`、`src/onebot/stickers.js`、`src/console/app.js`、`src/core/config-legacy.js`。让模型看一眼别人发的图，自己判断值不值得收（值得就存并写备注）；入口改成异步判断，不阻塞消息处理。条目保留 `srcKey` 作为去重键。
- **收藏判断健壮性**：`src/onebot/sticker-manager.js`。两个失败模式：模型有时把决定写成 `<tool_call>` 文本或裸 JSON（判断逻辑只认结构化 `tool_calls` → 决定丢失）；`max_tokens=200` 会被"思考"吃掉（实测思考 80-595 token），截断后一个字段都收不到 → 提到 600。另外内容过滤是概率性的（实测同图 20/20 通过、偶发被挡），把尝试次数 2 提到 3，并把"被服务商内容过滤"和"模型没提交"在日志里分开。
- **收藏去向与同步安全**：`src/onebot/sticker-manager.js`（优先加进 QQ 收藏表情，链接稳定、QQ 端也能用，失败退回本地库）、`src/onebot/stickers.js`（QQ 收藏列表为空或接口失败时不剪枝——否则接口一抖，本地库连同 AI 写的备注会被清空）。
- **查找与备注**：`src/onebot/stickers.js`、`src/tools/tools-core.js`、`src/onebot/sticker-manager.js`。线上连续出现 5 次"找不到表情 NNN"，编号其实来自来信里的 `[表情NNN]` 标签，模型却拿去当表情库 id 查。于是：来信把系统表情标成 `[QQ表情N 名字]`；找不到时把有效 id 回给模型；`findSticker` 增加"唯一命中"的模糊兜底，提示改为直接用备注名选图；备注上限 16 → 24 字（真图实测里 16 字会把一句话硬切）。
- **标签与收录规则**：`src/console/app.js`、`src/llm/prompt.js`、`src/tools/tools-core.js`、`src/onebot/stickers.js`、`src/onebot/sticker-manager.js`。表情包消息显示 `[表情包]`（普通图仍是 `[图片]`）；收藏规则收紧到"只认真正的表情包"，生活照/随手拍/自拍不收；相关文案统一叫"表情包"。

## 10. 主动发言与空间互动

- **开话题节奏**：`src/core/orchestrator.js`。间隔定为 2.5-3.5 小时；"没有安静的群"这种空转不算消耗本轮（45 分钟后再看）。概率、冷场阈值属于部署方偏好，脚本不强制。
- **间隔守卫**：`src/core/orchestrator.js`。tick 第一次在启动后 15 秒触发，所以每重启一次就会多一次开话题判定，与"几小时才概率开一次"的设定不符。改为把"上次判定时间"落盘，重启后不足一个间隔直接跳过（补丁标记 `minGapMs`、`writeProactiveLastAttempt`）。
- **可观测性**：`src/core/orchestrator.js`。原来整个 tick 一条日志都没有，出问题时完全没法查；现在跳过原因和真正开话题都记日志，每次 tick 最多一行，不会刷屏。
- **活跃时段**：`src/core/orchestrator.js`（支持多个窗口，如 9-12 与 14-24，窗口外不开口也不浪费间隔；调度上直接把下一次排到窗口开始）、`src/features/qzone-interactions.js`（空间互动有独立时段，不影响聊天回复）。
- **失败退避**：`src/features/qzone-interactions.js`。一次失败风暴里 3 分钟打了 191 次（失败后按 -1s 下限重排，等于每秒重试），QQ 直接回"使用人数过多，请稍后再试"。改为成功后清零失败计数、排下一次检查时加指数退避下限。回归用例见 `test/local/test-qzone-backoff.mjs`（23 秒内只尝试一次，下一次排到分钟级）。
- **抓取容错与通知阈值**：`src/features/qzone-interactions.js`、`ui/app.js`。好友动态这条外呼在腾讯侧被限流时会回 `{code:-10001, message:"network busy"}`（协议端原样透传），而它此前是硬失败：一次限流就让整轮——包括评论检查和已积压的未读——全部不跑，还会立刻顶一条"错误"级异常通知。现在抓取失败先等 45 秒重试一次（中止信号可打断等待）；仍失败只记 `run.feedError`，本轮继续跑评论检查与积压，运行记录标为「好友动态未取到」并在控制台显示原因；失败计数与退避照旧（2→4→8→16→30 分钟），连续第 3 次才发异常通知；失败轮不算建立动态基线，免得把上线前的旧动态当成新内容。用例：`test/qzone-interactions.test.mjs`、`test/local/test-qzone-backoff.mjs`、`test/local/test-qzone-intervals.mjs`。
- **每日说说容错**：`src/features/daily-moments.js`。空间列表读不到时跳过查重，不阻断发布。

## 11. 运维与控制台

- **控制台端口探测**：`src/console/integrations.js`。上游把 SnowLuma / noVNC 地址写死为旧端口 15099 / 16081，而 Linux 全栈部署实际使用 5099 / 6081，导致"服务与访问控制"页误报"不可达"。改为按实际部署端口探测，并修正改 SnowLuma 密码时的地址兜底端口。
- **控制台自动登录**：`ui/app.js`（地址栏带 `?token=` 时先自动登录，成功后清掉 URL 里的明文令牌再重载，避免留在浏览历史）、`src/console/app.js`（登录 cookie 加 `Max-Age`，避免关掉浏览器就要重新输令牌）。
- **会话列表轮询**：`ui/app.js`。首次 `startListPoller()` 在配置加载前执行会落到 4000ms 兜底值，导致会话列表每 4 秒重建一次（界面闪烁）；配置就绪后重新校准一次轮询间隔。
- **只在源码变化时重启**：部署链每小时会跑一遍所有补丁脚本，无条件重启会让服务每小时被重启多次、打断正在进行的对话；于是加哈希比对，源码没变就跳过重启。
- **运维工具与回归测试**：`src/ops.js`（单入口，详见 `docs/OPS.md`）与 `test/local/`（详见 `test/local/README.md`），均为本仓库新增。原 `ops/` 目录下的 shell/python 脚本已全部移植进 `src/ops.js`，目录本身已删除；开发机私有的 ssh 文件传输/执行脚本不再随仓库分发，远程执行直接用 `ssh`/`scp`。
- **关闭上游调试探针**：`src/*.js`、`ui/*.js`。上游作者在自己开发机上留了一批调试上报（往其私网地址的 7777/7780 端口发数据），与本项目无关，已全部关闭（守卫条件置假 + 目标地址换成本机兜底）。
