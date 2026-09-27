# 启动「时间机器」测试环境：API 4500（一次性测试库）+ 网页 3500（apps/web 的临时副本，电脑和手机都能开）。
# 用 PowerShell 7 运行：pwsh -NoProfile -File .scratch/manual-test/start.ps1
# 不会停止任何已有服务；端口被占用时直接报错。
$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '../..')).Path
$run = Join-Path $PSScriptRoot 'run'
$web = Join-Path $repo 'apps/web'
$preview = Join-Path $repo 'apps/web-manual-preview'
foreach ($port in 3500, 4500) {
  if (Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue) { throw "端口 $port 已被占用：先运行 stop.ps1，或关掉占用它的程序" }
}
if (Test-Path -LiteralPath $preview) { throw '上次的网页副本还在：先运行 stop.ps1' }
New-Item -ItemType Directory -Force -Path $run | Out-Null
Remove-Item -LiteralPath (Join-Path $run 'fixture.json') -ErrorAction SilentlyContinue

# 1. API：一次性测试库 + 合成身份，应用时钟从上海 2026-10-01 10:00 起走。
$tsx = Join-Path $repo 'apps/api/node_modules/tsx/dist/cli.mjs'
$api = Start-Process -FilePath (Get-Command node).Source -ArgumentList @($tsx, (Join-Path $PSScriptRoot 'server.ts')) -WorkingDirectory $repo -WindowStyle Hidden -PassThru `
  -RedirectStandardOutput (Join-Path $run 'api.log') -RedirectStandardError (Join-Path $run 'api-error.log')
@{ pid = $api.Id } | ConvertTo-Json -Compress | Set-Content -LiteralPath (Join-Path $run 'api-process.json')

# 2. 等 API 就绪，再起网页；API 失败时不留下网页副本。
$deadline = (Get-Date).AddSeconds(90)
while ((Get-Date) -lt $deadline) {
  $meta = Get-Content -LiteralPath (Join-Path $run 'fixture.json') -Raw -ErrorAction SilentlyContinue | ConvertFrom-Json -ErrorAction SilentlyContinue
  if ($meta.ready) { break }
  if ($api.HasExited) { throw "API 没有起来，看 $run\api.log" }
  Start-Sleep -Milliseconds 500
}
if (-not $meta.ready) { throw "API 90 秒内没有就绪，看 $run\api.log" }
# 3. 网页：复制 src/public（node_modules 用链接），监听所有网卡，/api 转给 4500。
New-Item -ItemType Directory -Path $preview | Out-Null
foreach ($name in @('src', 'public', 'package.json', 'tsconfig.json', 'next-env.d.ts', 'next.config.ts', 'postcss.config.mjs')) {
  $source = Join-Path $web $name
  if (Test-Path -LiteralPath $source) { Copy-Item -LiteralPath $source -Destination (Join-Path $preview $name) -Recurse }
}
New-Item -ItemType Junction -Path (Join-Path $preview 'node_modules') -Target (Join-Path $web 'node_modules') | Out-Null
$env:API_SERVER_URL = 'http://127.0.0.1:4500'
$env:NEXT_TELEMETRY_DISABLED = '1'
$next = Join-Path $web 'node_modules/next/dist/bin/next'
$site = Start-Process -FilePath (Get-Command node).Source -ArgumentList @($next, 'dev', '-p', '3500') -WorkingDirectory $preview -WindowStyle Hidden -PassThru `
  -RedirectStandardOutput (Join-Path $run 'web.log') -RedirectStandardError (Join-Path $run 'web-error.log')
@{ pid = $site.Id; preview = $preview } | ConvertTo-Json -Compress | Set-Content -LiteralPath (Join-Path $run 'web-process.json')

# 手机用 Wi-Fi 网卡的地址；找不到时列出所有放行的地址。
$wifi = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object { $_.InterfaceAlias -match '^(WLAN|Wi-?Fi)' } | Select-Object -First 1 -ExpandProperty IPAddress
$phone = if ($wifi) { "https://$($wifi):8444（要先启动 .scratch/lan-https/start.ps1）" } else { @($meta.lanOrigins) -join '  ' }
Write-Host ''
Write-Host '时间机器环境已启动（应用时间：上海 2026-10-01 10:00，随真实时间往前走）'
Write-Host '  电脑：http://localhost:3500'
Write-Host "  手机（同一个 Wi-Fi）：$phone"
Write-Host '  第一次打开要编译，等 10–30 秒。账号见 .scratch/manual-test/README.md'
