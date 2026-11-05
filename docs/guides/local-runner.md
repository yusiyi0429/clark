# 天枢本机程序：安装、卸载、排错

设计见 [RFC](../technical/local-runner/RFC.md)。代码在 `apps/local`。

## 安装

本人在自己电脑上开一个终端（Windows 是 PowerShell，Mac 是「终端」），粘一行：

```powershell
irm https://tk.tokenkingos.com/downloads/local/install.ps1 | iex
```

```sh
curl -fsSL https://tk.tokenkingos.com/downloads/local/install.sh | sh
```

> 下载源还没发布（11/06）。发布时把 `dist/` 里的产物、`SHA256SUMS`、四个脚本放到同一个目录；服务器给 `.ps1` 要回 `Content-Type: text/plain; charset=utf-8`，否则 Windows PowerShell 5.1 会把中文解成乱码。改下载源用环境变量 `TIANSHU_LOCAL_DOWNLOAD_BASE`。

装完会：程序放在 `%LOCALAPPDATA%\Programs\Tianshu\tianshu-local.exe`（Mac：`~/Library/Application Support/Tianshu/bin/tianshu-local`）；注册开机自启；托盘（Mac 菜单栏）出现天枢图标；没装 Claude Code 就用官方脚本装上，没登录就打开浏览器让本人点授权；最后打开天枢网页。全程不要管理员。

然后在天枢网页上：浏览器问「想要访问此设备上的其他应用和服务」时点**允许**；点「连接本机」，本机弹框里核对四位确认码，点**是**；再添加允许的文件夹（本机会弹出选择框）。

## 卸载

```powershell
powershell -ExecutionPolicy Bypass -File "$env:LOCALAPPDATA\Programs\Tianshu\uninstall.ps1"
```

```sh
sh "$HOME/Library/Application Support/Tianshu/bin/uninstall.sh"
```

停掉程序和它拉起的进程、取消开机自启、删掉程序。本机数据（会话记录、配对、模型配置和钥匙）默认保留；要一起删，先设 `TIANSHU_LOCAL_PURGE=1`。Claude Code 不动。

## 排错

| 现象 | 看什么 | 怎么办 |
|-|-|-|
| 网页说连不上本机 | 托盘有没有图标；浏览器地址栏左边站点设置里「本地网络访问」是不是「屏蔽」 | 没图标就双击 `%LOCALAPPDATA%\Programs\Tianshu\tianshu-local.exe`，或重新跑安装命令；被屏蔽就改回「允许」（装成应用的窗口：右上角「⋮ → 应用信息」） |
| 网页报 403 | 本机 `config.json` 的 `allowedOrigins`/`extraOrigins` | 本地开发的网页来源（如 `http://localhost:3000`）要加进 `extraOrigins`，改完重启本机程序 |
| 网页报 401 | 口令失效（取消过配对、换了浏览器 profile） | 网页上重新「连接本机」 |
| 开工报 `folder_not_allowed` | 目录不在允许的文件夹里 | 网页上添加文件夹（本机选择框） |
| 开工报 `agent_not_installed` / `agent_incompatible` | 网页上的 Claude Code 状态 | 在网页上点安装，或手动 `irm https://claude.ai/install.ps1 \| iex`；版本太旧就 `claude update` |
| 事件里出现 `auth_required` | `claude auth status --json` | 网页上点「登录 Claude」，或终端里 `claude auth login` |
| 出现 `search_not_effective` | 这张卡用的模型 | 换成实测能搜的模型（DeepSeek v4.1 flash、Claude），或不用联网搜索 |
| 云端看不到进展 | `GET /v1/cloud` 的 `outbox.pending`、`lastError` | 没关联就在网页上重新连接；`lastError` 写令牌无效就重新连接；断网时会自己补发 |
| 托盘没有图标但程序在跑 | Win11 新图标默认收在任务栏右下角「^」里 | 拖到任务栏上常驻 |
| 端口 47610 被占用 | `netstat -ano \| findstr 47610` | 在 `config.json` 里改 `port`；网页那边也要用同一个端口 |

本机配置文件 `%LOCALAPPDATA%\Tianshu\local\config.json`（Mac：`~/Library/Application Support/Tianshu/local/config.json`），本人手改，网页改不了：

```json
{ "extraOrigins": ["http://localhost:3000"], "port": 47610, "claudePath": null, "tianshuUrl": "https://tk.tokenkingos.com" }
```

会话事件日志在同目录的 `sessions/<会话 id>/events.jsonl`，排查时先看这里。钥匙在 `secrets.json`（Windows DPAPI 加密）或钥匙串（Mac），不要发给别人。

## 开发

见 [apps/local/README.md](../../apps/local/README.md)。
