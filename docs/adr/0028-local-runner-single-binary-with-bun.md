# 本机程序用 TypeScript 写、Bun 编成单文件，托盘用系统自带脚本宿主

2026-11-06 决定。适用于 `apps/local`（天枢本机程序）。

## 背景

本机程序每人都装，包括不写代码的同事：要单个可执行文件、一行命令装好、不另装 Node、开机自启、托盘有图标；Windows 先行，Mac 12 月，但选型时要确认 Mac 走得通。它的主要逻辑（拉起 Claude Code、归一化事件、会话、发件箱、HTTP 安全检查）都要和 `packages/contracts` 的 TypeBox 契约对齐，接手后端的同事熟悉 TypeScript。

## 比较（11/06 在 Windows 11 上实测，明细见 `.scratch/local-runner/实验/A_打包选型_Go与NodeSEA.md`）

| | Bun `--compile` | Go + fyne.io/systray | Node SEA（Node 24 + postject） |
|-|-|-|-|
| 产物（Win x64） | 112 MB（gzip 42 MB） | 7.2 MB（2.8 MB） | 91.8 MB（32.6 MB） |
| 启动到端口可用 | 约 0.2 s | 89 ms | 139 ms |
| 空闲工作集 | 约 155–165 MB，另加托盘助手约 30 MB | 16.8 MB（含托盘） | 37.4 MB（不含托盘） |
| 托盘 | 进程外：首次启动用 Windows 自带的 csc.exe 编一个约 10 KB 的 C# 托盘助手，实测图标、中文提示、换色、菜单、点击、确认框、选文件夹都通 | 进程内原生，实测通 | 要另带托盘辅助程序 |
| 不弹控制台 | `--windows-hide-console` | `-H windowsgui` | 默认弹，要改 PE 头（非官方） |
| 复用 TypeBox 契约 | 直接 import | 不能，要生成或手写 | 直接 import |
| 交叉编译 Mac | 在 Windows 上直接编出 darwin-arm64/x64，产物已带临时签名（Apple 芯片必需） | 托盘要 cgo，只能在 Mac 上编（CI 的 macOS runner 计费 10 倍） | 能注入，但签名坏了，要到 Mac 上重签 |
| 不签名能装吗 | `irm`/`iwr`/`curl` 下载的文件没有 Mark-of-the-Web，SmartScreen 不拦；Mac 上 curl 下载的没有隔离属性（Mac 未实测） | 同左 | 同左 |

## 决定

- 用 TypeScript 写，`bun build --compile` 编单文件；源码只用 `node:` 标准库，测试在 Node 下跑（vitest），所以日后换成 Node SEA 只改打包，不改代码。
- 托盘不打进主程序，用系统自带的东西：Windows 上主程序第一次启动时，用 .NET Framework 自带的 `csc.exe` 把嵌在程序里的 C# 源码（WinForms）编成约 10 KB 的托盘助手，放在数据目录的 `bin/` 里，源码一改自动重编；Mac 用 `osascript` 的 JXA 菜单栏。本机确认框和选文件夹框也走它们。不需要另下任何东西。
  - 最早用 PowerShell 宿主同一段逻辑，常驻约 100 MB；改成编好的小程序后约 30 MB（11/06 实测）。
- Mac 版在 12 月实测：JXA 菜单栏走不通就换成 CI 在 macOS 上编的小 Swift 助手，接口（stdin/stdout JSON 行）不变。

## 代价和后续

- **体积和内存偏大**：112 MB、空闲约 195 MB（主程序 155–165 MB + 托盘助手约 30 MB）。`--smol` 实测没有改善。主程序内存仍嫌大时，再评估换 Node SEA（工作集约 37 MB，但要处理控制台窗口和 Mac 重签）。
- Bun 打包会把中文字符串改写成 `\uXXXX`；`String.raw` 里的不会被还原，嵌入的脚本统一过 `embedded()` 还原（`src/store.ts`）。
- 正式发布前要 Windows Authenticode 签名、Mac Developer ID 签名和公证；这次没做。
