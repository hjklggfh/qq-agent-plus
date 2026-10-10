# 市场扩展兼容层

项目可以在同一进程内加载一部分来自 QQ-agent 市场的扩展。兼容层默认关闭，市场代码必须放在独立目录，并且必须同时出现在 `plugins.marketEnabled` 和 `plugins.marketApproved` 中。

```json
{
  "plugins": {
    "marketRoots": ["/mnt/data/qq-agent/market-extensions"],
    "marketEnabled": ["bangumi-lookup"],
    "marketApproved": {
      "bangumi-lookup": { "digest": "..." }
    },
    "marketSettings": {
      "bangumi-lookup": { "defaultLimit": 5 }
    }
  }
}
```

目前支持 `skill.json` / 旧式 `plugin.json`、`setup(api)`、`api.registerTool`、`api.config`（对象和函数两种写法）、`api.log`（函数和分级方法两种写法）、声明 `web_fetch` 后的受限 `api.fetch`、`available()` 以及 `prompt.sections`。

市场工具会变成 `<skill-id>__<tool-id>`，例如 `bangumi-lookup__search`，再和内置工具、原生插件工具一起交给模型。网络请求仍经过宿主的 SSRF 防护、响应大小和超时限制。

兼容层暂不提供 hooks、providers、OneBot、memory、store、后台定时器和图片发送能力。市场扩展是同进程代码，审批快照用于防止版本或权限变化后静默加载，并不构成进程级沙箱。

审批快照可用 `marketManifestFingerprint()` 生成；控制台接入市场扩展管理页之前，建议先在受控环境中读取清单、审查代码，再把该快照写入 `plugins.marketApproved`。
