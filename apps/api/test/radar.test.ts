import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { Value } from "@sinclair/typebox/value";
import { Card, type TRadarCandidateSubmission, type TRadarSourceItem } from "@warmap/contracts";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import { buildApp } from "../src/app.js";
import { createRadarService, type RadarAssessor, type RadarWebAdapter } from "../src/radar.js";
import { createBochaRadarWebAdapter, createWechatMcpAdapter } from "../src/radarSources.js";
import { createRadarAgentAssessor } from "../src/radarAgent.js";
import { createRadarScheduler } from "../src/radarScheduler.js";
import { loadCompanyMemory } from "../src/companyMemory.js";
import { migrate } from "../src/migrate.js";
import { createTestDb, testEnv, TEST_PASSWORD } from "./helpers.js";

const NOW = new Date("2026-05-02T03:00:00.000Z");
const ANCHORS = [{
  id: "anchor-market",
  title: "市场定价",
  query: "竞争对手 最新定价",
  location: { type: "battlefield", id: "growth" },
}];
const SOURCES = {
  sites: [{ id: "site-web", name: "公开 Web", enabled: true, domains: ["example.com"] }],
  wechatAccounts: [],
};

/** 契约要求每条候选附带 promotion：提交即完成 CompanyMemory 筛选并升级预研。 */
const promotionFixture = () => ({
  decisionKind: "company_direction" as const,
  decisionQuestion: "是否调整渠道策略？",
  options: ["调整渠道策略", "保持观察"],
  location: { level: "battlefield" as const, battlefieldId: "growth" },
  urgency: { level: "gray" as const },
});

const usage = {
  input: 5, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 8,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function toolStream(arguments_: TRadarCandidateSubmission) {
  const final: AssistantMessage = {
    role: "assistant",
    api: "openai-responses",
    provider: "warmap",
    model: "fake-light",
    content: [{ type: "toolCall", id: "radar-submit-1", name: "submit_candidate", arguments: arguments_ }],
    usage,
    stopReason: "toolUse",
    timestamp: Date.now(),
  };
  const events = createAssistantMessageEventStream();
  queueMicrotask(() => {
    events.push({ type: "start", partial: { ...final, content: [] } });
    events.push({ type: "toolcall_start", contentIndex: 0, partial: final });
    events.push({ type: "toolcall_end", contentIndex: 0, toolCall: final.content[0] as Extract<AssistantMessage["content"][number], { type: "toolCall" }>, partial: final });
    events.push({ type: "done", reason: "toolUse", message: final });
  });
  return events;
}

function assessor(submission: (sources: (TRadarSourceItem & { sourceFingerprint: string })[]) => TRadarCandidateSubmission): RadarAssessor {  return { async assess({ sources }) { return submission(sources); } };
}

function webItem(query: string, url: string, publishedAt: string): TRadarSourceItem {
  return {
    sourceType: "web",
    title: "去重与时间窗",
    url,
    publishedAt,
    excerpt: "连续原文",
    sourceRef: { type: "web-search", provider: "recorded-web", query },
  };
}

function outletItem(index: number): TRadarSourceItem {
  return {
    sourceType: "outlet",
    title: `发布方条目 ${index}`,
    url: `https://www.ft.com/content/outlet-${index}`,
    publishedAt: "2026-05-01T08:00:00.000Z",
    excerpt: `发布方连续原文 ${index}`,
    sourceRef: { type: "outlet", provider: "publisher-feed", outletId: "ft", outletName: "金融时报" },
  };
}

async function login(app: Awaited<ReturnType<typeof buildApp>>): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    headers: { origin: testEnv.publicOrigin },
    payload: { password: TEST_PASSWORD },
  });
  return (response.headers["set-cookie"] as string).split(";")[0];
}

describe("Radar source adapter public seam", () => {
  it("normalizes recorded Bocha Web and account-level WeChat MCP responses without keyword substitution", async () => {
    const requests: { url: string; authorization: string | null; body: Record<string, unknown> }[] = [];
    const fakeFetch: typeof fetch = async (input, init) => {
      requests.push({
        url: String(input),
        authorization: new Headers(init?.headers).get("authorization"),
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      });
      return new Response(JSON.stringify({ code: 200, data: { webPages: { value: [{
        name: "Web 公告",
        url: "https://example.com/web",
        summary: "Web 摘录",
        datePublished: "2026-05-01T08:00:00+08:00",
      }] } } }), { status: 200, headers: { "content-type": "application/json" } });
    };

    const web = createBochaRadarWebAdapter({ apiKey: "bocha-key", endpoint: "https://bocha.invalid/web-search", fetch: fakeFetch });
    const webItems = await web.search({ query: "市场变化", domains: ["example.com"] }, new AbortController().signal);
    expect(webItems[0]).toEqual({
      sourceType: "web",
      title: "Web 公告",
      url: "https://example.com/web",
      publishedAt: "2026-05-01T00:00:00.000Z",
      excerpt: "Web 摘录",
      sourceRef: { type: "web-search", provider: "bocha", query: "市场变化" },
    });
    expect(requests[0].url).toBe("https://bocha.invalid/web-search");
    expect(requests[0].authorization).toBe("Bearer bocha-key");
    expect(requests[0].body).toMatchObject({ query: "市场变化 site:example.com", summary: true });

    const calls: { name: string; args: Record<string, unknown> }[] = [];
    const wechat = createWechatMcpAdapter({
      url: "http://wechat:5000/mcp",
      token: "wechat-mcp-token",
      callTool: async (name, args) => {
        calls.push({ name, args });
        if (name === "list_subscriptions") return [{ fakeid: "wx-account-42", nickname: "增长观察" }];
        if (name === "get_recent_articles") {
          return { articles: [{
            id: 7,
            title: "公众号文章",
            digest: "",
            link: "https://mp.weixin.qq.com/s/account-article",
            publish_time: 1777626000,
          }], next_since: 0 };
        }
        if (name === "read_article") return "---\ntitle: x\n---\n\n全文摘录内容";
        throw new Error(`unexpected tool ${name}`);
      },
    });
    const wechatItems = await wechat.fetchLatest({ accountId: "wx-account-42", accountName: "增长观察" }, new AbortController().signal);
    expect(wechatItems[0]).toMatchObject({
      sourceType: "wechat-account",
      title: "公众号文章",
      url: "https://mp.weixin.qq.com/s/account-article",
      publishedAt: new Date(1777626000 * 1000).toISOString(),
      excerpt: "全文摘录内容",
      sourceRef: { type: "wechat-account", provider: "wechat-mcp", accountId: "wx-account-42", accountName: "增长观察" },
    });
    expect(calls.map((call) => call.name)).toEqual(["list_subscriptions", "get_recent_articles", "read_article"]);
    expect(calls[1].args).toEqual({ since: 0, limit: 30, source_id: "wx-account-42" });
  });

  it("公众号全文：digest 不再代表原文；单次扫描全文读取至多 15 次，超出退回 digest", async () => {
    let reads = 0;
    const wechat = createWechatMcpAdapter({
      callTool: async (name, args) => {
        if (name === "list_subscriptions") return [{ fakeid: "acc-1", nickname: "机器之心" }];
        if (name === "get_recent_articles") {
          return { articles: Array.from({ length: 17 }, (_, index) => ({
            id: index + 1,
            title: `文章 ${index + 1}`,
            digest: `digest-${index + 1}`,
            link: `https://mp.weixin.qq.com/s/a-${index + 1}`,
            publish_time: 1777626000 + index,
          })) };
        }
        if (name === "read_article") {
          reads += 1;
          return `---\ntitle: x\n---\n\n全文段落一\n\n${"内".repeat(30)}\n\n全文段落二`;
        }
        throw new Error(`unexpected tool ${name}`);
      },
    });
    const items = await wechat.fetchLatest({ accountId: "acc-1", accountName: "机器之心" }, new AbortController().signal);
    expect(reads).toBe(15);
    expect(items[0].excerpt).toBe(`全文段落一\n\n${"内".repeat(30)}\n\n全文段落二`);
    expect(items[15].excerpt).toBe("digest-16");
    expect(items[16].excerpt).toBe("digest-17");
  });

  it("rejects an unsubscribed WeChat account instead of substituting keyword search", async () => {
    const wechat = createWechatMcpAdapter({
      url: "http://wechat:5000/mcp",
      token: "wechat-mcp-token",
      callTool: async (name) => {
        if (name === "list_subscriptions") return [{ fakeid: "some-other-account" }];
        throw new Error(`unexpected tool ${name}`);
      },
    });
    await expect(wechat.fetchLatest({ accountId: "wx-account-42", accountName: "增长观察" }, new AbortController().signal))
      .rejects.toThrow(/不在公众号 sidecar 订阅列表/);
  });

  it("reports the Web Search provider honestly when BOCHA_API_KEY is absent", async () => {
    const web = createBochaRadarWebAdapter({});
    expect(web.configured).toBe(false);
    await expect(web.search({ query: "市场变化" }, new AbortController().signal)).rejects.toThrow(/BOCHA_API_KEY/);
  });
});

describe("Radar scheduled/manual public seam", () => {
  it("authenticates manual scans, shares the scheduled pipeline, and reserves one Company Day only for scheduled", async () => {
    await createTestDb(async ({ db, pool }) => {
      await migrate(db);
      await db.query("UPDATE radar_config SET anchors = $1::jsonb, sources = $2::jsonb WHERE id = 'default'", [
        JSON.stringify(ANCHORS), JSON.stringify(SOURCES),
      ]);
      const calls: string[] = [];
      const web: RadarWebAdapter = {
        configured: true,
        async search(input) {
          calls.push(input.query);
          return [{
            sourceType: "web",
            title: "竞争对手公告",
            url: "HTTPS://Example.com/pricing/?utm_source=newsletter&b=2&a=1#top",
            publishedAt: "2026-05-01T08:00:00.000Z",
            excerpt: "公告确认价格将在六月一日调整，具体地区另行通知。",
            sourceRef: { type: "web-search", provider: "recorded-web", query: input.query },
          }];
        },
      };
      const radar = createRadarService({
        pool,
        web,
        assessor: assessor(([source]) => ({ candidates: [{
          sourceFingerprint: source.sourceFingerprint,
          anchorId: "anchor-market",
          summary: "竞争对手将调整价格",
          strategicImpact: "需要 CEO 判断是否跟进价格窗口",
          evidenceQuote: "价格将在六月一日调整",
          unknowns: ["覆盖地区"],
          score: { relevance: 5, impact: 4, urgency: 3 },
          promotion: promotionFixture(),
        }] })),
        now: () => NOW,
      });
      const app = await buildApp({
        pool,
        env: testEnv,
        radarService: radar,
        conversationRuntime: { async run(input) { return { assistantMessage: "test", runtimeEntries: input.runtimeEntries }; } },
      });
      try {
        const anonymous = await app.inject({ method: "POST", url: "/api/radar/scans/manual" });
        expect(anonymous.statusCode).toBe(401);
        const cookie = await login(app);
        const wrongOrigin = await app.inject({ method: "POST", url: "/api/radar/scans/manual", headers: { cookie } });
        expect(wrongOrigin.statusCode).toBe(403);

        const manual = await app.inject({
          method: "POST",
          url: "/api/radar/scans/manual",
          headers: { cookie, origin: testEnv.publicOrigin },
        });
        expect(manual.statusCode).toBe(200);
        expect(manual.json()).toMatchObject({ trigger: "manual", status: "completed", companyDay: "2026-05-02", createdSignals: 1 });

        const scheduler = createRadarScheduler(radar);
        const scheduled = await radar.runScheduled();
        expect(scheduled).toMatchObject({ trigger: "scheduled", status: "completed", companyDay: "2026-05-02", createdSignals: 0 });
        await expect(scheduler.tick()).resolves.toBeUndefined();
        expect(await radar.runScheduled()).toMatchObject({ status: "skipped", companyDay: "2026-05-02" });
        expect(calls).toHaveLength(2);

        const saved = await db.query("SELECT source_url, source_fingerprint, source_ref, evidence_quote, location FROM signals");
        expect(saved.rows).toHaveLength(1);
        expect(saved.rows[0]).toMatchObject({
          source_url: "https://example.com/pricing?a=1&b=2",
          source_ref: { type: "web-search", provider: "recorded-web", query: "竞争对手 最新定价" },
          evidence_quote: "价格将在六月一日调整",
          location: { type: "battlefield", id: "growth" },
        });
        expect(saved.rows[0].source_fingerprint).toMatch(/^[a-f0-9]{64}$/);
      } finally {
        await app.close();
      }
    });
  });

  it("enforces the deterministic time window and URL fingerprint dedupe in code", async () => {
    await createTestDb(async ({ db, pool }) => {
      await migrate(db);
      await db.query("UPDATE radar_config SET anchors = $1::jsonb, sources = $2::jsonb WHERE id = 'default'", [
        JSON.stringify(ANCHORS), JSON.stringify(SOURCES),
      ]);
      const radar = createRadarService({
        pool,
        web: {
          configured: true,
          async search(input) {
            return [
              { ...webItem(input.query, "https://example.com/dup?utm_medium=x", "2026-05-01T08:00:00.000Z") },
              { ...webItem(input.query, "https://example.com/dup/", "2026-05-01T09:00:00.000Z") },
              { ...webItem(input.query, "https://example.com/stale", "2026-04-01T00:00:00.000Z") },
            ];
          },
        },
        assessor: assessor((sources) => ({ candidates: sources.map((source) => ({
          sourceFingerprint: source.sourceFingerprint,
          anchorId: "anchor-market",
          summary: "候选",
          strategicImpact: "待判断",
          evidenceQuote: "连续原文",
          unknowns: [],
          score: { relevance: 4, impact: 3, urgency: 2 },
          promotion: promotionFixture(),
        })) })),
        now: () => NOW,
      });
      const result = await radar.runManual();
      expect(result).toMatchObject({ status: "completed", createdSignals: 1 });
      expect(result.warnings.join(" ")).toContain("超出时间窗");
      expect(Number((await db.query("SELECT count(*) FROM signals")).rows[0].count)).toBe(1);
    });
  });

  it("fails the scan visibly instead of throwing when the database is unavailable, and the scheduler tick never crashes the process", async () => {
    const radar = createRadarService({
      pool: { connect: async () => { throw new Error("postgres is down"); } } as unknown as Parameters<typeof createRadarService>[0]["pool"],
      web: { configured: true, async search() { return []; } },
      assessor: assessor(() => ({ candidates: [] })),
      now: () => NOW,
    });
    await expect(radar.runManual()).resolves.toMatchObject({ status: "failed", createdSignals: 0 });

    const scheduler = createRadarScheduler({
      providerStatus: { web: false, wechat: false },
      runManual: async () => ({ trigger: "manual" as const, status: "failed" as const, companyDay: "2026-05-02", createdSignals: 0, warnings: [] }),
      runScheduled: async () => { throw new Error("scheduler blip"); },
    });
    await expect(scheduler.tick()).resolves.toBeUndefined();
  });

  it("aborts a provider that never answers and releases the lock instead of hanging forever", async () => {
    await createTestDb(async ({ db, pool }) => {
      await migrate(db);
      await db.query("UPDATE radar_config SET anchors = $1::jsonb, sources = $2::jsonb WHERE id = 'default'", [
        JSON.stringify(ANCHORS), JSON.stringify(SOURCES),
      ]);
      let observedAbort = false;
      const radar = createRadarService({
        pool,
        web: {
          configured: true,
          search(_input, signal) {
            return new Promise((_resolve, reject) => {
              signal.addEventListener("abort", () => { observedAbort = true; reject(signal.reason); }, { once: true });
            });
          },
        },
        assessor: assessor(() => ({ candidates: [] })),
        now: () => NOW,
        scanTimeoutMs: 20,
      });
      await expect(radar.runManual()).resolves.toMatchObject({ status: "failed", createdSignals: 0 });
      expect(observedAbort).toBe(true);
      // 锁已释放：后续扫描不会因为上一次悬挂而一直 busy
      await expect(radar.runManual()).resolves.not.toMatchObject({ status: "busy" });
    });
  });

  it("stops scheduling assess batches after the timeout signal fires", async () => {
    await createTestDb(async ({ db, pool }) => {
      await migrate(db);
      await db.query("UPDATE radar_config SET anchors = $1::jsonb, sources = $2::jsonb WHERE id = 'default'", [
        JSON.stringify(ANCHORS), JSON.stringify(SOURCES),
      ]);
      let calls = 0;
      const radar = createRadarService({
        pool,
        web: {
          configured: true,
          async search(input) {
            return Array.from({ length: 10 }, (_, index) => webItem(input.query, `https://example.com/slow-${index}`, "2026-05-01T08:00:00.000Z"));
          },
        },
        assessor: {
          // 模拟一个已启动后忽略 abort 的模型调用；修复前它返回后会继续启动后续 batch。
          async assess() {
            calls += 1;
            await new Promise((resolve) => setTimeout(resolve, 50));
            return { candidates: [] };
          },
        },
        now: () => NOW,
        scanTimeoutMs: 20,
      });
      const result = await radar.runManual();
      expect(result.status).toBe("failed");
      expect(result.warnings.join(" ")).toContain("Radar scan exceeded 20ms");
      expect(calls).toBe(1);
    });
  });

  it("caps publisher-feed items globally before assess", async () => {
    await createTestDb(async ({ db, pool }) => {
      await migrate(db);
      const sources = {
        sites: [],
        wechatAccounts: [],
        outlets: [{ id: "outlet-finance", name: "全球财经媒体", enabled: true, outlets: ["ft", "bbc"] }],
      };
      await db.query("UPDATE radar_config SET anchors = $1::jsonb, sources = $2::jsonb WHERE id = 'default'", [
        JSON.stringify(ANCHORS), JSON.stringify(sources),
      ]);
      const batches: number[] = [];
      const received: { outletIds: string[]; lookbackHours: number }[] = [];
      const radar = createRadarService({
        pool,
        web: { configured: false, async search() { return []; } },
        outlets: {
          configured: true,
          async fetchLatest(input) {
            received.push(input);
            return Array.from({ length: 25 }, (_, index) => outletItem(index));
          },
        },
        assessor: {
          async assess({ sources: batch }) {
            batches.push(batch.length);
            return { candidates: [] };
          },
        },
        now: () => NOW,
      });
      const result = await radar.runManual();
      expect(result.status).toBe("completed");
      expect(received).toEqual([{ outletIds: ["ft", "bbc"], lookbackHours: 48 }]);
      expect(batches).toEqual([5, 5, 5, 5]);
      expect(result.warnings.join(" ")).toContain("超过总上限 20 条，已截断");
    });
  });

  it("bounds anchors and assess batches, and keeps only the successful batches", async () => {
    await createTestDb(async ({ db, pool }) => {
      await migrate(db);
      const anchors = Array.from({ length: 25 }, (_, index) => ({
        id: `anchor-${index}`,
        title: `方向 ${index}`,
        query: `查询 ${index}`,
        location: { type: "company" as const },
      }));
      await db.query("UPDATE radar_config SET anchors = $1::jsonb, sources = $2::jsonb WHERE id = 'default'", [
        JSON.stringify(anchors), JSON.stringify(SOURCES),
      ]);
      const queries: string[] = [];
      const batches: number[] = [];
      let call = 0;
      const radar = createRadarService({
        pool,
        web: {
          configured: true,
          async search(input) {
            queries.push(input.query);
            return Array.from({ length: 1 }, (_, index) => ({
              ...webItem(input.query, `https://example.com/${input.query}/${index}`, "2026-05-01T08:00:00.000Z"),
              excerpt: `连续原文 ${input.query} ${index}`,
            }));
          },
        },
        assessor: {
          async assess({ sources }) {
            batches.push(sources.length);
            call += 1;
            // 第二批整体失败：该批候选不得落库，其余批继续
            if (call === 2) throw new Error("assess batch outage");
            return { candidates: sources.map((source) => ({
              sourceFingerprint: source.sourceFingerprint,
              anchorId: "anchor-0",
              summary: "批量候选",
              strategicImpact: "待判断",
              evidenceQuote: "连续原文",
              unknowns: [],
              score: { relevance: 4, impact: 3, urgency: 2 },
              promotion: promotionFixture(),
            })) };
          },
        },
        now: () => NOW,

      });
      const result = await radar.runManual();
      expect(result.status).toBe("completed");
      expect(result.warnings.join(" ")).toContain("Radar 监测方向超过上限");
      expect(result.warnings.join(" ")).toContain("assess batch outage");
      expect(queries).toHaveLength(20);
      // 4 批 × 5 条；第 2 批失败，其余 3 批各保存 5 条候选
      expect(batches).toEqual([5, 5, 5, 5]);
      expect(result.createdSignals).toBe(15);
      expect(Number((await db.query("SELECT count(*) FROM signals")).rows[0].count)).toBe(15);
    });
  });

  it("marks an interrupted running scan as failed on startup instead of leaving it running", async () => {
    await createTestDb(async ({ db, pool }) => {
      await migrate(db);
      await db.query(
        "UPDATE radar_config SET scheduled_company_day = '2026-05-02'::date, last_run = $1::jsonb WHERE id = 'default'",
        [JSON.stringify({ trigger: "scheduled", status: "running", companyDay: "2026-05-02", startedAt: NOW.toISOString(), warnings: [] })],
      );
      const radar = createRadarService({
        pool,
        web: { configured: true, async search() { return []; } },
        assessor: assessor(() => ({ candidates: [] })),
        now: () => NOW,
      });
      const app = await buildApp({
        pool,
        env: testEnv,
        radarService: radar,
        conversationRuntime: { async run(input) { return { assistantMessage: "test", runtimeEntries: input.runtimeEntries }; } },
      });
      try {
        await radar.recoverStaleRuns();
        const card = await app.inject({ method: "GET", url: "/api/cards/radar", headers: { cookie: await login(app) } });
        expect(card.json().cards[0].payload.lastRun).toMatchObject({ status: "failed", trigger: "scheduled", companyDay: "2026-05-02" });
        expect(card.json().cards[0].payload.lastRun.warnings.join(" ")).toContain("进程重启");
      } finally {
        await app.close();
      }
    });
  });

  it("does not clobber a live scan on another process and settles stale Radar AgentRuns", async () => {
    await createTestDb(async ({ db, pool }) => {
      await migrate(db);
      await db.query("UPDATE radar_config SET anchors = $1::jsonb, sources = $2::jsonb WHERE id = 'default'", [
        JSON.stringify(ANCHORS), JSON.stringify(SOURCES),
      ]);
      await db.query(
        `INSERT INTO agent_runs (id, kind, status, model_slot, prompt_hash, input_snapshot)
         VALUES (gen_random_uuid(), 'radar-assess', 'running', 'light', 'hash', '{}'::jsonb)`,
      );
      let release!: () => void;
      let started!: () => void;
      const waiting = new Promise<void>((resolve) => { release = resolve; });
      const entered = new Promise<void>((resolve) => { started = resolve; });
      const radar = createRadarService({
        pool,
        web: {
          configured: true,
          async search() { started(); await waiting; return []; },
        },
        assessor: assessor(() => ({ candidates: [] })),
        now: () => NOW,
      });
      const scan = radar.runManual();
      await entered;
      try {
        // 另一个进程启动：不得把正在运行的扫描标为中断
        await radar.recoverStaleRuns();
        const live = await db.query("SELECT last_run->>'status' AS status FROM radar_config WHERE id = 'default'");
        expect(live.rows[0].status).toBe("running");
      } finally {
        release();
      }
      expect(await scan).toMatchObject({ status: "completed" });
      // 崩溃遗留的 Radar AgentRun 在启动补偿时标为 failed
      await radar.recoverStaleRuns();
      expect((await db.query("SELECT status FROM agent_runs WHERE kind = 'radar-assess'")).rows[0].status).toBe("failed");
    });
  });

  it("reports a total assess failure as a failed scan instead of completed", async () => {
    await createTestDb(async ({ db, pool }) => {
      await migrate(db);
      await db.query("UPDATE radar_config SET anchors = $1::jsonb, sources = $2::jsonb WHERE id = 'default'", [
        JSON.stringify(ANCHORS), JSON.stringify(SOURCES),
      ]);
      const radar = createRadarService({
        pool,
        web: {
          configured: true,
          async search(input) { return [webItem(input.query, "https://example.com/assess-down", "2026-05-01T08:00:00.000Z")]; },
        },
        assessor: { async assess() { throw new Error("assess model down"); } },
        now: () => NOW,
      });
      const result = await radar.runManual();
      expect(result).toMatchObject({ status: "failed", createdSignals: 0 });
      expect(result.warnings.join(" ")).toContain("assess model down");
      expect(Number((await db.query("SELECT count(*) FROM signals")).rows[0].count)).toBe(0);
    });
  });

  it("uses the PostgreSQL lock to reject overlap and does not consume the scheduled day", async () => {
    await createTestDb(async ({ db, pool }) => {
      await migrate(db);
      await db.query("UPDATE radar_config SET anchors = $1::jsonb, sources = $2::jsonb WHERE id = 'default'", [
        JSON.stringify(ANCHORS), JSON.stringify(SOURCES),
      ]);
      let release!: () => void;
      let started!: () => void;
      const waiting = new Promise<void>((resolve) => { release = resolve; });
      const entered = new Promise<void>((resolve) => { started = resolve; });
      const radar = createRadarService({
        pool,
        web: {
          configured: true,
          async search() {
            started();
            await waiting;
            return [];
          },
        },
        assessor: assessor(() => ({ candidates: [] })),
        now: () => NOW,
      });
      const manual = radar.runManual();
      await entered;
      expect(await radar.runScheduled()).toMatchObject({ status: "busy" });
      release();
      expect(await manual).toMatchObject({ status: "completed" });
      expect(await radar.runScheduled()).toMatchObject({ status: "completed", companyDay: "2026-05-02" });
    });
  });

  it("makes provider failure visible after one attempt and performs no automatic retry", async () => {
    await createTestDb(async ({ db, pool }) => {
      await migrate(db);
      await db.query("UPDATE radar_config SET anchors = $1::jsonb, sources = $2::jsonb WHERE id = 'default'", [
        JSON.stringify(ANCHORS), JSON.stringify(SOURCES),
      ]);
      let calls = 0;
      const radar = createRadarService({
        pool,
        web: {
          configured: true,
          async search() {
            calls += 1;
            throw new Error("recorded provider outage");
          },
        },
        assessor: assessor(() => ({ candidates: [] })),
        now: () => NOW,
      });
      const result = await radar.runManual();
      expect(result).toMatchObject({ status: "failed", createdSignals: 0 });
      expect(result.warnings.join(" ")).toContain("recorded provider outage");
      expect(calls).toBe(1);
      expect((await db.query("SELECT last_run FROM radar_config WHERE id = 'default'")).rows[0].last_run).toMatchObject({ status: "failed" });
    });
  });
});

describe("strict Radar Candidate Tool to Signal persistence", () => {
  it("persists only the strict Tool candidate after deterministic quote and ownership checks", async () => {
    await createTestDb(async ({ db, pool }) => {
      await migrate(db);
      await db.query("UPDATE radar_config SET anchors = $1::jsonb, sources = $2::jsonb WHERE id = 'default'", [
        JSON.stringify(ANCHORS), JSON.stringify(SOURCES),
      ]);
      const expectedFingerprint = createHash("sha256").update("v1\nhttps://example.com/tool-result").digest("hex");
      const radar = createRadarService({
        pool,
        web: {
          configured: true,
          async search(input) {
            return [{
              sourceType: "web",
              title: "严格候选公告",
              url: "https://example.com/tool-result?utm_source=recording",
              publishedAt: "2026-05-01T08:00:00.000Z",
              excerpt: "原文明确写道渠道政策将在六月调整。",
              sourceRef: { type: "web-search", provider: "recorded-web", query: input.query },
            }];
          },
        },
        assessor: await createRadarAgentAssessor({
          query: pool.query.bind(pool),
          companyMemory: loadCompanyMemory(testEnv),
          baseUrl: "https://provider.invalid/v1/responses",
          apiKey: "test-key",
          modelId: "fake-light",
          streamSimple: () => toolStream({ candidates: [{
            sourceFingerprint: expectedFingerprint,
            anchorId: "anchor-market",
            summary: "渠道政策即将调整",
            strategicImpact: "需要重新判断渠道策略",
            evidenceQuote: "渠道政策将在六月调整",
            unknowns: [],
            score: { relevance: 5, impact: 4, urgency: 3 },
            promotion: promotionFixture(),
          }] }),
        }),
        now: () => NOW,
      });

      expect(await radar.runManual()).toMatchObject({ status: "completed", createdSignals: 1 });
      expect((await db.query("SELECT summary FROM signals")).rows).toEqual([{ summary: "渠道政策即将调整" }]);
      expect((await db.query("SELECT kind, status, candidate_output FROM agent_runs WHERE kind = 'radar-assess'")).rows[0]).toMatchObject({
        kind: "radar-assess",
        status: "succeeded",
        candidate_output: { candidates: [{ sourceFingerprint: expectedFingerprint }] },
      });
    });
  });

  it("rejects a candidate whose quote is not contiguous in its attributed excerpt", async () => {
    await createTestDb(async ({ db, pool }) => {
      await migrate(db);
      await db.query("UPDATE radar_config SET anchors = $1::jsonb, sources = $2::jsonb WHERE id = 'default'", [
        JSON.stringify(ANCHORS), JSON.stringify(SOURCES),
      ]);
      const radar = createRadarService({
        pool,
        web: {
          configured: true,
          async search(input) {
            return [{
              sourceType: "web",
              title: "引文测试",
              url: "https://example.com/quote",
              publishedAt: "2026-05-01T08:00:00.000Z",
              excerpt: "原文只说价格可能调整。",
              sourceRef: { type: "web-search", provider: "recorded-web", query: input.query },
            }];
          },
        },
        assessor: assessor(([source]) => ({ candidates: [{
          sourceFingerprint: source.sourceFingerprint,
          anchorId: "anchor-market",
          summary: "模型候选",
          strategicImpact: "待判断",
          evidenceQuote: "价格确定将在六月调整",
          unknowns: [],
          score: { relevance: 4, impact: 3, urgency: 2 },
          promotion: promotionFixture(),
        }] })),
        now: () => NOW,
      });
      const result = await radar.runManual();
      expect(result).toMatchObject({ status: "completed", createdSignals: 0 });
      expect(result.warnings.join(" ")).toContain("引文或归属校验");
      expect(Number((await db.query("SELECT count(*) FROM signals")).rows[0].count)).toBe(0);
    });
  });
});

describe("Radar and Signal Card/API seam", () => {
  it("shows unconfigured WeChat honestly and keeps read, saved, dismissed independent", async () => {
    await createTestDb(async ({ db, pool }) => {
      await migrate(db);
      const id = "11111111-1111-4111-8111-111111111111";
      await db.query(
        `INSERT INTO signals
           (id, version, source_type, source_fingerprint, source_title, source_url, published_at, excerpt,
            source_ref, anchor_id, location, summary, strategic_impact, evidence_quote, unknowns, score)
         VALUES ($1, 1, 'web', $2, '公告', 'https://example.com/news', $3, '连续原文引文',
                 $4::jsonb, 'anchor-market', $5::jsonb, '摘要', '战略影响', '连续原文', '[]'::jsonb, $6::jsonb)`,
        [
          id,
          "b".repeat(64),
          NOW,
          JSON.stringify({ type: "web-search", provider: "recorded-web", query: "公告" }),
          JSON.stringify({ type: "company" }),
          JSON.stringify({ relevance: 4, impact: 3, urgency: 2 }),
        ],
      );
      const app = await buildApp({
        pool,
        env: testEnv,
        conversationRuntime: { async run(input) { return { assistantMessage: "test", runtimeEntries: input.runtimeEntries }; } },
      });
      try {
        const cookie = await login(app);
        const radar = await app.inject({ method: "GET", url: "/api/cards/radar", headers: { cookie } });
        expect(radar.statusCode).toBe(200);
        expect(Value.Check(Card, radar.json().cards[0])).toBe(true);
        expect(radar.json().cards[0]).toMatchObject({
          kind: "radar",
          payload: { unreadCount: 1, sources: { wechat: { configured: false, message: "未配置微信公众号账号级来源" } } },
        });

        const list = await app.inject({ method: "GET", url: "/api/cards/signals", headers: { cookie } });
        expect(list.statusCode).toBe(200);
        expect(list.json().cards).toHaveLength(1);
        expect(Value.Check(Card, list.json().cards[0])).toBe(true);
        expect(list.json().cards[0]).toMatchObject({ kind: "signal", payload: { state: { read: false, saved: false, dismissed: false } } });

        for (const payload of [{ read: true }, { saved: true }, { dismissed: true }]) {
          const updated = await app.inject({
            method: "PATCH",
            url: `/api/signals/${id}/state`,
            headers: { cookie, origin: testEnv.publicOrigin },
            payload,
          });
          expect(updated.statusCode).toBe(200);
        }
        const detail = await app.inject({ method: "GET", url: `/api/cards/signals/${id}`, headers: { cookie } });
        expect(detail.json().cards[0].payload).toMatchObject({
          source: { title: "公告", url: "https://example.com/news", excerpt: "连续原文引文" },
          state: { read: true, saved: true, dismissed: true },
        });

        const unread = await app.inject({
          method: "PATCH",
          url: `/api/signals/${id}/state`,
          headers: { cookie, origin: testEnv.publicOrigin },
          payload: { read: false },
        });
        expect(unread.json().cards[0].payload.state).toEqual({ read: false, saved: true, dismissed: true });

        // 重复同一状态不改变版本：Signal version 仍是变更指示器
        const repeat = await app.inject({
          method: "PATCH",
          url: `/api/signals/${id}/state`,
          headers: { cookie, origin: testEnv.publicOrigin },
          payload: { read: false },
        });
        expect(repeat.json().cards[0].version).toBe(unread.json().cards[0].version);

        // 隐藏后不再计入未读投影
        await app.inject({
          method: "PATCH",
          url: `/api/signals/${id}/state`,
          headers: { cookie, origin: testEnv.publicOrigin },
          payload: { read: true, dismissed: true },
        });
        const after = await app.inject({ method: "GET", url: "/api/cards/radar", headers: { cookie } });
        expect(after.json().cards[0].payload.unreadCount).toBe(0);
      } finally {
        await app.close();
      }
    });
  });
});

describe("publisher outlet Signal persistence", () => {
  it("把发布方 feed 条目按 source_type=outlet 落库，不回落全网检索", async () => {
    await createTestDb(async ({ db, pool }) => {
      await migrate(db);
      const url = "https://www.bloomberg.com/news/articles/2026-09-18/treasury-basis-trade";
      const excerpt = "Treasury basis trade overview for the bond market.";
      await db.query("UPDATE radar_config SET anchors = $1::jsonb, sources = $2::jsonb WHERE id = 'default'", [
        JSON.stringify(ANCHORS),
        JSON.stringify({
          sites: [],
          wechatAccounts: [],
          outlets: [{ id: "global-finance", name: "全球财经媒体", enabled: true, outlets: ["bloomberg"] }],
        }),
      ]);
      const expectedFingerprint = createHash("sha256").update(`v1\n${url}`).digest("hex");
      let webCalls = 0;
      const radar = createRadarService({
        pool,
        web: { configured: true, async search() { webCalls += 1; return []; } },
        outlets: {
          configured: true,
          async fetchLatest(request) {
            expect(request).toEqual({ outletIds: ["bloomberg"], lookbackHours: 48 });
            return [{
              sourceType: "outlet",
              title: "Treasury basis trade",
              url,
              publishedAt: "2026-05-01T08:00:00.000Z",
              excerpt,
              sourceRef: { type: "outlet", provider: "publisher-feed", outletId: "bloomberg", outletName: "彭博" },
            }];
          },
        },
        assessor: await createRadarAgentAssessor({
          query: pool.query.bind(pool),
          companyMemory: loadCompanyMemory(testEnv),
          baseUrl: "https://provider.invalid/v1/responses",
          apiKey: "test-key",
          modelId: "fake-light",
          streamSimple: () => toolStream({ candidates: [{
            sourceFingerprint: expectedFingerprint,
            anchorId: "anchor-market",
            summary: "债券市场承压",
            strategicImpact: "需要判断融资成本",
            evidenceQuote: "Treasury basis trade overview",
            unknowns: [],
            score: { relevance: 5, impact: 4, urgency: 3 },
            promotion: promotionFixture(),
          }] }),
        }),
        now: () => NOW,
      });

      expect(await radar.runManual()).toMatchObject({ status: "completed", createdSignals: 1 });
      expect((await db.query("SELECT source_type, source_title FROM signals")).rows)
        .toEqual([{ source_type: "outlet", source_title: "Treasury basis trade" }]);
      expect(webCalls).toBe(0);
    });
  });
});
