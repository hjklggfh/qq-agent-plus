# 媒体自动转发（B 站 / 抖音）

B 站与抖音自动转发是宿主内置的扩展能力，统一归口在设置页 **「媒体转发」**（`id: 'media'`）下，各自提供独立启用开关，均无需安装 `yt-dlp`、`ffmpeg` 或登录 Cookie。

## 工作方式

收到聊天消息后（入库之后、不触发大模型，不消耗 token）：

1. **B 站**：识别文本或 QQ `json` / `xml` / `share` / `link` 卡片中的 B 站链接（`bilibili.com/video/BV...`、`av...`、番剧单集 `/bangumi/play/ep...`、`b23.tv/...` 短链及不带协议头的裸链接），自动展开短链并剥离追踪参数（如 `spm_id_from`、`vd_source`）。
2. **抖音**：识别文本、口令文案与 QQ 分享卡片中的抖音链接（`v.douyin.com/...`、`/video/<id>`、`/note/<id>`、`/slides/<id>`、`?modal_id=<id>`、`iesdouyin.com/share/...` 及裸链接）。
3. **匿名会话与元信息校验**：
   - B 站优先通过 `/x/frontend/finger/spi` 领取匿名指纹校验视频/番剧元信息与直链流，遇到画质超限时自动向下尝试更低清晰度（`32 -> 16 -> 6`）。
   - 抖音通过 `www.douyin.com/ttwid/register` 与首页 `uifid` 签名调用公开详情接口，并在网络或风控异常时回退到 `iesdouyin.com` 分享页解析；同时优先识别 `images` 图文字段，防止将图文作品附带的背景音乐当作视频发送。
4. **先下载、后投递与防重复**：
   - 视频先按大小与时长阈值校验并下载到临时目录（自动挑选优先 H.264、兼容 QQ 播放的码率），下载成功后再引用原消息发送封面与详情，随后投递本地视频文件；下载或元信息失败时仅给出明确失败提示。
   - 抖音图文作品会先下载全部无水印图片（受 `maxGalleryImages` 上限约束）：单张直接以图文卡片发送，多张先发送详情卡片再通过合并转发（失败时按确认边界安全回退为逐张图片）发出。
   - 同一会话 6 小时内同时按**链接去重**与**规范作品 ID（BVID/aid/epId、aweme_id）二级去重**，并通过基于规范 ID 的稳定 `runId` 避免 outbox 在结果未知（`unknown`）时重复写入。

## 主要配置项

### `bilibili`（默认关闭）

- `enabled`：是否启用 B 站自动转发（默认 `false`）
- `allowPrivate`：是否处理白名单私聊中的链接（默认 `false`）
- `qn`：首选清晰度（`6` / `16` / `32` / `64` / `80`，默认 `16` = 360P；超出体积上限时自动降级）
- `maxDurationSeconds` / `maxFileBytes` / `maxConcurrent`：最大时长（秒，默认 `900`）、最大体积（默认 `300 MiB`）与并发下载数（`1~3`）
- `rejectCollections` / `collectionKeywords`：是否跳过合集、歌单、助眠等关键词内容及自定义关键词列表
- `preferredUploader`：仅转发包含该 UP 主关键字的视频（留空不限）
- `keywordCompletion` / `searchLimit` / `searchMaxDurationSeconds` / `searchSort`：群内 B 站关键词搜索配置

### `douyin`（默认关闭）

- `enabled`：是否启用抖音自动转发（默认 `false`）
- `allowPrivate`：是否处理白名单私聊中的抖音链接（默认 `false`）
- `preferredQuality`：首选视频画质（`'540p'` / `'720p'` / `'1080p'` / `'highest'`，默认 `'720p'`；超限或无该档位时自动回退可用码率）
- `forwardGallery` / `maxGalleryImages`：是否转发抖音图文作品（默认 `true`）与单条图文最多转发张数（默认 `12`，上限 `30`）
- `maxDurationSeconds` / `maxFileBytes` / `maxConcurrent`：最大时长（默认 `900` 秒）、最大视频体积（默认 `100 MiB`）与并发下载数（`1~3`）
- `rejectCollections` / `collectionKeywords` / `preferredAuthor`：合集/歌单过滤开关、屏蔽关键词与作者筛选

## 临时文件与权限

- 媒体下载任务目录默认位于 `<dataDir>/bilibili/job-*` 与 `<dataDir>/douyin/job-*`（权限 `0755` / 文件 `0644`，适配容器或独立用户运行的 NapCat/OneBot）。
- 发送成功或投递结束后延迟 10 分钟清理临时目录，超期 2 小时未清理的残留 `job-*` 目录会在新任务开始前自动回收。
