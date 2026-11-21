# 天枢本机程序打包选型：Go + systray 与 Node SEA 实测（Windows）

日期 2026-11-06，机器 Windows 11 Home China 10.0.26300，x64，2560×1600。
目录 `C:\Users\10021\AppData\Local\Temp\claude\5412242dd0cafb0c\1e1fde7b-dbb6-4c7b-a0b3-c7c1a8e61db3\scratchpad\exp-pack\`（下文写作 `exp-pack\`）。

## 一句话结论

- **Go + fyne.io/systray**：在 Windows 上一个 7.2 MB 的 exe 就能做完全部要求（托盘、菜单、换图标和提示、HTTP 加 SSE、拉起 `claude`、HKCU Run），启动最快（中位数 89 ms），也不弹控制台。代价有两个：Mac 必须在 Mac 上编（需要 cgo）；不能复用 TypeBox，要靠代码生成或手写。
- **Node SEA**：HTTP、SSE、拉起子进程和内嵌资源都实测可用，冷启动 139 ms，能直接复用 TypeBox。但它有三个硬伤：
  1. 产物 92 MB（压缩后 33 MB）。
  2. 本身是控制台程序：从 Run 键或双击启动会弹出控制台窗口（已截图）。改 PE 头可以解决，已实测。
  3. 托盘必须另带一个辅助程序。
- 和 Bun `--compile` 比时，Node SEA 基本是同一类方案（JS 运行时整体塞进 exe），而 Bun 自带 `--windows-hide-console`、交叉编译也更顺。所以对 Node SEA 我的判断是「能用，但不如 Bun」。用不用 Go，取决于团队愿不愿意为了 7 MB、89 ms 和原生托盘，多维护一门语言和一套契约代码生成。

## 对比表

Bun 一列留给你填。测量工具 `exp-pack\tsbench.exe` 可以直接拿来测 Bun，口径一致（见文末）。

| 维度 | Go + fyne.io/systray | Node SEA（Node 24.15.0 + postject） | Bun --compile |
|---|---|---|---|
| 产物大小（Win x64） | **7.16 MB**（`-s -w -H windowsgui`），tgz 后 2.8 MB；win/arm64 6.5 MB | **91.8 MB**，tgz 后 32.6 MB；darwin-arm64 注入后 118.8 MB（tgz 36.0 MB） | |
| 冷启动到端口 LISTEN（5 次中位） | **88.7 ms**（109.5/85.4/85.9/98.1/88.7）·含托盘初始化 | **138.9 ms**（194.3/138.9/189.8/135.7/130.7）·不含托盘；参照：裸 `node main.cjs` 126.3 ms | |
| 空闲内存（启动后 10 s，5 次中位） | 工作集 **16.8 MB**，私有 46.9 MB | 工作集 **37.4 MB**，私有 21.2 MB（不含托盘辅助进程）；参照：裸 node 64.5 / 21.8 | |
| 托盘 | **进程内原生**：图标、提示、菜单、勾选项、换图标都已实测（截图）。菜单是经典 Win32 浅色菜单，不跟随深色模式；键盘 Apps 键打不开菜单 | **没有原生托盘**，要带辅助程序（见下文「Node 托盘包」），以 SEA asset 打进去、首次运行时释放再 spawn，原理可行 | |
| 开机自启 | HKCU Run 写入/删除已实测（未重启验证）；Mac LaunchAgent 代码已写，未在 Mac 上跑 | 同样写注册表即可（未单独实测）。**但必须先把 PE 子系统改成 GUI，否则开机会弹控制台窗口** | |
| 不弹控制台 | `-H windowsgui` 后 PE subsystem=2，无 conhost 子进程，MainWindowHandle=0 ✅ | 默认 subsystem=3 → **弹出控制台**（截图 `node-sea-console-window.png`）；改字节为 2 之后 /health、spawn 都正常，无窗口 ✅（非官方做法） | |
| spawn `claude` | `exec.Command("claude","--version")` + CREATE_NO_WINDOW → `2.1.318 (Claude Code)` | `execFile("claude",…)` → `2.1.318 (Claude Code)`；`cmd /c ver` 也能跑 | |
| 内嵌资源 | `//go:embed`（两张 ico） | SEA `assets` → `sea.getRawAsset()`，实测读到 17 B 文本和 540 B ico | |
| 复用 TypeBox | ❌ 不能直接用。要走 OpenAPI → oapi-codegen 或 JSON Schema → Go 生成，或手写 | ✅ 直接 import `@warmap/contracts`，esbuild 打进去，运行时用 TypeCompiler 校验 | |
| 长期维护（团队 TS） | 多一门语言；契约同步要靠生成加 CI diff；但代码量小、依赖少（systray + x/sys） | 同栈；但 SEA 仍是 Stability 1.1（active development）；`--build-sea` 要 Node ≥25.5，24 上得用 postject | |
| 交叉编译 | Windows→win/arm64 ✅；Windows→darwin ❌（systray 需 cgo：`CGO_ENABLED=0` 报 `undefined: nativeLoop…`，`=1` 报 `clang not found`）→ 必须在 Mac 上编 | 在 Windows 上往官方 darwin-arm64 node 注入成功（Mach-O 魔数 cffaedfe，fuse 已翻成 `:1`），但签名已坏，**必须在 Mac 上 `codesign --sign -`**（或用 rcodesign，未测），没在 Mac 上跑过 | |
| 签名 | 不签名在脚本安装下能跑（见下文）；正式发布建议 Authenticode；Mac 要 Developer ID + 公证 | 同左，另外 Mac 公证时 V8 要 JIT 相关 entitlements；Windows 注入前最好 `signtool remove /s`，注入后再签 | |
| 构建耗时（本机） | 首次 21 s（含编依赖），之后几秒 | esbuild 2 s + blob <1 s + postject **46 s**（90 MB 文件）；darwin 注入 13 s | |

## Go 原型

- 代码：`exp-pack\go-tray\main.go`、`exp-pack\go-tray\autostart_windows.go`、`exp-pack\go-tray\autostart_darwin.go`。
- 库选 **fyne.io/systray v1.12.2**（2026-06 发布），没选 getlantern/systray（最后一版 v1.2.2，2023-03）。理由：
  - fyne 版是 getlantern 的维护分支，还在发版。
  - Linux 改走 DBus，不再依赖 GTK。
  - Windows 下纯 Go，不需要 cgo。
  - API 和 getlantern 基本一样。
- 工具链：从 go.dev 下载 `go1.27.3.windows-amd64.zip`，sha256 和官网 JSON 一致，解压到 `exp-pack\toolchain\`。`GOPATH`、`GOCACHE`、`GOMODCACHE` 都指向 `exp-pack\`，只在单个进程里设置。
  - 注意：第一次调用 go 时，Go 往 `%APPDATA%\go\telemetry` 写了本地计数（Go 默认的 local 模式，不上传）。之后的命令都把 APPDATA 指到 `exp-pack\appdata`。这个目录是本次 01:49 新建的，测完已删除并确认不存在。
- 编译：`go build -trimpath -ldflags "-s -w -H windowsgui" -o out\tianshu-local-go.exe .`，产物 7,162,880 B。
- 实测结果：
  - `/health` → `{"go":"go1.27.3","ok":true,"paused":false,"pid":5740,"running":0,"runtime":"go","uptimeMs":2082}`。
  - `/events` SSE 每秒推一条 `event: status`，数据形如 `{"running":N,"seq":k}`。
  - `/spawn` → `{"ms":151,"ok":true,"out":"2.1.318 (Claude Code)"}`。
- 托盘证据（任务栏是自动隐藏的。用 Win+B、Enter 打开「^」溢出区，用 UI Automation 读按钮名，再截屏）：
  - `shots\go-tray-overflow-2-crop.png`：橙色「忙」图标，提示文字「天枢本机程序：正在跑 1 张卡」。UIA 读到的按钮名会随 tooltip 变化（正在跑 1/2/3 张卡）。
  - `shots\go-tray-menu-crop.png`：右键菜单「打开天枢 / 暂停全部 / ─ / 退出」。暂停全部被提示条挡住了一半，`go-tray-menu-2-crop.png` 是第二次截的图。
  - 点「暂停全部」后，`/health` 返回 `"paused":true`；`shots\go-tray-paused-crop.png` 里提示变成「天枢本机程序：已暂停」。
  - 点「退出」后进程结束，47641 端口不再监听（`go-tray-menu-quit-crop.png`）。
  - 「打开天枢」**没有点**。代码里用 `TS_OPEN_URL=about:blank` 覆盖了地址，实现是 `rundll32 url.dll,FileProtocolHandler`。
  - Win11 会在 `HKCU\Control Panel\NotifyIconSettings\16208140040264869502` 自动给这个 exe 建一条图标记录。这是系统自己的记账，我没动它。
- 不弹控制台：PE subsystem=2，没有 conhost 子进程，MainWindowHandle=0。
- HKCU Run 的命令和输出摘要：
  - 写入前 `reg query HKCU\...\Run /v TianshuLocalExp` 返回 not found。
  - 运行 `tianshu-local-go.exe install-autostart` 后，查到 `TianshuLocalExp REG_SZ "…\tianshu-local-go.exe"`。
  - 运行 `uninstall-autostart` 后又是 not found。`StartupApproved\Run` 里也没有这一项。
  - **注册表项已验证写入和删除，没有重启验证开机自启。**
- 强杀之后溢出区没有残留的幽灵图标（`shots\after-kill-overflow-crop.png`，Win11 会自动清理）。
- Mac 构建方案：
  - systray 的 darwin 实现是 `systray_darwin.m`（Objective-C），必须 `CGO_ENABLED=1` 并有 Xcode 的 clang 和 SDK。
  - 推荐用 GitHub Actions `macos-14`（arm64）runner：`GOARCH=arm64 CGO_ENABLED=1 go build`，同一台机器再跑 `GOARCH=amd64 CGO_ENABLED=1` 编 x86_64，然后 `lipo` 合成 universal，再 `codesign` 和 `notarytool`。
  - 注意 macOS runner 在私有仓库按 **10 倍**分钟计费，组织目前是 Free 档 2000 分钟。替代办法是在同事的 Mac 上手动编。
  - darwin/arm64 上 Go 链接器（包括 cgo 外部链接）会自动做 ad-hoc 签名，所以 curl 装上就能跑。

## Node SEA 原型

- 代码：`exp-pack\node-sea\src\main.ts`、`exp-pack\node-sea\sea-config.json`。esbuild 0.28.2 和 postject 1.0.0-alpha.6 装在 `exp-pack\node-sea\node_modules`，仓库没动。
- 构建步骤：
  1. `esbuild src/main.ts --bundle --platform=node --format=cjs --target=node24 --outfile=dist/main.cjs`，得到 3.4 KB。
  2. `node --experimental-sea-config sea-config.json`，得到 4 KB 的 blob。配置是 `useCodeCache/useSnapshot=false`、`disableExperimentalSEAWarning=true`，assets 有 `hello.txt` 和 `icon.ico`。
  3. 复制 `node.exe`，然后 `npx postject … NODE_SEA_BLOB … --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2`。postject 提示 `The signature seems corrupted!`，之后 `Get-AuthenticodeSignature` 显示 NotSigned（原来是 OpenJS 的 Valid 签名）。
- Node 24 **没有** `--build-sea`：`node --help` 里只有 `--experimental-sea-config`。官方文档说 `--build-sea` 从 **v25.5.0** 起才有，内部完成注入，可以用 `executable` 字段指定别的 node 二进制，`mainFormat: "module"` 支持 ESM 入口。
- 实测结果：
  - `/health` → `{"ok":true,"runtime":"node-sea","node":"v24.15.0",…,"asset":{"ok":true,"bytes":17,"text":"tianshu-asset-ok","sea":true},"icon":540}`。
  - `/spawn?cmd=claude` → `{"ok":true,"out":"2.1.318 (Claude Code)","ms":484}`。
  - SSE 正常，没有打印 SEA 实验警告。
- **控制台窗口**：PE subsystem=3。用 `Start-Process` 正常启动时，Windows Terminal 弹出了一个窗口，标签是 exe 路径，内容是 `listening 127.0.0.1:47642`（截图 `shots\node-sea-console-window.png`）。复制一份，用 `scripts\pe-subsystem.ps1 -Set 2` 把 subsystem 改成 2 之后：
  - `/health` 正常，`claude --version` 正常。
  - MainWindowHandle=0，没有子进程。
  - 写 stdout 也没有崩。
  - 这一步要放在注入之后、签名之前。这不是官方文档里的做法，属于「拿不准」。
- 不签名直接运行：本机 Smart App Control 是关的（`VerifiedAndReputablePolicyState=0`），文件也没有 MOTW，所以没有任何提示。

### Node 托盘包调查

几个包都只做了 `npm pack` 看内容，没有执行。

| 包 | 最近发布 | 原理 | Windows 辅助程序 | 能不能打进单文件 |
|---|---|---|---|---|
| `@trayjs/trayjs` 0.0.10 | 2026-02 | 每个平台一个原生小程序（Win32 C / ObjC / GTK），stdin/stdout **JSON-lines** 通信，按 optionalDependencies 分平台发包 | `tray.exe` **174 KB**，GUI 子系统，未签名 | 能：把 tray.exe 和 ico 放进 SEA assets，首次运行时写到 `%LOCALAPPDATA%\Tianshu\bin\` 再 spawn。它的 API 吃文件路径，图标也得落盘。版本还在 0.0.x，偏早期 |
| `systray2` 2.1.4 | 2022-01 | 自带 getlantern/systray 编译的 Go 程序（systray-portable），stdin/stdout JSON | `tray_windows_release.exe` 3.6 MB，**控制台子系统**，未签名 | 能（同样释放再 spawn），但已经停更 4 年 |
| `trayicon` 1.2.2 | 2022-05 | 自带 31 KB 的小 exe（**有签名**），只支持 Win32 | 31 KB | 能，但只有 Windows，Mac 用不了 |
| `node-tray` 2.0.5 | 2026-06 | **原生 addon**（node-gyp） | — | 很麻烦：要把 .node 作为 asset 写出来再 `process.dlopen`，还得为每个平台预编译 |
| `systray`（zaaack） | 2022-01 | systray2 的前身 | — | 不推荐 |

结论：Node 和 Bun 都要走「辅助托盘进程 + JSON-lines」这条路。

- 现成可选的有 trayjs（小、跨平台、但早期），或者**我们自己用 Go 写一个约 150 行的托盘辅助程序**。后者其实就是本原型的 onReady 部分，约 2–3 MB，Mac 上同样需要 cgo。
- 你在试的 PowerShell NotifyIcon 子进程只适用于 Windows，Mac 还得另做一套。
- 不管哪种，都等于多带一个需要签名的可执行文件。另外「exe 往磁盘释放另一个未签名 exe 再运行」是杀毒软件的典型启发式特征，两者都要签名。

## 签名与「不签名的影响」

**Windows**：

- 实测，下面这些方式下载的文件**都没有** `Zone.Identifier` 流（MOTW）：
  - PowerShell 7.6.9 的 `Invoke-WebRequest -OutFile`、`Invoke-RestMethod -OutFile`
  - Windows PowerShell 5.1.26100 的 `iwr`、`irm`、`Net.WebClient.DownloadFile`
  - `curl.exe -o`

  所以「一行命令安装」装到用户目录的 exe 不会触发 SmartScreen 的「Windows 已保护你的电脑」（SmartScreen 只检查带 MOTW 的文件）。
- 如果用户是**从浏览器下载** exe：带 MOTW，没签名或没信誉就会被 SmartScreen 拦，需要点「仍要运行」。
- **Smart App Control** 打开的机器（Win11 新装机可能默认是评估或开启状态），不管有没有 MOTW 都会拦未签名、无信誉的 exe。本机是关的，没有实测拦截。
- 正式发布建议上 Authenticode：
  - OV/EV 证书，或 Azure 托管签名服务（Trusted Signing / Artifact Signing，按月计费，价格和地区资格没查实）。
  - Node SEA 要在注入和改子系统之后再签。
  - Go 二进制偶尔会被杀毒软件误报，签名能显著缓解。本机没有出现检测记录。

**Mac**（查资料，没在 Mac 上测）：

- `curl` 下载的文件**不带** `com.apple.quarantine`。只有设置了 LSFileQuarantineEnabled 的应用（浏览器、聊天软件等）下载的文件才会带。所以 curl 安装不会经过 Gatekeeper 和公证检查。
- 但 Apple Silicon 要求可执行文件**至少有 ad-hoc 签名**才能运行：
  - Go 原生编译会自动签。
  - Node SEA 注入后签名就坏了，必须重新 `codesign --sign -`，官方文档就是这么写的。
  - 托盘辅助程序同样要签。
- 浏览器下载的文件会带 quarantine，没公证就会被拦（macOS 15 起不能再右键「打开」绕过，只能去「隐私与安全性」里放行）。
- 公证要 Developer ID（$99/年）和 hardened runtime。Node/Bun 这类带 V8/JSC JIT 的二进制还要 `com.apple.security.cs.allow-jit` 等 entitlements。
- macOS 13 起，新增 LaunchAgent 会弹「已添加后台项目」通知，显示的名字来自签名主体。

## 拿不准的点

1. Node SEA 改 PE subsystem 是非官方做法。Node 升级或 postject 变化后是否一直有效，需要在 CI 里加一个检查。Bun 的 `--windows-hide-console` 是官方开关。
2. Go 这边，「打开天枢」按实测要求没有真点。`rundll32 url.dll,FileProtocolHandler` 是常用写法，但没验证。
3. fyne systray 在 macOS 上作为裸可执行文件（不是 .app 包）跑时，会不会在 Dock 出现图标、能不能正常收菜单事件，没在 Mac 上验证。
4. 在 Windows 上注入的 darwin SEA 只做了静态检查，没在 Mac 上运行。rcodesign 能否在 Windows/Linux 上完成 ad-hoc 签名甚至公证，没有实测。
5. Windows 上有没有不需要 cgo 的 macOS 托盘 Go 库（比如基于 purego 调 ObjC），我没找到成熟的，所以按「Mac 托盘必须 cgo」处理。
6. 内存口径：Go 的「私有字节」46.9 MB 比工作集高，是 Go 运行时预先提交的堆，实际占用看工作集。Node SEA 没含托盘辅助进程：trayjs 大概再加几 MB，PowerShell NotifyIcon 估计几十 MB，这两项都没测。
7. 冷启动是在文件缓存已经热的情况下测的，不是重启后的第一次启动。
8. 第一次用 PowerShell `TcpClient.Connect` 轮询测出来是 540–1490 ms，数值是按约 500 ms 一档跳的。原因是 Windows 对被拒的连接会重试，这组数据作废了。改用 `tsbench`，它轮询系统 TCP 表，看端口进入 LISTEN 的时间。

## 用同一口径测 Bun

```powershell
& "C:\Users\10021\AppData\Local\Temp\claude\5412242dd0cafb0c\1e1fde7b-dbb6-4c7b-a0b3-c7c1a8e61db3\scratchpad\exp-pack\tsbench.exe" -port <端口> -runs 5 -idle 10 -- <bun 产物.exe>
```

它会输出每一次和中位数的 readyMs、wsMB、privMB，测完杀掉自己起的进程。源码在 `exp-pack\benchtool\main.go`。

## 清理状态（结束时核对）

- 本次起过的进程 PID 记在 `exp-pack\pids.txt`。核对时它们都不在了，也没有任何路径含 exp-pack 的进程。
- 47641 和 47642 都没有在监听。
- 溢出区里没有天枢图标（`shots\after-kill-overflow-crop.png`）。
- `reg query …\Run /v TianshuLocalExp` 返回 not found。
- `%APPDATA%\go` 已删除。
- 没有改 PATH 或持久环境变量，没有 git 操作。
- npm 的下载缓存（`%LOCALAPPDATA%\npm-cache`）里留有 esbuild、postject 和几个托盘包的 tarball，这是 npm 的正常缓存行为。

## 文件索引

- 结论：`exp-pack\结论.md`
- Go：`go-tray\`（源码、`out\tianshu-local-go.exe`、`out\tianshu-local-go-arm64.exe`）、`toolchain\go\`
- Node SEA：`node-sea\`（`dist\tianshu-local-node.exe` 是控制台版，`dist\tianshu-local-node-gui.exe` 是改过子系统的版本，`dist\tianshu-local-node-darwin-arm64` 是未签名的注入版）
- 测量：`tsbench.exe`、`bench-1.txt`
- 脚本：`scripts\pe-subsystem.ps1`、`scripts\tray-shot2.ps1`、`scripts\tray-click.ps1`
- 截图：`shots\*.png`（`-crop` 是右下角裁剪图）
- 托盘包：`tray-pkgs\`（只解包，没执行）
