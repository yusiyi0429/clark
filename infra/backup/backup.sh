#!/usr/bin/env bash
# 宿主机 cron 备份（.tech/08 §11）：pg_dump(custom) → 非空校验 → age 加密 → checksum →
# SSH/SFTP 异机复制 → 异机与本机保留 BACKUP_RETENTION_DAYS（至少 7）天 → 删除本机明文。
# 默认 BACKUP_SOURCE_MODE=compose：PostgreSQL 只在 Compose 内网，经 docker compose exec 在容器内 dump/查询；
# 不读取、不拼接、不打印 POSTGRES_PASSWORD。BACKUP_SOURCE_MODE=url 时兼容外部库（需 DATABASE_URL + 宿主 pg_dump/psql）。
# API 镜像不包含本脚本；真实凭据只从环境变量/受限文件读取，脚本不打印 secret。
# 用法：backup.sh [--dry-run]
set -euo pipefail

DRY_RUN=0
case "${1:-}" in
  --dry-run) DRY_RUN=1 ;;
  "" ) ;;
  -h|--help) sed -n '2,8p' "$0"; exit 0 ;;
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

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

SOURCE_MODE="${BACKUP_SOURCE_MODE:-compose}"
COMPOSE_FILE="${WARMAP_COMPOSE_FILE:-$REPO_ROOT/infra/docker-compose.yml}"
COMPOSE_ENV_FILE="${WARMAP_ENV_FILE:-$REPO_ROOT/infra/.env}"
COMPOSE_SERVICE="${WARMAP_PG_SERVICE:-postgres}"
DB_NAME="${WARMAP_DB_NAME:-warmap}"
DB_USER="${WARMAP_DB_USER:-warmap}"

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
AGE_BIN="${AGE_BIN:-age}"
SSH_BIN="${SSH_BIN:-ssh}"
SCP_BIN="${SCP_BIN:-scp}"
SSH_OPTS=(-i "$BACKUP_SSH_KEY_PATH" -o BatchMode=yes -o StrictHostKeyChecking=accept-new)
TARGET="${BACKUP_SSH_USER}@${BACKUP_SSH_HOST}"
SCHEMA_SQL="SELECT coalesce(max(id), 0) FROM schema_migrations"

# 源模式决定 dump/schema 命令；两种模式都不把密码写进命令行
case "$SOURCE_MODE" in
  compose)
    DUMP_DESC="docker compose -f $COMPOSE_FILE --env-file $COMPOSE_ENV_FILE exec -T $COMPOSE_SERVICE pg_dump -U $DB_USER -d $DB_NAME --format=custom --no-owner --no-privileges"
    SCHEMA_DESC="docker compose -f $COMPOSE_FILE --env-file $COMPOSE_ENV_FILE exec -T $COMPOSE_SERVICE psql -U $DB_USER -d $DB_NAME -Atc \"$SCHEMA_SQL\""
    run_dump() { docker compose -f "$COMPOSE_FILE" --env-file "$COMPOSE_ENV_FILE" exec -T "$COMPOSE_SERVICE" pg_dump -U "$DB_USER" -d "$DB_NAME" --format=custom --no-owner --no-privileges "$@" > "$plain"; }
    run_schema() { docker compose -f "$COMPOSE_FILE" --env-file "$COMPOSE_ENV_FILE" exec -T "$COMPOSE_SERVICE" psql -U "$DB_USER" -d "$DB_NAME" -Atc "$SCHEMA_SQL"; }
    ;;
  url)
    : "${DATABASE_URL:?backup: BACKUP_SOURCE_MODE=url 需要 DATABASE_URL（备份源库）}"
    PG_DUMP_BIN="${PG_DUMP_BIN:-pg_dump}"
    PSQL_BIN="${PSQL_BIN:-psql}"
    DUMP_DESC="$PG_DUMP_BIN --dbname=$(redact "$DATABASE_URL") --format=custom --no-owner --no-privileges"
    SCHEMA_DESC="$PSQL_BIN $(redact "$DATABASE_URL") -Atc \"$SCHEMA_SQL\""
    run_dump() { "$PG_DUMP_BIN" --dbname="$DATABASE_URL" --format=custom --no-owner --no-privileges > "$plain"; }
    run_schema() { "$PSQL_BIN" "$DATABASE_URL" -Atc "$SCHEMA_SQL"; }
    ;;
  *) die "BACKUP_SOURCE_MODE 只支持 compose 或 url（当前: ${SOURCE_MODE}）" ;;
esac

timestamp=$(date -u +%Y%m%dT%H%M%SZ)
base="warmap-${timestamp}.dump"

echo "backup: source_mode=$SOURCE_MODE 异机=${BACKUP_SSH_HOST}:${BACKUP_SSH_PATH} 保留=${RETENTION_DAYS}天 时间=${timestamp}"
if [ "$DRY_RUN" = 1 ]; then
  echo "backup: dump   → $DUMP_DESC"
  echo "backup: schema → $SCHEMA_DESC"
  if [ "$SOURCE_MODE" = compose ]; then
    echo "backup: compose_file=$COMPOSE_FILE($([ -f "$COMPOSE_FILE" ] && echo exists || echo missing)) env_file=$COMPOSE_ENV_FILE($([ -f "$COMPOSE_ENV_FILE" ] && echo exists || echo missing))"
  fi
  echo "backup: --dry-run：将执行 dump → age -r → checksum → scp → 清理 ${RETENTION_DAYS} 天前备份；未执行任何写入、未连接数据库、未触达远端"
  exit 0
fi

if [ "$SOURCE_MODE" = compose ]; then
  [ -f "$COMPOSE_FILE" ] || die "compose 文件不存在: $COMPOSE_FILE"
  [ -f "$COMPOSE_ENV_FILE" ] || die "compose env 文件不存在: $COMPOSE_ENV_FILE（默认 infra/.env）"
fi

mkdir -p "$BACKUP_LOCAL_DIR"
tmpdir=$(mktemp -d "${TMPDIR:-/tmp}/warmap.XXXXXX")
trap 'rm -rf "$tmpdir"' EXIT
plain="$tmpdir/$base"
encrypted="$BACKUP_LOCAL_DIR/${base}.age"

# 1) dump（stdout 重定向到本机临时文件）；2) 非空校验
run_dump
[ -s "$plain" ] || die "pg_dump 产物为空，已中止（不覆盖异机历史备份）"

schema_version=$(run_schema) || die "无法读取 schema_migrations"
[[ "$schema_version" =~ ^[0-9]+$ ]] || die "schema_migrations 返回值不合法"

# 3) age 加密（只保留密文，明文在 trap 中删除）
"$AGE_BIN" -r "$BACKUP_AGE_RECIPIENT" -o "$encrypted" "$plain"
[ -s "$encrypted" ] || die "age 加密产物为空"

# 4) checksum + 元数据
( cd "$BACKUP_LOCAL_DIR" && sha256 "$(basename "$encrypted")" > "$(basename "$encrypted").sha256" ) || die "checksum 生成失败"
cat > "$BACKUP_LOCAL_DIR/${base}.meta.json" <<EOF
{"file":"$(basename "$encrypted")","createdAt":"$(date -u +%Y-%m-%dT%H:%M:%SZ)","schemaVersion":${schema_version},"retentionDays":${RETENTION_DAYS},"sourceMode":"${SOURCE_MODE}"}
EOF

# 5) 异机复制
"$SCP_BIN" "${SSH_OPTS[@]}" "$encrypted" "$BACKUP_LOCAL_DIR/${base}.age.sha256" "$BACKUP_LOCAL_DIR/${base}.meta.json" "$TARGET:${BACKUP_SSH_PATH}/" \
  || die "SCP 复制失败（本机密文保留在 ${BACKUP_LOCAL_DIR}，可重试）"

# 6) 保留策略：异机与本机同步清理
"$SSH_BIN" "${SSH_OPTS[@]}" "$TARGET" \
  "find '$BACKUP_SSH_PATH' -maxdepth 1 -type f -name 'warmap-*' -mtime +${RETENTION_DAYS} -delete" \
  || die "异机保留策略执行失败"
find "$BACKUP_LOCAL_DIR" -maxdepth 1 -type f -name 'warmap-*' -mtime "+${RETENTION_DAYS}" -delete

echo "backup: 完成 ${base}.age (schema=${schema_version}, source_mode=${SOURCE_MODE})，明文已删除"
