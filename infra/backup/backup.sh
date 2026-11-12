#!/usr/bin/env bash
# 宿主机 cron 备份（.tech/08 §11 + ADR 0017）：同一 UTC 批次内
#   停 API（仅当其在运行）→ pg_dump(custom) → schema 版本 → 存储行清单 →
#   meeting_materials + conversation_attachments + meeting_recordings 三个 API volume 与 wechat_data 卷 tar →
#   非空校验 → age 加密 → checksum → SSH/SFTP 异机复制 → 保留策略 → trap 重启 API → 删除本机明文。
# 默认 BACKUP_SOURCE_MODE=compose：PostgreSQL 与各 volume 都在 Compose 内网，经 docker compose 执行；
# 不读取、不拼接、不打印 POSTGRES_PASSWORD。BACKUP_SOURCE_MODE=url 时仅备份数据库：
# volume 数据（会前材料/会话附件/录音/公众号登录与订阅）不在该模式覆盖范围内，恢复亦不支持——脚本会显式打印该限制。
# API 镜像不包含本脚本；真实凭据只从环境变量/受限文件读取，脚本不打印 secret。
# BACKUP_TARGET=local 时只留本机（BACKUP_LOCAL_DIR），不要求也不连接 SSH 异机——脚本会显式声明这不是异地备份。
# WARMAP_COMPOSE_OVERRIDE 可追加一份 compose 覆盖文件（火山主机用 infra/volcano.override.yml）。
# 用法：backup.sh [--dry-run]
set -euo pipefail

DRY_RUN=0
case "${1:-}" in
  --dry-run) DRY_RUN=1 ;;
  "" ) ;;
  -h|--help) sed -n '2,9p' "$0"; exit 0 ;;
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
COMPOSE_OVERRIDE="${WARMAP_COMPOSE_OVERRIDE:-}"
COMPOSE_ENV_FILE="${WARMAP_ENV_FILE:-$REPO_ROOT/infra/.env}"
COMPOSE_SERVICE="${WARMAP_PG_SERVICE:-postgres}"
API_SERVICE="${WARMAP_API_SERVICE:-api}"
DB_NAME="${WARMAP_DB_NAME:-warmap}"
DB_USER="${WARMAP_DB_USER:-warmap}"
# API volume（ADR 0017）与公众号 sidecar 数据卷；名字与 infra/docker-compose.yml 一致
VOLUME_MEETING="${WARMAP_VOLUME_MEETING:-meeting_materials}"
VOLUME_ATTACHMENT="${WARMAP_VOLUME_ATTACHMENT:-conversation_attachments}"
VOLUME_RECORDING="${WARMAP_VOLUME_RECORDING:-meeting_recordings}"
VOLUME_WECHAT="${WARMAP_VOLUME_WECHAT:-wechat_data}"
WECHAT_SERVICE="${WARMAP_WECHAT_SERVICE:-wechat}"

TARGET_MODE="${BACKUP_TARGET:-ssh}"
case "$TARGET_MODE" in ssh|local) ;; *) die "BACKUP_TARGET 只支持 ssh 或 local（当前: ${TARGET_MODE}）" ;; esac

: "${BACKUP_AGE_RECIPIENT:?backup: 需要 BACKUP_AGE_RECIPIENT（age 公钥 age1...）}"
if [ "$TARGET_MODE" = ssh ]; then
  : "${BACKUP_SSH_HOST:?backup: 需要 BACKUP_SSH_HOST（异机地址）}"
  : "${BACKUP_SSH_USER:?backup: 需要 BACKUP_SSH_USER}"
  : "${BACKUP_SSH_PATH:?backup: 需要 BACKUP_SSH_PATH（异机目录）}"
  : "${BACKUP_SSH_KEY_PATH:?backup: 需要 BACKUP_SSH_KEY_PATH（SSH 私钥，仅宿主机）}"
fi

RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-7}"
[[ "$RETENTION_DAYS" =~ ^[0-9]+$ ]] || die "BACKUP_RETENTION_DAYS 必须是整数"
[ "$RETENTION_DAYS" -ge 7 ] || die "BACKUP_RETENTION_DAYS 至少为 7"
if [ "$TARGET_MODE" = ssh ]; then
  [ -f "$BACKUP_SSH_KEY_PATH" ] || die "BACKUP_SSH_KEY_PATH 不是文件: $BACKUP_SSH_KEY_PATH"
fi

BACKUP_LOCAL_DIR="${BACKUP_LOCAL_DIR:-$HOME/warmap-backups}"
AGE_BIN="${AGE_BIN:-age}"
SSH_BIN="${SSH_BIN:-ssh}"
SCP_BIN="${SCP_BIN:-scp}"
SSH_OPTS=(-i "${BACKUP_SSH_KEY_PATH:-}" -o BatchMode=yes -o StrictHostKeyChecking=accept-new)
TARGET="${BACKUP_SSH_USER:-}@${BACKUP_SSH_HOST:-}"
SCHEMA_SQL="SELECT coalesce(max(id), 0) FROM schema_migrations"
# 存储行清单：materials 与会话附件的 storageKey/SHA 都以 DB 为准（manifest 的校验基准）
STORAGE_ROWS_SQL="SELECT 'meeting_material|' || m.id || '|' || (value->>'storageKey') || '|' || (value->>'sha256') FROM meetings m, jsonb_array_elements(m.materials) value WHERE value->>'storageKey' <> '' UNION ALL SELECT 'conversation_attachment|' || cm.conversation_id || ':' || cm.sequence || '|' || (a->>'storageKey') || '|' || (a->>'sha256') FROM conversation_messages cm, jsonb_array_elements(cm.attachments) a WHERE a->>'storageKey' <> ''"

COMPOSE_FILES=(-f "$COMPOSE_FILE")
[ -n "$COMPOSE_OVERRIDE" ] && COMPOSE_FILES+=(-f "$COMPOSE_OVERRIDE")
compose() { docker compose "${COMPOSE_FILES[@]}" --env-file "$COMPOSE_ENV_FILE" "$@"; }

case "$SOURCE_MODE" in
  compose)
    DUMP_DESC="docker compose -f $COMPOSE_FILE --env-file $COMPOSE_ENV_FILE exec -T $COMPOSE_SERVICE pg_dump -U $DB_USER -d $DB_NAME --format=custom --no-owner --no-privileges"
    SCHEMA_DESC="docker compose -f $COMPOSE_FILE --env-file $COMPOSE_ENV_FILE exec -T $COMPOSE_SERVICE psql -U $DB_USER -d $DB_NAME -Atc \"$SCHEMA_SQL\""
    STORAGE_DESC="docker compose -f $COMPOSE_FILE --env-file $COMPOSE_ENV_FILE exec -T $COMPOSE_SERVICE psql -U $DB_USER -d $DB_NAME -Atc \"$STORAGE_ROWS_SQL\""
    VOLUME_DESC="docker compose -f $COMPOSE_FILE --env-file $COMPOSE_ENV_FILE run --rm --no-deps -T --entrypoint tar $API_SERVICE czf - -C /var/lib/warmap/<volume> .（$VOLUME_WECHAT 经 $WECHAT_SERVICE 的 /app/data）"
    FREEZE_DESC="docker compose ps -q $API_SERVICE → 若在运行：docker stop <容器id>（EXIT trap 按同一 id docker start）"
    run_dump() { compose exec -T "$COMPOSE_SERVICE" pg_dump -U "$DB_USER" -d "$DB_NAME" --format=custom --no-owner --no-privileges "$@" > "$plain"; }
    run_schema() { compose exec -T "$COMPOSE_SERVICE" psql -U "$DB_USER" -d "$DB_NAME" -Atc "$SCHEMA_SQL"; }
    run_storage_rows() { compose exec -T "$COMPOSE_SERVICE" psql -U "$DB_USER" -d "$DB_NAME" -Atc "$STORAGE_ROWS_SQL"; }
    archive_volume() { compose run --rm --no-deps -T --entrypoint tar "$API_SERVICE" czf - -C "/var/lib/warmap/$1" . > "$2"; }
    # 公众号登录态与订阅只在 sidecar 卷里；用 sidecar 自己的镜像（自带 tar）挂同一卷归档
    archive_wechat() { compose run --rm --no-deps -T --entrypoint tar "$WECHAT_SERVICE" czf - -C /app/data . > "$1"; }
    ;;
  url)
    : "${DATABASE_URL:?backup: BACKUP_SOURCE_MODE=url 需要 DATABASE_URL（备份源库）}"
    PG_DUMP_BIN="${PG_DUMP_BIN:-pg_dump}"
    PSQL_BIN="${PSQL_BIN:-psql}"
    DUMP_DESC="$PG_DUMP_BIN --dbname=$(redact "$DATABASE_URL") --format=custom --no-owner --no-privileges"
    SCHEMA_DESC="$PSQL_BIN $(redact "$DATABASE_URL") -Atc \"$SCHEMA_SQL\""
    STORAGE_DESC="$PSQL_BIN $(redact "$DATABASE_URL") -Atc \"$STORAGE_ROWS_SQL\""
    VOLUME_DESC="（url 模式无 volume 归档）"
    FREEZE_DESC="（url 模式不停止任何服务）"
    run_dump() { "$PG_DUMP_BIN" --dbname="$DATABASE_URL" --format=custom --no-owner --no-privileges > "$plain"; }
    run_schema() { "$PSQL_BIN" "$DATABASE_URL" -Atc "$SCHEMA_SQL"; }
    run_storage_rows() { "$PSQL_BIN" "$DATABASE_URL" -Atc "$STORAGE_ROWS_SQL"; }
    archive_volume() { die "url 模式不支持 volume 归档"; }
    archive_wechat() { die "url 模式不支持 volume 归档"; }
    ;;
  *) die "BACKUP_SOURCE_MODE 只支持 compose 或 url（当前: ${SOURCE_MODE}）" ;;
esac

timestamp=$(date -u +%Y%m%dT%H%M%SZ)
base="warmap-${timestamp}"

if [ "$TARGET_MODE" = local ]; then
  echo "backup: source_mode=$SOURCE_MODE target=local 本机=${BACKUP_LOCAL_DIR} 保留=${RETENTION_DAYS}天 时间=${timestamp}"
  echo "backup: 警告：target=local 只留在本机，不是异地备份；主机或数据盘损坏时备份一起丢失"
else
  echo "backup: source_mode=$SOURCE_MODE 异机=${BACKUP_SSH_HOST}:${BACKUP_SSH_PATH} 保留=${RETENTION_DAYS}天 时间=${timestamp}"
fi
if [ "$DRY_RUN" = 1 ]; then
  echo "backup: freeze → $FREEZE_DESC"
  echo "backup: dump   → $DUMP_DESC"
  echo "backup: schema → $SCHEMA_DESC"
  echo "backup: storage→ $STORAGE_DESC"
  echo "backup: volume → $VOLUME_DESC"
  if [ "$SOURCE_MODE" = "url" ]; then
    echo "backup: 警告：url 模式仅备份数据库；meeting_materials/conversation_attachments/meeting_recordings/wechat_data 卷数据不在覆盖范围，该备份不能用于卷恢复"
  fi
  if [ "$SOURCE_MODE" = compose ]; then
    echo "backup: compose_file=$COMPOSE_FILE($([ -f "$COMPOSE_FILE" ] && echo exists || echo missing)) env_file=$COMPOSE_ENV_FILE($([ -f "$COMPOSE_ENV_FILE" ] && echo exists || echo missing))"
  fi
  echo "backup: --dry-run：将按 freeze → dump → manifest → volume×4 → 加密 → checksum → scp → 保留策略 → 重启 API 执行；未执行任何写入、未连接数据库、未触达远端"
  exit 0
fi

if [ "$SOURCE_MODE" = compose ]; then
  [ -f "$COMPOSE_FILE" ] || die "compose 文件不存在: $COMPOSE_FILE"
  [ -f "$COMPOSE_ENV_FILE" ] || die "compose env 文件不存在: ${COMPOSE_ENV_FILE}（默认 infra/.env）"
fi

make_checksum() { ( cd "$(dirname "$1")" && sha256 "$(basename "$1")" > "$(basename "$1").sha256" ); }

mkdir -p "$BACKUP_LOCAL_DIR"
tmpdir=$(mktemp -d "${TMPDIR:-/tmp}/warmap.XXXXXX")
API_CONTAINERS=""
on_exit() {
  # 只重启备份前确实在运行的 API 容器；按 id 用 docker start，不走 compose start（它会连带检查依赖服务，生产上曾因此起不来）
  if [ "$SOURCE_MODE" = compose ] && [ -n "$API_CONTAINERS" ]; then
    # shellcheck disable=SC2086
    docker start $API_CONTAINERS >/dev/null || echo "backup: 警告：API 重启失败，请手动 docker start $API_CONTAINERS" >&2
  fi
  rm -rf "$tmpdir"
}
trap on_exit EXIT

plain="$tmpdir/$base.dump"

if [ "$SOURCE_MODE" = compose ]; then
  # 冻结写入口：只停止 API（唯一写方），PostgreSQL/edge/wechat 不动
  running_ids=$(compose ps -q "$API_SERVICE" || true)
  if [ -n "$running_ids" ]; then
    API_CONTAINERS=$(echo $running_ids)
    # shellcheck disable=SC2086
    docker stop $API_CONTAINERS >/dev/null
    echo "backup: 已停止 ${API_SERVICE}（写冻结）"
  else
    echo "backup: $API_SERVICE 未在运行，无需冻结"
  fi
fi

# 1) dump；2) 非空校验
run_dump
[ -s "$plain" ] || die "pg_dump 产物为空，已中止（不覆盖异机历史备份）"

schema_version=$(run_schema) || die "无法读取 schema_migrations"
[[ "$schema_version" =~ ^[0-9]+$ ]] || die "schema_migrations 返回值不合法"

# 3) 存储行清单（DB 为唯一事实：materials + 会话附件的 storageKey/SHA）
if [ "$SOURCE_MODE" = url ]; then
  echo "backup: 警告：url 模式仅备份数据库；meeting_materials/conversation_attachments/meeting_recordings/wechat_data 卷数据不在覆盖范围，该备份不能用于卷恢复"
fi
run_storage_rows > "$tmpdir/storage_rows.txt" || die "无法读取存储行清单"
storage_row_count=$(wc -l < "$tmpdir/storage_rows.txt" | tr -d ' ')

if [ "$SOURCE_MODE" = compose ]; then
  # 4) 四个 volume 归档（同一 UTC 批次）；空卷的 tar.gz 也非空，空文件说明归档失败
  for vol in "$VOLUME_MEETING" "$VOLUME_ATTACHMENT" "$VOLUME_RECORDING"; do
    archive_volume "$vol" "$tmpdir/$vol.tar.gz"
    [ -s "$tmpdir/$vol.tar.gz" ] || die "$vol 卷归档为空，已中止"
  done
  archive_wechat "$tmpdir/$VOLUME_WECHAT.tar.gz"
  [ -s "$tmpdir/$VOLUME_WECHAT.tar.gz" ] || die "$VOLUME_WECHAT 卷归档为空，已中止"
fi

# 5) 加密 + checksum：dump 与各卷归档分别加密；manifest 无敏感内容，保持明文便于异机盘点
"$AGE_BIN" -r "$BACKUP_AGE_RECIPIENT" -o "$BACKUP_LOCAL_DIR/$base.dump.age" "$plain"
[ -s "$BACKUP_LOCAL_DIR/$base.dump.age" ] || die "age 加密产物为空"
make_checksum "$BACKUP_LOCAL_DIR/$base.dump.age"

manifest="$BACKUP_LOCAL_DIR/$base.manifest.json"
{
  echo "{\"batch\":\"$base\",\"createdAt\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"schemaVersion\":${schema_version},\"sourceMode\":\"${SOURCE_MODE}\",\"retentionDays\":${RETENTION_DAYS},\"volumes\":[\"$VOLUME_MEETING\",\"$VOLUME_ATTACHMENT\",\"$VOLUME_RECORDING\",\"$VOLUME_WECHAT\"],\"storageRowCount\":${storage_row_count},\"storageRows\":["
  awk '{ if (NR > 1) printf ","; printf "\"%s\"", $0 }' "$tmpdir/storage_rows.txt"
  echo "]}"
} > "$manifest"

artifacts=("$BACKUP_LOCAL_DIR/$base.dump.age")
if [ "$SOURCE_MODE" = compose ]; then
  for vol in "$VOLUME_MEETING" "$VOLUME_ATTACHMENT" "$VOLUME_RECORDING" "$VOLUME_WECHAT"; do
    "$AGE_BIN" -r "$BACKUP_AGE_RECIPIENT" -o "$BACKUP_LOCAL_DIR/$base.$vol.tar.gz.age" "$tmpdir/$vol.tar.gz"
    [ -s "$BACKUP_LOCAL_DIR/$base.$vol.tar.gz.age" ] || die "age 加密卷归档为空: $vol"
    make_checksum "$BACKUP_LOCAL_DIR/$base.$vol.tar.gz.age"
    artifacts+=("$BACKUP_LOCAL_DIR/$base.$vol.tar.gz.age")
  done
fi
make_checksum "$manifest"
artifacts+=("$manifest")

# 6) 异机复制（同批次全部产物）；target=local 跳过
if [ "$TARGET_MODE" = ssh ]; then
"$SCP_BIN" "${SSH_OPTS[@]}" \
  "$BACKUP_LOCAL_DIR/$base.dump.age" "$BACKUP_LOCAL_DIR/$base.dump.age.sha256" \
  "$manifest" "$manifest.sha256" \
  "$TARGET:$BACKUP_SSH_PATH/" \
  || die "SCP 复制失败（本机密文保留在 ${BACKUP_LOCAL_DIR}，可重试）"
if [ "$SOURCE_MODE" = compose ]; then
  volume_files=()
  for vol in "$VOLUME_MEETING" "$VOLUME_ATTACHMENT" "$VOLUME_RECORDING" "$VOLUME_WECHAT"; do
    volume_files+=("$BACKUP_LOCAL_DIR/$base.$vol.tar.gz.age" "$BACKUP_LOCAL_DIR/$base.$vol.tar.gz.age.sha256")
  done
  "$SCP_BIN" "${SSH_OPTS[@]}" "${volume_files[@]}" "$TARGET:$BACKUP_SSH_PATH/" \
    || die "SCP 复制卷归档失败（本机密文保留在 ${BACKUP_LOCAL_DIR}，可重试）"
fi

fi

# 7) 保留策略：异机（仅 ssh）与本机同步清理
if [ "$TARGET_MODE" = ssh ]; then
  "$SSH_BIN" "${SSH_OPTS[@]}" "$TARGET" \
    "find '$BACKUP_SSH_PATH' -maxdepth 1 -type f -name 'warmap-*' -mtime +${RETENTION_DAYS} -delete" \
    || die "异机保留策略执行失败"
fi
find "$BACKUP_LOCAL_DIR" -maxdepth 1 -type f -name 'warmap-*' -mtime "+${RETENTION_DAYS}" -delete

echo "backup: 完成 $base 批次 (schema=${schema_version}, source_mode=${SOURCE_MODE}, storage_rows=${storage_row_count}, volumes=4)，明文已删除，API 状态已恢复"
