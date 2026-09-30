# 傻瓜式连接外部 Agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** 让非技术同事「下载说明 → 发给 Agent → 点允许」就能连上天枢；Codex 定时同步真的写得进去；连接与同步结果在天枢可见；周五没同步时天枢兜底提醒。

**Architecture:** 说明文件改为让 Codex 把令牌和工具放行写进 `config.toml`（实测过）；令牌视图加 `lastProgressAt`，连接表单生成后轮询直到连上；成员首页数据加读取时现算的 `weeklySync` 提醒，渲染成通知栏里的一张卡。

**Tech Stack:** TypeBox 契约 + openapi-typescript 生成客户端；Fastify + pg（`apps/api`）；Next.js + React（`apps/web`）；Vitest。

**Spec:** `.scratch/connect-foolproof/spec.md`

## Global Constraints

- 工作区已有大量未提交改动（含 `connectionGuide.ts` 里「月度复盘」一行、`openapi.json`、`schema.d.ts`），只在其上兼容修改，不回退。
- `apps/web/src/lib/api/openapi.json` / `schema.d.ts` 只能用 `pnpm --filter @warmap/web gen:client` 生成，不手改。
- 时区 Asia/Shanghai（无夏令时，按 UTC+8 计算）；「本周」从周一 00:00 起；提醒窗口周五 18:00 至周日 24:00。
- 计入「已同步」的进展来源：`codex`、`claude`、`other`（不含 `web`、`github`）。
- 不提交、不推送，除非用户要求。

---

### Task 1: 说明文件改用 Codex 配置写令牌与放行

**Files:**
- Modify: `apps/web/src/lib/connectionGuide.ts`
- Modify: `apps/web/src/components/ConnectAgentForm.tsx`（手动设置里 Codex 的提示行）
- Test: `apps/web/src/lib/connectionGuide.test.ts`

**Interfaces:**
- Produces: `codexConfig(endpoint: string, token: string): string`（TOML 片段）；`connectCommands("codex", …)` 返回一行 `{ label, value: codexConfig(...) }`。

- [x] **Step 1: 改测试**（Codex 用例）

```ts
expect(text).toContain("[mcp_servers.tianshu]");
expect(text).toContain('http_headers = { Authorization = "Bearer tsm_x" }');
expect(text).toContain('default_tools_approval_mode = "approve"');
expect(text).not.toContain("TIANSHU_TOKEN");
expect(text).toContain("codex exec --skip-git-repo-check");
expect(connectCommands("codex", "https://t.example/mcp/me", "tsm_x")[0].value).toContain("http_headers");
```
删掉旧断言 `SetEnvironmentVariable(...)` 和 `codex mcp add tianshu --url ...`；CEO 用例的 `codex mcp add tianshu` 改为 `[mcp_servers.tianshu]`。

- [x] **Step 2: 跑测试确认失败** — `pnpm --filter @warmap/web exec vitest run src/lib/connectionGuide.test.ts`，预期 FAIL。

- [x] **Step 3: 实现**

```ts
/** Codex 的天枢配置：令牌直接写请求头（桌面 App、IDE 插件、命令行、定时任务读同一份，不依赖环境变量）；
 *  放行天枢工具，否则无人值守的 codex exec 会拒绝调用 MCP 工具（2026-09-30 实测）。 */
export const codexConfig = (endpoint: string, token: string) => [
  "[mcp_servers.tianshu]",
  `url = "${endpoint}"`,
  `http_headers = { Authorization = "Bearer ${token}" }`,
  'default_tools_approval_mode = "approve"',
].join("\n");
```
`connectCommands` 的 codex 分支：
```ts
[{ label: "追加到 ~/.codex/config.toml（Windows：%USERPROFILE%\\.codex\\config.toml）", value: codexConfig(endpoint, token) }]
```
`connectionGuide` 的 codex 步骤：
```ts
"1. 在用户的 Codex 配置文件末尾追加下面这段（macOS / Linux：`~/.codex/config.toml`；Windows：`%USERPROFILE%\\.codex\\config.toml`；没有就新建）。已有 `[mcp_servers.tianshu]` 时只替换这一段，不动其他内容：",
"",
"```toml",
codexConfig(endpoint, token),
"```",
"",
"   令牌直接写在请求头里，Codex 的桌面 App、IDE 插件、命令行和定时任务都读这一份，不需要环境变量；`default_tools_approval_mode = \"approve\"` 只对天枢生效，让定时同步无人值守时也能调用天枢的工具。",
"   这个文件在工作目录之外，写入被沙箱挡住时，申请在沙箱外执行，让用户在批准弹窗里点允许；不要让用户自己去改文件。",
"2. 请用户完全退出并重新打开 Codex（桌面 App 要从菜单里退出，不只是关窗口）。",
```
定时同步段落：脚本那条去掉 `TIANSHU_TOKEN`，改为「终端里能找到的命令它可能找不到」；验证那条末尾加「再请用户打开天枢「账号菜单 → 连接到外部工具」，这条连接显示「最近同步」就说明写进了天枢」。
`ConnectAgentForm.tsx` 里 `存好环境变量后，重新打开终端再添加。` 改为 `保存后完全退出并重新打开 Codex。`

- [x] **Step 4: 跑测试确认通过**（同 Step 2 + `src/components/connectionDialog.test.tsx`）。

---

### Task 2: 连接状态可见（lastProgressAt、轮询、同步开关带动有效期）

**Files:**
- Modify: `packages/contracts/src/personalTokens.ts`
- Modify: `apps/api/src/personalTokens.ts`
- Regenerate: `apps/web/src/lib/api/openapi.json`、`schema.d.ts`
- Modify: `apps/web/src/components/ConnectAgentForm.tsx`、`apps/web/src/components/ConnectionDialog.tsx`
- Test: `apps/api/test/personalMcp.test.ts`（加断言）、`apps/web/src/components/connectionDialog.test.tsx`

**Interfaces:**
- Produces: `PersonalTokenView.lastProgressAt: string | null`；`connectionState(token: TokenView): string`（从 `ConnectAgentForm.tsx` 导出）；`ConnectAgentForm` 新 prop `onUpdated?: (view: TokenView) => void`。

- [x] **Step 1: API 测试**（`personalMcp.test.ts` 第一个用例，`append_progress` 之后）

```ts
const listedTokens = (await call(f, f.member, "GET", "/api/me/tokens")).json().tokens;
expect(listedTokens[0].lastUsedAt).not.toBeNull();
expect(listedTokens[0].lastProgressAt).not.toBeNull();
```
并在创建后立刻断言 `view.lastProgressAt` 为 `null`。

- [x] **Step 2: 跑 API 测试确认失败** — `pnpm --filter @warmap/api exec vitest run test/personalMcp.test.ts`。

- [x] **Step 3: 契约与 API**

契约 `PersonalTokenView` 加 `lastProgressAt: Type.Union([Type.String({ minLength: 1 }), Type.Null()])`。
`personalTokens.ts`：`Row` 加 `last_progress_at?: Date | null`；`view` 加 `lastProgressAt: row.last_progress_at?.toISOString() ?? null`；`listPersonalTokens` 改为
```sql
SELECT t.*, (SELECT max(p.created_at) FROM task_progress p WHERE p.token_id=t.id) AS last_progress_at
  FROM personal_tokens t WHERE t.person_id=$1 AND t.revoked_at IS NULL ORDER BY t.created_at DESC,t.id DESC
```
然后 `pnpm --filter @warmap/web gen:client`。

- [x] **Step 4: 跑 API 测试确认通过。**

- [x] **Step 5: Web 测试**（`connectionDialog.test.tsx`）：生成后 mock 第二次 `GET /api/me/tokens` 返回 `lastUsedAt` 非空，断言出现「已连上天枢」；列表里 `lastProgressAt` 非空时显示「最近同步」；成员表单默认有效期选中「不过期」，关掉同步开关后选中「30 天」。

- [x] **Step 6: 实现**

```ts
/** 连接列表与生成后的状态：写过进展 > 调通过 > 还没连。 */
export const connectionState = (token: TokenView) => token.lastProgressAt ? `最近同步 ${monthDayTime(token.lastProgressAt)}`
  : token.lastUsedAt ? `已连上 · 最近使用 ${monthDayTime(token.lastUsedAt)}` : "等待连接";
```
`ConnectAgentForm`：`expiresInDays` 初值 `role === "member" ? null : 30`；同步开关 `onClick` 同时 `setExpiresInDays(next ? null : 30)`；生成后 `useEffect` 每 5 秒 `GET /api/me/tokens`，找到同 id 的 view 就 `onUpdated?.(view)`，`lastUsedAt` 非空后停止并在「连接说明已生成」块里显示 `✓ 已连上天枢`，之前显示 `等待你的 Agent 连上…（连上后这里会自动变化）`；卸载、被撤销时停止。
`ConnectionDialog`：列表第二行改为 `到期 {expiryText(token.expiresAt)} · {connectionState(token)}`；给表单传 `onUpdated={(view) => setTokens((current) => current.map((item) => item.id === view.id ? view : item))}`。

- [x] **Step 7: 跑 Web 测试确认通过**，`pnpm --filter @warmap/web exec tsc --noEmit -p .`。

---

### Task 3: 周五兜底提醒

**Files:**
- Modify: `packages/contracts/src/tasks.ts`（`WeeklySyncReminder`、`MeHomeResponse.weeklySync`）
- Create: `apps/api/src/weeklySyncReminder.ts`
- Modify: `apps/api/src/routes/me.ts`
- Create: `apps/api/test/weeklySyncReminder.test.ts`
- Regenerate: web 客户端
- Create: `apps/web/src/components/member/weeklySyncNotice.ts`
- Modify: `apps/web/src/components/member/useMemberHome.ts`、`MemberWorkspace.tsx`
- Test: `apps/web/src/components/member/weeklySyncNotice.test.ts`

**Interfaces:**
- Consumes: `SYNC_INSTRUCTION`（`@/lib/connectionGuide`）、`openConnectionDialog`（`@/components/monthlyReview/personalReviewApi`）
- Produces: `readWeeklySyncReminder(q: Query, personId: string, now: Date): Promise<TWeeklySyncReminder | null>`；`weeklySyncNotices(reminder: WeeklySyncReminder | null): ActionNotice[]`；`useMemberHome().weeklySync`。

- [x] **Step 1: API 测试**

```ts
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { call, executionFixture, newTask } from "./executionFixture.js";

const home = async (f: Awaited<ReturnType<typeof executionFixture>>) => (await call(f, f.member, "GET", "/api/me/home")).json().weeklySync;

describe("周五兜底提醒", () => {
  it("周五 18:00 起、本周没有外部 Agent 进展才提醒，并区分有没有连接", async () => {
    const f = await executionFixture();
    try {
      f.setNow(new Date("2026-10-09T09:59:00Z")); // 周五 17:59
      expect(await home(f)).toBeNull();
      f.setNow(new Date("2026-10-09T10:00:00Z")); // 周五 18:00
      expect(await home(f)).toEqual({ reason: "no_connection" });
      const { token, view } = (await call(f, f.member, "POST", "/api/me/tokens", { name: "笔记本", client: "codex", expiresInDays: 30 })).json();
      expect(await home(f)).toEqual({ reason: "not_synced" });
      const task = (await call(f, f.member, "POST", "/api/me/tasks", newTask())).json();
      await call(f, f.member, "POST", `/api/me/tasks/${task.id}/progress`, { clientEventId: randomUUID(), body: "网页写的" });
      await f.t.sql("UPDATE task_progress SET created_at=$1", ["2026-10-08T00:00:00Z"]);
      expect(await home(f)).toEqual({ reason: "not_synced" }); // web 来源不算
      const sent = await f.t.app.inject({ method: "POST", url: "/mcp/me", headers: { authorization: `Bearer ${token}`, accept: "application/json, text/event-stream" },
        payload: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "append_progress", arguments: { itemId: task.id, body: "Agent 同步" } } } });
      expect(sent.statusCode).toBe(200);
      await f.t.sql("UPDATE task_progress SET created_at=$1 WHERE source='codex'", ["2026-10-04T15:59:00Z"]); // 上周日 23:59
      expect(await home(f)).toEqual({ reason: "not_synced" });
      await f.t.sql("UPDATE task_progress SET created_at=$1 WHERE source='codex'", ["2026-10-04T16:00:00Z"]); // 本周一 00:00
      expect(await home(f)).toBeNull();
      await f.t.sql("DELETE FROM task_progress WHERE source='codex'");
      await f.t.sql("UPDATE personal_tokens SET expires_at=$2 WHERE id=$1", [view.id, "2026-10-09T09:00:00Z"]);
      expect(await home(f)).toEqual({ reason: "no_connection" }); // 过期算没有连接
      f.setNow(new Date("2026-10-11T15:59:00Z")); // 周日 23:59
      expect(await home(f)).toEqual({ reason: "no_connection" });
      f.setNow(new Date("2026-10-11T16:00:00Z")); // 下周一 00:00
      expect(await home(f)).toBeNull();
    } finally { await f.t.close(); }
  });
});
```

- [x] **Step 2: 跑测试确认失败** — `pnpm --filter @warmap/api exec vitest run test/weeklySyncReminder.test.ts`。

- [x] **Step 3: 契约与实现**

契约（`tasks.ts`）：
```ts
/** 周五 18:00 到周日结束，本周没有外部 Agent 写入的进展时提醒；no_connection 没有有效连接，not_synced 连了但没同步。 */
export const WeeklySyncReminder = Type.Object({ reason: Type.Union([Type.Literal("no_connection"), Type.Literal("not_synced")]) }, { additionalProperties: false });
```
`MeHomeResponse` 加 `weeklySync: Type.Union([WeeklySyncReminder, Type.Null()])`，导出 `TWeeklySyncReminder`，并在 `openapi.ts` 的 components 注册 `WeeklySyncReminder`。

`apps/api/src/weeklySyncReminder.ts`：
```ts
import type { TWeeklySyncReminder } from "@warmap/contracts";
import type { Query } from "./meetingStore.js";

const OFFSET = 8 * 3_600_000; // Asia/Shanghai，无夏令时

/** 读取时现算，不存通知：周五 18:00 到周日结束，本周（周一 00:00 起）没有来自外部 Agent 的进展就提醒。 */
export async function readWeeklySyncReminder(q: Query, personId: string, now: Date): Promise<TWeeklySyncReminder | null> {
  const local = new Date(now.getTime() + OFFSET);
  const day = local.getUTCDay();
  if (!(day === 6 || day === 0 || day === 5 && local.getUTCHours() >= 18)) return null;
  const weekStart = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() - (day + 6) % 7) - OFFSET);
  const synced = (await q("SELECT 1 FROM task_progress WHERE author_id=$1 AND source IN ('codex','claude','other') AND created_at>=$2 LIMIT 1", [personId, weekStart])).rows.length > 0;
  if (synced) return null;
  const connected = (await q("SELECT 1 FROM personal_tokens WHERE person_id=$1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>$2) LIMIT 1", [personId, now])).rows.length > 0;
  return { reason: connected ? "not_synced" : "no_connection" };
}
```
`routes/me.ts` 的 `/api/me/home`：`Promise.all` 加 `readWeeklySyncReminder(q, req.person!.personId, ctx.now())`，返回 `{ myTasks, work, radar, weeklySync }`。然后 `gen:client`。

- [x] **Step 4: 跑 API 测试确认通过**，并跑 `test/memberHome.test.ts`（整体比对首页响应的断言补上 `weeklySync`）。

- [x] **Step 5: Web 测试**（`weeklySyncNotice.test.ts`）

```ts
import { describe, expect, it, vi } from "vitest";
import { weeklySyncNotices } from "./weeklySyncNotice";

describe("周五兜底提醒卡", () => {
  it("没有提醒时为空", () => expect(weeklySyncNotices(null)).toEqual([]));
  it("没连接：按钮打开连接对话框", async () => {
    const listener = vi.fn();
    window.addEventListener("open-connection-dialog", listener);
    const [notice] = weeklySyncNotices({ reason: "no_connection" });
    expect(notice.title).toContain("连接你的 Agent");
    await notice.buttons[0].run();
    expect(listener).toHaveBeenCalled();
  });
  it("没同步：按钮复制同步指令", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    const [notice] = weeklySyncNotices({ reason: "not_synced" });
    expect(notice.detail).toContain("同步本周进展");
    expect(await notice.buttons[0].run()).toEqual({ ok: true, settled: "已复制同步指令" });
    expect(writeText).toHaveBeenCalled();
  });
});
```

- [x] **Step 6: 实现**

```ts
import type { components } from "@/lib/api/schema";
import type { ActionNotice } from "@/components/ActionNoticeCard";
import { openConnectionDialog } from "@/components/monthlyReview/personalReviewApi";
import { SYNC_INSTRUCTION } from "@/lib/connectionGuide";

type Reminder = components["schemas"]["WeeklySyncReminder"];

/** 周五兜底：服务端判断本周没同步，这里只负责文案和一步操作。 */
export function weeklySyncNotices(reminder: Reminder | null): ActionNotice[] {
  if (!reminder) return [];
  return [reminder.reason === "no_connection" ? {
    id: "weekly-sync", tone: "amber", title: "本周进展还没同步：先连接你的 Agent",
    detail: "连上 Codex、Claude Code 等工具后，它每周五会把你的进展写进天枢。",
    buttons: [{ label: "连接你的 Agent", emphasis: true, run: async () => { openConnectionDialog(); return { ok: true }; } }],
  } : {
    id: "weekly-sync", tone: "amber", title: "本周进展还没同步",
    detail: "对你的 Agent 说「同步本周进展」，或复制下面的指令发给它。",
    buttons: [{ label: "复制同步指令", emphasis: true, run: async () => {
      try { await navigator.clipboard.writeText(SYNC_INSTRUCTION); return { ok: true, settled: "已复制同步指令" }; }
      catch { return { ok: false, error: "复制失败，请在「连接到外部工具」里手动复制" }; }
    } }],
  }];
}
```
`useMemberHome`：加 `const [weeklySync, setWeeklySync] = useState<WeeklySyncReminder | null>(null)`，在 `home.data` 分支 `setWeeklySync(home.data.weeklySync ?? null)`，返回值带上 `weeklySync`。
`MemberWorkspace`：在 `<CycleCountdown />` 之后加
```tsx
<ActionNoticeCard id="weekly-sync" title="每周同步" mark="meeting" notices={weeklySyncNotices(home.weeklySync)} onSettled={() => undefined} />
```
「暂时没有新通知」的计数加上 `(home.weeklySync ? 1 : 0)`。

- [x] **Step 7: 跑 Web 测试与类型检查**；浏览器实测（成员登录，周五 18:00 后或临时改时钟）两种文案与按钮，截图。

---

## 收尾

- [x] 消融检查：逐项确认新增字段 / 分支都在服务验收；删掉不需要的。
- [x] 全量相关测试：`pnpm --filter @warmap/api exec vitest run test/personalMcp.test.ts test/weeklySyncReminder.test.ts test/memberHome.test.ts`；`pnpm --filter @warmap/web exec vitest run src/lib/connectionGuide.test.ts src/components src/components/member`；两边 `tsc --noEmit`。
- [x] 更新 spec 的 Status，向用户交付说明。
