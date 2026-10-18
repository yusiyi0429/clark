# 一键同步：本机链接协议方案（未实现）

现在的一键同步是本机命令 `tkos_collector.py sync`。下一步让天枢通知里的链接直接触发它：

1. **协议**：`tkos-collector://sync`，不带任何参数（不接受服务端传来的路径、命令或令牌，免得链接被人拿来在本机执行别的东西）。
2. **注册**：
   - Windows：安装脚本在 `HKCU\Software\Classes\tkos-collector` 下写 `URL Protocol` 和 `shell\open\command`，命令固定为 `pythonw.exe "<安装目录>\tkos_collector.py" sync`。只写当前用户，不要管理员。
   - macOS：launchd 不处理链接，需要一个极小的 `.app`（`Info.plist` 里声明 `CFBundleURLTypes`），收到链接后执行同一条命令。用 `osacompile` 从一行 AppleScript 生成，装到 `~/Applications`，再用 `lsregister` 登记。
3. **卸载**：两个卸载脚本一并删掉注册表项或 `.app`。
4. **天枢侧**：健康探测记黄、记红后，给本人的提醒里带「立即同步」链接 `tkos-collector://sync`；没装采集器的浏览器打开会失败，提醒里同时给本机命令作为备选。
5. **防重复**：`sync` 与定时检查可能同时跑。定时任务已设 `MultipleInstances IgnoreNew`（Windows），本机脚本再加一个 `~/.tkos-world/collector.lock` 文件锁即可。

待定：macOS 的 `.app` 是否要签名（未签名的首次打开会被 Gatekeeper 拦）。
