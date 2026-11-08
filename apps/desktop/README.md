# 天枢桌面版（apps/desktop）

Electron 壳：一个窗口开线上天枢（`https://tk.tokenkingos.com`），窗口里只停天枢和飞书登录授权页，别的链接交给系统浏览器。线上网页拿不到 Node（`contextIsolation`、`sandbox`、不开 `nodeIntegration`、不挂 preload），本机能力只经 127.0.0.1 那套（Origin 白名单、口令、本机确认）。计划和取舍见设计稿 17.5 / 17.7 和 `桌面版计划_D_1108.md`（共享笔记）。

进度：第 1 天（窗口、放行规则、权限、连不上页、单实例、UA 标记）；第 2 天（本机程序进壳、托盘、开机自启、关窗口进托盘、接管旧版）；第 3 天（安装包、自动更新）。

## 本机程序怎么在壳里跑

- `scripts/build.mjs` 用 esbuild 把 `apps/local/src/hosted.ts` 打成 `app/dist/runner/hosted.cjs`（约 1 MB），壳用 Electron 的 `utilityProcess` 跑它（Electron 自带的 Node）。本机程序源码照旧只用 `node:`。
- 本机程序这边是 `HostedDesktop`（`apps/local/src/desktop/hosted.ts`）：配对确认框、选文件夹、托盘状态经消息口交给壳；托盘的暂停、恢复、退出经消息口回来。数据目录、端口（47610）、配置和脚本装的一样。
- 壳这边（`src/runner.ts`）：意外退出就重拉（2、4、8… 秒，最多 60 秒）；起不来（端口被占）不重拉，托盘提示原因。退出时先让本机程序停掉会话进程再退，10 秒没退就强停。
- 托盘：四种颜色和文案同原来的 C# 托盘（灰没配对、蓝已连接、绿正在跑、橙已暂停）；菜单「打开天枢 / 暂停全部（恢复）/ 退出」；单击叫出窗口。关窗口只是收进托盘。
- 开机自启：装好的桌面版用登录项（HKCU，不要管理员），带 `--hidden` 只进托盘；开发时跑的 electron.exe 不登记。
- 接管脚本装的旧版（`src/legacy.ts`）：删 `HKCU\…\Run\TianshuLocal`，停掉 `%LOCALAPPDATA%\Programs\Tianshu\tianshu-local.exe` 这个路径的进程（强停，旧版正在跑的会话会断，桌面版的本机程序起来后照原样排队和续接）；数据目录不动，桌面版照用；程序文件留着。

## 上手

```bash
pnpm --filter @warmap/desktop test        # 放行规则、托盘单测
pnpm --filter @warmap/desktop start       # 打包产物并打开窗口（第一次会下载 Electron 运行时）
pnpm --filter @warmap/desktop dist        # 出安装包：release/tianshu-desktop-setup-<版本>.exe、.blockmap、latest.yml
```

## 安装包和自动更新

- `scripts/build.mjs` 生成 `app/`：`package.json`（名字 `tianshu-desktop`，版本、说明照本目录的）、`dist/main.cjs`（主进程连同 electron-updater 打成一个文件，包里不带 `node_modules`）、`dist/runner/hosted.cjs`；另生成 `resources/icon.png`。
- `electron-builder --projectDir app`：NSIS 一键装、按用户装到 `%LOCALAPPDATA%\Programs\tianshu-desktop`、不要管理员、中文界面；卸载不删本机数据，删开机自启和开始菜单、桌面的「天枢」快捷方式（`resources/installer.nsh`，带 BOM，NSIS 才按 UTF-8 读中文）。约 121 MB。内部版不签名。
  项目目录必须是 `app/`：用 apps/desktop 时安装目录总按工作区包名变成 `@warmap/desktop`（extraMetadata、directories.app 都不管用，11/08 实测）。
- 打包的坑：electron-builder 26.18 声明 `@electron/get ^3.0.0` 却要 3.1 的东西，根目录 `pnpm-workspace.yaml` 用 override 锁到 3.1.0；Electron 用 `node_modules/electron/dist` 现成的（`electronDist`）。GitHub 下载打包工具超时（504）时，设 `ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/`（工具包有 sha256 校验）。
- 自动更新（`src/updates.ts`）：装好的版本启动时和每 6 小时从下载源（`https://tk.tokenkingos.com/downloads/desktop`，发布时上传 release/ 里的安装包、.blockmap、latest.yml）拉 latest.yml，后台下好；托盘出「重启换新版本 x.y.z」，有卡在跑时点不了（写「卡跑完再重启」）；不点也行，下次从托盘退出时静默装上。`TIANSHU_DESKTOP_UPDATE_URL` 可换下载源。

## 第 3 天实测（11/08）

0.1.0 和 0.1.1 两个安装包，下载源用本地模拟（只听 127.0.0.1），本机程序数据放临时目录（`TIANSHU_LOCAL_HOME`）：
- 静默装 0.1.0：装到 `Programs\tianshu-desktop`，启动后本机程序在 47610 起来，开机自启登记上。
- 自动更新：拉了 latest.yml、blockmap，0.1.1 下到 `tianshu-desktop-updater\pending`；从退出流程（先停本机程序）静默装上，exe 版本变成 0.1.1。
- 静默卸载：程序目录、开机自启、安装登记、快捷方式都没了；本机数据留着。测完这台电脑上没有残留（程序、快捷方式、注册表、进程、端口）。
- 没实测：从浏览器下载安装包时的 SmartScreen 提示（这次是本地文件，没有「来自网络」标记）、托盘「重启换新版本」点击、真重启后的开机自启（第 4 天）。

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
