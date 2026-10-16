#!/usr/bin/env bash
# 独立恢复流程（.tech/08 §11 + ADR 0017）：只恢复到空 PostgreSQL 与显式指定的空 volume，不覆盖现有库。
# 默认 dry-run；必须显式 --execute 才写。任何一步不满足即中止，不做自动回滚。
# 不带卷参数时为数据库-only 恢复：显式不支持 meeting_materials / conversation_attachments /
# meeting_recordings / wechat_data 卷数据，脚本会打印该限制；完整恢复必须同时提供四个卷各自的
# --<卷>-archive 与 --<卷>-volume（目标卷必须已存在且为空）。
# 恢复完成后以 DB 为准校验每个 storageKey 的 SHA-256 与卷内文件一致；不一致立即失败（fail closed）。
# 用法：restore.sh --backup <file.dump.age> [--checksum <file.sha256>] --target-url <postgres://...>
#                 [--age-identity <key.txt>] [--execute]
#                 [--meeting-materials-archive <tar.gz.age>] [--meeting-materials-volume <name>]
#                 [--conversation-attachments-archive <tar.gz.age>] [--conversation-attachments-volume <name>]
#                 [--meeting-recordings-archive <tar.gz.age>] [--meeting-recordings-volume <name>]
#                 [--wechat-data-archive <tar.gz.age>] [--wechat-data-volume <name>]
set -euo pipefail

EXECUTE=0
BACKUP_FILE=""
TARGET_URL=""
CHECKSUM_FILE=""
AGE_IDENTITY="${BACKUP_AGE_IDENTITY:-}"
MEETING_ARCHIVE=""
MEETING_VOLUME=""
ATTACHMENT_ARCHIVE=""
ATTACHMENT_VOLUME=""
RECORDING_ARCHIVE=""
RECORDING_VOLUME=""
WECHAT_ARCHIVE=""
WECHAT_VOLUME=""
# 卷内文件属主：API 镜像以 node(1000:1000) 运行（deployment.test.ts 断言非 root）
VOLUME_UID="${WARMAP_VOLUME_UID:-1000}"
VOLUME_GID="${WARMAP_VOLUME_GID:-1000}"
VOLUME_IMAGE="${WARMAP_VOLUME_IMAGE:-alpine:3.20}"

while [ $# -gt 0 ]; do
  case "$1" in
    --execute) EXECUTE=1 ;;
    --dry-run) EXECUTE=0 ;;
    --backup) BACKUP_FILE="${2:?restore: --backup 需要路径}"; shift ;;
    --checksum) CHECKSUM_FILE="${2:?restore: --checksum 需要路径}"; shift ;;
    --target-url) TARGET_URL="${2:?restore: --target-url 需要连接串}"; shift ;;
    --age-identity) AGE_IDENTITY="${2:?restore: --age-identity 需要路径}"; shift ;;
    --meeting-materials-archive) MEETING_ARCHIVE="${2:?restore: --meeting-materials-archive 需要路径}"; shift ;;
    --meeting-materials-volume) MEETING_VOLUME="${2:?restore: --meeting-materials-volume 需要卷名}"; shift ;;
    --conversation-attachments-archive) ATTACHMENT_ARCHIVE="${2:?restore: --conversation-attachments-archive 需要路径}"; shift ;;
    --conversation-attachments-volume) ATTACHMENT_VOLUME="${2:?restore: --conversation-attachments-volume 需要卷名}"; shift ;;
    --meeting-recordings-archive) RECORDING_ARCHIVE="${2:?restore: --meeting-recordings-archive 需要路径}"; shift ;;
    --meeting-recordings-volume) RECORDING_VOLUME="${2:?restore: --meeting-recordings-volume 需要卷名}"; shift ;;
    --wechat-data-archive) WECHAT_ARCHIVE="${2:?restore: --wechat-data-archive 需要路径}"; shift ;;
    --wechat-data-volume) WECHAT_VOLUME="${2:?restore: --wechat-data-volume 需要卷名}"; shift ;;
    -h|--help) sed -n '2,13p' "$0"; exit 0 ;;
    *) echo "restore: 未知参数 $1" >&2; exit 2 ;;
  esac
  shift
done

die() { echo "restore: $*" >&2; exit 1; }
sha256() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$@"; else shasum -a 256 "$@"; fi; }
redact() {
  case "$1" in
    *://*@*) printf '%s' "${1%%://*}://***@${1##*@}" ;;
    *) printf '%s' "$1" ;;
  esac
}

PG_RESTORE_BIN="${PG_RESTORE_BIN:-pg_restore}"
PSQL_BIN="${PSQL_BIN:-psql}"
AGE_BIN="${AGE_BIN:-age}"
DOCKER_BIN="${DOCKER_BIN:-docker}"

[ -n "$BACKUP_FILE" ] || die "缺少 --backup"
[ -f "$BACKUP_FILE" ] || die "备份文件不存在: $BACKUP_FILE"
[ -n "$TARGET_URL" ] || die "缺少 --target-url（只允许指向新建空库）"
[ -n "$AGE_IDENTITY" ] || die "缺少 --age-identity（备份私钥，仅宿主机受限文件）"
[ -f "$AGE_IDENTITY" ] || die "age 私钥不存在: $AGE_IDENTITY"

# 卷参数要么都给，要么都不给：半个卷恢复比不恢复更危险
VOLUME_ARGS=("$MEETING_VOLUME" "$MEETING_ARCHIVE" "$ATTACHMENT_VOLUME" "$ATTACHMENT_ARCHIVE" "$RECORDING_VOLUME" "$RECORDING_ARCHIVE" "$WECHAT_VOLUME" "$WECHAT_ARCHIVE")
given=0
for arg in "${VOLUME_ARGS[@]}"; do [ -n "$arg" ] && given=$((given + 1)); done
if [ "$given" -ne 0 ] && [ "$given" -ne "${#VOLUME_ARGS[@]}" ]; then
  die "卷恢复参数不完整：需要同时提供 meeting-materials/conversation-attachments/meeting-recordings/wechat-data 四个卷各自的 --<卷>-archive 与 --<卷>-volume"
fi
VOLUME_MODE=0
[ -n "$MEETING_VOLUME" ] && VOLUME_MODE=1

# 显式破坏保护：绝不覆盖生产库
if [ -n "${DATABASE_URL:-}" ] && [ "$TARGET_URL" = "${DATABASE_URL}" ]; then
  die "目标与生产 DATABASE_URL 相同，拒绝恢复"
fi

verify_checksum() {
  local file="$1" checksum="${2:-}"
  if [ -z "$checksum" ]; then checksum="$file.sha256"; fi
  [ -f "$checksum" ] || die "缺少 checksum 文件: $checksum"
  local expected actual
  expected=$(awk 'NR==1{print $1}' "$checksum")
  actual=$(sha256 "$file" | awk '{print $1}')
  [ -n "$expected" ] || die "checksum 文件为空: $checksum"
  [ "$expected" = "$actual" ] || die "checksum 不匹配，拒绝恢复: $(basename "$file")"
}

verify_checksum "$BACKUP_FILE" "$CHECKSUM_FILE"

if [ "$VOLUME_MODE" = 1 ]; then
  for archive in "$MEETING_ARCHIVE" "$ATTACHMENT_ARCHIVE" "$RECORDING_ARCHIVE" "$WECHAT_ARCHIVE"; do
    verify_checksum "$archive"
  done
  for vol in "$MEETING_VOLUME" "$ATTACHMENT_VOLUME" "$RECORDING_VOLUME" "$WECHAT_VOLUME"; do
    "$DOCKER_BIN" volume inspect "$vol" >/dev/null 2>&1 || die "目标 volume 不存在: ${vol}（必须预先创建空卷，本脚本不创建）"
  done
  # 目标卷必须为空：非空卷意味着可能指向在用环境
  for vol in "$MEETING_VOLUME" "$ATTACHMENT_VOLUME" "$RECORDING_VOLUME" "$WECHAT_VOLUME"; do
    if ! "$DOCKER_BIN" run --rm -v "$vol":/data:ro "$VOLUME_IMAGE" sh -c '[ -z "$(ls -A /data)" ]'; then
      die "目标 volume 非空: ${vol}，拒绝恢复（只恢复到显式创建的空卷）"
    fi
  done
else
  echo "restore: 警告：数据库-only 恢复。meeting_materials / conversation_attachments / meeting_recordings / wechat_data 卷数据不在本次范围，"
  echo "restore: 警告：此模式对会前材料、会话附件、录音与公众号登录态不是完整恢复；完整恢复必须显式提供卷归档与空目标卷参数。"
fi

# 只允许空库：public schema 下不得已有基本表
existing=$("$PSQL_BIN" "$TARGET_URL" -Atc \
  "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'") \
  || die "无法连接目标库（不自动创建/覆盖）"
[ "$existing" = "0" ] || die "目标库已有 ${existing} 张表，拒绝覆盖（只恢复到空库）"

echo "restore: 备份=$(basename "$BACKUP_FILE") 目标=$(redact "$TARGET_URL") 卷模式=$VOLUME_MODE"
if [ "$EXECUTE" != 1 ]; then
  echo "restore: dry-run（默认）：checksum、生产库保护、卷非空与空库检查通过；加 --execute 才解密并恢复"
  exit 0
fi

tmpdir=$(mktemp -d "${TMPDIR:-/tmp}/warmap.XXXXXX")
trap 'rm -rf "$tmpdir"' EXIT
plain="$tmpdir/restore.dump"
"$AGE_BIN" -d -i "$AGE_IDENTITY" -o "$plain" "$BACKUP_FILE"
# 明文 dump 用 stdin 交给 pg_restore：不在磁盘上留下额外可读副本
"$PG_RESTORE_BIN" --dbname="$TARGET_URL" --no-owner --no-privileges --exit-on-error < "$plain"

if [ "$VOLUME_MODE" = 1 ]; then
  # 解密 API 卷归档并解压进空卷；--user 1000:1000 + tar 默认 --no-same-owner 保证非 root 属主兼容
  restore_api_volume() {
    "$AGE_BIN" -d -i "$AGE_IDENTITY" -o "$tmpdir/$1.tar.gz" "$2"
    "$DOCKER_BIN" run --rm --user "$VOLUME_UID:$VOLUME_GID" -v "$1":/target -v "$tmpdir":/src:ro "$VOLUME_IMAGE" \
      tar -xzf "/src/$1.tar.gz" -C /target --no-same-owner
  }
  restore_api_volume "$MEETING_VOLUME" "$MEETING_ARCHIVE"
  restore_api_volume "$ATTACHMENT_VOLUME" "$ATTACHMENT_ARCHIVE"
  restore_api_volume "$RECORDING_VOLUME" "$RECORDING_ARCHIVE"
  # 公众号 sidecar 以 root 运行：root 解压保留原属主
  "$AGE_BIN" -d -i "$AGE_IDENTITY" -o "$tmpdir/$WECHAT_VOLUME.tar.gz" "$WECHAT_ARCHIVE"
  "$DOCKER_BIN" run --rm -v "$WECHAT_VOLUME":/target -v "$tmpdir":/src:ro "$VOLUME_IMAGE" \
    tar -xzf "/src/$WECHAT_VOLUME.tar.gz" -C /target
fi

# 恢复后抽查：六实体（MeetingOutcome/Transcript 内嵌在 meetings）+ 消息 + Pi entries（计数为 0 也如实打印，不伪造成功明细）
"$PSQL_BIN" "$TARGET_URL" -Atc "
  SELECT 'issues=' || (SELECT count(*) FROM issues)
      || ' signals=' || (SELECT count(*) FROM signals)
      || ' meetings=' || (SELECT count(*) FROM meetings)
      || ' transcripts=' || (SELECT count(*) FROM meetings WHERE transcript IS NOT NULL)
      || ' outcomes=' || (SELECT count(*) FROM meetings WHERE outcome IS NOT NULL)
      || ' monthly_plans=' || (SELECT count(*) FROM monthly_plans)
      || ' conversations=' || (SELECT count(*) FROM conversations)
      || ' messages=' || (SELECT count(*) FROM conversation_messages)
      || ' pi_entries=' || (SELECT count(*) FROM conversations WHERE jsonb_array_length(runtime_entries) > 0)"

if [ "$VOLUME_MODE" = 1 ]; then
  # 存储校验（fail closed）：以恢复后的 DB 为准，逐行核对卷内文件 SHA-256
  storage_rows=$("$PSQL_BIN" "$TARGET_URL" -Atc "SELECT 'meeting_material|' || m.id || '|' || (value->>'storageKey') || '|' || (value->>'sha256') FROM meetings m, jsonb_array_elements(m.materials) value WHERE value->>'storageKey' <> '' UNION ALL SELECT 'conversation_attachment|' || cm.conversation_id || ':' || cm.sequence || '|' || (a->>'storageKey') || '|' || (a->>'sha256') FROM conversation_messages cm, jsonb_array_elements(cm.attachments) a WHERE a->>'storageKey' <> ''")
  verified=0
  while IFS='|' read -r kind _owner storage_key expected; do
    [ -n "$storage_key" ] || continue
    case "$kind" in
      meeting_material) vol="$MEETING_VOLUME" ;;
      conversation_attachment) vol="$ATTACHMENT_VOLUME" ;;
      *) die "存储校验失败：未知存储行类型 $kind" ;;
    esac
    actual=$("$DOCKER_BIN" run --rm --user "$VOLUME_UID:$VOLUME_GID" -v "$vol":/data:ro "$VOLUME_IMAGE" sha256sum "/data/$storage_key" | awk '{print $1}')
    if [ "$actual" != "$expected" ]; then
      die "存储校验失败: ${storage_key}（DB=$expected 卷=${actual}）。卷与数据库不一致，恢复判定为失败"
    fi
    verified=$((verified + 1))
  done <<< "$storage_rows"
  echo "restore: 存储校验通过（${verified} 行 storageKey/SHA 与卷内文件一致）"
fi

echo "restore: 完成。下一步用恢复库启动 API 并继续一次对象 Conversation（见 docs/guides/deployment.md）"
