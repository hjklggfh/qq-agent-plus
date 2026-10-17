# 以图搜图：Google Lens、Yandex、trace.moe

## 功能与实际限制

这是宿主内置功能，默认关闭，配置入口为 **设置 → 以图搜图**。明确搜图指令直接由程序处理，不调用聊天模型。Google Lens 与 Yandex 用于综合搜图；trace.moe 用于定位动画截图的名称、集数和时间段。

杭州宿主下载 QQ 图片并通过受鉴权的中转传给东京；东京向实际查询的平台上传图片，再返回来源信息。图片会交给外部搜索平台处理，受对应平台的数据政策约束。本功能不把图片存入任务历史，不建立公共图床，也不把 QQ 图片网址作为公开搜索地址。Google 临时图片和独立浏览器资料目录在查询结束后清理。

**有东京出口不等于免验证码。** 2026-10-17 实测：Yandex 和 trace.moe 均完成了图片文件上传和结果提取；Yandex 连续查询后开始要求验证码。Google 能通过浏览器提交图片，但该出口随后被要求验证码，尚未取得真实来源结果。当前 Google 适配器提供浏览器上传、来源提取和拦截检测，但不能把它称为生产验证通过。页面改版、出口限制、验证码、无匹配和超时均可能影响结果。程序不会代解验证码或无限重试。

目前使用免费公开查询能力，没有接入付费 API，也不需要模型 API Key。中转令牌是杭州与东京之间的访问密码，和平台 API Key 不同。Google 的网页能力及 Yandex 的页面格式没有稳定 API 契约；今后如需更可靠的 Google 接入，可在同一平台适配层增加用户自选的 API 服务，不能默认产生费用。

## QQ 用法

- 同一条消息发送 **搜图** 和一张图片，或者回复本会话已记录的图片发送 **搜图**。
- **搜图 Google** / **搜图 谷歌**：只查询 Google Lens。
- **搜图 Yandex**：只查询 Yandex。
- **搜图 trace.moe** / **搜图 动画**：只查询动画截图。
- **搜图 全部**：依次查询全部已开启的平台。

每次处理第一张图片，支持不超过 8MB 的 PNG、JPEG、GIF、WebP。Google 可能拒绝 GIF 等格式，此时换用静态 PNG/JPEG。暂不支持从任意聊天读取被引用的图片：引用必须已记录在当前会话，避免跨群或跨私聊读取。

默认“搜图”先查询选定平台，失败或无结果时按 Google、Yandex、trace.moe 顺序尝试其他已开启的平台，找到结果即停止。指定平台时不自动切换。“搜图 全部”逐个平台返回状态和结果。

来源网页不等于原创作者或最早发布者。trace.moe 的最低相似度默认 0.90，低于门槛只提示无可靠结果；不同片源有片头、剪辑和时间差，时间段仅对应返回的匹配片源。同一动画同一集的多片源候选去重。

## 两端分工

```text
QQ → 杭州宿主（权限、去重、安全下载、任务记录、QQ回复）
   → 杭州本机 SSH 隧道端口 → 东京 127.0.0.1:3220
   → Google Lens / Yandex / trace.moe → 结构化结果
```

东京中转是独立 Node 进程，不加载宿主配置、QQ、记忆或模型。默认仅监听 `127.0.0.1:3220`，所有接口（含健康检查）需要令牌。不需要开放 3220 公网端口。杭州源码、运行目录和数据目录保持原有部署方式，不使用插件同步脚本更新宿主。

## 一、在东京安装中转

以下由普通用户（例如 ubuntu）执行，不要用 root 运行安装脚本。需要 git、curl、tar、xz、sha256sum 和可用的 systemd 用户会话。若本机没有 Node ≥22.19，安装脚本会从 Node 官方下载独立运行时并校验 SHA256，不替换系统 Node。

```bash
git clone https://github.com/hjklggfh/qq-agent-plus.git ~/qq-image-search-relay
cd ~/qq-image-search-relay
bash deploy-image-search-relay.sh
sudo loginctl enable-linger "$(whoami)"
```

这个命令先装好 Yandex / trace.moe 中转；Google 要另配浏览器。安装目录不要包含空格和特殊字符。安装脚本保留已有令牌，重新运行不会清空配置。

### Google 浏览器

安装支持当前服务器系统的 Chrome/Chromium 及其依赖，并确保普通服务用户能在**启用浏览器沙箱**的情况下启动它。例如已经安装的 Google Chrome 路径可能为 `/usr/bin/google-chrome-stable`；实际以服务器为准：

```bash
bash deploy-image-search-relay.sh --chrome /usr/bin/google-chrome-stable
```

浏览器通过 Chrome DevTools Protocol 自动上传临时图片，使用独立的一次性浏览器资料，不读取个人浏览器 Cookie、账号或密码。只运行一个搜索任务，浏览器任务串行，服务内存上限 900MB。

Ubuntu 24.04 的 AppArmor 可能阻止便携 Chrome 的用户命名空间沙箱，表现为 `No usable sandbox`。应为受信任的浏览器按 Chromium 官方说明配置沙箱/系统策略，或使用带适当隔离的专用运行环境。生产代码不会自动加 `--no-sandbox`，也不会修改系统策略。未配置或无法启动浏览器时 Google 不可用，自动模式会尝试其他平台。

参考：[Chrome for Testing](https://googlechromelabs.github.io/chrome-for-testing/)、[Ubuntu AppArmor 与 Chromium 沙箱](https://chromium.googlesource.com/chromium/src/+/main/docs/security/apparmor-userns-restrictions.md)。

### 东京状态和配置

```bash
systemctl --user status qq-image-search-relay.service
journalctl --user -u qq-image-search-relay.service -n 50 --no-pager
```

配置文件：`~/.config/qq-image-search-relay/env`（权限 0600）。包含 `IMAGE_SEARCH_RELAY_TOKEN` 和可选 `IMAGE_SEARCH_CHROME`。可以设置 `IMAGE_SEARCH_RELAY_PORT` 更改监听端口，默认 3220。修改后重启中转服务。

不要把该文件上传 GitHub。控制台和任务记录不会返回令牌明文。

## 二、建立杭州到东京的 SSH 隧道

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

## 三、更新杭州宿主并填写控制台

按现有流程从 GitHub main 拉取并运行原宿主 `deploy.sh`，保持原有源码、安装目录和数据目录参数。**东京使用独立安装器，杭州继续使用原部署流程，两者不要混用。**

打开 **设置 → 以图搜图**：

1. 中转地址填 `http://127.0.0.1:3220`。
2. 从东京配置文件读取中转令牌，填入密码框保存；留空保留原值，勾选清除才删除。
3. 点击“测试已保存的中转连接”。连通正常、已配置浏览器不代表平台当前允许搜索。
4. 选择默认平台（默认 Google）、各平台开关和自动切换。
5. 填入允许搜图的群号。**空群白名单表示全部群禁止**；还需满足宿主聊天白名单。私聊默认禁止，开启后仍受宿主私聊白名单约束。
6. 保存并启用后，在测试群发送图片和“搜图”。

设置立即生效；修改搜图设置会取消正在执行的任务。暂停、观察模式、时间限制和宿主拒绝访问仍然有效。搜图过程不会绕过这些条件发送 QQ 消息。

每个平台默认超时45秒（可设10—90），默认最多3条结果（1—5），同会话冷却15秒。宿主及中转各限一个并发任务；忙碌时明确拒绝，不积压大型图片队列。一次自动回退或全部搜索可能耗时数个平台的时间。

## 历史、错误和停用

任务历史位于宿主独立数据目录的 `image-search/history.json`，最多50项，保存会话、时间、状态、平台和结果数量，不保存图片、令牌、完整查询页面或原图地址。关闭功能保留配置和历史，取消当前请求；重启将运行中任务显示为中断，不自动重新上传。已有 QQ 消息去重和发送 outbox 继续负责重复事件、发送失败及发送结果未知；遇到未知结果不会自动重发。

- **验证码/访问限制**：换其他平台或稍后手动重试；不要密集点击或配置无限重试。
- **Google 不可用**：检查 Chrome 路径、依赖和沙箱；浏览器未配置仍可使用其他平台。
- **动画无可靠结果**：可能不是动画截图、裁剪过重、数据库无收录或相似度不足；不要随意降低门槛把候选当成事实。
- **引用未找到**：请直接发送图片与指令，或引用当前会话已入库的图片。
- **中转连接失败**：检查两端隧道、东京用户服务和令牌是否一致；不需要重部署整个 QQ Agent。
- **发送未确认**：先核对 QQ 会话和宿主异常处理，不自动重跑任务。

停用宿主功能只需关闭网页开关；停用独立服务：

```bash
# 东京
systemctl --user disable --now qq-image-search-relay.service
# 杭州
systemctl --user disable --now qq-image-search-tunnel.service
```

更新东京代码：进入独立中转仓库，`git pull --ff-only` 后重新运行安装器（传同样的 Chrome 路径），或生产依赖未变化时仅重启服务。回滚前记录当前 commit，关闭搜图后在对应仓库恢复到已知版本并重启；不删除宿主数据或令牌文件。

## 开发验证

```bash
node --test test/image-search.test.mjs test/image-search-ingest.test.mjs test/image-search-ui.test.mjs
npm run lint
node src/ops.js scan --strict
node src/ops.js scan plugins --strict
```

更改 UI 后还需执行 `UI-SMOKE.md` 和现有渲染、滚动、用量及真模块测试。新增测试使用临时数据和本机桩服务，不连接真实 QQ 或付费模型；真实 Google 结果、杭州至东京传图和 QQ 回复需要部署后现场验收。
