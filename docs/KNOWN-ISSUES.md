# 已知问题

本文档仅记录**当前基线上稳定复现、尚未修复**的问题，以避免 CI 重复报告同一问题。
问题修复后即从本文档删除。

## 待修问题

### 2026-09-22 全量审查确认、本轮不修的问题

**5 秒兜底重试 ticker 不检查自主节奏（pacing）开关。** `orchestrator.js` 的 5 秒 ticker
会对启用 pacing 的会话直接调用 `scheduleWake`，绕过 `#ensurePacedWake` 的排队。
仅在启用「自主节奏」实验功能时可能触发，会导致个别批次不经过节奏队列。

（同批记录的「远程价格表切成 `none` 后本进程仍沿用旧表」已于 2026-09-23 修复：
`initPriceFeed` 的关闭分支现在会 `setRemotePrices({})` 当场回落到内置表，
磁盘缓存仍按设计保留，重新启用时先顶上。）

## 历史问题（已全部修复）

### 控制台查询串令牌（2026-10-06 已修）

`authorize()` 现只允许 `/api/events` 使用 `?token=`（浏览器 EventSource 无法加自定义请求头）；
普通 API 已拒绝查询串令牌，`test/review-2026-10-06.test.mjs` 覆盖正反两条路径。控制台首页
自动登录仍会从地址栏剥掉令牌。2026-10-21 同步修正了 `src/ops.js` 两处仍用查询串访问
`/api/status` 的旧调用，改用 `x-console-token` 头。

### 成本口径复审记录的 6 项问题（2026-09-21 记录，同日全部修复）

v0.6.0..v0.6.4 之间复审成本口径时记录的 6 项“不影响主链路”的问题，随后已全部修复，
修复原因均写入 `src/pricing/`、`ui/app.js`、`docs/model-prices.md`：

1. 更换远程表地址且新地址拉取失败时，界面无法区分实际生效的地址 → `priceFeedStatus()` 增加
   `sourceStale`，设置页明确提示“当前生效的仍是上一次成功拉取的旧地址”。
2. 两次刷新重叠时没有并发保护 → `refreshPriceFeed` 采用单飞：同一组地址复用同一次请求，
   地址变化时排队，后到的旧结果不会覆盖新结果。
3. 别名 `from`/`until` 写成非法日期时被静默忽略 → 解析失败即整条别名不生效（fail-closed）。
4. 手工修改 `config.json` 删除渠道不撤销已注入的价目表 → `initChannelPrices` 按配置对齐注入，
   删除的渠道即时撤表，无需重启。
5. 全 0 的自定义价与 `costMultiplier: 0` 被当作未填写 → 0 是合法价格（免费），
   判据改为是否写入 `in`/`out` 字段。
6. 「当前模型单价」卡片与「全局兜底单价」共用一组输入框 → 拆分为「生效价」（只读展示）与
   「自填单价」（仅在保存确实生效时可编辑，停用时说明原因）。

另有 `friend_opportunities` 缺少保留策略，已连同 `friend_proposals`、`incoming_friend_requests`
一起补充 90 天清理（`IdentityStore.pruneLedgers`，启动时清理过期的**已了结**行，未决待办不删）。

本文档历史上还记录过 5 个随底座引入的基线失败用例（2026-09-19 已全部修复）：

- `configure-linux` 生成的 `config.json` 权限被防抖保存回退为 0664 → 修复：所有写盘路径
  统一 `mode: 0o600`（`src/core/config-legacy.js` 的 `scheduleConfigSave`）。
- 「禁用身份基建后不建库」：该用例验证的是旧契约。身份与事件基建已按
  `src/core/stable-feature-policy.js` 转为默认开启，用例改写为「转正后旧的 enabled:false 被忽略」。
- 「好友候选批准分发」：分发链路同样已转为默认开启，测试桩补充 `get_login_info` 与
  `sendFriendRequest` 桩件，断言改为「批准即发送」。
- 事件列表计数 `2 !== 1`：`app.start()` 无法连接 OneBot 时会自动捕获一条连接事件，
  属于正常基建行为；用例改为仅断言自身注入的那条（按 `source` 过滤）。
- 「已确认黑话」注入：黑话研究已下线（slangPilot retired），提示词不再注入任何黑话；
  用例改写为「即使旧配置开启、slang.json 存在也不注入」（防跨群泄露的原始目标保留）。

## 环境相关（不属于项目问题）

在 Windows 上执行 `npm run test:unit` 会有 43 个用例失败（2026-10-01 实测基线，仅 Windows 本机特有：
docker/systemd/linux 集成类）；
在 Linux 服务器与 CI（ubuntu-latest）上全量通过。判断"有没有新增失败"的办法：把 `✖` 用例名
（去掉耗时）排序后与上一份日志做差集，失败集合逐条一致 = 零回归。

`test/usage-e2e.mjs` 起的真服务用的是配置里的控制台端口（`app.start()` 不收参数，
文件里那个 40995 不起作用），所以机器上已经跑着机器人时它会以 `EADDRINUSE` 退出 ——
只有在本机没有实例占用该端口时才能跑。它不在更新器的部署前测试集里
（那一集只跑 `test/*.test.mjs`），因此不影响「立即更新」。

## 主动好友候选功能已退役（2026-09-25）

**"主动加好友"整个功能已退役**（候选生成、审批、派发全部关闭），原因：

1. **协议路径被服务端统一拒绝**：`friendlist.addFriend` JCE 包能被解析并回包，
   但业务码恒为 1（"添加失败，请稍后再试"），与参数、目标、验证方式全部无关
   （陌生人 / 已好友 / 机器人自己 / 参数矩阵扫描均同一结果，详见 Issue #10）。
2. **上游明确不做**：GUI 实际走 NTQQ 内核 `NodeIKernelBuddyService::reqToAddFriends`；
   向 SnowLuma 请求暴露该能力的 issue（#480）被维护者关闭为 not_planned
   （"公开版不会加主动加好友功能，该功能过于敏感"）。开源生态亦无可参考实现。
3. **风控代价**：连续派发实验已实际触发 QQ 官方设备风控警告。该功能即使可用，
   自动化加好友本身也是风控敏感行为。
4. **滥用风险**：开箱即用的自动化批量加好友能力，极易被拿去做营销骚扰、
   灰产引流等滥用场景，不适合作为开源机器人仓库的内置功能。

### 退役方式

- `src/core/stable-feature-policy.js`：每次落盘强制
  `identityPilot.friendProposal.enabled=false`（毕业不变量反转为退役不变量，
  配置无法重新开启）；
- `src/core/config.js`：`friendProposalEnabled()` 硬编码 `return false`；
- 提案照常生成的前提已不存在，审批与派发入口全部被功能门拦截；
- 历史提案数据（friend_proposals 表）保留在身份库中备查；
- **入站好友请求处理（`incomingFriendRequest`）不受影响**：别人主动发送的
  好友申请仍可在 Web 控制台审批，批准后自动加入私聊白名单。

如需给机器人增加好友，请在 SnowLuma 的 noVNC 界面手动操作（GUI 路径正常）。

## 自动更新状态文件跨进程竞态（2026-10-21 已修）

`src/auto-update.js` 的 `writeAutoUpdateState()` 现在以 `auto-update.json.lock` 目录保护整段
读—合并—写；应用进程与独立更新器共用这一个函数。锁竞争等待最多 5 秒；持锁进程仍存活时
不会因时间较长而夺锁，进程退出且锁目录超过 30 秒后才接管。通知发送前、成功后和失败后
的状态更新还会核对当前通知快照；新一轮失败不会被上一轮通知的收尾写覆盖。

`src/ops.js` 对控制台状态接口使用 `x-console-token` 请求头，避免旧的 `?token=` 调用被
当前鉴权策略拒绝。回归用例见 `test/auto-update.test.mjs`。

### 历史问题与边界

原记录（`notification` 单槽）：`data/auto-update.json` 的 `notification` 只有一个槽位。Agent
发送通知的数秒窗口里，如果另一个写入方（updater 独立进程、或控制台手动更新的失败路径）恰好
写入了一条**新的**待发通知，发送完成时的收尾写会把整份旧快照盖回去——新通知被标成"已发"而
静默丢失。触发要求两次失败落进同一次发送窗口，概率很低。

扩写（2026-09-29 审查）：这不只是 `notification` 一个字段的问题——**整个
`auto-update.json` 都是"读—改—写"且没有跨进程互斥**。写入方有两个进程：
应用进程（`src/auto-update.js` 的 manager，处理控制台的暂停/恢复/立即更新；以及
`src/update-notice.js` 写通知与忽略版本）和 updater 独立进程（`scripts/auto-update.mjs`
在连通性/检查/部署各阶段写状态）。后写者用自己那份整文件快照覆盖，因此**并发时丢的是
"另一个进程刚改的字段"**（例如你点"暂停"的同时一个计划运行正在推进阶段），而不是把文件写坏
——写入本身是原子的（`writeObject` 走 tmp + rename + 0600，`readObject` 解析失败回落 `{}`）。

旧实现可能让控制台显示的阶段/状态、通知、忽略版本短暂回退或丢失；它不影响部署是否成功，
也不影响代码与数据的完整性。本次锁只保护 `auto-update.json`，不替代更新器自身的部署互斥锁。

> **2026-10-01 历史补注**：当时只修了**另一把锁** —— updater 自己的运行互斥
> `data/.auto-update.lock`（防止两次更新同时跑）：原先它①只有 `pid > 0` 才检查属主活没活
> （空/坏锁会被立刻抢走）、②接管是 `unlink + open('wx')` 两步、不是原子对（并发时互相
> 删掉对方的锁）、③接管互斥文件没有陈旧兜底。现在：空/坏锁按 mtime 给 5 分钟宽限、
> 接管走 `.takeover` 互斥文件（互斥本身也带 5 分钟陈旧兜底）、拿到互斥后**再判一次**
> 才删锁，errno 非 ESRCH 一律按"进程还在"处理（busy 按 0 退出，不会连累 `disableOnFailure`）。
> 当时"两个 updater 同时部署"已有保护；跨进程状态写入保护于 2026-10-21 补齐。
