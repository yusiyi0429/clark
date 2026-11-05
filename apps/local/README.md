# 天枢本机程序（apps/local）

装在每个人电脑上的小程序：只监听 `127.0.0.1:47610`，天枢网页直连它，它替本人拉起官方 Claude Code 干活，结果单向报给天枢云端。设计见 [RFC](../../docs/technical/local-runner/RFC.md)，接口见 `packages/contracts/src/localRunner.ts`，安装和排错见 [runbook](../../docs/guides/local-runner.md)。

## 快速上手

```bash
pnpm --filter @warmap/local test        # 单测（假 claude，不调模型）
pnpm --filter @warmap/local typecheck
pnpm --filter @warmap/local dev         # 用 tsx 跑，带 --dev：测试页 http://127.0.0.1:47610/dev
pnpm --filter @warmap/local build       # 用 Bun 编当前平台的单文件，产物在 dist/（要装 Bun ≥1.3，或用 BUN=路径 指定）
pnpm --filter @warmap/local build:all   # 编 Windows x64、macOS arm64/x64
```

测试页照契约直连本机 API，网页那边可以照着写：配对 → 添加文件夹 → 开工 → 看事件 → 插话 → 批权限 → 停下 → 强停。

冒烟测试命令（会真的调用 Claude，默认 haiku、提示词很短）：

```bash
# 先起本机程序（无托盘，自动通过配对，选文件夹直接用给定目录）
TIANSHU_LOCAL_AUTO_APPROVE=1 TIANSHU_LOCAL_PICK_FOLDER=/tmp/work ./dist/tianshu-local-windows-x64.exe run --headless --port 47660 --data-dir /tmp/tl-data
node scripts/smoke.mjs --port 47660
```

## 命令

```
tianshu-local [run] [--dev] [--headless] [--port N] [--data-dir DIR]   启动（默认）
tianshu-local autostart on|off|status                                  开机自启
tianshu-local version
```

只给开发和测试用的环境变量：`TIANSHU_LOCAL_HOME`（数据目录）、`TIANSHU_LOCAL_AUTO_APPROVE=1`（无托盘时自动通过配对）、`TIANSHU_LOCAL_PICK_FOLDER`（无托盘时选文件夹的结果）、`TIANSHU_LOCAL_PLAIN_SECRETS=1`（钥匙存明文文件）。

## 代码地图

| 文件 | 做什么 |
|-|-|
| `src/main.ts`、`src/app.ts` | 命令行入口；把各部分接起来、托盘菜单动作 |
| `src/http/server.ts`、`security.ts` | 路由；Host、Origin、口令、只收 JSON；SSE 补发；本会话 MCP 接口 |
| `src/pairing.ts` | 配对（本机弹框确认码）、口令只存哈希 |
| `src/sessions.ts` | 会话状态机、权限挂起、插话、停下、强停、续接、交产出物和交回、喂发件箱 |
| `src/agents/claudeCode.ts`、`claudeEnv.ts` | 拉起 Claude Code、参数、环境变量白名单、stream-json 归一化 |
| `src/agents/claudeSetup.ts` | 检测、安装、登录 Claude Code |
| `src/agents/codex.ts` | Codex 占位（12 月） |
| `src/eventLog.ts` | 每会话事件日志 |
| `src/outbox.ts` | 发件箱：落盘、退避重试、幂等键 |
| `src/models.ts`、`secrets.ts` | 模型配置；钥匙存 DPAPI / 钥匙串 |
| `src/desktop/` | 托盘和本机弹框（Windows：首次启动用系统自带 csc 编的 C# 小程序；Mac：osascript） |
| `src/autostart.ts` | HKCU Run / LaunchAgent |
| `scripts/` | 打包、冒烟、安装卸载脚本 |

源码只用 `node:` 标准库，测试在 Node 下跑，正式产物用 Bun 编（ADR 0028）。嵌入的脚本用 `String.raw` 写时要过 `embedded()`：Bun 打包会把中文改成 `\uXXXX`。
