# 天枢桌面版（apps/desktop）

Electron 壳：一个窗口开线上天枢（`https://tk.tokenkingos.com`），窗口里只停天枢和飞书登录授权页，别的链接交给系统浏览器。线上网页拿不到 Node（`contextIsolation`、`sandbox`、不开 `nodeIntegration`、不挂 preload），本机能力只经 127.0.0.1 那套（Origin 白名单、口令、本机确认）。计划和取舍见设计稿 17.5 / 17.7 和 `桌面版计划_D_1108.md`（共享笔记）。

进度：第 1 天（窗口、放行规则、权限、连不上页、单实例、UA 标记）。本机程序进壳、托盘、开机自启、安装包、自动更新在后面几天。

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
