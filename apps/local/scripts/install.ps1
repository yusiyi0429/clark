# 天枢本机程序 · Windows 一行安装：irm <下载源>/install.ps1 | iex
# 装到本人目录（不要管理员），注册开机自启，启动；检查 Claude Code，没装就装，没登录就带着登录。
# 可调的环境变量：
#   TIANSHU_LOCAL_DOWNLOAD_BASE  下载源（默认见下；以后放天枢服务器或 GitHub Release）
#   TIANSHU_LOCAL_FILE           直接用本地这个 exe，不下载（开发和测试用）
#   TIANSHU_LOCAL_SKIP_CLAUDE=1  不检查、不安装、不登录 Claude Code
#   TIANSHU_LOCAL_NO_OPEN=1      装完不打开天枢网页
# 不带 BOM：irm | iex 时 BOM 会让第一行注释失效；中文靠下载源回 Content-Type: text/plain; charset=utf-8。
# 整个脚本包在 & { } 里：iex 在本人的终端作用域里执行，不能把 $ErrorActionPreference 之类留在那个窗口里。
& {
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$Base = if ($env:TIANSHU_LOCAL_DOWNLOAD_BASE) { $env:TIANSHU_LOCAL_DOWNLOAD_BASE.TrimEnd('/') } else { 'https://tk.tokenkingos.com/downloads/local' }
$TianshuUrl = 'https://tk.tokenkingos.com'
$Dir = Join-Path $env:LOCALAPPDATA 'Programs\Tianshu'
$Exe = Join-Path $Dir 'tianshu-local.exe'

function Say($s) { Write-Host "  $s" }
Write-Host ''
Write-Host '天枢本机程序 · 安装' -ForegroundColor Cyan

if (-not [Environment]::Is64BitOperatingSystem) { throw '只支持 64 位 Windows' }
# Windows 11「智能应用控制」开着强制时，会拦下没签名的程序（本机程序和它首次启动时编出的托盘助手），没有单个放行的办法（ADR 0032）
$sac = $null
try { $sac = (Get-ItemProperty -Path 'HKLM:\SYSTEM\CurrentControlSet\Control\CI\Policy' -Name VerifiedAndReputablePolicyState -ErrorAction Stop).VerifiedAndReputablePolicyState } catch {}
if ($sac -eq 1) { throw '这台电脑开着「智能应用控制」，会拦下还没签名的天枢本机程序。请等签名版，或在「Windows 安全中心 › 应用和浏览器控制 › 智能应用控制设置」里关掉后再装' }
New-Item -ItemType Directory -Force -Path $Dir | Out-Null

# 1. 停掉正在跑的旧版本（只停装在这个位置的那个）
Get-Process -Name 'tianshu-local' -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $Exe } | ForEach-Object {
  Say '停掉正在运行的旧版本…'
  # 连同它拉起的托盘助手和 Claude Code 进程一起停（只停这个 PID 的进程树）
  & taskkill.exe /PID $_.Id /T /F | Out-Null
  Start-Sleep -Milliseconds 800
}

# 2. 取程序：下载并核对 SHA256，或用本地文件
$Tmp = Join-Path $env:TEMP ("tianshu-local-" + [guid]::NewGuid().ToString('N') + '.exe')
if ($env:TIANSHU_LOCAL_FILE) {
  Say "用本地文件 $($env:TIANSHU_LOCAL_FILE)"
  Copy-Item -LiteralPath $env:TIANSHU_LOCAL_FILE -Destination $Tmp
} else {
  Say "下载 $Base/tianshu-local-windows-x64.exe …"
  Invoke-WebRequest -UseBasicParsing -Uri "$Base/tianshu-local-windows-x64.exe" -OutFile $Tmp
  $sums = (Invoke-WebRequest -UseBasicParsing -Uri "$Base/SHA256SUMS").Content
  $want = ($sums -split "`n" | Where-Object { $_ -match 'tianshu-local-windows-x64\.exe' } | Select-Object -First 1) -replace '\s.*$', ''
  $got = (Get-FileHash -Algorithm SHA256 -LiteralPath $Tmp).Hash.ToLower()
  if (-not $want -or $got -ne $want.ToLower()) { Remove-Item -LiteralPath $Tmp -Force; throw '下载的文件校验不通过，没有安装' }
}
Move-Item -LiteralPath $Tmp -Destination $Exe -Force

# 3. 卸载脚本放一份在本机，断网也能卸
$Uninstall = Join-Path $Dir 'uninstall.ps1'
if ($env:TIANSHU_LOCAL_FILE) {
  $src = Join-Path (Split-Path -Parent $env:TIANSHU_LOCAL_FILE) '..\scripts\uninstall.ps1'
  if (Test-Path $src) { Copy-Item -LiteralPath $src -Destination $Uninstall -Force }
} else {
  try { Invoke-WebRequest -UseBasicParsing -Uri "$Base/uninstall.ps1" -OutFile $Uninstall } catch { Say '（卸载脚本没下载到，可以之后在线卸载）' }
}

# 4. 开机自启 + 现在就启动
& $Exe autostart on | Out-Null
Start-Process -FilePath $Exe -ArgumentList 'run' -WindowStyle Hidden
$ok = $false
for ($i = 0; $i -lt 40 -and -not $ok; $i++) {
  Start-Sleep -Milliseconds 500
  try {
    $h = Invoke-RestMethod -Uri 'http://127.0.0.1:47610/v1/health' -Headers @{ Origin = $TianshuUrl } -TimeoutSec 2
    $ok = $h.app -eq 'tianshu-local'
  } catch {}
}
if ($ok) { Say "已启动，托盘里有天枢图标；版本 $($h.version)" } else { Say '程序已装好，但还没连上 127.0.0.1:47610，稍后看看托盘' }

# 5. Claude Code：没装就装（官方脚本，不要管理员），没登录就登录（浏览器里点授权）
if ($env:TIANSHU_LOCAL_SKIP_CLAUDE -ne '1') {
  $claude = Join-Path $env:USERPROFILE '.local\bin\claude.exe'
  if (-not (Test-Path $claude)) {
    Say '没找到 Claude Code，正在用官方脚本安装（几分钟）…'
    Invoke-RestMethod https://claude.ai/install.ps1 | Invoke-Expression
  }
  if (Test-Path $claude) {
    $st = $null
    try { $st = & $claude auth status --json 2>$null | ConvertFrom-Json } catch {}
    if ($st -and $st.loggedIn) {
      Say "Claude Code 已登录（$($st.authMethod)）"
    } else {
      Say '接下来登录 Claude：浏览器会打开，点「授权」即可'
      & $claude auth login
    }
  } else {
    Say 'Claude Code 没装上：可能连不上 downloads.claude.ai。之后可以在天枢网页里再装'
  }
}

Write-Host ''
Write-Host '装好了。' -ForegroundColor Green
Say "程序：$Exe"
Say "卸载：powershell -ExecutionPolicy Bypass -File `"$Uninstall`""
if ($env:TIANSHU_LOCAL_NO_OPEN -ne '1') { Start-Process $TianshuUrl }
}
