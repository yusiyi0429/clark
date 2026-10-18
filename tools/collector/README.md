# 本机采集器

## 准备

1. 装好 Python 3（已装 tkos-world 的，会自动用 `~/.tkos-world/venv` 里的 Python）。
2. 在天枢生成一个「本机采集器」令牌（client 为 `collector`，只能用来上报，连不了 MCP）。页面入口还没做，先在已登录天枢的浏览器标签里打开开发者工具的控制台，运行：

   ```js
   await (await fetch("/api/me/tokens", { method: "POST", headers: { "content-type": "application/json" },
     body: JSON.stringify({ name: "本机采集器", client: "collector", expiresInDays: 90 }) })).json()
   ```

   复制返回里的 `token`，下一步安装时粘贴。令牌只显示这一次。

## 安装

Windows（PowerShell，在本目录下）：

```powershell
powershell -ExecutionPolicy Bypass -File .\install-windows.ps1 -Server https://天枢地址
```

macOS（终端，在本目录下）：

```sh
sh install-macos.sh --server https://天枢地址
```

- 按提示粘贴令牌。令牌存在 `~/.tkos-world/collector.token`。
- 收工时间默认 20:30，要改就加 `-EodTime 19:00`（Windows）或 `--eod 19:00`（macOS）。
- 想先看会做什么，加 `-DryRun` 或 `--dry-run`：只打印，不复制、不注册。

装好后每 30 分钟检查一次；电脑关机或睡眠错过的，开机后补跑。

## 一键同步

不等定时，现在就整理并上报一次：

```sh
python ~/.tkos-world/collector/tkos_collector.py sync
```

Windows 把 `python` 换成 `& "$env:USERPROFILE\.tkos-world\venv\Scripts\python.exe"`，路径换成 `"$env:USERPROFILE\.tkos-world\collector\tkos_collector.py"`。

只看要发什么、不真发：在命令后加 `--dry-run`。

## 卸载

Windows：

```powershell
powershell -ExecutionPolicy Bypass -File .\uninstall-windows.ps1
```

macOS：

```sh
sh uninstall-macos.sh
```

加 `-Purge`（Windows）或 `--purge`（macOS）会连令牌、配置和水位线 `~/.tkos-world/daily-state.json` 一起删。卸载后到天枢撤销这个令牌。
