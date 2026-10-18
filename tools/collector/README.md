# 本机采集器

## 一行安装（推荐）

天枢上手流程的「安装本机采集器」一步：点「生成」得到本人的采集器令牌，按系统复制一行命令到终端执行。命令从天枢拉安装脚本（`/api/collector/install.ps1`、`/api/collector/install.sh`），脚本再从 `/api/collector/files/` 下载三个 Python 文件，令牌只在命令参数里：

```powershell
& ([scriptblock]::Create((irm 'https://天枢地址/api/collector/install.ps1'))) -Server 'https://天枢地址' -Token '令牌'
```

```sh
curl -fsSL 'https://天枢地址/api/collector/install.sh' | sh -s -- --server 'https://天枢地址' --token '令牌'
```

装好后第一次检查就发心跳，并带上本机清单（定时任务、近 30 天会话里读过的飞书文档、记忆文件的路径和大小），上手页面随即显示「已连接」并开始扫描。之后每天盘点一次。

## 准备（手动安装）

1. 装好 Python 3（已装 tkos-world 的，会自动用 `~/.tkos-world/venv` 里的 Python）。
2. 在天枢生成一个「本机采集器」令牌（client 为 `collector`，只能用来上报，连不了 MCP）。不走上手流程时，在已登录天枢的浏览器标签里打开开发者工具的控制台，运行：

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
