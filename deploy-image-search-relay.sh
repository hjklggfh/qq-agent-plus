#!/usr/bin/env bash
# 独立安装东京搜图中转；不运行宿主 deploy.sh、不接触 QQ Agent 数据。
set -euo pipefail
if [[ "$(id -u)" == 0 ]]; then echo '请使用普通服务用户运行，不要 sudo 执行此脚本。' >&2; exit 1; fi
if [[ "$(uname -s)" != Linux ]]; then echo '此安装器仅支持 Linux。' >&2; exit 1; fi
RELAY_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
RELAY_STATE="${XDG_DATA_HOME:-$HOME/.local/share}/qq-image-search-relay"
RELAY_CONFIG="${XDG_CONFIG_HOME:-$HOME/.config}/qq-image-search-relay"
RELAY_UNITS="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
RELAY_CHROME=''
RELAY_NODE="$(command -v node || true)"
while (($#)); do
  case "$1" in
    --chrome) [[ $# -ge 2 ]] || exit 2; RELAY_CHROME="$2"; shift 2 ;;
    --node) [[ $# -ge 2 ]] || exit 2; RELAY_NODE="$2"; shift 2 ;;
    *) echo '用法：bash deploy-image-search-relay.sh [--chrome /绝对路径/chrome] [--node /绝对路径/node]' >&2; exit 2 ;;
  esac
done
for RELAY_PATH in "$RELAY_ROOT" "$RELAY_STATE" "$RELAY_CONFIG" "$RELAY_UNITS"; do
  [[ "$RELAY_PATH" =~ ^/[a-zA-Z0-9_./-]+$ ]] || { echo '安装路径不能含空格或特殊字符。' >&2; exit 1; }
done
[[ -f "$RELAY_ROOT/src/features/image-search/relay.js" ]] || { echo '请在完整源码仓库中执行。' >&2; exit 1; }
systemctl --user show-environment >/dev/null || { echo '当前用户的 systemd 服务不可用，请先启用用户服务。' >&2; exit 1; }
umask 077
mkdir -p "$RELAY_STATE" "$RELAY_CONFIG" "$RELAY_UNITS"
if [[ -z "$RELAY_NODE" ]] || ! "$RELAY_NODE" -e 'const [a,b,c]=process.versions.node.split(".").map(Number);process.exit(a>22||a===22&&(b>19||b===19&&c>=0)?0:1)' 2>/dev/null; then
  RELAY_NODE_VERSION='22.23.2'
  case "$(uname -m)" in x86_64) RELAY_ARCH=x64 ;; aarch64|arm64) RELAY_ARCH=arm64 ;; *) echo '暂不支持此CPU架构。' >&2; exit 1 ;; esac
  RELAY_ARCHIVE="node-v${RELAY_NODE_VERSION}-linux-${RELAY_ARCH}.tar.xz"
  mkdir -p "$RELAY_STATE/runtime"
  RELAY_NODE="$RELAY_STATE/runtime/node-v${RELAY_NODE_VERSION}-linux-${RELAY_ARCH}/bin/node"
  if [[ ! -x "$RELAY_NODE" ]]; then
    echo '正在下载并校验独立 Node.js 运行时…'
    curl -fSL --retry 2 "https://nodejs.org/dist/v${RELAY_NODE_VERSION}/$RELAY_ARCHIVE" -o "$RELAY_STATE/runtime/$RELAY_ARCHIVE"
    curl -fsSL "https://nodejs.org/dist/v${RELAY_NODE_VERSION}/SHASUMS256.txt" -o "$RELAY_STATE/runtime/SHASUMS256.txt"
    (cd "$RELAY_STATE/runtime"; awk -v f="$RELAY_ARCHIVE" '$2 == f { print; found=1 } END { if (!found) exit 1 }' SHASUMS256.txt | sha256sum -c -)
    tar -xJf "$RELAY_STATE/runtime/$RELAY_ARCHIVE" -C "$RELAY_STATE/runtime"
  fi
fi
[[ "$RELAY_NODE" =~ ^/[a-zA-Z0-9_./-]+$ ]] || { echo 'Node 路径必须为不含特殊字符的绝对路径。' >&2; exit 1; }
if [[ -n "$RELAY_CHROME" ]]; then
  [[ "$RELAY_CHROME" =~ ^/[a-zA-Z0-9_./-]+$ && -x "$RELAY_CHROME" ]] || { echo 'Chrome 路径无效。' >&2; exit 1; }
fi
RELAY_NPM="$(dirname "$RELAY_NODE")/npm"
[[ -x "$RELAY_NPM" ]] || { echo 'Node 同目录中缺少 npm。' >&2; exit 1; }
(cd "$RELAY_ROOT"; PATH="$(dirname "$RELAY_NODE"):$PATH" "$RELAY_NPM" ci --omit=dev --ignore-scripts --no-audit --no-fund)
if [[ ! -e "$RELAY_CONFIG/env" ]]; then
  printf 'IMAGE_SEARCH_RELAY_TOKEN=%s\n' "$("$RELAY_NODE" -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))')" > "$RELAY_CONFIG/env"
fi
if [[ -n "$RELAY_CHROME" ]]; then
  # 仅更新浏览器路径，保留已有中转令牌。
  sed '/^IMAGE_SEARCH_CHROME=/d' "$RELAY_CONFIG/env" > "$RELAY_CONFIG/env.tmp"
  printf 'IMAGE_SEARCH_CHROME=%s\n' "$RELAY_CHROME" >> "$RELAY_CONFIG/env.tmp"
  mv "$RELAY_CONFIG/env.tmp" "$RELAY_CONFIG/env"
fi
chmod 600 "$RELAY_CONFIG/env"
cat > "$RELAY_UNITS/qq-image-search-relay.service" <<EOF
[Unit]
Description=QQ Agent image search relay
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$RELAY_ROOT
EnvironmentFile=$RELAY_CONFIG/env
ExecStart=$RELAY_NODE $RELAY_ROOT/src/features/image-search/relay.js
Restart=on-failure
RestartSec=5
TimeoutStopSec=15
MemoryMax=900M
UMask=0077
PrivateTmp=true

[Install]
WantedBy=default.target
EOF
systemctl --user daemon-reload
systemctl --user enable --now qq-image-search-relay.service
systemctl --user restart qq-image-search-relay.service
echo '中转已安装，监听 127.0.0.1:3220。'
echo "令牌保存在 $RELAY_CONFIG/env（不要贴到群聊或公开日志）。"
echo '检查状态：systemctl --user status qq-image-search-relay.service'
echo '保持退出登录后运行：sudo loginctl enable-linger "$(whoami)"'
