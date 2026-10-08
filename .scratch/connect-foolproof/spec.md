# 傻瓜式连接外部 Agent · Spec

Status: implemented（2026-09-30，未提交；测试与浏览器实测见对话记录）
日期：2026-09-30

## 背景

同事按「连接说明.md」让 Codex（macOS）设置每周五自动同步，遇到两个问题：crontab / launchctl 被 Codex 沙箱挡住，Agent 让用户自己去终端敲命令；`codex exec` 要求工作目录是 git 仓库。第一轮已改说明文案（沙箱外执行、macOS 用 LaunchAgent、`--skip-git-repo-check`、调度器触发验证），本 spec 处理剩下的「所有情况」。

目标：非技术同事只需要「下载说明 → 发给 Agent → 在批准弹窗里点允许」，其余由 Agent 完成；定时同步设不成也不会漏，天枢自己兜底；连没连上、同步没同步，用户在天枢里看得见。

覆盖范围（已确认）：Codex（桌面 App / IDE 插件 / 命令行）、Claude Code（任意形态）、Cursor / OpenCode 等其他远程 MCP 工具；Windows / macOS / Linux。

## 实测结论（Codex CLI 0.156.1，2026-09-30，本机假 MCP 服务）

| 项 | 结果 |
|---|---|
| `config.toml` 里 `http_headers = { Authorization = "Bearer …" }` | 请求带上令牌，不需要环境变量 |
| 非 git 目录 + `--skip-git-repo-check` | 可运行 |
| `codex exec` 默认调 MCP 工具 | 拒绝：「MCP tool call requires approval, but approval policy is never」——原说明里的定时同步写不进任何进展 |
| 服务上配 `default_tools_approval_mode = "approve"` | 工具调用成功 |

`codex mcp add` 没有写请求头的参数，所以 Codex 改由 Agent 直接追加 `config.toml`。

## 设计

### 1. 说明文件（`apps/web/src/lib/connectionGuide.ts`）

**Codex**：不再用环境变量 `TIANSHU_TOKEN`。Agent 在 `~/.codex/config.toml`（Windows：`%USERPROFILE%\.codex\config.toml`）追加：

```toml
[mcp_servers.tianshu]
url = "<endpoint>"
http_headers = { Authorization = "Bearer <token>" }
default_tools_approval_mode = "approve"
```

- 已有 `[mcp_servers.tianshu]` 时替换这一段，不动其他内容。
- 写入被沙箱挡住时申请在沙箱外执行，让用户点允许；不让用户自己去终端。
- 完成后请用户完全退出并重开 Codex 一次。
- 桌面 App、IDE 插件、命令行、定时任务读同一份配置，桌面 App 读不到 shell 配置、定时任务拿不到令牌的问题一并消失。
- 「手动设置」折叠区（`connectCommands("codex", …)`）改为给这段 TOML，不再给环境变量命令。

**Claude Code**：`claude mcp add --scope user` 不变；定时同步已用 `--allowedTools` 放行天枢工具。

**其他工具**：不变。能非交互运行就设定时任务，不能就靠第 3 节的提醒。

**定时同步**：保留第一轮的写法。验证改为：用调度器触发一次后，请用户回天枢「连接到外部工具」看这条连接是否显示本周已同步（第 2 节）；日志用于排错。定时脚本不再需要为令牌加载 shell 配置，只为 PATH 加载。

### 2. 连接状态可见

- 契约 `PersonalTokenView` 增加：
  - `lastUsedAt: string | null`（后端已有 `personal_tokens.last_used_at`）
  - `lastProgressAt: string | null`：该令牌最近一次写入 `task_progress` 的时间（`token_id` 关联）
- 连接对话框的连接列表每条显示：
  - 从未使用 →「等待连接」
  - 用过、没写过进展 →「已连上 · 最近使用 <月/日 时:分>」
  - 写过进展 →「最近同步 <月/日 时:分>」
- 生成令牌后、对话框未关闭期间，每 5 秒刷新一次列表，直到这条连接 `lastUsedAt` 非空。首次引导里的表单同样适用。
- 打开「每周五自动同步」时，有效期默认「不过期」；用户仍可改。关掉同步开关时默认回到 30 天。

### 3. 周五兜底提醒

- 不加定时任务、不加通知类型，读取时现算，放进成员首页数据（`MeHomeResponse`）：
  - 时间窗：本周五 18:00 起到周日 24:00（Asia/Shanghai）。
  - 条件：本人本周（周一 00:00 起，Asia/Shanghai）没有 `source IN ('codex','claude','other')` 的 `task_progress`。
  - 原因：
    - `no_connection`：没有未撤销且未过期的令牌 → 按钮「连接你的 Agent」，打开连接对话框
    - `not_synced`：有有效令牌但本周没写入 → 文案「对你的 Agent 说『同步本周进展』」，一键复制同步指令
- 不满足条件时字段为 `null`，首页不显示。
- 只有打开天枢才能看到；飞书推送不在本次范围。

## 不做

- 一键安装脚本（方案 B）
- 飞书 / 邮件推送
- 区分定时触发和手动触发的同步（只看进展是否真的写进来）
- CEO 角色的每周同步（CEO 工具只读）

## 验收

- `connectionGuide` 单测：Codex 说明含 `http_headers`、`default_tools_approval_mode = "approve"`，不含 `TIANSHU_TOKEN`；Claude / 其他工具不回退。
- API 测试：`lastUsedAt` / `lastProgressAt` 正确；提醒在无连接 / 有连接未写入 / 已写入三种状态下正确；周五 17:59 与 18:00、周一 00:00 边界正确；过期或撤销的令牌算「没有连接」。
- 浏览器实测：连接对话框在令牌首次被使用后自动变为「已连上」；首页提醒在两种原因下的文案和按钮。
