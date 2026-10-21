# 以图搜图：Google Lens、SerpApi、Yandex、trace.moe

## 功能与实际限制

这是宿主内置功能，默认关闭，配置入口为 **设置 → 以图搜图**。明确搜图指令直接由程序处理，不调用聊天模型。Google Lens 浏览器、SerpApi 的 Google Lens 接口与 Yandex 用于综合搜图；trace.moe 用于定位动画截图的名称、集数和时间段。

宿主下载 QQ 图片并通过受鉴权的中转查询外部平台。中转可以与宿主同机运行，也可以放在另一台服务器；当前杭州 → 东京只是现有部署方式。**只使用 SerpApi 时，国内服务器能连通 `serpapi.com` 即可将中转部署在国内，无需国外服务器或 SSH 隧道。**图片会交给外部搜索平台处理，受对应平台的数据政策约束。本功能不把图片存入任务历史，不建立公共图床，也不把 QQ 图片网址作为公开搜索地址。Google 临时图片和独立浏览器资料目录在查询结束后清理。

**有东京出口不等于免验证码。** 2026-10-17 实测：Yandex 和 trace.moe 均完成了图片文件上传和结果提取；Yandex 连续查询后开始要求验证码。Google 能通过浏览器提交图片，但该出口随后被要求验证码，尚未取得真实来源结果。当前 Google 适配器提供浏览器上传、来源提取和拦截检测，但不能把它称为生产验证通过。页面改版、出口限制、验证码、无匹配和超时均可能影响结果。程序不会代解验证码或无限重试。

SerpApi 是可选的第三方 API，需要单独的账户与 Key，按其账户额度计量；默认关闭，不会自动产生查询。每张图片先查完全匹配；没有帖子结果或查询失败时再查相似图片；两者都为空时补查一次 Google Lens 自动裁剪，最多使用三次 Lens 查询。中转令牌用于宿主访问中转，和 SerpApi Key 不同，即使同机部署也必须配置。杭州服务器曾在不带 Key 的请求下完成到 SerpApi 上传及搜索端点的 HTTPS 连接；这只证明当时网络可达，不代表所有国内网络都稳定，也不等于已验证同机部署的完整搜图流程。Google 浏览器查询及 Yandex 网页查询仍使用公开页面，没有稳定 API 契约。

## QQ 用法

- 回复本会话已记录的图片发送 **找鸡**：只查询 SerpApi，返回一条普通文字来源线索，列出平台、匹配类型、页面标题、链接账号和来源网址；不发送合并转发卡片。
- 回复图片发送 **搜图**，或同一条消息发送 **搜图** 和一张图片：同样只查询 SerpApi，但沿用原有的结果列表；开启“返回匹配图片”时仍发送合并转发卡片。
- **搜图 Google** / **搜图 谷歌**：只查询 Google Lens。
- **搜图 SerpApi** / **搜图 谷歌API**：通过 SerpApi 查询 Google Lens；结果覆盖 X、TikTok 等被检索到的网站。
- **搜图 Yandex**：只查询 Yandex。
- **搜图 trace.moe** / **搜图 动画**：只查询动画截图。
- **搜图 全部**：依次查询全部已开启的平台。

每次处理第一张图片，支持不超过 8MB 的 PNG、JPEG、GIF、WebP。SerpApi 上传限制为 500 KB；中转在必要时将图片压缩为 JPEG 后上传，动画 GIF 取首帧。Google 浏览器可能拒绝 GIF 等格式，此时换用静态 PNG/JPEG。暂不支持从任意聊天读取被引用的图片：引用必须已记录在当前会话，避免跨群或跨私聊读取。

“找鸡”和不带平台参数的“搜图”固定查询 SerpApi，失败或无结果时不会自动请求其他平台，避免额外消耗额度。SerpApi 默认关闭；配置 Key 后仍需在网页中单独启用。显式指定“搜图 Google / Yandex / trace.moe”可单独使用对应平台；“搜图 全部”逐个平台返回状态和结果。旧配置中的默认平台和自动切换字段保留兼容，但不再控制这两个关键词。

来源网页不等于原创作者或最早发布者。“找鸡”会检查前八条候选并优先展示社交平台帖子；具体帖子或资料页能从链接提取账号时，“名字”默认填账号名（不带 @），并不代表真实姓名或原创作者。商品标题只作为页面标题，不当作人物名字；链接里的账号可能是转载者。自动裁剪只产生相似图片线索，不能据此确认身份，所以不提取账号。SerpApi 结果注明来源网站、帖子／资料页／搜索页，以及 Lens 的匹配分区；TikTok 发现页等只能作为线索，不能当成原帖。trace.moe 的最低相似度默认 0.90，低于门槛只提示无可靠结果；不同片源有片头、剪辑和时间差，时间段仅对应返回的匹配片源。同一动画同一集的多片源候选去重。

## 部署位置与分工

```text
国内同机：QQ → 宿主（权限、去重、安全下载、任务记录、QQ回复）
                 → 本机 127.0.0.1:3220 搜图中转 → SerpApi → 结构化结果

现有两地：QQ → 杭州宿主 → 杭州本机 SSH 隧道端口
                 → 东京 127.0.0.1:3220 搜图中转 → 各搜索平台
```

中转是独立 Node 进程，不加载宿主配置、QQ、记忆或模型。默认仅监听 `127.0.0.1:3220`，所有接口（含健康检查）需要令牌。同机部署时宿主直接连接本机端口，不需要 SSH 隧道或开放 3220 公网端口。浏览器版 Google、Yandex 等平台仍要按各自网络条件验证，SerpApi 可连通不代表它们也可用。宿主源码、运行目录和数据目录保持原有部署方式，不使用插件同步脚本更新宿主。

## 国内服务器同机使用 SerpApi

在运行宿主的国内 Linux 服务器上，以普通服务用户从源码目录执行 `bash deploy-image-search-relay.sh` 安装中转；安装器会创建独立的 `qq-image-search-relay.service`，不需要为 SerpApi 安装 Chrome。按需执行 `sudo loginctl enable-linger "$(whoami)"`，保证退出登录后用户服务继续运行。编辑 `~/.config/qq-image-search-relay/env`（权限保持 0600），添加自己的 `IMAGE_SEARCH_SERPAPI_API_KEY=...`，再执行 `systemctl --user restart qq-image-search-relay.service`。在控制台填本机中转地址 `http://127.0.0.1:3220` 与该环境文件中的 `IMAGE_SEARCH_RELAY_TOKEN`，测试连接并启用 SerpApi 平台。宿主更新仍使用原有 `deploy.sh`，不要用中转安装器替代宿主部署。

国内同机方案不执行下文的东京安装和 SSH 隧道步骤。如果已有服务或隧道占用本机 3220，应先确定要保留哪条链路，或在中转环境文件设置其他 `IMAGE_SEARCH_RELAY_PORT` 并同步修改控制台中转地址。先测试服务器能否稳定访问 [SerpApi 图片上传接口](https://serpapi.com/image-api)和 [Google Lens 接口](https://serpapi.com/google-lens-api)；单纯的 HTTPS 连通性检查不消耗搜图额度，但仍需用自己的 Key 完成一次实际搜图验收。

## 一、可选：在东京安装中转

以下由普通用户（例如 ubuntu）执行，不要用 root 运行安装脚本。需要 git、curl、tar、xz、sha256sum 和可用的 systemd 用户会话。若本机没有 Node ≥22.19，安装脚本会从 Node 官方下载独立运行时并校验 SHA256，不替换系统 Node。

```bash
git clone https://github.com/hjklggfh/qq-agent-plus.git ~/qq-image-search-relay
cd ~/qq-image-search-relay
bash deploy-image-search-relay.sh
sudo loginctl enable-linger "$(whoami)"
```

这个命令安装搜图中转；SerpApi、Yandex 和 trace.moe 不需要 Chrome，浏览器版 Google 要另配浏览器。安装目录不要包含空格和特殊字符。安装脚本保留已有令牌，重新运行不会清空配置。

### Google 浏览器

安装支持当前服务器系统的 Chrome/Chromium 及其依赖，并确保普通服务用户能在**启用浏览器沙箱**的情况下启动它。例如已经安装的 Google Chrome 路径可能为 `/usr/bin/google-chrome-stable`；实际以服务器为准：

```bash
bash deploy-image-search-relay.sh --chrome /usr/bin/google-chrome-stable
```

浏览器通过 Chrome DevTools Protocol 自动上传临时图片，使用独立的一次性浏览器资料，不读取个人浏览器 Cookie、账号或密码。只运行一个搜索任务，浏览器任务串行，服务内存上限 900MB。

在 Ubuntu 24.04 上，systemd 用户服务的 `PrivateTmp=true` 会使 Chrome 的沙箱无法启动，即使同一用户在 SSH 终端能正常运行浏览器。安装器因此使用 `PrivateTmp=false`；模块仍通过 `mkdtemp` 创建 0700 临时目录并在任务结束后删除，Chrome 自身沙箱保持开启。2026-10-17 已通过实际用户服务的失败/成功对比核验，不需要全局关闭 AppArmor 或使用 `--no-sandbox`。

Ubuntu 24.04 的 AppArmor 可能阻止便携 Chrome 的用户命名空间沙箱，表现为 `No usable sandbox`。应为受信任的浏览器按 Chromium 官方说明配置沙箱/系统策略，或使用带适当隔离的专用运行环境。生产代码不会自动加 `--no-sandbox`，也不会修改系统策略。未配置或无法启动浏览器时，显式指定的“搜图 Google”不可用；默认“搜图”仍使用 SerpApi。

参考：[Chrome for Testing](https://googlechromelabs.github.io/chrome-for-testing/)、[Ubuntu AppArmor 与 Chromium 沙箱](https://chromium.googlesource.com/chromium/src/+/main/docs/security/apparmor-userns-restrictions.md)。

### 中转状态和配置（国内同机、东京通用）

```bash
systemctl --user status qq-image-search-relay.service
journalctl --user -u qq-image-search-relay.service -n 50 --no-pager
```

配置文件：`~/.config/qq-image-search-relay/env`（权限 0600）。包含 `IMAGE_SEARCH_RELAY_TOKEN` 和可选 `IMAGE_SEARCH_CHROME`、`IMAGE_SEARCH_SERPAPI_API_KEY`。可以设置 `IMAGE_SEARCH_RELAY_PORT` 更改监听端口，默认 3220。修改后重启中转服务。

要启用 SerpApi，在中转所在服务器的服务用户环境文件中另起一行设置 `IMAGE_SEARCH_SERPAPI_API_KEY=你的Key`，保持文件权限 0600，然后执行 `systemctl --user restart qq-image-search-relay.service`。不要把 Key 写进 Git、QQ 消息、宿主网页或中转令牌字段。重新运行中转安装器会保留环境文件内的 Key。控制台的中转健康检查只返回“是否已配置”，不会返回 Key。SerpApi 的图片上传和 Lens 查询会使用账户额度；[上传接口](https://serpapi.com/image-api)和[搜图接口](https://serpapi.com/google-lens-api)的条件以其文档为准。

不要把该文件上传 GitHub。控制台和任务记录不会返回令牌明文。

## 二、可选：建立杭州到东京的 SSH 隧道

仅中转部署在东京等另一台服务器时需要本节；国内同机方案直接连接 `127.0.0.1:3220`，跳过 SSH 隧道。

**Windows 的 SSH 私钥不会自动出现在杭州服务器上。** 建议在杭州以机器人服务用户生成专用密钥，并将公钥加入东京 ubuntu 用户的 `~/.ssh/authorized_keys`。私钥留在杭州，权限 0600；不要复制到仓库、聊天或网页设置中。

先在杭州配置 SSH 别名，例如 `~/.ssh/config`：

```sshconfig
Host image-search-tokyo
    HostName YOUR_TOKYO_IP
    User ubuntu
    IdentityFile ~/.ssh/image_search_tokyo_ed25519
    IdentitiesOnly yes
    ServerAliveInterval 30
    ServerAliveCountMax 3
```

首次连接应通过云控制台等可信渠道核对东京 SSH 主机指纹并写入 known_hosts。然后在杭州测试：

```bash
ssh -o StrictHostKeyChecking=yes image-search-tokyo true
ssh -N -o BatchMode=yes -o ExitOnForwardFailure=yes -o StrictHostKeyChecking=yes \
  -L 127.0.0.1:3220:127.0.0.1:3220 image-search-tokyo
```

测试时保持此终端开启。正式使用可在杭州创建 `~/.config/systemd/user/qq-image-search-tunnel.service`：

```ini
[Unit]
Description=QQ image search SSH tunnel
After=network-online.target

[Service]
ExecStart=/usr/bin/ssh -NT -o BatchMode=yes -o StrictHostKeyChecking=yes -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 -o ServerAliveCountMax=3 -L 127.0.0.1:3220:127.0.0.1:3220 image-search-tokyo
Restart=always
RestartSec=10

[Install]
WantedBy=default.target
```

```bash
systemctl --user daemon-reload
systemctl --user enable --now qq-image-search-tunnel.service
```

若杭州 3220 已被占用，仅更改 `-L` 冒号前的本机端口，并同步网页中转地址。SSH 隧道与机器人服务相互独立。也支持用户自行配置 HTTPS 反向代理，网页只接受根地址和无凭据 URL；HTTP 仅允许本机地址。

## 三、更新宿主并填写控制台

按现有流程从 GitHub main 拉取并运行原宿主 `deploy.sh`，保持原有源码、安装目录和数据目录参数。**无论中转部署在国内还是东京，中转使用独立安装器，宿主继续使用原部署流程，两者不要混用。**

打开 **设置 → 以图搜图**：

1. 中转地址填 `http://127.0.0.1:3220`。
2. 从中转所在服务器的配置文件读取中转令牌，填入密码框保存；留空保留原值，勾选清除才删除。
3. 点击“测试已保存的中转连接”。检查 SerpApi 是否已配置；连通正常不代表平台当前一定返回结果。
4. 在中转服务器配置 Key 后，开启 SerpApi 平台开关；“找鸡”和“搜图”将使用它。浏览器版 Google 等其他平台可单独关闭。
5. 填入允许搜图的群号。**空群白名单表示全部群禁止**；还需满足宿主聊天白名单。私聊默认禁止，开启后仍受宿主私聊白名单约束。
6. 保存并启用后，在测试群发送图片和“搜图”。

需要图片时，勾选“返回匹配图片及来源链接”。结果以合并转发卡片发送，每条对应来源链接和图片；优先下载平台提供的匹配图原文件，失败时尝试缩略图并标注。trace.moe 返回动画匹配帧预览；匹配图原文件不保证是作者发布的最高分辨率版本。

每次最多尝试前三条结果附图，图片串行下载，总计最多8MB，附图阶段最多35秒。下载失败、过大、防盗链或超过数量上限，仍返回来源链接和原因。关闭此选项恢复纯文字结果，不删除数据；旧配置默认不附图。本次发送若未确认，不再自动补发文字或重试卡片。

匹配图片由中转下载，宿主通过同机端口或 SSH 隧道取回。中转只接受搜索时生成的五分钟短期图片凭证（内存最多60项），不能提交任意下载地址；下载及每次重定向均检查公网地址并固定已校验的IP，不沿用宿主的内网图片例外。图片及凭证不写入任务历史。

FYimg 的[综合搜索入口](https://fyimg.com/image-search)将图片链接交给各平台，Google 按钮仍打开 Lens；它不能消除浏览器版 Google 遇到的验证。Google 被拦截后中转暂停自动访问 Google 十分钟；普通“搜图”固定使用 SerpApi，不会改查其他平台。[Google 官方说明](https://support.google.com/websearch/answer/86640)也指出自动请求或网络流量可能触发验证；目前不能保证浏览器版 Google 无人值守可用，不能把浏览器启动成功当作搜索成功。

设置立即生效；修改搜图设置会取消正在执行的任务。暂停、观察模式、时间限制和宿主拒绝访问仍然有效。搜图过程不会绕过这些条件发送 QQ 消息。

每个平台默认超时45秒（可设10—90），默认最多3条结果（1—5），同会话冷却15秒。宿主及中转各限一个并发任务；忙碌时明确拒绝，不积压大型图片队列。“搜图 全部”可能耗时数个平台的时间。

## 历史、错误和停用

任务历史位于宿主独立数据目录的 `image-search/history.json`，最多50项，保存会话、时间、状态、平台和结果数量，不保存图片、令牌、完整查询页面或原图地址。关闭功能保留配置和历史，取消当前请求；重启将运行中任务显示为中断，不自动重新上传。已有 QQ 消息去重和发送 outbox 继续负责重复事件、发送失败及发送结果未知；遇到未知结果不会自动重发。

- **验证码/访问限制**：换其他平台或稍后手动重试；不要密集点击或配置无限重试。
- **Google 不可用**：检查 Chrome 路径、依赖和沙箱；浏览器未配置仍可使用其他平台。
- **SerpApi 不可用**：检查中转所在服务器到 SerpApi 的网络、环境文件中的 Key、账户额度及健康检查状态；单次暂无结果可稍后手动重试，不无限消耗查询额度。
- **动画无可靠结果**：可能不是动画截图、裁剪过重、数据库无收录或相似度不足；不要随意降低门槛把候选当成事实。
- **引用未找到**：请直接发送图片与指令，或引用当前会话已入库的图片。
- **中转连接失败**：国内同机部署时检查本机端口、中转用户服务和令牌；跨服务器部署时再检查两端隧道。不需要重部署整个 QQ Agent。
- **发送未确认**：先核对 QQ 会话和宿主异常处理，不自动重跑任务。

停用宿主功能只需关闭网页开关；停用独立服务：

```bash
# 在中转所在服务器运行
systemctl --user disable --now qq-image-search-relay.service
# 仅跨服务器部署时，在宿主关闭隧道
systemctl --user disable --now qq-image-search-tunnel.service
```

更新中转代码：进入中转所在服务器的源码仓库，`git pull --ff-only` 后重新运行安装器（若已配置 Chrome，传同样的路径），或生产依赖未变化时仅重启服务。回滚前记录当前 commit，关闭搜图后在对应仓库恢复到已知版本并重启；不删除宿主数据或令牌文件。

## 开发验证

```bash
node --test test/image-search.test.mjs test/image-search-ingest.test.mjs test/image-search-ui.test.mjs
npm run lint
node src/ops.js scan --strict
node src/ops.js scan plugins --strict
```

更改 UI 后还需执行 `UI-SMOKE.md` 和现有渲染、滚动、用量及真模块测试。新增测试使用临时数据和本机桩服务，不连接真实 QQ 或付费模型；真实搜索结果、中转传图和 QQ 回复需要部署后现场验收。
