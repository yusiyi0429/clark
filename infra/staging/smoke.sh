#!/usr/bin/env bash
# staging 上线 smoke（.tech/08 §11）：只打真实入口，不发起模型/Search 调用，不写 staging 业务对象。
# 用法：smoke.sh [--dry-run]
# 需要：PUBLIC_ORIGIN（如 https://staging.example.com）、CEO_LOGIN_ID 与 CEO_PASSCODE（真实 CEO 的登录 ID 与 4 位口令，只从环境读取，不落盘）。
set -euo pipefail

DRY_RUN=0
case "${1:-}" in
  --dry-run) DRY_RUN=1 ;;
  "" ) ;;
  -h|--help) sed -n '2,5p' "$0"; exit 0 ;;
  *) echo "smoke: 未知参数 $1" >&2; exit 2 ;;
esac

: "${PUBLIC_ORIGIN:?smoke: 需要 PUBLIC_ORIGIN}"
ORIGIN="${PUBLIC_ORIGIN%/}"

if [ "$DRY_RUN" = 1 ]; then
  cat <<EOF
smoke: dry-run（未发请求）。步骤：
  1. GET  ${ORIGIN}/healthz                 Web 进程存活 + BUILD_SHA
  2. GET  ${ORIGIN}/api/healthz             API health（database/Pi/modelSlots/MCP/search/wechat + BUILD_SHA）
  3. POST ${ORIGIN}/mcp/company-memory      已停用的 CompanyMemory MCP 必须 404
  4. POST ${ORIGIN}/api/auth/login          真实 CEO 登录（需要 CEO_LOGIN_ID + CEO_PASSCODE）
  5. GET  ${ORIGIN}/api/cards/home          首页 Card
  6. GET  ${ORIGIN}/api/cards/radar         Radar Card（provider 配置如实显示）
  7. 登录后 GET 对象的 /api/cards/*         写操作只针对专门 staging 对象
真实 Provider 验收（博查 query + Pi Tool loop、公众号账号拉取、三模型槽位、合法 Transcript、备份恢复）
不在此脚本内自动执行，按 docs/guides/deployment.md 逐项确认授权与成本。
EOF
  exit 0
fi

: "${CEO_LOGIN_ID:?smoke: 缺少 CEO_LOGIN_ID（真实 smoke 需要登录；缺失即 BLOCKED，不跳过）}"
: "${CEO_PASSCODE:?smoke: 缺少 CEO_PASSCODE}"
command -v curl >/dev/null || { echo "smoke: 需要 curl" >&2; exit 1; }

failures=0
check() {
  local name="$1" expected="$2" body="$3"
  if grep -q "$expected" <<<"$body"; then
    echo "PASS  $name"
  else
    echo "FAIL  $name（期望包含: $expected）"
    failures=$((failures + 1))
  fi
}

web=$(curl -fsS "$ORIGIN/healthz")
check "web health" '"status":"ok"' "$web"

api=$(curl -fsS "$ORIGIN/api/healthz")
check "api health" '"api":true' "$api"
check "api database" '"database":true' "$api"
echo "      dependencies: $(grep -o '"dependencies":{[^}]*}' <<<"$api")"

mcp_code=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$ORIGIN/mcp/company-memory" -H 'content-type: application/json' -d '{}')
[ "$mcp_code" = "404" ] && echo "PASS  CompanyMemory 旧端点已停用 404" || { echo "FAIL  CompanyMemory 旧端点应为 404，实际 $mcp_code"; failures=$((failures + 1)); }

cookie=$(mktemp)
trap 'rm -f "$cookie"' EXIT
login_code=$(curl -s -o /dev/null -w "%{http_code}" -c "$cookie" -X POST "$ORIGIN/api/auth/login" \
  -H 'content-type: application/json' -H "origin: $ORIGIN" \
  --data "$(printf '{"loginId":"%s","passcode":"%s"}' "$CEO_LOGIN_ID" "$CEO_PASSCODE")")
[ "$login_code" = "200" ] && echo "PASS  CEO 登录" || { echo "FAIL  CEO 登录 HTTP $login_code"; failures=$((failures + 1)); }

home=$(curl -fsS -b "$cookie" "$ORIGIN/api/cards/home")
check "首页 Card" '"cards"' "$home"

radar=$(curl -fsS -b "$cookie" "$ORIGIN/api/cards/radar")
check "Radar Card" '"kind":"radar"' "$radar"

if [ "$failures" -gt 0 ]; then
  echo "smoke: $failures 项失败"
  exit 1
fi
echo "smoke: 全部通过（真实 Provider 与备份恢复见 docs/guides/deployment.md）"
