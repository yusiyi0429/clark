<#
  卸载本机采集器（Windows）：删计划任务 TkosCollector 和 %USERPROFILE%\.tkos-world\collector。
  -Purge：连令牌、配置、水位线一起删。-DryRun：只打印将要做的事。
#>
param([switch]$Purge, [switch]$DryRun)
$ErrorActionPreference = "Stop"
$TaskName = "TkosCollector"
$Root = Join-Path $env:USERPROFILE ".tkos-world"
$paths = @(Join-Path $Root "collector")
if ($Purge) { $paths += @("collector.token", "collector.json", "daily-state.json") | ForEach-Object { Join-Path $Root $_ } }

$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($DryRun) {
  Write-Output "[dry-run] 删除计划任务 $TaskName（$(if ($task) { '已注册' } else { '未注册' })）"
  $paths | ForEach-Object { Write-Output "[dry-run] 删除 $_" }
  return
}
if ($task) { Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false }
$paths | Where-Object { Test-Path $_ } | ForEach-Object { Remove-Item -Recurse -Force $_ }
Write-Output "已卸载本机采集器。"
