# 运维工具（src/ops.js）

本项目的运维入口仅有一个文件 `src/ops.js`，使用 Node 内置模块（`child_process` /
`fs` / `path` / `os` / `node:sqlite` 等），**不引入任何新依赖**，也不需要 python3。
原 `ops/` 目录（shell / python 脚本与 systemd 示例单元）的内容已全部移植至该文件，目录已
删除。

东京侧外部监测与服务恢复见 [`RECOVERY.md`](RECOVERY.md)，入口 `recovery-watch` / `recovery-target`。未配置阿里云凭据时不启用整机重启，只做诊断与受限的机器人服务恢复。

约定：

- 所有路径与凭据仅从**环境变量**读取，脚本中不包含任何真实地址、令牌或账号；
- token / 口令仅用于本地请求，`audit` 对 `config.json` 中的密钥只报告「有 / 无」，不打印内容；
- 只读子命令（`audit` / `audit-host` / `scan` / `watch-*` 及 `--print` 模式）不写入业务数据；
- 破坏性操作（`backup` / `deploy` / `guard` 真实执行 / `install-timers` 写盘）必须显式指定
  `--confirm`，预演使用 `--dry-run` 或 `--print`；
- 外部命令（`systemctl` / `docker` / `journalctl` / `ss` / `tar` / `openssl` 等）缺失时，
  对应段落打印「跳过」后继续执行，不中断整体体检；在 Windows/macOS 上只读体检可正常完成。

```bash
node src/ops.js help          # 全部子命令
node src/ops.js <子命令> --help
npm run ops -- <子命令>
```

## health-check（健康巡检）

```bash
node src/ops.js health-check            # 只巡检并输出 JSON（退出码 0=健康 / 1=有失败项）
node src/ops.js health-check --confirm  # 允许在"连续 3 次失败"或"恢复"时私聊 admin.ownerUin
```

7 项检查：控制台 `/healthz`、OneBot `get_status`、入站处理水位（到期未处理或重试耗尽的入站消息；
`runtime.mode=observe`、Agent 暂停、当日预算降级时自动跳过）、磁盘余量（< 1GB 报警）、
`auto-update.json` 的 `status=failed`、部署中断标记 `.deploy-in-progress`、`messages.sqlite` 完整性检查。

- 结果落在 `data/health.json`：`streaks` 记每类检查的连续失败数，`lastResults` 是最近一次明细。
- **抑制抖动**：同一检查连续失败到**第 3 次**才发一条 QQ 私聊告警；恢复正常时补发一条"已恢复"。
- `--confirm` 才真的发消息；不加就只巡检（定时器 `qq-agent-health.timer` 带 `--confirm`）。

安装定时器（每 5 分钟一次）：

```bash
node src/ops.js install-timers --print     # 预演，看将要写入的单元
node src/ops.js install-timers --confirm   # 写入并启用 backup / process-guard / health / audit-prune 四个 timer
```


## 子命令一览

| 子命令 | 对应原脚本 | 功能 | 适用场景 |
| --- | --- | --- | --- |
| `audit` | `ops/audit-server.sh` | 服务、代码与数据体检：systemd user 服务/定时器、启动补丁链可执行性、全量 js 语法、未定义调用扫描、关键补丁标记、config.json 关键项（密钥只报告有/无）、sqlite 完整性、控制台与协议端运行态、最近日志、主机资源 | 部署后验收；出现问题时用于定位 |
| `audit-host` | `ops/audit-host.sh` | 主机只读体检：失败单元、内存/磁盘/journald、Docker 容器与重启次数、监听端口、SSH 安全、防火墙、定时任务、可升级包、TLS 证书到期、备份现状 | 接手机器后的检查、例行巡检 |
| `audit-prune` | —（改进方案 #5 新增） | 删除 `data/audit-log/` 下超过保留月数的 `audit-YYYYMM.jsonl`（控制台写操作的审计留痕）；默认保留 6 个月，先 `--dry-run` 预演 | 每月定时执行（`qq-agent-audit-prune.timer`）；磁盘吃紧时手动执行 |
| `backup` | `ops/backup-qq-agent-data.sh` | 停止服务数秒 → tar.gz 打包数据目录 → 启动服务 → 仅保留最近 N 份；任何失败路径都会重新启动服务 | 每周定时执行（配合 `.timer`）；重大变更前手动执行 |
| `scan` | `ops/scan-undefined-calls.py` + `ops/check-undefined-calls.sh` | 将注释/字符串/正则/模板串抹白后，查找「已调用但本文件既未定义也未 import」的函数名；默认只记录、不阻断（退出码 0）；`--strict` 下有可疑调用**或目录不存在**则退出 1（2026-10-03：路径写错也要让 CI 变红） | 修改 `src/*.js` 后；也可挂载到服务 `ExecStartPost` |
| `watch-send` | `ops/watch-send.py` | 监视 outbox 表的 rowid 水位线：基线之后新增 failed 行报 SEND_FAIL，新增成功行报 SEND_OK；同时检查是否再次出现未定义函数事故 | 修复发送链路后的线上验证 |
| `watch-login` | `ops/watch-login.py` | 每 15 秒轮询协议端 HTTP 端口，直至 QQ 登录成功，随后打印登录信息 / 控制台状态 / 最近日志 | 重启协议端容器或掉线重登后确认恢复 |
| `guard` | `ops/guard-process-explosion.sh` | 用户进程数超过阈值时清理失控的 bash/grep/tr/sh/sleep 进程树并记录现场（仅 Linux） | 配合 `process-guard.timer` 每 10 分钟执行 |
| `face-names` | `ops/export-face-names.sh` | 合并 SnowLuma 目录 / QQ 客户端配置 / 手工补充表，导出 `data/face-names.json` | QQ 新增表情、表情名不匹配时 |
| `deploy` | `ops/deploy_qq_agent.sh` | 非交互部署：设置模型凭据后调用源码目录的 `deploy-all.sh -y` | 新机器初始化、CI 或远程 SSH 环境中的部署 |
| `console` | `ops/qq-console.bat` | 使用系统 `ssh` 建立控制台 / WebUI / 远程桌面三个端口的隧道，就绪后提示或打开控制台（Windows/macOS/Linux 通用） | 日常打开控制台 |
| `install-timers` | `ops/systemd/` | 生成并安装四个 systemd user 定时器：备份（每周日 04:10）、进程看门狗（每 10 分钟）、健康巡检（每 5 分钟）、审计日志清理（每月 1 日 04:20） | 安装定时任务 |

## 常用示例

```bash
# 体检（先主机层，再服务层）
node src/ops.js audit-host
QQ_AGENT_CONSOLE_TOKEN=xxx node src/ops.js audit

# 本地跑体检时指定仓库自身（默认看 /data/qq-agent/app）
node src/ops.js audit --app=. --data=./data

# 未定义调用扫描：默认带项目已知误报忽略表；传空 --ignore= 可看原始结果
node src/ops.js scan
node src/ops.js scan --ignore=
node src/ops.js scan --log="$HOME/qq-agent-undefined-calls.log"   # 有可疑调用时追加记录

# 备份（先预演，再执行；N 默认取 QQ_AGENT_KEEP=4）
node src/ops.js backup --dry-run
node src/ops.js backup --confirm --keep=4

# 审计日志清理（控制台写操作留痕，按自然月切文件；默认保留 6 个月）
node src/ops.js audit-prune --dry-run
node src/ops.js audit-prune --confirm --keep-months=6

# 线上验证
node src/ops.js watch-send --minutes=240
node src/ops.js watch-login --timeout=25

# 进程看门狗
node src/ops.js guard --dry-run
node src/ops.js guard --confirm --threshold=800

# 表情名导出（容器在跑时直接导出；也可以给本地文件副本）
node src/ops.js face-names
node src/ops.js face-names --print
node src/ops.js face-names --catalog=/path/sys-face-catalog.json --qq-config=/path/face_config.json

# 非交互部署
QQ_AGENT_MODEL_API_KEY=... QQ_AGENT_MODEL_BASE_URL=... QQ_AGENT_MODEL=... \
  node src/ops.js deploy --dir="$HOME/qq-agent-src" --confirm

# 控制台隧道
SSHHOST=user@your-server node src/ops.js console --open
node src/ops.js console --print        # 只打印 ssh 命令
# Windows 且本机没有 Node：双击仓库根目录 console-tunnel.bat
#   console-tunnel.bat test            # 连通性自检（输出 TEST_OK / 非零退出）
#   console-tunnel.bat forget          # 清除记住的服务器地址

# 定时器
node src/ops.js install-timers --print
node src/ops.js install-timers --confirm
```

## 环境变量

所有带默认值的路径均可覆盖；默认值对应「部署根目录 `/data/qq-agent`」的标准布局。

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `QQ_AGENT_DIR` | `/data/qq-agent` | 部署根目录 |
| `QQ_AGENT_APP_DIR` | `$QQ_AGENT_DIR/app` | 应用目录（`src/`、`ui/`、自带 `.runtime/node`） |
| `QQ_AGENT_DATA_DIR` | `$QQ_AGENT_DIR/data` | 数据目录（config.json、sqlite、sessions） |
| `QQ_AGENT_BACKUP_DIR` | `$HOME/qq-agent/backups` | 备份输出目录 |
| `QQ_AGENT_SERVICE` | `qq-agent-linux.service` | systemd user 服务名 |
| `QQ_AGENT_KEEP` | `4` | `backup` 保留份数（也可用 `--keep=N`） |
| `QQ_AGENT_USER` | 当前登录用户 | 进程/定时任务检查的目标用户 |
| `QQ_AGENT_NODE` | 自动查找 `$APP_DIR/.runtime/node-*/bin/node` | 执行 `--check` 使用的 node |
| `QQ_AGENT_LOG` | `$HOME/qq-agent-undefined-calls.log` | 启动自检报告文件（`scan --log=` 可显式覆盖） |
| `QQ_AGENT_LOG_LEVEL` | `info` | 应用日志级别（`error`/`warn`/`info`/`debug`，改进方案 #6） |
| `QQ_AGENT_LOG_FORMAT` | `text` | 应用日志格式（`text` 保持原观感 / `json` 单行供 journald 过滤） |
| `QQ_AGENT_CONSOLE_PORT` | `3210` | 控制台端口 |
| `QQ_AGENT_ONEBOT_HTTP_PORT` | `3390` | 协议端 HTTP 端口 |
| `QQ_AGENT_CONSOLE_TOKEN` | 无（未设置时回退到 `config.json` 的 `server.token`；两者均无则跳过相关检查） | 控制台 API token |
| `QQ_AGENT_ONEBOT_TOKEN` | 无（未设置时回退到 `config.json` 的 OneBot 令牌） | 协议端 access token |
| `QQ_AGENT_UPDATE_TIMER` | `qq-agent-linux-update.timer` | 自动更新定时器名（`audit` 只读检查） |
| `QQ_AGENT_GUARD_TIMER` | `process-guard.timer` | 进程看门狗定时器名 |
| `QQ_AGENT_OVERRIDE_CONF` | `~/.config/systemd/user/<service>.d/override.conf` | 启动补丁链检查使用的 override 文件 |
| `QQ_AGENT_HOST_UPDATE_PATTERN` | `hermes\|unattended\|update` | 主机级更新定时器过滤正则 |
| `QQ_AGENT_GUARD_USER` | `QQ_AGENT_USER` | 看门狗监视的系统用户 |
| `QQ_AGENT_PROC_LIMIT` | `800` | 看门狗阈值（也可用 `--threshold=N`） |
| `QQ_AGENT_GUARD_LOG` | `$HOME/process-explosion.log` | 看门狗现场记录文件 |
| `QQ_AGENT_SNOWLUMA_CONTAINER` | `qq-agent-snowluma` | 协议端容器名（`face-names` 使用） |
| `QQ_AGENT_WEBUI_PORT` | `5099` | SnowLuma WebUI 端口（`console` 隧道） |
| `QQ_AGENT_VNC_PORT` | `6081` | QQ 远程桌面 / 扫码端口（`console` 隧道） |
| `QQ_AGENT_SYSTEMD_DIR` | `~/.config/systemd/user` | `install-timers` 写入目录 |
| `QQ_AGENT_SRC_DIR` | `$HOME/qq-agent-src` | `deploy` 的源码 checkout 目录（也可用 `--dir=`） |
| `QQ_AGENT_ROOT_DIR` | `QQ_AGENT_DIR` | `deploy` 的部署根目录（也可用 `--root-dir=`） |
| `QQ_AGENT_MODEL_API_KEY` / `QQ_AGENT_MODEL_KEY_FILE` | 无（必填其一） | 模型凭据（文件优先级低于环境变量） |
| `QQ_AGENT_MODEL_BASE_URL` / `QQ_AGENT_MODEL` | 无（必填） | 模型网关地址 / 模型名 |
| `SNOWLUMA_IMAGE` | `motricseven7/snowluma:v1.14.15` | 协议端镜像（`deploy`） |
| `QQ_AGENT_IMAGE_MIRROR` | 空 | 拉镜像失败时改走镜像站（逗号分隔多个；等价于 `deploy-all.sh --image-mirror`）。国内连不上 Docker Hub 时用，用法见 `docs/LINUX.md` |
| `QQ_AGENT_ONEBOT_WS_PORT` | `3391` | 协议端 WebSocket 端口（`deploy`） |
| `SSHHOST` / `QQ_AGENT_SSH` | **必填**（缺失直接报错退出） | 服务器地址；两种写法都支持：`SSHHOST=host` 或 `SSHHOST=user@host` / `QQ_AGENT_SSH=user@host` |
| `SSHUSER` | `ubuntu` | SSH 登录用户 |
| `SSHPORT` | `22` | SSH 端口 |

安全约定：token / 口令仅从环境变量或部署生成的配置文件读取，不得写入脚本或提交到仓库。

## 日志（级别 / 格式 / trace id）

应用日志（改进方案 #6）默认输出与升级前逐字相同：`text` 格式直通 stdout/stderr，只多了一层
脱敏（Bearer / 查询串 / JSON 体 / Cookie / 裸 `sk-`-`pk-`-`rk-` 开头的密钥），并且**一次运行内的
日志会自动带 `[<traceId>]` 前缀**。

- `QQ_AGENT_LOG_LEVEL=debug`：打开调试级（默认 `info`；也可设 `warn` / `error` 更严）；
- `QQ_AGENT_LOG_FORMAT=json`：每条一行 JSON（`{ts,level,scope,traceId,msg}`），方便 journald 过滤，
  例如 `journalctl --user -u qq-agent-linux.service -o cat | grep '"level":"error"'`；
- **traceId**：每次运行（消息唤醒、以及群日报 / 空间互动 / 每日动态的定时轮次）分配一个 8 位 id，
  这段运行里的日志都带同一个 id；控制台 HTTP 的响应头 `x-trace-id` 是那次请求的 id。
  排查"这一轮到底发生了什么"：
  ```bash
  journalctl --user -u qq-agent-linux.service -o cat | grep '<traceId>'
  # 或看接口：GET /api/status 的 lastTraceId 字段 = 最近一次运行的 id（控制台界面暂未展示）
  ```
- 注意：`node src/ops.js …` 这条链路的输出不走应用日志（仍是直接打印）。

## 退出码

| 子命令 | 退出码 |
| --- | --- |
| `scan` | 默认 0（只记录、不阻断）；`--strict` 下有可疑调用或目录不存在则退出 1 |
| `watch-send` | 0 = 工具层成功发出消息；1 = 发送失败或再次出现未定义函数；2 = 超时 |
| `watch-login` | 0 = 已登录；1 = 超时或缺少令牌 |
| `backup` / `deploy` / `install-timers` / `audit-prune` | 0 = 成功；1 = 参数或执行失败（缺少 `--confirm` 亦返回 1） |
| `audit` / `audit-host` / `guard` | 恒为 0（问题仅体现在 NG / [注意] 行数） |

## 定时任务

`install-timers` 生成四个 unit。`--print` 仅打印内容，`--confirm` 写入
`~/.config/systemd/user/` 并执行 `systemctl --user daemon-reload && enable --now`：

- `qq-agent-backup.timer`：`OnCalendar=Sun *-*-* 04:10:00`、`Persistent=true`，
  调用 `node src/ops.js backup --confirm`；
- `process-guard.timer`：`OnBootSec=3min`、`OnUnitActiveSec=10min`，
  调用 `node src/ops.js guard --confirm`；
- `qq-agent-health.timer`：`OnBootSec=5min`、`OnUnitActiveSec=5min`，
  调用 `node src/ops.js health-check --confirm`；
- `qq-agent-audit-prune.timer`：`OnCalendar=*-*-01 04:20:00`、`Persistent=true`，
  调用 `node src/ops.js audit-prune --confirm`（控制台写操作审计留痕的月度清理）。

生成的 ExecStart 使用当前 node 与 `src/ops.js` 的绝对路径。更换机器或部署目录后，重新执行
`install-timers --confirm` 即可，也可直接修改 unit 中的路径。

## 远程执行

仓库不再包含开发机专用的 ssh/paramiko 文件传输与执行脚本（原 `ops/sshcmd.py`、
`ops/sshrun.py`、`ops/sshupload.py`、`ops/sshget.py`）。**远程执行直接使用 `ssh` / `scp`**，
例如：

```bash
ssh user@host 'cd /data/qq-agent/app && node src/ops.js audit'
scp user@host:/data/qq-agent/data/messages.sqlite ./messages.sqlite
```

本项目仅额外提供 `console` 子命令用于端口隧道（控制台 / WebUI / 远程桌面），便于日常打开
控制台。

## 旧 ops/ 迁移对照

- 命令对应关系见上方子命令一览表；所有默认路径与变量名保持不变；
- 已知差异：
  - `watch-send` / `watch-login` 改为在本机（或通过 SSH 登录的目标机器）直接运行，不再内置
    SSH 客户端；轮询间隔新增 `--interval` 选项，便于调试；
  - `backup` 在缺少 `systemctl` 的环境（如 Windows）仅跳过停止/启动服务，仍会打包数据；
  - `scan` 默认带项目已知误报忽略表（等价于原 `check-undefined-calls.sh`），`--ignore=` 可
    关闭；`--log=文件` 等价于原启动自检的日志行为；
  - `audit` 的第 4 节会打印每个文件的未定义调用明细，并在结论中重复计数。
