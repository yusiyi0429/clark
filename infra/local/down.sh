#!/usr/bin/env bash
# 停本地准生产。默认保留数据卷；加 -v 会连本地数据库、附件、录音卷一起删掉（不可恢复）。
# 用法（仓库根，Git Bash）：bash infra/local/down.sh [-v]
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/../.." && pwd)
env_file="$here/.env.local"
[ -f "$env_file" ] || env_file="$here/.env.local.example"

docker compose -f "$repo/infra/docker-compose.yml" -f "$here/compose.local.yml" --env-file "$env_file" down "$@"
