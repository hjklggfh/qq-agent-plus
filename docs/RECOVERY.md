# 东京外部巡检与服务恢复

运维入口为 `node src/ops.js recovery-watch --confirm`（监测端）与 `recovery-target --confirm`（目标端专用SSH入口）。无 `--confirm` 不发出恢复指令。独立主机只需部署 `src/core/recovery-watch.js` 和 Node22，其内置 worker 供 systemd 调用，不依赖应用数据库或 npm 包。

当前阶段**没有配置云端整机重启**。无法SSH、整机无响应或服务恢复后仍故障时，只留诊断记录，不调用 reboot，不使用 Docker 获取主机root权限。将来接入阿里云凭据后，需单独实现并验证云端状态判断、正常重启、动作持久化和重启限额；强制重启不在当前授权范围。

每分钟执行一次，由 systemd oneshot/timer 防止重叠。东京以专用密钥SSH到QQ服务器，另检查公开 `/healthz`。专用公钥限制东京来源IP、固定命令且禁用转发/PTY，命令只接受 `probe`、`restart-service`，不能执行任意shell。主机指纹通过已有可信连接复制，禁止自动接受陌生主机密钥。

- 服务器开机10分钟内不恢复，避免正常冷启动被打断。
- 健康接口连续5分钟不可用才尝试重启QQ Agent服务；单纯QQ掉线、无人聊天、非活跃时段、磁盘短暂冲高均不触发。
- 同一故障只请求一次；请求前保存状态，SSH回包丢失按未知处理，不自动重发。
- 重启服务最多每小时一次、滚动24小时两次；目标端再次核对健康、暂停/观察状态与部署锁，显式停止的服务不自动拉起。
- SSH不可用不会被当作已确认服务故障；采样中断超过3分钟、时钟回退重新计时。

两端每分钟保存轻量JSONL：时间、boot ID、健康状态、机器人PID/RSS/读写计数、可用内存/swap、swap换入换出累计页数、I/O PSI及磁盘累计读写。不扫描聊天内容、不调用模型、不发送QQ通知。每日文件最多2MiB，最多7天（各端最多14MiB）；数据在 `QQ_RECOVERY_DIR`，权限0700/0600。当前累计计数供前后样本计算速率，不能把累计读写当作瞬时流量。

目标端环境：`QQ_AGENT_SERVICE`（默认qq-agent-linux.service）、`QQ_AGENT_CONSOLE_PORT`、`QQ_AGENT_DATA_DIR`、`QQ_RECOVERY_DIR`。监测端环境：`QQ_RECOVERY_HOST=user@host`、`QQ_RECOVERY_KEY`、`QQ_RECOVERY_KNOWN_HOSTS`、`QQ_RECOVERY_HEALTH_URL`、`QQ_RECOVERY_DIR`。路径、主机和密钥不写进源码。worker对外部命令、SSH和HTTP探测均有超时。

停止监控：东京执行 `systemctl --user disable --now qq-agent-recovery.timer`；不会停止机器人或删除诊断数据。维护时可暂时停止timer，完成后重新启用。查看状态：`systemctl --user status qq-agent-recovery.timer`，查看最近决策：`journalctl --user -u qq-agent-recovery.service -n 20 --no-pager`。不要用真实卡死或重启生产服务器验证：先测试决策逻辑，线上只验证健康探测和定时器执行。
