import { createHash, randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { FormatRegistry } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import {
  CompanyRadarSettings, MeHomeResponse, MyRadar, OnboardingResponse, PersonalSignal, PersonalSignalList, RadarAnchor, RadarSources,
  type TRadarSourceItem,
} from "@warmap/contracts";
import { buildApp } from "../src/app.js";
import { migrate } from "../src/migrate.js";
import type { PersonalRadarService } from "../src/personalRadar.js";
import { createRadarService, type RadarService } from "../src/radar.js";
import { createTestApp, createTestDb, seedTestAccess, testEnv, TEST_LOGIN, TEST_MEMBER, type TestApp } from "./helpers.js";

// Fastify 用 ajv 校验格式；这里给 Value.Check 局部注册响应里用到的三种格式，证明响应符合冻结的契约。
beforeAll(() => {
  FormatRegistry.Set("uuid", (value) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value));
  FormatRegistry.Set("date", (value) => /^\d{4}-\d{2}-\d{2}$/.test(value));
  FormatRegistry.Set("date-time", (value) => !Number.isNaN(Date.parse(value)) && /T/.test(value));
});

// 2026-10-08 10:00（Asia/Shanghai）
const NOW = new Date("2026-10-08T02:00:00.000Z");
const hashId = (text: string) => createHash("sha256").update(`v1\n${text}`).digest("hex").slice(0, 12);
const SITE_NOTE = "全网检索后按域名筛，结果可能很少";
const CEO_ONLY = "CEO 的雷达就是公司雷达，在「雷达设置」里修改";

function spyRadar(webSearch = true) {
  const enqueued: [string, string][] = [];
  const service: PersonalRadarService = {
    providerStatus: { webSearch },
    enqueue: (personId, trigger) => { enqueued.push([personId, trigger]); },
    async runScheduled() {},
    async recoverStaleRuns() {},
    async idle() {},
  };
  return { enqueued, service };
}

function companyRadarStub(web: boolean): RadarService {
  const failed = async () => ({ trigger: "manual" as const, status: "failed" as const, companyDay: "2026-10-08", createdSignals: 0, warnings: [] });
  return { providerStatus: { web, wechat: false, outlets: true }, async recoverStaleRuns() {}, runManual: failed, runScheduled: failed };
}

async function open(options: { webSearch?: boolean; companyWeb?: boolean } = {}) {
  const spy = spyRadar(options.webSearch ?? true);
  const t = await createTestApp({}, undefined, {
    monthlyNow: () => NOW,
    personalRadarService: spy.service,
    ...(options.companyWeb === undefined ? {} : { radarService: companyRadarStub(options.companyWeb) }),
  });
  return { t, spy, ceo: await t.loginCookie(), member: await t.memberCookie() };
}

type Method = "GET" | "PUT" | "PATCH" | "POST";
const call = (t: TestApp, method: Method, url: string, cookie?: string, payload?: unknown, origin: string | null = t.publicOrigin) =>
  t.app.inject({
    method, url,
    headers: { ...(cookie ? { cookie } : {}), ...(origin ? { origin } : {}) },
    ...(payload === undefined ? {} : { payload: payload as object }),
  });

async function insertSignal(t: TestApp, personId: string, options: {
  url?: string; collectedAt?: Date; relevance?: number; read?: boolean; dismissed?: boolean; outlet?: { id: string; name: string }; summary?: string;
} = {}): Promise<string> {
  const id = randomUUID();
  const url = options.url ?? `https://www.example.com/news/${id}`;
  const sourceRef = options.outlet
    ? { type: "outlet", provider: "publisher-feed", outletId: options.outlet.id, outletName: options.outlet.name }
    : { type: "web-search", provider: "bocha", query: "大模型定价" };
  const at = options.collectedAt ?? NOW;
  await t.sql(
    `INSERT INTO person_radar_signals (id, person_id, source_type, source_fingerprint, source_title, source_url, published_at, excerpt,
       source_ref, direction_id, direction_text, summary, reason, evidence_quote, relevance, read_at, dismissed_at, collected_at)
     VALUES ($1, $2, $3, $4, '原文标题', $5, $6, '原文全文，写明了企业版价格下调。', $7::jsonb, $8, '大模型定价', $9, '直接回答了定价方向',
       '企业版价格下调', $10, $11, $12, $13)`,
    [id, personId, options.outlet ? "outlet" : "web", createHash("sha256").update(`v1\n${url}`).digest("hex"), url,
      new Date(at.getTime() - 3_600_000), JSON.stringify(sourceRef), `d_${hashId("大模型定价")}`, options.summary ?? "对手下调了企业版价格",
      options.relevance ?? 4, options.read ? at : null, options.dismissed ? at : null, at],
  );
  return id;
}

describe("闸门", () => {
  it("没登录 401；CEO 调 /api/me/radar* 403；成员调 /api/config/radar 403；写请求 Origin 不对 403", async () => {
    const { t, ceo, member } = await open();
    try {
      const id = randomUUID();
      const routes: [Method, string, unknown?][] = [
        ["GET", "/api/me/radar"],
        ["PUT", "/api/me/radar", { enabled: false, directions: [], sources: [] }],
        ["GET", "/api/me/radar/signals"],
        ["GET", `/api/me/radar/signals/${id}`],
        ["PATCH", `/api/me/radar/signals/${id}/state`, { read: true }],
        ["POST", "/api/me/radar/scan"],
      ];
      for (const [method, url, payload] of [...routes, ["GET", "/api/config/radar"], ["PUT", "/api/config/radar", { directions: [], sources: [] }]] as [Method, string, unknown?][]) {
        const res = await call(t, method, url, undefined, payload);
        expect([url, res.statusCode, res.json().code]).toEqual([url, 401, "UNAUTHORIZED"]);
      }
      for (const [method, url, payload] of routes) {
        const res = await call(t, method, url, ceo, payload);
        expect([url, res.statusCode, res.json()]).toMatchObject([url, 403, { code: "FORBIDDEN", message: CEO_ONLY }]);
      }
      for (const [method, url, payload] of [["GET", "/api/config/radar"], ["PUT", "/api/config/radar", { directions: [], sources: [] }]] as [Method, string, unknown?][]) {
        const res = await call(t, method, url, member, payload);
        expect([url, res.statusCode, res.json().code]).toEqual([url, 403, "FORBIDDEN"]);
      }
      for (const [method, url, payload] of routes.filter(([method]) => method !== "GET")) {
        const res = await call(t, method, url, member, payload, null);
        expect([url, res.statusCode, res.json().code]).toEqual([url, 403, "ORIGIN_MISMATCH"]);
      }
      const ceoPut = await call(t, "PUT", "/api/config/radar", ceo, { directions: [], sources: [] }, "https://evil.example");
      expect([ceoPut.statusCode, ceoPut.json().code]).toEqual([403, "ORIGIN_MISMATCH"]);
      expect(await t.sql("SELECT * FROM person_radar")).toEqual([]);
    } finally { await t.close(); }
  });
});

describe("GET/PUT /api/me/radar", () => {
  it("从没保存过：默认关闭、updatedAt 为 null；建议来源只放能读的", async () => {
    const { t, member } = await open();
    try {
      const res = await call(t, "GET", "/api/me/radar", member);
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(Value.Check(MyRadar, body)).toBe(true);
      expect(body).toMatchObject({ enabled: false, directions: [], sources: [], updatedAt: null, lastRun: null, unreadCount: 0, webSearch: true });
      expect(body.suggestions.sources.map((item: { value: string }) => item.value)).toEqual([
        "ft.com", "qbitai.com", "theinformation.com", "bbc.com", "bloomberg.com", "reuters.com", "cnbc.com", "economist.com", "36kr.com", "jiqizhixin.com",
      ]);
    } finally { await t.close(); }

    const closed = await open({ webSearch: false });
    try {
      const body = (await call(closed.t, "GET", "/api/me/radar", closed.member)).json();
      expect(body.webSearch).toBe(false);
      expect(body.suggestions.sources.every((item: { kind: string }) => item.kind === "feed")).toBe(true);
    } finally { await closed.t.close(); }
  });

  it("PUT 往返规范化：库里只存规范值，GET 读回同一份，读法现算；PUT 不触发扫描", async () => {
    const { t, spy, member } = await open();
    try {
      const put = await call(t, "PUT", "/api/me/radar", member, {
        enabled: true,
        directions: [" 1 号位产品的设计 ", "ＡＩ　Agent", "ai agent"],
        sources: ["HTTPS://WWW.FT.COM/world?x=1#y", "36kr.com/p/1", "github.com/trending?since=daily", "ft.com"],
      });
      expect(put.statusCode).toBe(200);
      expect(Value.Check(MyRadar, put.json())).toBe(true);
      expect(put.json()).toMatchObject({
        enabled: true,
        directions: [{ id: `d_${hashId("1 号位产品的设计")}`, text: "1 号位产品的设计" }, { id: `d_${hashId("AI Agent")}`, text: "AI Agent" }],
        sources: [
          { value: "ft.com", name: "金融时报", kind: "feed", note: "订阅源" },
          { value: "36kr.com", name: "36氪", kind: "site", note: SITE_NOTE },
          { value: "github.com/trending", name: "GitHub Trending", kind: "unsupported", note: "榜单读取器还在开发，暂不支持" },
        ],
        updatedAt: NOW.toISOString(), lastRun: null, unreadCount: 0,
      });
      expect((await call(t, "GET", "/api/me/radar", member)).json()).toEqual(put.json());
      expect(await t.sql("SELECT person_id, enabled, directions, sources, updated_at FROM person_radar")).toEqual([{
        person_id: TEST_MEMBER.personId, enabled: true, directions: ["1 号位产品的设计", "AI Agent"], sources: ["ft.com", "36kr.com", "github.com/trending"], updated_at: NOW,
      }]);
      expect(spy.enqueued).toEqual([]);

      // 关掉也能保存；方向和来源留着
      const off = await call(t, "PUT", "/api/me/radar", member, { enabled: false, directions: ["1 号位产品的设计"], sources: [] });
      expect(off.json()).toMatchObject({ enabled: false, directions: [{ text: "1 号位产品的设计" }], sources: [] });
    } finally { await t.close(); }
  });

  it("PUT 的 400：开启没方向、方向不合格、来源不合格（一次返回全部）、超过条数；失败时什么都不写", async () => {
    const { t, member } = await open();
    try {
      const put = (payload: unknown) => call(t, "PUT", "/api/me/radar", member, payload);
      const required = await put({ enabled: true, directions: [], sources: ["ft.com"] });
      expect([required.statusCode, required.json().code]).toEqual([400, "RADAR_DIRECTION_REQUIRED"]);
      const invalid = await put({ enabled: true, directions: ["!!!", "好方向", "中".repeat(41)], sources: [] });
      expect(invalid.statusCode).toBe(400);
      expect(invalid.json()).toMatchObject({ code: "RADAR_DIRECTION_INVALID", fieldErrors: { "directions/0": "方向要写成一句话", "directions/2": "方向最多 40 个字" } });
      expect(invalid.json().fieldErrors).not.toHaveProperty("directions/1");
      const sources = await put({ enabled: true, directions: ["方向"], sources: ["mp.weixin.qq.com/s/1", "ft.com", "127.0.0.1", "ftp://ft.com"] });
      expect(sources.statusCode).toBe(400);
      expect(sources.json()).toMatchObject({ code: "RADAR_SOURCE_INVALID", fieldErrors: {
        "sources/0": "公众号要按账号订阅，贴文章链接读不到", "sources/2": "请填公开网站的域名", "sources/3": "只支持 http 或 https 网址",
      } });
      for (const payload of [
        { enabled: true, directions: ["一", "二", "三", "四", "五", "六"], sources: [] },
        { enabled: true, directions: ["方向"], sources: Array.from({ length: 11 }, (_, index) => `site${index}.com`) },
        { enabled: true, directions: ["中".repeat(81)], sources: [] },
      ]) {
        const res = await put(payload);
        expect([res.statusCode, res.json().code]).toEqual([400, "INVALID_INPUT"]);
      }
      expect(await t.sql("SELECT * FROM person_radar")).toEqual([]);
    } finally { await t.close(); }
  });

  it("方向建议取自本月参与的战场、能力与本人 Mission，讨论候选写明来源；已在方向里的不再建议", async () => {
    const { t, member } = await open();
    try {
      await t.sql("UPDATE battlefield_config SET owner_id = $1 WHERE id = 'growth'", [TEST_MEMBER.personId]);
      await t.sql("INSERT INTO capability_config (id, version, code, name, six_month_outcome) VALUES ('method', 1, '07', '方法论', '能力目标')");
      await t.sql(`INSERT INTO missions (id, version, code, period, title, owner_id, capability_id, battlefield_ids, outcome, source_ref, source_document_id, source_revision, source_title, placeholder)
        VALUES ('m-1', 1, 'A-1', '2026-10', '未来组织范式设计与确认', $1, 'method', '["growth"]', '结果', 'fixture', 'fixture', 1, '测试', TRUE),
               ('m-2', 1, 'A-2', '2026-10', '渠道定价复盘，下月再定', $1, 'method', '[]', '结果', 'fixture', 'fixture', 1, '测试', FALSE),
               ('m-old', 1, 'A-0', '2026-09', '上个月的任务', $1, 'method', '[]', '结果', 'fixture', 'fixture', 1, '测试', FALSE)`, [TEST_MEMBER.personId]);
      const suggestions = async () => (await call(t, "GET", "/api/me/radar", member)).json().suggestions.directions;
      expect(await suggestions()).toEqual([
        { text: "未来组织范式设计与确认", from: "10 月讨论候选" },
        { text: "增长战场", from: "参与的战场" },
        { text: "方法论", from: "能力域" },
      ]);
      await call(t, "PUT", "/api/me/radar", member, { enabled: true, directions: ["未来组织范式设计与确认", "增长战场"], sources: [] });
      expect(await suggestions()).toEqual([
        { text: "渠道定价复盘", from: "10 月 Mission" },
        { text: "方法论", from: "能力域" },
      ]);
    } finally { await t.close(); }
  });
});

describe("个人信号", () => {
  it("列表、单条与状态只看本人的；不是 UUID、不存在、第三个人的一律 404", async () => {
    const { t, member } = await open();
    try {
      const older = await insertSignal(t, TEST_MEMBER.personId, { collectedAt: new Date(NOW.getTime() - 60_000) });
      const newer = await insertSignal(t, TEST_MEMBER.personId, { outlet: { id: "qbitai", name: "量子位" }, url: "https://www.qbitai.com/2026/10/1.html" });
      const hidden = await insertSignal(t, TEST_MEMBER.personId, { dismissed: true });
      const others = await insertSignal(t, "person-third", {});

      const list = await call(t, "GET", "/api/me/radar/signals", member);
      expect(list.statusCode).toBe(200);
      expect(Value.Check(PersonalSignalList, list.json())).toBe(true);
      expect(list.json().signals.map((signal: { id: string }) => signal.id)).toEqual([newer, older]);
      expect(list.json().signals[0]).not.toHaveProperty("excerpt");
      expect(list.json().signals[0].source).toMatchObject({ type: "outlet", label: "量子位", listedOn: null });
      expect(list.json().signals[1].source).toMatchObject({ type: "web", label: "example.com" });
      expect((await call(t, "GET", "/api/me/radar/signals?limit=1", member)).json().signals.map((signal: { id: string }) => signal.id)).toEqual([newer]);
      for (const limit of ["0", "101", "abc"]) {
        const res = await call(t, "GET", `/api/me/radar/signals?limit=${limit}`, member);
        expect([limit, res.statusCode]).toEqual([limit, 400]);
      }

      const detail = await call(t, "GET", `/api/me/radar/signals/${newer}`, member);
      expect(Value.Check(PersonalSignal, detail.json())).toBe(true);
      expect(detail.json()).toMatchObject({
        id: newer, fullText: true, excerpt: "原文全文，写明了企业版价格下调。", evidenceQuote: "企业版价格下调",
        direction: { id: `d_${hashId("大模型定价")}`, text: "大模型定价" }, state: { read: false, saved: false, dismissed: false },
      });
      expect((await call(t, "GET", `/api/me/radar/signals/${older}`, member)).json().fullText).toBe(false);
      for (const id of ["not-a-uuid", randomUUID(), others]) {
        for (const [method, url, payload] of [["GET", `/api/me/radar/signals/${id}`], ["PATCH", `/api/me/radar/signals/${id}/state`, { read: true }]] as [Method, string, unknown?][]) {
          const res = await call(t, method, url, member, payload);
          expect([url, res.statusCode, res.json().code]).toEqual([url, 404, "SIGNAL_NOT_FOUND"]);
        }
      }
      expect(await t.sql("SELECT read_at FROM person_radar_signals WHERE id = $1", [others])).toEqual([{ read_at: null }]);

      const read = await call(t, "PATCH", `/api/me/radar/signals/${older}/state`, member, { read: true });
      expect(read.statusCode).toBe(200);
      expect(Value.Check(PersonalSignal, read.json())).toBe(true);
      expect(read.json().state).toEqual({ read: true, saved: false, dismissed: false });
      const [before] = await t.sql("SELECT read_at, updated_at FROM person_radar_signals WHERE id = $1", [older]);
      // 状态没变不写
      expect((await call(t, "PATCH", `/api/me/radar/signals/${older}/state`, member, { read: true })).json().state.read).toBe(true);
      expect(await t.sql("SELECT read_at, updated_at FROM person_radar_signals WHERE id = $1", [older])).toEqual([before]);
      expect((await call(t, "PATCH", `/api/me/radar/signals/${older}/state`, member, { saved: true, dismissed: true })).json().state).toEqual({ read: true, saved: true, dismissed: true });
      expect((await call(t, "GET", "/api/me/radar/signals", member)).json().signals.map((signal: { id: string }) => signal.id)).toEqual([newer]);
      expect((await call(t, "PATCH", `/api/me/radar/signals/${older}/state`, member, { dismissed: false })).json().state).toEqual({ read: true, saved: true, dismissed: false });
      expect((await call(t, "GET", `/api/me/radar/signals/${hidden}`, member)).json().state.dismissed).toBe(true);
      // 未读数：本人、未读、未隐藏
      expect((await call(t, "GET", "/api/me/radar", member)).json().unreadCount).toBe(1);
    } finally { await t.close(); }
  });

  it("泄露检查：成员的个人信号不进公司雷达的列表、单条、未读数、状态接口与对话", async () => {
    const { t, ceo, member } = await open();
    try {
      const id = await insertSignal(t, TEST_MEMBER.personId);
      const signals = await call(t, "GET", "/api/cards/signals", ceo);
      expect([signals.statusCode, signals.json().cards]).toEqual([200, []]);
      expect((await call(t, "GET", `/api/cards/signals/${id}`, ceo)).statusCode).toBe(404);
      expect((await call(t, "GET", "/api/cards/radar", ceo)).json().cards[0].payload.unreadCount).toBe(0);
      expect((await call(t, "PATCH", `/api/signals/${id}/state`, ceo, { read: true })).statusCode).toBe(404);
      for (const cookie of [ceo, member]) {
        const res = await call(t, "GET", `/api/conversations/signal:${id}/messages`, cookie);
        expect([res.statusCode, res.json().code]).toEqual([404, "CONVERSATION_SCOPE_NOT_FOUND"]);
      }
      const home = (await call(t, "GET", "/api/cards/home", ceo)).json();
      expect(JSON.stringify(home)).not.toContain(id);
      expect(await t.sql("SELECT read_at FROM person_radar_signals WHERE id = $1", [id])).toEqual([{ read_at: null }]);
    } finally { await t.close(); }
  });
});

describe("POST /api/me/radar/scan", () => {
  it("202 排队；排队中 409；冷却 429 带 retry-after；没开 409；今天收满 409", async () => {
    const { t, spy, member } = await open();
    try {
      const scan = () => call(t, "POST", "/api/me/radar/scan", member);
      const never = await scan();
      expect([never.statusCode, never.json().code]).toEqual([409, "RADAR_DISABLED"]);
      await call(t, "PUT", "/api/me/radar", member, { enabled: true, directions: ["大模型定价"], sources: [] });

      const queued = await scan();
      expect([queued.statusCode, queued.json()]).toEqual([202, { queued: true }]);
      expect(spy.enqueued).toEqual([[TEST_MEMBER.personId, "manual"]]);
      expect(await t.sql("SELECT last_manual_scan_at, last_run FROM person_radar")).toEqual([{
        last_manual_scan_at: NOW,
        last_run: { trigger: "manual", status: "queued", queuedAt: NOW.toISOString(), createdSignals: 0, warnings: [] },
      }]);
      expect((await call(t, "GET", "/api/me/radar", member)).json().lastRun).toEqual({ trigger: "manual", status: "queued", queuedAt: NOW.toISOString(), createdSignals: 0, warnings: [] });

      const again = await scan();
      expect([again.statusCode, again.json().code]).toEqual([409, "RADAR_SCAN_IN_PROGRESS"]);
      await t.sql(`UPDATE person_radar SET last_run = jsonb_set(last_run, '{status}', '"running"')`);
      expect((await scan()).json().code).toBe("RADAR_SCAN_IN_PROGRESS");

      await t.sql(`UPDATE person_radar SET last_run = jsonb_set(last_run, '{status}', '"completed"'), last_manual_scan_at = $1`, [new Date(NOW.getTime() - 4 * 60_000)]);
      const cooling = await scan();
      expect([cooling.statusCode, cooling.json().code, cooling.headers["retry-after"]]).toEqual([429, "RADAR_SCAN_RATE_LIMITED", "360"]);
      await t.sql("UPDATE person_radar SET last_manual_scan_at = $1", [new Date(NOW.getTime() - 10 * 60_000)]);
      expect((await scan()).statusCode).toBe(202);
      expect(spy.enqueued).toHaveLength(2);

      await t.sql(`UPDATE person_radar SET last_run = jsonb_set(last_run, '{status}', '"completed"'), last_manual_scan_at = NULL`);
      for (let index = 0; index < 10; index += 1) await insertSignal(t, TEST_MEMBER.personId);
      const capped = await scan();
      expect([capped.statusCode, capped.json().code]).toEqual([409, "RADAR_DAILY_CAP_REACHED"]);

      await t.sql("DELETE FROM person_radar_signals");
      await call(t, "PUT", "/api/me/radar", member, { enabled: false, directions: [], sources: [] });
      const disabled = await scan();
      expect([disabled.statusCode, disabled.json().code]).toEqual([409, "RADAR_DISABLED"]);
      expect(spy.enqueued).toHaveLength(2);
    } finally { await t.close(); }
  });
});

describe("首页与引导", () => {
  it("/api/me/home：没保存过或关着为 null；开着时带最近一次扫描、未读数和最多 3 条亮点；CEO 为 null", async () => {
    const { t, ceo, member } = await open();
    try {
      const home = async (cookie: string) => {
        const res = await call(t, "GET", "/api/me/home", cookie);
        expect(res.statusCode).toBe(200);
        expect(Value.Check(MeHomeResponse, res.json())).toBe(true);
        return res.json().radar;
      };
      expect(await home(member)).toBeNull();
      expect(await home(ceo)).toBeNull();

      await call(t, "PUT", "/api/me/radar", member, { enabled: true, directions: ["大模型定价"], sources: [] });
      expect(await home(member)).toEqual({ lastRun: null, unreadCount: 0, highlights: [] });

      const day = 24 * 3_600_000;
      const ids = {
        top: await insertSignal(t, TEST_MEMBER.personId, { relevance: 5, collectedAt: new Date(NOW.getTime() - 2 * day) }),
        topNewer: await insertSignal(t, TEST_MEMBER.personId, { relevance: 5, collectedAt: new Date(NOW.getTime() - day), read: true }),
        mid: await insertSignal(t, TEST_MEMBER.personId, { relevance: 4 }),
        low: await insertSignal(t, TEST_MEMBER.personId, { relevance: 3 }),
        hiddenTop: await insertSignal(t, TEST_MEMBER.personId, { relevance: 5, dismissed: true }),
        stale: await insertSignal(t, TEST_MEMBER.personId, { relevance: 5, collectedAt: new Date(NOW.getTime() - 8 * day) }),
      };
      await insertSignal(t, "person-third", { relevance: 5 });
      await t.sql("UPDATE person_radar SET last_run = $1::jsonb", [JSON.stringify({ trigger: "scheduled", status: "completed", startedAt: NOW.toISOString(), completedAt: NOW.toISOString(), createdSignals: 4, warnings: [] })]);
      const radar = await home(member);
      expect(radar.lastRun).toMatchObject({ trigger: "scheduled", status: "completed", createdSignals: 4 });
      expect(radar.unreadCount).toBe(4);
      expect(radar.highlights.map((signal: { id: string }) => signal.id)).toEqual([ids.topNewer, ids.top, ids.mid]);
      expect(radar.highlights[0]).not.toHaveProperty("excerpt");

      await call(t, "PUT", "/api/me/radar", member, { enabled: false, directions: ["大模型定价"], sources: [] });
      expect(await home(member)).toBeNull();
      // 关掉之后，已经收到的仍能在「我的雷达」里看到
      expect((await call(t, "GET", "/api/me/radar/signals", member)).json().signals).toHaveLength(5);
    } finally { await t.close(); }
  });

  it("引导的雷达摘要：成员按本人设置；CEO 按公司雷达的手工方向与媒体来源，公司雷达恒为开启", async () => {
    const { t, ceo, member } = await open();
    try {
      const summary = async (cookie: string) => {
        const res = await call(t, "GET", "/api/me/onboarding", cookie);
        expect(res.statusCode).toBe(200);
        expect(Value.Check(OnboardingResponse, res.json())).toBe(true);
        return res.json().radar;
      };
      expect(await summary(member)).toEqual({ configured: false, enabled: false, directions: 0 });
      await call(t, "PUT", "/api/me/radar", member, { enabled: true, directions: ["一个方向", "另一个方向"], sources: [] });
      expect(await summary(member)).toEqual({ configured: true, enabled: true, directions: 2 });
      await call(t, "PUT", "/api/me/radar", member, { enabled: false, directions: [], sources: [] });
      expect(await summary(member)).toEqual({ configured: true, enabled: false, directions: 0 });

      expect(await summary(ceo)).toEqual({ configured: false, enabled: true, directions: 0 });
      await t.sql(`UPDATE radar_config SET sources = '{"sites":[],"wechatAccounts":[],"outlets":[{"id":"x","name":"媒体","enabled":true,"outlets":["ft"]}]}'::jsonb`);
      expect(await summary(ceo)).toEqual({ configured: true, enabled: true, directions: 0 });
      await t.sql(`UPDATE radar_config SET sources = '{"sites":[],"wechatAccounts":[],"outlets":[{"id":"x","name":"媒体","enabled":false,"outlets":["ft"]}]}'::jsonb`);
      expect(await summary(ceo)).toEqual({ configured: false, enabled: true, directions: 0 });
      await call(t, "PUT", "/api/config/radar", ceo, { directions: ["大模型定价", "芯片出口"], sources: [] });
      expect(await summary(ceo)).toEqual({ configured: true, enabled: true, directions: 2 });
    } finally { await t.close(); }
  });
});

const LEGACY_ANCHOR = { id: "legacy-anchor", title: "旧的手写方向", query: "旧查询", location: { type: "company" } };
const ONTOLOGY_ANCHOR = { id: "ontology:company", title: "公司目标", query: "本月公司目标", location: { type: "company" }, source: "ontology", originRef: "monthly-plan:2026-10" };
const OLD_MANUAL = { id: "manual:old", title: "旧手工方向", query: "旧手工方向", location: { type: "company" }, source: "manual" };
const COMPANY_SOURCES = {
  sites: [{ id: "site-web", name: "全网", enabled: true }],
  wechatAccounts: [{ id: "wx", accountId: "fakeid-1", name: "增长观察", enabled: true }],
  outlets: [
    { id: "finance", name: "全球财经媒体", enabled: true, outlets: ["ft", "bbc"] },
    { id: "tech", name: "科技媒体", enabled: true, outlets: ["bbc", "qbitai"] },
    { id: "off", name: "停用", enabled: false, outlets: ["reuters"] },
  ],
};

describe("/api/config/radar", () => {
  it("GET：manual anchor 是方向，已启用发布方的并集是来源，其余 anchor 只读；webSearch 看公司全网来源", async () => {
    const { t, ceo } = await open({ companyWeb: true });
    try {
      await t.sql("UPDATE radar_config SET anchors = $1::jsonb, sources = $2::jsonb", [JSON.stringify([ONTOLOGY_ANCHOR, OLD_MANUAL, LEGACY_ANCHOR]), JSON.stringify(COMPANY_SOURCES)]);
      const res = await call(t, "GET", "/api/config/radar", ceo);
      expect(res.statusCode).toBe(200);
      expect(Value.Check(CompanyRadarSettings, res.json())).toBe(true);
      expect(res.json()).toMatchObject({
        directions: [{ id: "manual:old", text: "旧手工方向" }],
        sources: [
          { value: "ft.com", name: "金融时报", kind: "feed", note: "订阅源" },
          { value: "bbc.com", name: "BBC", kind: "feed", note: "订阅源" },
          { value: "qbitai.com", name: "量子位", kind: "feed", note: "订阅源" },
        ],
        automatic: ["公司目标", "旧的手写方向"],
        webSearch: true,
      });
      expect(res.json().suggestions.sources.map((item: { kind: string }) => item.kind)).toEqual(Array(8).fill("feed"));
      // 雷达卡的媒体名单从已启用发布方现算：去重、按目录顺序，不再写死
      expect((await call(t, "GET", "/api/cards/radar", ceo)).json().cards[0].payload.sources.outlets).toMatchObject({
        configured: true, sourceCount: 3, names: ["BBC", "金融时报", "量子位"],
      });
      await t.sql(`UPDATE radar_config SET sources = jsonb_set(sources, '{sites,0,enabled}', 'false')`);
      expect((await call(t, "GET", "/api/config/radar", ceo)).json().webSearch).toBe(false);
    } finally { await t.close(); }
  });

  it("PUT：公司模式只收订阅源，方向规则同成员；失败时配置不动", async () => {
    const { t, ceo } = await open();
    try {
      const [before] = await t.sql("SELECT version, anchors, sources FROM radar_config");
      const bad = await call(t, "PUT", "/api/config/radar", ceo, { directions: ["!!!"], sources: ["36kr.com", "ft.com", "wsj.com"] });
      expect(bad.statusCode).toBe(400);
      expect(bad.json()).toMatchObject({ code: "RADAR_DIRECTION_INVALID", fieldErrors: {
        "directions/0": "方向要写成一句话",
        "sources/0": "公司雷达已经在全网按方向检索；单独的网站只有在有订阅源时才能加入",
        "sources/2": "订阅源已停更，暂不支持",
      } });
      expect(await t.sql("SELECT version, anchors, sources FROM radar_config")).toEqual([before]);
    } finally { await t.close(); }
  });

  it("PUT：只替换 manual、放在最前，没有 source 的旧 anchor 原样保留；清空时写 outlets: []；写完 Value.Check 为真、公司扫描照常跑、不自动扫描", async () => {
    await createTestDb(async ({ db, pool }) => {
      await migrate(db);
      await seedTestAccess(db);
      await db.query("UPDATE radar_config SET anchors = $1::jsonb, sources = $2::jsonb", [JSON.stringify([ONTOLOGY_ANCHOR, OLD_MANUAL, LEGACY_ANCHOR]), JSON.stringify(COMPANY_SOURCES)]);
      const searched: string[] = [];
      const fetched: string[][] = [];
      const assessedAnchors: string[][] = [];
      const radar = createRadarService({
        pool,
        web: { configured: true, async search(input) { searched.push(input.query); return []; } },
        outlets: {
          configured: true,
          async fetchLatest(input): Promise<TRadarSourceItem[]> {
            fetched.push(input.outletIds);
            return [{ sourceType: "outlet", title: "条目", url: "https://www.theinformation.com/articles/a", publishedAt: new Date(NOW.getTime() - 3_600_000).toISOString(), excerpt: "原文", sourceRef: { type: "outlet", provider: "publisher-feed", outletId: "theinformation", outletName: "The Information" } }];
          },
        },
        assessor: { async assess(input) { assessedAnchors.push(input.anchors.map((anchor) => anchor.id)); return { candidates: [] }; } },
        now: () => NOW,
      });
      const app = await buildApp({
        pool, env: testEnv, now: () => NOW, radarService: radar,
        conversationRuntime: { async run(input) { return { assistantMessage: "test", runtimeEntries: input.runtimeEntries }; } },
      });
      try {
        const login = await app.inject({ method: "POST", url: "/api/auth/login", headers: { origin: testEnv.publicOrigin }, payload: TEST_LOGIN });
        const headers = { cookie: (login.headers["set-cookie"] as string).split(";")[0], origin: testEnv.publicOrigin };
        const config = async () => (await pool.query("SELECT version, anchors, sources, last_run FROM radar_config")).rows[0];
        const { version } = await config();

        const put = await app.inject({ method: "PUT", url: "/api/config/radar", headers, payload: { directions: ["大模型定价", " 大模型定价 ", "芯片出口"], sources: ["theinformation.com", "https://www.ft.com/world"] } });
        expect(put.statusCode).toBe(200);
        expect(Value.Check(CompanyRadarSettings, put.json())).toBe(true);
        expect(put.json()).toMatchObject({
          directions: [{ id: `manual:${hashId("大模型定价")}`, text: "大模型定价" }, { id: `manual:${hashId("芯片出口")}`, text: "芯片出口" }],
          sources: [{ value: "theinformation.com", name: "The Information", kind: "feed" }, { value: "ft.com", name: "金融时报", kind: "feed" }],
          automatic: ["公司目标", "旧的手写方向"],
        });
        const saved = await config();
        expect(saved.version).toBe(version + 1);
        expect(saved.last_run).toBeNull();
        expect(saved.anchors).toEqual([
          { id: `manual:${hashId("大模型定价")}`, title: "大模型定价", query: "大模型定价", location: { type: "company" }, source: "manual" },
          { id: `manual:${hashId("芯片出口")}`, title: "芯片出口", query: "芯片出口", location: { type: "company" }, source: "manual" },
          ONTOLOGY_ANCHOR,
          LEGACY_ANCHOR,
        ]);
        expect(saved.sources).toEqual({ ...COMPANY_SOURCES, outlets: [{ id: "settings", name: "雷达设置", enabled: true, outlets: ["theinformation", "ft"] }] });
        expect(saved.anchors.every((anchor: unknown) => Value.Check(RadarAnchor, anchor))).toBe(true);
        expect(Value.Check(RadarSources, saved.sources)).toBe(true);

        // 公司扫描照常跑：手工方向排在最前，新来源生效
        expect(await radar.runManual()).toMatchObject({ status: "completed" });
        expect(fetched).toEqual([["theinformation", "ft"]]);
        expect(assessedAnchors[0].slice(0, 2)).toEqual([`manual:${hashId("大模型定价")}`, `manual:${hashId("芯片出口")}`]);
        expect(searched.slice(0, 2)).toEqual(["大模型定价", "芯片出口"]);

        const cleared = await app.inject({ method: "PUT", url: "/api/config/radar", headers, payload: { directions: [], sources: [] } });
        expect(cleared.statusCode).toBe(200);
        expect(cleared.json()).toMatchObject({ directions: [], sources: [] });
        const empty = await config();
        expect(empty.sources).toEqual({ ...COMPANY_SOURCES, outlets: [] });
        expect(empty.anchors).toEqual([ONTOLOGY_ANCHOR, LEGACY_ANCHOR]);
        expect(Value.Check(RadarSources, empty.sources)).toBe(true);
        expect(await radar.runManual()).toMatchObject({ status: "completed" });
        expect(fetched).toHaveLength(1);
        expect(Number((await pool.query("SELECT count(*) FROM signals")).rows[0].count)).toBe(0);
      } finally {
        await app.close();
      }
    });
  });

  it("PUT 写前校验不过就回滚并返回 500，不把公司雷达写坏", async () => {
    const { t, ceo } = await open();
    try {
      // 库里已有一条不合规的旧 anchor：新配置整体过不了 Value.Check
      await t.sql("UPDATE radar_config SET anchors = $1::jsonb", [JSON.stringify([{ id: "broken", title: "", query: "q", location: { type: "company" } }])]);
      const [before] = await t.sql("SELECT version, anchors, sources FROM radar_config");
      const res = await call(t, "PUT", "/api/config/radar", ceo, { directions: ["大模型定价"], sources: ["ft.com"] });
      expect([res.statusCode, res.json().code]).toEqual([500, "RADAR_CONFIG_INVALID"]);
      expect(await t.sql("SELECT version, anchors, sources FROM radar_config")).toEqual([before]);
    } finally { await t.close(); }
  });
});
