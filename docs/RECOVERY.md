# 东京外部巡检与服务恢复

运维入口为 `node src/ops.js recovery-watch --confirm`（监测端）与 `recovery-target --confirm`（目标端专用SSH入口）。无 `--confirm` 不发出恢复指令。独立主机只需部署 `src/core/recovery-watch.js` 和 Node22，其内置 worker 供 systemd 调用，不依赖应用数据库或 npm 包。

云端整机恢复默认关闭，需 `QQ_RECOVERY_ECS_ENABLED=1`、`QQ_RECOVERY_ECS_FILE`（私有凭据文件）、`QQ_RECOVERY_INSTANCE_ID`、`QQ_RECOVERY_REGION` 显式启用。凭据只在东京读取，0600且归运行用户所有，实例和地域必须与独立环境配置一致。只允许查询状态和 `RebootInstance`，签名请求固定官方HTTPS端点，不跟随重定向、不重试；所有重启固定 `ForceStop=false`，不使用Docker获取主机root权限。验证权限仅调用 `DryRun=true`，返回 `DryRunOperation` 表示预检通过，不能用真实重启测试权限。

整机恢复条件：有过去24小时内成功SSH取得的主机基线，主机已运行至少10分钟，最近状态不是暂停/观察/显式停止/部署中；SSH和公开健康接口同时连续失败10分钟，或服务已尝试恢复且健康接口仍失败、I/O PSI full avg60≥20%持续5分钟。还需两项ECS查询均确认指定实例Running、健康Ok或Impaired、无计划事件，并再次检查SSH/HTTP仍未恢复。云端Starting/Stopped/维护/计划事件会抑制重启并留10分钟宽限。服务正常或单纯QQ掉线绝不触发整机重启。

每小时最多一次、滚动24小时两次整机请求，与服务恢复计数分开；重启后宽限10分钟。发请求前状态fsync落盘，锁防止并发；一次请求结果未知时停止自动重发，保持到观察到新的boot ID或人工核查。正常重启请求成功仅表示已受理，不能当作服务恢复；严重卡死时正常重启可能仍无法完成，**不会自动升级强制重启**。

每分钟执行一次，由 systemd oneshot/timer 防止重叠。东京以专用密钥SSH到QQ服务器，另检查公开 `/healthz`。专用公钥限制东京来源IP、固定命令且禁用转发/PTY，命令只接受 `probe`、`restart-service`，不能执行任意shell。主机指纹通过已有可信连接复制，禁止自动接受陌生主机密钥。

- 服务器开机10分钟内不恢复，避免正常冷启动被打断。
- 健康接口连续5分钟不可用才尝试重启QQ Agent服务；单纯QQ掉线、无人聊天、非活跃时段、磁盘短暂冲高均不触发。
- 同一故障只请求一次；请求前保存状态，SSH回包丢失按未知处理，不自动重发。
- 重启服务最多每小时一次、滚动24小时两次；目标端再次核对健康、暂停/观察状态与部署锁，显式停止的服务不自动拉起。
- SSH不可用不会被当作已确认服务故障；采样中断超过3分钟、时钟回退重新计时。

两端每分钟保存轻量JSONL：时间、boot ID、健康状态、机器人PID/RSS/读写计数、可用内存/swap、swap换入换出累计页数、I/O PSI及磁盘累计读写。不扫描聊天内容、不调用模型、不发送QQ通知。每日文件最多2MiB，最多7天（各端最多14MiB）；数据在 `QQ_RECOVERY_DIR`，权限0700/0600。当前累计计数供前后样本计算速率，不能把累计读写当作瞬时流量。

目标端环境：`QQ_AGENT_SERVICE`（默认qq-agent-linux.service）、`QQ_AGENT_CONSOLE_PORT`、`QQ_AGENT_DATA_DIR`、`QQ_RECOVERY_DIR`。监测端环境：`QQ_RECOVERY_HOST=user@host`、`QQ_RECOVERY_KEY`、`QQ_RECOVERY_KNOWN_HOSTS`、`QQ_RECOVERY_HEALTH_URL`、`QQ_RECOVERY_DIR`，以及上面的可选ECS配置。路径、主机和密钥不写进源码。worker对外部命令、SSH、HTTP与云API均有超时；完整云端检查执行窗口需要systemd `TimeoutStartSec=120`，oneshot不重叠。独立部署需一起复制recovery-watch.js、recovery-ecs.js、recovery-cloud-policy.js。

停止监控：东京执行 `systemctl --user disable --now qq-agent-recovery.timer`；不会停止机器人或删除诊断数据。维护时可暂时停止timer，完成后重新启用。查看状态：`systemctl --user status qq-agent-recovery.timer`，查看最近决策：`journalctl --user -u qq-agent-recovery.service -n 20 --no-pager`。不要用真实卡死或重启生产服务器验证：先测试决策逻辑，线上只验证健康探测和定时器执行。
