#!/bin/sh
# 安装本机采集器（macOS）：脚本放到 ~/.tkos-world/collector，
# 注册 launchd 任务：StartInterval 1800（每 30 分钟），加载时跑一次；睡眠错过的醒来后补跑。
# 用法：sh install-macos.sh --server https://天枢地址 [--python 路径] [--eod 20:30] [--dry-run]
set -eu

SERVER=""; PY=""; EOD="20:30"; DRY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --server) SERVER="$2"; shift 2 ;;
    --python) PY="$2"; shift 2 ;;
    --eod) EOD="$2"; shift 2 ;;
    --dry-run) DRY=1; shift ;;
    *) echo "不认识的参数：$1" >&2; exit 2 ;;
  esac
done
[ -n "$SERVER" ] || { echo "缺 --server（天枢地址）" >&2; exit 2; }
case "$EOD" in [01][0-9]:[0-5][0-9]|2[0-3]:[0-5][0-9]) ;; *) echo "--eod 要写成 HH:MM" >&2; exit 2 ;; esac

LABEL="com.tokenkingos.tkos-collector"
ROOT="$HOME/.tkos-world"
TARGET="$ROOT/collector"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
HERE="$(cd "$(dirname "$0")" && pwd)"
if [ -z "$PY" ]; then
  if [ -x "$ROOT/venv/bin/python" ]; then PY="$ROOT/venv/bin/python"; else PY="$(command -v python3 || true)"; fi
fi
[ -n "$PY" ] || { echo "没找到 python3：先装 Python 3，或用 --python 指定" >&2; exit 2; }

plist() {
  cat <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array><string>$PY</string><string>$TARGET/tkos_collector.py</string><string>check</string></array>
  <key>WorkingDirectory</key><string>$TARGET</string>
  <key>StartInterval</key><integer>1800</integer>
  <key>RunAtLoad</key><true/>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>$ROOT/logs/collector.log</string>
  <key>StandardErrorPath</key><string>$ROOT/logs/collector.log</string>
</dict>
</plist>
EOF
}

if [ "$DRY" = 1 ]; then
  echo "[dry-run] 复制 tkos_collector.py、collect_sessions.py 到 $TARGET"
  echo "[dry-run] 写配置 $ROOT/collector.json：server=$SERVER eod_time=$EOD"
  [ -f "$ROOT/collector.token" ] || echo "[dry-run] 提示粘贴采集器令牌，存到 $ROOT/collector.token"
  echo "[dry-run] 写 $PLIST 并 launchctl bootstrap gui/$(id -u)："
  plist
  exit 0
fi

mkdir -p "$TARGET" "$ROOT/logs" "$HOME/Library/LaunchAgents"
cp "$HERE/tkos_collector.py" "$HERE/collect_sessions.py" "$TARGET/"
"$PY" -c 'import json,sys; json.dump({"server": sys.argv[1], "eod_time": sys.argv[2]}, open(sys.argv[3], "w"), ensure_ascii=False)' \
  "$SERVER" "$EOD" "$ROOT/collector.json"
if [ ! -f "$ROOT/collector.token" ]; then
  printf '粘贴天枢里生成的「本机采集器」令牌：'
  stty -echo; read -r TOKEN; stty echo; echo
  [ -n "$TOKEN" ] || { echo "没有令牌，安装中止" >&2; exit 1; }
  (umask 077; printf '%s' "$TOKEN" > "$ROOT/collector.token")
fi
plist > "$PLIST"
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "已注册 launchd 任务 $LABEL，日志在 $ROOT/logs/collector.log。"
