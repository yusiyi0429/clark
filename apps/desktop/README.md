# 天枢桌面版（apps/desktop）

Electron 壳：一个窗口开线上天枢（`https://tk.tokenkingos.com`），窗口里只停天枢和飞书登录授权页，别的链接交给系统浏览器。线上网页拿不到 Node（`contextIsolation`、`sandbox`、不开 `nodeIntegration`、不挂 preload），本机能力只经 127.0.0.1 那套（Origin 白名单、口令、本机确认）。计划和取舍见设计稿 17.5 / 17.7 和 `桌面版计划_D_1108.md`（共享笔记）。

进度：第 1 天（窗口、放行规则、权限、连不上页、单实例、UA 标记）；第 2 天（本机程序进壳、托盘、开机自启、关窗口进托盘、接管旧版）。安装包、自动更新在第 3 天。

## 本机程序怎么在壳里跑

- `scripts/build-runner.mjs` 用 esbuild 把 `apps/local/src/hosted.ts` 打成 `dist/runner/hosted.cjs`（约 1 MB），壳用 Electron 的 `utilityProcess` 跑它（Electron 自带的 Node）。本机程序源码照旧只用 `node:`。
- 本机程序这边是 `HostedDesktop`（`apps/local/src/desktop/hosted.ts`）：配对确认框、选文件夹、托盘状态经消息口交给壳；托盘的暂停、恢复、退出经消息口回来。数据目录、端口（47610）、配置和脚本装的一样。
- 壳这边（`src/runner.ts`）：意外退出就重拉（2、4、8… 秒，最多 60 秒）；起不来（端口被占）不重拉，托盘提示原因。退出时先让本机程序停掉会话进程再退，10 秒没退就强停。
- 托盘：四种颜色和文案同原来的 C# 托盘（灰没配对、蓝已连接、绿正在跑、橙已暂停）；菜单「打开天枢 / 暂停全部（恢复）/ 退出」；单击叫出窗口。关窗口只是收进托盘。
- 开机自启：装好的桌面版用登录项（HKCU，不要管理员），带 `--hidden` 只进托盘；开发时跑的 electron.exe 不登记。
- 接管脚本装的旧版（`src/legacy.ts`）：删 `HKCU\…\Run\TianshuLocal`，停掉 `%LOCALAPPDATA%\Programs\Tianshu\tianshu-local.exe` 这个路径的进程（强停，旧版正在跑的会话会断，桌面版的本机程序起来后照原样排队和续接）；数据目录不动，桌面版照用；程序文件留着。

## 上手

```bash
pnpm --filter @warmap/desktop test        # 放行规则单测
pnpm --filter @warmap/desktop start       # 编译并打开窗口（第一次会下载 Electron 运行时）
```

`TIANSHU_DESKTOP_ORIGIN=https://…` 可换天枢环境（只认 https；要连本机程序，这个来源得在本机程序的 Origin 白名单里）。

## 网页怎么认出在桌面版里

UA 末尾带 `TianshuDesktop/<版本>`。不给网页挂桥。

## 第 1 天实测（11/08，Electron 45.0.0 / Chromium 156，Windows 11）

- **网页直连 127.0.0.1**：天枢页面 `fetch("http://127.0.0.1:<端口>/v1/health")` 直接 200，不弹授权框。Electron 默认把本地网络访问（`local-network-access`、`loopback-network`、`local-network`）全给；壳装了权限处理以后，判「拒绝」也只改网页查到的状态，请求照样通。所以挡别的页面靠本机程序的 Origin 白名单和口令（原来就是这样）；壳只给天枢放行，让网页查状态时看到「已允许」，不出浏览器那套授权引导。检查时给的 origin 带结尾斜杠，按 URL 解析后比。
- **飞书登录**：窗口里打开 `/api/auth/feishu/start`，跳转链 accounts → passport → accounts → login（trap）→ accounts 扫码页，二维码正常显示。扫码后回调 `/api/auth/feishu/callback` 回到同一个窗口、同一份 cookie（state cookie 是 SameSite=Lax 的顶层跳转，和浏览器一样）；**扫码这一步没实测**（要本人扫），本人第一次在桌面版里登录时确认。
- 窗口里：网页拿不到 `require`、`process`；跳 `file:` 被挡、不交给系统浏览器；Electron 在「窗口都关了」时默认退出程序（托盘常驻时要改）。

## 第 2 天实测（11/08，同上）

用临时的 `LOCALAPPDATA`（数据不碰本人的），放一个改名成 `tianshu-local.exe` 的程序当旧版、加一条测试用的 `TianshuLocal` 自启项，起壳：
- 本机程序在壳里起来，47610 的 `/v1/health` 是 `tianshu-local`；旧版被停、自启项被删，数据目录在 `LOCALAPPDATA\Tianshu\local`。
- 网页发起配对 → 壳弹系统确认框（文字里有确认码）→ 点「是」→ 网页拿到口令。确认框是任务对话框，按钮不支持 UI 自动化的「点击」，测试里是聚焦第一个按钮按空格。
- 带口令读 `/v1/status`：本机程序在 utilityProcess 里照常拉起 `claude`（读到 Claude Code 2.1.318、ready）。
- 退出（关浏览器）：本机程序跟着退，47610 放开，没有残留的 Electron 进程。
- 没实测：托盘图标的样子和菜单（要看屏幕）、选文件夹的系统框（本机程序这边有单测）、真重启后的开机自启（第 4 天）。
