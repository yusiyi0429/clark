#!/bin/sh
# 卸载本机采集器（macOS）：停掉并删除 launchd 任务和 ~/.tkos-world/collector。
# 用法：sh uninstall-macos.sh [--purge 连令牌、配置、水位线一起删] [--dry-run]
set -eu

PURGE=0; DRY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --purge) PURGE=1; shift ;;
    --dry-run) DRY=1; shift ;;
    *) echo "不认识的参数：$1" >&2; exit 2 ;;
  esac
done

LABEL="com.tokenkingos.tkos-collector"
ROOT="$HOME/.tkos-world"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
PATHS="$ROOT/collector $PLIST"
[ "$PURGE" = 1 ] && PATHS="$PATHS $ROOT/collector.token $ROOT/collector.json $ROOT/daily-state.json"

if [ "$DRY" = 1 ]; then
  echo "[dry-run] launchctl bootout gui/$(id -u)/$LABEL"
  for p in $PATHS; do echo "[dry-run] 删除 $p"; done
  exit 0
fi
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
for p in $PATHS; do rm -rf "$p"; done
echo "已卸载本机采集器。"
