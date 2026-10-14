# 控制台手工烟测清单（UI-SMOKE）

## 跑团工作台

- [ ] 左侧「跑团」打开后有独立设置、两个卡片编辑器、使用说明和存档列表，关闭时仍可编辑卡片。
- [ ] 群聊／私聊白名单分开填写，空名单提示禁止开团；保存后立即生效，刷新与切页保留未保存的名单草稿。
- [ ] 白名单会话开始后普通消息自动作为行动，团主发送「退出游戏」后恢复聊天；旁观者不能推进剧情，名单外会话不能开团。
- [ ] 新建世界与角色、编辑已有卡、导入JSON/TXT，保存后得到ID；导出JSON可重新导入。
- [ ] 卡片名称和设定中的HTML按文字显示；刷新存档、切换页签不会清空编辑中的草稿。
- [ ] 默认示例团在QQ开团后，网页可看到玩家HP、背包、地点、剧情与骰点。
- [ ] 暂停/结束/删除操作先确认，只有已结束的团能删除；卡片删除不改动团内快照。
- [ ] 窄屏两个编辑器上下排列，长设定和长存档不撑出屏幕。

自动化只覆盖到「渲染函数不抛异常 + 真实 DOM 能加载 + 钩子接上了」这三层
（`test/render-test.mjs`、`test/scroll-test.mjs`、`test/usage-e2e.mjs`、
`test/ui-smoke.test.mjs`、`test/ui-module-graph.test.mjs`、`test/ui-real-modules.test.mjs`、
`test/ui-modules.test.mjs`、`test/ui-registry.test.mjs`、`test/static-cache.test.mjs`）。
各文件的条数随用例增减，这里不再抄 —— 判据是全部通过，不是某个数字。
**布局、事件、真实数据下的
观感只有人看得见**，所以每次动到 `ui/` 就照下面走一遍。

> **`ui-modules` / `ui-module-graph` / `ui-real-modules` / `ui-smoke` 不是可选用例。**
> ui/ 已拆成一堆 ES module（2026-10-01 起）：文件漏加载、漏写一个 import、模块求值期踩 TDZ，
> 浏览器里可能是**白屏**、也可能只是某个页面空白或某个外挂改造悄悄失效
> （`status-refresh.js` 掉了就是"状态不再自动刷新"，页面上看不出异常）。
> 注意分工：vm 沙箱（render / scroll / usage / ui-smoke）是"剥掉 import/export 按 classic 跑"，
> 对真模块语义**是瞎的**；管模块图与求值期行为的是 `ui-module-graph`（静态）与
> `ui-real-modules`（用真 ESM 加载器加载整棵树）。

打开方式见 [`../AGENTS.md`](../AGENTS.md)（`console-tunnel.bat` 或
`SSHHOST=user@host node src/ops.js console --open`）。

## 0. 前置

- [ ] 页头没有「控制台已更新 · 点击刷新」的黄条（有就说明拿到的还是旧 JS，先刷新）
- [ ] 浏览器控制台（F12）没有任何红色报错；`console.warn` 里没有 `[QARegistry]` 开头的行
      —— 出现 `[QARegistry] xxx 抛错，已跳过该钩子` 就是某个插件钩子挂了（页面不会白，但那段改造没生效）
- [ ] 在控制台里执行 `QARegistry.snapshot()`：`bases` 应有 8 个入口、`overrides` 应有 3 个
      （`refreshStatus` / `renderLifecycleOverview` / `loadFriendFeaturePage`）、
      `transforms` 应有 `renderExperimentalSettingsSection`、`afters` 应有 4 个渲染页
      （`QARegistry` 是 ui/ 里**有意留在 window 上**的两个东西之一，另一个是 `QAText`；
      其余函数不再是全局 —— 想从控制台驱动界面，点 DOM 而不是敲 `switchTab('usage')`）
- [ ] 页面能点：点一个页签有反应。**module 是 defer 语义**，启动挂在 `DOMContentLoaded` 上；
      若整页点不动、连报错都没有，先看 Network 里那批 js 是不是 200/304 都拿到了
      （js 现在不带 `?v=` 令牌、走回源校验，这是 2026-10-01 有意改的）

## 1. 顶栏与总览

- [ ] OneBot 状态点/文字正常；鼠标悬停能看到失败原因（未连接时）
- [ ] 「模型 / 今日用量 / 搜索」三段文字不换行、不被截断（窄窗口拉伸一次再看）
- [ ] 暂停按钮文字在「暂停 / 恢复」间正确切换
- [ ] 生命周期卡片（有 lifecycle 会话时）底部显示「结束原因」—— 这是
      `status-refresh.js` 的 `renderLifecycleOverview` 接管在起作用

## 2. 设置页（去插件化的主要风险面）

- [ ] 左侧 16 个分区都能点开，切页不残留上一页的内容
- [ ] **页面顶部有「全局管理员 QQ」面板**（`renderSettings` 的 after 钩子），
      填一个非法值（如 `abc`）保存 → 就地提示「必须为 5 到 15 位数字」，不发请求
- [ ] **「设置 → 实验功能」里看不到已转正/退役的控件**
      （`renderExperimentalSettingsSection` 的 transform 钩子）：
      人物统一印象、主动好友、黑话试点、异常处理试点这四项的"启停"开关不应出现
- [ ] 「设置 → 实验功能」里没有"黑话研究"那一段（同一钩子顺带摘掉的）
- [ ] 设置页滚动到底，所有区块都渲染完整（没有半截 html）

## 3. 人物印象 / 好友管理 / 异常

- [ ] 三个页面打开都有内容，且**没有区域被整块删除**
- [ ] 人物印象页与异常页**不该再出现旧文案**「统一身份库」「异常处理试点」
      （实际渲染：tab 标签是「人物印象」，页头是「人物统一印象」、异常页是「异常处理…」——
      判据以"旧文案不出现"为准，别拿页头必须等于 tab 名去卡）
- [ ] 好友管理页右上角有「手动触发评分」按钮（`loadFriendFeaturePage` 接管加的），
      点开弹窗能列出身位库里的人；`state.config` 未加载时按钮为灰
- [ ] 好友候选/入站申请的旧「owner」输入框已被隐藏成 hidden input（不应再看到可编辑的旧输入框）

## 4. 会话页 / 存档页

- [ ] 会话列表按 key 增量更新：连点刷新，行的 DOM 不整块重建（不闪）
- [ ] 存档页滚到底能继续加载更早的消息；切群时旧请求晚回来不会覆盖新群
- [ ] 「当前版本」显示成 `v<版本号> · <提交号>`（如 `v0.7.5 · ec02a8b…`）；未提交树部署时退化成
      `v<版本号> · 未提交版本 · 时间`，不是被截断的裸串

## 5. 改完 UI 之后

- [ ] `npm run lint`（0 error；含 `ui/` 的体积闸门 `max-lines` 1800）
- [ ] `node test/render-test.mjs` → ALL PASSED
- [ ] `node test/scroll-test.mjs` → ALL PASSED
- [ ] `node test/usage-e2e.mjs` → ALL PASSED
- [ ] `node --test test/ui-smoke.test.mjs test/ui-module-graph.test.mjs test/ui-real-modules.test.mjs test/ui-registry.test.mjs test/ui-modules.test.mjs`
      注：**缺 devDeps 时这几条会整体跳过**（`ui-smoke` / `ui-real-modules` 要 happy-dom，
      `ui-module-graph` 要 espree / eslint-scope）—— 生产与更新器环境按 D6 约定就是
      `npm ci --omit=dev`，跳过是约定不是漏测；它们由 CI 与本地开发环境覆盖。
- [ ] `node --test test/static-cache.test.mjs`（动了 `src/console/app.js` 的静态服务才需要：
      它盯 HTML 里的内容哈希令牌、js 不带令牌、immutable 头与真 304）
- [ ] 跨文件引用一律 `import`，**别再加共享全局**：`test/ui-module-graph.test.mjs` 会判红
      （未解析引用只剩浏览器内建才放行；另外它还管"不许导出 let/var、不许写 import 绑定、
      求值期不踩 TDZ、除 `QARegistry`·`QAText` 外不许挂 window"）
- [ ] 新增/删除 `ui/**/*.js` 时，**同时**改 `ui/index.html` 的 script 清单 ——
      `test/ui-modules.test.mjs` 双向核对，且每个 `<script src>` 都得是 `type="module"`

