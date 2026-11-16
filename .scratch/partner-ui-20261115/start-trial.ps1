$ErrorActionPreference = 'Stop'
$trialRepo = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '../..')).Path
$qaRoot = Join-Path $trialRepo '.scratch/partner-work-continuity/qa'
$runtimeRoot = Join-Path $PSScriptRoot 'trial-runtime'
New-Item -ItemType Directory -Force -Path $runtimeRoot | Out-Null

function Get-TrialRun {
  Get-ChildItem -LiteralPath $qaRoot -Directory | Where-Object { $_.Name -like 'preview-*' } |
    Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1
}
function Read-TrialStatus($run) {
  if (-not $run) { return $null }
  $statusPath = Join-Path $run.FullName 'status.json'
  if (Test-Path -LiteralPath $statusPath) {
    try { return (Get-Content -Raw -Encoding UTF8 -LiteralPath $statusPath | ConvertFrom-Json) } catch { return $null }
  }
  return $null
}
function Test-Trial($status) {
  if (-not $status -or -not $status.webOrigin -or -not $status.accounts -or $status.stoppedAt) { return $false }
  try {
    $login = Invoke-WebRequest -Uri ($status.webOrigin + '/access?next=%2Fme%2Fwork') -UseBasicParsing -TimeoutSec 25
    if ([int]$login.StatusCode -ne 200) { return $false }
    $account = $status.accounts[0]
    $body = @{ loginId = $account.loginId; passcode = $account.passcode } | ConvertTo-Json
    $session = New-Object Microsoft.PowerShell.Commands.WebRequestSession
    $signed = Invoke-WebRequest -Uri ($status.webOrigin + '/api/auth/login') -Method Post -ContentType 'application/json' -Body $body -Headers @{ Origin = $status.webOrigin } -WebSession $session -UseBasicParsing -TimeoutSec 25
    if ([int]$signed.StatusCode -ne 200) { return $false }
    foreach ($path in @('/me/work','/me/work/buddy','/api/me/work-home','/api/me/partner-meetings','/api/me/meeting-work-handoffs','/api/me/partner-work-events')) {
      $reply = Invoke-WebRequest -Uri ($status.webOrigin + $path) -WebSession $session -UseBasicParsing -TimeoutSec 35
      if ([int]$reply.StatusCode -ne 200) { return $false }
      if ($path.StartsWith('/api/')) { $null = $reply.Content | ConvertFrom-Json }
      elseif ($reply.Content -notmatch 'work-home') { return $false }
    }
    return $true
  } catch {
    Write-Host ('访问校验尚未通过：' + $_.Exception.Message)
    return $false
  }
}
function Show-Trial($status) {
  $url = $status.webOrigin + '/access?next=%2Fme%2Fwork'
  Write-Host "天枢试玩已通过登录、伙伴页面及新版数据接口校验：$url"
  Write-Host '账号 qaone / 2847；另一个账号 qatwo / 5827（可用无痕窗口同时登录）。'
  Write-Host '本环境使用演示数据，重启清空；真实模型对话、飞书入会和录音尚未接入。'
  $url | Set-Content -Encoding UTF8 -LiteralPath (Join-Path $runtimeRoot 'url.txt')
  Start-Process -FilePath $url
}

$existingRun = Get-TrialRun
$existing = Read-TrialStatus $existingRun
if (Test-Trial $existing) { Show-Trial $existing; exit 0 }
if ($existingRun -and $existing -and -not $existing.stoppedAt) {
  Write-Host '已有演示服务未通过访问校验，正在通过它自己的停止入口重启（演示数据会清空）。'
  'restart requested by desktop trial launcher' | Set-Content -Encoding UTF8 -LiteralPath (Join-Path $existingRun.FullName 'stop')
  $stopDeadline = (Get-Date).AddSeconds(15)
  do {
    Start-Sleep -Milliseconds 500
    $stopping = Read-TrialStatus $existingRun
  } until (($stopping -and $stopping.stoppedAt) -or (Get-Date) -gt $stopDeadline)
  if (-not $stopping -or -not $stopping.stoppedAt) { throw '已有演示服务没有确认退出，未启动第二个实例。请保留 trial-runtime 日志供检查。' }
}
# 锁文件的存在不证明服务还在运行；由 Next 自己检查运行锁，不删除文件、不终止其他服务。

$node = (Get-Command node -ErrorAction Stop).Source
$tsx = Join-Path $trialRepo 'apps/api/node_modules/tsx/dist/cli.mjs'
$preview = Join-Path $qaRoot 'preview.mts'
$launchId = [guid]::NewGuid().ToString('N')
$output = Join-Path $runtimeRoot ($launchId + '.out.log')
$errors = Join-Path $runtimeRoot ($launchId + '.err.log')
$previousName = if ($existingRun) { $existingRun.Name } else { '' }
$process = Start-Process -FilePath $node -ArgumentList @(('"' + $tsx + '"'),('"' + $preview + '"')) -WorkingDirectory $trialRepo -WindowStyle Hidden -RedirectStandardOutput $output -RedirectStandardError $errors -PassThru
Write-Host '正在后台启动天枢。首次编译可能需要几分钟，服务启动后不依赖此终端。'
$deadline = (Get-Date).AddMinutes(4)
while ((Get-Date) -lt $deadline) {
  $currentRun = Get-TrialRun
  if ($currentRun -and $currentRun.Name -ne $previousName) {
    $status = Read-TrialStatus $currentRun
    if ($status -and $status.state -in @('ready','awaiting_browser')) {
      if (Test-Trial $status) { Show-Trial $status; exit 0 }
      throw "服务未通过页面/接口校验。查看 $($currentRun.FullName)/next.log 和 $errors"
    }
    if ($status -and $status.state -eq 'failed') { throw "启动失败。查看 $($currentRun.FullName)/status.json 和 $errors" }
  }
  $process.Refresh()
  if ($process.HasExited) { throw "启动程序已退出。查看 $output 和 $errors" }
  Start-Sleep -Milliseconds 750
}
throw "启动超时，未报告就绪。查看 $output 和 $errors"
