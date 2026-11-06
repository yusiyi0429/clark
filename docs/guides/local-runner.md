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

> 下载源还没发布（11/06），发布步骤见下面「打包和发布」。改下载源用环境变量 `TIANSHU_LOCAL_DOWNLOAD_BASE`。

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
| 托盘里是「已暂停」，网页开不了工 | 托盘图标是橙色 | 托盘菜单点「恢复」（网页只能暂停，不能替本人恢复） |
| 网页报 401 | 口令失效（取消过配对、换了浏览器 profile） | 网页上重新「连接本机」 |
| 开工报 `folder_not_allowed` | 目录不在允许的文件夹里 | 网页上添加文件夹（本机选择框） |
| 开工报 `agent_not_installed` / `agent_incompatible` | 网页上的 Claude Code 状态 | 在网页上点安装，或手动 `irm https://claude.ai/install.ps1 \| iex`；版本太旧就 `claude update` |
| 事件里出现 `auth_required` | `claude auth status --json` | 网页上点「登录 Claude」，或终端里 `claude auth login` |
| 出现 `search_not_effective` | 这张卡用的模型 | 换成实测能搜的模型（DeepSeek v4.1 flash、Claude），或不用联网搜索 |
| 云端看不到进展 | `GET /v1/cloud` 的 `outbox.pending`、`lastError` | 没关联就在网页上重新连接；`lastError` 写令牌无效就重新连接；断网时会自己补发 |
| 托盘没有图标但程序在跑 | Win11 新图标默认收在任务栏右下角「^」里；数据目录 `bin/` 下有没有 `tianshu-tray-*.exe`（第一次启动用系统自带的 csc.exe 编出来） | 拖到任务栏上常驻；没编出来多半是系统缺 .NET Framework 4，程序照常跑但没有托盘和本机弹框 |
| 端口 47610 被占用 | `netstat -ano \| findstr 47610` | 在 `config.json` 里改 `port`；网页那边也要用同一个端口 |
| 安装时说开着「智能应用控制」 | Windows 安全中心 › 应用和浏览器控制 › 智能应用控制设置 | 没签名的版本装不了（ADR 0032）：等签名版，或本人决定关掉它 |
| 安装时中文是乱码、或报语法错 | `curl -sI <下载源>/install.ps1` 的 `Content-Type` | 下载源要回 `text/plain; charset=utf-8`（见「打包和发布」） |
| 选文件夹提示「不能选主目录…」 | 选的是不是主目录、`C:\Users`、`~/.claude` 或本机程序数据目录 | 选具体的项目文件夹（ADR 0031） |
| 权限请求标红写着「越界」 | 这一步要碰的路径不在允许的文件夹里 | 确认是本人要的再点「只允许这一次」；常用的外部目录直接加进允许的文件夹 |
| 卡上出现「连不上模型服务…正在重试」 | 这张卡用的网关地址、TokenHub 状态 | 网关模型重试 2 次就报错（约 3 秒；连上不回约 2 分钟）；修好网关后再发一句话会接着做 |

本机配置文件 `%LOCALAPPDATA%\Tianshu\local\config.json`（Mac：`~/Library/Application Support/Tianshu/local/config.json`），本人手改，网页改不了：

```json
{ "extraOrigins": ["http://localhost:3000"], "port": 47610, "claudePath": null, "tianshuUrl": "https://tk.tokenkingos.com" }
```

会话事件日志在同目录的 `sessions/<会话 id>/events.jsonl`，排查时先看这里。钥匙在 `secrets.json`（Windows DPAPI 加密）或钥匙串（Mac），不要发给别人。

## 打包和发布

**发布到线上是部署动作，要本人同意；动线上服务器前先按部署规范重读一遍（飞书知识库 XbCWwMI9fi9n1AkycJvcdJgvnsg）。** 签名、公证的选项见 ADR 0032，现在发的是不签名版。

1. **改版本号**：`apps/local/src/config.ts` 的 `VERSION` 和 `apps/local/package.json` 的 `version`（两处要一致，打包脚本会查；Windows 程序属性里的版本从 `config.ts` 取）。
2. **准备文件**（Windows 上跑，要 Bun ≥1.3，不在 PATH 里就用 `BUN=路径`）：

   ```bash
   pnpm --filter @warmap/local release
   ```

   编 Windows x64、macOS arm64/x64 三个程序，连同 `install.ps1`、`uninstall.ps1`、`install.sh`、`uninstall.sh` 放进 `apps/local/dist/release/<版本>/`，写 `SHA256SUMS`。顺带自查：`install.ps1` 不能带 BOM（`irm | iex` 会把它当成乱码命令）、`uninstall.ps1` 要带 BOM（`powershell -File` 在 5.1 下没有 BOM 按本地代码页读）、`.sh` 必须是 LF、三个程序的文件格式对。只换脚本不重编程序时加 `-- --skip-build`。
3. **Mac 程序验签**（12 月 Mac 版上线前，在一台 Mac 上做）：`codesign -v tianshu-local-darwin-arm64`、`-x64`。Bun 交叉编译会带临时签名，但有报告说会失效；失效就 `codesign --remove-signature <文件> && codesign --force --sign - <文件>`，把签好的文件放回 `apps/local/dist/`，再跑一次第 2 步（`--skip-build`）重写 `SHA256SUMS`。
4. **上传**：把 `dist/release/<版本>/` 里的 8 个文件整体放进下载源目录（建议服务器上按版本留目录，`/downloads/local/` 指向当前版本，回滚时指回上一版）。**脚本和 `SHA256SUMS` 必须回 `Content-Type: text/plain; charset=utf-8`**（PowerShell 5.1 的 `irm` 没有 charset 时按 ISO-8859-1 解码，中文全乱，11/06 实测）。Caddy 写法参考（没在线上验证过）：

   ```
   handle_path /downloads/local/* {
       root * /srv/tianshu-downloads/local/current
       @text path *.ps1 *.sh /SHA256SUMS
       header @text Content-Type "text/plain; charset=utf-8"
       header Cache-Control "no-cache"
       file_server
   }
   ```

5. **核对线上**：

   ```bash
   node apps/local/scripts/release.mjs --verify https://tk.tokenkingos.com/downloads/local
   ```

   逐个下载，核对哈希和 `SHA256SUMS` 一致、文本文件带 `charset=utf-8`；有一项不对就报错退出。
6. **真装一遍**：找一台没装过的 Windows 电脑跑一行安装命令，看托盘图标、`http://127.0.0.1:47610/v1/health` 的版本号，再卸载。

11/06 在本机模拟过第 2、4、5、6 步：本机起一个带 charset 的静态服务当下载源，Windows PowerShell 5.1 `irm | iex` 下载 → 核对 `SHA256SUMS` → 装好 → 自启 → 托盘，用时 22 秒；`--verify` 通过；换成不带 charset 的服务，`--verify` 报出 5 个文本文件，`irm` 取到的中文是乱码；卸载（带 `TIANSHU_LOCAL_PURGE=1`）后进程、自启项、程序、数据、端口全部清掉。

## 开发

见 [apps/local/README.md](../../apps/local/README.md)。
