#!/usr/bin/env bash
# 起本地准生产：按线上方式构建 web/api，起 postgres + edge(Caddy) + tls(Nginx)，等 https 健康检查通过。
# 用法（仓库根，Git Bash）：bash infra/local/up.sh [compose up 参数，默认 --build；只重启用 --no-build]
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/../.." && pwd)
env_file="$here/.env.local"
[ -f "$env_file" ] || { echo "缺少 infra/local/.env.local：先 cp infra/local/.env.local.example infra/local/.env.local 再填写" >&2; exit 1; }

env_value() { sed -n "s/^$1=//p" "$env_file" | tail -1 | tr -d '\r'; }
domain=$(env_value PUBLIC_DOMAIN)
[ -n "$domain" ] || { echo ".env.local 缺少 PUBLIC_DOMAIN" >&2; exit 1; }
host=${domain%%:*}
port=$(env_value LOCAL_HTTPS_PORT); port=${port:-443}

certs="$here/certs"
if [ ! -f "$certs/local.pem" ] || [ ! -f "$certs/local-key.pem" ]; then
  command -v mkcert >/dev/null || { echo "缺少证书且未安装 mkcert，见 infra/local/README.md 第 1 步" >&2; exit 1; }
  mkdir -p "$certs"
  mkcert -cert-file "$certs/local.pem" -key-file "$certs/local-key.pem" "$host"
fi

hosts_file=/etc/hosts
[ -f /c/Windows/System32/drivers/etc/hosts ] && hosts_file=/c/Windows/System32/drivers/etc/hosts
grep -Eq "^[[:space:]]*127\.0\.0\.1[[:space:]].*\b$host\b" "$hosts_file" \
  || echo "提醒：$hosts_file 里还没有 127.0.0.1 $host，浏览器打不开（见 README 第 1 步）" >&2

export BUILD_SHA=${BUILD_SHA:-$(git -C "$repo" rev-parse --short HEAD)}
compose=(docker compose -f "$repo/infra/docker-compose.yml" -f "$here/compose.local.yml" --env-file "$env_file")
"${compose[@]}" config --quiet
[ $# -gt 0 ] || set -- --build
"${compose[@]}" up -d "$@"

url="https://$domain/api/healthz"
for _ in $(seq 1 90); do
  if body=$(curl -fsS --max-time 5 --resolve "$host:$port:127.0.0.1" "$url" 2>/dev/null); then
    echo "就绪：https://$domain  buildSha=$BUILD_SHA"
    echo "$body"
    exit 0
  fi
  sleep 2
done
echo "等了 3 分钟 $url 仍不通。证书错误先确认做过 mkcert -install；其余看日志：docker compose -p warmap-local logs api tls edge" >&2
exit 1
