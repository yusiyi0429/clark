# 启动本机 HTTPS 反代（Caddy 容器 tianshu-lan-https），只监听这台电脑的 Wi-Fi 地址。
# 用 PowerShell 7 运行：pwsh -NoProfile -File .scratch/lan-https/start.ps1
$ErrorActionPreference = 'Stop'
$ip = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object { $_.InterfaceAlias -match '^(WLAN|Wi-?Fi)' } | Select-Object -First 1 -ExpandProperty IPAddress
if (-not $ip) { throw '找不到 Wi-Fi 的 IPv4 地址：先连上 Wi-Fi' }
$ca = Join-Path $PSScriptRoot 'ca'
$caFile = Join-Path $ca 'tianshu-local-ca.crt'
New-Item -ItemType Directory -Force -Path $ca | Out-Null

docker rm -f tianshu-lan-https 2>&1 | Out-Null
docker run -d --name tianshu-lan-https -e "LAN_IP=$ip" `
  -p "$($ip):8443:8443" -p "$($ip):8444:8444" -p "$($ip):8480:8480" `
  --add-host host.docker.internal:host-gateway `
  -v tianshu-lan-caddy-data:/data `
  --mount "type=bind,source=$(Join-Path $PSScriptRoot 'Caddyfile'),target=/etc/caddy/Caddyfile,readonly" `
  --mount "type=bind,source=$ca,target=/srv/ca,readonly" `
  caddy:2 | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Caddy 容器没有起来：确认 Docker Desktop 在运行，8443/8444/8480 没被占用' }

# 等本机 CA 生成，只把公开的 root.crt 拷出来给手机下载。
$deadline = (Get-Date).AddSeconds(30)
do {
  Start-Sleep -Milliseconds 800
  docker cp tianshu-lan-https:/data/caddy/pki/authorities/local/root.crt $caFile 2>&1 | Out-Null
} until ((Test-Path -LiteralPath $caFile) -or (Get-Date) -gt $deadline)
if (-not (Test-Path -LiteralPath $caFile)) { throw '30 秒内没拿到根证书，看 docker logs tianshu-lan-https' }

Write-Host ''
Write-Host "本机 HTTPS 反代已启动（Wi-Fi 地址 $ip）"
Write-Host "  开发环境：https://$($ip):8443"
Write-Host "  时间机器：https://$($ip):8444（先启动时间机器）"
Write-Host "  手机第一次用：Safari 打开 http://$($ip):8480/tianshu-local-ca.crt 装证书"
Write-Host "  API 的 EXTRA_ALLOWED_ORIGINS 要包含 https://$($ip):8443"
