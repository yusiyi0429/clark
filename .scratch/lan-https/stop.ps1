# 关掉本机 HTTPS 反代。根证书和私钥留在命名卷里，下次启动证书不变，手机不用重装。
# 彻底不用时：docker volume rm tianshu-lan-caddy-data，并在 iPhone「设置 → 通用 → VPN 与设备管理」里删掉描述文件。
docker rm -f tianshu-lan-https 2>&1 | Out-Null
Write-Host '本机 HTTPS 反代已关闭。'
