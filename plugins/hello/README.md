# 官方示例插件：hello

随仓库分发的示例，**默认不启用**。两个用途：

1. 当 [`docs/PLUGINS.md`](../../docs/PLUGINS.md) 的活文档 —— manifest、能力声明、
   `activate(api)`、`registerTool`、工具返回值的写法都在这里跑得通；
2. 当手工验证的靶子：启用后跟机器人说句话，就能确认整条链路（装载 → 注入工具 →
   模型调用 → 发消息 → 存储）是通的。

它只用了三个能力：`chat:send`、`chat:read`、`storage`。没有 `http` / `secrets`，
所以这个插件里 `toolCtx.fetch` 与 `api.secret` **根本不存在** —— 这正是能力清单的用法示范。

## 启用

在 `config.json` 里加上审批快照（`capabilities` 与 `tools` 必须**排序后逐字一致**）：

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

然后重启服务：

```bash
systemctl --user restart qq-agent-linux.service
```

> 不想手抄这份清单就先只写 `enabled: ["hello"]`：重启后启动日志与控制台的插件页会告诉你
> 它停在 `pending-approval`，并把待确认的能力/工具列出来，照抄即可。

## 验证

- 启动日志出现 `[plugin] 插件：已加载 1 个（工具 2 个）…`；
- 跟机器人（在它的白名单会话里）说「用 hello_count 打个招呼」
  → 它应该调这个工具并发出一条「你好，这是第 1 次被叫到。」；
- 再叫一次，计数变 2（说明 `plugin-state/hello/kv.json` 真的在持久化）；
- 重启服务后再叫，计数**继续累加**（不是从 1 开始）；
- 想看坏插件的表现：随便改坏 `index.js` 的一处语法，重启后这个插件应是 `failed` 并给出原因，
  而机器人本身照常聊天。

## 停用

把 `enabled` 里的 `hello` 去掉后重启。计数留在 `<数据目录>/plugin-state/hello/`，
**不会**跟着插件目录一起被删 —— 想彻底清掉就连那个目录一起删。
