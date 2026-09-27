# 关掉「时间机器」测试环境：删掉一次性测试库、停掉 3500 的网页、删除网页副本。
# 用 PowerShell 7 运行：pwsh -NoProfile -File .scratch/manual-test/stop.ps1
$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '../..')).Path
$run = Join-Path $PSScriptRoot 'run'
$preview = [System.IO.Path]::GetFullPath((Join-Path $repo 'apps/web-manual-preview'))
if ((Split-Path -Leaf $preview) -ne 'web-manual-preview') { throw '清理目标不对，已停止' }

# 1. 让 API 自己删库并退出。
$metaPath = Join-Path $run 'fixture.json'
if (Test-Path -LiteralPath $metaPath) {
  $meta = Get-Content -LiteralPath $metaPath -Raw | ConvertFrom-Json
  if ($meta.ready) {
    & node (Join-Path $PSScriptRoot 'control.cjs') close | Out-Null
    if ($LASTEXITCODE -ne 0) { Write-Warning 'API 没有确认关闭；测试库可能还在（名字在 run/fixture.json）' }
  }
}

# 2. 停掉网页副本的进程树，只停这一棵。
$webMeta = Join-Path $run 'web-process.json'
if (Test-Path -LiteralPath $webMeta) {
  $webProcess = Get-Content -LiteralPath $webMeta -Raw | ConvertFrom-Json
  $all = @(Get-CimInstance Win32_Process)
  $owned = @([int]$webProcess.pid)
  do {
    $children = @($all | Where-Object { $_.ParentProcessId -in $owned -and $_.ProcessId -notin $owned } | Select-Object -ExpandProperty ProcessId)
    $owned += $children
  } while ($children.Count -gt 0)
  foreach ($id in ($owned | Sort-Object -Descending)) { Stop-Process -Id $id -Force -ErrorAction SilentlyContinue }
  Remove-Item -LiteralPath $webMeta
}

# 3. 删除网页副本：先解除 node_modules 链接，绝不删 apps/web 自己的依赖。
if (Test-Path -LiteralPath $preview) {
  Start-Sleep -Milliseconds 800
  $junction = Join-Path $preview 'node_modules'
  if (Test-Path -LiteralPath $junction) {
    if ((Get-Item -LiteralPath $junction).LinkType -ne 'Junction') { throw 'node_modules 不是链接，已停止，请手动检查' }
    [System.IO.Directory]::Delete($junction)
  }
  Remove-Item -LiteralPath $preview -Recurse -Force
}
$left = @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.LocalPort -in 3500, 4500 })
Write-Host ('已关闭。' + $(if ($left.Count) { ' 注意：3500/4500 还有进程在监听。' } else { ' 3500/4500 已释放。' }))
