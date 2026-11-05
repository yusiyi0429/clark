# 天枢本机程序 · Windows 卸载
# 停掉程序、取消开机自启、删掉程序。本机数据（会话记录、配对、模型配置；钥匙在 DPAPI 加密文件里）默认保留，
# 想一起删：设 TIANSHU_LOCAL_PURGE=1 再跑。Claude Code 不动。
$ErrorActionPreference = 'Stop'
$Dir = Join-Path $env:LOCALAPPDATA 'Programs\Tianshu'
$Exe = Join-Path $Dir 'tianshu-local.exe'
$Data = Join-Path $env:LOCALAPPDATA 'Tianshu\local'

Write-Host '天枢本机程序 · 卸载' -ForegroundColor Cyan
Get-Process -Name 'tianshu-local' -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $Exe } | ForEach-Object {
  # 连同它拉起的托盘助手和 Claude Code 进程一起停（只停这个 PID 的进程树）
  & taskkill.exe /PID $_.Id /T /F | Out-Null
}
Start-Sleep -Milliseconds 800
& reg.exe delete 'HKCU\Software\Microsoft\Windows\CurrentVersion\Run' /v TianshuLocal /f 2>$null | Out-Null
if (Test-Path $Dir) { Remove-Item -LiteralPath $Dir -Recurse -Force }
if ($env:TIANSHU_LOCAL_PURGE -eq '1' -and (Test-Path $Data)) {
  Remove-Item -LiteralPath $Data -Recurse -Force
  $parent = Split-Path -Parent $Data
  if ((Test-Path $parent) -and -not (Get-ChildItem -LiteralPath $parent -Force)) { Remove-Item -LiteralPath $parent -Force }
  Write-Host '  本机数据也删了'
} elseif (Test-Path $Data) {
  Write-Host "  本机数据保留在 $Data（要删就设 TIANSHU_LOCAL_PURGE=1 再跑一次）"
}
Write-Host '已卸载。' -ForegroundColor Green
