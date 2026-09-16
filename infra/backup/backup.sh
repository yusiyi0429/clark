#!/usr/bin/env bash
# 宿主机 cron 备份（.tech/08 §11）：pg_dump(custom) → 非空校验 → age 加密 → checksum →
# SSH/SFTP 异机复制 → 异机与本机保留 BACKUP_RETENTION_DAYS（至少 7）天 → 删除本机明文。
# API 镜像不包含本脚本；真实凭据只从环境变量/受限文件读取，脚本不打印 secret。
# 用法：backup.sh [--dry-run]
set -euo pipefail

DRY_RUN=0
case "${1:-}" in
  --dry-run) DRY_RUN=1 ;;
  "" ) ;;
  -h|--help) sed -n '2,7p' "$0"; exit 0 ;;
  *) echo "未知参数: $1" >&2; exit 2 ;;
esac

die() { echo "backup: $*" >&2; exit 1; }
sha256() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$@"; else shasum -a 256 "$@"; fi; }
redact() {
  case "$1" in
    *://*@*) printf '%s' "${1%%://*}://***@${1##*@}" ;;
    *) printf '%s' "$1" ;;
  esac
}

: "${DATABASE_URL:?backup: 需要 DATABASE_URL（备份源库）}"
: "${BACKUP_AGE_RECIPIENT:?backup: 需要 BACKUP_AGE_RECIPIENT（age 公钥 age1...）}"
: "${BACKUP_SSH_HOST:?backup: 需要 BACKUP_SSH_HOST（异机地址）}"
: "${BACKUP_SSH_USER:?backup: 需要 BACKUP_SSH_USER}"
: "${BACKUP_SSH_PATH:?backup: 需要 BACKUP_SSH_PATH（异机目录）}"
: "${BACKUP_SSH_KEY_PATH:?backup: 需要 BACKUP_SSH_KEY_PATH（SSH 私钥，仅宿主机）}"

RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-7}"
[[ "$RETENTION_DAYS" =~ ^[0-9]+$ ]] || die "BACKUP_RETENTION_DAYS 必须是整数"
[ "$RETENTION_DAYS" -ge 7 ] || die "BACKUP_RETENTION_DAYS 至少为 7"
[ -f "$BACKUP_SSH_KEY_PATH" ] || die "BACKUP_SSH_KEY_PATH 不是文件: $BACKUP_SSH_KEY_PATH"

BACKUP_LOCAL_DIR="${BACKUP_LOCAL_DIR:-$HOME/warmap-backups}"
PG_DUMP_BIN="${PG_DUMP_BIN:-pg_dump}"
PSQL_BIN="${PSQL_BIN:-psql}"
AGE_BIN="${AGE_BIN:-age}"
SSH_BIN="${SSH_BIN:-ssh}"
SCP_BIN="${SCP_BIN:-scp}"
SSH_OPTS=(-i "$BACKUP_SSH_KEY_PATH" -o BatchMode=yes -o StrictHostKeyChecking=accept-new)
TARGET="${BACKUP_SSH_USER}@${BACKUP_SSH_HOST}"

timestamp=$(date -u +%Y%m%dT%H%M%SZ)
base="warmap-${timestamp}.dump"

echo "backup: 源=$(redact "$DATABASE_URL") 异机=${BACKUP_SSH_HOST}:${BACKUP_SSH_PATH} 保留=${RETENTION_DAYS}天 时间=${timestamp}"
if [ "$DRY_RUN" = 1 ]; then
  echo "backup: --dry-run：将执行 pg_dump → age -r → checksum → scp → 清理 ${RETENTION_DAYS} 天前备份；未执行任何写入"
  exit 0
fi

mkdir -p "$BACKUP_LOCAL_DIR"
tmpdir=$(mktemp -d "${TMPDIR:-/tmp}/warmap.XXXXXX")
trap 'rm -rf "$tmpdir"' EXIT
plain="$tmpdir/$base"
encrypted="$BACKUP_LOCAL_DIR/${base}.age"

# 1) dump（stdout 重定向：既支持本地 pg_dump，也支持 docker exec 容器化客户端）；2) 非空校验
"$PG_DUMP_BIN" --dbname="$DATABASE_URL" --format=custom --no-owner --no-privileges > "$plain"
[ -s "$plain" ] || die "pg_dump 产物为空，已中止（不覆盖异机历史备份）"

schema_version=$("$PSQL_BIN" "$DATABASE_URL" -Atc "SELECT coalesce(max(id), 0) FROM schema_migrations") \
  || die "无法读取 schema_migrations"

# 3) age 加密（只保留密文，明文在 trap 中删除）
"$AGE_BIN" -r "$BACKUP_AGE_RECIPIENT" -o "$encrypted" "$plain"
[ -s "$encrypted" ] || die "age 加密产物为空"

# 4) checksum + 元数据
( cd "$BACKUP_LOCAL_DIR" && sha256 "$(basename "$encrypted")" > "$(basename "$encrypted").sha256" ) || die "checksum 生成失败"
cat > "$BACKUP_LOCAL_DIR/${base}.meta.json" <<EOF
{"file":"$(basename "$encrypted")","createdAt":"$(date -u +%Y-%m-%dT%H:%M:%SZ)","schemaVersion":${schema_version},"retentionDays":${RETENTION_DAYS}}
EOF

# 5) 异机复制
"$SCP_BIN" "${SSH_OPTS[@]}" "$encrypted" "$BACKUP_LOCAL_DIR/${base}.age.sha256" "$BACKUP_LOCAL_DIR/${base}.meta.json" "$TARGET:${BACKUP_SSH_PATH}/" \
  || die "SCP 复制失败（本机密文保留在 ${BACKUP_LOCAL_DIR}，可重试）"

# 6) 保留策略：异机与本机同步清理
"$SSH_BIN" "${SSH_OPTS[@]}" "$TARGET" \
  "find '$BACKUP_SSH_PATH' -maxdepth 1 -type f -name 'warmap-*' -mtime +${RETENTION_DAYS} -delete" \
  || die "异机保留策略执行失败"
find "$BACKUP_LOCAL_DIR" -maxdepth 1 -type f -name 'warmap-*' -mtime "+${RETENTION_DAYS}" -delete

echo "backup: 完成 ${base}.age (schema=${schema_version})，明文已删除"
