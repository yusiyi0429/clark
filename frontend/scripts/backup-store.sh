#!/usr/bin/env bash
# .data/store.json 带日期拷一份。一行 crontab 的那个「一行」。
#
#   0 3 * * * /srv/tkos/scripts/backup-store.sh >> /var/log/tkos-backup.log 2>&1
#
# 为什么必须有：那一个文件里装着一号位一个月的议题、判断、决定，和几个 DRI 的
# 全部回传。不备份等于拿一个月的真实数据赌一次磁盘。
set -euo pipefail

SRC="${TKOS_DATA_DIR:-/srv/tkos/.data}/store.json"
DEST="${TKOS_BACKUP_DIR:-/srv/tkos/backups}"
KEEP="${TKOS_BACKUP_KEEP:-30}"

if [ ! -f "$SRC" ]; then
  echo "[tkos:backup] 没有 $SRC —— 应用还没写过盘，或者路径配错了。"
  exit 1
fi

mkdir -p "$DEST"
STAMP="$(date +%Y%m%d-%H%M%S)"
cp "$SRC" "$DEST/store-$STAMP.json"
echo "[tkos:backup] $DEST/store-$STAMP.json（$(wc -c <"$SRC") 字节）"

# 只留最近 KEEP 份。`ls -t` 按时间倒序，tail 掉前 KEEP 个之后的全删。
ls -t "$DEST"/store-*.json | tail -n "+$((KEEP + 1))" | xargs -r rm --
