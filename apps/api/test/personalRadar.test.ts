import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { createAssistantMessageEventStream, type AssistantMessage, type Context } from "@earendil-works/pi-ai";
import type { TRadarScanResponse, TRadarSourceItem } from "@warmap/contracts";
import { buildApp } from "../src/app.js";
import { createCompanyContext, type MemoryPerson } from "../src/companyContext.js";
import { migrate } from "../src/migrate.js";
import { createPersonalRadarJudge } from "../src/personalRadarAgent.js";
import { createPersonalRadarService, type PersonalRadarJudge, type PersonalRadarJudgeInput } from "../src/personalRadar.js";
import type { GithubTrendingReader, TrendingRepo, TrendingSince } from "../src/githubTrending.js";
import type { RadarOutletAdapter, RadarService, RadarWebAdapter } from "../src/radar.js";
import { createRadarScheduler } from "../src/radarScheduler.js";
import { createTestDb, seedTestAccess, testEnv, TEST_MEMBER } from "./helpers.js";

// 2026-10-08 10:00（Asia/Shanghai）：Company Day 为 2026-10-08
const NOW = new Date("2026-10-08T02:00:00.000Z");
const person = (personId: string, roles: string[]): MemoryPerson => ({ personId, displayName: personId, roles, sourceRef: "fixture", updatedAt: NOW.toISOString() });
const PEOPLE = [person("person-ceo", ["ceo"]), person("person-a", ["dri"]), person("person-b", ["participant"]), person("person-c", ["dri"])];
const memory = { searchPeople: () => PEOPLE };

const fingerprintOf = (url: string) => createHash("sha256").update(`v1\n${url}`).digest("hex");
const hours = (n: number) => new Date(NOW.getTime() - n * 3_600_000).toISOString();

function webItem(url: string, options: { title?: string; excerpt?: string; publishedAt?: string; query?: string } = {}): TRadarSourceItem {
  return {
    sourceType: "web",
    title: options.title ?? `标题 ${url}`,
    url,
    publishedAt: options.publishedAt ?? hours(1),
    excerpt: options.excerpt ?? `原文写明了新的定价方案：${url}`,
    sourceRef: { type: "web-search", provider: "bocha", query: options.query ?? "q" },
  };
}

function outletItem(url: string, outletId = "ft", outletName = "金融时报", publishedAt = hours(2)): TRadarSourceItem {
  return {
    sourceType: "outlet", title: `订阅源 ${url}`, url, publishedAt, excerpt: `订阅源原文：${url}`,
    sourceRef: { type: "outlet", provider: "publisher-feed", outletId, outletName },
  };
}

type WebCall = Parameters<RadarWebAdapter["search"]>[0];
function fakeWeb(results: (query: string, signal: AbortSignal) => TRadarSourceItem[] | Promise<TRadarSourceItem[]>, configured = true) {
  const calls: WebCall[] = [];
  const web: RadarWebAdapter & { calls: WebCall[] } = {
    configured,
    calls,
    async search(input, signal) {
      calls.push(structuredClone(input));
      return results(input.query, signal);
    },
  };
  return web;
}

type OutletCall = Parameters<RadarOutletAdapter["fetchLatest"]>[0];
function fakeOutlets(items: TRadarSourceItem[] = []) {
  const calls: OutletCall[] = [];
  const outlets: RadarOutletAdapter & { calls: OutletCall[] } = {
    configured: true,
    calls,
    async fetchLatest(input) {
      calls.push(structuredClone(input));
      return structuredClone(items);
    },
  };
  return outlets;
}

/** 判定替身：把本批每条都归到第一个方向，引文取原文开头。 */
function acceptAll(relevance = 5) {
  const calls: PersonalRadarJudgeInput[] = [];
  const judge: PersonalRadarJudge & { calls: PersonalRadarJudgeInput[] } = {
    calls,
    async judge(input) {
      calls.push(structuredClone(input));
      return { candidates: input.sources.map((source) => ({
        sourceFingerprint: source.sourceFingerprint, directionId: input.directions[0].id,
        summary: "一句结论", reason: "和方向直接相关", evidenceQuote: source.excerpt.slice(0, 6), relevance,
      })) };
    },
  };
  return judge;
}

async function setRadar(pool: Pool, personId: string, options: { enabled?: boolean; directions?: unknown[]; sources?: unknown[]; lastScanDay?: string | null } = {}) {
  await pool.query(
    `INSERT INTO person_radar (person_id, enabled, directions, sources, updated_at, last_scan_day)
     VALUES ($1, $2, $3::jsonb, $4::jsonb, $5, $6::date)
     ON CONFLICT (person_id) DO UPDATE SET enabled = EXCLUDED.enabled, directions = EXCLUDED.directions,
       sources = EXCLUDED.sources, last_scan_day = EXCLUDED.last_scan_day`,
    [personId, options.enabled ?? true, JSON.stringify(options.directions ?? ["大模型定价"]), JSON.stringify(options.sources ?? []), NOW, options.lastScanDay ?? null],
  );
}

async function insertSignal(pool: Pool, personId: string, collectedAt: Date | string = NOW, url = `https://example.com/old/${randomUUID()}`) {
  await pool.query(
    `INSERT INTO person_radar_signals (id, person_id, source_type, source_fingerprint, source_title, source_url, published_at, excerpt,
       source_ref, direction_id, direction_text, summary, reason, evidence_quote, relevance, collected_at)
     VALUES ($1, $2, 'web', $3, '旧标题', $4, $5, '旧原文', '{"type":"web-search","provider":"bocha","query":"q"}'::jsonb,
       'd_old', '方向', '结论', '理由', '旧原文', 3, $5)`,
    [randomUUID(), personId, fingerprintOf(url), url, collectedAt],
  );
}

const lastRun = async (pool: Pool, personId: string) =>
  (await pool.query("SELECT last_run, last_scan_day::text AS last_scan_day FROM person_radar WHERE person_id = $1", [personId])).rows[0];
const count = async (pool: Pool, table: string, where = "TRUE", params: unknown[] = []) =>
  Number((await pool.query(`SELECT count(*) FROM ${table} WHERE ${where}`, params)).rows[0].count);

type TrendingCall = { language: string | null; since: TrendingSince };
/** 榜单替身：按「语言|版本」给出上榜仓库；可以附带读取器的 warning，或直接失败。 */
function fakeTrending(pages: Record<string, TrendingRepo[]>, options: { warnings?: string[]; fail?: Error } = {}) {
  const calls: TrendingCall[] = [];
  const trending: GithubTrendingReader & { calls: TrendingCall[] } = {
    calls,
    async read(source) {
      calls.push(structuredClone(source));
      if (options.fail) throw options.fail;
      return { repos: structuredClone(pages[`${source.language ?? ""}|${source.since}`] ?? []), warnings: options.warnings ?? [] };
    },
  };
  return trending;
}
const repo = (name: string, starsInPeriod: number | null, description: string | null = `${name} 的描述`, language: string | null = "TypeScript"): TrendingRepo =>
  ({ fullName: `owner/${name}`, url: `https://github.com/owner/${name}`, description, language, starsInPeriod });

function service(pool: Pool, deps: { web?: RadarWebAdapter; outlets?: RadarOutletAdapter; judge?: PersonalRadarJudge; trending?: GithubTrendingReader; scanTimeoutMs?: number; now?: () => Date }) {
  return createPersonalRadarService({
    pool,
    companyMemory: memory,
    web: deps.web ?? fakeWeb(() => []),
    outlets: deps.outlets ?? fakeOutlets(),
    judge: deps.judge ?? acceptAll(),
    ...(deps.trending ? { trending: deps.trending } : {}),
    now: deps.now ?? (() => NOW),
    ...(deps.scanTimeoutMs ? { scanTimeoutMs: deps.scanTimeoutMs } : {}),
  });
}

async function scan(radar: ReturnType<typeof createPersonalRadarService>, ...personIds: string[]) {
  for (const personId of personIds) radar.enqueue(personId, "manual");
  await radar.idle();
}

describe("升级防护", () => {
  it("只写 person_radar_signals：判定给 5 分，signals 与 issues 仍是 0 行；博查不收 domains", async () => {
    await createTestDb(async ({ db, pool }) => {
      await migrate(db);
      await setRadar(pool, "person-a");
      const web = fakeWeb(() => [webItem("https://Example.com/a/?utm_source=x#top"), webItem("https://example.com/b")]);
      const radar = service(pool, { web, judge: acceptAll(5) });
      await scan(radar, "person-a");

      expect(await count(pool, "person_radar_signals")).toBe(2);
      expect(await count(pool, "signals")).toBe(0);
      expect(await count(pool, "issues")).toBe(0);
      const saved = (await pool.query("SELECT person_id, source_url, source_fingerprint, direction_text, relevance, collected_at FROM person_radar_signals ORDER BY source_url")).rows;
      expect(saved.map((row) => row.source_url)).toEqual(["https://example.com/a", "https://example.com/b"]);
      expect(saved[0]).toMatchObject({ person_id: "person-a", source_fingerprint: fingerprintOf("https://example.com/a"), direction_text: "大模型定价", relevance: 5, collected_at: NOW });
      expect(web.calls).toEqual([{ query: "大模型定价", lookbackHours: 48 }]);
      expect(await lastRun(pool, "person-a")).toEqual({
        last_scan_day: "2026-10-08",
        last_run: { trigger: "manual", status: "completed", queuedAt: NOW.toISOString(), startedAt: NOW.toISOString(), completedAt: NOW.toISOString(), createdSignals: 2, warnings: [] },
      });
    });
  });

  it("个人雷达的代码不引用 issues，也不读写 radar_config、signals、issues", () => {
    const source = (file: string) => readFileSync(fileURLToPath(new URL(`../src/${file}`, import.meta.url)), "utf8");
    for (const file of ["personalRadar.ts", "personalRadarAgent.ts", "personalSignals.ts", "radarSettings.ts", "routes/myRadar.ts"]) {
      expect(source(file)).not.toMatch(/from "\.{1,2}\/issues\.js"/);
      expect(source(file)).not.toMatch(/onIssuePromoted|promotion/);
    }
    for (const file of ["personalRadar.ts", "personalRadarAgent.ts", "personalSignals.ts"]) {
      expect(source(file)).not.toMatch(/radar_config|\b(FROM|INTO|UPDATE|JOIN)\s+(signals|issues)\b/i);
    }
  });
});

describe("去重", () => {
  it("按人按网址去重：同一人重复扫描只一行，两个人各自一行", async () => {
    await createTestDb(async ({ db, pool }) => {
      await migrate(db);
      await setRadar(pool, "person-a");
      await setRadar(pool, "person-b");
      const web = fakeWeb(() => [webItem("https://Example.com/x/?utm_source=a"), webItem("https://example.com/x#frag")]);
      const judge = acceptAll();
      const radar = service(pool, { web, judge });
      await scan(radar, "person-a", "person-b");
      const rows = (await pool.query("SELECT person_id, source_fingerprint FROM person_radar_signals ORDER BY person_id")).rows;
      expect(rows).toEqual([
        { person_id: "person-a", source_fingerprint: fingerprintOf("https://example.com/x") },
        { person_id: "person-b", source_fingerprint: fingerprintOf("https://example.com/x") },
      ]);
      // 批内去重：一次扫描只送判一条
      expect(judge.calls.map((call) => call.sources.length)).toEqual([1, 1]);

      // 再扫一次：本人已有的指纹不再送判，也不重复写
      await scan(radar, "person-a");
      expect(judge.calls).toHaveLength(2);
      expect(await count(pool, "person_radar_signals", "person_id = 'person-a'")).toBe(1);
      expect((await lastRun(pool, "person-a")).last_run).toMatchObject({ status: "completed", createdSignals: 0, warnings: ["48 小时内没有新条目"] });
    });
  });
});

describe("每天 10 条上限", () => {
  it("今天已收满 10 条就短路：不调博查、不调模型；昨天（公司时区）收的不算", async () => {
    await createTestDb(async ({ db, pool }) => {
      await migrate(db);
      await setRadar(pool, "person-a");
      await setRadar(pool, "person-b");
      for (let index = 0; index < 10; index += 1) await insertSignal(pool, "person-a", new Date(NOW.getTime() - index * 60_000));
      // 2026-10-07 23:59:59（Asia/Shanghai）属于前一天
      for (let index = 0; index < 10; index += 1) await insertSignal(pool, "person-b", "2026-10-07T15:59:59.000Z");
      const web = fakeWeb((query) => [webItem(`https://example.com/${query}/new`)]);
      const judge = acceptAll();
      const radar = service(pool, { web, judge });
      await scan(radar, "person-a");
      expect(web.calls).toHaveLength(0);
      expect(judge.calls).toHaveLength(0);
      expect((await lastRun(pool, "person-a")).last_run).toMatchObject({ status: "completed", createdSignals: 0, warnings: ["今天已收满 10 条"] });

      await scan(radar, "person-b");
      expect(web.calls).toHaveLength(1);
      expect((await lastRun(pool, "person-b")).last_run).toMatchObject({ status: "completed", createdSignals: 1 });
    });
  });

  it("只写今天剩下的名额：相关度高的先，同分按发布时间新的先", async () => {
    await createTestDb(async ({ db, pool }) => {
      await migrate(db);
      await setRadar(pool, "person-a", { sources: ["ft.com"] });
      for (let index = 0; index < 8; index += 1) await insertSignal(pool, "person-a");
      const items = [
        outletItem("https://www.ft.com/content/r3", "ft", "金融时报", hours(1)),
        outletItem("https://www.ft.com/content/r5-old", "ft", "金融时报", hours(10)),
        outletItem("https://www.ft.com/content/r4", "ft", "金融时报", hours(2)),
        outletItem("https://www.ft.com/content/r5-new", "ft", "金融时报", hours(5)),
      ];
      const relevance: Record<string, number> = { r3: 3, "r5-old": 5, r4: 4, "r5-new": 5 };
      const radar = service(pool, {
        outlets: fakeOutlets(items),
        judge: {
          async judge(input) {
            return { candidates: input.sources.map((source) => {
              const key = Object.keys(relevance).find((name) => source.title.endsWith(`/${name}`))!;
              return { sourceFingerprint: source.sourceFingerprint, directionId: input.directions[0].id, summary: "结论", reason: "理由", evidenceQuote: source.excerpt.slice(0, 4), relevance: relevance[key] };
            }) };
          },
        },
      });
      await scan(radar, "person-a");
      const saved = (await pool.query("SELECT source_url FROM person_radar_signals WHERE direction_id <> 'd_old' ORDER BY source_url")).rows.map((row) => row.source_url);
      expect(saved).toEqual(["https://www.ft.com/content/r5-new", "https://www.ft.com/content/r5-old"]);
      expect((await lastRun(pool, "person-a")).last_run).toMatchObject({ status: "completed", createdSignals: 2, warnings: ["今天的 10 条名额已满，另有 2 条没有保存"] });
    });
  });
});

describe("代码复核", () => {
  it("指纹不在本批、方向不属于本人、引文不在判定看到的原文里都丢弃；相关度低于 3 不写", async () => {
    await createTestDb(async ({ db, pool }) => {
      await migrate(db);
      await setRadar(pool, "person-a", { directions: ["大模型定价", "芯片出口"], sources: ["ft.com"] });
      const long = `${"前".repeat(2_100)}藏在两千字之后的原话`;
      const item = (name: string, excerpt: string) => ({ ...outletItem(`https://www.ft.com/content/${name}`), excerpt });
      const items = [
        item("ok", "这条原文里有连续的引文。"),
        item("unknown-direction", "方向不对的原文。"),
        item("bad-quote", "原文只说可能调整。"),
        item("low", "相关度不够的原文。"),
        item("long", long),
      ];
      const judged: PersonalRadarJudgeInput[] = [];
      const radar = service(pool, {
        outlets: fakeOutlets(items),
        judge: {
          async judge(input) {
            judged.push(input);
            const by = (suffix: string) => input.sources.find((source) => source.title.endsWith(suffix))!;
            const [pricing, chips] = input.directions;
            const base = { summary: "结论", reason: "理由", relevance: 4 };
            return { candidates: [
              { ...base, sourceFingerprint: by("/ok").sourceFingerprint, directionId: chips.id, evidenceQuote: "连续的引文", relevance: 3 },
              // 同一条再提交一次、分更低：只留更相关的那次
              { ...base, sourceFingerprint: by("/ok").sourceFingerprint, directionId: pricing.id, evidenceQuote: "连续的引文", relevance: 3 },
              { ...base, sourceFingerprint: "0".repeat(64), directionId: pricing.id, evidenceQuote: "原文" },
              { ...base, sourceFingerprint: by("/unknown-direction").sourceFingerprint, directionId: "d_000000000000", evidenceQuote: "方向不对" },
              { ...base, sourceFingerprint: by("/bad-quote").sourceFingerprint, directionId: pricing.id, evidenceQuote: "确定将在六月调整" },
              { ...base, sourceFingerprint: by("/low").sourceFingerprint, directionId: pricing.id, evidenceQuote: "相关度不够", relevance: 2 },
              { ...base, sourceFingerprint: by("/long").sourceFingerprint, directionId: pricing.id, evidenceQuote: "藏在两千字之后的原话" },
            ] };
          },
        },
      });
      await scan(radar, "person-a");
      // 判定只看到前 2000 字；库里存全文
      expect(Array.from(judged[0].sources.find((source) => source.title.endsWith("/long"))!.excerpt)).toHaveLength(2_000);
      const saved = (await pool.query("SELECT source_url, direction_text, relevance, excerpt FROM person_radar_signals")).rows;
      expect(saved).toEqual([{ source_url: "https://www.ft.com/content/ok", direction_text: "芯片出口", relevance: 3, excerpt: "这条原文里有连续的引文。" }]);
      expect((await lastRun(pool, "person-a")).last_run).toMatchObject({ status: "completed", createdSignals: 1, warnings: [] });
    });
  });
});

describe("来源模式", () => {
  it("只看订阅源：一次调用发布方目录 id，不调博查；暂不支持的只写 warning", async () => {
    await createTestDb(async ({ db, pool }) => {
      await migrate(db);
      await setRadar(pool, "person-a", { sources: ["ft.com", "qbitai.com", "wsj.com"] });
      const web = fakeWeb(() => [webItem("https://example.com/never")]);
      const outlets = fakeOutlets([outletItem("https://www.ft.com/content/1")]);
      const judge = acceptAll();
      await scan(service(pool, { web, outlets, judge }), "person-a");
      expect(web.calls).toEqual([]);
      expect(outlets.calls).toEqual([{ outletIds: ["ft", "qbitai"], lookbackHours: 48 }]);
      expect(judge.calls[0].sources).toEqual([expect.objectContaining({ title: "订阅源 https://www.ft.com/content/1", from: "金融时报" })]);
      expect((await lastRun(pool, "person-a")).last_run).toMatchObject({
        status: "completed", createdSignals: 1,
        warnings: ["华尔街日报：订阅源已停更，暂不支持", "量子位：48 小时内没有新条目"],
      });
      expect((await pool.query("SELECT source_type, source_ref FROM person_radar_signals")).rows[0]).toEqual({
        source_type: "outlet", source_ref: { type: "outlet", provider: "publisher-feed", outletId: "ft", outletName: "金融时报" },
      });
    });
  });

  it("网站：每个方向全网检索一次（不带 domains），只留该域名、子域与路径前缀下的结果，不回落全网", async () => {
    await createTestDb(async ({ db, pool }) => {
      await migrate(db);
      await setRadar(pool, "person-a", { directions: ["定价", "芯片"], sources: ["36kr.com", "example.org/blog"] });
      const web = fakeWeb((query) => [
        webItem(`https://36kr.com/p/${query}`),
        webItem("https://m.36kr.com/p/shared"),
        webItem("https://fake36kr.com/p/x"),
        webItem("https://other.com/x"),
        webItem("https://example.org/blog/1"),
        webItem("https://example.org/blogger"),
        webItem("https://example.org/about"),
        webItem("https://notexample.org/blog/2"),
      ]);
      const judge = acceptAll();
      await scan(service(pool, { web, judge }), "person-a");
      expect(web.calls).toEqual([{ query: "定价", lookbackHours: 48 }, { query: "芯片", lookbackHours: 48 }]);
      expect(judge.calls.flatMap((call) => call.sources.map((source) => source.title.replace("标题 ", ""))).sort()).toEqual([
        "https://36kr.com/p/定价", "https://36kr.com/p/芯片", "https://example.org/blog/1", "https://m.36kr.com/p/shared",
      ]);
      expect(judge.calls[0].sources.find((source) => source.title.includes("m.36kr.com"))!.from).toBe("m.36kr.com");
    });
  });

  it("全是暂不支持的来源：不采集、如实写 warning，照常完成", async () => {
    await createTestDb(async ({ db, pool }) => {
      await migrate(db);
      await setRadar(pool, "person-a", { sources: ["github.com/trending/developers", "news.ycombinator.com"] });
      const web = fakeWeb(() => [webItem("https://example.com/never")]);
      const outlets = fakeOutlets([outletItem("https://www.ft.com/content/never")]);
      const judge = acceptAll();
      await scan(service(pool, { web, outlets, judge }), "person-a");
      expect([web.calls.length, outlets.calls.length, judge.calls.length]).toEqual([0, 0, 0]);
      expect((await lastRun(pool, "person-a")).last_run).toMatchObject({
        status: "completed", createdSignals: 0,
        warnings: ["GitHub Trending 开发者榜：只读仓库榜，开发者榜暂不支持", "Hacker News：订阅源只有评论链接，暂不支持"],
      });
    });
  });

  it("全网检索没开通：只写方向或只填网站都读不到，如实写 warning，不算失败；订阅源照读", async () => {
    await createTestDb(async ({ db, pool }) => {
      await migrate(db);
      await setRadar(pool, "person-a");
      await setRadar(pool, "person-b", { sources: ["36kr.com", "ft.com"] });
      const web = fakeWeb(() => [webItem("https://example.com/never")], false);
      const outlets = fakeOutlets([outletItem("https://www.ft.com/content/2")]);
      const radar = service(pool, { web, outlets });
      expect(radar.providerStatus).toEqual({ webSearch: false });
      await scan(radar, "person-a", "person-b");
      expect(web.calls).toEqual([]);
      expect((await lastRun(pool, "person-a")).last_run).toMatchObject({ status: "completed", createdSignals: 0, warnings: ["全网检索未开通，只写方向暂时读不到"] });
      expect((await lastRun(pool, "person-b")).last_run).toMatchObject({ status: "completed", createdSignals: 1, warnings: ["36氪：全网检索未开通，暂时读不到"] });
    });
  });

  it("时间窗与每个方向的上限：只留 48 小时内、每个方向最新 3 条网页结果", async () => {
    await createTestDb(async ({ db, pool }) => {
      await migrate(db);
      await setRadar(pool, "person-a", { directions: ["方向一", "方向二", "方向三", "方向四", "方向五"], sources: [] });
      const web = fakeWeb((query) => [
        ...Array.from({ length: 5 }, (_, index) => webItem(`https://example.com/${encodeURIComponent(query)}/${index}`, { publishedAt: hours(index * 2 + 1) })),
        webItem(`https://example.com/${encodeURIComponent(query)}/stale`, { publishedAt: hours(49) }),
        webItem(`https://example.com/${encodeURIComponent(query)}/future`, { publishedAt: new Date(NOW.getTime() + 60_000).toISOString() }),
      ]);
      const judge = acceptAll(2);
      await scan(service(pool, { web, judge }), "person-a");
      expect(judge.calls.map((call) => call.sources.length)).toEqual([10, 5]);
      const judged = judge.calls.flatMap((call) => call.sources.map((source) => source.title));
      expect(judged.some((title) => /\/(3|4|stale|future)$/.test(title))).toBe(false);
      // 相关度 2 低于门槛：不写，也不算复核失败
      expect((await lastRun(pool, "person-a")).last_run).toMatchObject({ status: "completed", createdSignals: 0, warnings: [] });
    });
  });

  it("订阅源最多 20 条、合计最多 30 条，新的优先；每批判 10 条", async () => {
    await createTestDb(async ({ db, pool }) => {
      await migrate(db);
      await setRadar(pool, "person-b", { directions: ["方向一", "方向二", "方向三", "方向四", "方向五"], sources: ["ft.com", "example.com"] });
      const web = fakeWeb((query) => Array.from({ length: 4 }, (_, index) => webItem(`https://example.com/${encodeURIComponent(query)}/${index}`, { publishedAt: hours(index + 1) })));
      const feed = Array.from({ length: 25 }, (_, index) => outletItem(`https://www.ft.com/content/${index}`, "ft", "金融时报", hours(index + 1)));
      const judge = acceptAll(2);
      await scan(service(pool, { web, outlets: fakeOutlets(feed), judge }), "person-b");
      expect(judge.calls.map((call) => call.sources.length)).toEqual([10, 10, 10]);
      const judged = judge.calls.flatMap((call) => call.sources.map((source) => source.title));
      expect(judged).toContain("订阅源 https://www.ft.com/content/14");
      for (const index of [15, 19, 20, 24]) expect(judged).not.toContain(`订阅源 https://www.ft.com/content/${index}`);
      expect((await lastRun(pool, "person-b")).last_run).toMatchObject({ status: "completed", warnings: [] });
    });
  });
});

describe("榜单（02b）", () => {
  it("按版读一次：取时段 star 最多的 10 个；只记上榜日、不伪造发布时间；没有描述就写「没有描述」", async () => {
    await createTestDb(async ({ db, pool }) => {
      await migrate(db);
      await setRadar(pool, "person-a", { sources: ["github.com/trending/typescript?since=weekly"] });
      const repos = Array.from({ length: 12 }, (_, index) => repo(`repo-${index + 1}`, index + 1, index === 11 ? null : undefined));
      const trending = fakeTrending({ "typescript|weekly": repos });
      const web = fakeWeb(() => [webItem("https://example.com/never")]);
      const outlets = fakeOutlets([outletItem("https://www.ft.com/content/never")]);
      const judge = acceptAll(4);
      await scan(service(pool, { web, outlets, judge, trending }), "person-a");
      expect(trending.calls).toEqual([{ language: "typescript", since: "weekly" }]);
      expect([web.calls.length, outlets.calls.length]).toEqual([0, 0]);
      const judged = judge.calls[0].sources;
      expect(judged).toHaveLength(10);
      expect(judged.map((source) => source.title)).not.toContain("owner/repo-1");
      expect(judged.every((source) => source.publishedAt === null && source.listedOn === "2026-10-08" && source.from === "GitHub Trending")).toBe(true);
      expect(judged.find((source) => source.title === "owner/repo-12")?.excerpt).toBe("owner/repo-12：没有描述（语言 TypeScript，本周 12 star）");
      const rows = await pool.query(`SELECT source_type, source_title, published_at, listed_on::text AS listed_on, source_ref
        FROM person_radar_signals WHERE person_id = 'person-a' ORDER BY source_title`);
      expect(rows.rows).toHaveLength(10);
      expect(rows.rows.every((row) => row.source_type === "list" && row.published_at === null && row.listed_on === "2026-10-08")).toBe(true);
      expect(rows.rows.find((row) => row.source_title === "owner/repo-12")!.source_ref).toEqual({
        type: "list", provider: "github-trending", listName: "GitHub Trending", language: "TypeScript", starsInPeriod: 12, since: "weekly",
      });
      expect(await count(pool, "signals")).toBe(0);
    });
  });

  it("同一个仓库第二天还在榜上：同一人不重复收，也不再拿去判", async () => {
    await createTestDb(async ({ db, pool }) => {
      await migrate(db);
      await setRadar(pool, "person-a", { sources: ["github.com/trending"] });
      const trending = fakeTrending({ "|daily": [repo("agent", 900)] });
      const judge = acceptAll();
      await scan(service(pool, { judge, trending }), "person-a");
      const tomorrow = new Date(NOW.getTime() + 24 * 3_600_000);
      await scan(service(pool, { judge, trending, now: () => tomorrow }), "person-a");
      expect(trending.calls).toHaveLength(2);
      expect(judge.calls).toHaveLength(1);
      expect(await count(pool, "person_radar_signals")).toBe(1);
      expect((await lastRun(pool, "person-a")).last_run).toMatchObject({ status: "completed", createdSignals: 0 });
    });
  });

  it("榜单读取失败或页面结构变了：只写 warning，同一个人的订阅源照读，照常完成", async () => {
    await createTestDb(async ({ db, pool }) => {
      await migrate(db);
      await setRadar(pool, "person-a", { sources: ["github.com/trending", "ft.com"] });
      const outlets = fakeOutlets([outletItem("https://www.ft.com/content/a")]);
      const failing = fakeTrending({}, { fail: new Error("GitHub Trending 返回 HTTP 429") });
      await scan(service(pool, { outlets, trending: failing }), "person-a");
      expect((await lastRun(pool, "person-a")).last_run).toMatchObject({
        status: "completed", createdSignals: 1, warnings: ["GitHub Trending读取失败：GitHub Trending 返回 HTTP 429"],
      });
      await setRadar(pool, "person-b", { sources: ["github.com/trending"] });
      const changed = fakeTrending({}, { warnings: ["GitHub Trending 页面结构可能变了，没有解析出上榜仓库"] });
      await scan(service(pool, { trending: changed }), "person-b");
      expect((await lastRun(pool, "person-b")).last_run).toMatchObject({
        status: "completed", createdSignals: 0, warnings: ["GitHub Trending 页面结构可能变了，没有解析出上榜仓库", "48 小时内没有新条目"],
      });
    });
  });

  it("没接上读取器：榜单来源只写 warning，不算失败", async () => {
    await createTestDb(async ({ db, pool }) => {
      await migrate(db);
      await setRadar(pool, "person-a", { sources: ["github.com/trending"] });
      await scan(service(pool, {}), "person-a");
      expect((await lastRun(pool, "person-a")).last_run).toMatchObject({
        status: "completed", createdSignals: 0, warnings: ["GitHub Trending：榜单读取器没有接上，这次没读"],
      });
    });
  });
});

describe("失败隔离与超时", () => {
  it("一个人失败只写他自己的 last_run；行数据损坏的人也只把自己记为 failed", async () => {
    await createTestDb(async ({ db, pool }) => {
      await migrate(db);
      await setRadar(pool, "person-a", { directions: ["博查挂了"] });
      await setRadar(pool, "person-c", { directions: [123] });
      await setRadar(pool, "person-b", { directions: ["正常方向"] });
      const web = fakeWeb((query) => {
        if (query === "博查挂了") throw new Error("Bocha Search HTTP 500");
        return [webItem("https://example.com/ok")];
      });
      await scan(service(pool, { web }), "person-a", "person-c", "person-b");
      expect((await lastRun(pool, "person-a")).last_run).toMatchObject({ status: "failed", createdSignals: 0, warnings: ["全网检索「博查挂了」失败：Bocha Search HTTP 500"] });
      expect((await lastRun(pool, "person-c")).last_run).toMatchObject({ status: "failed", createdSignals: 0, warnings: ["雷达设置数据无效"] });
      expect((await lastRun(pool, "person-b")).last_run).toMatchObject({ status: "completed", createdSignals: 1 });
    });
  });

  it("判定全部失败记为 failed，一条都不写；部分批失败照常完成", async () => {
    await createTestDb(async ({ db, pool }) => {
      await migrate(db);
      const directions = ["方向一", "方向二", "方向三", "方向四", "方向五"];
      await setRadar(pool, "person-a");
      await setRadar(pool, "person-b", { directions });
      // 每个方向 3 条不同网址：5 个方向共 15 条，分两批（10 + 5）
      const web = fakeWeb((query) => Array.from({ length: 3 }, (_, index) => webItem(`https://example.com/${encodeURIComponent(query)}/${index}`, { publishedAt: hours(index + 1) })));
      await scan(service(pool, { web, judge: { async judge() { throw new Error("light model down"); } } }), "person-a");
      expect((await lastRun(pool, "person-a")).last_run).toMatchObject({ status: "failed", createdSignals: 0, warnings: ["研判失败：light model down"] });
      expect(await count(pool, "person_radar_signals")).toBe(0);

      const inner = acceptAll();
      let calls = 0;
      await scan(service(pool, {
        web,
        judge: { async judge(input, signal) { calls += 1; if (calls === 1) throw new Error("第一批失败"); return inner.judge(input, signal); } },
      }), "person-b");
      expect(calls).toBe(2);
      expect((await lastRun(pool, "person-b")).last_run).toMatchObject({ status: "completed", createdSignals: 5, warnings: ["研判失败：第一批失败"] });
    });
  });

  it("采集悬挂到上限就中断、记为 failed，下一个人照常扫", async () => {
    await createTestDb(async ({ db, pool }) => {
      await migrate(db);
      await setRadar(pool, "person-a", { directions: ["悬挂"] });
      await setRadar(pool, "person-b", { directions: ["正常"] });
      let observedAbort = false;
      const web = fakeWeb((query, signal) => {
        if (query === "正常") return [webItem("https://example.com/ok")];
        return new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => { observedAbort = true; reject(signal.reason); }, { once: true });
        });
      });
      await scan(service(pool, { web, scanTimeoutMs: 200 }), "person-a", "person-b");
      expect(observedAbort).toBe(true);
      expect((await lastRun(pool, "person-a")).last_run).toMatchObject({ status: "failed", createdSignals: 0, warnings: ["扫描超过 0.2 秒上限，已中断"] });
      expect((await lastRun(pool, "person-b")).last_run).toMatchObject({ status: "completed", createdSignals: 1 });
    });
  });

  it("判定阶段超时：判完的照常写，没来得及判的条数写进 warning；一批都没判完就记为 failed", async () => {
    await createTestDb(async ({ db, pool }) => {
      await migrate(db);
      await setRadar(pool, "person-a", { directions: ["方向一", "方向二", "方向三", "方向四", "方向五"] });
      await setRadar(pool, "person-b");
      const web = fakeWeb((query) => Array.from({ length: 3 }, (_, index) => webItem(`https://example.com/${encodeURIComponent(query)}/${index}`, { publishedAt: hours(index + 1) })));
      const inner = acceptAll(3);
      const hang = (signal: AbortSignal) => new Promise<never>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
      let calls = 0;
      await scan(service(pool, {
        web,
        scanTimeoutMs: 200,
        judge: { judge(input, signal) { calls += 1; return calls === 1 ? inner.judge(input, signal) : hang(signal); } },
      }), "person-a");
      expect(calls).toBe(2);
      expect(await count(pool, "person_radar_signals")).toBe(10);
      expect((await lastRun(pool, "person-a")).last_run).toMatchObject({ status: "completed", createdSignals: 10, warnings: ["有 5 条没来得及研判（超过 0.2 秒上限）"] });

      await scan(service(pool, { web, scanTimeoutMs: 30, judge: { judge: (_input, signal) => hang(signal) } }), "person-b");
      expect((await lastRun(pool, "person-b")).last_run).toMatchObject({ status: "failed", createdSignals: 0, warnings: ["有 3 条没来得及研判（超过 0.03 秒上限）"] });
    });
  });
});

describe("调度与启动补偿", () => {
  it("定时补扫只排今天没扫过、开着、还在 seed 里的成员；同一天再补扫不重复", async () => {
    await createTestDb(async ({ db, pool }) => {
      await migrate(db);
      await setRadar(pool, "person-a");
      await setRadar(pool, "person-b", { lastScanDay: "2026-10-07" });
      await setRadar(pool, "person-c", { lastScanDay: "2026-10-08" });
      await setRadar(pool, "person-ceo");
      await setRadar(pool, "person-gone");
      await pool.query("INSERT INTO person_radar (person_id) VALUES ('person-off')");
      const web = fakeWeb(() => []);
      const radar = service(pool, { web });
      await radar.runScheduled();
      await radar.idle();
      expect(web.calls).toHaveLength(2);
      const days = (await pool.query("SELECT person_id, last_scan_day::text AS day, last_run->>'trigger' AS trigger FROM person_radar ORDER BY person_id")).rows;
      expect(days).toEqual([
        { person_id: "person-a", day: "2026-10-08", trigger: "scheduled" },
        { person_id: "person-b", day: "2026-10-08", trigger: "scheduled" },
        { person_id: "person-c", day: "2026-10-08", trigger: null },
        { person_id: "person-ceo", day: null, trigger: null },
        { person_id: "person-gone", day: null, trigger: null },
        { person_id: "person-off", day: null, trigger: null },
      ]);
      await radar.runScheduled();
      await radar.idle();
      expect(web.calls).toHaveLength(2);
      // 认领时再看一次：排在队里的定时扫描碰上今天已经扫过的人，直接跳过（多进程或排队期间刚扫完）
      radar.enqueue("person-a", "scheduled");
      await radar.idle();
      expect(web.calls).toHaveLength(2);
      // 手动扫描不受当天限制；已在队列里的人再排一次会被忽略
      radar.enqueue("person-a", "manual");
      radar.enqueue("person-b", "manual");
      radar.enqueue("person-b", "manual");
      await radar.idle();
      expect(web.calls).toHaveLength(4);
    });
  });

  it("正在扫描时库里又接受了一次手动请求：排在后面再扫，不会一直停在排队中", async () => {
    await createTestDb(async ({ db, pool }) => {
      await migrate(db);
      await setRadar(pool, "person-a");
      let release!: () => void;
      let started!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const entered = new Promise<void>((resolve) => { started = resolve; });
      const web = fakeWeb(async () => {
        if (web.calls.length === 1) {
          started();
          await gate;
        }
        return [];
      });
      const radar = service(pool, { web });
      radar.enqueue("person-a", "scheduled");
      await entered;
      // 第一次扫描还没结束时，/scan 的 CAS 已把这次手动请求记成排队中
      radar.enqueue("person-a", "manual");
      release();
      await radar.idle();
      expect(web.calls).toHaveLength(2);
      expect((await lastRun(pool, "person-a")).last_run).toMatchObject({ trigger: "manual", status: "completed" });
    });
  });

  it("公司扫描结束（busy 除外）才排个人扫描；两段各自捕获，tick 永不 reject", async () => {
    const statuses: (TRadarScanResponse["status"] | "throw")[] = ["completed", "busy", "skipped", "failed", "throw"];
    const company: RadarService = {
      providerStatus: { web: false, wechat: false, outlets: false },
      async recoverStaleRuns() {},
      runManual: async () => { throw new Error("unused"); },
      async runScheduled() {
        const status = statuses.shift()!;
        if (status === "throw") throw new Error("company blip");
        return { trigger: "scheduled", status, companyDay: "2026-10-08", createdSignals: 0, warnings: [] };
      },
    };
    let after = 0;
    const scheduler = createRadarScheduler(company, 60_000, async () => {
      after += 1;
      if (after === 2) throw new Error("personal blip");
    });
    const seen: number[] = [];
    for (let index = 0; index < 5; index += 1) {
      await expect(scheduler.tick()).resolves.toBeUndefined();
      seen.push(after);
    }
    expect(seen).toEqual([1, 1, 2, 3, 4]);
  });

  it("启动补偿：排队中和扫描中的标为 failed 并注明被重启中断；personal-radar-assess 的 running 运行同样标为 failed；不自动重跑", async () => {
    await createTestDb(async ({ db, pool }) => {
      await migrate(db);
      await setRadar(pool, "person-a");
      await setRadar(pool, "person-b");
      await setRadar(pool, "person-c");
      const run = (status: string) => JSON.stringify({ trigger: "manual", status, queuedAt: NOW.toISOString(), createdSignals: 0, warnings: [] });
      await pool.query("UPDATE person_radar SET last_run = $2::jsonb WHERE person_id = $1", ["person-a", run("queued")]);
      await pool.query("UPDATE person_radar SET last_run = $2::jsonb WHERE person_id = $1", ["person-b", run("running")]);
      await pool.query("UPDATE person_radar SET last_run = $2::jsonb WHERE person_id = $1", ["person-c", run("completed")]);
      await pool.query(`INSERT INTO agent_runs (id, kind, status, model_slot, prompt_hash, input_snapshot) VALUES
        (gen_random_uuid(), 'personal-radar-assess', 'running', 'light', 'hash', '{}'::jsonb),
        (gen_random_uuid(), 'radar-assess', 'running', 'light', 'hash', '{}'::jsonb)`);
      const web = fakeWeb(() => []);
      await service(pool, { web }).recoverStaleRuns();
      const runs = (await pool.query("SELECT person_id, last_run FROM person_radar ORDER BY person_id")).rows;
      expect(runs[0].last_run).toMatchObject({ status: "failed", completedAt: NOW.toISOString(), warnings: ["扫描被进程重启中断"] });
      expect(runs[1].last_run).toMatchObject({ status: "failed", warnings: ["扫描被进程重启中断"] });
      expect(runs[2].last_run).toMatchObject({ status: "completed", warnings: [] });
      expect((await pool.query("SELECT kind, status FROM agent_runs ORDER BY kind")).rows).toEqual([
        { kind: "personal-radar-assess", status: "failed" },
        { kind: "radar-assess", status: "running" },
      ]);
      expect(web.calls).toEqual([]);
    });
  });

  it("排队后雷达被关掉：这次扫描取消并如实标为 failed，不会一直卡在排队中", async () => {
    await createTestDb(async ({ db, pool }) => {
      await migrate(db);
      await setRadar(pool, "person-a");
      await pool.query(`UPDATE person_radar SET enabled = FALSE, last_run = $2::jsonb WHERE person_id = $1`,
        ["person-a", JSON.stringify({ trigger: "manual", status: "queued", queuedAt: NOW.toISOString(), createdSignals: 0, warnings: [] })]);
      const web = fakeWeb(() => []);
      await scan(service(pool, { web }), "person-a");
      expect(web.calls).toEqual([]);
      expect((await lastRun(pool, "person-a")).last_run).toMatchObject({ status: "failed", warnings: ["雷达已关闭，这次扫描取消了"] });
    });
  });
});

const usage = { input: 5, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 8, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
function modelReply(content: AssistantMessage["content"]) {
  const final: AssistantMessage = {
    role: "assistant", api: "openai-responses", provider: "warmap", model: "fake-light", content, usage,
    stopReason: content[0].type === "toolCall" ? "toolUse" : "stop", timestamp: Date.now(),
  };
  const events = createAssistantMessageEventStream();
  queueMicrotask(() => {
    events.push({ type: "start", partial: { ...final, content: [] } });
    const block = final.content[0];
    if (block.type === "toolCall") {
      events.push({ type: "toolcall_start", contentIndex: 0, partial: final });
      events.push({ type: "toolcall_end", contentIndex: 0, toolCall: block, partial: final });
      events.push({ type: "done", reason: "toolUse", message: final });
    } else if (block.type === "text") {
      events.push({ type: "text_start", contentIndex: 0, partial: final });
      events.push({ type: "text_delta", contentIndex: 0, delta: block.text, partial: final });
      events.push({ type: "text_end", contentIndex: 0, content: block.text, partial: final });
      events.push({ type: "done", reason: "stop", message: final });
    }
  });
  return events;
}

describe("判定器（Pi 候选运行时）", () => {
  it("轻模型、person-radar 对象、只有 submit_candidate 一个工具；严格候选照常落库", async () => {
    await createTestDb(async ({ db, pool }) => {
      await migrate(db);
      await setRadar(pool, "person-a");
      const url = "https://example.com/strict";
      const contexts: Context[] = [];
      const judge = createPersonalRadarJudge({
        query: pool.query.bind(pool), baseUrl: "https://provider.invalid/v1/responses", apiKey: "test-key", modelId: "fake-light",
        streamSimple: (_model, context) => {
          contexts.push(context);
          return modelReply([{ type: "toolCall", id: "submit-1", name: "submit_candidate", arguments: { candidates: [{
            sourceFingerprint: fingerprintOf(url), directionId: `d_${createHash("sha256").update("v1\n大模型定价").digest("hex").slice(0, 12)}`,
            summary: "对手下调了企业版价格", reason: "直接回答了定价方向", evidenceQuote: "企业版价格下调", relevance: 5,
          }] } }]);
        },
      });
      await scan(service(pool, { web: fakeWeb(() => [webItem(url, { excerpt: "公告称企业版价格下调两成。" })]), judge }), "person-a");
      expect(contexts[0].tools?.map((tool) => tool.name)).toEqual(["submit_candidate"]);
      expect((await pool.query("SELECT summary, relevance FROM person_radar_signals")).rows).toEqual([{ summary: "对手下调了企业版价格", relevance: 5 }]);
      expect((await pool.query("SELECT kind, status, model_slot, object_ref FROM agent_runs")).rows).toEqual([
        { kind: "personal-radar-assess", status: "succeeded", model_slot: "light", object_ref: { type: "person-radar", id: "person-a" } },
      ]);
      expect(await count(pool, "signals")).toBe(0);
      expect(await count(pool, "issues")).toBe(0);
    });
  });

  it("多给升级字段的提交被契约拒绝：这一批失败，一条都不写", async () => {
    await createTestDb(async ({ db, pool }) => {
      await migrate(db);
      await setRadar(pool, "person-a");
      const url = "https://example.com/promotion";
      let turns = 0;
      const judge = createPersonalRadarJudge({
        query: pool.query.bind(pool), baseUrl: "https://provider.invalid/v1/responses", apiKey: "test-key", modelId: "fake-light",
        streamSimple: () => {
          turns += 1;
          if (turns > 1) return modelReply([{ type: "text", text: "结束" }]);
          return modelReply([{ type: "toolCall", id: "submit-1", name: "submit_candidate", arguments: { candidates: [{
            sourceFingerprint: fingerprintOf(url), directionId: `d_${createHash("sha256").update("v1\n大模型定价").digest("hex").slice(0, 12)}`,
            summary: "结论", reason: "理由", evidenceQuote: "原文", relevance: 5,
            promotion: { decisionKind: "company_direction", decisionQuestion: "要不要跟进？", options: ["跟", "不跟"] },
          }] } }]);
        },
      });
      await scan(service(pool, { web: fakeWeb(() => [webItem(url, { excerpt: "原文写明了变化。" })]), judge }), "person-a");
      expect((await lastRun(pool, "person-a")).last_run).toMatchObject({ status: "failed", createdSignals: 0 });
      expect(await count(pool, "person_radar_signals")).toBe(0);
      expect(await count(pool, "signals")).toBe(0);
      expect(await count(pool, "issues")).toBe(0);
      expect((await pool.query("SELECT status FROM agent_runs WHERE kind = 'personal-radar-assess'")).rows).toEqual([{ status: "failed" }]);
    });
  });
});

describe("接口排队到扫描完成", () => {
  it("POST /api/me/radar/scan 排队 → 后台扫描 → GET 看到完成与未读数", async () => {
    await createTestDb(async ({ db, pool }) => {
      await migrate(db);
      await seedTestAccess(db);
      const radar = createPersonalRadarService({
        pool, companyMemory: createCompanyContext(testEnv),
        web: fakeWeb(() => [webItem("https://example.com/flow")]), outlets: fakeOutlets(), judge: acceptAll(), now: () => NOW,
      });
      const app = await buildApp({
        pool, env: testEnv, now: () => NOW, personalRadarService: radar,
        conversationRuntime: { async run(input) { return { assistantMessage: "test", runtimeEntries: input.runtimeEntries }; } },
      });
      try {
        const login = await app.inject({ method: "POST", url: "/api/auth/login", headers: { origin: testEnv.publicOrigin }, payload: { loginId: "ceshiy", passcode: "1357" } });
        const cookie = (login.headers["set-cookie"] as string).split(";")[0];
        const headers = { cookie, origin: testEnv.publicOrigin };
        expect((await app.inject({ method: "PUT", url: "/api/me/radar", headers, payload: { enabled: true, directions: ["大模型定价"], sources: [] } })).statusCode).toBe(200);
        const queued = await app.inject({ method: "POST", url: "/api/me/radar/scan", headers });
        expect(queued.statusCode).toBe(202);
        expect(queued.json()).toEqual({ queued: true });
        await radar.idle();
        const mine = (await app.inject({ method: "GET", url: "/api/me/radar", headers: { cookie } })).json();
        expect(mine).toMatchObject({ lastRun: { trigger: "manual", status: "completed", createdSignals: 1 }, unreadCount: 1 });
        const list = (await app.inject({ method: "GET", url: "/api/me/radar/signals", headers: { cookie } })).json();
        expect(list.signals).toHaveLength(1);
        expect((await pool.query("SELECT person_id FROM person_radar_signals")).rows).toEqual([{ person_id: TEST_MEMBER.personId }]);
      } finally {
        await app.close();
      }
    });
  });
});
