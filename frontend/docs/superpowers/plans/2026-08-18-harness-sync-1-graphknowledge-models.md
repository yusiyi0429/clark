# harness 同步 · 第一半：GraphKnowledge M7 + 模型网关 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 `clark-main` 真正连上 GraphKnowledge M7 本体与火山方舟双出口模型网关，`GET /api/graphknowledge/check` 四层全绿。

**Architecture:** 把 `tkos-lab` 的 Python harness 底层逐层翻成 TypeScript，落在 `src/lib/graphknowledge/`（对外只有 `openContext()` 一扇门）与 `src/lib/models/`（`ModelSpec` 注册表 + `pro`/`flash`/`alt` 槽位 + `callModel()`）。三态（命中 / 无锚点 / 服务不可用）由类型结构保证不被混淆：`AnchorNotFound` 在门里被吃掉转成 `external_only`，`GraphKnowledgeUnavailable` 原样穿透。

**Tech Stack:** TypeScript 5.9（`target: ES2017`，`strict`）、Next.js 16.3 App Router、undici（新增依赖，为自签证书传 dispatcher）、vitest（新增，仓库此前没有测试框架）、pnpm 11.5.3。

设计文档：[`docs/superpowers/specs/2026-08-18-harness-sync-design.md`](../specs/2026-08-18-harness-sync-design.md)（commit `b3bfb5f`）。

## Global Constraints

- **阈值常量逐字照搬，不许改**：`TIE_RATIO = 0.95`、`FLAT_RATIO = 0.90`、`FLAT_MIN_SEEDS = 4`、`MAX_CANDIDATES = 8`、`MAX_CONTEXT_CHARS = 16_000`、`P3_MAX_QUERY_CHARS = 100`；三配方 P3 参数 S01 `k=5/budget=3000`、S02 `k=3/budget=1200`、S03 `k=10/budget=6000` + `k=5/budget=3000`。
- **每个从实验台搬来的文件，头部注释第一行写「对齐自 `tkos-lab/src/tkos_lab/<路径>`」**。将来实验台调阈值，正式版跟上是一次能 diff 出来的比对。
- **三态绝不混淆**：`AnchorNotFound` 是分支不是故障；`GraphKnowledgeUnavailable` 就地失败。任何 `catch` 块都必须先判 `AnchorNotFound`，再判基类。
- **火山两把 key 各自配一个地址，不给第二种组合的机会**：`ARK_API_KEY` → `/api/v3`，`ARK_AGENT_API_KEY` → `/api/plan/v3`。套餐 key 打模型广场地址会**照单收费**，不报错。
- **`ALT` 必须与 `PRO` 不同家族**。默认 `pro=deepseek-pro`、`flash=deepseek-flash`、`alt=kimi-k3`。
- **`callJson(messages, opts): Promise<string>` 的签名一个字不改** —— `a2` / `a6` / `a10` 都在用它，它们不在本轮范围内。
- **读环境变量永不抛异常**。解析失败记进 `warnings` 数组，由自检报出来。
- **凭据不进日志、不进任何返回值**。认证只报「配了 / 没配」。
- 中文注释写「为什么」不写「做了什么」，与现有代码同密度。
- 类型检查用 `npx tsc --noEmit`；lint 逐文件 `npx eslint <file>`（`npx eslint .` 会超时）。

## 与 spec 的两处收窄（实施时明确记下）

1. **spec §2 写「新建 `prompts/`：13 个工程 prompt」，本半不建任何 prompt 文件。** 本半不碰 agent 层。第二半只建这一轮真正用到的四个（`a1a.triage` / `a1a.issue.update` / `a1a.issue.new` / `a1a.issue.external`）；A3/A4 按 spec §3 决策 4「输出形状不动」，继续用现有的 `a3/prompt.ts`、`a4/prompt.ts`。凑到 13 个只会得到 9 个空文件。
2. **spec §10③ 的 `TKOS_MODEL_MOCK` 落在第二半。** mock 要返回**每个 prompt key 各自形状**的样例输出才有用，而那些 key 在第二半才存在。本半的 `callModel()` 不带 mock 分支。

---

### Task 1: vitest 落地 + 三态错误 + P3 查询长度上限

**Files:**
- Modify: `package.json`
- Create: `vitest.config.ts`
- Create: `src/lib/graphknowledge/errors.ts`
- Create: `src/lib/graphknowledge/limits.ts`
- Test: `src/lib/graphknowledge/limits.test.ts`

**Interfaces:**
- Consumes: 无（第一个任务）
- Produces:
  - `class GraphKnowledgeError extends Error { readonly detail: Record<string, unknown> }`
  - `class GraphKnowledgeNotFound / GraphKnowledgeRejected / GraphKnowledgeUnavailable / AnchorNotFound extends GraphKnowledgeError`
  - `const P3_MAX_QUERY_CHARS = 100`
  - `function clip(value: string, limit?: number): string`
  - `pnpm test` 跑 `vitest run`

- [ ] **Step 1: 装 vitest**

```bash
pnpm add -D vitest
```

- [ ] **Step 2: 写 vitest 配置**

`@/` 别名必须显式给 vitest —— 它不读 `tsconfig.json` 的 `paths`，不配的话第一个 `import "@/lib/..."` 就解析失败。

Create `vitest.config.ts`:

```ts
/**
 * vitest 只用来盯纯函数里的**阈值与断句规则**。
 *
 * 这些常量改了不会报错，只会让锚点选得越来越差、检索式被切在词中间 ——
 * 那种坏法没有任何症状，是单测最值钱的地方。渲染、路由、模型调用不进这里。
 */
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // vitest 不读 tsconfig 的 paths，别名要在这里再说一遍。
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
```

- [ ] **Step 3: 给 package.json 加 test 脚本**

在 `"scripts"` 里 `"lint": "eslint"` 之后加两行：

```json
    "test": "vitest run",
    "test:watch": "vitest"
```

- [ ] **Step 4: 写失败的测试**

Create `src/lib/graphknowledge/limits.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { P3_MAX_QUERY_CHARS, clip } from "./limits";

describe("clip", () => {
  it("上限是 100 —— 这是服务端的约束，不是我们的选择", () => {
    expect(P3_MAX_QUERY_CHARS).toBe(100);
  });

  it("没超长就只折空白：换行与全角竖线一律折成单个空格", () => {
    expect(clip("一 二\n三｜四")).toBe("一 二 三 四");
  });

  it("超长时断在句读上，不把最后一个词切成两半", () => {
    const long = "甲".repeat(50) + "。" + "乙".repeat(60);
    expect(clip(long)).toBe("甲".repeat(50) + "。");
  });

  it("整句没有标点就硬切到上限", () => {
    expect(clip("丙".repeat(120))).toHaveLength(100);
  });

  it("句读太靠前（< 10 字）就当没找到，硬切 —— 断出两个字的检索式没有意义", () => {
    expect(clip("，" + "丁".repeat(120))).toHaveLength(100);
  });
});
```

- [ ] **Step 5: 跑测试确认它失败**

Run: `npx vitest run src/lib/graphknowledge/limits.test.ts`
Expected: FAIL —— `Failed to resolve import "./limits"`

- [ ] **Step 6: 写 errors.ts**

Create `src/lib/graphknowledge/errors.ts`:

```ts
/**
 * 对齐自 tkos-lab/src/tkos_lab/graphknowledge/errors.py
 *
 * GraphKnowledge 的四种失败。**`AnchorNotFound` 必须在 `GraphKnowledgeError`
 * 之前判**：它继承自基类，先判基类会把一条正常分支吃成故障。
 *
 * 为什么要分这么细：`GraphKnowledgeUnavailable`（连不上）和 `AnchorNotFound`
 * （图里没这条）的结论完全相反。前者是一次停机，后者是「这条输入对公司现有
 * 方向来说太新」。混成一件事的后果是——图服务一挂，每次运行都悄悄降级成纯
 * 外部调研，还照样产出一份格式漂亮的报告，没人查得出来。
 */
export class GraphKnowledgeError extends Error {
  readonly detail: Record<string, unknown>;

  constructor(message: string, detail: Record<string, unknown> = {}) {
    super(message);
    this.name = new.target.name;
    this.detail = detail;
  }
}

/** 显式传进来的业务锚点不存在（404）。 */
export class GraphKnowledgeNotFound extends GraphKnowledgeError {}

/** 参数不满足契约（400 / 422）。q 超 100 字就是这一类。 */
export class GraphKnowledgeRejected extends GraphKnowledgeError {}

/** 网络不通、地址没配、认证被拒、返回不可解析、服务端 5xx。**就地失败。** */
export class GraphKnowledgeUnavailable extends GraphKnowledgeError {}

/**
 * 按问题找不到该频道要的锚点。**这不是故障，是一条分支信号** ——
 * 调用方改走纯外部调研。绝不能由服务不可用折成这一条。
 */
export class AnchorNotFound extends GraphKnowledgeError {}
```

- [ ] **Step 7: 写 limits.ts**

Create `src/lib/graphknowledge/limits.ts`:

```ts
/**
 * 对齐自 tkos-lab/src/tkos_lab/graphknowledge/limits.py
 *
 * M7 接口自身的硬约束。写在一处，是因为它们是**服务端**的约束，不是我们的
 * 选择：抄第二份就一定会有一份忘了跟着改，而这类不一致的表现是线上 422、
 * 离线全绿。
 */

/**
 * P3（`/api/v1/context/dynamic`）的 q 上限。超了服务端返回 422
 * `string_too_long`，**不是**悄悄截断——所以必须由调用方先裁。
 *
 * 实验台踩过这个坑：这条约束曾经只有配方装配那一处遵守，锚点检索那一处没有。
 * 一条真实信号两三百字，于是每次实验的第一步（按问题选锚点）都 422，表现是
 * 「找不到 CARD-* 锚点」——看起来像图谱里没有，实际是请求根本没被受理。
 */
export const P3_MAX_QUERY_CHARS = 100;

/** 句读。断在这些字符后面，不断在词中间。 */
const MARKS = "。！？；，";

/**
 * 把一段自然语言裁成 P3 收得下的检索式。
 *
 * 换行与全角竖线一律折成空格（多行信号原文直接送过去，服务端只看总长），
 * 尽量断在句读上——断在词中间会把最后一个词切成两半，那是给 embedding 添
 * 噪音。找不到句读（一整句没有标点）就硬切。
 */
export function clip(value: string, limit: number = P3_MAX_QUERY_CHARS): string {
  const flat = (value ?? "").replace(/[\s｜|]+/g, " ").trim();
  if (flat.length <= limit) return flat;
  const head = flat.slice(0, limit);
  let cut = -1;
  for (const mark of MARKS) cut = Math.max(cut, head.lastIndexOf(mark));
  // 断出两三个字的检索式对 embedding 毫无意义，那还不如硬切满 100 字。
  return cut >= 10 ? head.slice(0, cut + 1) : head;
}
```

- [ ] **Step 8: 跑测试确认通过**

Run: `npx vitest run src/lib/graphknowledge/limits.test.ts`
Expected: PASS，5 个用例全绿

- [ ] **Step 9: 类型检查**

Run: `npx tsc --noEmit`
Expected: 无输出

- [ ] **Step 10: Commit**

```bash
git add package.json pnpm-lock.yaml vitest.config.ts src/lib/graphknowledge/errors.ts src/lib/graphknowledge/limits.ts src/lib/graphknowledge/limits.test.ts
git commit -m "装 vitest；GraphKnowledge 三态错误与 P3 的 100 字上限"
```

---

### Task 2: M7 只读客户端

**Files:**
- Create: `src/lib/graphknowledge/client.ts`
- Test: `src/lib/graphknowledge/client.test.ts`
- Modify: `package.json`（加 `undici`）

**Interfaces:**
- Consumes: `GraphKnowledgeNotFound` / `GraphKnowledgeRejected` / `GraphKnowledgeUnavailable`（Task 1）
- Produces:
  - `type GkSettings = { baseUrl: string; auth: { user: string; password: string } | null; verifyTls: boolean; viewer: string; warnings: string[] }`
  - `function gkSettings(): GkSettings`
  - `type GkEntity = { code?: string; label?: string; properties?: Record<string, unknown>; relations?: Record<string, string[]>; versions?: GkVersion[] }`
  - `type GkVersion = { index?: number; status?: string; at?: string; statement?: string; meetingLabel?: string }`
  - `type GkSeed = { code?: string; type?: string; score?: number }`
  - `type GkDynamic = { query?: string; seeds?: GkSeed[]; text?: string; warning?: string }`
  - `class GraphKnowledgeClient` —— 字段 `baseUrl` / `viewer` / `warnings`；方法 `staticContext({viewer, asOf}): Promise<string>`、`entity(code): Promise<GkEntity>`、`chain(code): Promise<GkEntity>`、`dynamic(query, {k, budget}): Promise<GkDynamic>`、`health(): Promise<Record<string, unknown>>`

- [ ] **Step 1: 装 undici**

`TKOS_GRAPHKNOWLEDGE_VERIFY_TLS=0` 在 Node 里没法靠 `fetch` 的选项实现 —— 全局 `fetch` 不吃 `rejectUnauthorized`。图服务是 IP + 自签证书，必须走 `undici.request` 显式传 dispatcher。顺带的好处是绕开 Next.js 给全局 `fetch` 打的缓存补丁。

```bash
pnpm add undici
```

- [ ] **Step 2: 写失败的测试**

不联网也能测两件真正会坑人的事：地址没配时的错误话术，以及认证串写坏时不静默通过。

Create `src/lib/graphknowledge/client.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { GraphKnowledgeClient, gkSettings } from "./client";
import { GraphKnowledgeUnavailable } from "./errors";

const KEYS = [
  "TKOS_GRAPHKNOWLEDGE_BASE_URL",
  "TKOS_GRAPHKNOWLEDGE_AUTH",
  "TKOS_GRAPHKNOWLEDGE_VERIFY_TLS",
  "TKOS_GRAPHKNOWLEDGE_MOCK",
  "TKOS_GRAPHKNOWLEDGE_VIEWER",
] as const;

let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  for (const k of KEYS) delete process.env[k];
});

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("gkSettings", () => {
  it("什么都没配时给出空地址与默认 viewer，且不抛异常", () => {
    const s = gkSettings();
    expect(s.baseUrl).toBe("");
    expect(s.auth).toBeNull();
    expect(s.verifyTls).toBe(true);
    expect(s.viewer).toBe("PSN-01");
  });

  it("地址末尾的斜杠去掉 —— 否则拼出来是 //api/v1/...", () => {
    process.env.TKOS_GRAPHKNOWLEDGE_BASE_URL = "https://example.test/graph//";
    expect(gkSettings().baseUrl).toBe("https://example.test/graph");
  });

  it("AUTH 不是 user:password 形式时按未配置处理，并留下告警", () => {
    process.env.TKOS_GRAPHKNOWLEDGE_AUTH = "只有用户名";
    const s = gkSettings();
    expect(s.auth).toBeNull();
    expect(s.warnings.join()).toContain("user:password");
  });

  it("拆 AUTH 只按第一个冒号切 —— 密码里可以有冒号", () => {
    process.env.TKOS_GRAPHKNOWLEDGE_AUTH = "reader:a:b:c";
    expect(gkSettings().auth).toEqual({ user: "reader", password: "a:b:c" });
  });

  it("关掉 TLS 校验必须留告警 —— 不能变成一个没人记得的开关", () => {
    process.env.TKOS_GRAPHKNOWLEDGE_VERIFY_TLS = "0";
    const s = gkSettings();
    expect(s.verifyTls).toBe(false);
    expect(s.warnings.join()).toContain("不防中间人");
  });

  it("MOCK=1 本轮没实现，要说出来而不是假装图谱是假的", () => {
    process.env.TKOS_GRAPHKNOWLEDGE_MOCK = "1";
    expect(gkSettings().warnings.join()).toContain("本轮未实现");
  });
});

describe("GraphKnowledgeClient", () => {
  it("没配地址时说「地址是空的」，而不是报一个像服务掉了的底层错", async () => {
    const client = new GraphKnowledgeClient(gkSettings());
    await expect(client.entity("ISS-D6")).rejects.toThrow(GraphKnowledgeUnavailable);
    await expect(client.entity("ISS-D6")).rejects.toThrow(/地址是空的/);
  });
});
```

- [ ] **Step 3: 跑测试确认它失败**

Run: `npx vitest run src/lib/graphknowledge/client.test.ts`
Expected: FAIL —— `Failed to resolve import "./client"`

- [ ] **Step 4: 写 client.ts**

Create `src/lib/graphknowledge/client.ts`:

```ts
/**
 * 对齐自 tkos-lab/src/tkos_lab/graphknowledge/client.py
 *
 * GraphKnowledge M7 只读 API 客户端：只暴露 P0/P1/P2/P3 与 /healthz，
 * **不包含任何写方法**。
 *
 * 用 `undici.request` 而不是全局 `fetch`：图服务是 IP + 自签证书，关校验只能
 * 靠自带 dispatcher（`fetch` 的选项里没有 `rejectUnauthorized`）。顺带绕开
 * Next.js 给全局 `fetch` 打的缓存补丁 —— 本体读的是「此刻的公司状态」，被缓存
 * 住的表现是快照冻结失效，而屏幕上看不出来。
 */
import { Agent, request } from "undici";

import {
  GraphKnowledgeNotFound,
  GraphKnowledgeRejected,
  GraphKnowledgeUnavailable,
} from "./errors";

const GK_TIMEOUT_MS = 30_000;

export type GkSettings = {
  baseUrl: string;
  auth: { user: string; password: string } | null;
  verifyTls: boolean;
  viewer: string;
  /** 环境变量的解析问题。**不抛** —— 一个解析失败会让模块导入失败，表现是每条路由都 500。 */
  warnings: string[];
};

export function gkSettings(): GkSettings {
  const warnings: string[] = [];

  const baseUrl = (process.env.TKOS_GRAPHKNOWLEDGE_BASE_URL ?? "").trim().replace(/\/+$/, "");

  const authRaw = (process.env.TKOS_GRAPHKNOWLEDGE_AUTH ?? "").trim();
  let auth: GkSettings["auth"] = null;
  if (authRaw) {
    // 只按第一个冒号切：密码里带冒号是常事，切在最后一个会把密码劈成两半，
    // 表现是 401——而变量明明配了，排查会从「服务不认这把凭据」开始猜。
    const i = authRaw.indexOf(":");
    if (i > 0) auth = { user: authRaw.slice(0, i), password: authRaw.slice(i + 1) };
    else warnings.push("TKOS_GRAPHKNOWLEDGE_AUTH 不是 user:password 形式，本次按未配置处理");
  }

  const verifyTls = (process.env.TKOS_GRAPHKNOWLEDGE_VERIFY_TLS ?? "1").trim() !== "0";
  if (!verifyTls) {
    warnings.push(
      "TKOS_GRAPHKNOWLEDGE_VERIFY_TLS=0：这条链路不校验证书，不防中间人。" +
        "图服务换成域名 + 正式证书之后要把它去掉。"
    );
  }

  if ((process.env.TKOS_GRAPHKNOWLEDGE_MOCK ?? "").trim() === "1") {
    warnings.push(
      "TKOS_GRAPHKNOWLEDGE_MOCK=1 本轮未实现（正式版不带图谱 mock），本次仍连真实服务"
    );
  }

  return {
    baseUrl,
    auth,
    verifyTls,
    viewer: (process.env.TKOS_GRAPHKNOWLEDGE_VIEWER ?? "").trim() || "PSN-01",
    warnings,
  };
}

export type GkVersion = {
  index?: number;
  status?: string;
  at?: string;
  statement?: string;
  meetingLabel?: string;
};

export type GkEntity = {
  code?: string;
  label?: string;
  properties?: Record<string, unknown>;
  relations?: Record<string, string[]>;
  versions?: GkVersion[];
};

export type GkSeed = { code?: string; type?: string; score?: number };

export type GkDynamic = {
  query?: string;
  seeds?: GkSeed[];
  text?: string;
  /** 服务端自己报的降级（`query_embedding_not_cached` / `_failed`）。不是错误。 */
  warning?: string;
};

/**
 * 两个 dispatcher（校验 / 不校验）各缓存一个。每次请求新建 `Agent` 会把连接池
 * 也一起丢掉，连接复用没了，而症状只是「本体这一步有点慢」。
 */
const agents = new Map<boolean, Agent>();

function agentFor(verifyTls: boolean): Agent {
  let a = agents.get(verifyTls);
  if (!a) {
    a = new Agent({
      connect: { rejectUnauthorized: verifyTls, timeout: GK_TIMEOUT_MS },
      headersTimeout: GK_TIMEOUT_MS,
      bodyTimeout: GK_TIMEOUT_MS,
    });
    agents.set(verifyTls, a);
  }
  return a;
}

export class GraphKnowledgeClient {
  readonly baseUrl: string;
  readonly viewer: string;
  readonly warnings: string[];
  private readonly auth: GkSettings["auth"];
  private readonly verifyTls: boolean;

  constructor(settings: GkSettings = gkSettings()) {
    this.baseUrl = settings.baseUrl;
    this.viewer = settings.viewer;
    this.warnings = settings.warnings;
    this.auth = settings.auth;
    this.verifyTls = settings.verifyTls;
  }

  /** P0：公司经营状态。返回的是 Markdown 正文，不是 JSON。 */
  async staticContext(opts: { viewer: string; asOf: string }): Promise<string> {
    const { body } = await this.get("/api/v1/context/static", {
      viewer: opts.viewer,
      as_of: opts.asOf,
    });
    return body;
  }

  /** P1：实体当前版。 */
  async entity(code: string): Promise<GkEntity> {
    const r = await this.get(`/api/v1/entities/${encodeURIComponent(code)}`, { view: "latest" });
    return asObject(r.body, code) as GkEntity;
  }

  /** P2：实体版本链。 */
  async chain(code: string): Promise<GkEntity> {
    const r = await this.get(`/api/v1/entities/${encodeURIComponent(code)}`, { view: "chain" });
    return asObject(r.body, code) as GkEntity;
  }

  /** P3：语义召回。`query` 必须已经过 `clip()` —— 超 100 字服务端直接 422。 */
  async dynamic(query: string, opts: { k: number; budget: number }): Promise<GkDynamic> {
    const r = await this.get("/api/v1/context/dynamic", {
      q: query,
      k: opts.k,
      budget: opts.budget,
    });
    return asObject(r.body, "dynamic") as GkDynamic;
  }

  async health(): Promise<Record<string, unknown>> {
    const r = await this.get("/healthz", {});
    return asObject(r.body, "healthz");
  }

  private async get(
    path: string,
    params: Record<string, string | number>
  ): Promise<{ status: number; body: string }> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = { accept: "application/json, text/plain, */*" };
    if (this.auth) {
      const raw = `${this.auth.user}:${this.auth.password}`;
      headers.authorization = `Basic ${Buffer.from(raw, "utf8").toString("base64")}`;
    }
    const qs = new URLSearchParams(
      Object.entries(params).map(([k, v]) => [k, String(v)])
    ).toString();

    let status: number;
    let body: string;
    try {
      const res = await request(qs ? `${url}?${qs}` : url, {
        method: "GET",
        headers,
        dispatcher: agentFor(this.verifyTls),
      });
      status = res.statusCode;
      body = await res.body.text();
    } catch (e) {
      /*
       * 一定要带上目标 URL：只报底层 errno 的话，连是地址没配、服务没起还是
       * 网络不通都分不出来，排查得从头猜起。
       *
       * 判空要判 `this.baseUrl` 本身，不能判拼完的 url —— 没配地址时拼出来是
       * "/api/v1/context/dynamic"，非空，于是这句提示永远走不到，现场只剩一个
       * 相对路径加一句 Invalid URL，看着像服务掉了。这两件事要做的完全不同。
       */
      const target = this.baseUrl
        ? url
        : `${path}（没配 TKOS_GRAPHKNOWLEDGE_BASE_URL，地址是空的，这个请求压根没发出去）`;
      throw new GraphKnowledgeUnavailable(
        `GraphKnowledge 不可达（${errName(e)}）：${errMsg(e)}　目标 ${target}`,
        {
          url,
          baseUrl: this.baseUrl,
          errorType: errName(e),
          error: errMsg(e),
          hint:
            "确认 TKOS_GRAPHKNOWLEDGE_BASE_URL 指向真实服务；" +
            "自签证书报 SSL 错时设 TKOS_GRAPHKNOWLEDGE_VERIFY_TLS=0",
        }
      );
    }

    const detail = parseDetail(body);
    if (status === 401 || status === 403) {
      // 认证问题跟「服务挂了」完全是两条排查路径，不能都报成不可达。
      throw new GraphKnowledgeUnavailable(
        `GraphKnowledge 拒绝认证（${status}）：TKOS_GRAPHKNOWLEDGE_AUTH ` +
          `${this.auth ? "不被接受" : "没配"}`,
        { ...detail, authConfigured: this.auth !== null }
      );
    }
    if (status === 404) {
      const tail = path.split("/").pop() ?? path;
      throw new GraphKnowledgeNotFound(
        `GraphKnowledge 锚点不存在: ${decodeURIComponent(tail)}`,
        detail
      );
    }
    if (status === 400 || status === 422) {
      throw new GraphKnowledgeRejected(`GraphKnowledge 拒绝请求（${status}）`, detail);
    }
    if (status >= 400) {
      throw new GraphKnowledgeUnavailable(`GraphKnowledge 返回 ${status}`, detail);
    }
    return { status, body };
  }
}

const errName = (e: unknown): string =>
  e instanceof Error ? e.constructor.name : typeof e;

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

function asObject(body: string, code: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    throw new GraphKnowledgeUnavailable("GraphKnowledge 返回的不是合法 JSON", {
      code,
      body: body.slice(0, 500),
    });
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new GraphKnowledgeUnavailable("GraphKnowledge 返回结构不是对象", { code });
  }
  return value as Record<string, unknown>;
}

/** 错误现场：服务端的应答正文常常是唯一说得清原因的地方，能解析就带结构，不能就带前 500 字。 */
function parseDetail(body: string): Record<string, unknown> {
  try {
    const value = JSON.parse(body);
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
    return { body: value };
  } catch {
    return { body: body.slice(0, 500) };
  }
}
```

- [ ] **Step 5: 跑测试确认通过**

Run: `npx vitest run src/lib/graphknowledge/client.test.ts`
Expected: PASS，7 个用例全绿

- [ ] **Step 6: 类型检查与 lint**

Run: `npx tsc --noEmit && npx eslint src/lib/graphknowledge/client.ts src/lib/graphknowledge/client.test.ts`
Expected: 无输出

- [ ] **Step 7: Commit**

```bash
git add package.json pnpm-lock.yaml src/lib/graphknowledge/client.ts src/lib/graphknowledge/client.test.ts
git commit -m "M7 只读客户端：自签证书走自带 dispatcher，没配地址时说没配地址"
```

---

### Task 3: 按问题自动定锚点

**Files:**
- Create: `src/lib/graphknowledge/lookup.ts`
- Test: `src/lib/graphknowledge/lookup.test.ts`

**Interfaces:**
- Consumes: `GraphKnowledgeClient` / `GkSeed` / `GraphKnowledgeError`（Task 1、2）、`clip` / `P3_MAX_QUERY_CHARS`（Task 1）
- Produces:
  - `type Channel = "A1a" | "A3" | "A4"`，`type AnchorPrefix = "CARD-" | "ISS-"`
  - `const PREFIX: Record<Channel, AnchorPrefix>`、`MAX_CANDIDATES` / `TIE_RATIO` / `FLAT_RATIO` / `FLAT_MIN_SEEDS`
  - `type Pool = { n: number; topScore: number; bottomScore: number; topCode: string; flatness: number | null }`
  - `function poolOf(seeds: GkSeed[]): Pool`
  - `function noMatchReason(top: { code: string; score?: number }, pool: Pool): string`
  - `type Candidate = { code: string; type?: string; score?: number; label: string; state: string; rankOverall: number }`
  - `type AnchorPick = { origin: "auto"; anchorCode: string; score?: number; label: string; state: string; channel: Channel; prefix: AnchorPrefix; rank: 1; rankOverall: number; k: number; ambiguous: boolean; pool: Pool; querySent: string; runnersUp: { code: string; score?: number; label: string }[]; warnings: string[] }`
  - `async function autopick(query: string, channel: Channel, client?: GraphKnowledgeClient): Promise<AnchorPick>` —— throws `AnchorNotFound` / `GraphKnowledgeUnavailable`
  - `async function findAnchors(query: string, channel: Channel, opts?: { client?: GraphKnowledgeClient; limit?: number }): Promise<SearchResult & { unavailable?: true }>`

- [ ] **Step 1: 写失败的测试**

两条相对规则是整套锚点逻辑里唯一「改了不报错、只让结果越来越差」的地方，所以单测只盯纯函数。

Create `src/lib/graphknowledge/lookup.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import {
  FLAT_MIN_SEEDS,
  FLAT_RATIO,
  MAX_CANDIDATES,
  PREFIX,
  TIE_RATIO,
  noMatchReason,
  poolOf,
} from "./lookup";

describe("阈值常量", () => {
  it("逐字对齐实验台 —— 这些是相对比例，换 embedding 模型仍然成立", () => {
    expect(MAX_CANDIDATES).toBe(8);
    expect(TIE_RATIO).toBe(0.95);
    expect(FLAT_RATIO).toBe(0.9);
    expect(FLAT_MIN_SEEDS).toBe(4);
  });

  it("每个频道只接受一种锚点：A1a 从信号出发，A3/A4 从议题出发", () => {
    expect(PREFIX).toEqual({ "A1a": "CARD-", A3: "ISS-", A4: "ISS-" });
  });
});

describe("poolOf", () => {
  it("空池不算平坦度 —— 除零得不出结论", () => {
    expect(poolOf([])).toEqual({ n: 0, topScore: 0, bottomScore: 0, topCode: "", flatness: null });
  });

  it("平坦度是最低分/最高分，留四位", () => {
    const p = poolOf([{ code: "A", score: 0.3 }, { code: "B", score: 0.2 }]);
    expect(p.topCode).toBe("A");
    expect(p.flatness).toBe(0.6667);
  });
});

describe("noMatchReason", () => {
  it("整池拉不开 → 没有对应议题（问「VPN 部署在哪」时是这种）", () => {
    const seeds = [
      { code: "ISS-1", score: 0.299 },
      { code: "DOC-1", score: 0.29 },
      { code: "CARD-1", score: 0.285 },
      { code: "PSN-1", score: 0.278 },
    ];
    const why = noMatchReason({ code: "ISS-1", score: 0.299 }, poolOf(seeds));
    expect(why).toContain("拉不开");
    expect(why).toContain("4 条种子");
  });

  it("池子太小不做平坦判定 —— 两三条种子的首末比天然就高", () => {
    const seeds = [{ code: "ISS-1", score: 0.3 }, { code: "DOC-1", score: 0.29 }];
    expect(noMatchReason({ code: "ISS-1", score: 0.3 }, poolOf(seeds))).toBe("");
  });

  it("池子拉得开但议题只是陪跑 → 也算没有对应议题", () => {
    const seeds = [
      { code: "DOC-1", score: 0.7 },
      { code: "ISS-1", score: 0.31 },
      { code: "PSN-1", score: 0.3 },
      { code: "CARD-1", score: 0.29 },
    ];
    const why = noMatchReason({ code: "ISS-1", score: 0.31 }, poolOf(seeds));
    expect(why).toContain("不在全体首名");
    expect(why).toContain("DOC-1");
  });

  it("议题本身就是全体首名 → 有对应议题", () => {
    const seeds = [
      { code: "ISS-1", score: 0.82 },
      { code: "DOC-1", score: 0.4 },
      { code: "PSN-1", score: 0.31 },
      { code: "CARD-1", score: 0.3 },
    ];
    expect(noMatchReason({ code: "ISS-1", score: 0.82 }, poolOf(seeds))).toBe("");
  });
});
```

- [ ] **Step 2: 跑测试确认它失败**

Run: `npx vitest run src/lib/graphknowledge/lookup.test.ts`
Expected: FAIL —— `Failed to resolve import "./lookup"`

- [ ] **Step 3: 写 lookup.ts**

Create `src/lib/graphknowledge/lookup.ts`:

```ts
/**
 * 对齐自 tkos-lab/src/tkos_lab/graphknowledge/lookup.py
 *
 * 按自然语言问题找锚点。上游给的是一句问题（正式版是 `issue.statement`），
 * 不是编号 —— 让人去背 `ISS-D6` 这种编码既不现实，也会把「这次跑哪个议题」
 * 变成一件容易填错、且填错了看不出来的事。
 *
 * 自动选并不等于不可见：选中的编号、分数、以及**落选的次名**都进 trace 和
 * 结果页。次名咬得很紧说明这句问题本身指向不清，自检会标出来由人判断 ——
 * 而不是悄悄用一条「差不多」的议题去装配上下文。
 *
 * `autopick` 有三种结局，三种必须分开：
 *   ① 命中       —— 返回锚点记录，正常装配上下文
 *   ② 图里没有   —— `AnchorNotFound`。**这不是故障**，调用方改走纯外部
 *   ③ 服务不可用 —— `GraphKnowledgeUnavailable` 原样抛出，**绝不能**折成 ②
 *
 * `findAnchors` 是给排查/浏览用的，服务不可用时也得有个返回值，所以它**吞**
 * 异常。autopick 走的是内部 `search`，不吞。
 */
import type { GkSeed, GraphKnowledgeClient } from "./client";
import { GraphKnowledgeClient as Client } from "./client";
import { AnchorNotFound, GraphKnowledgeError } from "./errors";
import { P3_MAX_QUERY_CHARS, clip } from "./limits";

export type Channel = "A1a" | "A3" | "A4";
export type AnchorPrefix = "CARD-" | "ISS-";

/** 每个频道只接受一种锚点：A1a 从信号出发，A3/A4 从议题出发。 */
export const PREFIX: Record<Channel, AnchorPrefix> = {
  "A1a": "CARD-",
  A3: "ISS-",
  A4: "ISS-",
};

export const MAX_CANDIDATES = 8;

/**
 * 次名分数达到首名的这个比例，就当「同一档」。**这不是相关性阈值** —— 不是说
 * 0.95 以下就不相关，而是「同一个打分器分不开这两条」。所以它是相对值，换个
 * embedding 模型仍然成立；绝对阈值换个模型就废了。
 */
export const TIE_RATIO = 0.95;

/**
 * 全体种子里最低分达到最高分的这个比例，就当这个池子「拉不开」。
 *
 * 为什么需要它：P3 几乎总会返回点什么。问「VPN 服务器部署在新加坡还是香港」，
 * 图谱照样回 8 条，只是全挤在 0.278–0.299 里 —— 里面恰好有条 ISS-*，于是就会
 * 拿它当锚点，A4 接着按一条毫不相干的议题跑完全程。分布拉不开的意思是「打分
 * 器认为这句话跟库里每样东西都一样远」，那就是没有对应议题。
 */
export const FLAT_RATIO = 0.9;

/** 池子太小时分布没有意义（两三条种子的首末比天然就高），不做平坦判定。 */
export const FLAT_MIN_SEEDS = 4;

export type Pool = {
  n: number;
  topScore: number;
  bottomScore: number;
  topCode: string;
  flatness: number | null;
};

const scoreOf = (s: GkSeed): number => s.score ?? 0;
const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;

/** 全体种子（不按前缀过滤）的分布。判「有没有对应议题」要看整池。 */
export function poolOf(seeds: GkSeed[]): Pool {
  const scores = seeds.map(scoreOf);
  const topScore = scores.length ? Math.max(...scores) : 0;
  const bottomScore = scores.length ? Math.min(...scores) : 0;
  return {
    n: seeds.length,
    topScore,
    bottomScore,
    topCode: String(seeds.find((s) => scoreOf(s) === topScore)?.code ?? ""),
    flatness: topScore ? round4(bottomScore / topScore) : null,
  };
}

/**
 * 这句问题在图谱里到底有没有对应议题？返回空字符串表示有。
 *
 * 两条规则任一命中就算没有，两条是互补的：
 *   · 池子拉不开 —— 打分器认为这句话跟库里每样东西都一样远
 *   · 不在同一档 —— 池子拉得开，但图谱认为有别的东西明显更贴近，最高的议题
 *                   只是陪跑（问某份文档里的细节时是这种）
 *
 * 只用前者会漏掉后者：某份 Document 0.7、其余 0.3，池子不平，但最高的 ISS-*
 * 只有 0.31。只用后者会漏掉前者：整池都挤在一起时，谁跟谁都「同一档」。
 *
 * 两个常数都是**相对**的（比例，不是分数）。实测值一律进 trace，误判了直接调常数。
 */
export function noMatchReason(top: { code: string; score?: number }, pool: Pool): string {
  const flat = pool.flatness;
  if (flat !== null && pool.n >= FLAT_MIN_SEEDS && flat >= FLAT_RATIO) {
    return (
      `P3 这一池 ${pool.n} 条种子的分数拉不开（最低/最高 = ${flat}，≥${FLAT_RATIO}），` +
      `说明打分器认为这句问题跟库里每样东西都一样远`
    );
  }
  const score = top.score ?? 0;
  if (pool.topScore && score / pool.topScore < TIE_RATIO) {
    return (
      `最贴近的 ${top.code}（${score}）不在全体首名 ${pool.topCode}（${pool.topScore}）的同一档里` +
      `（比值 ${round4(score / pool.topScore)} < ${TIE_RATIO}），图谱认为更贴近这句问题的不是一条议题`
    );
  }
  return "";
}

export type Candidate = {
  code: string;
  type?: string;
  score?: number;
  label: string;
  state: string;
  /** 在**全体**种子里排第几。判「这句问题是不是在问某条议题」看的是这个，
   *  而不是它在同前缀里排第几 —— 同前缀里它总是第一。 */
  rankOverall: number;
};

export type SearchResult = {
  candidates: Candidate[];
  prefix: AnchorPrefix;
  warnings: string[];
  pool: Pool;
  query: string;
  querySent: string;
  degraded: string;
};

/** 跑一次 P3，按前缀筛候选。**服务不可用时原样抛出。** */
async function search(
  query: string,
  prefix: AnchorPrefix,
  opts: { client?: GraphKnowledgeClient; limit: number }
): Promise<SearchResult> {
  const q = (query ?? "").trim();
  if (!q) {
    return {
      candidates: [],
      prefix,
      warnings: ["问题为空，无法检索"],
      pool: poolOf([]),
      query: q,
      querySent: q,
      degraded: "",
    };
  }

  /*
   * 送进 P3 的必须是裁过的：一条真实信号有两三百字，而 q 的服务端上限是 100
   * 字符，超了整个请求 422。裁过这件事进 warnings —— 「按前 100 字选的锚点」
   * 和「按整条信号选的锚点」不是一回事，人得看得见。
   */
  const sent = clip(q);
  const gk = opts.client ?? new Client();
  const warnings: string[] = [];
  if (sent !== q) {
    warnings.push(
      `P3 的 q 上限 ${P3_MAX_QUERY_CHARS} 字符，原文 ${q.length} 字，` +
        `本次按前 ${sent.length} 字检索：${sent}`
    );
  }

  const result = await gk.dynamic(sent, { k: MAX_CANDIDATES, budget: 2000 });
  if (result.warning) warnings.push(String(result.warning));

  const everything = [...(result.seeds ?? [])].sort((a, b) => scoreOf(b) - scoreOf(a));
  const pool = poolOf(everything);
  const codes = everything.map((s) => String(s.code ?? ""));

  const candidates: Candidate[] = [];
  const matched = everything
    .filter((s) => String(s.code ?? "").startsWith(prefix))
    .slice(0, opts.limit);
  for (const s of matched) {
    const code = String(s.code);
    const item: Candidate = {
      code,
      type: s.type,
      score: s.score,
      label: "",
      state: "",
      rankOverall: codes.indexOf(code) + 1,
    };
    try {
      // 补标题；失败只记告警，不影响其余候选 —— 只有编号的候选对人是不可判断的。
      const ent = await gk.entity(code);
      item.label = ent.label ?? "";
      item.state = String((ent.properties ?? {}).state ?? "");
    } catch (e) {
      if (!(e instanceof GraphKnowledgeError)) throw e;
      warnings.push(`${code} 取不到标题`);
    }
    candidates.push(item);
  }

  if (!candidates.length) {
    warnings.push(
      `P3 没有返回 ${prefix}* 候选——可能这个问题在库里还没有对应议题，` +
        `或 embedding 检索被降级。可以直接手工填写锚点。`
    );
  }

  /*
   * 一条种子都没回、而且服务端自己报了 warning：这是**检索没跑出来**，不是
   * 「库里没有对应议题」。两者的结论完全相反，不能共用一句话（真实服务上对
   * 新问题会回 query_embedding_failed，池子是空的而不是拉不开的）。
   */
  const degraded = everything.length ? "" : String(result.warning ?? "");

  return { candidates, prefix, warnings, pool, query: q, querySent: sent, degraded };
}

/**
 * 排查/浏览用：列出候选，服务不可用也要有个返回值，所以异常被吞成 `unavailable`。
 * harness 不走这条，走 `autopick`。
 */
export async function findAnchors(
  query: string,
  channel: Channel,
  opts: { client?: GraphKnowledgeClient; limit?: number } = {}
): Promise<SearchResult & { unavailable?: true }> {
  const prefix = PREFIX[channel];
  try {
    return await search(query, prefix, { client: opts.client, limit: opts.limit ?? 5 });
  } catch (e) {
    if (!(e instanceof GraphKnowledgeError)) throw e;
    const q = (query ?? "").trim();
    return {
      candidates: [],
      prefix,
      warnings: [`${e.name}: ${e.message}`],
      pool: poolOf([]),
      query: q,
      querySent: clip(q),
      degraded: "",
      unavailable: true,
    };
  }
}

export type AnchorPick = {
  origin: "auto";
  anchorCode: string;
  score?: number;
  label: string;
  state: string;
  channel: Channel;
  prefix: AnchorPrefix;
  rank: 1;
  rankOverall: number;
  k: number;
  /** 次名咬得紧：这句问题指向不唯一。**只提示不拦截**，由人判断。 */
  ambiguous: boolean;
  pool: Pool;
  querySent: string;
  runnersUp: { code: string; score?: number; label: string }[];
  warnings: string[];
};

/**
 * harness 用：按问题定这次运行的锚点。
 *
 * 取 P3 里该频道前缀下分数最高的一条，但**要先过「这句问题在图谱里到底有没有
 * 对应议题」这一关**（见 `noMatchReason`）。过不了就抛 `AnchorNotFound`，不允许
 * 「随便挑一个凑合」：上下文装错了议题，产出看着仍然合理，而错误的方向会被当成
 * prompt 的问题去改。
 */
export async function autopick(
  query: string,
  channel: Channel,
  client?: GraphKnowledgeClient
): Promise<AnchorPick> {
  const prefix = PREFIX[channel];
  const r = await search(query, prefix, { client, limit: 3 });
  const cands = r.candidates;
  const top = cands[0];

  let why: string;
  if (r.degraded) {
    why =
      `P3 这一次没算出检索结果（服务端 warning：${r.degraded}），` +
      `一条种子都没回，锚点无从选起`;
  } else if (!top) {
    why = `P3 没有返回任何 ${prefix}* 候选`;
  } else {
    why = noMatchReason(top, r.pool);
  }

  if (why) {
    /*
     * 「检索没跑出来」和「图谱里还没有这条议题」的结论相反：后者说明这条输入
     * 对公司现有方向来说太新，前者只说明这一次没检索成功。混成一句话会让人把
     * 一次检索故障读成一个战略判断。
     */
    const tail = r.degraded
      ? "检索没跑出来时**不能**读作「图谱里没有这条议题」——这一次拿不到公司上下文，但它不是关于这条输入的判断。"
      : "这不代表这个问题与战略无关——可能它对公司战略方向来说还太新。";
    throw new AnchorNotFound(
      `按这条问题在 GraphKnowledge 里找不到 ${prefix}* 锚点：${why}。${tail}`,
      {
        query,
        querySent: r.querySent,
        channel,
        prefix,
        why,
        degraded: r.degraded,
        pool: r.pool,
        bestEffort: top ?? null,
        warnings: r.warnings,
      }
    );
  }

  const rest = cands.slice(1);
  const s1 = top.score;
  const s2 = rest[0]?.score;
  const ambiguous = Boolean(s1 && s2 && s2 / s1 >= TIE_RATIO);

  return {
    origin: "auto",
    anchorCode: top.code,
    score: s1,
    label: top.label,
    state: top.state,
    channel,
    prefix,
    rank: 1,
    rankOverall: top.rankOverall,
    k: MAX_CANDIDATES,
    ambiguous,
    pool: r.pool,
    querySent: r.querySent,
    runnersUp: rest.map((c) => ({ code: c.code, score: c.score, label: c.label })),
    warnings: r.warnings,
  };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/lib/graphknowledge/lookup.test.ts`
Expected: PASS，7 个用例全绿

- [ ] **Step 5: 类型检查与 lint**

Run: `npx tsc --noEmit && npx eslint src/lib/graphknowledge/lookup.ts src/lib/graphknowledge/lookup.test.ts`
Expected: 无输出

- [ ] **Step 6: Commit**

```bash
git add src/lib/graphknowledge/lookup.ts src/lib/graphknowledge/lookup.test.ts
git commit -m "锚点自动选：两条相对规则判「图里没有对应议题」，检索没跑出来不读作没有"
```

---

### Task 4: S01/S02/S03 三配方装配

**Files:**
- Create: `src/lib/graphknowledge/recipes.ts`
- Test: `src/lib/graphknowledge/recipes.test.ts`

**Interfaces:**
- Consumes: `GraphKnowledgeClient` / `GkDynamic` / `GkEntity` / `GkVersion`（Task 2）、`clip`（Task 1）
- Produces:
  - `const MAX_CONTEXT_CHARS = 16_000`
  - `type Recipe = "S01" | "S02" | "S03"`
  - `type GkCall = { point: "P0" | "P1" | "P2" | "P3"; path: string } & Record<string, unknown>`
  - `type ContextBundle = { query: string; recipe: Recipe; anchorCode: string; renderedMarkdown: string; memberIds: string[]; calls: GkCall[]; warnings: string[]; viewer: string; asOf: string; sourceBaseUrl: string }`
  - `function bundleSummary(b: ContextBundle): { recipe: Recipe; anchorCode: string; members: number; calls: number; warnings: number; renderedChars: number }`
  - `function finish(parts: string[]): string`
  - `async function buildS01(client, signalCode, { query, viewer, asOf }): Promise<ContextBundle>`
  - `async function buildS02(client, issueCode, { query, viewer, asOf }): Promise<ContextBundle>`
  - `async function buildS03(client, issueCode, { coreQuestion, viewer, asOf }): Promise<ContextBundle>`

- [ ] **Step 1: 写失败的测试**

Create `src/lib/graphknowledge/recipes.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { MAX_CONTEXT_CHARS, finish } from "./recipes";

describe("上下文总预算", () => {
  it("上限逐字对齐实验台", () => {
    expect(MAX_CONTEXT_CHARS).toBe(16_000);
  });

  it("没超预算就原样拼，段间空一行", () => {
    expect(finish(["甲", "乙"])).toBe("甲\n\n乙");
  });

  it("超了就截断，并且**说出来** —— 悄悄少一段会被读成「图里就这么点东西」", () => {
    const out = finish(["头", "尾".repeat(MAX_CONTEXT_CHARS)]);
    expect(out.length).toBeLessThanOrEqual(MAX_CONTEXT_CHARS);
    expect(out.endsWith("（上下文超过总预算，末段已截断）")).toBe(true);
  });

  it("截断处的尾随空白去掉 —— 否则后缀前面会挂一串空格", () => {
    const filler = "丙".repeat(MAX_CONTEXT_CHARS - 40) + " ".repeat(30);
    const out = finish([filler, "丁".repeat(100)]);
    expect(out).not.toMatch(/\s\n\n（上下文超过总预算/);
  });
});
```

- [ ] **Step 2: 跑测试确认它失败**

Run: `npx vitest run src/lib/graphknowledge/recipes.test.ts`
Expected: FAIL —— `Failed to resolve import "./recipes"`

- [ ] **Step 3: 写 recipes.ts**

Create `src/lib/graphknowledge/recipes.ts`:

```ts
/**
 * 对齐自 tkos-lab/src/tkos_lab/graphknowledge/recipes.py
 *
 * GraphKnowledge M7 的 S01/S02/S03 Agent 侧上下文装配。三配方的 P3 参数是**固定
 * 的**，不受思考深度影响：深度只驱动 harness 自己的研究规模，改 P3 的 k/budget
 * 会让「同一个议题、不同深度」拿到不同的公司上下文，两次结果就不可比了。
 */
import type { GkDynamic, GkEntity, GkVersion, GraphKnowledgeClient } from "./client";
import { clip } from "./limits";

export const MAX_CONTEXT_CHARS = 16_000;

export type Recipe = "S01" | "S02" | "S03";

/** 这次装配打了哪些端点。进 trace，是复现的一部分。 */
export type GkCall = { point: "P0" | "P1" | "P2" | "P3"; path: string } & Record<string, unknown>;

export type ContextBundle = {
  query: string;
  recipe: Recipe;
  anchorCode: string;
  renderedMarkdown: string;
  /** 这次装配摸到的所有实体编号。A3 的「引用 ID 真实」自检拿它当白名单。 */
  memberIds: string[];
  calls: GkCall[];
  warnings: string[];
  viewer: string;
  asOf: string;
  sourceBaseUrl: string;
};

export function bundleSummary(b: ContextBundle) {
  return {
    recipe: b.recipe,
    anchorCode: b.anchorCode,
    members: b.memberIds.length,
    calls: b.calls.length,
    warnings: b.warnings.length,
    renderedChars: b.renderedMarkdown.length,
  };
}

class Builder {
  readonly members = new Set<string>();
  readonly calls: GkCall[] = [];
  readonly warnings: string[] = [];

  constructor(
    private readonly client: GraphKnowledgeClient,
    private readonly meta: {
      query: string;
      recipe: Recipe;
      anchorCode: string;
      viewer: string;
      asOf: string;
    }
  ) {}

  async p0(): Promise<string> {
    this.calls.push({
      point: "P0",
      path: "/api/v1/context/static",
      viewer: this.meta.viewer,
      as_of: this.meta.asOf,
    });
    return this.client.staticContext({ viewer: this.meta.viewer, asOf: this.meta.asOf });
  }

  async p1(code: string): Promise<GkEntity> {
    this.calls.push({ point: "P1", path: `/api/v1/entities/${code}`, view: "latest" });
    const card = await this.client.entity(code);
    this.addCard(card);
    return card;
  }

  async p2(code: string): Promise<GkEntity> {
    this.calls.push({ point: "P2", path: `/api/v1/entities/${code}`, view: "chain" });
    const chain = await this.client.chain(code);
    this.addCard(chain);
    return chain;
  }

  async p3(query: string, k: number, budget: number): Promise<GkDynamic> {
    const q = clip(query);
    this.calls.push({ point: "P3", path: "/api/v1/context/dynamic", q, k, budget });
    const result = await this.client.dynamic(q, { k, budget });
    if (result.warning) this.warnings.push(String(result.warning));
    for (const seed of result.seeds ?? []) if (seed.code) this.members.add(String(seed.code));
    return result;
  }

  bundle(parts: string[]): ContextBundle {
    const text = finish(parts);
    // finish() 之后还超说明预算逻辑本身坏了。这时候宁可炸，也不要把一份超预算
    // 的上下文发给模型 —— 那会撞上模型侧的截断，报错话术完全指错方向。
    if (text.length > MAX_CONTEXT_CHARS) throw new Error("上下文总预算失效");
    return {
      query: this.meta.query,
      recipe: this.meta.recipe,
      anchorCode: this.meta.anchorCode,
      renderedMarkdown: text,
      memberIds: [...this.members].sort(),
      calls: this.calls,
      warnings: this.warnings,
      viewer: this.meta.viewer,
      asOf: this.meta.asOf,
      sourceBaseUrl: this.client.baseUrl,
    };
  }

  private addCard(card: GkEntity): void {
    if (card.code) this.members.add(String(card.code));
    for (const values of Object.values(card.relations ?? {})) {
      if (Array.isArray(values)) for (const v of values) if (v) this.members.add(String(v));
    }
  }
}

/** S01 Issue Framing：Signal → Issue → 被动摇判断。 */
export async function buildS01(
  client: GraphKnowledgeClient,
  signalCode: string,
  opts: { query: string; viewer: string; asOf: string }
): Promise<ContextBundle> {
  const b = new Builder(client, { ...opts, recipe: "S01", anchorCode: signalCode });
  const staticText = await b.p0();
  const signal = await b.p1(signalCode);

  const parts = [
    `【公司经营状态】\n${staticText}`,
    `【Signal 原文（照录，供「不复述」对照）】\n${signal.label ?? ""}\n` +
      textValue((signal.properties ?? {}).why, ""),
  ];

  const issues = (signal.relations ?? {}).spawns ?? [];
  const shaken: string[] = [];
  if (issues.length) {
    const issueLines: string[] = [];
    for (const issueCode of issues) {
      const issue = await b.p1(issueCode);
      const state = String((issue.properties ?? {}).state ?? "");
      issueLines.push(`${issueCode}「${issue.label ?? ""}」（${state}）`);
      for (const anchor of (issue.relations ?? {}).shakes ?? []) {
        const chain = await b.p2(anchor);
        const versions = chain.versions ?? [];
        const latest = versions[versions.length - 1];
        if (latest) {
          shaken.push(
            `${anchor} v${latest.index ?? "?"}（被 ${issueCode} 动摇）\n  ${latest.statement ?? ""}`
          );
        } else {
          shaken.push(`${anchor}（无版本链——首次形成）`);
        }
      }
    }
    parts.push(`【催生的议题】\n${issueLines.join("\n")}`);
  } else {
    parts.push("【催生的议题】\n（该信号尚未催生议题——本次调用即为此而来）");
  }

  parts.push(
    `【被动摇的在版判断】\n${shaken.length ? shaken.join("\n") : "（图内无被动摇的在版判断）"}`
  );
  parts.push(segSeeds(await b.p3(signal.label || opts.query, 5, 3000)));
  return b.bundle(parts);
}

/** S02 Pre-research：Issue → 当前判断/既有研究 → 轻量语义召回。 */
export async function buildS02(
  client: GraphKnowledgeClient,
  issueCode: string,
  opts: { query: string; viewer: string; asOf: string }
): Promise<ContextBundle> {
  const b = new Builder(client, { ...opts, recipe: "S02", anchorCode: issueCode });
  const staticText = await b.p0();
  const issue = await b.p1(issueCode);
  const props = issue.properties ?? {};

  const parts = [
    `【公司经营状态】\n${staticText}`,
    `【议题定义】\n${issueCode}「${issue.label ?? ""}」（${String(props.state ?? "")}）\n` +
      textValue(props.monitoringNote, ""),
  ];

  const anchors = (issue.relations ?? {}).hasJudgement ?? [];
  if (anchors.length) {
    const lines: string[] = [];
    for (const anchor of anchors) {
      const chain = await b.p2(anchor);
      const versions = chain.versions ?? [];
      const latest = versions[versions.length - 1];
      lines.push(
        latest
          ? `${anchor} v${latest.index ?? "?"}：${latest.statement ?? ""}`
          : `${anchor}（无版本链——首次形成）`
      );
      const card = await b.p1(anchor);
      const shakenBy = (card.relations ?? {}).shakenBy ?? [];
      if (shakenBy.length) lines.push(`  相邻动摇：${shakenBy.join("、")}`);
    }
    parts.push(`【当前在版判断】\n${lines.join("\n")}`);
  } else {
    parts.push("【当前在版判断】\n（尚无判断——首次形成）");
  }

  parts.push(await researchBlock(b, issue));
  parts.push(segSeeds(await b.p3(issue.label || opts.query, 3, 1200)));
  return b.bundle(parts);
}

/** S03 Strategic Deep Research：完整判断史、共识边界与双路召回。 */
export async function buildS03(
  client: GraphKnowledgeClient,
  issueCode: string,
  opts: { coreQuestion: string; viewer: string; asOf: string }
): Promise<ContextBundle> {
  const b = new Builder(client, {
    query: opts.coreQuestion,
    recipe: "S03",
    anchorCode: issueCode,
    viewer: opts.viewer,
    asOf: opts.asOf,
  });
  const staticText = await b.p0();
  const issue = await b.p1(issueCode);
  const props = issue.properties ?? {};

  const parts = [
    `【公司经营状态】\n${staticText}`,
    `【议题】\n${issueCode}「${issue.label ?? ""}」（${String(props.state ?? "")}）`,
  ];

  const anchors = (issue.relations ?? {}).hasJudgement ?? [];
  if (anchors.length) {
    const chains: string[] = [];
    for (const anchor of anchors) chains.push(renderVersions(await b.p2(anchor)));
    parts.push(`【判断演进链】\n${chains.join("\n\n")}`);
  } else {
    parts.push("【判断演进链】\n（尚无判断——首次形成）");
  }

  const agreements = (issue.relations ?? {}).resolvedBy ?? [];
  if (agreements.length) {
    const lines: string[] = [];
    for (const code of agreements) {
      const agreement = await b.p1(code);
      const ap = agreement.properties ?? {};
      lines.push(
        `${code}「${agreement.label ?? ""}」status=${String(ap.agreementStatus ?? "")}\n` +
          `结论：${textValue(ap.text)}\n边界：${textValue(ap.boundary)}`
      );
    }
    parts.push(`【既有共识与边界】\n${lines.join("\n\n")}`);
  } else {
    parts.push("【既有共识与边界】\n（议题未闭环）");
  }

  parts.push(await researchBlock(b, issue));
  parts.push(
    mergedSemantic([
      ["core question", await b.p3(opts.coreQuestion, 10, 6000)],
      ["议题标题", await b.p3(issue.label || opts.coreQuestion, 5, 3000)],
    ])
  );
  return b.bundle(parts);
}

export function textValue(value: unknown, empty = "（无）"): string {
  if (Array.isArray(value)) return value.map((x) => String(x)).join("\n") || empty;
  return value === null || value === undefined || value === "" ? empty : String(value);
}

async function researchBlock(builder: Builder, issue: GkEntity): Promise<string> {
  const codes = (issue.relations ?? {}).researchForOf ?? [];
  if (!codes.length) return "【既有研究】\n（图内无既有研究挂载）";
  const lines: string[] = [];
  for (const code of codes) {
    const doc = await builder.p1(code);
    lines.push(`${code}「${doc.label ?? ""}」\n${textValue((doc.properties ?? {}).text)}`);
  }
  return `【既有研究】\n${lines.join("\n\n")}`;
}

const seedLine = (s: { code?: string; type?: string; score?: number }): string =>
  `· ${s.code} [${s.type}] score=${(s.score ?? 0).toFixed(3)}`;

function segSeeds(result: GkDynamic): string {
  const query = result.query ?? "";
  const seeds = result.seeds ?? [];
  if (seeds.length) {
    return [`【语义召回】（q=${query}）`, ...seeds.map(seedLine), "", result.text ?? ""].join("\n");
  }
  // 语义段降级不是错误：P0/P1/P2 的确定性上下文照用。但必须写进正文 ——
  // 少一段而不说，模型会当成「图里没有相关材料」。
  const warning = result.warning || "无结果";
  return `【语义召回】（q=${query}）\n（语义段降级：${warning}，本次调用不含语义召回）`;
}

function mergedSemantic(routes: [string, GkDynamic][]): string {
  const best = new Map<string, { code?: string; type?: string; score?: number }>();
  for (const [, result] of routes) {
    for (const seed of result.seeds ?? []) {
      const code = seed.code;
      if (!code) continue;
      const prev = best.get(String(code));
      if (!prev || (seed.score ?? 0) > (prev.score ?? 0)) best.set(String(code), seed);
    }
  }
  const seeds = [...best.values()].sort(
    (a, b) => (b.score ?? 0) - (a.score ?? 0) || String(a.code).localeCompare(String(b.code))
  );
  const successful = routes.filter(([, r]) => (r.seeds ?? []).length);
  const warnings = routes
    .filter(([, r]) => !(r.seeds ?? []).length)
    .map(([label, r]) => `${label}: ${r.warning || "无结果"}`);

  if (!seeds.length) {
    return `【语义召回】\n（语义段降级：${warnings.join("；")}，本次调用不含语义召回）`;
  }

  const [selectedLabel, selected] = successful.reduce((acc, cur) =>
    (cur[1].seeds?.[0]?.score ?? 0) > (acc[1].seeds?.[0]?.score ?? 0) ? cur : acc
  );
  const lines = ["【语义召回 · 双路合并】", ...seeds.map(seedLine)];
  if (warnings.length) lines.push("", `降级：${warnings.join("；")}`);
  lines.push(
    "",
    `正文采用得分最高路由：${selectedLabel}（q=${selected.query ?? ""}）`,
    selected.text ?? ""
  );
  return lines.join("\n");
}

function renderVersions(chain: GkEntity): string {
  const versions = chain.versions ?? [];
  if (!versions.length) return `（锚点 ${chain.code} 无版本链——首次形成）`;
  const lines: string[] = [];
  for (const v of versions as GkVersion[]) {
    let head = `v${v.index}[${v.status ?? ""}] ${String(v.at ?? "").slice(0, 10)}`;
    if (v.meetingLabel) head += `（${v.meetingLabel}）`;
    lines.push(head, `  ${v.statement ?? ""}`);
  }
  return lines.join("\n");
}

export function finish(parts: string[]): string {
  const text = parts.join("\n\n");
  if (text.length <= MAX_CONTEXT_CHARS) return text;
  const suffix = "\n\n（上下文超过总预算，末段已截断）";
  return text.slice(0, MAX_CONTEXT_CHARS - suffix.length).replace(/\s+$/, "") + suffix;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/lib/graphknowledge/recipes.test.ts`
Expected: PASS，4 个用例全绿

- [ ] **Step 5: 类型检查与 lint**

Run: `npx tsc --noEmit && npx eslint src/lib/graphknowledge/recipes.ts src/lib/graphknowledge/recipes.test.ts`
Expected: 无输出

- [ ] **Step 6: Commit**

```bash
git add src/lib/graphknowledge/recipes.ts src/lib/graphknowledge/recipes.test.ts
git commit -m "S01/S02/S03 三配方装配：P3 参数按配方固定，超预算截断要说出来"
```

---

### Task 5: 上下文快照冻结

**Files:**
- Create: `src/lib/graphknowledge/snapshot.ts`
- Modify: `src/lib/data/store.ts`（store 字面量加一个集合 + 两个导出函数）
- Test: `src/lib/graphknowledge/snapshot.test.ts`

**Interfaces:**
- Consumes: `ContextBundle`（Task 4）
- Produces:
  - `function stableStringify(value: unknown): string`
  - `function freezeContext(bundle: ContextBundle): string` —— 返回 `ctx-<sha256 前 16 位>`
  - `function loadContext(snapshotId: string): ContextBundle`（不存在则 throw）
  - `function contextExists(snapshotId: string): boolean`
  - store.ts 新增导出：`function contextSnapshotPut(id: string, value: unknown): void`、`function contextSnapshotGet(id: string): unknown | null`

- [ ] **Step 1: 写失败的测试**

Create `src/lib/graphknowledge/snapshot.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import type { ContextBundle } from "./recipes";
import { contextExists, freezeContext, loadContext, stableStringify } from "./snapshot";

const bundle = (over: Partial<ContextBundle> = {}): ContextBundle => ({
  query: "GPU 供给还够不够撑到明年二季度",
  recipe: "S02",
  anchorCode: "ISS-D6",
  renderedMarkdown: "【公司经营状态】\n……",
  memberIds: ["ISS-D6", "JDG-01"],
  calls: [{ point: "P1", path: "/api/v1/entities/ISS-D6", view: "latest" }],
  warnings: [],
  viewer: "PSN-01",
  asOf: "2026-08-18",
  sourceBaseUrl: "https://example.test/graph",
  ...over,
});

describe("stableStringify", () => {
  it("键序不影响结果 —— 否则同一份上下文会算出两个 id", () => {
    expect(stableStringify({ b: 1, a: 2 })).toBe(stableStringify({ a: 2, b: 1 }));
  });

  it("数组次序**是**内容，不排序", () => {
    expect(stableStringify([1, 2])).not.toBe(stableStringify([2, 1]));
  });
});

describe("freezeContext", () => {
  it("id 是内容哈希：同样的上下文冻出同一个 id", () => {
    const a = freezeContext(bundle());
    const b = freezeContext(bundle());
    expect(a).toBe(b);
    expect(a).toMatch(/^ctx-[0-9a-f]{16}$/);
  });

  it("正文变一个字就是另一份快照", () => {
    expect(freezeContext(bundle())).not.toBe(
      freezeContext(bundle({ renderedMarkdown: "【公司经营状态】\n…" }))
    );
  });

  it("冻结之后读回来一模一样 —— 后续步骤只读快照，不再访问图谱", () => {
    const id = freezeContext(bundle());
    expect(contextExists(id)).toBe(true);
    expect(loadContext(id)).toEqual(bundle());
  });

  it("不存在的快照要报出 id，不能返回一个空 bundle", () => {
    expect(() => loadContext("ctx-0000000000000000")).toThrow(/ctx-0000000000000000/);
  });
});
```

- [ ] **Step 2: 跑测试确认它失败**

Run: `npx vitest run src/lib/graphknowledge/snapshot.test.ts`
Expected: FAIL —— `Failed to resolve import "./snapshot"`

- [ ] **Step 3: 在 store 里开一格放快照**

Modify `src/lib/data/store.ts` —— 在 store 字面量里 `probeEdges` 那一行之后加：

```ts
  /*
   * GraphKnowledge 上下文快照。键是内容哈希（`ctx-<sha256 前 16 位>`）。
   *
   * 放进 store 而不是模块级 Map：Next.js 里不同路由可能拿到不同的模块实例，
   * 而 store 已经是解决这件事的那个单例。类型故意留成 unknown ——
   * `ContextBundle` 的定义在 graphknowledge 层，数据层不该认识它。
   */
  contextSnapshots: {} as Record<string, unknown>,
```

- [ ] **Step 4: 在 store 里加读写函数**

Modify `src/lib/data/store.ts` —— 在 `export function resetToSeed()` 之后加：

```ts
/**
 * 上下文快照的读写。给 `graphknowledge/snapshot.ts` 用，**不进 `api` 对象** ——
 * 前端不需要它，而进了 `api` 就等于进了 `/api/data` 的方法白名单。
 */
const MAX_CONTEXT_SNAPSHOTS = 64;

export function contextSnapshotPut(id: string, value: unknown): void {
  store.contextSnapshots[id] = value;
  /*
   * 加个上限：一份上下文最大 16,000 字，而落盘是整个 store 一起重写。不封顶的
   * 表现是跑得越久每次写盘越慢 —— 没有任何报错，只是越来越钝。
   * 键的插入序就是写入序（都是 ctx- 前缀的字符串键），先进先出。
   */
  const keys = Object.keys(store.contextSnapshots);
  for (const stale of keys.slice(0, Math.max(0, keys.length - MAX_CONTEXT_SNAPSHOTS))) {
    delete store.contextSnapshots[stale];
  }
  persistSoon();
}

export function contextSnapshotGet(id: string): unknown | null {
  return store.contextSnapshots[id] ?? null;
}
```

- [ ] **Step 5: 写 snapshot.ts**

Create `src/lib/graphknowledge/snapshot.ts`:

```ts
/**
 * 对齐自 tkos-lab/src/tkos_lab/graphknowledge/snapshot.py
 *
 * 冻结 M7 装配后的完整上下文；后续 agent 步骤**只读快照**，不再访问图谱。
 *
 * 为什么要冻：一次运行里可能有四五次模型调用，如果每一步各取一次上下文，图谱
 * 在中间被更新过，四节报告就是按四份不同的公司状态写出来的 —— 而屏幕上完全
 * 看不出来。id 用内容哈希而不是随机串：同一份上下文只存一份，而且「这两次运行
 * 看的是不是同一份公司状态」变成一次字符串比较。
 */
import { createHash } from "node:crypto";

import { contextSnapshotGet, contextSnapshotPut } from "@/lib/data/store";

import type { ContextBundle } from "./recipes";

/**
 * 稳定序列化：对象键排序，**数组次序保留**。
 *
 * `JSON.stringify` 按插入序写键，于是同一份上下文换个装配顺序就会算出另一个
 * 哈希，「同一份上下文」这个判断当场失效。数组不能排——`memberIds` 的次序无关
 * 紧要，但 `calls` 的次序就是调用顺序，排掉等于把复现坐标搞坏。
 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}

export function freezeContext(bundle: ContextBundle): string {
  const body = stableStringify(bundle);
  const snapshotId = `ctx-${createHash("sha256").update(body, "utf8").digest("hex").slice(0, 16)}`;
  contextSnapshotPut(snapshotId, JSON.parse(body) as ContextBundle);
  return snapshotId;
}

export function loadContext(snapshotId: string): ContextBundle {
  const value = contextSnapshotGet(snapshotId);
  // 报出 id：快照丢了和快照内容不对是两件事，不带 id 的话第一件会被当成第二件查。
  if (value === null) throw new Error(`快照不存在: ${snapshotId}`);
  return value as ContextBundle;
}

export function contextExists(snapshotId: string): boolean {
  return contextSnapshotGet(snapshotId) !== null;
}
```

- [ ] **Step 6: 跑测试确认通过**

Run: `npx vitest run src/lib/graphknowledge/snapshot.test.ts`
Expected: PASS，5 个用例全绿

`store.ts` 在导入时会构造整套种子，测试里第一次 import 会慢一两秒；这是正常的，不是卡住。

- [ ] **Step 7: 类型检查与 lint**

Run: `npx tsc --noEmit && npx eslint src/lib/graphknowledge/snapshot.ts src/lib/graphknowledge/snapshot.test.ts src/lib/data/store.ts`
Expected: 无输出

- [ ] **Step 8: Commit**

```bash
git add src/lib/graphknowledge/snapshot.ts src/lib/graphknowledge/snapshot.test.ts src/lib/data/store.ts
git commit -m "上下文快照按内容哈希冻结，落在数据层并封顶 64 份"
```

---

### Task 6: 模型注册表与槽位

**Files:**
- Create: `src/lib/models/registry.ts`
- Create: `src/lib/models/slots.ts`
- Modify: `src/lib/agent/models.ts`（改成薄的再导出层，保住现有 import 路径）
- Test: `src/lib/models/slots.test.ts`

**Interfaces:**
- Consumes: 无
- Produces:
  - `type ModelAlias = "deepseek-pro" | "deepseek-flash" | "kimi-k3"`
  - `type ArkKeyEnv = "ARK_API_KEY" | "ARK_AGENT_API_KEY"`
  - `type ModelSpec = { alias: ModelAlias; display: string; providerModelId: string; keyEnv: ArkKeyEnv; contextTokens: number; acceptsEffort: boolean; sampling: boolean; family: string; note: string }`
  - `const MODELS: Record<ModelAlias, ModelSpec>`、`function getModel(alias: string): ModelSpec`、`function modelCatalog(): ModelSpec[]`
  - `function arkKey(keyEnv: ArkKeyEnv): string`、`function arkBase(keyEnv: ArkKeyEnv): string`
  - `type Slot = "pro" | "flash" | "alt"`
  - `type ModelConfig = { slot: Slot; alias: string; baseUrl: string; apiKey: string; model: string; family: string; acceptsEffort: boolean; sampling: boolean; keyEnv: string }`
  - `const SLOT_ALIAS: Record<Slot, ModelAlias>`
  - `function familyOf(model: string): string`、`function resolveModel(slot: Slot): ModelConfig | null`、`function areIndependent(a: ModelConfig, b: ModelConfig): boolean`、`function assertSlotSanity(): void`
- 现有 `import { resolveModel, areIndependent, familyOf, type Slot, type ModelConfig } from "@/lib/agent/models"` 的调用点（`agent/json.ts`、`a4/run.ts`、`api/chat/route.ts`）**保持能编译**。

- [ ] **Step 1: 写失败的测试**

Create `src/lib/models/slots.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { MODELS, arkBase, getModel } from "./registry";
import { SLOT_ALIAS, areIndependent, familyOf, resolveModel } from "./slots";

const KEYS = [
  "ARK_API_KEY",
  "ARK_AGENT_API_KEY",
  "ARK_BASE_URL",
  "ARK_PLAN_BASE_URL",
  "ARK_MODEL_DEEPSEEK_PRO",
  "ARK_MODEL_DEEPSEEK_FLASH",
  "ARK_MODEL_KIMI_K3",
  "DEEPSEEK_API_KEY",
] as const;

let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  for (const k of KEYS) delete process.env[k];
});

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("两把 key 各自配一个地址", () => {
  it("模型广场那把打 /api/v3", () => {
    expect(arkBase("ARK_API_KEY")).toBe("https://ark.cn-beijing.volces.com/api/v3");
  });

  it("套餐那把打 /api/plan/v3 —— 打错地址不报错，是照单收费", () => {
    expect(arkBase("ARK_AGENT_API_KEY")).toBe("https://ark.cn-beijing.volces.com/api/plan/v3");
  });

  it("覆盖也分开覆盖，一个环境变量绝不同时改两个出口", () => {
    process.env.ARK_BASE_URL = "https://proxy.test/api/v3/";
    expect(arkBase("ARK_API_KEY")).toBe("https://proxy.test/api/v3");
    expect(arkBase("ARK_AGENT_API_KEY")).toBe("https://ark.cn-beijing.volces.com/api/plan/v3");
  });
});

describe("注册表", () => {
  it("三个别名，火山三个都不吃 effort —— 发过去是 400，不是被忽略", () => {
    expect(Object.keys(MODELS)).toEqual(["deepseek-pro", "deepseek-flash", "kimi-k3"]);
    for (const m of Object.values(MODELS)) expect(m.acceptsEffort).toBe(false);
  });

  it("kimi-k3 走套餐那把 key", () => {
    expect(MODELS["kimi-k3"].keyEnv).toBe("ARK_AGENT_API_KEY");
    expect(MODELS["deepseek-pro"].keyEnv).toBe("ARK_API_KEY");
  });

  it("provider_model_id 可由环境变量覆盖 —— 账号里叫什么名字是部署期才知道的事", () => {
    process.env.ARK_MODEL_KIMI_K3 = "ep-20260818-abcdef";
    expect(getModel("kimi-k3").providerModelId).toBe("ep-20260818-abcdef");
  });

  it("未知别名要报出可选项，不能返回 undefined 让下游炸在别处", () => {
    expect(() => getModel("opus-5")).toThrow(/deepseek-pro/);
  });
});

describe("familyOf", () => {
  it("认得出家族", () => {
    expect(familyOf("deepseek-v4-pro")).toBe("deepseek");
    expect(familyOf("kimi-k3")).toBe("kimi");
    expect(familyOf("moonshot-v1-128k")).toBe("kimi");
  });

  it("猜不出来就返回模型名本身：宁可漏报，不要把两个不同的判成同一个", () => {
    expect(familyOf("ep-20260818-abcdef")).toBe("ep-20260818-abcdef");
  });
});

describe("槽位", () => {
  it("ALT 必须与 PRO 不同家族 —— 同家族的话交叉评审与双源反证都是走过场", () => {
    expect(MODELS[SLOT_ALIAS.pro].family).not.toBe(MODELS[SLOT_ALIAS.alt].family);
  });

  it("没有任何 key 时返回 null，不返回一个打不通的配置", () => {
    expect(resolveModel("pro")).toBeNull();
  });

  it("配了方舟就按注册表出配置，并带上出错时要报的那个变量名", () => {
    process.env.ARK_API_KEY = "ark-plaza-key";
    process.env.ARK_AGENT_API_KEY = "ark-plan-key";
    const pro = resolveModel("pro");
    const alt = resolveModel("alt");
    expect(pro?.keyEnv).toBe("ARK_API_KEY");
    expect(pro?.baseUrl.endsWith("/api/v3")).toBe(true);
    expect(alt?.keyEnv).toBe("ARK_AGENT_API_KEY");
    expect(alt?.baseUrl.endsWith("/api/plan/v3")).toBe(true);
    expect(areIndependent(pro!, alt!)).toBe(true);
  });

  it("只配了套餐那把 key 时，pro 槽位不许偷用它 —— 那会把账记到另一边", () => {
    process.env.ARK_AGENT_API_KEY = "ark-plan-key";
    expect(resolveModel("pro")).toBeNull();
    expect(resolveModel("alt")).not.toBeNull();
  });

  it("DeepSeek 直连回落只有 pro/flash，alt 没有对应家族", () => {
    process.env.DEEPSEEK_API_KEY = "ds-key";
    expect(resolveModel("pro")?.baseUrl).toBe("https://api.deepseek.com/v1");
    expect(resolveModel("alt")).toBeNull();
  });
});
```

- [ ] **Step 2: 跑测试确认它失败**

Run: `npx vitest run src/lib/models/slots.test.ts`
Expected: FAIL —— `Failed to resolve import "./registry"`

- [ ] **Step 3: 写 registry.ts**

Create `src/lib/models/registry.ts`:

```ts
/**
 * 对齐自 tkos-lab/src/tkos_lab/models/registry.py（只搬火山三个，Bedrock 六个不搬）
 *
 * 模型 ID 与出网路径是两件事。方舟有**两个出口**，地址和 key 成对出现，不能交叉：
 *
 *   · 模型广场（`ARK_API_KEY` + `/api/v3`）—— model 填推理接入点 `ep-xxxxxxxx`，
 *     直接填模型名会 404 `ModelNotOpen`
 *   · 套餐（`ARK_AGENT_API_KEY` + `/api/plan/v3`）—— model 填模型名（`kimi-k3` 等），
 *     套餐里没有创建接入点这一步
 *
 * 套餐那把 key 打模型广场的地址会**按次另外计费**（控制台原话：请勿使用
 * https://ark.cn-beijing.volces.com/api/v3，接入会产生额外费用）。那不是报错，
 * 是账单下来才看得见。所以地址跟着 key 走，写在一处，不给第二种组合的机会。
 */
export type ModelAlias = "deepseek-pro" | "deepseek-flash" | "kimi-k3";
export type ArkKeyEnv = "ARK_API_KEY" | "ARK_AGENT_API_KEY";

export type ModelSpec = {
  /** 正式版里用的名字，也是 Run 记录里存的值。 */
  alias: ModelAlias;
  display: string;
  /** 真正发给服务端的 model 字段。可由环境变量覆盖。 */
  providerModelId: string;
  /** 哪个模型走哪把 key 是账号事实，只能写在这张表上。401 时要报出这个变量名。 */
  keyEnv: ArkKeyEnv;
  contextTokens: number;
  /**
   * 认不认 `output_config.effort`（思考深度）。这是 Anthropic 自己的字段，
   * 火山这三个发过去只会报错 —— 所以深度在正式版只驱动 harness 的研究规模。
   */
  acceptsEffort: boolean;
  /** 能不能发 temperature / top_p。不是「要不要调」，是「能不能发」。 */
  sampling: boolean;
  /** 同家族的两次调用不算「独立」。交叉评审与双源反证用它做判定。 */
  family: string;
  note: string;
};

const ARK_PLAZA_BASE = "https://ark.cn-beijing.volces.com/api/v3";
const ARK_PLAN_BASE = "https://ark.cn-beijing.volces.com/api/plan/v3";

const trimSlash = (s: string) => s.replace(/\/+$/, "");

/** 部署期才知道账号里开通的到底叫什么名字，所以留一道环境变量覆盖。 */
const arkId = (env: string, fallback: string): string =>
  (process.env[env] ?? "").trim() || fallback;

export const MODELS: Record<ModelAlias, ModelSpec> = {
  "deepseek-pro": {
    alias: "deepseek-pro",
    display: "DeepSeek V4 Pro",
    providerModelId: arkId("ARK_MODEL_DEEPSEEK_PRO", "deepseek-v4-pro"),
    keyEnv: "ARK_API_KEY",
    contextTokens: 128_000,
    acceptsEffort: false,
    sampling: true,
    family: "deepseek",
    note: "国内直连，成本低，主力出文",
  },
  "deepseek-flash": {
    alias: "deepseek-flash",
    display: "DeepSeek V4 Flash",
    providerModelId: arkId("ARK_MODEL_DEEPSEEK_FLASH", "deepseek-v4-flash"),
    keyEnv: "ARK_API_KEY",
    contextTokens: 128_000,
    acceptsEffort: false,
    sampling: true,
    family: "deepseek",
    note: "最快最便宜，短活与选路用",
  },
  "kimi-k3": {
    alias: "kimi-k3",
    display: "Kimi K3",
    providerModelId: arkId("ARK_MODEL_KIMI_K3", "kimi-k3"),
    keyEnv: "ARK_AGENT_API_KEY",
    contextTokens: 256_000,
    acceptsEffort: false,
    sampling: true,
    family: "kimi",
    note: "长上下文；与 DeepSeek 不同家族，撑起独立第二源",
  },
};

export function getModel(alias: string): ModelSpec {
  const spec = (MODELS as Record<string, ModelSpec>)[alias];
  // 报出可选项：返回 undefined 会让调用方炸在几层之外，现场看不出是别名写错了。
  if (!spec) throw new Error(`未知模型 ${alias}；可选：${Object.keys(MODELS).join(", ")}`);
  return spec;
}

export function modelCatalog(): ModelSpec[] {
  return Object.values(MODELS);
}

export function arkKey(keyEnv: ArkKeyEnv): string {
  // 只负责取，不做「取不到就换另一把」这种兜底：拿错 key 的表现是 401 或额度
  // 记到别的账上，静默替换只会把问题藏起来。
  return (process.env[keyEnv] ?? "").trim();
}

export function arkBase(keyEnv: ArkKeyEnv): string {
  if (keyEnv === "ARK_AGENT_API_KEY") {
    return trimSlash((process.env.ARK_PLAN_BASE_URL ?? "").trim() || ARK_PLAN_BASE);
  }
  return trimSlash((process.env.ARK_BASE_URL ?? "").trim() || ARK_PLAZA_BASE);
}
```

- [ ] **Step 4: 写 slots.ts**

Create `src/lib/models/slots.ts`（内容是从 `src/lib/agent/models.ts` 搬过来的，`familyOf` / `areIndependent` / `assertSlotSanity` 行为不变，`resolveModel` 改成走注册表）:

```ts
/**
 * 模型槽位。**按角色配，不按厂商配。**
 *
 * ## 唯一的不变量：ALT 必须和 PRO 不同家族
 *
 * 两处设计依赖它：
 *   1. **交叉 judge**（rubric L4）—— PRO 生成的由 ALT 判，反之亦然。理由不是
 *      「要用不同厂商」，是**自己判自己会通过自己的失败模式**。
 *   2. **两份独立研究**（A3 / A4）—— 两份的分歧点就是「这个判断有多硬」的度量。
 *
 * 如果 ALT 退化成和 PRO 同一个模型，这两件事都变成表演：交叉校验会稳定放过同一类
 * 错误，而通过率反而更好看 —— 从指标上看不出来。所以下面有一道启动期告警。
 */
import { MODELS, type ModelAlias, arkBase, arkKey } from "./registry";

export type Slot = "pro" | "flash" | "alt";

export type ModelConfig = {
  slot: Slot;
  /** 注册表别名；DeepSeek 直连回落时是模型名本身。 */
  alias: string;
  baseUrl: string;
  apiKey: string;
  /** 真正发给服务端的 model 字段。 */
  model: string;
  family: string;
  acceptsEffort: boolean;
  sampling: boolean;
  /** 401 / 未开通时要报出「该补哪一把」。 */
  keyEnv: string;
};

/**
 * 槽位到别名的映射。写死在这里而不是再开三个环境变量：换模型 id 已经有
 * `ARK_MODEL_*` 可以覆盖，再加一层「槽位配别名」只是多一处能配歪的地方。
 *
 * `alt` 取 kimi-k3：与 pro/flash 的 deepseek 不同家族，而且把第二把 key 用上了。
 */
export const SLOT_ALIAS: Record<Slot, ModelAlias> = {
  pro: "deepseek-pro",
  flash: "deepseek-flash",
  alt: "kimi-k3",
};

const DEEPSEEK_BASE = "https://api.deepseek.com/v1";
const trimSlash = (s: string) => s.replace(/\/+$/, "");

/**
 * 从模型名猜家族。够用就行 —— 它只服务一件事：判断两次调用是不是「独立」的。
 * 猜不出来时返回模型名本身，宁可把两个同家族的判成不同（漏报），
 * 也不要把两个不同的判成同一个（误报会让交叉校验被误停）。
 */
export function familyOf(model: string): string {
  const m = model.toLowerCase();
  for (const f of [
    "deepseek", "doubao", "kimi", "moonshot", "qwen", "glm",
    "ernie", "step", "minimax", "gpt", "claude", "gemini",
  ]) {
    if (m.includes(f)) return f === "moonshot" ? "kimi" : f;
  }
  return m;
}

/**
 * 解析一个槽位。方舟优先；没配方舟就回落到 DeepSeek 官方直连，此时只有
 * pro / flash 可用。
 *
 * 回落那条**不进注册表**：`.env.local` 里 `DEEPSEEK_*` 当前是注释掉的，为一条
 * 没启用的路径加两个 `ModelSpec` 只是多两处要维护的地方。留着它是因为删掉属于
 * 与本轮无关的行为变更。
 */
export function resolveModel(slot: Slot): ModelConfig | null {
  const spec = MODELS[SLOT_ALIAS[slot]];
  const key = arkKey(spec.keyEnv);
  if (key) {
    return {
      slot,
      alias: spec.alias,
      baseUrl: arkBase(spec.keyEnv),
      apiKey: key,
      model: spec.providerModelId,
      family: spec.family,
      acceptsEffort: spec.acceptsEffort,
      sampling: spec.sampling,
      keyEnv: spec.keyEnv,
    };
  }

  const dsKey = (process.env.DEEPSEEK_API_KEY ?? "").trim();
  if (dsKey && slot !== "alt") {
    const model =
      slot === "pro"
        ? (process.env.DEEPSEEK_MODEL_PRO ?? "deepseek-v4-pro")
        : (process.env.DEEPSEEK_MODEL ?? "deepseek-v4-flash");
    return {
      slot,
      alias: model,
      baseUrl: trimSlash(process.env.DEEPSEEK_BASE_URL ?? DEEPSEEK_BASE),
      apiKey: dsKey,
      model,
      family: familyOf(model),
      acceptsEffort: false,
      sampling: true,
      keyEnv: "DEEPSEEK_API_KEY",
    };
  }
  return null;
}

/**
 * 两个配置是不是「独立」的。交叉 judge 与双源对照在动手前问这一句。
 * 同家族 → 不独立，因为它们大概率共享同一批失败模式。
 */
export const areIndependent = (a: ModelConfig, b: ModelConfig): boolean =>
  a.family !== b.family;

let warned = false;

/**
 * 启动期自检。**只告警不阻断** —— 交叉校验降级了系统仍然能用，
 * 但必须在日志里留下痕迹，否则将来看到「通过率变高了」会当成好消息。
 */
export function assertSlotSanity(): void {
  if (warned) return;
  warned = true;
  const pro = resolveModel("pro");
  const alt = resolveModel("alt");

  if (!pro) {
    console.warn(
      `[tkos:models] 没有可用的 pro 槽位 —— 对话与研究都接不上模型。` +
        `补 ${MODELS[SLOT_ALIAS.pro].keyEnv}。`
    );
    return;
  }
  if (!alt) {
    console.warn(
      `[tkos:models] 没配 ALT 槽位（缺 ${MODELS[SLOT_ALIAS.alt].keyEnv}）。` +
        `交叉 judge 与两份独立研究会退化成单模型 —— ` +
        `校验会稳定放过 ${pro.family} 自己的失败模式，而通过率反而更好看。`
    );
    return;
  }
  if (!areIndependent(pro, alt)) {
    console.warn(
      `[tkos:models] ALT(${alt.model}) 与 PRO(${pro.model}) 是同一家族「${pro.family}」。` +
        `交叉校验此时等于自己判自己，等于没做。换一个不同家族的模型。`
    );
    return;
  }
  console.log(
    `[tkos:models] pro=${pro.alias}(${pro.family})  alt=${alt.alias}(${alt.family})  ✓ 独立`
  );
}
```

- [ ] **Step 5: 把 agent/models.ts 改成再导出层**

`agent/json.ts`、`a4/run.ts`、`api/chat/route.ts` 都从 `@/lib/agent/models` 取这些符号。不动它们的 import 路径 —— 那属于与本轮目标无关的改动面。

Replace 整个 `src/lib/agent/models.ts` 的内容为：

```ts
/**
 * 槽位解析搬到了 `src/lib/models/`（注册表 + 槽位 + 调用）。
 *
 * 这里留一层再导出，不是为了兼容而兼容：`a2` / `a6` / `a10` 与对话路径都从这个
 * 路径取符号，一起改 import 会把本轮的改动面扩到三个不在范围内的 agent 上。
 * 新代码请直接从 `@/lib/models/slots` 取。
 */
export {
  SLOT_ALIAS,
  areIndependent,
  assertSlotSanity,
  familyOf,
  resolveModel,
  type ModelConfig,
  type Slot,
} from "@/lib/models/slots";
```

- [ ] **Step 6: 跑测试确认通过**

Run: `npx vitest run src/lib/models/slots.test.ts`
Expected: PASS，13 个用例全绿

- [ ] **Step 7: 类型检查与 lint**

Run: `npx tsc --noEmit && npx eslint src/lib/models/registry.ts src/lib/models/slots.ts src/lib/models/slots.test.ts src/lib/agent/models.ts`
Expected: 无输出。`tsc` 会顺带证明三个旧调用点仍然编译得过。

- [ ] **Step 8: Commit**

```bash
git add src/lib/models/registry.ts src/lib/models/slots.ts src/lib/models/slots.test.ts src/lib/agent/models.ts
git commit -m "模型注册表：两把 key 各自配一个地址；ALT 与 PRO 不同家族有单测把关"
```

---

### Task 7: 统一的模型调用与四项 token 计量

**Files:**
- Create: `src/lib/models/complete.ts`
- Modify: `src/lib/agent/json.ts:36-68`（`callJson` 内部改成调 `callModel`，签名不动；新增 `callModelJson`）

**Interfaces:**
- Consumes: `resolveModel` / `ModelConfig` / `Slot`（Task 6）、`getModel` / `ModelAlias`（Task 6）
- Produces:
  - `type Effort = "low" | "medium" | "high" | "xhigh" | "max"`
  - `type Usage = { inputTokens: number; outputTokens: number; cachedInputTokens: number; reasoningTokens: number }`
  - `function emptyUsage(): Usage`、`function addUsage(a: Usage, b: Usage): Usage`
  - `class ModelUnavailable extends Error`
  - `type CallResult = { text: string; usage: Usage; ms: number; slot: Slot | null; alias: string; providerModelId: string; effortSent: Effort | null; stopReason: string }`
  - `async function callModel(opts: { slot?: Slot; alias?: ModelAlias; messages: { role: string; content: string }[]; maxTokens?: number; temperature?: number; effort?: Effort; json?: boolean }): Promise<CallResult>`
  - `src/lib/agent/json.ts` 新增导出 `async function callModelJson(messages: Msg[], opts?: CallOpts & { effort?: Effort }): Promise<CallResult>`

- [ ] **Step 1: 写 complete.ts**

Create `src/lib/models/complete.ts`:

```ts
/**
 * 对齐自 tkos-lab/src/tkos_lab/models/{base,volcengine}.py
 *
 * 所有模型调用的唯一出口。OpenAI 兼容协议（火山方舟两个出口都是）。
 *
 * **每次调用都必须带回 token 计量。** 四个字段归一：新鲜输入、输出、命中提示
 * 缓存的输入、推理 token。少了 cached 那一项，账单对不上而看不出为什么；少了
 * reasoning 那一项，思考型模型的「为什么这么慢这么贵」就没有现场。
 */
import { getModel, type ModelAlias } from "./registry";
import { resolveModel, type ModelConfig, type Slot } from "./slots";

/** 官方 effort 词表，五档，英文原词照发。 */
export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export type Usage = {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  reasoningTokens: number;
};

export const emptyUsage = (): Usage => ({
  inputTokens: 0,
  outputTokens: 0,
  cachedInputTokens: 0,
  reasoningTokens: 0,
});

export const addUsage = (a: Usage, b: Usage): Usage => ({
  inputTokens: a.inputTokens + b.inputTokens,
  outputTokens: a.outputTokens + b.outputTokens,
  cachedInputTokens: a.cachedInputTokens + b.cachedInputTokens,
  reasoningTokens: a.reasoningTokens + b.reasoningTokens,
});

/** 未配置或调用失败。由上层记为该步失败，**不静默降级**。 */
export class ModelUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelUnavailable";
  }
}

export type CallResult = {
  text: string;
  usage: Usage;
  ms: number;
  slot: Slot | null;
  alias: string;
  providerModelId: string;
  /** 实际发出去的档位。**空 = 该模型不吃这个字段，不是「没选」。** */
  effortSent: Effort | null;
  stopReason: string;
};

const MODEL_TIMEOUT_MS = 180_000;

export async function callModel(opts: {
  slot?: Slot;
  alias?: ModelAlias;
  messages: { role: string; content: string }[];
  maxTokens?: number;
  temperature?: number;
  effort?: Effort;
  json?: boolean;
}): Promise<CallResult> {
  const cfg = configFor(opts);
  const maxTokens = opts.maxTokens ?? 4000;
  // 只给认这个字段的模型发。火山三个都不认——发过去是 400，不是被忽略。
  const effortSent = opts.effort && cfg.acceptsEffort ? opts.effort : null;

  const body: Record<string, unknown> = {
    model: cfg.model,
    messages: opts.messages,
    max_tokens: maxTokens,
    stream: false,
  };
  if (cfg.sampling) body.temperature = opts.temperature ?? 0.3;
  if (effortSent) body.output_config = { effort: effortSent };
  if (opts.json !== false) body.response_format = { type: "json_object" };

  const started = Date.now();
  let res: Response;
  try {
    res = await fetch(`${cfg.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(MODEL_TIMEOUT_MS),
    });
  } catch (e) {
    /*
     * 超时异常的 message 常常是空串，照原样拼出来是「调用失败: 」，看不出是超时
     * 也看不出等了多久。思考型模型（kimi-k3）超时是常态失败，这句话就是结果页上
     * 唯一的现场，必须自己把秒数写清楚。
     */
    const name = e instanceof Error ? e.name : typeof e;
    if (name === "TimeoutError" || name === "AbortError") {
      throw new ModelUnavailable(
        `火山方舟调用超时 [${cfg.model}]（用的是 ${cfg.keyEnv}）：` +
          `等了 ${MODEL_TIMEOUT_MS / 1000}s 没等到回复。思考型模型这一次可能想得特别久。`
      );
    }
    throw new ModelUnavailable(
      `火山方舟调用失败 [${cfg.model}]（用的是 ${cfg.keyEnv}）: ` +
        `${name}: ${e instanceof Error ? e.message : String(e)}`
    );
  }

  if (!res.ok) {
    /*
     * 一定要带上服务端应答正文：状态码只说「404 Not Found」，而方舟真正的原因
     * 全在正文里 —— `ModelNotOpen`（没开通）、`InvalidEndpointOrModel.NotFound`
     * （模型 id 不对，或该用接入点 ep-*）、`AuthenticationError`（key 无效）。
     * 三种要做的事完全不同。不带出来的话，得有人拿 curl 再打一遍才知道改哪。
     */
    const text = (await res.text().catch(() => "")).slice(0, 400);
    throw new ModelUnavailable(
      `火山方舟调用失败 [${cfg.model}]（用的是 ${cfg.keyEnv}）: HTTP ${res.status}` +
        (text ? ` — ${text}` : "")
    );
  }

  const j = (await res.json()) as {
    choices?: { message?: { content?: string }; finish_reason?: string }[];
    usage?: {
      prompt_tokens?: number;
      completion_tokens?: number;
      prompt_tokens_details?: { cached_tokens?: number };
      completion_tokens_details?: { reasoning_tokens?: number };
    };
  };
  const choice = j.choices?.[0];
  const u = j.usage ?? {};

  return {
    text: choice?.message?.content ?? "",
    usage: {
      inputTokens: Number(u.prompt_tokens ?? 0),
      outputTokens: Number(u.completion_tokens ?? 0),
      cachedInputTokens: Number(u.prompt_tokens_details?.cached_tokens ?? 0),
      reasoningTokens: Number(u.completion_tokens_details?.reasoning_tokens ?? 0),
    },
    ms: Date.now() - started,
    slot: opts.alias ? null : (opts.slot ?? "pro"),
    alias: cfg.alias,
    providerModelId: cfg.model,
    effortSent,
    stopReason: choice?.finish_reason ?? "",
  };
}

function configFor(opts: { slot?: Slot; alias?: ModelAlias }): ModelConfig {
  if (opts.alias) {
    const spec = getModel(opts.alias);
    const key = (process.env[spec.keyEnv] ?? "").trim();
    if (!key) {
      throw new ModelUnavailable(`未配置 ${spec.keyEnv}（${spec.providerModelId} 用的是这一把）`);
    }
    // 走别名时也必须由 slots 决定地址：地址和 key 是一对，拆开配就会出现
    // 「套餐的 key 打了模型广场的地址」——那不报错，是照单收费。
    const bySlot = (Object.keys(SLOT_BY_ALIAS) as ModelAlias[]).includes(opts.alias)
      ? resolveModel(SLOT_BY_ALIAS[opts.alias])
      : null;
    if (!bySlot) throw new ModelUnavailable(`别名 ${opts.alias} 没有对应的可用槽位`);
    return bySlot;
  }
  const slot = opts.slot ?? "pro";
  const cfg = resolveModel(slot);
  if (!cfg) {
    throw new ModelUnavailable(
      `没有可用的 ${slot} 槽位（需要 ARK_API_KEY / ARK_AGENT_API_KEY，或 DEEPSEEK_API_KEY）。`
    );
  }
  return cfg;
}

/** 别名 → 槽位的反查。地址永远由槽位给，见 `configFor`。 */
const SLOT_BY_ALIAS: Record<ModelAlias, Slot> = {
  "deepseek-pro": "pro",
  "deepseek-flash": "flash",
  "kimi-k3": "alt",
};
```

- [ ] **Step 2: 类型检查**

Run: `npx tsc --noEmit`
Expected: 无输出

- [ ] **Step 3: 把 json.ts 的调用改到 complete.ts**

`callJson` 的**签名一个字不改** —— `a2` / `a6` / `a10` 都在用它。只换内部实现，并加一个带计量的姊妹函数给 a1a/a3/a4 用。

Modify `src/lib/agent/json.ts` —— 把顶部的 import 换成：

```ts
import { callModel, type CallResult, type Effort } from "@/lib/models/complete";
import type { Slot } from "@/lib/models/slots";
import type { Statement, TraceKind } from "@/lib/data/types";
```

把 `CallOpts` 类型加一个字段：

```ts
export type CallOpts = {
  slot?: Slot;
  /** 一次成文的产物比对话长得多。A4 会写到 3000+ tokens。 */
  maxTokens?: number;
  temperature?: number;
  /** 关掉时返回自由文本，不强制 JSON。目前只有实验路径用。 */
  json?: boolean;
  /** 思考深度。只发给认这个字段的模型；火山三个都不认，发过去是 400。 */
  effort?: Effort;
};
```

把 `callJson` 的函数体（第 37–67 行）整段换成：

```ts
export async function callJson(messages: Msg[], opts: CallOpts = {}): Promise<string> {
  return (await callModelJson(messages, opts)).text;
}

/**
 * 和 `callJson` 同一条路，但把 token 计量、耗时、实际模型、实际发出的深度一起
 * 带回来。A1a / A3 / A4 落 Run 记录要用它 —— 只拿正文的话，一次运行花了多少
 * 就只能靠猜。
 */
export async function callModelJson(
  messages: Msg[],
  opts: CallOpts = {}
): Promise<CallResult> {
  const r = await callModel({
    slot: opts.slot ?? "pro",
    messages,
    maxTokens: opts.maxTokens,
    temperature: opts.temperature,
    effort: opts.effort,
    json: opts.json,
  });
  if (!r.text) throw new Error("模型返回里没有正文。");
  // 截断的 JSON 解析必然失败，落到下游是一个看不懂的 SyntaxError。必须在这里
  // 认出来并说人话。
  if (r.stopReason === "length") {
    throw new Error(`模型输出被 max_tokens(${opts.maxTokens ?? 4000}) 截断。`);
  }
  return r;
}
```

- [ ] **Step 4: 类型检查与 lint**

Run: `npx tsc --noEmit && npx eslint src/lib/models/complete.ts src/lib/agent/json.ts`
Expected: 无输出

- [ ] **Step 5: 跑全部单测确认没弄坏别的**

Run: `pnpm test`
Expected: PASS，Task 1–6 的用例全绿

- [ ] **Step 6: Commit**

```bash
git add src/lib/models/complete.ts src/lib/agent/json.ts
git commit -m "模型调用收到一处：四项 token 计量、深度只发给认的模型、401 说清补哪把 key"
```

---

### Task 8: 唯一那扇门 + 四层自检 + 自检端点

**Files:**
- Create: `src/lib/graphknowledge/index.ts`
- Create: `src/lib/graphknowledge/check.ts`
- Create: `src/app/api/graphknowledge/check/route.ts`
- Modify: `src/app/api/health/route.ts`

**Interfaces:**
- Consumes: 前七个任务的全部产出
- Produces:
  - `type OpenedContext = { mode: "anchored" | "external_only"; bundle: ContextBundle | null; anchor: AnchorPick | null; noAnchorReason: string | null; snapshotId: string | null; trace: TraceNode[]; warnings: string[] }`
  - `type TraceNode = { at: string; label: string; kind: "graph" | "anchor" | "context"; detail: Record<string, unknown> }`
  - `async function openContext(opts: { recipe: Recipe; prefix: AnchorPrefix; channel: Channel; q: string; anchorCode?: string; viewer?: string; asOf?: string; client?: GraphKnowledgeClient }): Promise<OpenedContext>` —— throws `GraphKnowledgeUnavailable`
  - `type CheckLayer = { layer: "网络" | "P0" | "锚点" | "P3"; ok: boolean; detail: Record<string, unknown>; error?: string }`
  - `async function runGraphKnowledgeCheck(opts: { probeQuery: string; viewer?: string; asOf?: string }): Promise<{ ok: boolean; stoppedAt: string | null; layers: CheckLayer[]; warnings: string[] }>`
  - `GET /api/graphknowledge/check` —— 返回上面那个结构；`GET /api/health` 的 `upstream` 多一项 `graphknowledge`

- [ ] **Step 1: 写 index.ts —— 对外唯一那扇门**

Create `src/lib/graphknowledge/index.ts`:

```ts
/**
 * GraphKnowledge 对外**只有这一扇门**。
 *
 * `AnchorNotFound` 在门里面就被吃掉、转成 `mode:"external_only"`；
 * `GraphKnowledgeUnavailable` 原样抛出去。这是三态不被混淆的**结构保证**：
 * 调用方拿不到「没找到」这个异常，所以没法误接成失败；也没法把「连不上」当成
 * 「没找到」，因为那个异常它必须处理。
 *
 * 路由与 UI 层不许直接 import 这个目录下的其它文件。
 */
import { GraphKnowledgeClient } from "./client";
import { AnchorNotFound } from "./errors";
import { autopick, type AnchorPick, type AnchorPrefix, type Channel } from "./lookup";
import {
  buildS01,
  buildS02,
  buildS03,
  bundleSummary,
  type ContextBundle,
  type Recipe,
} from "./recipes";
import { freezeContext } from "./snapshot";

export { GraphKnowledgeClient, gkSettings } from "./client";
export {
  AnchorNotFound,
  GraphKnowledgeError,
  GraphKnowledgeNotFound,
  GraphKnowledgeRejected,
  GraphKnowledgeUnavailable,
} from "./errors";
export { findAnchors, type AnchorPick, type AnchorPrefix, type Channel } from "./lookup";
export { MAX_CONTEXT_CHARS, type ContextBundle, type Recipe } from "./recipes";
export { contextExists, loadContext } from "./snapshot";

export type TraceNode = {
  at: string;
  label: string;
  kind: "graph" | "anchor" | "context";
  detail: Record<string, unknown>;
};

export type OpenedContext = {
  mode: "anchored" | "external_only";
  /** `external_only` 时为 null。 */
  bundle: ContextBundle | null;
  anchor: AnchorPick | null;
  /** 命中了哪条相对规则。`anchored` 时为 null。 */
  noAnchorReason: string | null;
  snapshotId: string | null;
  trace: TraceNode[];
  /** q 被裁、语义段降级、TLS 未校验…… 都在这里。 */
  warnings: string[];
};

/** `as_of` **没有环境变量**：给它一个变量意味着有人会设成某个日期然后忘掉，
 *  之后每次运行都在读一份过期视图，而产出看不出任何异常。 */
const today = (): string => new Date().toISOString().slice(0, 10);

export async function openContext(opts: {
  recipe: Recipe;
  prefix: AnchorPrefix;
  channel: Channel;
  /** 自然语言问题，**不含指令样板**。正式版传 `issue.statement` 这类结构化字段。 */
  q: string;
  /** 显式钉锚点：复现旧运行走这条。 */
  anchorCode?: string;
  viewer?: string;
  asOf?: string;
  client?: GraphKnowledgeClient;
}): Promise<OpenedContext> {
  const client = opts.client ?? new GraphKnowledgeClient();
  const viewer = opts.viewer ?? client.viewer;
  const asOf = opts.asOf ?? today();
  const trace: TraceNode[] = [];
  const warnings = [...client.warnings];
  const note = (label: string, kind: TraceNode["kind"], detail: Record<string, unknown>) =>
    trace.push({ at: new Date().toISOString(), label, kind, detail });

  let anchor: AnchorPick | null = null;
  if (opts.anchorCode) {
    note("锚点由调用方钉住", "anchor", { anchorCode: opts.anchorCode, origin: "explicit" });
  } else {
    try {
      anchor = await autopick(opts.q, opts.channel, client);
      warnings.push(...anchor.warnings);
      note("锚点自动选定", "anchor", {
        anchorCode: anchor.anchorCode,
        label: anchor.label,
        score: anchor.score,
        rankOverall: anchor.rankOverall,
        ambiguous: anchor.ambiguous,
        pool: anchor.pool,
        runnersUp: anchor.runnersUp,
        querySent: anchor.querySent,
      });
    } catch (e) {
      // AnchorNotFound 必须在基类之前判。不是故障，是分支。
      if (!(e instanceof AnchorNotFound)) throw e;
      note("图谱里没有对应锚点，转纯外部", "anchor", { why: e.detail.why, ...e.detail });
      return {
        mode: "external_only",
        bundle: null,
        anchor: null,
        noAnchorReason: e.message,
        snapshotId: null,
        trace,
        warnings: [...warnings, ...((e.detail.warnings as string[]) ?? [])],
      };
    }
  }

  const anchorCode = opts.anchorCode ?? anchor!.anchorCode;
  const bundle =
    opts.recipe === "S01"
      ? await buildS01(client, anchorCode, { query: opts.q, viewer, asOf })
      : opts.recipe === "S02"
        ? await buildS02(client, anchorCode, { query: opts.q, viewer, asOf })
        : await buildS03(client, anchorCode, { coreQuestion: opts.q, viewer, asOf });

  warnings.push(...bundle.warnings);
  const snapshotId = freezeContext(bundle);
  note(`${opts.recipe} 上下文已装配并冻结`, "context", {
    ...bundleSummary(bundle),
    snapshotId,
    calls: bundle.calls,
  });

  return {
    mode: "anchored",
    bundle,
    anchor,
    noAnchorReason: null,
    snapshotId,
    trace,
    warnings,
  };
}
```

- [ ] **Step 2: 写 check.ts —— 四层自检**

Create `src/lib/graphknowledge/check.ts`:

```ts
/**
 * 图谱四层自检。**不调模型，一个 token 不烧。**
 *
 * 卡在哪层报哪层。这一条通了，「api + 本体连接跑通」就算立住了。
 */
import { GraphKnowledgeClient, gkSettings } from "./client";
import { AnchorNotFound } from "./errors";
import { MAX_CANDIDATES, autopick } from "./lookup";
import { clip } from "./limits";

export type CheckLayer = {
  layer: "网络" | "P0" | "锚点" | "P3";
  ok: boolean;
  detail: Record<string, unknown>;
  error?: string;
};

const msg = (e: unknown): string => (e instanceof Error ? `${e.name}: ${e.message}` : String(e));

export async function runGraphKnowledgeCheck(opts: {
  /** 一条**真实的** issue.statement。拿假问题跑锚点层等于没测。 */
  probeQuery: string;
  viewer?: string;
  asOf?: string;
}): Promise<{ ok: boolean; stoppedAt: string | null; layers: CheckLayer[]; warnings: string[] }> {
  const settings = gkSettings();
  const client = new GraphKnowledgeClient(settings);
  const viewer = opts.viewer ?? settings.viewer;
  const asOf = opts.asOf ?? new Date().toISOString().slice(0, 10);
  const layers: CheckLayer[] = [];

  // ── ① 网络：地址配了没有、TLS 校验开没开、能不能建连 ──
  // 认证只报「配了没有」，凭据不进返回值 —— 这个结构会经 HTTP 暴露出去。
  const net: CheckLayer = {
    layer: "网络",
    ok: false,
    detail: {
      baseUrlConfigured: Boolean(settings.baseUrl),
      baseUrl: settings.baseUrl,
      authConfigured: settings.auth !== null,
      verifyTls: settings.verifyTls,
    },
  };
  try {
    net.detail.healthz = await client.health();
    net.ok = true;
  } catch (e) {
    net.error = msg(e);
  }
  layers.push(net);
  if (!net.ok) return done(layers, settings.warnings);

  // ── ② P0：公司经营状态取到没有，viewer / as_of 生效没有 ──
  const p0: CheckLayer = { layer: "P0", ok: false, detail: { viewer, asOf } };
  try {
    const text = await client.staticContext({ viewer, asOf });
    p0.detail.chars = text.length;
    p0.detail.head = text.slice(0, 200);
    // 取到一个空串和取到内容是两件事，而两者都是 200。
    p0.ok = text.trim().length > 0;
    if (!p0.ok) p0.error = "P0 返回了空正文：viewer 或 as_of 可能不对";
  } catch (e) {
    p0.error = msg(e);
  }
  layers.push(p0);
  if (!p0.ok) return done(layers, settings.warnings);

  // ── ③ 锚点：拿一条真实 issue.statement 跑 autopick ──
  const anchor: CheckLayer = {
    layer: "锚点",
    ok: false,
    detail: { probeQuery: opts.probeQuery, querySent: clip(opts.probeQuery), k: MAX_CANDIDATES },
  };
  try {
    const pick = await autopick(opts.probeQuery, "A3", client);
    anchor.ok = true;
    anchor.detail = {
      ...anchor.detail,
      anchorCode: pick.anchorCode,
      label: pick.label,
      score: pick.score,
      rankOverall: pick.rankOverall,
      ambiguous: pick.ambiguous,
      pool: pick.pool,
      runnersUp: pick.runnersUp,
    };
  } catch (e) {
    /*
     * `AnchorNotFound` **不算这一层不通**：它说明这条探针问题在图里没有对应
     * 议题，而不是锚点机制坏了。把它记成失败会让人去修一个没坏的东西。
     */
    if (e instanceof AnchorNotFound) {
      anchor.ok = true;
      anchor.detail = { ...anchor.detail, outcome: "AnchorNotFound（正常分支：转纯外部）", why: e.detail.why, pool: e.detail.pool };
    } else {
      anchor.error = msg(e);
    }
  }
  layers.push(anchor);
  if (!anchor.ok) return done(layers, settings.warnings);

  // ── ④ P3：语义段取到没有、有没有降级 ──
  const p3: CheckLayer = { layer: "P3", ok: false, detail: {} };
  try {
    const r = await client.dynamic(clip(opts.probeQuery), { k: 3, budget: 1200 });
    p3.detail = {
      seeds: (r.seeds ?? []).map((s) => ({ code: s.code, type: s.type, score: s.score })),
      chars: (r.text ?? "").length,
      // 降级不是错误：P0/P1/P2 的确定性上下文照用。但要报出来。
      degraded: r.warning ?? null,
    };
    p3.ok = true;
  } catch (e) {
    p3.error = msg(e);
  }
  layers.push(p3);
  return done(layers, settings.warnings);
}

function done(layers: CheckLayer[], warnings: string[]) {
  const failed = layers.find((l) => !l.ok);
  return { ok: !failed, stoppedAt: failed?.layer ?? null, layers, warnings };
}
```

- [ ] **Step 3: 写自检端点**

Create `src/app/api/graphknowledge/check/route.ts`:

```ts
/**
 * 本轮的主验收口：`GET /api/graphknowledge/check`。不调模型。
 *
 * 探针问题默认取库里第一条议题的标题 —— 用一条**真实**的题目跑锚点层，
 * 编出来的问题测出的只是「autopick 不崩」。要试别的就 `?q=`。
 */
import { runGraphKnowledgeCheck } from "@/lib/graphknowledge/check";
import { api } from "@/lib/data/store";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const q = (url.searchParams.get("q") ?? "").trim();
  const probeQuery = q || (await api.listIssues())[0]?.title || "";
  if (!probeQuery) {
    return Response.json(
      { ok: false, stoppedAt: "锚点", error: "库里没有议题，也没传 ?q= —— 锚点层无从测起" },
      { status: 400 }
    );
  }
  const result = await runGraphKnowledgeCheck({
    probeQuery,
    viewer: url.searchParams.get("viewer") ?? undefined,
    asOf: url.searchParams.get("as_of") ?? undefined,
  });
  return Response.json(result, { status: result.ok ? 200 : 503 });
}
```

- [ ] **Step 4: /api/health 加一项**

Modify `src/app/api/health/route.ts` —— 把 `upstream` 那个对象换成：

```ts
    // 下游配置是否就位——不暴露值，只报是否配置
    upstream: {
      model: Boolean(process.env.ARK_API_KEY || process.env.ARK_AGENT_API_KEY || process.env.DEEPSEEK_API_KEY),
      ontology: Boolean(process.env.TKOS_ONTOLOGY_BASE_URL),
      /*
       * verifyTls:false 要在这里露出来。图服务现在是 IP + 自签证书，关校验的代价
       * 是这条链路不防中间人 —— 不报出来它就会变成一个没人记得的开关。
       */
      graphknowledge: {
        configured: Boolean(process.env.TKOS_GRAPHKNOWLEDGE_BASE_URL),
        verifyTls: (process.env.TKOS_GRAPHKNOWLEDGE_VERIFY_TLS ?? "1").trim() !== "0",
      },
    },
```

（`ontology` 那一项留到第二半，随 `src/lib/ontology/` 一起删。）

- [ ] **Step 5: 类型检查与 lint**

Run: `npx tsc --noEmit && npx eslint src/lib/graphknowledge/index.ts src/lib/graphknowledge/check.ts src/app/api/graphknowledge/check/route.ts src/app/api/health/route.ts`
Expected: 无输出

- [ ] **Step 6: 跑全部单测**

Run: `pnpm test`
Expected: PASS，全绿

- [ ] **Step 7: 真的连一次图谱（本半的验收）**

起 dev server（**不要**用 Bash 跑 dev server）：`preview_start { name: "clark" }`，然后取自检结果：

```bash
curl -s http://localhost:3000/api/graphknowledge/check | head -c 3000
```

Expected: `"ok": true`，`layers` 四层齐全 —— 网络层报出 `verifyTls: false`、P0 层 `chars > 0`、锚点层带出 `anchorCode` / `score` / `rankOverall` / `runnersUp`、P3 层给出 `seeds`。

卡住时按层排查，**不要**改阈值常量：
- 卡在**网络**且错误里有「地址是空的」→ `.env.local` 的 `TKOS_GRAPHKNOWLEDGE_BASE_URL` 没被读到；`pnpm dev` 读的是 `.env.local`，确认改完重启过。
- 卡在**网络**且是 SSL 错 → `TKOS_GRAPHKNOWLEDGE_VERIFY_TLS=0` 没生效，检查 dispatcher 是否真的传下去了。
- 卡在**网络**且是 401/403 → 看 `authConfigured`；`false` 是没配，`true` 是凭据不被接受。
- 卡在**P0** 且返回空正文 → `viewer` 不对，试 `?viewer=PSN-01`。
- **锚点层** `outcome: "AnchorNotFound"` 不算失败。想看命中的样子，用 `?q=` 换一条图里确实有的议题标题。

顺手确认 health：

```bash
curl -s http://localhost:3000/api/health
```

Expected: `upstream.graphknowledge.configured` 为 `true`，`verifyTls` 为 `false`。

- [ ] **Step 8: Commit**

```bash
git add src/lib/graphknowledge/index.ts src/lib/graphknowledge/check.ts src/app/api/graphknowledge/check/route.ts src/app/api/health/route.ts
git commit -m "openContext 一扇门吃掉无锚点、放过不可达；四层自检落成验收口"
```

---

## 本半交付什么

- `GET /api/graphknowledge/check` 四层全绿 —— spec §10② 说的主验收口。
- `openContext()` 一个函数把三态封住：调用方**拿不到** `AnchorNotFound`，所以没法误接成失败；**必须处理** `GraphKnowledgeUnavailable`，所以没法把停机读成「图里没有」。
- 模型调用收到一处，四项 token 计量、两把 key 的地址配对、`ALT ≠ PRO` 都有单测。
- 21 个单测盯住六组会静默变坏的常量与规则。

## 下一半（另一份计划）

harness 基类、`prompts/engineering/`、A1a 三条路、`agentRuns` 与 `applyA1aResult`、A3/A4 换上下文源、删 `src/lib/ontology/`。分开是因为这一半自己就能验收（连接跑通），而下一半要动 agent 与数据层，评审的东西完全不同。
