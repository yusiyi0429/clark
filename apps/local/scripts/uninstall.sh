#!/bin/sh
# 天枢本机程序 · macOS 卸载。本机数据默认保留，TIANSHU_LOCAL_PURGE=1 时一起删（钥匙串里 tianshu-local 的条目也删）。Claude Code 不动。
set -u
DIR="$HOME/Library/Application Support/Tianshu/bin"
DATA="$HOME/Library/Application Support/Tianshu/local"
PLIST="$HOME/Library/LaunchAgents/com.tokenkingos.tianshu-local.plist"

printf '天枢本机程序 · 卸载\n'
launchctl bootout "gui/$(id -u)/com.tokenkingos.tianshu-local" 2>/dev/null || true
pkill -f "^$DIR/tianshu-local" 2>/dev/null || true
rm -f "$PLIST"
rm -rf "$DIR"
if [ "${TIANSHU_LOCAL_PURGE:-}" = "1" ]; then
  rm -rf "$DATA"
  while security delete-generic-password -s tianshu-local >/dev/null 2>&1; do :; done
  printf '  本机数据和钥匙串条目也删了\n'
else
  printf '  本机数据保留在 %s（要删就设 TIANSHU_LOCAL_PURGE=1 再跑一次）\n' "$DATA"
fi
printf '已卸载。\n'
