# 天枢装成 PWA 后访问 127.0.0.1 的授权：实验结论（2026-11-06）

## 一句话结论

Chrome 156 里，访问 127.0.0.1 的授权按**来源（origin）+ 浏览器 profile** 保存，标签页和装好的应用窗口**共用同一份**：

- 在标签页里允许过，装成应用后在应用窗口里不用再授权。
- 反过来也一样：在应用窗口里屏蔽，标签页里也是屏蔽。
- 没授权过、第一次就在应用窗口里访问，**会弹同样的授权框**，挂在应用窗口标题栏右上角的「⋮」按钮下面。
- 在应用窗口里点了屏蔽之后，可以从窗口里改回来：**「⋮」→「应用信息 localhost:47631」→「设备上的应用」开关**（或点「重置权限」）。改完立刻生效，不用刷新页面。

Edge 156 只测了访客模式加 `--app` 窗口，弹窗和权限共享的表现和 Chrome 一致。**Edge 真正安装 PWA 没测**，原因见第 4 节。

## 环境与搭法

| 项 | 内容 |
|---|---|
| 浏览器 | Chrome 156.0.8078.80；Edge 156.0.4314.58（Windows 11） |
| 测试页 | `http://localhost:47631`，`server.mjs` 零依赖。提供 manifest（id/start_url `/`、`display: standalone`、192/512 图标）和一个直通的 service worker。页面上有一个按钮去 fetch `http://127.0.0.1:47632/health`，并显示 `loopback-network` / `local-network-access` / `local-network` 三个权限状态，以及 `display-mode` |
| 假本机服务 | `127.0.0.1:47632`，只回 `/health`。CORS 只放行 `http://localhost:47631`，检查 Host，没有 Origin 的请求一律回 403（已用 curl 验证） |
| 当作公网来源 | `--ip-address-space-overrides=127.0.0.1:47631=public` |
| profile | 每轮都用全新的 `--user-data-dir`（chrome-A / chrome-B / chrome-C，Edge 用 edge-G / edge-G2 加 `--guest`），加了 `--no-first-run --disable-sync`，**没有登录任何账号**。测完已全部删除 |
| CDP | `--remote-debugging-port=47633`，用来读权限状态和页面结果 |
| 怎么安装 | **真安装**：用 Windows UI 自动化点地址栏里的「安装“天枢 PWA 测试”」，再在安装确认框里点「安装」，和用户手动安装完全一样。装完后 Chrome 把当前标签页转成应用窗口；同时生成了开始菜单快捷方式、桌面快捷方式和 HKCU 卸载项（已通过应用自己的「卸载」清掉，前后对比为零差异）。CDP 的 `PWA.install` / `PWA.getOsAppState` 在这个版本里返回 `'PWA.getOsAppState' wasn't found`，用不了 |
| 怎么点允许/屏蔽 | **CDP 模拟不了**：`Browser.setPermission`（loopback-network / local-network-access / local-network）和 `Browser.grantPermissions`（loopbackNetwork / localNetworkAccess / localNetwork）都返回 ok，但页面里的权限状态一直是 prompt，挂起的请求也不放行（截图 `c02_tab_after_cdp_grant.png`）。这类覆盖只在 CDP 会话期间有效，不等于用户真的点了。所以改用 Windows UI 自动化（UIA InvokePattern），直接点**隔离浏览器里的原生弹窗**上的「允许」「屏蔽」按钮，效果就是真实点击，会写进站点设置 |
| 截图 | `shot.ps1` 只截我们自己起的浏览器进程的窗口，包括弹窗 |

## 1. 标签页里授权过，装成应用后还要不要再授权？——不用，权限按来源共享（Chrome 已验证）

步骤（profile chrome-A）：

1. 在标签页打开测试页。权限状态全是 `prompt`。点 fetch 后请求挂起，服务端一条请求都没收到，弹出授权框：「http://localhost:47631 想要 / 访问此设备上的其他应用和服务 / 允许 / 屏蔽」，挂在地址栏下面。截图 `shots/c01_tab_prompt.png`。
2. 点「允许」。权限变成 `loopback-network=granted, local-network-access=granted`（`local-network` 仍是 prompt，因为它管的是局域网，不是本机），fetch 返回 200。截图 `shots/c02_tab_after_allow.png`。
3. 点地址栏的「安装」，在确认框里点「安装」（截图 `shots/c03_install_dialog.png`）。标签页变成独立的应用窗口，`display-mode` 是 `standalone`。
4. 在应用窗口里刷新页面再 fetch：**没有弹窗，直接 200（9ms）**，权限状态是 granted。截图 `shots/c04_app_after_tab_grant.png`。
5. 关掉应用窗口，用开始菜单快捷方式同样的参数（`--app-id=lgoobpjlepgpdfkcjpoioflbcdbiaiop`）重新启动应用，再 fetch：同样直接 200（8ms），没有弹窗。

反向也验证了（profile chrome-B）：在应用窗口里屏蔽后，用标签页打开同一来源，权限是 `denied`，fetch 在 5ms 内失败，也不弹窗。

结论：授权存在站点设置里，按 origin 加 profile 区分，和窗口形态无关。两个前提要注意：

- 换了 profile 或换了浏览器，要重新授权。
- 天枢线上来源是 `https://tk.tokenkingos.com`，授权也只认这个来源。预发、其他域名都要各授权一次。

## 2. 没授权过、第一次就在应用窗口里访问，会不会弹？——会，弹在标题栏「⋮」下面

步骤（全新 profile chrome-B）：先在标签页里装好应用，安装前没有发过任何本机请求。然后用 `--app-id` 冷启动应用窗口，在里面点 fetch：

- 应用窗口没有地址栏，授权框挂在**标题栏右上角的「⋮」（自定义和控制天枢 PWA 测试）按钮下面**。文案和按钮跟标签页里一模一样：「http://localhost:47631 想要 / 访问此设备上的其他应用和服务 / 允许 / 屏蔽」。截图 `shots/c05_app_first_prompt.png`。
- 请求一直挂起，等用户选择（5 秒后仍然 pending），服务端收不到请求。
- 点「允许」后，**挂起的那次请求会直接成功**，不用重发。在 chrome-C 里验证过：单个请求点允许后 3.7 秒返回 200；两个并发请求，点一次允许后两个都返回 200。Edge 也一样：标签页里点允许后，挂起的请求返回 200。

## 3. 在应用窗口里点了屏蔽，用户怎么改回？——窗口里就有入口

点「屏蔽」之后（chrome-B）：

- 挂起的请求失败（`TypeError: Failed to fetch`），权限变成 `loopback-network=denied, local-network-access=denied`。
- 以后再 fetch，**3ms 内直接失败，不再弹窗**。标题栏上也**没有任何「已屏蔽」的提示图标**，用户看不出被拦了。截图 `shots/c06_app_after_block.png`。

**在应用窗口里改回的路径（已实际操作验证）：**

1. 点标题栏「⋮」，菜单第一项是「应用信息　localhost:47631」。截图 `shots/c10_app_menu.png`。
2. 点开后是站点信息面板，里面有「设备上的应用」开关（当前关着）和「重置权限」按钮，下面还有「Cookie 和网站数据」「设置」。截图 `shots/c11_app_info_bubble.png`。
3. 打开「设备上的应用」开关后，权限马上变成 granted，**不刷新页面**再 fetch 就返回 200。截图 `shots/c12_app_info_toggled_on.png`。

其他入口：

- `chrome://settings/content/siteDetails?site=<来源>` 里有一行「设备上的应用」，选项为「询问（默认）/允许/屏蔽」，屏蔽后显示「屏蔽」。截图 `shots/c09_site_details_blocked.png`。同一页还有一行「本地网络」，对应局域网，和 127.0.0.1 无关。
- `chrome://app-settings/<app-id>`（应用设置页）**没有列出这个权限**，只有位置、摄像头、麦克风，要点「更多设置和权限」才能跳到上面的站点设置。截图 `shots/c08_app_settings_page.png`。

用户看到的名称是 **「设备上的应用」**，对应权限名 `loopback-network`。天枢里做引导文案时应该用这个名字。

## 4. Edge

**测了什么：访客模式（`--guest`），没有登录。**

- 访客模式**不能安装 PWA**：`Page.getInstallabilityErrors` 返回 `in-incognito`，地址栏也没有安装按钮。
- 所以用 `--app=URL` 打开应用式窗口代替安装。这种窗口的 `display-mode` 也是 `standalone`。

| 场景 | 结果 | 证据 |
|---|---|---|
| 标签页首次访问 | 弹框，请求挂起。文案和 Chrome 一样，按钮是「阻止 / 允许」（Edge 把「屏蔽」叫「阻止」） | `shots/e01_guest_tab_prompt.png` |
| 标签页点允许后，在同一会话里打开 `--app` 窗口 | 不弹框，直接 200，权限 granted（同样按来源共享） | `shots/e02_guest_appwin_after_tab_allow.png` |
| 全新访客会话，直接在 `--app` 窗口里首次访问 | 弹框，挂在窗口内容区左上角，请求挂起 | `shots/e03_guest_appwin_first_prompt.png` |
| `--app` 窗口里点「阻止」 | 请求失败，之后 2ms 内直接失败，不再弹框 | `shots/e04_guest_appwin_after_block.png` |

**和真正装好的 PWA 有什么差别：**`--app` 窗口的标题栏只有最小化、最大化、关闭三个按钮，**没有「…」菜单**，所以在窗口里找不到站点设置入口。真正装好的 Edge PWA 有自己的菜单，但这次没法验证。

**没测的部分与原因：**Edge 真安装后的弹窗位置、菜单里的站点权限入口都没测。

- 访客模式和 InPrivate 都不能装 PWA。
- 普通的独立 profile 一启动就可能自动登录本人的微软账号（11/05 出过一次），按要求不冒这个险。

想补测的话，最稳的办法是本人在自己 Edge 的一个已登录 profile 里手动装一次线上天枢，看授权框和「…」菜单。按 Chrome 上的结果推断，表现应该一样，但这只是推断，没有验证。

## 顺带发现（对天枢有用）

- **本机程序没启动时也会弹授权框。**第一次跑 chrome-B 时，测试服务被我意外杀掉了（见下面的「过程问题」）。那时在应用窗口里 fetch，4ms 就失败了（连接被拒），但授权框照样弹了出来。也就是说，用户可能在本机程序还没装、还没启动的时候就被问一次；要是顺手点了「屏蔽」，以后就再也不会弹了。建议天枢先用别的方式判断本机程序是否在线，再去发第一次请求，或者在发请求前先说明要问什么。
- **屏蔽之后完全没有提示。**请求几毫秒就失败，界面上也没有提示图标。天枢应该用 `navigator.permissions.query({name:'loopback-network'})` 读到 `denied` 时，自己提示用户：「⋮ → 应用信息 → 设备上的应用」（标签页里是点地址栏左边的图标）。权限状态可以用 `onchange` 监听；我在页面里挂了监听，切换开关后页面显示马上更新了。
- **CDP 不能用来做自动化授权。**`Browser.setPermission` 和 `grantPermissions` 对 LNA 不起作用，11/05 在 headless 下也是这样。以后做自动化测试，要么用 UIA 点原生弹窗，要么预先写好站点设置。

## 过程问题（如实记录）

- **测试服务中途被误杀过一次。**第一轮用 `taskkill /T` 按进程树关 Chrome A 时，Node 测试服务也被一起杀了。推测是启动 Node 的那个 PowerShell 进程已经退出，它的 PID 被 Chrome 的子进程复用了，于是 Node 被算进了这棵树。当时 chrome-B 第一次的结果作废，重启服务后重测，上面的结论用的都是重测的数据。之后改成只按命令行里包含 `exp-pwa\` 的 PID 逐个结束进程，没有动本人的 Chrome/Edge。
- `shots/c07_app_menu.png` 是一次没打开菜单的尝试，可以忽略。菜单截图以 `c10_app_menu.png` 为准。

## 清理状态

- 我起的所有 chrome.exe / msedge.exe（按命令行里的 `exp-pwa\` 识别）和 Node 进程都已结束。端口 47631–47633 已不再监听。
- 两次 Chrome 安装都通过应用自己的「卸载」移除了。开始菜单、桌面快捷方式、HKCU 卸载项和测试前对比为零差异（`logs/os_before.txt` 对 `logs/os_final.txt`）。
- profile 目录 chrome-A/B/C、edge-G/G2 已删除。
- 没有提交 git，没有推送，也没有发任何消息。

## 文件

全部在 `C:\Users\10021\AppData\Local\Temp\claude\5412242dd0cafb0c\1e1fde7b-dbb6-4c7b-a0b3-c7c1a8e61db3\scratchpad\exp-pwa\` 下：

- 脚本：`server.mjs`、`page.html`、`cdp.mjs`、`shot.ps1`、`uia.ps1`、`keys.ps1`、`site-select.js`
- 日志：`logs/server.jsonl`（每次本机请求的 Origin/Host/结果）、`logs/os_*.txt`
- 截图：`shots/`
