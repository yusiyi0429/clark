# 抓取信号落地正式版（下半）：收件端点与待挑信号列表页实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在正式版上装出「抓取作业投进来的过线信号」这一层：一个受口令保护的幂等收件端点、数据层里一个有上限的集合、一个三键处置的列表页，其中「开成议题」就是拿这条原文去跑现有的 A1a。

**Architecture:** 薄、且只有一条方向。作业（`tkos-lab/scripts/catch.py`）POST 过来，`POST /api/signals/inbox` 按 `dedupe_key` 幂等落库，列表页读未处置的那些。跨仓库契约的这一半是一个纯函数（`src/lib/data/inbox.ts` 的 `parseInboxPayload`），单测钉住它，因为另一半在另一个仓库里（`src/tkos_lab/deliver.py`）。**正式版这一侧不做任何研判**：分数、理由、建议议题方向都是作业那边算完的，这边只展示与排序。

**Tech Stack:** TypeScript 5.9 / Next.js 16.3 App Router（`src/proxy.ts` 是访问门）/ vitest（node 环境，只测纯函数与数据层）/ 无新依赖。

## Global Constraints

- **不改 A1a。** `src/lib/agent/a1a/{run,apply,prompt}.ts` 与 `prompts/engineering/a1a.*.md` 一个字不动。`runA1a` 的 `A1aInput.cardId` 只进类型不进函数体（锚点是 `openContext("S01", input.headline)` 拿 headline 去查的），所以待挑的信号原样喂得进去。
- **不改提请台。** `store.cards` / `api.listPending` / `api.disposeCard` / `digest-view.tsx` 的卡片区一概不动，只在 `PanelHead` 的 `actions` 里加一个入口链接。
- **`prompts/cognitive/` 里不放 catching 的认知段。** 策略正文只在实验台一处（见 `docs/superpowers/specs/2026-08-19-catching-signal-rollout-design.md` §5 与 `prompts/cognitive/README.md` 的「引，不要抄」）。本计划不新建任何 prompt 文件。
- **不在这一侧再加一层准入过滤**（rollout §9）。作业给什么就收什么、就显示什么。分数只用来排序，不用来筛。
- 口令只走环境变量 `OPERATOR_TOKEN`（已在 `.env.example` / `.env.docker.example` / `docker-compose.yml` 里）。不进代码、不进日志、不进任何 HTTP 响应体。
- `TKOS_SEED_FROZEN` 那套约束照旧（见 `docs/03_MVP上线与运维须知.md` §1①）：新集合初值为空、不进 `SEED_FINGERPRINT`（它只哈希数据集身份，见 `store.ts` 上那段注释）。**别往种子里塞示例信号** —— 塞了就得进指纹，进了指纹就等于「改一条示例文案会抹掉线上数据」。
- 数据层新增的模块级写入口一律写成 **`function` 声明**，理由见 `store.ts` 里 `agentRunPut` 上那段注释（`store → a3/run → harness → graphknowledge/index → snapshot → store` 这个 import 环上，箭头函数会拿到未初始化的绑定，模块初始化期就炸，而类型完全合法）。
- 写方法只有处置那一个上 `api`（浏览器要点它）；收件与写回结果的入口**不上 `api`** —— `api` 的每个键都在 `POST /api/data` 的白名单里，上了就等于允许浏览器往列表里塞任意信号。
- 验证只有三样，`next build` / `next dev` 在这个环境里跑不起来：
  - `npx tsc --noEmit`
  - `npx eslint <改过的文件>`（`npx eslint .` 会超时）
  - `npx vitest run <测试文件>`
- **这个 worktree 里没有 `node_modules`**（它在仓库根上，`.claude/worktrees/` 往上两级）。
  上面三条命令照样跑得通 —— `npx` 与 TS 的模块解析都会往父目录找。**别在这里
  `pnpm install`**：装出来的是第二份依赖，而 `.next/` 仍然不会有。
- **`npx tsc --noEmit` 的基线是 8 条错，不是 0 条。** 全部是 `Cannot find name 'PageProps'` / `'LayoutProps'`，来自 `.next/types` 没生成（typegen 要 `next dev` 或 `next build`）。只看**新增**的错：
  ```
  src/app/(tkos)/decisions/[id]/page.tsx(4,55)   src/app/(tkos)/docs/[id]/page.tsx(3,51)
  src/app/(tkos)/issues/[id]/brief/page.tsx(8,57) src/app/(tkos)/issues/[id]/page.tsx(14,4)
  src/app/(tkos)/judgments/[id]/page.tsx(7,56)   src/app/(tkos)/layout.tsx(9,50)
  src/app/(tkos)/meetings/page.tsx(10,62)        src/app/layout.tsx(53,50)
  ```
  新页面不需要参数，**别给它写 `PageProps`**，照 `src/app/(tkos)/signals-log/page.tsx` 那样三行了事。
- 屏幕上的话不许失真：不编分母、不写「正在全网抓取」。可说的事实是「作业上一轮扫回来 N 条，还没有人挑」。

## 与 spec 的六处收敛（都是有意的，执行时按这里写的做）

1. **命名只留一套：代码里一律 `inbox`。** 类型 `InboxSignal`、集合 `store.inboxSignals`、页面 `/signals-inbox`、视图 `signals-inbox-view.tsx`。spec §5 管这个对象叫「待挑的信号」，端点路径又是 `/api/signals/inbox`；两套词里取端点那个，因为它是跨仓库契约里定死的、改不了。**屏幕上的话仍然是「待挑的信号」** —— 界面上不出现 inbox 这个词。

2. **幂等更新的字段比 spec 列的多。** spec §5 只说「已存在的键更新 `score` 与 `why`」。实际要更新的是同一次研判的**全部产物**：`score` / `dimensions` / `kiq` / `why` / `suggestedIssue` / `text` / `publishedAt` / `runId` / `scannedAt`。只更一半会让屏幕上分数是新的、理由是旧的，而这两样恰好要一起读。**不更新的是** `receivedAt` 与三个处置字段 —— 一号位已经挑过的东西，不能因为下一轮扫描又冒回列表里。

3. **`/api/signals/inbox` 必须进 `src/proxy.ts` 的 `PUBLIC_PATHS`。** 那个文件是全站访问门：任何 `/api/*` 没有访问 cookie 就直接 401。作业是机器，没有 cookie，所以不加这一条的话，它带着**完全正确**的口令也只会拿到 `{"error":"unauthorized"}` —— 而那句话看起来就像口令配错了，能查很久。加进去不等于「公开」：这条路自己有 `x-operator-token` 那道门。

4. **「开成议题」走独立 route，不复用 `POST /api/agent/a1a`，也不调 `applyA1aResult`。** 现有那条按 `cardId` 取输入（`agentSignalInput` 要求这条信号已经是提请台里的一张卡、且挂在某个议题下），待挑的信号两样都没有。而 `applyA1aResult` 的 `new_issue` / `update_issue` 两条至今抛 `NotWiredYet`，`ignore` 那条会去 `markCardAgentVerdict` 一张不存在的卡。这条链路的写回就是把 A1a 的结论记在这条信号上。

5. **处置立刻记下来，不等 A1a 跑完。** 「他挑了这一条」是这条链路真正要留的数据（rollout §7：处置是阈值的免费标注），跟 A1a 这次跑成没跑成是两件事。A1a 的结果另记在 `judged` 里。

6. **上限满了先丢已处置的。** 已处置的丢完还超，才丢未处置的**并且 warn 一声**：一条一号位还没看过的信号被静默丢掉，从屏幕上看不出任何区别（这一页本来就只是「机器捞回来的一批」，少一条谁也不知道），而它恰好是这条链路唯一的产出。

## 文件结构

| 文件 | 职责 |
|---|---|
| `src/lib/data/types.ts` | 改：`InboxSignal` / `InboxSignalInput` / `InboxDisposition` 三个类型 |
| `src/lib/data/inbox.ts` | 新：跨仓库契约的这一半 —— 蛇形转驼峰、形状校验、正文截断、上限淘汰。纯函数，不碰 store |
| `src/lib/data/inbox.test.ts` | 新：钉住上面那三件事 |
| `src/lib/data/store.ts` | 改：`inboxSignals` 集合、`MAX_INBOX_SIGNALS`、四个模块级出口、`api` 上两个方法 |
| `src/lib/data/inbox-signals.test.ts` | 新：幂等落库、处置、写回结果、列表排序 |
| `src/lib/data/client.ts` | 改：两条 `forward(...)`。少一条 `tsc` 直接红 |
| `src/app/api/signals/inbox/route.ts` | 新：收件端点。口令门 + 解析 + 落库，别的什么都不做 |
| `src/proxy.ts` | 改：`PUBLIC_PATHS` 加收件端点 |
| `src/app/api/agent/a1a/inbox/route.ts` | 新：「开成议题」的触发与轮询 |
| `src/app/(tkos)/signals-inbox/page.tsx` | 新：三行的页面壳 |
| `src/app/_views/signals-inbox-view.tsx` | 新：列表页本体，三键处置 |
| `src/app/_views/digest-view.tsx` | 改：`PanelHead.actions` 里加一个入口（有货才出现） |
| `src/app/_views/home-view.tsx` | 改：`RadarPanel` 上那句「自动抓取还没接」现在是假话了，改掉 |
| `.env.example` / `.env.docker.example` | 改：`OPERATOR_TOKEN` 那条注释「本版封存」现在是假话了 |
| `docs/03_MVP上线与运维须知.md` | 改：环境变量表、口子一节、已知空档各加一条 |

**依赖顺序：** Task 1 → Task 2 → Task 3；Task 2 → Task 4 → Task 5。Task 3 与 Task 4/5 之间没有依赖，可以并行。全部完成之后才配作业那边的 `TKOS_INBOX_URL`（见最后一节）。

---

### Task 1: 跨仓库契约的这一半 —— 解析、截断、淘汰

**Files:**
- Modify: `src/lib/data/types.ts`（在文件末尾 `CardAgentVerdict` 之后追加）
- Create: `src/lib/data/inbox.ts`
- Test: `src/lib/data/inbox.test.ts`

**Interfaces:**
- Consumes: 无（这个任务不 import 数据层的任何东西，只 import 自己的类型）。
- Produces:
  - `type InboxDisposition = "issue" | "watch" | "dismiss"`
  - `interface InboxSignalInput`（契约里那 15 个字段，驼峰）
  - `interface InboxSignal extends InboxSignalInput`（多 `receivedAt` / `disposedAs?` / `disposedAt?` / `judged?`）
  - `const INBOX_TEXT_MAX = 2000`
  - `type InboxParse = { ok: true; runId: string; scannedAt: string; signals: InboxSignalInput[] } | { ok: false; error: string }`
  - `function parseInboxPayload(body: unknown): InboxParse`
  - `function inboxEvictees(signals: InboxSignal[], cap: number): InboxSignal[]`

- [ ] **Step 1: 追加三个类型**

`src/lib/data/types.ts` 末尾（`CardAgentVerdict` 那一段之后）加：

```ts
/**
 * 待挑的信号：抓取作业（`tkos-lab/scripts/catch.py`）投进来的一条过线信号。
 *
 * 和 `Card` 分开：卡是**已经进了提请台**的东西，一号位对它的每一次点击都落成组织
 * 动作；这一批是「机器觉得值得看，还没有人挑过」。混进 `cards` 之后，首屏那几张
 * 卡里会混着没人看过的机器产出 —— 而提请台的克制正是它的全部价值。
 *
 * 字段是跨仓库契约（rollout design §4.3）的驼峰版。蛇形转驼峰只在
 * `src/lib/data/inbox.ts` 里发生一次。**这一侧不做任何研判**：score / dimensions /
 * kiq / why / suggestedIssue 全是作业那边算完的，这里只展示与排序。
 */
export interface InboxSignalInput {
  /** 幂等键 = 归一化后的 URL（去 utm 与 fragment）。作业那边由 `sources.normalize_url` 算。 */
  dedupeKey: string;
  title: string;
  url: string;
  /** 正文或摘要，作业那边抽的。这边不再加工，只截长度。 */
  text: string;
  /** ISO 8601。源里抓不到就是空串 —— 空串照样收，不猜一个时间填上去。 */
  publishedAt: string;
  /** 源的备注名或域名 */
  source: string;
  origin: "pinned" | "discovered";
  /** 1–5，作业那边按 rubric 打的。**区间不在这边校验**（见 inbox.ts 里的注释）。 */
  score: number;
  dimensions: Record<string, number>;
  /** 命中的关键情报问题编号，例如 `KIQ2.2`。它是「为什么值得看」的可追溯锚。 */
  kiq: string;
  why: string;
  suggestedIssue: string;
  /** 产出它的那次扫描（实验台 Run 的 id）。追「线上跑的是哪套参数」从这里进。 */
  runId: string;
  scannedAt: string;
}

/** 一号位对一条待挑信号做的处置。`issue` = 开成议题（去跑 A1a）。 */
export type InboxDisposition = "issue" | "watch" | "dismiss";

export interface InboxSignal extends InboxSignalInput {
  /** 收件时间。同一个 `dedupeKey` 再来一次**不改**它。 */
  receivedAt: string;
  /** 空 = 还在等他挑。**v1 只记不读**（rollout §7：处置是阈值的免费标注，读它是 v2 的事）。 */
  disposedAs?: InboxDisposition;
  disposedAt?: string;
  /**
   * 「开成议题」那一下的结果。和处置分开存：处置是他的动作，这个是 A1a 的结论，
   * A1a 跑挂了不该让「他挑过这一条」这件事跟着消失。
   */
  judged?: {
    runId: string;
    status: AgentRunRecord["status"];
    route?: AgentRunRecord["route"];
    at: string;
  };
}
```

- [ ] **Step 2: 写失败的测试**

`src/lib/data/inbox.test.ts`：

```ts
/**
 * 跨仓库契约的这一半。另一半是 `tkos-lab/src/tkos_lab/deliver.py` 的
 * `build_payload`，**改它要同时改两处** —— 两边各有测试钉住同一个形状。
 */
import { describe, expect, it } from "vitest";

import { INBOX_TEXT_MAX, inboxEvictees, parseInboxPayload } from "./inbox";
import type { InboxSignal } from "./types";

const sig = (over: Record<string, unknown> = {}) => ({
  dedupe_key: "https://a.com/x",
  title: "大厂把 To B 的销售与交付合并成行业线",
  url: "https://a.com/x?utm_source=w",
  text: "正文",
  published_at: "2026-08-18T02:00:00Z",
  source: "36氪·AI",
  origin: "pinned",
  score: 4.2,
  dimensions: { materiality: 4, novelty: 3 },
  kiq: "KIQ2.2",
  why: "它指向采购决策权的转移。",
  suggested_issue: "入口移到交付侧之后我们的差异还剩多少",
  ...over,
});

const payload = (signals: unknown[]) => ({
  run_id: "RUN-7",
  scanned_at: "2026-08-19T07:00:00Z",
  signals,
});

describe("parseInboxPayload", () => {
  it("蛇形转驼峰，一条不丢", () => {
    const got = parseInboxPayload(payload([sig()]));
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    expect(got.runId).toBe("RUN-7");
    expect(got.scannedAt).toBe("2026-08-19T07:00:00Z");
    expect(got.signals[0]).toEqual({
      dedupeKey: "https://a.com/x",
      title: "大厂把 To B 的销售与交付合并成行业线",
      url: "https://a.com/x?utm_source=w",
      text: "正文",
      publishedAt: "2026-08-18T02:00:00Z",
      source: "36氪·AI",
      origin: "pinned",
      score: 4.2,
      dimensions: { materiality: 4, novelty: 3 },
      kiq: "KIQ2.2",
      why: "它指向采购决策权的转移。",
      suggestedIssue: "入口移到交付侧之后我们的差异还剩多少",
      runId: "RUN-7",
      scannedAt: "2026-08-19T07:00:00Z",
    });
  });

  it("空批次是合法的 —— 这一轮什么都没过线也要能回话", () => {
    const got = parseInboxPayload(payload([]));
    expect(got).toEqual({ ok: true, runId: "RUN-7", scannedAt: "2026-08-19T07:00:00Z", signals: [] });
  });

  it("身份字段缺了整批拒收，并且点名是第几条的哪个字段", () => {
    const got = parseInboxPayload(payload([sig(), sig({ dedupe_key: "  " })]));
    expect(got.ok).toBe(false);
    if (got.ok) return;
    expect(got.error).toContain("signals[1].dedupe_key");
  });

  it("分数不是数就拒 —— 它是排序键，NaN 会让整页顺序变成随机", () => {
    const got = parseInboxPayload(payload([sig({ score: "4.2" })]));
    expect(got.ok).toBe(false);
    if (got.ok) return;
    expect(got.error).toContain("signals[0].score");
  });

  it("只用来显示的字段缺了填空串，不拒收", () => {
    const got = parseInboxPayload(payload([sig({ why: undefined, kiq: undefined, text: undefined })]));
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    expect(got.signals[0].why).toBe("");
    expect(got.signals[0].kiq).toBe("");
    expect(got.signals[0].text).toBe("");
  });

  it("dimensions 缺了当空对象；值不是数就点名那个维度", () => {
    const a = parseInboxPayload(payload([sig({ dimensions: null })]));
    expect(a.ok).toBe(true);
    if (a.ok) expect(a.signals[0].dimensions).toEqual({});

    const b = parseInboxPayload(payload([sig({ dimensions: { materiality: "高" } })]));
    expect(b.ok).toBe(false);
    if (!b.ok) expect(b.error).toContain("signals[0].dimensions.materiality");
  });

  it("origin 只认两个值", () => {
    const got = parseInboxPayload(payload([sig({ origin: "manual" })]));
    expect(got.ok).toBe(false);
    if (got.ok) return;
    expect(got.error).toContain("signals[0].origin");
    expect(got.error).toContain("manual");
  });

  it("正文截断 —— 落盘是整个 store 重写一遍，全文进来会把每一次写盘都拖长", () => {
    const got = parseInboxPayload(payload([sig({ text: "字".repeat(INBOX_TEXT_MAX + 500) })]));
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    expect(got.signals[0].text.length).toBe(INBOX_TEXT_MAX + 1);
    expect(got.signals[0].text.endsWith("…")).toBe(true);
  });

  it("不是对象、signals 不是数组、run_id 空 —— 三种都拒，话说清楚是哪一样", () => {
    expect(parseInboxPayload(null)).toEqual({ ok: false, error: "请求体不是一个对象。" });
    const a = parseInboxPayload({ run_id: "R", scanned_at: "T", signals: {} });
    if (!a.ok) expect(a.error).toContain("signals 不是数组");
    const b = parseInboxPayload(payload([]));
    expect(b.ok).toBe(true);
    const c = parseInboxPayload({ run_id: "", scanned_at: "T", signals: [] });
    if (!c.ok) expect(c.error).toContain("run_id");
  });
});

const stored = (key: string, at: string, disposed?: boolean): InboxSignal => ({
  dedupeKey: key,
  title: key,
  url: `https://a.com/${key}`,
  text: "",
  publishedAt: "",
  source: "s",
  origin: "pinned",
  score: 4,
  dimensions: {},
  kiq: "",
  why: "",
  suggestedIssue: "",
  runId: "RUN-7",
  scannedAt: at,
  receivedAt: at,
  ...(disposed ? { disposedAs: "watch" as const, disposedAt: at } : {}),
});

describe("inboxEvictees", () => {
  it("没超上限不丢东西", () => {
    expect(inboxEvictees([stored("a", "2026-08-01"), stored("b", "2026-08-02")], 2)).toEqual([]);
  });

  it("先丢已处置的最老那几条", () => {
    const list = [
      stored("open-old", "2026-08-01"),
      stored("done-new", "2026-08-04", true),
      stored("done-old", "2026-08-02", true),
      stored("open-new", "2026-08-03"),
    ];
    expect(inboxEvictees(list, 2).map((s) => s.dedupeKey)).toEqual(["done-old", "done-new"]);
  });

  it("已处置的不够，才动未处置的 —— 顺序仍是老的先走", () => {
    const list = [
      stored("done", "2026-08-01", true),
      stored("open-old", "2026-08-02"),
      stored("open-new", "2026-08-03"),
    ];
    expect(inboxEvictees(list, 1).map((s) => s.dedupeKey)).toEqual(["done", "open-old"]);
  });
});
```

- [ ] **Step 3: 跑一次确认它红**

Run: `npx vitest run src/lib/data/inbox.test.ts`
Expected: FAIL —— `Failed to resolve import "./inbox"`。

- [ ] **Step 4: 写实现**

`src/lib/data/inbox.ts`：

```ts
/**
 * 抓取作业推过来的那份 JSON → 数据层认识的记录。
 *
 * **这是跨仓库契约的这一半。** 另一半是 `tkos-lab/src/tkos_lab/deliver.py` 的
 * `build_payload`（形状见 `docs/superpowers/specs/2026-08-19-catching-signal-rollout-design.md`
 * §4.3）。改它要同时改两处，所以它得是一个能被单测钉住的纯函数，而不是埋在 HTTP
 * 处理里的十几行 —— 契约漂了之后，端点只会安静地少收几个字段。
 *
 * 蛇形转驼峰只在这个文件里发生一次。这里不 import store，也不认识 HTTP。
 */
import type { InboxSignal, InboxSignalInput } from "./types";

/**
 * 正文留多长。落盘是**整个 store 序列化重写一遍**（见 `persist.ts`），一篇全文
 * 三五千字，两百条就是每次写盘都搬一兆。
 *
 * 截了不影响判断：研判在作业那边已经做完了，这一页只是让一号位扫一眼决定要不要
 * 开成议题；他要读全文，标题就是外链。
 */
export const INBOX_TEXT_MAX = 2000;

export type InboxParse =
  | { ok: true; runId: string; scannedAt: string; signals: InboxSignalInput[] }
  | { ok: false; error: string };

const bad = (error: string): InboxParse => ({ ok: false, error });

const obj = (v: unknown): Record<string, unknown> | null =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

/** 只用来显示的字段：给什么算什么，没给算空串。 */
const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

const truncate = (text: string): string =>
  text.length > INBOX_TEXT_MAX ? `${text.slice(0, INBOX_TEXT_MAX)}…` : text;

/**
 * 解析一批。**一条不合规就整批拒收**，不做「跳过坏的那条、收下别的」。
 *
 * 部分接收是静默丢数据：作业那边看到 200，以为都进来了，而少的那条再也不会重投
 * （下一轮扫描它可能已经出了时间窗）。整批拒 + 非零退出码，作业重跑一次即可 ——
 * 幂等键保证重跑安全，这正是它存在的理由。
 *
 * 严格与宽松的分界：**身份与排序的字段缺了就拒**（`dedupe_key` 是主键，`title` /
 * `url` 是这条信号在屏幕上的全部，`score` 是排序键，`origin` 有下游分支），
 * **只用来显示的字段缺了填空串**（`why` / `kiq` / `text` / `published_at` /
 * `source` / `suggested_issue`）—— 模型偶尔漏一句话，不该让一整轮扫描白跑。
 */
export function parseInboxPayload(body: unknown): InboxParse {
  const root = obj(body);
  if (!root) return bad("请求体不是一个对象。");

  const runId = str(root.run_id);
  if (!runId) return bad("run_id 是空的 —— 每一批都要说清是哪次扫描产出的。");
  const scannedAt = str(root.scanned_at);
  if (!scannedAt) return bad("scanned_at 是空的。");
  if (!Array.isArray(root.signals)) return bad("signals 不是数组。");

  const signals: InboxSignalInput[] = [];
  for (let i = 0; i < root.signals.length; i += 1) {
    const at = `signals[${i}]`;
    const raw = obj(root.signals[i]);
    if (!raw) return bad(`${at} 不是一个对象。`);

    const dedupeKey = str(raw.dedupe_key);
    if (!dedupeKey) {
      return bad(`${at}.dedupe_key 是空的 —— 幂等键缺了这条链路必然堆重复，整批拒收。`);
    }
    const title = str(raw.title);
    if (!title) return bad(`${at}.title 是空的。`);
    const url = str(raw.url);
    if (!url) return bad(`${at}.url 是空的 —— 一号位要点进去看原文。`);

    /*
     * 分数只校验「是个能排序的有限数」，**不校验区间**。1–5 是作业那边 rubric
     * 的事；在这里也钉一遍的话，实验台把 rubric 换成 1–10 的那一天，正式版会把
     * 整批拒掉，而两边谁都没觉得自己改了契约。
     */
    const score = raw.score;
    if (typeof score !== "number" || !Number.isFinite(score)) {
      return bad(`${at}.score 不是数字（收到 ${JSON.stringify(score)}）—— 它是排序键。`);
    }

    const origin = raw.origin;
    if (origin !== "pinned" && origin !== "discovered") {
      return bad(`${at}.origin 只能是 pinned 或 discovered，收到 ${JSON.stringify(origin)}。`);
    }

    const dims: Record<string, number> = {};
    if (raw.dimensions !== undefined && raw.dimensions !== null) {
      const src = obj(raw.dimensions);
      if (!src) return bad(`${at}.dimensions 不是一个对象。`);
      for (const [k, v] of Object.entries(src)) {
        if (typeof v !== "number" || !Number.isFinite(v)) {
          return bad(`${at}.dimensions.${k} 不是数字（收到 ${JSON.stringify(v)}）。`);
        }
        dims[k] = v;
      }
    }

    signals.push({
      dedupeKey,
      title,
      url,
      text: truncate(str(raw.text)),
      publishedAt: str(raw.published_at),
      source: str(raw.source),
      origin,
      score,
      dimensions: dims,
      kiq: str(raw.kiq),
      why: str(raw.why),
      suggestedIssue: str(raw.suggested_issue),
      runId,
      scannedAt,
    });
  }

  return { ok: true, runId, scannedAt, signals };
}

/**
 * 超了上限该丢哪几条。**先丢已处置的，都按收件时间老的先走。**
 *
 * 已处置的优先，是因为它的账已经记下了（`disposedAs` 就是那份标注）；未处置的
 * 一丢，这条链路唯一的产出就没了，而屏幕上看不出任何区别 —— 这一页本来就只是
 * 「机器捞回来的一批」，少一条谁也不知道。调用方发现返回里有未处置的，要 warn。
 *
 * 纯函数，不碰 store：上限行为是这一层唯一会静默丢数据的地方，得能被直接钉住。
 */
export function inboxEvictees(signals: InboxSignal[], cap: number): InboxSignal[] {
  const over = signals.length - cap;
  if (over <= 0) return [];
  const oldest = [...signals].sort((a, b) => a.receivedAt.localeCompare(b.receivedAt));
  return [...oldest.filter((s) => s.disposedAs), ...oldest.filter((s) => !s.disposedAs)].slice(0, over);
}
```

- [ ] **Step 5: 跑到绿**

Run: `npx vitest run src/lib/data/inbox.test.ts`
Expected: PASS（12 个 it 全绿）

- [ ] **Step 6: 类型与 lint**

Run: `npx tsc --noEmit` —— 只许有 Global Constraints 里那 8 条基线错。
Run: `npx eslint src/lib/data/inbox.ts src/lib/data/inbox.test.ts src/lib/data/types.ts`
Expected: 无输出。

- [ ] **Step 7: 提交**

```bash
git add src/lib/data/types.ts src/lib/data/inbox.ts src/lib/data/inbox.test.ts
git commit -m "feat(inbox): 待挑信号的契约与解析 —— 蛇形转驼峰、整批拒收、上限淘汰"
```

---

### Task 2: 数据层 —— 集合、幂等落库、处置

**Files:**
- Modify: `src/lib/data/store.ts`
- Modify: `src/lib/data/client.ts`
- Test: `src/lib/data/inbox-signals.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `InboxSignal` / `InboxSignalInput` / `InboxDisposition`（`./types`）与 `inboxEvictees`（`./inbox`）。
- Produces:
  - `const MAX_INBOX_SIGNALS = 200`
  - `function inboxSignalsPut(incoming: InboxSignalInput[]): { inserted: number; updated: number }`
  - `function inboxSignalGet(dedupeKey: string): InboxSignal | null`
  - `function inboxSignalDispose(dedupeKey: string, action: InboxDisposition): InboxSignal | null`
  - `function inboxSignalJudged(dedupeKey: string, judged: NonNullable<InboxSignal["judged"]>): boolean`
  - `api.listInboxSignals(): Promise<InboxSignal[]>`
  - `api.disposeInboxSignal(dedupeKey: string, action: InboxDisposition): Promise<InboxSignal>`

- [ ] **Step 1: 写失败的测试**

`src/lib/data/inbox-signals.test.ts`：

```ts
/**
 * 待挑信号的落库。
 *
 * 断言一律写成「我刚写的那条在不在、对不对」，**不断言集合里只有这几条** ——
 * store 是持久化的（`.data/store.json`），本机跑过一次 dev 之后里面就有真实的
 * 信号。写成 toEqual 的话，「在这台机器上跑过应用」本身会让测试变红。
 * （同 `agent-runs.test.ts` 里那段注释。）
 */
import { describe, expect, it } from "vitest";

import {
  api,
  inboxSignalDispose,
  inboxSignalGet,
  inboxSignalJudged,
  inboxSignalsPut,
} from "./store";
import type { InboxSignalInput } from "./types";

const input = (key: string, over: Partial<InboxSignalInput> = {}): InboxSignalInput => ({
  dedupeKey: key,
  title: `标题 ${key}`,
  url: `https://a.com/${key}`,
  text: "正文",
  publishedAt: "2026-08-18T02:00:00Z",
  source: "36氪·AI",
  origin: "pinned",
  score: 4,
  dimensions: { materiality: 4 },
  kiq: "KIQ2.2",
  why: "原因",
  suggestedIssue: "方向",
  runId: "RUN-7",
  scannedAt: "2026-08-19T07:00:00Z",
  ...over,
});

describe("inboxSignalsPut", () => {
  it("同一个键第二次来只更新研判，不新增，也不动收件时间", () => {
    const first = inboxSignalsPut([input("k-1")]);
    expect(first).toEqual({ inserted: 1, updated: 0 });
    const at = inboxSignalGet("k-1")?.receivedAt;

    const again = inboxSignalsPut([input("k-1", { score: 4.8, why: "改了", runId: "RUN-8" })]);
    expect(again).toEqual({ inserted: 0, updated: 1 });

    const got = inboxSignalGet("k-1");
    expect(got?.score).toBe(4.8);
    expect(got?.why).toBe("改了");
    expect(got?.runId).toBe("RUN-8");
    // 窗口是重叠的（time_window_hours=72，扫描每 2–3 天一轮），这一条必须成立。
    expect(got?.receivedAt).toBe(at);
  });

  it("一号位挑过的东西不会因为下一轮扫描又冒回列表", () => {
    inboxSignalsPut([input("k-2")]);
    inboxSignalDispose("k-2", "dismiss");
    inboxSignalsPut([input("k-2", { score: 5 })]);

    const got = inboxSignalGet("k-2");
    expect(got?.score).toBe(5);
    expect(got?.disposedAs).toBe("dismiss");
    expect(got?.disposedAt).toBeTruthy();
  });

  it("一批里自己重了也只算一条", () => {
    const got = inboxSignalsPut([input("k-3"), input("k-3", { score: 2 })]);
    expect(got).toEqual({ inserted: 1, updated: 1 });
    expect(inboxSignalGet("k-3")?.score).toBe(2);
  });

  it("拿不到的键返回 null，不抛", () => {
    expect(inboxSignalGet("k-不存在")).toBeNull();
    expect(inboxSignalDispose("k-不存在", "watch")).toBeNull();
    expect(inboxSignalJudged("k-不存在", { runId: "R", status: "ok", at: "T" })).toBe(false);
  });
});

describe("listInboxSignals", () => {
  it("只出未处置的，分数高的在前，同分先来的在前", async () => {
    inboxSignalsPut([
      input("k-low", { score: 3.6 }),
      input("k-high", { score: 4.9 }),
      input("k-gone", { score: 5 }),
    ]);
    inboxSignalDispose("k-gone", "issue");

    const list = await api.listInboxSignals();
    const keys = list.map((s) => s.dedupeKey);
    expect(keys).not.toContain("k-gone");
    expect(keys.indexOf("k-high")).toBeLessThan(keys.indexOf("k-low"));
    expect(list.every((s) => !s.disposedAs)).toBe(true);
  });

  it("处置回来的就是那一条的新样子", async () => {
    inboxSignalsPut([input("k-4")]);
    const got = await api.disposeInboxSignal("k-4", "watch");
    expect(got.disposedAs).toBe("watch");
    await expect(api.disposeInboxSignal("k-没有", "watch")).rejects.toThrow(/找不到/);
  });

  it("A1a 的结论记在信号上，和处置分开 —— 跑挂了也不该让「他挑过」消失", () => {
    inboxSignalsPut([input("k-5")]);
    inboxSignalDispose("k-5", "issue");
    expect(
      inboxSignalJudged("k-5", {
        runId: "RUN-a1a-1",
        status: "failed",
        at: "2026-08-19T08:00:00.000Z",
      })
    ).toBe(true);

    const got = inboxSignalGet("k-5");
    expect(got?.disposedAs).toBe("issue");
    expect(got?.judged?.status).toBe("failed");
    expect(got?.judged?.runId).toBe("RUN-a1a-1");
  });
});
```

- [ ] **Step 2: 跑一次确认它红**

Run: `npx vitest run src/lib/data/inbox-signals.test.ts`
Expected: FAIL —— `store.ts` 里没有 `inboxSignalsPut` 这些导出。

- [ ] **Step 3: 集合与上限常量**

`src/lib/data/store.ts`：
1. `import type { ... } from "./types"` 那一批里加 `InboxDisposition`、`InboxSignal`、`InboxSignalInput`；文件顶部 import 区加 `import { inboxEvictees } from "./inbox";`。
2. `store` 对象字面量里，`agentRuns` 那一项**之后**插入：

```ts
  /*
   * 待挑的信号：抓取作业（tkos-lab 的 `scripts/catch.py`）投进来的过线信号。
   *
   * 初值必须是空的，**不进种子** —— 塞了示例信号就得进 `SEED_FINGERPRINT`，
   * 而进了指纹就等于「谁改一条示例文案，下一次重启会把线上真实数据抹掉」
   * （见 persist.ts 里 `seedFrozen` 上那段）。
   *
   * 有上限，理由同 `agentRuns`：落盘是把整个 store 序列化重写一遍。
   */
  inboxSignals: [] as InboxSignal[],
```

**`persist.ts` 一个字不用改**（rollout §5 把它列在这里，但那是多写的）：落盘存的是
`state: store` 整份，恢复是 `Object.assign(store, restored)` 整份，没有需要登记新集合的
白名单。旧快照里没有 `inboxSignals` 这个键也不会炸 —— `Object.assign` 不动它，种子给的
`[]` 就留着。**新集合不进 `SEED_FINGERPRINT`**：它哈希的是数据集身份（议题/判断/人/域），
把运行期数据加进去等于「收到一条信号就让快照作废」。

3. `MAX_AGENT_RUNS` 那一段之后加：

```ts
/**
 * 待挑的信号留多少条。理由同 `MAX_AGENT_RUNS`（落盘是整份重写），数字也一样：
 * 每 2–3 天一轮、每轮过线上限 8 条，200 条是两个多月的量。
 *
 * 满了先丢**已处置**的（`inboxEvictees` 定的顺序），已处置的丢完才动未处置的，
 * 而且那时要 warn —— 见下面 `inboxSignalsPut` 里那段。
 */
export const MAX_INBOX_SIGNALS = 200;
```

- [ ] **Step 4: 四个模块级出口**

`store.ts` 里 `agentSignalInput` 那一段之后加（`MAX_INBOX_SIGNALS` 已在上面）：

```ts
/*
 * 收件入口。**不进 `api` 对象** —— `api` 的每个键都在 `POST /api/data` 的白名单里，
 * 浏览器能直接打；上了就等于允许前端往一号位的列表里塞任意信号。同 `agentRunPut`。
 *
 * 下面四个都**必须保持 `function` 声明**（跨模块环那条边上的出口，
 * 见 `agentRunPut` 上的注释）。
 */
export function inboxSignalsPut(incoming: InboxSignalInput[]): {
  inserted: number;
  updated: number;
} {
  const at = nowIso();
  let inserted = 0;
  let updated = 0;

  for (const sig of incoming) {
    const cur = store.inboxSignals.find((s) => s.dedupeKey === sig.dedupeKey);
    if (cur) {
      /*
       * 同一条 URL 又扫到一次。`time_window_hours = 72` 而扫描每 2–3 天一轮，
       * 窗口本来就是重叠的 —— 这是常态，不是异常。
       *
       * 更新的是**同一次研判的全部产物**（分数和理由要一起读，只更一半会让屏幕上
       * 分数是新的、理由是旧的）；**不动** `receivedAt` 与三个处置字段：一号位
       * 已经挑过的东西不能因为下一轮扫描又冒回列表里。
       */
      cur.title = sig.title;
      cur.url = sig.url;
      cur.text = sig.text;
      cur.publishedAt = sig.publishedAt;
      cur.source = sig.source;
      cur.origin = sig.origin;
      cur.score = sig.score;
      cur.dimensions = { ...sig.dimensions };
      cur.kiq = sig.kiq;
      cur.why = sig.why;
      cur.suggestedIssue = sig.suggestedIssue;
      cur.runId = sig.runId;
      cur.scannedAt = sig.scannedAt;
      updated += 1;
      continue;
    }
    store.inboxSignals.push({ ...sig, dimensions: { ...sig.dimensions }, receivedAt: at });
    inserted += 1;
  }

  const doomed = inboxEvictees(store.inboxSignals, MAX_INBOX_SIGNALS);
  if (doomed.length > 0) {
    for (const s of doomed) {
      // 未处置的被挤掉要喊出来：它是这条链路唯一的产出，而屏幕上看不出少了一条。
      if (!s.disposedAs) {
        console.warn(
          `[tkos:inbox] 上限 ${MAX_INBOX_SIGNALS} 满了，挤掉一条**还没有人挑过**的信号：` +
            `${s.title}（${s.url}）。要么调大上限，要么这一页积压太久了。`
        );
      }
    }
    const keys = new Set(doomed.map((s) => s.dedupeKey));
    store.inboxSignals = store.inboxSignals.filter((s) => !keys.has(s.dedupeKey));
  }

  persistSoon();
  return { inserted, updated };
}

/** 取一条（副本）。给「开成议题」那条 route 用 —— 它不该拿到能改 store 的引用。 */
export function inboxSignalGet(dedupeKey: string): InboxSignal | null {
  const sig = store.inboxSignals.find((s) => s.dedupeKey === dedupeKey);
  return sig ? clone(sig) : null;
}

/**
 * 记下处置。找不到返回 null，不抛 —— 调用方（route / api）自己决定怎么说这句话。
 *
 * `api.disposeInboxSignal` 是它的壳。两个入口共用同一个原语，不各写一份：处置字段
 * 有两个写者（一号位点三键、「开成议题」那条 route 先记后跑），逻辑分两处会漂。
 */
export function inboxSignalDispose(
  dedupeKey: string,
  action: InboxDisposition
): InboxSignal | null {
  const sig = store.inboxSignals.find((s) => s.dedupeKey === dedupeKey);
  if (!sig) return null;
  sig.disposedAs = action;
  sig.disposedAt = nowIso();
  persistSoon();
  return clone(sig);
}

/** A1a 跑完之后把结论记在这条信号上。找不到返回 false，不抛。 */
export function inboxSignalJudged(
  dedupeKey: string,
  judged: NonNullable<InboxSignal["judged"]>
): boolean {
  const sig = store.inboxSignals.find((s) => s.dedupeKey === dedupeKey);
  if (!sig) return false;
  sig.judged = { ...judged };
  persistSoon();
  return true;
}
```

- [ ] **Step 5: `api` 上两个方法**

`store.ts` 的 `api` 对象里，`listSignalLog` 那一项之后加：

```ts
  /**
   * 待挑的信号：**未处置的那些**，分数高的在前，同分先来的在前。
   *
   * **不在这里再过一遍阈值**（rollout §9）：线上一装过滤器，实验台调出来的阈值就
   * 不再是最终阈值，那次调参就白做了。差一点的信号摊在屏幕上不伤人 —— 他没挑的
   * 那几条本身就是对阈值最好的标注。
   *
   * 处置过的不出现在这里，也没有第二个读它的方法：**v1 只记不读**（rollout §5）。
   */
  async listInboxSignals(): Promise<InboxSignal[]> {
    await sleep(160, 340);
    return store.inboxSignals
      .filter((s) => !s.disposedAs)
      .map((s) => clone(s))
      .sort((a, b) => b.score - a.score || a.receivedAt.localeCompare(b.receivedAt));
  },

  /** 三键处置里的「待定」与「不看了」。「开成议题」走 `POST /api/agent/a1a/inbox`。 */
  async disposeInboxSignal(dedupeKey: string, action: InboxDisposition): Promise<InboxSignal> {
    await sleep(160, 320);
    const got = inboxSignalDispose(dedupeKey, action);
    if (!got) throw new ApiError(`找不到这条信号：${dedupeKey}`);
    return got;
  },
```

- [ ] **Step 6: 客户端两条转发**

`src/lib/data/client.ts` 里 `listSignalLog: forward("listSignalLog"),` 之后加：

```ts
  listInboxSignals: forward("listInboxSignals"),
  disposeInboxSignal: forward("disposeInboxSignal"),
```

漏了会怎样：`const api: Api` 这个标注会让 `tsc` 直接报缺键（见 client.ts 文件头）。

- [ ] **Step 7: 跑到绿**

Run: `npx vitest run src/lib/data/inbox-signals.test.ts`
Expected: PASS（7 个 it）
Run: `npx vitest run src/lib/data/inbox.test.ts src/lib/data/agent-runs.test.ts`
Expected: PASS —— 顺带确认没碰坏台账那一套。

- [ ] **Step 8: 类型与 lint**

Run: `npx tsc --noEmit`（只许 8 条基线错）
Run: `npx eslint src/lib/data/store.ts src/lib/data/client.ts src/lib/data/inbox-signals.test.ts`

- [ ] **Step 9: 提交**

```bash
git add src/lib/data/store.ts src/lib/data/client.ts src/lib/data/inbox-signals.test.ts
git commit -m "feat(inbox): 数据层落库 —— 按 dedupeKey 幂等、处置只记不读、上限先丢已处置的"
```

---

### Task 3: 收件端点 `POST /api/signals/inbox`

**Files:**
- Create: `src/app/api/signals/inbox/route.ts`
- Modify: `src/proxy.ts:5`
- Modify: `.env.example:121`、`.env.docker.example`（`OPERATOR_TOKEN` 上那条注释）
- Modify: `docs/03_MVP上线与运维须知.md`（§3 表格、§4 口子、§6 已知空档）

**Interfaces:**
- Consumes: Task 1 的 `parseInboxPayload`、Task 2 的 `inboxSignalsPut`。
- Produces: `POST /api/signals/inbox`，请求头 `x-operator-token`，成功回 `{ ok: true, inserted, updated }`。作业那边（`deliver.py` 的 `push`）读的就是这个响应；HTTP ≥ 400 时它把 body 前 300 字记进 trace。

- [ ] **Step 1: 端点**

`src/app/api/signals/inbox/route.ts`：

```ts
/**
 * 抓取作业的收件口。**这一层只做三件事：验口令、解析、落库。**
 *
 * 不做研判、不做过滤（rollout §9：这一侧一装过滤器，实验台调出来的阈值就不再是
 * 最终阈值）。方向永远是作业推过来 —— 定时在作业那边，正式版不必知道实验台存在，
 * 也不必为机器再开一条穿过访问口令的鉴权路。
 *
 * **它在 `src/proxy.ts` 的 `PUBLIC_PATHS` 里**，因为作业没有访问 cookie。那不是
 * 「公开」：它有下面这道 `x-operator-token`。少了那一条的话，作业带着完全正确的
 * 口令也只会拿到 `{"error":"unauthorized"}`，而那句话看起来像口令配错了。
 *
 * 契约的另一半在 `tkos-lab/src/tkos_lab/deliver.py`。形状校验在
 * `src/lib/data/inbox.ts`（纯函数，有单测）—— 这个文件里没有一行形状判断。
 */
import { parseInboxPayload } from "@/lib/data/inbox";
import { inboxSignalsPut } from "@/lib/data/store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: Request) {
  // 没配 token 就直接拒，不留「没配就放行」的口子（同 `api/stage/route.ts`）。
  const expected = process.env.OPERATOR_TOKEN;
  if (!expected) {
    return Response.json(
      { error: "服务端没有配 OPERATOR_TOKEN，抓取作业现在推不进来。" },
      { status: 503 }
    );
  }
  if (req.headers.get("x-operator-token") !== expected) {
    return Response.json({ error: "口令不对。" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "请求体不是 JSON。" }, { status: 400 });
  }

  const parsed = parseInboxPayload(body);
  if (!parsed.ok) {
    /*
     * 400 而不是 422：这是契约破了，属于「这批请求本身不合规」。作业那边会把这句话
     * 记进 trace 并以非零码退出，改完重投即可 —— 幂等键保证重投安全。
     */
    console.warn(`[tkos:inbox] 拒收一批：${parsed.error}`);
    return Response.json({ error: parsed.error }, { status: 400 });
  }

  const { inserted, updated } = inboxSignalsPut(parsed.signals);
  console.log(
    `[tkos:inbox] run ${parsed.runId}（扫描于 ${parsed.scannedAt}）` +
      `收到 ${parsed.signals.length} 条 → 新增 ${inserted} / 更新 ${updated}`
  );
  return Response.json({ ok: true, inserted, updated });
}
```

- [ ] **Step 2: 放进访问门的白名单**

`src/proxy.ts` 第 5 行：

```ts
/*
 * `/api/signals/inbox` 在这里，不是因为它公开，而是因为**推它的是机器**：抓取作业
 * 没有访问 cookie，不加这一条它连 route 都进不到，只会拿到 `{"error":"unauthorized"}`
 * —— 而那句话读起来像 `OPERATOR_TOKEN` 配错了，能查很久。它自己那道门是请求头里的
 * `x-operator-token`（见该 route）。
 */
const PUBLIC_PATHS = new Set(["/access", "/api/access", "/api/health", "/api/signals/inbox"]);
```

- [ ] **Step 3: 手动验一遍（三条路都要走）**

这一步在**本机开着 dev server** 时做（`pnpm dev`，沙箱里跑不起来 —— 交给人跑；`TKOS_ACCESS_*` 与 `OPERATOR_TOKEN` 先填好）：

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://localhost:3000/api/signals/inbox -H 'content-type: application/json' -d '{}'
```
期望 `401`（没带口令）。

```bash
curl -s -X POST http://localhost:3000/api/signals/inbox -H 'content-type: application/json' -H "x-operator-token: $OPERATOR_TOKEN" -d '{"run_id":"RUN-manual","scanned_at":"2026-08-19T07:00:00Z","signals":[{"dedupe_key":"https://a.com/x","title":"手工验一条","url":"https://a.com/x","text":"正文","published_at":"2026-08-18T02:00:00Z","source":"手工","origin":"pinned","score":4.2,"dimensions":{"materiality":4},"kiq":"KIQ2.2","why":"验通路","suggested_issue":"无"}]}'
```
期望 `{"ok":true,"inserted":1,"updated":0}`；**再跑一遍**期望 `{"ok":true,"inserted":0,"updated":1}` —— 幂等就是这一下。

```bash
curl -s -X POST http://localhost:3000/api/signals/inbox -H 'content-type: application/json' -H "x-operator-token: $OPERATOR_TOKEN" -d '{"run_id":"R","scanned_at":"T","signals":[{"title":"没有幂等键"}]}'
```
期望 400，且 error 里点名 `signals[0].dedupe_key`。

- [ ] **Step 4: 两份 env 样例里那条注释改掉**

`.env.example` 与 `.env.docker.example` 里 `OPERATOR_TOKEN` 上方那一行现在写着「本版封存」，那已经是假话了。换成：

```
# ── 机器口令（operator）──
# 两个用处：秘书控制台（本版封存），以及**抓取作业的收件口** POST /api/signals/inbox。
# 抓取作业那边把同一个值配成 TKOS_INBOX_TOKEN（见 tkos-lab 的 deploy/VERCEL.md）。
# 缺了收件口一律 503，配歪了 401 —— 两种都在日志里带 [tkos:inbox] 前缀。
OPERATOR_TOKEN=
```

- [ ] **Step 5: 运维须知补三处**

`docs/03_MVP上线与运维须知.md`：

1. §3 那张表末尾加一行：

```
| `OPERATOR_TOKEN` | 缺了 `POST /api/signals/inbox` 一律 503，抓取作业推不进来；和作业那边 `TKOS_INBOX_TOKEN` 不一致则 401。两种都在 `[tkos:inbox]` 前缀下 |
```

2. §4 末尾加一节：

```markdown
### `POST /api/signals/inbox` —— 抓取作业的收件口，机器专用

受 `x-operator-token` 保护（值 = `OPERATOR_TOKEN`），**在访问门的白名单里**（见
`src/proxy.ts`：推它的是机器，没有访问 cookie）。按 `dedupe_key`（归一化后的 URL）
幂等：同一条 URL 再来一次只更新研判，不新增，也不动一号位已经做过的处置。

日志一行一批：`[tkos:inbox] run <run_id>（扫描于 …）收到 N 条 → 新增 x / 更新 y`。
排查顺序：401 就是口令不一致（不是网络）；400 那句话会点名是第几条的哪个字段，
契约破了在这里看得见；503 是这台机器压根没配 `OPERATOR_TOKEN`。

**这一侧不做任何过滤**：作业给什么就收什么、就显示什么。阈值只在实验台调
（`docs/superpowers/specs/2026-08-19-catching-signal-rollout-design.md` §9）。
```

3. §6「已知空档」加三条：

```markdown
- **待挑信号的处置只记不读。** 一号位挑了哪几条、放下哪几条都落在
  `inboxSignals[].disposedAs` 里，但没有任何界面读它 —— 它是 v2 人工标注与
  precision 统计的原始数据（rollout §7）。「不看了」按下去那一条就从这一页消失，
  没有撤销。
- **点开一条待挑的信号看不到它的 trace。** 抓取与研判的全链路 trace 在实验台
  （tkos-lab 的 dev 端），正式版不做反向查询（rollout §9）。这一页上的 run id
  就是去那边查的凭据。
- **待挑信号有上限 200 条。** 满了先丢已处置的；已处置的丢完才丢未处置的，那时
  日志里有 `[tkos:inbox] 上限 … 挤掉一条**还没有人挑过**的信号`。看见这行说明
  这一页积压太久了。
```

- [ ] **Step 6: 类型与 lint**

Run: `npx tsc --noEmit`（只许 8 条基线错）
Run: `npx eslint src/app/api/signals/inbox/route.ts src/proxy.ts`

- [ ] **Step 7: 提交**

```bash
git add src/app/api/signals/inbox/route.ts src/proxy.ts .env.example .env.docker.example docs/03_MVP上线与运维须知.md
git commit -m "feat(inbox): 收件端点 —— 口令门、幂等落库、进访问门白名单"
```

---

### Task 4: 「开成议题」= 拿这条原文去跑现有的 A1a

**Files:**
- Create: `src/app/api/agent/a1a/inbox/route.ts`

**Interfaces:**
- Consumes: Task 2 的 `inboxSignalGet` / `inboxSignalDispose` / `inboxSignalJudged`；现有的 `runA1a`（`@/lib/agent/a1a/run`）、`AgentRunFailed`（`@/lib/agent/harness`）、`agentRunPut`（`@/lib/data/store`）、`runTask` / `taskState`（`@/lib/agent/tasks`）。
- Produces: `POST /api/agent/a1a/inbox`，body `{ key: string, depth?: string }`，回 `TaskState`（`{ status: "idle"|"running"|"done"|"failed", startedAt?, finishedAt?, error?, attempts? }`）；`GET /api/agent/a1a/inbox?key=<dedupeKey>` 回同一个形状。Task 5 的视图按这两个打。

- [ ] **Step 1: route**

`src/app/api/agent/a1a/inbox/route.ts`：

```ts
/**
 * 「开成议题」：拿一条待挑的信号去跑现有的 A1a。**A1a 本身一个字不改。**
 *
 * 为什么不复用 `../route.ts`：那一条按 `cardId` 取输入（`agentSignalInput` 要求这条
 * 信号已经是提请台里的一张卡、并且挂在某个议题下）。待挑的信号两样都没有 —— 它就是
 * 一段外部原文，恰好是 A1a 纯外部那条路的输入。而 `runA1a` 的 `cardId` **只进类型不进
 * 函数体**（锚点是 `openContext("S01", input.headline)` 拿 headline 去图谱里查的），
 * 所以这里把 `dedupeKey` 填进去就够，不用给 A1a 加任何分支。
 *
 * **不调 `applyA1aResult`**：它的 `new_issue` / `update_issue` 两条至今抛
 * `NotWiredYet`，而 `ignore` 那条会去 `markCardAgentVerdict` 一张不存在的卡。这条
 * 链路的写回就是把结论记在这条信号上（`inboxSignalJudged`）。
 *
 * **口令**：不要把这条路加进 `src/proxy.ts` 的 `PUBLIC_PATHS` —— 点它的是浏览器里的
 * 一号位，走访问 cookie 那道门。只有作业推的那一条是机器路。
 */
import { runA1a } from "@/lib/agent/a1a/run";
import { AgentRunFailed } from "@/lib/agent/harness";
import { runTask, taskState } from "@/lib/agent/tasks";
import {
  agentRunPut,
  inboxSignalDispose,
  inboxSignalGet,
  inboxSignalJudged,
} from "@/lib/data/store";
import type { AgentRunRecord } from "@/lib/data/types";

export const dynamic = "force-dynamic";

/** 任务表里的分类。和按 cardId 的那条分开，否则两种 id 会撞在同一个 key 上。 */
const KIND = "a1a-inbox";

const fail = (status: number, message: string) => Response.json({ error: message }, { status });

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return fail(400, "请求体不是 JSON。");
  }
  const key = (body as { key?: unknown })?.key;
  const depth = (body as { depth?: unknown })?.depth;
  if (typeof key !== "string" || !key) return fail(400, "要给 key。");

  const sig = inboxSignalGet(key);
  if (!sig) return fail(404, `没有这条信号：${key}`);

  /*
   * **先记处置，再跑。** 「他挑了这一条」是这条链路真正要留的数据（rollout §7：
   * 处置是阈值的免费标注），跟 A1a 这次跑成没跑成是两件事 —— 跑挂了就把处置也丢掉的
   * 话，这份标注会系统性地偏向「顺利的那些」，而它将来要用来算 precision。
   */
  inboxSignalDispose(key, "issue");

  // `runTask` 是**同步**的：立刻返回 running，后台自己跑（别加 await）。
  // 同一个 key 正在跑就直接返回 running，不排队 —— 前端是轮询的。
  const state = runTask(KIND, key, async () => {
    let run: AgentRunRecord;
    try {
      run = await runA1a(
        {
          cardId: key,
          headline: sig.title,
          source: sig.source || "抓取作业",
          body: sig.text,
        },
        { depth: typeof depth === "string" ? depth : undefined }
      );
    } catch (e) {
      // 就地失败也要留账：台账一条，信号上一条 —— 两边说的话必须一致。
      if (e instanceof AgentRunFailed) {
        agentRunPut(e.run);
        inboxSignalJudged(key, {
          runId: e.run.id,
          status: e.run.status,
          route: e.run.route,
          at: e.run.finishedAt,
        });
      }
      throw e;
    }
    agentRunPut(run);
    inboxSignalJudged(key, {
      runId: run.id,
      status: run.status,
      route: run.route,
      at: run.finishedAt,
    });
    console.log(`[tkos:inbox] ${key} → A1a ${run.id} ${run.status}${run.route ? ` · ${run.route}` : ""}`);
    if (run.status === "failed") throw new Error(run.error ?? "A1a 失败");
    return { attempts: 1 };
  });

  return Response.json(state);
}

export async function GET(req: Request) {
  const key = new URL(req.url).searchParams.get("key");
  if (!key) return fail(400, "要给 key。");
  return Response.json(taskState(KIND, key));
}
```

- [ ] **Step 2: 类型与 lint**

Run: `npx tsc --noEmit`（只许 8 条基线错）
Run: `npx eslint src/app/api/agent/a1a/inbox/route.ts`

- [ ] **Step 3: 手动验（本机 dev，交给人跑）**

先按 Task 3 Step 3 灌一条进去，然后：

```bash
curl -s -X POST http://localhost:3000/api/agent/a1a/inbox -H 'content-type: application/json' -b "$COOKIE" -d '{"key":"https://a.com/x"}'
```
期望立刻回 `{"status":"running",...}`；隔几秒 `GET .../inbox?key=https%3A%2F%2Fa.com%2Fx` 变成 `done` 或 `failed`。
**没配图服务或没配模型时它会 `failed`，那是对的** —— 要的是 `failed` 里那句人话，不是白屏。带 `TKOS_MODEL_MOCK=1` 跑能不烧 token 走通全程。

- [ ] **Step 4: 提交**

```bash
git add src/app/api/agent/a1a/inbox/route.ts
git commit -m "feat(inbox): 开成议题 —— 待挑的信号直接喂现有 A1a，处置先记后跑"
```

---

### Task 5: 待挑信号列表页与入口

**Files:**
- Create: `src/app/(tkos)/signals-inbox/page.tsx`
- Create: `src/app/_views/signals-inbox-view.tsx`
- Modify: `src/app/_views/digest-view.tsx`（`PanelHead.actions`，第 77–83 行那一块；`ArchiveLink` 之后加一个组件）
- Modify: `src/app/_views/home-view.tsx`（`RadarPanel` 上那段注释里「自动抓取还没接」那句）

**Interfaces:**
- Consumes: Task 2 的 `api.listInboxSignals()` / `api.disposeInboxSignal(key, action)` 与类型 `InboxSignal`；Task 4 的 `POST/GET /api/agent/a1a/inbox`；`TaskState`（`import type` from `@/lib/agent/tasks`）。
- Produces: 路由 `/signals-inbox`。

- [ ] **Step 1: 页面壳**

`src/app/(tkos)/signals-inbox/page.tsx`（照 `signals-log/page.tsx`，**不要写 `PageProps`**）：

```tsx
import { SignalsInboxView } from "@/app/_views/signals-inbox-view";

/** 待挑的信号：抓取作业捞回来、还没有人挑过的那些。 */
export default function SignalsInboxPage() {
  return <SignalsInboxView />;
}
```

- [ ] **Step 2: 列表页**

`src/app/_views/signals-inbox-view.tsx`：

```tsx
"use client";

import { EyeOff, Search, Timer } from "lucide-react";
import { useEffect, useState } from "react";
import { AsyncBoundary } from "@/components/async-boundary";
import { Panel, PanelEmpty, PanelHead } from "@/components/panel";
import { api } from "@/lib/data/client";
import type { InboxDisposition, InboxSignal } from "@/lib/data/types";
import type { TaskState } from "@/lib/agent/tasks";
import { formatStamp } from "@/lib/format";
import { useResource } from "@/lib/use-resource";
import { cn } from "@/lib/utils";

/**
 * 待挑的信号。
 *
 * 抓取作业（实验台那套 catching harness，按 tag 部署的一个独立作业）每 2–3 天扫一轮，
 * 过线的投到这里。**这一页不做任何研判**：分数、命中的 KIQ、一句话理由、建议的议题
 * 方向，全是作业那边算完的；这一页只把它们摆开，让一号位挑。
 *
 * 三键的重量差得很远，所以底色分三档：
 *   - **开成议题** —— 拿这条原文去跑 A1a。这是全站第一个真的会触发 agent 的按钮。
 *   - **待定** —— 记一笔，先从这一页拿走。
 *   - **不看了** —— 同上。**没有撤销**（账在数据层，v1 只记不读）。
 *
 * 按下去屏幕不跳走、行也不消失：他可能连着处置四五条，每一次都被弹到别处或者让列表
 * 当场重排，这一页就没法一口气看完。行留在原地、按钮换成一句结果，刷新之后它才不再
 * 出现 —— 「已经处理过的东西不再占今天的注意力」这件事，由下一次进这一页来完成。
 */
export function SignalsInboxView() {
  const resource = useResource<InboxSignal[]>("signals-inbox", () => api.listInboxSignals());

  return (
    <Panel>
      <AsyncBoundary resource={resource} skeleton={<InboxSkeleton />}>
        {(signals) => <InboxList signals={signals} />}
      </AsyncBoundary>
    </Panel>
  );
}

function InboxList({ signals }: { signals: InboxSignal[] }) {
  /** 这一次进来点过的那几条：留在屏幕上，只是换一句结果。 */
  const [acted, setActed] = useState<Record<string, InboxDisposition>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [judging, setJudging] = useState<Record<string, TaskState>>({});

  /*
   * 有在跑的就每 2 秒问一次进度。
   *
   * 依赖写成拼起来的字符串而不是数组 —— 数组每次渲染都是新引用，effect 会每帧
   * 重挂一次计时器，看起来正常，实际是在按渲染频率打接口。
   */
  const running = Object.entries(judging)
    .filter(([, s]) => s.status === "running")
    .map(([k]) => k)
    .join("\n");

  useEffect(() => {
    if (!running) return;
    const tick = () => {
      for (const key of running.split("\n")) {
        void fetch(`/api/agent/a1a/inbox?key=${encodeURIComponent(key)}`, { cache: "no-store" })
          .then((r) => r.json() as Promise<TaskState>)
          .then((s) => setJudging((cur) => ({ ...cur, [key]: s })))
          .catch(() =>
            // 问不到进度就说问不到。一直转圈是这一页最不能出的错：他会以为还在跑。
            setJudging((cur) => ({
              ...cur,
              [key]: { status: "failed", error: "问不到进度了（网络中断？）。刷新这一页看结果。" },
            }))
          );
      }
    };
    const t = setInterval(tick, 2000);
    return () => clearInterval(t);
  }, [running]);

  const openIssue = async (sig: InboxSignal) => {
    setBusy(sig.dedupeKey);
    try {
      const res = await fetch("/api/agent/a1a/inbox", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key: sig.dedupeKey }),
        cache: "no-store",
      });
      const state = (await res.json()) as TaskState & { error?: string };
      setActed((cur) => ({ ...cur, [sig.dedupeKey]: "issue" }));
      setJudging((cur) => ({
        ...cur,
        [sig.dedupeKey]: res.ok ? state : { status: "failed", error: state.error ?? "开不起来。" },
      }));
    } catch {
      setJudging((cur) => ({
        ...cur,
        [sig.dedupeKey]: { status: "failed", error: "连不上服务。" },
      }));
    } finally {
      setBusy(null);
    }
  };

  const dispose = async (sig: InboxSignal, action: Exclude<InboxDisposition, "issue">) => {
    setBusy(sig.dedupeKey);
    try {
      await api.disposeInboxSignal(sig.dedupeKey, action);
      setActed((cur) => ({ ...cur, [sig.dedupeKey]: action }));
    } finally {
      setBusy(null);
    }
  };

  const left = signals.filter((s) => !acted[s.dedupeKey]).length;

  return (
    <>
      <PanelHead
        /*
         * 只说得出来的事实：这一批是哪次扫描捞回来的、还剩几条没挑。
         * **不写「已扫描 N 条」** —— 那个分母没人核得动（同 home-view 的雷达那一段）。
         */
        eyebrow={`待挑的信号 · 还剩 ${left} 条`}
        title="机器捞回来的，等您挑。"
        sub="分数、理由与建议方向都是抓取作业算的。开成议题会拿这条原文去跑一次调研。"
      />

      {signals.length === 0 ? (
        <PanelEmpty
          title="眼下没有待挑的信号。"
          note="抓取作业每 2–3 天扫一轮，过线的会出现在这里。"
        />
      ) : (
        <ul className="card mt-7 overflow-hidden">
          {signals.map((sig, i) => (
            /* `row concentric` 挂在 `<li>` 上：缝里那条发丝线是 `.row + .row` 画的，只认相邻兄弟。 */
            <li
              key={sig.dedupeKey}
              className="stagger row concentric px-3.5 py-3.5"
              style={{ "--i": i } as React.CSSProperties}
            >
              <div className="flex items-baseline gap-2.5">
                <span
                  className={cn(
                    "meta tabular-nums font-medium",
                    sig.score >= 4.5 ? "text-confirmed" : "text-ink-muted"
                  )}
                >
                  {sig.score.toFixed(1)}
                </span>
                <a
                  href={sig.url}
                  target="_blank"
                  rel="noreferrer"
                  className="min-w-0 flex-1 text-md leading-relaxed text-ink underline decoration-hairline underline-offset-4 transition-colors duration-fast hover:decoration-ink-faint"
                >
                  {sig.title}
                </a>
              </div>

              <div className="meta mt-1 flex flex-wrap items-baseline gap-x-2.5 gap-y-1 text-ink-faint">
                <span>{sig.source || "未标来源"}</span>
                {sig.publishedAt ? <span>{formatStamp(sig.publishedAt)}</span> : null}
                {sig.kiq ? <span>{sig.kiq}</span> : null}
                {sig.origin === "discovered" ? <span>作业自己提名的源</span> : null}
              </div>

              {sig.why ? <p className="mt-1.5 text-sm leading-relaxed text-ink-muted">{sig.why}</p> : null}
              {sig.suggestedIssue ? (
                <p className="meta mt-1 text-ink-faint">建议方向：{sig.suggestedIssue}</p>
              ) : null}

              <div className="mt-3">
                {acted[sig.dedupeKey] ? (
                  <Outcome action={acted[sig.dedupeKey]} task={judging[sig.dedupeKey]} />
                ) : (
                  <div className="grid grid-cols-3 gap-1.5 sm:max-w-md">
                    <Act
                      icon={<Search className="size-3.5" aria-hidden />}
                      label="开成议题"
                      tone="solid"
                      disabled={busy !== null}
                      onClick={() => void openIssue(sig)}
                    />
                    <Act
                      icon={<Timer className="size-3.5" aria-hidden />}
                      label="待定"
                      tone="outline"
                      disabled={busy !== null}
                      onClick={() => void dispose(sig, "watch")}
                    />
                    <Act
                      icon={<EyeOff className="size-3.5" aria-hidden />}
                      label="不看了"
                      tone="bare"
                      disabled={busy !== null}
                      onClick={() => void dispose(sig, "dismiss")}
                    />
                  </div>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

/**
 * 点完之后那一行字。
 *
 * A1a 判为噪音（`ignored`）**不是失败**，是一个正经结论：这条不值得开成议题。混成
 * 「失败」的话，他会以为系统坏了然后再点一次，而那是一次真实的模型调用。
 */
function Outcome({ action, task }: { action: InboxDisposition; task?: TaskState }) {
  if (action === "watch") return <p className="meta text-ink-muted">已记为待定。</p>;
  if (action === "dismiss") return <p className="meta text-ink-faint">已记下不看了。</p>;

  if (!task || task.status === "running" || task.status === "idle") {
    return (
      <p className="meta text-ink-muted" aria-live="polite">
        正在开成议题 —— 调研这一步要两次模型调用，稍等…
      </p>
    );
  }
  if (task.status === "failed") {
    return (
      <p className="meta text-counter">
        这一条没开成：{task.error ?? "没有给出原因。"}（处置已经记下了，账不会丢。）
      </p>
    );
  }
  return <p className="meta text-confirmed">已开成议题 —— 去战略议题那一屏看它。</p>;
}

/** 动作按重量分三档：实心=主出口，描边=次要出口，无框=降级。同 signal-view。 */
function Act({
  icon,
  label,
  tone,
  disabled,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  tone: "solid" | "outline" | "bare";
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "meta inline-flex h-9 w-full items-center justify-center gap-1 rounded-lg px-1 font-medium whitespace-nowrap transition-colors duration-fast ease-swift disabled:opacity-40",
        tone === "solid" && "bg-solid text-solid-fg hover:opacity-90",
        tone === "outline" && "border border-hairline-strong text-ink hover:bg-neutral-wash",
        tone === "bare" && "text-ink-faint hover:text-ink-muted"
      )}
    >
      {icon}
      {label}
    </button>
  );
}

function InboxSkeleton() {
  return (
    <div aria-live="polite">
      <span className="skeleton block h-2.5 w-40" />
      <span className="skeleton mt-2.5 block h-5 w-[46%]" />
      {/* 骨架跟真清单同一套结构，否则数据到手时布局会跳。 */}
      <div className="card mt-7 overflow-hidden">
        {[0, 1, 2].map((i) => (
          <div key={i} className="row concentric px-3.5 py-3.5">
            <span className="skeleton block h-4 w-[78%]" />
            <span className="skeleton mt-2 block h-2.5 w-48" />
            <span className="skeleton mt-2.5 block h-3.5 w-[64%]" />
          </div>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 3: 待定事项那一屏加入口**

`src/app/_views/digest-view.tsx`：

1. `PanelHead` 的 `actions`（现在只有一个「处置记录 →」）换成：

```tsx
        actions={
          <>
            <InboxLink />
            <Link
              href="/signals-log"
              className="meta rounded-[3px] text-ink-faint underline decoration-hairline underline-offset-4 transition-colors duration-fast hover:text-ink-muted"
            >
              处置记录 →
            </Link>
          </>
        }
```

2. `ArchiveLink()` 之后加（照它的「有存货才出现」写法；key 与列表页同一个，SWR 因此不会多打一次接口）：

```tsx
/**
 * 机器捞回来那一批的入口。**没有就不出现。**
 *
 * 放在这一屏的标题行而不是做成第四条卡：待挑的信号是「还没有人看过的机器产出」，
 * 和提请台里那几张已经成卡的东西不是一个份量，混在一起会把提请台的克制稀释掉。
 */
function InboxLink() {
  const inbox = useResource<InboxSignal[]>("signals-inbox", () => api.listInboxSignals());
  const n = inbox.data?.length ?? 0;
  if (n === 0) return null;
  return (
    <Link
      href="/signals-inbox"
      className="meta rounded-[3px] text-ink-muted underline decoration-hairline underline-offset-4 transition-colors duration-fast hover:text-ink hover:decoration-ink-faint"
    >
      待挑的信号 {n} 条 →
    </Link>
  );
}
```

3. 该文件的 `import type { Card, SensorTarget, WithheldItem } from "@/lib/data/types";` 加上 `InboxSignal`。

- [ ] **Step 4: 雷达上那句话现在是假话了**

`src/app/_views/home-view.tsx` 的 `RadarPanel` 注释里这一句：

> 要如实说的是：**自动抓取还没接**（A1a 与两个信号源渠道未做）。所以这台雷达此刻
> 表达的是「系统在持续盯着这些靶点」，不是「它正在外网抓东西」。前者是真的。

换成：

```
 * 要如实说的是：这台雷达表达的是「系统在持续盯着这些靶点」，不是「它正在外网抓
 * 东西」。抓取现在**确实接了**（实验台那套 catching 作业每 2–3 天扫一轮，过线的进
 * `/signals-inbox`），但那不在这一格里 —— 这一格摊的是布控着的靶点。别顺手在这里
 * 加一个「今天抓了 N 条」：那个分母没人核得动，而它换来的信任是假的。
```

**只改这段注释，不给雷达加计数。** 待挑信号的计数在待定事项那一屏的标题行（`InboxLink`），一个入口够了。

- [ ] **Step 5: 类型与 lint**

Run: `npx tsc --noEmit`（只许 8 条基线错）
Run: `npx eslint src/app/_views/signals-inbox-view.tsx src/app/_views/digest-view.tsx src/app/_views/home-view.tsx "src/app/(tkos)/signals-inbox/page.tsx"`

- [ ] **Step 6: 本机看一眼（交给人跑，沙箱里起不来 dev server）**

`pnpm dev` → 先按 Task 3 Step 3 灌两三条进去 → `/signals-inbox`：

1. 分数高的在上；标题点开是外链新窗口。
2. 「待定」按下去那一行留在原地、换成一句「已记为待定」，别的行不动；刷新之后它不再出现。
3. 「开成议题」按下去先出「正在开成议题…」，2 秒一次轮询，结束后变成结果那一句（没配模型时是 `failed` 那一句，**那也是对的**）。
4. 回 `/`（待定事项那一屏）标题行有「待挑的信号 N 条 →」；把三条都处置掉再刷新，那个链接消失。
5. 窄屏（≤640px）三键仍在一行里，字不折。

- [ ] **Step 7: 提交**

```bash
git add "src/app/(tkos)/signals-inbox/page.tsx" src/app/_views/signals-inbox-view.tsx src/app/_views/digest-view.tsx src/app/_views/home-view.tsx
git commit -m "feat(inbox): 待挑信号列表页与入口 —— 三键处置，开成议题触发 A1a"
```

---

## 全部做完之后的人工事项（不写代码）

1. **配上作业那边的两个变量再打开投递**：tkos-lab 的 `TKOS_INBOX_URL`（= `https://<正式版>/api/signals/inbox`）与 `TKOS_INBOX_TOKEN`（= 这边的 `OPERATOR_TOKEN`）。在那之前作业用 `--dry-run` 跑，信号只落在实验台的库里（见 tkos-lab 的 `docs/superpowers/plans/2026-08-19-catching-signal.md` Task 11）。
2. **上线判据是连续两轮扫描不再改策略**（rollout §7），达成那一刻把那条 run 的 id 与加星的策略版本写进实验台 CHANGELOG 的 v0.15.0 那条 —— 作业的 `--from-run` 就是它。
3. **靶点策略 v0.1 要方法负责人（田田）与 CEO 审阅**之后才装成默认认知段。它阻塞的是作业用哪一版策略，**不阻塞这五个任务里的任何一行代码**。
4. 第一次真投递之后，看一眼日志里那行 `[tkos:inbox] run … 收到 N 条 → 新增 x / 更新 y`：第二轮的 `更新` 不为零，才说明幂等键真的在起作用（窗口重叠是常态）。
