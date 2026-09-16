#!/usr/bin/env bash
# 独立恢复流程（.tech/08 §11）：只恢复到空 PostgreSQL，不覆盖现有库。
# 默认 dry-run；必须显式 --execute 才写库。任何一步不满足即中止，不做自动回滚。
# 用法：restore.sh --backup <file.dump.age> [--checksum <file.sha256>] --target-url <postgres://...>
#                 [--age-identity <key.txt>] [--execute]
set -euo pipefail

EXECUTE=0
BACKUP_FILE=""
TARGET_URL=""
CHECKSUM_FILE=""
AGE_IDENTITY="${BACKUP_AGE_IDENTITY:-}"

while [ $# -gt 0 ]; do
  case "$1" in
    --execute) EXECUTE=1 ;;
    --dry-run) EXECUTE=0 ;;
    --backup) BACKUP_FILE="${2:?restore: --backup 需要路径}"; shift ;;
    --checksum) CHECKSUM_FILE="${2:?restore: --checksum 需要路径}"; shift ;;
    --target-url) TARGET_URL="${2:?restore: --target-url 需要连接串}"; shift ;;
    --age-identity) AGE_IDENTITY="${2:?restore: --age-identity 需要路径}"; shift ;;
    -h|--help) sed -n '2,5p' "$0"; exit 0 ;;
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

[ -n "$BACKUP_FILE" ] || die "缺少 --backup"
[ -f "$BACKUP_FILE" ] || die "备份文件不存在: $BACKUP_FILE"
[ -n "$TARGET_URL" ] || die "缺少 --target-url（只允许指向新建空库）"
[ -n "$AGE_IDENTITY" ] || die "缺少 --age-identity（备份私钥，仅宿主机受限文件）"
[ -f "$AGE_IDENTITY" ] || die "age 私钥不存在: $AGE_IDENTITY"

# 显式破坏保护：绝不覆盖生产库
if [ -n "${DATABASE_URL:-}" ] && [ "$TARGET_URL" = "${DATABASE_URL}" ]; then
  die "目标与生产 DATABASE_URL 相同，拒绝恢复"
fi

# checksum 先于解密验证
if [ -z "$CHECKSUM_FILE" ]; then
  CHECKSUM_FILE="${BACKUP_FILE}.sha256"
fi
[ -f "$CHECKSUM_FILE" ] || die "缺少 checksum 文件: $CHECKSUM_FILE"
expected=$(awk 'NR==1{print $1}' "$CHECKSUM_FILE")
actual=$(sha256 "$BACKUP_FILE" | awk '{print $1}')
[ -n "$expected" ] || die "checksum 文件为空: $CHECKSUM_FILE"
[ "$expected" = "$actual" ] || die "checksum 不匹配，拒绝恢复"

# 只允许空库：public schema 下不得已有基本表
existing=$("$PSQL_BIN" "$TARGET_URL" -Atc \
  "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'") \
  || die "无法连接目标库（不自动创建/覆盖）"
[ "$existing" = "0" ] || die "目标库已有 ${existing} 张表，拒绝覆盖（只恢复到空库）"

echo "restore: 备份=$(basename "$BACKUP_FILE") 目标=$(redact "$TARGET_URL")"
if [ "$EXECUTE" != 1 ]; then
  echo "restore: dry-run（默认）：checksum、生产库保护与空库检查通过；加 --execute 才解密并恢复"
  exit 0
fi

tmpdir=$(mktemp -d "${TMPDIR:-/tmp}/warmap.XXXXXX")
trap 'rm -rf "$tmpdir"' EXIT
plain="$tmpdir/restore.dump"
"$AGE_BIN" -d -i "$AGE_IDENTITY" -o "$plain" "$BACKUP_FILE"
# 明文 dump 用 stdin 交给 pg_restore：不在磁盘上留下额外可读副本
"$PG_RESTORE_BIN" --dbname="$TARGET_URL" --no-owner --no-privileges --exit-on-error < "$plain"

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

echo "restore: 完成。下一步用恢复库启动 API 并继续一次对象 Conversation（见 infra/staging/runbook.md）"
