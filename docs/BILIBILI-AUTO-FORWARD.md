# B 站视频自动转发

该功能由宿主入站事件直接处理，不调用模型，也不消耗模型 token。默认关闭。

## 依赖

服务器需要安装并放入 `PATH`：

```bash
yt-dlp --version
ffmpeg -version
```

`yt-dlp` 负责展开 `b23.tv` 短链、读取元数据和下载视频；`ffmpeg` 负责合并音视频流。也可以在配置中填写两个可执行文件的绝对路径。

## 配置

在控制台保存配置（或编辑数据目录中的 `config.json`）的 `bilibili` 段：

```json
{
  "bilibili": {
    "enabled": true,
    "downloader": "yt-dlp",
    "ffmpeg": "ffmpeg",
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

收到群消息中的 `bilibili.com`、`www.bilibili.com` 或 `b23.tv` 链接后，程序会自动下载并发送一个视频消息，文字说明包含标题、UP 主、时长和原链接。任务按群串行、全局受并发上限约束；同一群里的同一链接在六小时内不会重复下载。

私聊默认不处理，设置 `allowPrivate: true` 后才会处理白名单私聊。

## 搜索

在群里发送：

```text
b站搜索 初音未来现场
```

或 `bilibili 搜索 <关键词>`。搜索同样由本机 `yt-dlp` 完成，受 UP 主、最大时长、结果数量和排序设置限制；关键词补全开启时会自动补充 B 站语境。搜索只回复文本结果，不调用模型。

疑似“合集、歌单、循环、助眠、白噪音、playlist、mix”的内容默认跳过，可通过 `collectionKeywords` 调整。
