<#
  安装本机采集器（Windows）：脚本放到 %USERPROFILE%\.tkos-world\collector，
  注册计划任务 TkosCollector：每 30 分钟检查一次、登录时也跑一次，错过的开机后补跑（StartWhenAvailable）。
  -DryRun：只打印将要做的事，不复制文件、不写配置、不注册任务。
#>
param(
  [Parameter(Mandatory = $true)][string]$Server,
  [string]$Python = "",
  [string]$EodTime = "20:30",
  [switch]$DryRun
)
$ErrorActionPreference = "Stop"
$TaskName = "TkosCollector"
$Root = Join-Path $env:USERPROFILE ".tkos-world"
$Target = Join-Path $Root "collector"
$TokenFile = Join-Path $Root "collector.token"
$ConfigFile = Join-Path $Root "collector.json"

if (-not $Python) {
  $venv = Join-Path $Root "venv\Scripts\pythonw.exe"
  if (Test-Path $venv) { $Python = $venv }
  else {
    $found = Get-Command pythonw.exe -ErrorAction SilentlyContinue
    if (-not $found) { throw "没找到 Python 3：先装 Python，或用 -Python 指定 pythonw.exe 的路径" }
    $Python = $found.Source
  }
}
if ($EodTime -notmatch '^([01][0-9]|2[0-3]):[0-5][0-9]$') { throw "-EodTime 要写成 HH:MM，例如 20:30" }

$script = Join-Path $Target "tkos_collector.py"
$action = New-ScheduledTaskAction -Execute $Python -Argument "`"$script`" check" -WorkingDirectory $Target
$every30 = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 30)
$atLogon = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 10)
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited

if ($DryRun) {
  Write-Output "[dry-run] 复制 tkos_collector.py、collect_sessions.py、sanitize.py 到 $Target"
  Write-Output "[dry-run] 写配置 $ConfigFile ：server=$Server eod_time=$EodTime"
  if (-not (Test-Path $TokenFile)) { Write-Output "[dry-run] 提示粘贴采集器令牌，存到 $TokenFile" }
  Write-Output "[dry-run] 注册计划任务 $TaskName ：$Python `"$script`" check"
  Write-Output "[dry-run]   触发器：每 30 分钟（$($every30.Repetition.Interval)）、登录时；StartWhenAvailable=$($settings.StartWhenAvailable)；MultipleInstances=$($settings.MultipleInstances)"
  return
}

New-Item -ItemType Directory -Force -Path $Target | Out-Null
Copy-Item -Force (Join-Path $PSScriptRoot "tkos_collector.py"), (Join-Path $PSScriptRoot "collect_sessions.py"), (Join-Path $PSScriptRoot "sanitize.py") $Target
[System.IO.File]::WriteAllText($ConfigFile, (@{ server = $Server; eod_time = $EodTime } | ConvertTo-Json), (New-Object System.Text.UTF8Encoding $false))
if (-not (Test-Path $TokenFile)) {
  $secure = Read-Host "粘贴天枢里生成的「本机采集器」令牌" -AsSecureString
  $plain = [System.Net.NetworkCredential]::new("", $secure).Password
  if (-not $plain) { throw "没有令牌，安装中止" }
  [System.IO.File]::WriteAllText($TokenFile, $plain, (New-Object System.Text.UTF8Encoding $false))
}
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $every30, $atLogon -Settings $settings -Principal $principal `
  -Description "天枢本机采集器：每 30 分钟检查本机会话并上报" -Force | Out-Null
Write-Output "已注册计划任务 $TaskName。现在先跑一次检查："
& ($Python -replace 'pythonw\.exe$', 'python.exe') $script check
