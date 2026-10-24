# 跨对话认人与具体回忆

入口：「设置 → 记忆整理 → 跨对话认人与回忆」。既有人物印象仍按QQ号全局管理；
本功能补充其他窗口的具体消息片段。升级默认不自动启用；启用后默认不打开聊天隐私。
隐私关闭意味着同一人在允许群聊与私聊里的内容可以用于当前回答。

```json
{ "memory": { "crossChat": {
  "enabled": true, "privacy": false, "maxChars": 1200, "maxMessages": 4, "lookbackDays": 30
} } }
```

只认本轮实际说话者的QQ号，不用昵称推测身份；每次最多2人、2个来源窗口。
从现有SQLite消息库按发送者索引读取最近120条候选，再按时间范围、关键词和来源权限筛选。
群聊只补充明确 `target_user_id` 对应此人的机器人回复；私聊取其发言后5分钟内、下一次发言前的回复。
不会混入其他人的发言、游戏秘密事件、被禁止会话或被屏蔽成员的消息。
保留的记录不完整时，不声称记得整段历史；清理掉的存档不能恢复。

默认自动回忆最多4条、合计1200字符（含来源、时间、说明）；balanced模式最多900字符，
aggressive最多600字符。未命中不添加提示词，不调用额外模型，不复制消息建第二套记忆库。
`recall_conversations` 可按QQ号及短关键词追加检索，每轮最多2次，每次使用同样预算。
字符上限不是精确Token上限，工具定义及模型回答也有成本。动态片段在用户上下文中，保持系统前缀稳定。

「开启聊天隐私」优先于回忆开关：不查询、不注入其他窗口原文，印象只接受纯当前窗口来源，
拒绝混合来源与来源不明的印象；暂不注入旧交接和线程摘要。切换可见性/访问范围会取消
在途聊天并关闭旧线程；生命周期提示词指纹也包含该策略，重启后不会复用旧策略上下文。
本轮读到跨窗口片段后不允许通过 `memory_append` 改存为当前窗口印象。
存档和人物数据保留，关闭隐私后可再次按权限使用。已经发到QQ当前窗口的消息无法撤回，
它们仍属于当前窗口历史；该开关不是删除历史或遗忘已公开内容。

旧 `memory.visibility.mode=perChat` 同样禁止跨窗口片段；
`hidePrivateInGroup=true` 继续阻止私聊原文进入群聊。需要完整跨窗口回忆时选全局可见性，
关闭隐藏私聊来源和聊天隐私。控制台管理员仍可管理原有存档。

实现入口：`src/memory/cross-chat-policy.js`、`src/memory/cross-chat-recall.js`、
`ChatStore.recallPersonMessages()`、`buildUserPrompt()`、`recall_conversations`。
验证：`test/cross-chat-recall.test.mjs`、`test/recall-config-api.test.mjs`、`test/ui-smoke.test.mjs`。
关闭回忆或回滚代码均不需要删除配置、消息库或人物记忆。
