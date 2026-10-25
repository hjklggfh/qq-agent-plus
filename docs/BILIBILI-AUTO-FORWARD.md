# B 站视频自动转发

该功能由宿主入站事件直接处理，不调用模型，也不消耗模型 token。默认关闭。

## 依赖

使用 B 站公开 API 和 Node 下载单文件 MP4，需要服务器能访问 B 站 API 与视频 CDN；不依赖 yt-dlp 或 ffmpeg。

## 配置

在控制台保存配置（或编辑数据目录中的 `config.json`）的 `bilibili` 段：

```json
{
  "bilibili": {
    "enabled": true,
    "maxDurationSeconds": 900,
    "maxFileBytes": 314572800,
    "maxConcurrent": 1,
    "rejectCollections": true,
    "preferredUploader": "",
    "searchMaxDurationSeconds": 900,
    "searchLimit": 5,
    "searchSort": "relevance",
    "keywordCompletion": true
  }
}
```

收到群消息中的 `bilibili.com`、`www.bilibili.com` 或 `b23.tv` 链接（包括 QQ 的 JSON/XML 分享卡片）后，先下载视频；下载成功后，引用原消息发送一条图文详情（封面、标题、原视频链接、作者，以及播放/弹幕、点赞/投币、收藏/评论），紧接着发送可播放视频，不等待下一轮消息。下载失败只提示原因，不提前发送详情卡片。统计来自本次 API 返回，缺失标为“未知”；封面获取失败时退回引用文字详情，随后仍发送视频。QQ 客户端决定具体气泡样式和两条消息的显示间隔。

任务受全局并发上限约束，发送由宿主队列按会话串行；同一会话里正在处理的链接不会重复入队，发送成功的同一链接六小时内防重。下载或明确发送失败后可重新提交；图文或视频发送结果未知时不自动重发，稳定的视频/会话外发 ID 与 outbox 会在进程重启后继续阻止未知写入重放。

私聊默认不处理，设置 `allowPrivate: true` 后才会处理白名单私聊。

## 搜索

在群里发送：

```text
b站搜索 初音未来现场
```

或 `bilibili 搜索 <关键词>`。搜索使用 B 站 API，受最大时长、结果数量和排序设置限制；关键词补全开启时会自动补充 B 站语境。搜索只回复文本结果，不调用模型。

疑似“合集、歌单、循环、助眠、白噪音、playlist、mix”的内容默认跳过，可通过 `collectionKeywords` 调整。

### API 下载链路说明

当前自动转发使用 B 站公开 API 获取视频元信息和单文件 MP4 播放地址，再由 Node 在本机带视频页 Referer 下载。普通视频不需要 yt-dlp 或 ffmpeg，也不消耗模型 token。服务器需要能访问 `api.bilibili.com` 和 API 返回的 B 站 CDN。

配置中的 `qn` 默认是 `16`（360P）。未登录时 B 站通常只提供 360P 或 480P；请求更高画质时会使用接口实际返回的档位。图文详情与视频分开发送，以兼容 OneBot 对 video 段的限制。封面经公共地址安全校验下载，上限 2 MiB、超时 10 秒；图片内容不写入 outbox，只记录大小与说明。`mediaDir` 留空时使用数据目录下的 `bilibili` 临时目录；临时目录和文件会设置为 OneBot 进程可读取的权限。考虑到 OneBot 可能异步读取本地媒体，视频发送成功后会保留 10 分钟再删除；每次新任务会清理超过 2 小时的残留目录。

元信息、播放和搜索接口复用匿名指纹 Cookie，不读取用户登录 Cookie；遇到 HTTP 412/-412 最多刷新指纹重试一次。持续拒绝会明确提示失败，用户稍后可重新提交，不进行后台循环重试。视频及失败说明均经宿主发送队列发送，日志记录处理阶段；视频已发出但说明失败不会释放视频防重。
