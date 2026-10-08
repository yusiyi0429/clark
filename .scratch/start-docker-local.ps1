$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path $PSScriptRoot -Parent
Push-Location $repoRoot
try {
  docker start tianshu-pg tianshu-wechat
  if ($LASTEXITCODE -ne 0) { throw '启动本地依赖失败' }
  docker compose --env-file .scratch/.env.docker-local -f infra/docker-compose.yml -f .scratch/docker-compose.local.yml up -d --no-deps --no-build api web edge
  if ($LASTEXITCODE -ne 0) { throw '启动本地应用失败' }
} finally {
  Pop-Location
}