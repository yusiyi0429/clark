import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { Value } from "@sinclair/typebox/value";
import { Card, type TRadarCandidateSubmission, type TRadarSourceItem } from "@warmap/contracts";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import { buildApp } from "../src/app.js";
import { createRadarService, RADAR_SCAN_TIMEOUT_MS, type RadarAssessor, type RadarWebAdapter } from "../src/radar.js";
import { createBochaRadarWebAdapter, createWechatMcpAdapter } from "../src/radarSources.js";
import { createBochaWebSearchAdapter } from "../src/webSearch.js";
import { createRadarAgentAssessor } from "../src/radarAgent.js";
import { createRadarScheduler } from "../src/radarScheduler.js";
import { loadCompanyMemory } from "../src/companyMemory.js";
import { projectSignalCard, shortSignalTitle } from "../src/signals.js";
import { migrate } from "../src/migrate.js";
import { createTestDb, seedTestAccess, testEnv, TEST_LOGIN } from "./helpers.js";

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

function anchorList(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    id: `anchor-${index}`,
    title: `方向 ${index}`,
    query: `查询 ${index}`,
    location: { type: "company" as const },
  }));
}

/** 每个监测方向返回 3 条不同 URL 的网页结果（恰好不触发每方向上限）。 */
const threeWebItemsPerAnchor: RadarWebAdapter = {
  configured: true,
  async search(input) {
    return Array.from({ length: 3 }, (_, index) => webItem(input.query, `https://example.com/${input.query}/${index}`, "2026-05-01T08:00:00.000Z"));
  },
};

async function login(app: Awaited<ReturnType<typeof buildApp>>, db: { query: (text: string, params?: unknown[]) => Promise<unknown> }): Promise<string> {
  await seedTestAccess(db);
  const response = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    headers: { origin: testEnv.publicOrigin },
    payload: TEST_LOGIN,
  });
  return (response.headers["set-cookie"] as string).split(";")[0];
}

describe("Radar source adapter public seam", () => {
  it("核心观点作为标题时最多显示 30 个字符", () => {
    expect(Array.from(shortSignalTitle("出现覆盖企业智能体授权、Skill 安全、运行控制与审计复盘的全生命周期安全治理方案。")).length).toBe(30);
    expect(shortSignalTitle("短观点")).toBe("短观点");
  });
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

    const web = createBochaRadarWebAdapter(createBochaWebSearchAdapter({ apiKey: "bocha-key", endpoint: "https://bocha.invalid/web-search", fetch: fakeFetch }));
    const webItems = await web.search({ query: "市场变化", domains: ["example.com"], lookbackHours: 48 }, new AbortController().signal);
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
          return `---\ntitle: x\n---\n\n全文段落一\n\n![配图](https://mmbiz.qpic.cn/example.jpg)\n\n${"内".repeat(30)}\n\n全文段落二`;
        }
        throw new Error(`unexpected tool ${name}`);
      },
    });
    const items = await wechat.fetchLatest({ accountId: "acc-1", accountName: "机器之心" }, new AbortController().signal);
    expect(reads).toBe(15);
    expect(items[0].excerpt).toBe(`全文段落一\n\n${"内".repeat(30)}\n\n全文段落二`);
    expect(items[0].images).toEqual([{ src: "https://mmbiz.qpic.cn/example.jpg", after: 0 }]);
    expect(items[15].excerpt).toBe("digest-16");
    expect(items[16].excerpt).toBe("digest-17");
    // 逐条记下原文完整度：read_article 读到的标 fullText，退回 digest 的不标
    expect(items[0].sourceRef).toMatchObject({ type: "wechat-account", fullText: true });
    expect(items[15].sourceRef).not.toHaveProperty("fullText");
  });

  it("公众号全文标记：read_article 失败或读空时退回 digest，不标 fullText", async () => {
    const wechat = createWechatMcpAdapter({
      callTool: async (name, args) => {
        if (name === "list_subscriptions") return [{ fakeid: "acc-1", nickname: "机器之心" }];
        if (name === "get_recent_articles") {
          return { articles: [1, 2, 3].map((id) => ({
            id, title: `文章 ${id}`, digest: `digest-${id}`, link: `https://mp.weixin.qq.com/s/a-${id}`, publish_time: 1777626000 + id,
          })) };
        }
        if (name === "read_article") {
          if (args.article_id === 1) return "---\ntitle: x\n---\n\n全文段落";
          if (args.article_id === 2) return "";
          throw new Error("sidecar 抓取失败");
        }
        throw new Error(`unexpected tool ${name}`);
      },
    });
    const items = await wechat.fetchLatest({ accountId: "acc-1", accountName: "机器之心" }, new AbortController().signal);
    expect(items.map((item) => [item.excerpt, (item.sourceRef as { fullText?: boolean }).fullText])).toEqual([
      ["全文段落", true],
      ["digest-2", undefined],
      ["digest-3", undefined],
    ]);
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
    const web = createBochaRadarWebAdapter(createBochaWebSearchAdapter({}));
    expect(web.configured).toBe(false);
    await expect(web.search({ query: "市场变化", lookbackHours: 48 }, new AbortController().signal)).rejects.toThrow(/BOCHA_API_KEY/);
  });

  it("按 lookback_hours 给博查传最小覆盖的 freshness（超过一年不限时间），时间窗过滤仍由 radar 负责", async () => {
    const bodies: Record<string, unknown>[] = [];
    const web = createBochaRadarWebAdapter(createBochaWebSearchAdapter({
      apiKey: "bocha-key",
      endpoint: "https://bocha.invalid/web-search",
      sleep: async () => undefined,
      fetch: async (_input, init) => {
        bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return new Response(JSON.stringify({ code: 200, data: { webPages: { value: [] } } }), { status: 200 });
      },
    }));
    for (const lookbackHours of [24, 48, 168, 720, 8760, 9000]) {
      await web.search({ query: "市场变化", lookbackHours }, new AbortController().signal);
    }
    expect(bodies.map((body) => body.freshness)).toEqual(["oneDay", "oneWeek", "oneWeek", "oneMonth", "oneYear", undefined]);
  });

  it("雷达与对话 web_search 共用同一博查适配器时共享请求间隔", async () => {
    let clock = Date.parse("2026-09-25T00:00:00.000Z");
    const starts: number[] = [];
    const bocha = createBochaWebSearchAdapter({
      apiKey: "bocha-key",
      endpoint: "https://bocha.invalid/web-search",
      now: () => clock,
      sleep: async (ms) => { clock += ms; },
      fetch: async () => {
        starts.push(clock);
        return new Response(JSON.stringify({ code: 200, data: { webPages: { value: [] } } }), { status: 200 });
      },
    });
    const web = createBochaRadarWebAdapter(bocha);
    await web.search({ query: "市场变化", lookbackHours: 48 }, new AbortController().signal);
    await bocha.search({ query: "对话检索" }, new AbortController().signal);
    expect(starts[1] - starts[0]).toBeGreaterThanOrEqual(1100);
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
        const cookie = await login(app, db);
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
        // 雷达自动升级的议题是 AI 生成的候选：带 nature=ai_suggested（界面标「AI 建议」，见 dataOrigin.ts）。
        const promotedIssues = await db.query("SELECT origin, origin_ref FROM issues WHERE origin = 'radar'");
        expect(promotedIssues.rows).toHaveLength(1);
        expect(promotedIssues.rows[0].origin_ref).toMatchObject({ nature: "ai_suggested" });
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
      const lookbacks: number[] = [];
      const assessed: number[] = [];
      const radar = createRadarService({
        pool,
        web: {
          configured: true,
          async search(input) {
            lookbacks.push(input.lookbackHours);
            return [
              { ...webItem(input.query, "https://example.com/dup?utm_medium=x", "2026-05-01T08:00:00.000Z") },
              { ...webItem(input.query, "https://example.com/dup/", "2026-05-01T09:00:00.000Z") },
              { ...webItem(input.query, "https://example.com/stale", "2026-04-01T00:00:00.000Z") },
            ];
          },
        },
        assessor: assessor((sources) => {
          assessed.push(sources.length);
          return { candidates: sources.map((source) => ({
            sourceFingerprint: source.sourceFingerprint,
            anchorId: "anchor-market",
            summary: "候选",
            strategicImpact: "待判断",
            evidenceQuote: "连续原文",
            unknowns: [],
            score: { relevance: 4, impact: 3, urgency: 2 },
            promotion: promotionFixture(),
          })) };
        }),
        now: () => NOW,
      });
      const result = await radar.runManual();
      expect(result).toMatchObject({ status: "completed", createdSignals: 1 });
      // 出窗过滤是常规记录：只进服务端日志，不展示给 CEO
      expect(result.warnings).toEqual([]);
      // 默认 radar_config.lookback_hours = 48，透传给 Web 来源用于博查 freshness
      expect(lookbacks).toEqual([48]);
      expect(Number((await db.query("SELECT count(*) FROM signals")).rows[0].count)).toBe(1);
      // 已存成信号的来源下一轮不再送去研判
      expect(await radar.runManual()).toMatchObject({ status: "completed", createdSignals: 0, warnings: [] });
      expect(assessed).toEqual([1]);
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
        JSON.stringify(anchorList(10)), JSON.stringify(SOURCES),
      ]);
      let calls = 0;
      let allStarted!: () => void;
      const started = new Promise<void>((resolve) => { allStarted = resolve; });
      // 假时钟：扫描时限与模拟模型耗时只随手动推进而流逝，机器负载不会让时限提前耗尽
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        const radar = createRadarService({
          pool,
          web: threeWebItemsPerAnchor,
          assessor: {
            // 模拟已启动后忽略 abort 的模型调用：它们在超时后才返回，也绝不能再启动后续 batch。
            async assess() {
              calls += 1;
              if (calls === 3) allStarted();
              await new Promise((resolve) => setTimeout(resolve, 50));
              return { candidates: [] };
            },
          },
          now: () => NOW,
          scanTimeoutMs: 20,
        });
        const run = radar.runManual();
        await started;
        // 先到扫描时限（20ms），再让已启动的 3 批在 50ms 时返回
        await vi.advanceTimersByTimeAsync(50);
        const result = await run;
        // 30 条来源 = 6 批，并发 3：超时前只启动了前 3 批，超时后不再启动第 4–6 批
        expect(calls).toBe(3);
        expect(result.status).toBe("completed");
        expect(result.warnings.join(" ")).toContain("本轮有 15 条来源没来得及研判");
      } finally {
        vi.useRealTimers();
      }
    });
  });

  it("assess 批次以并发 3 执行", async () => {
    await createTestDb(async ({ db, pool }) => {
      await migrate(db);
      await db.query("UPDATE radar_config SET anchors = $1::jsonb, sources = $2::jsonb WHERE id = 'default'", [
        JSON.stringify(anchorList(10)), JSON.stringify(SOURCES),
      ]);
      let calls = 0;
      let active = 0;
      let maxActive = 0;
      const radar = createRadarService({
        pool,
        web: threeWebItemsPerAnchor,
        assessor: {
          async assess() {
            calls += 1;
            active += 1;
            maxActive = Math.max(maxActive, active);
            await new Promise((resolve) => setTimeout(resolve, 20));
            active -= 1;
            return { candidates: [] };
          },
        },
        now: () => NOW,
      });
      const result = await radar.runManual();
      expect(result.status).toBe("completed");
      expect(calls).toBe(6);
      expect(maxActive).toBe(3);
    });
  });

  it("assess 阶段超时：已完成批次的候选照常校验落库，未研判条数如实提示", async () => {
    await createTestDb(async ({ db, pool }) => {
      await migrate(db);
      await db.query("UPDATE radar_config SET anchors = $1::jsonb, sources = $2::jsonb WHERE id = 'default'", [
        JSON.stringify(anchorList(10)), JSON.stringify(SOURCES),
      ]);
      let calls = 0;
      let allStarted!: () => void;
      const started = new Promise<void>((resolve) => { allStarted = resolve; });
      // 假时钟：第 1 批完成、第 4 批补上之前，扫描时限不会因机器负载提前耗尽
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        const radar = createRadarService({
          pool,
          web: threeWebItemsPerAnchor,
          assessor: {
            assess({ sources }, signal) {
              calls += 1;
              if (calls === 4) allStarted();
              // 第 1 批及时返回；其余批悬挂到超时，由 abort 信号中断
              if (calls === 1) {
                return Promise.resolve({ candidates: sources.map((source) => ({
                  sourceFingerprint: source.sourceFingerprint,
                  anchorId: "anchor-0",
                  summary: "超时前完成的候选",
                  strategicImpact: "待判断",
                  evidenceQuote: "连续原文",
                  unknowns: [],
                  score: { relevance: 4, impact: 3, urgency: 2 },
                  promotion: promotionFixture(),
                })) });
              }
              return new Promise((_resolve, reject) => {
                signal.addEventListener("abort", () => reject(signal.reason), { once: true });
              });
            },
          },
          now: () => NOW,
          scanTimeoutMs: 50,
        });
        const run = radar.runManual();
        await started;
        await vi.advanceTimersByTimeAsync(50);
        const result = await run;
        // 6 批并发 3：第 1 批完成后补上第 4 批；超时时第 2–4 批被中断，第 5–6 批从未启动
        expect(calls).toBe(4);
        expect(result).toMatchObject({ status: "completed", createdSignals: 5 });
        expect(result.warnings.join(" ")).toContain("本轮有 25 条来源没来得及研判（扫描超过 0.05 秒上限）");
        expect(result.warnings.join(" ")).not.toContain("研判失败");
        expect(Number((await db.query("SELECT count(*) FROM signals")).rows[0].count)).toBe(5);
        expect((await db.query("SELECT last_run FROM radar_config WHERE id = 'default'")).rows[0].last_run)
          .toMatchObject({ status: "completed", createdSignals: 5 });
      } finally {
        vi.useRealTimers();
      }
    });
  });

  it("assess 阶段超时且没有任何批次完成：扫描如实标为 failed，不保存候选", async () => {
    await createTestDb(async ({ db, pool }) => {
      await migrate(db);
      await db.query("UPDATE radar_config SET anchors = $1::jsonb, sources = $2::jsonb WHERE id = 'default'", [
        JSON.stringify(ANCHORS), JSON.stringify(SOURCES),
      ]);
      const radar = createRadarService({
        pool,
        web: {
          configured: true,
          async search(input) { return [webItem(input.query, "https://example.com/hang", "2026-05-01T08:00:00.000Z")]; },
        },
        assessor: {
          assess(_input, signal) {
            return new Promise((_resolve, reject) => {
              signal.addEventListener("abort", () => reject(signal.reason), { once: true });
            });
          },
        },
        now: () => NOW,
        scanTimeoutMs: 20,
      });
      const result = await radar.runManual();
      expect(result).toMatchObject({ status: "failed", createdSignals: 0 });
      expect(result.warnings).toEqual(["扫描超过 0.02 秒上限，没有完成"]);
      expect(Number((await db.query("SELECT count(*) FROM signals")).rows[0].count)).toBe(0);
    });
  });

  it("超时发生在采集阶段：不启动 assess，扫描如实标为 failed", async () => {
    await createTestDb(async ({ db, pool }) => {
      await migrate(db);
      await db.query("UPDATE radar_config SET anchors = $1::jsonb, sources = $2::jsonb WHERE id = 'default'", [
        JSON.stringify(anchorList(2)), JSON.stringify(SOURCES),
      ]);
      let calls = 0;
      const radar = createRadarService({
        pool,
        web: {
          configured: true,
          search(input, signal) {
            // 第一个方向正常返回，第二个方向悬挂到超时
            if (input.query === "查询 0") return Promise.resolve([webItem(input.query, "https://example.com/first", "2026-05-01T08:00:00.000Z")]);
            return new Promise((_resolve, reject) => {
              signal.addEventListener("abort", () => reject(signal.reason), { once: true });
            });
          },
        },
        assessor: {
          async assess() {
            calls += 1;
            return { candidates: [] };
          },
        },
        now: () => NOW,
        scanTimeoutMs: 20,
      });
      const result = await radar.runManual();
      expect(result).toMatchObject({ status: "failed", createdSignals: 0 });
      expect(result.warnings).toEqual(["扫描超过 0.02 秒上限，没有完成"]);
      expect(calls).toBe(0);
    });
  });

  it("网页结果在时间窗过滤与去重之后，每个监测方向只保留最新 3 条", async () => {
    await createTestDb(async ({ db, pool }) => {
      await migrate(db);
      await db.query("UPDATE radar_config SET anchors = $1::jsonb, sources = $2::jsonb WHERE id = 'default'", [
        JSON.stringify(anchorList(2)), JSON.stringify(SOURCES),
      ]);
      const assessed: string[] = [];
      const radar = createRadarService({
        pool,
        web: {
          configured: true,
          async search(input) {
            if (input.query === "查询 0") {
              return [
                webItem(input.query, "https://example.com/a-1", "2026-05-01T01:00:00.000Z"),
                webItem(input.query, "https://example.com/a-4", "2026-05-01T04:00:00.000Z"),
                // 与 a-4 同一 URL：去重后只占一个名额
                webItem(input.query, "https://example.com/a-4?utm_source=x", "2026-05-01T04:00:00.000Z"),
                // 超出时间窗（晚于扫描开始）：先被过滤，不占名额
                webItem(input.query, "https://example.com/a-future", "2026-05-03T00:00:00.000Z"),
                webItem(input.query, "https://example.com/a-2", "2026-05-01T02:00:00.000Z"),
                webItem(input.query, "https://example.com/a-0", "2026-04-30T23:00:00.000Z"),
                webItem(input.query, "https://example.com/a-3", "2026-05-01T03:00:00.000Z"),
              ];
            }
            return [
              webItem(input.query, "https://example.com/b-1", "2026-05-01T01:00:00.000Z"),
              webItem(input.query, "https://example.com/b-2", "2026-05-01T02:00:00.000Z"),
            ];
          },
        },
        assessor: {
          async assess({ sources }) {
            assessed.push(...sources.map((source) => source.url));
            return { candidates: [] };
          },
        },
        now: () => NOW,
      });
      const result = await radar.runManual();
      expect(result.status).toBe("completed");
      expect(assessed.sort()).toEqual([
        "https://example.com/a-2", "https://example.com/a-3", "https://example.com/a-4",
        "https://example.com/b-1", "https://example.com/b-2",
      ]);
      expect(result.warnings).toEqual([]);
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
      expect(result.warnings).toEqual([]);
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
      expect(result.warnings.join(" ")).toContain("监测方向超过 20 个，本轮只看了前 20 个");
      expect(result.warnings.join(" ")).toContain("有 5 条来源研判失败");
      expect(result.warnings.join(" ")).not.toContain("assess batch outage");
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
        const card = await app.inject({ method: "GET", url: "/api/cards/radar", headers: { cookie: await login(app, db) } });
        expect(card.json().cards[0].payload.lastRun).toMatchObject({ status: "failed", trigger: "scheduled", companyDay: "2026-05-02" });
        expect(card.json().cards[0].payload.lastRun.warnings).toEqual(["扫描被服务重启打断，没有完成"]);
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
      expect(result.warnings.join(" ")).toContain("研判失败");
      expect(result.warnings.join(" ")).not.toContain("assess model down");
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
      expect(result.warnings).toEqual(["网页搜索有 1 个监测方向没取到结果，这些方向本轮可能有遗漏"]);
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
      expect(result.warnings).toEqual([]);
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
        const cookie = await login(app, db);
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
          source: { title: "公告", url: "https://example.com/news", excerpt: "连续原文引文", fullText: false },
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

describe("Signal 原文出处标注", () => {
  it("只有目录标了 fullText 的发布方（量子位）标为发布方原文，其余发布方与检索来源都不宣称全文", () => {
    const row = (outletId: string) => ({
      id: "22222222-2222-4222-8222-222222222222",
      version: 1,
      source_type: "outlet" as const,
      source_fingerprint: "c".repeat(64),
      source_title: "标题",
      source_url: "https://www.qbitai.com/2026/09/1.html",
      published_at: new Date(NOW),
      excerpt: "原文",
      source_ref: { type: "outlet", provider: "publisher-feed", outletId, outletName: "媒体" },
      anchor_id: "anchor-market",
      location: { type: "company" },
      summary: "摘要",
      strategic_impact: "影响",
      evidence_quote: "原文",
      unknowns: [],
      score: { relevance: 1, impact: 1, urgency: 1 },
      read_at: null,
      saved_at: null,
      dismissed_at: null,
      collected_at: new Date(NOW),
      source_images: [],
    });
    const fullTextOf = (outletId: string) => (projectSignalCard(row(outletId)).payload as { source: { fullText: boolean } }).source.fullText;
    expect(fullTextOf("qbitai")).toBe(true);
    expect(fullTextOf("bloomberg")).toBe(false);
    // 采集时逐条记下的标记优先：公众号读到全文标发布方原文；量子位这条没抓到全文就不再按目录宣称
    const cardFullText = (sourceType: "wechat-account" | "outlet", sourceRef: Record<string, unknown>) =>
      (projectSignalCard({ ...row("qbitai"), source_type: sourceType, source_ref: sourceRef } as never).payload as { source: { fullText: boolean } }).source.fullText;
    expect(cardFullText("wechat-account", { type: "wechat-account", provider: "wechat-mcp", accountId: "a", accountName: "号", fullText: true })).toBe(true);
    expect(cardFullText("wechat-account", { type: "wechat-account", provider: "wechat-mcp", accountId: "a", accountName: "号" })).toBe(false);
    expect(cardFullText("outlet", { type: "outlet", provider: "publisher-feed", outletId: "qbitai", outletName: "量子位", fullText: false })).toBe(false);
  });
});

describe("检索条目入库前换成原文页全文", () => {
  it("只给通过引文校验、要落库的检索条目抓原文页；全文含引文才替换并标 fullText，否则保留检索摘要", async () => {
    await createTestDb(async ({ db, pool }) => {
      await migrate(db);
      await db.query("UPDATE radar_config SET anchors = $1::jsonb, sources = $2::jsonb WHERE id = 'default'", [
        JSON.stringify(ANCHORS), JSON.stringify(SOURCES),
      ]);
      const summaryOf = (url: string) => `检索摘要：竞品下调企业版价格 ${url}`;
      const item = (url: string): TRadarSourceItem => ({
        sourceType: "web", title: `标题 ${url}`, url, publishedAt: "2026-05-01T08:00:00.000Z", excerpt: summaryOf(url),
        sourceRef: { type: "web-search", provider: "bocha", query: "竞争对手 最新定价" },
        images: [{ src: "https://img.example.com/bocha-cover.jpg", after: 0 }],
      });
      const urls = ["https://example.com/full", "https://example.com/rewritten", "https://example.com/failed", "https://example.com/rejected"];
      const body = (url: string) => `${"背景段落。".repeat(50)}\n\n${summaryOf(url)}\n\n${"后续段落。".repeat(50)}`;
      const asked: string[] = [];
      const radar = createRadarService({
        pool,
        web: { configured: true, async search() { return urls.map(item); } },
        assessor: {
          async assess({ sources }) {
            return { candidates: sources.map((source) => ({
              sourceFingerprint: source.sourceFingerprint, anchorId: "anchor-market", summary: "竞品降价", strategicImpact: "影响",
              // rejected：引文不在检索摘要里，研判就不通过，不应为它抓原文页
              evidenceQuote: source.url.endsWith("rejected") ? "摘要里没有的句子" : "竞品下调企业版价格",
              unknowns: [], score: { relevance: 3, impact: 3, urgency: 3 },
            })) } as never;
          },
        },
        articleText: async (url) => {
          asked.push(url);
          if (url.endsWith("/full")) return { text: body(url), images: [{ src: "https://example.com/inline.jpg", after: 1 }] };
          // 原文页把那句话改写了：全文里找不到引文，保留检索摘要
          if (url.endsWith("/rewritten")) return { text: body(url).replace("竞品下调企业版价格", "竞品调低了企业版的价格"), images: [] };
          return null;
        },
        now: () => NOW,
      });
      expect(await radar.runManual()).toMatchObject({ status: "completed", createdSignals: 3 });
      expect(asked.sort()).toEqual(["https://example.com/failed", "https://example.com/full", "https://example.com/rewritten"]);
      const stored = Object.fromEntries((await db.query<{ source_url: string; excerpt: string; evidence_quote: string; source_ref: Record<string, unknown>; source_images: unknown }>(
        "SELECT source_url, excerpt, evidence_quote, source_ref, source_images FROM signals",
      )).rows.map((row) => [row.source_url, row]));
      expect(stored["https://example.com/full"]).toMatchObject({
        excerpt: body("https://example.com/full"),
        source_ref: { type: "web-search", provider: "bocha", fullText: true },
        source_images: [{ src: "https://example.com/inline.jpg", after: 1 }],
      });
      for (const url of ["https://example.com/rewritten", "https://example.com/failed"]) {
        expect(stored[url].excerpt).toBe(summaryOf(url));
        expect(stored[url].source_ref).not.toHaveProperty("fullText");
        expect(stored[url].source_images).toEqual([{ src: "https://img.example.com/bocha-cover.jpg", after: 0 }]);
      }
      // 不变量：引文永远逐字出现在落库的原文里
      for (const row of Object.values(stored)) expect(row.excerpt).toContain(row.evidence_quote);
      const card = projectSignalCard((await db.query(`SELECT * FROM signals WHERE source_url = 'https://example.com/full'`)).rows[0]);
      expect((card.payload as { source: { fullText: boolean } }).source.fullText).toBe(true);
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
              images: [{ src: "https://assets.bloomberg.com/chart.jpg", after: 0 }],
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
      expect((await db.query("SELECT source_type, source_title, source_images FROM signals")).rows)
        .toEqual([{ source_type: "outlet", source_title: "Treasury basis trade", source_images: [{ src: "https://assets.bloomberg.com/chart.jpg", after: 0 }] }]);
      expect(webCalls).toBe(0);
    });
  });
});

describe("radar scan time limit", () => {
  it("defaults to 6 minutes so a Haiku scan of a full round is not cut short", () => {
    expect(RADAR_SCAN_TIMEOUT_MS).toBe(6 * 60_000);
  });
});
