# PID 专用东京链路

PID 默认使用已有国内图片入口。需要海外线路时，可以单独部署本目录对应的 HTTPS CONNECT 代理，再用 SSH 本地转发连接。它不读取以图搜图的令牌，不调用以图搜图接口，也不修改以图搜图服务。

## 结构与范围

杭州 Agent → 杭州 `127.0.0.1:3222` → 专用 SSH 隧道 → 东京 `127.0.0.1:3222` → 指定 Pixiv 相关域名。

代理源码：`src/features/pixiv/connect_proxy.py`，CONNECT 使用 Python 3 标准库，图片压缩另需系统 Pillow（Ubuntu 安装 python3-pil）。只接受指定主机的443端口 CONNECT：`www.pixiv.net`、`app-api.pixiv.net`、`i.pximg.net`、`s.pximg.net`、`pixiv.re`、`i.pixiv.re`、`api.lolicon.app`。其他目标、私网 DNS 结果和普通 HTTP 转发被拒绝。两个监听端口都只绑定127.0.0.1，不开放公网代理。

CONNECT 的 HTTPS 仍由杭州 Agent 与目标网站直接协商，东京只转发加密字节，不解密 Cookie、不记录图片或请求内容。仅改变 PID 独立配置里的 `proxyUrl`，不设置系统代理或聊天模型代理。最多同时转发8条连接，空闲120秒断开。

## 部署前准备

需要用户明确授权：在杭州生成专用 SSH 密钥、在东京授权对应公钥，以及两端持久运行的用户服务。私钥只保存在杭州服务用户的 `~/.ssh/pixiv_tokyo_ed25519`，不要上传仓库或发送到聊天中。东京沿用已有用户；不使用root部署。

SSH 主机公钥必须使用已核实的 known_hosts，不关闭主机校验。专用公钥授权应限制端口并禁止执行命令，例如：

```text
restrict,port-forwarding,permitopen="127.0.0.1:3222",command="/bin/false" ssh-ed25519 <专用公钥> qq-pixiv-tunnel
```

## 东京服务

把源码复制到东京服务用户的 `~/.local/share/qq-pixiv-proxy/connect_proxy.py`。建立 `~/.config/systemd/user/qq-pixiv-proxy.service`：

```ini
[Unit]
Description=Dedicated Pixiv HTTPS tunnel proxy
After=network-online.target
[Service]
Type=simple
ExecStart=/usr/bin/python3 -I -B %h/.local/share/qq-pixiv-proxy/connect_proxy.py --port 3222
Restart=on-failure
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=read-only
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
MemoryMax=384M
TasksMax=32
UMask=0077
[Install]
WantedBy=default.target
```

以该用户执行 `systemctl --user daemon-reload`、`systemctl --user enable --now qq-pixiv-proxy.service`。本机 `http://127.0.0.1:3222/healthz` 返回200。用户服务需保留已有的 linger 设置，才能在退出SSH后持续运行。

## 杭州隧道

建立独立的 `qq-pixiv-tunnel.service`。将 `src/features/pixiv/ssh_gateway.py` 复制到杭州服务用户的 `~/.local/share/qq-pixiv-tunnel/ssh_gateway.py`，设置权限0600；用户服务执行下面的命令，设置 `Restart=always`、`RestartSec=3`、`MemoryMax=128M`、`TasksMax=64`。路径和目标用户按实际安装填写：

```bash
python3 -I -B ~/.local/share/qq-pixiv-tunnel/ssh_gateway.py \
  --host <东京用户>@<东京地址> \
  --key ~/.ssh/pixiv_tokyo_ed25519 \
  --known-hosts ~/.ssh/known_hosts_pixiv --port 3222
```

在systemd的ExecStart里使用绝对路径，避免 `~` 未展开。启用后，从杭州访问上述健康检查应返回200。先使用隔离数据目录和模拟发送接口，验证官方详情、分级、完整页数、实际下载、PDF页数和耗时，确认成功后再切换生产PID设置。

杭州网关为每个TCP请求启动受限的 `ssh -W 127.0.0.1:3222` 通道。底层SSH连接最多顺序复用3次，超过10秒或空闲3秒后在无请求占用时回收；每条连接同一时刻只服务一个通道。这样可减少反复认证开销，同时避免所有图片长期共用一条因丢包而变慢的连接。仍使用同一把受限密钥和已核实主机公钥，最多8条连接，仅绑定本机地址。控制套接字放在服务自有的0700临时目录，不接受客户端指定目标。断开或120秒无数据会清理对应通道，不会重试QQ发送。网关只适用于Linux。发生线路回退需要时，可在网关启动命令增加 `--batch-size 1`，恢复每个请求独立SSH连接。

单作品PDF正常只发送开始提示、PDF文件、完成总结，共3条；不发送逐页、合成或上传中的文本提示。错误直接结束任务并返回原因，不补发重复文件。

## Agent 设置与回退

备份配置后，在“设置 → PID 搜索 → 网络与图片处理”中填写：

- 自选HTTP代理：`http://127.0.0.1:3222`。
- 作品详情接口：`https://www.pixiv.net/ajax/illust/{pid}`，或在已配置代理时留空使用官方默认。
- Cookie：无需要时留空。需要登录态的作品仍须由管理员在控制台填写有效Cookie；不要在聊天里发送凭据。Cookie仅发给Pixiv官方域名。

建议在PID配置中设置 `proxyScope: "official"`：只有 Pixiv 官网与 pximg 官方图片域名走东京，`pixiv.re` / `i.pixiv.re` 与 Lolicon 仍直连。这样可保留国内PID短链引导路径，取得真实地址后再由东京加速官方图片下载。`proxyScope: "all"` 为旧行为兼容默认值，会让本功能的全部网络请求使用指定代理。设置接口支持该字段，普通网页保存其他设置会保留它。

现有分级、大小、页数、超时和取消限制继续生效。中转不能保证所有作品都可取，也不能把缺失的图片地址或HTTP200误当成整本成功。分级已核实且首次取得真实图片路径后，会缓存该路径，后续相同PID减少短链接查询。

回退时，在控制台显式清除PID代理，恢复原详情接口；确认没有PID任务运行后，停止并禁用两端专用用户服务。不会删除聊天、存档、分级、作品历史或以图搜图数据。需要撤销访问时再单独移除对应专用公钥授权，保留其他SSH密钥。

## 减少跨区图片回传

若 SSH 回传大图较慢，可通过设置接口配置 `imageRelayUrl: "http://127.0.0.1:3222/image"`。网页保存其他设置会保留它。该端点只接受官方 `i.pximg.net` 图片路径，不接收 Cookie、认证头、任意主机或重定向。东京通过 HTTPS 下载公开 CDN 图片，在内存中缩放后转为 JPEG（质量75、透明处填白、动图取首帧），经 SSH 返回杭州生成 PDF。长边由现有 `downsampleMaxEdge` 控制，默认1200；这会损失一些清晰度，不属于原图无损传输。

最多同时下载三张图片，解码和压缩仍串行执行，原文件受 `maxImageBytes` 限制（最大16MiB），像素上限2400万，用户服务内存上限384MiB。不保存图片、不记录请求内容。官方详情仍通过 CONNECT 保持端到端 HTTPS。若作品需要登录，Cookie仍只发给官方详情接口。

显式清空 `imageRelayUrl` 可关闭东京压缩，继续使用普通代理下载；完整回退还需清空 `proxyUrl` 并恢复原详情接口。先完成隔离的整本下载测试，再启用生产设置。

已知总页数且可靠图片地址就绪时，杭州最多预取三张图片，按原始顺序消费并生成PDF；未知页数或未取得可靠路径时继续逐页探测。停止、取消、达到文件大小上限后会等待预取结束并删除未使用的临时图片。图片质量和尺寸不因并发调整而降低。

首页引导最多跟随3次已知图床的同站响应，只读取GET响应头后取消正文；图床不支持HEAD。取得 `X-Origin-URL` 后仍校验官方域名、作品号、页号及无凭据，再按现有尺寸从东京获取图片。没有有效地址时回退原下载流程，不根据响应头放宽分级。
