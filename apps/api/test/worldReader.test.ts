import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import { buildApp } from "../src/app.js";
import { loadPeopleDirectory } from "../src/peopleDirectory.js";
import { createPiConversationRuntime } from "../src/piConversationRuntime.js";
import { loadWorldInstance, resolveWorldEnv, resolveWorldTkEnv, WorldClient, type WorldInstance } from "../src/worldClient.js";
import {
  choosePeriodGoals, clearWorldReadCache, createWorldReader, mergeWorldGoalsIntoContext, ontologyToolResult, worldDisplayText,
  type WorldSnapshot,
} from "../src/worldReader.js";
import { createTestApp, TEST_CEO, testEnv } from "./helpers.js";
import { stubWorld, type HttpCall } from "./worldFixture.js";

// 不连真实 world-02：fetch 换成 fake world server。凭证一律是测试假值，测试临时文件里写的也是假值。
const FAKE_TOKEN = "fake-world-token-for-tests";
const DEMO = loadWorldInstance("demo");
const COMPANY_ID = DEMO.anchors!.company!;
const env = { worldApiUrl: "https://world.test", worldAgentToken: FAKE_TOKEN, worldInstance: "demo" as const };

type Head = { object_id: string; object_type: string; title: string; version: number; revision_id: string; object_version: number; domain_id: string; lifecycle: unknown; external_refs: { system: string; id: string }[]; contract_version: string };
const head = (object_id: string, object_type: string, title: string, domain_id: string, extra: Partial<Head> = {}): Head => ({
  object_id, object_type, title, version: 2, revision_id: `rev-${object_id}`, object_version: 3, domain_id,
  lifecycle: { status: "draft", display_name: "草稿", event_id: null }, external_refs: [], contract_version: "tkos.world/0.2", ...extra,
});
const component = (id: string, type: string, text: string) => ({ id, type, text });
function view(h: Head, attributes: Record<string, unknown>, blocks: { id: string; components: ReturnType<typeof component>[] }[]) {
  return {
    object_id: h.object_id,
    business: { object_id: h.object_id, object_type: h.object_type, title: h.title, version: h.version, revision_id: h.revision_id, object_version: h.object_version,
      domain_id: h.domain_id, attributes, blocks: blocks.map((block) => ({ ...block, display_name: block.id === "target" ? "目标" : block.id })) },
    identity: { responsible: { principals: [] }, delegations: [] },
    records: { lifecycle: h.lifecycle, latest_state: null, open_issues: [] },
    protocol: { contract_version: "tkos.world/0.2" },
  };
}

/** 演示范围的最小镜像：Company、Strategy、一个战场单元（growth）及其长期目标、两个周期的本期目标，外加一个没对上本地战场的单元。 */
function fakeWorld(overrides: { companyId?: string } = {}) {
  const company = head(overrides.companyId ?? COMPANY_ID, "Company", "投资组合（演示 1）", "dom-company");
  const strategy = head("strategy-1", "Strategy", "集团总体战略", "dom-company");
  const unit = head("unit-growth", "ResponsibilityUnit", "增长（TK）", "dom-growth", { external_refs: [{ system: "tianshu", id: "battlefield:growth" }] });
  const other = head("unit-other", "ResponsibilityUnit", "未对应战场", "dom-other");
  const lto = head("lto-growth", "LongTermGoal", "TK 长期目标", "dom-growth");
  const poOct = head("po-oct", "PeriodGoal", "TK 10 月：01 灯塔", "dom-growth");
  const poSep = head("po-sep", "PeriodGoal", "9 月目标", "dom-growth");
  const poOther = head("po-other", "PeriodGoal", "别的单元", "dom-other");
  const lists: Record<string, Head[]> = { Company: [company], Strategy: [strategy], ResponsibilityUnit: [unit, other], LongTermGoal: [lto], PeriodGoal: [poOct, poSep, poOther] };
  const views: Record<string, unknown> = {
    [company.object_id]: view(company, {}, [{ id: "identity", components: [component("vision", "vision", "成为产业控股集团〔建议定义〕")] }]),
    [strategy.object_id]: view(strategy, {}, [{ id: "strategy_core", components: [component("thesis", "strategic_thesis", "布局 AIDC、TK、FDD 三个战场")] }]),
    [lto.object_id]: view(lto, { horizon: "2027 年春节前" }, [{ id: "target", components: [
      component("outcome", "outcome", "春节前完成 TK 核心业务第一次被真实证明"), component("success", "success_criterion", "真实客户使用与付费"),
    ] }]),
    [poOct.object_id]: view(poOct, { period: "2026-10" }, [{ id: "target", components: [
      component("outcome", "outcome", "TK 01 灯塔：正式启动 TKOS 部署"), component("tb", "time_boundary", "2026 年 10 月"), component("acc", "acceptance_criterion", "灯塔持续使用"),
    ] }]),
    [poSep.object_id]: view(poSep, { period: "2026-09" }, [{ id: "target", components: [component("outcome", "outcome", "九月的旧目标")] }]),
    [poOther.object_id]: view(poOther, { period: "2026-10" }, [{ id: "target", components: [component("outcome", "outcome", "不该出现")] }]),
  };
  return (call: HttpCall) => {
    // 健康检查与版本号都不带凭证：/v1/health 的正文有 ok、db，没有版本号；版本在 /openapi.json 的 info.version。旧的 /healthz 现在是 503。
    if (call.url.pathname === "/healthz") return Response.json({ error: "deprecated" }, { status: 503 });
    if (call.url.pathname === "/v1/health") return Response.json({ ok: true, db: "ok" });
    if (call.url.pathname === "/openapi.json") return Response.json({ openapi: "3.1.0", info: { title: "tkos.world", version: "0.6.3" } });
    if (call.url.pathname === "/v1/world/objects") return { items: lists[call.url.searchParams.get("type") ?? ""] ?? [], next_cursor: null };
    const id = decodeURIComponent(call.url.pathname.replace("/v1/world/objects/", ""));
    return views[id] ?? Response.json({ error: { code: "NOT_FOUND", message: "not found" } }, { status: 404 });
  };
}

/** 健康检查和 openapi 正常，对象读取一律返回给定错误（健康检查不带凭证，401 只会出现在读对象时）。 */
const objectsFail = (status: number, body: unknown) => (call: HttpCall) =>
  call.url.pathname === "/v1/health" || call.url.pathname === "/openapi.json" ? fakeWorld()(call) : Response.json(body, { status });

beforeEach(() => clearWorldReadCache());
afterEach(() => vi.unstubAllGlobals());

describe("world 配置切换与凭证文件", () => {
  it("缺省 mvp 原配置不变；TKOS_WORLD_INSTANCE=demo 切到演示范围（只读不写）；本地文件只合并 people", async () => {
    const mvp = loadWorldInstance();
    expect(mvp.scope_id).toBe("a92430fd-e1fc-4a42-8a04-bc2faa0a34cc");
    expect(mvp.reads).toBeUndefined();
    expect(mvp.writes).toBeUndefined();
    expect(DEMO.scope_id).toBe("8c18bcbb-f60c-4472-b336-778bf4780a75");
    expect(DEMO.domains).toMatchObject({ company: "df06952f-a49c-4a40-9672-48e8a0dd3075", eo: "3114d7d7-f9ad-4695-a7d8-0652d3c64c9a" });
    expect(Object.keys(DEMO.domains).sort()).toEqual(["aidc", "ciyuan", "company", "eo", "fangdongdong"]);
    expect(DEMO.principals!["demo-tianshu"]).toBe("553069bc-19bb-4183-a542-a0b1490e44e9");
    expect(DEMO).toMatchObject({ reads: true, writes: false, people: {} });
    expect(resolveWorldEnv({}).worldInstance).toBe("mvp");
    expect(resolveWorldEnv({}, { instance: "demo" }).worldInstance).toBe("demo");
    expect(resolveWorldEnv({ TKOS_WORLD_INSTANCE: "demo" }).worldInstance).toBe("demo");
    expect(() => resolveWorldEnv({ TKOS_WORLD_INSTANCE: "prod" })).toThrow(/TKOS_WORLD_INSTANCE/);
    const dir = await mkdtemp(join(tmpdir(), "world-instance-"));
    try {
      const local = join(dir, "local.json");
      await writeFile(local, JSON.stringify({ people: { "person-a": "principal-a" }, scope_id: "must-not-override", writes: true }));
      const merged = loadWorldInstance("demo", local);
      expect(merged.people).toEqual({ "person-a": "principal-a" });
      expect(merged.scope_id).toBe(DEMO.scope_id);
      expect(merged.writes).toBe(false);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("凭证文件：读文件并 trim、只在内存；直给的变量优先；读不到或为空给错误码，不含文件内容", async () => {
    const dir = await mkdtemp(join(tmpdir(), "world-token-"));
    try {
      const file = join(dir, "agent.token");
      await writeFile(file, `  ${FAKE_TOKEN}\r\n`);
      expect(resolveWorldEnv({ TKOS_WORLD_API_URL: " https://world.test ", TKOS_WORLD_AGENT_TOKEN_FILE: file })).toMatchObject({ worldApiUrl: "https://world.test", worldAgentToken: FAKE_TOKEN });
      expect(resolveWorldEnv({ TKOS_WORLD_AGENT_TOKEN: "direct-fake", TKOS_WORLD_AGENT_TOKEN_FILE: file }).worldAgentToken).toBe("direct-fake");
      const missing = resolveWorldEnv({ TKOS_WORLD_AGENT_TOKEN_FILE: join(dir, "nope.token") });
      expect(missing.worldAgentToken).toBeUndefined();
      expect(missing.worldTokenError).toBe("WORLD_TOKEN_FILE_UNREADABLE:ENOENT");
      const empty = join(dir, "empty.token");
      await writeFile(empty, " \n");
      expect(resolveWorldEnv({ TKOS_WORLD_AGENT_TOKEN_FILE: empty }).worldTokenError).toBe("WORLD_TOKEN_FILE_EMPTY");
      const status = createWorldReader({ q: async () => ({ rows: [] }) as never, env: missing }).status();
      expect(status).toMatchObject({ configured: false, state: "not_configured", errorCode: "WORLD_TOKEN_FILE_UNREADABLE:ENOENT" });
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});

describe("正式实例与 TK 只读实例", () => {
  const FORMAL = loadWorldInstance("formal");
  const TK = loadWorldInstance("tk");
  const TK_TOKEN = "fake-tk-reader-token-for-tests";
  const tkEnv = { worldApiUrl: "https://world.test", worldAgentToken: TK_TOKEN, worldInstance: "tk" as const };
  const noDb = async () => { throw new Error("不该连数据库"); };

  it("formal / tk 配置：scope、分区、主体、锚点；都不写，tk 写死只读", () => {
    expect(FORMAL).toMatchObject({ scope_id: "1fb8bdf8-ea7b-4a98-b691-f2d09ee6687f", tenant_id: "tokenking-world-02-group", reads: true, writes: false, people: {} });
    expect(Object.keys(FORMAL.domains).sort()).toEqual(["aidc", "ciyuan", "company", "fangdongdong"]);
    expect(FORMAL.principals).toMatchObject({ "group-ceo": "aeb9cd26-95b1-41ea-b741-5ccebba0b227", tianshu: "be1b7c23-bb7b-4cd7-8584-612f1ea34ace" });
    expect(TK).toMatchObject({ scope_id: "a92430fd-e1fc-4a42-8a04-bc2faa0a34cc", reads: true, writes: false, people: {} });
    expect(TK.domains.reader).toBe("392a2f73-f1d1-4ec0-a6d7-9963976f56c8");
    expect(TK.principals!["tianshu-reader"]).toBe("6d11f6fc-ee9d-43b1-872b-284cb0a318ab");
    expect(TK.anchors).toMatchObject({ company: "0ee4d398-0283-4e08-9f9f-c0244802c806", strategy: "0057ae2d-1439-4326-9587-258ee8988577" });
    // 本体团队换成同一 scope 的配置也改不了只读：tk 的 writes 在加载时强制为 false
    expect(new WorldClient(noDb as never, tkEnv, { ...TK, writes: true }).readOnly).toBe(true);
    expect(new WorldClient(noDb as never, { ...tkEnv, worldInstance: "formal" }, FORMAL).readOnly).toBe(false);
  });

  it("tk 实例的 write 一律拒绝：不发请求、不碰台账", async () => {
    const calls = stubWorld(() => ({}));
    const client = new WorldClient(noDb as never, tkEnv);
    await expect(client.write("tianshu:test:0123456789", async () => { throw new Error("不该构造请求"); })).rejects.toMatchObject({ status: 403, code: "WORLD_READ_ONLY" });
    expect(calls).toHaveLength(0);
  });

  it("identity：GET /v1/identity，带凭证、不带正文", async () => {
    const calls = stubWorld(() => ({ scope_id: TK.scope_id, tenant_id: "t", company_id: "c", principal_id: "p", principal_type: "agent", display_name: "读", auth_epoch: 1, assignments: [] }));
    const identity = await new WorldClient(noDb as never, tkEnv).identity();
    expect(identity.scope_id).toBe(TK.scope_id);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method: "GET", body: undefined });
    expect(calls[0].url.pathname).toBe("/v1/identity");
    expect(calls[0].headers.get("authorization")).toBe(`Bearer ${TK_TOKEN}`);
  });

  it("resolveWorldTkEnv：不设就关闭；只接受 tk；凭证只从 TKOS_WORLD_TK_TOKEN_FILE 读，不回退主实例凭证；地址缺省沿用主实例", async () => {
    expect(resolveWorldTkEnv({})).toBeUndefined();
    expect(resolveWorldTkEnv({ TKOS_WORLD_TK_INSTANCE: " " })).toBeUndefined();
    expect(() => resolveWorldTkEnv({ TKOS_WORLD_TK_INSTANCE: "formal" })).toThrow(/TKOS_WORLD_TK_INSTANCE/);
    expect(() => resolveWorldTkEnv({ TKOS_WORLD_TK_INSTANCE: "prod" })).toThrow(/TKOS_WORLD_INSTANCE/);
    const dir = await mkdtemp(join(tmpdir(), "world-tk-"));
    try {
      const file = join(dir, "reader.token");
      await writeFile(file, ` ${TK_TOKEN}
`);
      const main = { TKOS_WORLD_API_URL: "https://world.test", TKOS_WORLD_AGENT_TOKEN: "main-fake", TKOS_WORLD_AGENT_TOKEN_FILE: join(dir, "main.token") };
      expect(resolveWorldTkEnv({ ...main, TKOS_WORLD_TK_INSTANCE: "tk", TKOS_WORLD_TK_TOKEN_FILE: file }))
        .toEqual({ worldApiUrl: "https://world.test", worldInstance: "tk", worldAgentToken: TK_TOKEN });
      expect(resolveWorldTkEnv({ ...main, TKOS_WORLD_TK_INSTANCE: "tk", TKOS_WORLD_TK_API_URL: "https://tk.test", TKOS_WORLD_TK_TOKEN_FILE: file })!.worldApiUrl).toBe("https://tk.test");
      const noToken = resolveWorldTkEnv({ ...main, TKOS_WORLD_TK_INSTANCE: "tk" })!;
      expect(noToken.worldAgentToken).toBeUndefined();
      expect(resolveWorldTkEnv({ TKOS_WORLD_TK_INSTANCE: "tk", TKOS_WORLD_TK_TOKEN_FILE: join(dir, "nope.token") })!.worldTokenError).toBe("WORLD_TOKEN_FILE_UNREADABLE:ENOENT");
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("app：配了 TK 实例时健康接口多一项 worldTk（不含凭证），两实例串行探测、只发 GET；不配时没有这一项", async () => {
    const t = await createTestApp();
    const mainWorld = fakeWorld();
    const tkWorld = fakeWorld({ companyId: TK.anchors!.company });
    const calls = stubWorld((call) => (call.headers.get("authorization") === `Bearer ${TK_TOKEN}` ? tkWorld(call) : mainWorld(call)));
    const runtime = { async run() { return { assistantMessage: "test", runtimeEntries: [] }; } };
    const app = await buildApp({ pool: t.pool, env: { ...t.env, ...env, worldTk: tkEnv }, conversationRuntime: runtime });
    try {
      await app.ready();
      await vi.waitFor(async () => {
        const health = (await app.inject({ url: "/api/healthz" })).json();
        expect(health.world.state).toBe("connected");
        expect(health.worldTk).toMatchObject({ configured: true, instance: "tk", scopeId: TK.scope_id, reads: true, writes: false, state: "connected" });
      });
      const health = (await app.inject({ url: "/api/healthz" })).json();
      expect(JSON.stringify(health)).not.toContain(TK_TOKEN);
      expect(calls.every((call) => call.method === "GET" && call.body === undefined)).toBe(true);
      expect(calls.some((call) => call.url.pathname.endsWith("/context"))).toBe(false);
      const isTk = (call: HttpCall) => call.headers.get("authorization") === `Bearer ${TK_TOKEN}`;
      const isMainRead = (call: HttpCall) => call.headers.get("authorization") === `Bearer ${FAKE_TOKEN}`;
      const lastMainRead = calls.map((call, index) => (isMainRead(call) ? index : -1)).reduce((max, index) => Math.max(max, index), -1);
      expect(lastMainRead).toBeGreaterThan(-1);
      expect(calls.findIndex(isTk)).toBeGreaterThan(lastMainRead);
    } finally { await app.close(); }
    const plain = await buildApp({ pool: t.pool, env: { ...t.env, ...env }, conversationRuntime: runtime });
    try {
      await plain.ready();
      expect((await plain.inject({ url: "/api/healthz" })).json()).not.toHaveProperty("worldTk");
    } finally { await plain.close(); await t.close(); }
  }, 30_000);
});

describe("world 只读：健康检查、快照、缓存与回退", () => {
  const q = async () => ({ rows: [] }) as never;

  it("健康检查用只读调用验证连通：connected、计数、契约与服务端版本；状态里没有凭证和地址；只发 GET", async () => {
    const calls = stubWorld(fakeWorld());
    const reader = createWorldReader({ q, env });
    const status = await reader.check();
    expect(status).toMatchObject({
      configured: true, instance: "demo", scopeId: DEMO.scope_id, reads: true, writes: false, state: "connected",
      contractVersion: "tkos.world/0.2", serverVersion: "0.6.3", errorCode: null, httpStatus: 200,
      objects: { company: 1, strategy: 1, units: 2, longTermGoals: 1, periodGoals: 3 },
    });
    expect(JSON.stringify(status)).not.toContain(FAKE_TOKEN);
    expect(JSON.stringify(status)).not.toContain("world.test");
    expect(calls.every((call) => call.method === "GET")).toBe(true);
    const open = ["/v1/health", "/openapi.json"];
    expect(calls.filter((call) => !open.includes(call.url.pathname)).every((call) => call.headers.get("authorization") === `Bearer ${FAKE_TOKEN}`)).toBe(true);
    for (const path of open) expect(calls.find((call) => call.url.pathname === path)!.headers.get("authorization")).toBeNull();
    expect(calls.some((call) => call.url.pathname === "/healthz")).toBe(false);
    const snapshot = (await reader.snapshot())!;
    expect(snapshot.company).toMatchObject({ objectId: COMPANY_ID, ref: `${COMPANY_ID}@2`, lifecycle: "草稿" });
    expect(snapshot.strategy!.components[0].text).toBe("布局 AIDC、词元云集、房懂懂 三个战场");
    expect(snapshot.units).toHaveLength(1);
    const growth = snapshot.units[0];
    expect(growth).toMatchObject({ battlefieldId: "growth", unit: { title: "增长（词元云集）" } });
    expect(growth.lto).toMatchObject({ ref: "lto-growth@2", horizon: "2027 年春节前", outcome: "春节前完成 词元云集 核心业务第一次被真实证明", successCriteria: "真实客户使用与付费" });
    expect(growth.periodGoals.map((goal) => goal.objectId).sort()).toEqual(["po-oct", "po-sep"]);
  });

  it("请求路径与顺序：先 /v1/health，再列对象、逐个读对象，最后 /openapi.json；全程串行（任一时刻最多 1 个在途请求）；不碰 /healthz 和 /context", async () => {
    const handler = fakeWorld();
    let active = 0;
    let maxActive = 0;
    const calls = stubWorld(async (call) => {
      active++; maxActive = Math.max(maxActive, active);
      try { await new Promise((resolve) => setTimeout(resolve, 5)); return handler(call); } finally { active--; }
    });
    const reader = createWorldReader({ q, env });
    const status = await reader.check();
    expect(status).toMatchObject({ state: "connected", serverVersion: "0.6.3" });
    expect(maxActive).toBe(1);
    const trail = calls.map((call) => `${call.method} ${call.url.pathname}${call.url.searchParams.get("type") ? `?type=${call.url.searchParams.get("type")}` : ""}`);
    expect(trail).toEqual([
      "GET /v1/health",
      "GET /v1/world/objects?type=Company", "GET /v1/world/objects?type=Strategy", "GET /v1/world/objects?type=ResponsibilityUnit",
      "GET /v1/world/objects?type=LongTermGoal", "GET /v1/world/objects?type=PeriodGoal",
      `GET /v1/world/objects/${COMPANY_ID}`, "GET /v1/world/objects/strategy-1",
      "GET /v1/world/objects/lto-growth", "GET /v1/world/objects/po-oct", "GET /v1/world/objects/po-sep",
      "GET /openapi.json",
    ]);
    expect(calls.some((call) => call.url.pathname === "/healthz" || call.url.pathname.endsWith("/context") || call.method !== "GET")).toBe(false);
  });

  it("/v1/health 非 200（或 ok:false）：状态为 error / WORLD_UNHEALTHY，带 HTTP 状态，不再去读对象", async () => {
    const calls = stubWorld((call) => call.url.pathname === "/v1/health" ? Response.json({ ok: false, db: "down" }, { status: 503 }) : fakeWorld()(call));
    const reader = createWorldReader({ q, env });
    expect(await reader.check()).toMatchObject({ state: "error", errorCode: "WORLD_UNHEALTHY", httpStatus: 503, serverVersion: null });
    expect(calls.map((call) => call.url.pathname)).toEqual(["/v1/health"]);
    clearWorldReadCache();
    stubWorld((call) => call.url.pathname === "/v1/health" ? Response.json({ ok: false }) : fakeWorld()(call));
    expect(await createWorldReader({ q, env }).check()).toMatchObject({ state: "error", errorCode: "WORLD_UNHEALTHY", httpStatus: 200 });
  });

  it("openapi.json 读不到或没有 info.version：serverVersion 为 null，但读取照常 connected", async () => {
    for (const openapi of [() => Response.json({}, { status: 404 }), () => Response.json({ info: {} }), () => new Response("not json")]) {
      clearWorldReadCache();
      stubWorld((call) => call.url.pathname === "/openapi.json" ? openapi() : fakeWorld()(call));
      expect(await createWorldReader({ q, env }).check()).toMatchObject({ state: "connected", serverVersion: null, httpStatus: 200 });
    }
  });

  it("缓存 5 分钟：期内不再请求；过期后重读；单飞：并发只读一次", async () => {
    let t = 1_000_000;
    const calls = stubWorld(fakeWorld());
    const reader = createWorldReader({ q, env, clock: () => t });
    const [a, b] = await Promise.all([reader.snapshot(), reader.snapshot()]);
    expect(a).toBe(b);
    const first = calls.length;
    t += 4 * 60_000;
    await reader.snapshot();
    expect(calls.length).toBe(first);
    t += 2 * 60_000;
    await reader.snapshot();
    // 重读时版本号（/openapi.json，300KB、约 2 秒）1 小时内不再取
    expect(calls.length).toBe(first * 2 - 1);
    expect(calls.filter((call) => call.url.pathname === "/openapi.json")).toHaveLength(1);
    // 同一实例共用缓存：另一个场次 app 的 reader 直接拿到
    const another = createWorldReader({ q, env, clock: () => t });
    await another.snapshot();
    expect(calls.length).toBe(first * 2 - 1);
  });

  it("版本号缓存 1 小时：5 分钟重读对象时不再取 /openapi.json，满 1 小时才重取", async () => {
    let t = 1_000_000;
    const calls = stubWorld(fakeWorld());
    const reader = createWorldReader({ q, env, clock: () => t });
    const versions = () => calls.filter((call) => call.url.pathname === "/openapi.json").length;
    await reader.snapshot();
    expect(versions()).toBe(1);
    for (let i = 0; i < 5; i++) { t += 6 * 60_000; await reader.snapshot(); }
    expect(versions()).toBe(1);
    expect(reader.status().serverVersion).toBe("0.6.3");
    t += 31 * 60_000;
    await reader.snapshot();
    expect(versions()).toBe(2);
  });

  it("读失败：沿用上一份成功结果；1 分钟内不重试；没有成功结果时为 null（调用方回退本地）", async () => {
    let t = 1_000_000;
    stubWorld(fakeWorld());
    const reader = createWorldReader({ q, env, clock: () => t });
    const good = await reader.snapshot();
    t += 6 * 60_000;
    const calls = stubWorld(objectsFail(500, { error: { code: "INTERNAL", message: "boom" } }));
    expect(await reader.snapshot()).toBe(good);
    expect(reader.status()).toMatchObject({ state: "error", errorCode: "INTERNAL", httpStatus: 500 });
    const failed = calls.length;
    t += 30_000;
    expect(await reader.snapshot()).toBe(good);
    expect(calls.length).toBe(failed);
    clearWorldReadCache();
    const fresh = createWorldReader({ q, env, clock: () => t });
    stubWorld(() => { throw new TypeError("fetch failed: connect ECONNREFUSED"); });
    expect(await fresh.snapshot()).toBeNull();
    expect(fresh.status()).toMatchObject({ state: "error", errorCode: "NETWORK_ERROR" });
  });

  it("401：报告错误码与状态，不重试别的凭证，消息里不带凭证", async () => {
    const calls = stubWorld(objectsFail(401, { error: { code: "UNAUTHENTICATED", message: `bad token ${FAKE_TOKEN}` } }));
    const reader = createWorldReader({ q, env });
    const status = await reader.check();
    expect(status).toMatchObject({ state: "error", errorCode: "UNAUTHENTICATED", httpStatus: 401 });
    expect(await reader.snapshot()).toBeNull();
    expect(JSON.stringify(status)).not.toContain(FAKE_TOKEN);
    expect(new Set(calls.map((call) => call.headers.get("authorization")).filter(Boolean))).toEqual(new Set([`Bearer ${FAKE_TOKEN}`]));
  });

  it("超时预算：本体慢时最多等 budget，先回退（null），读完后下次用新结果", async () => {
    const handler = fakeWorld();
    stubWorld(async (call) => { await new Promise((resolve) => setTimeout(resolve, 80)); return handler(call); });
    const reader = createWorldReader({ q, env });
    expect(await reader.snapshot(10)).toBeNull();
    await reader.check();
    expect((await reader.snapshot(10))?.units).toHaveLength(1);
  });

  it("范围核对：读回的 Company 不是实例配置里的那一个时不用这份数据（SCOPE_MISMATCH）", async () => {
    stubWorld(fakeWorld({ companyId: "someone-elses-company" }));
    const reader = createWorldReader({ q, env });
    expect(await reader.check()).toMatchObject({ state: "error", errorCode: "SCOPE_MISMATCH" });
    expect(await reader.snapshot()).toBeNull();
  });

  it("MVP 实例（reads 未开）只做健康检查，不给快照；未配置的 reader 不发请求", async () => {
    const calls = stubWorld(fakeWorld());
    const mvp: WorldInstance = { ...loadWorldInstance(), anchors: undefined };
    const reader = createWorldReader({ q, env: { ...env, worldInstance: "mvp" }, config: mvp });
    expect(reader.enabled).toBe(false);
    expect(await reader.snapshot()).toBeNull();
    expect((await reader.check()).state).toBe("connected");
    const before = calls.length;
    const off = createWorldReader({ q, env: {} });
    expect(await off.check()).toMatchObject({ configured: false, state: "not_configured" });
    expect(calls.length).toBe(before);
  });
});

describe("本体目标：本期选择、按需工具与上下文包", () => {
  const snapshot: WorldSnapshot = {
    fetchedAt: "2026-10-13T08:00:00.000Z", company: null, strategy: null,
    units: [{
      battlefieldId: "growth", unit: { objectId: "u", ref: "u@1", title: "增长", domainId: "d" },
      lto: { objectId: "l", ref: "l@2", title: "长期", version: 2, lifecycle: "草稿", period: null, horizon: "春节前", outcome: "本体长期目标", successCriteria: "本体成功标准", acceptance: null, timeBoundary: null, realizationLogic: null },
      periodGoals: [
        { objectId: "p1", ref: "p1@1", title: "01 灯塔", version: 1, lifecycle: "草稿", period: "2026-10", horizon: null, outcome: "本体本期一", successCriteria: null, acceptance: "验收一", timeBoundary: "2026 年 10 月", realizationLogic: null },
        { objectId: "p2", ref: "p2@1", title: "02 运营", version: 1, lifecycle: "草稿", period: "2026-10", horizon: null, outcome: "本体本期二", successCriteria: null, acceptance: null, timeBoundary: null, realizationLogic: null },
        { objectId: "p0", ref: "p0@1", title: "9 月", version: 1, lifecycle: "草稿", period: "2026-09", horizon: null, outcome: "九月", successCriteria: null, acceptance: null, timeBoundary: null, realizationLogic: null },
      ],
    }],
  };

  it("本期目标取当前公司月，没有当前月时取最近一个周期", () => {
    const goals = snapshot.units[0].periodGoals;
    expect(choosePeriodGoals(goals, "2026-10").map((goal) => goal.objectId)).toEqual(["p1", "p2"]);
    expect(choosePeriodGoals(goals, "2026-11").map((goal) => goal.objectId)).toEqual(["p1", "p2"]);
    expect(choosePeriodGoals(goals.slice(2), "2026-11").map((goal) => goal.objectId)).toEqual(["p0"]);
  });

  it("按需工具的结果：带引用和说明、按 part / 战场筛选、超长时截短；每轮上下文包只换长期目标正文、不加本体一节", () => {
    const long = "很长".repeat(400);
    const company = { objectId: "c", ref: "c@1", title: "投资组合", version: 1, lifecycle: null, components: [{ block: "身份", type: "vision", text: long }] };
    const full = ontologyToolResult({ ...snapshot, company }, "2026-10");
    expect(full).toMatchObject({ source: "本体", company: { ref: "c@1" }, strategy: null });
    expect((full.company as { content: string[] }).content[0]).toBe(`身份 · vision：${long.slice(0, 400)}…`);
    expect(String(full.note)).toContain("以本体为准");
    const battlefields = full.battlefields as Record<string, any>[];
    expect(battlefields[0]).toMatchObject({ battlefieldId: "growth", longTermGoal: { ref: "l@2", lifecycle: "草稿", outcome: "本体长期目标", horizon: "春节前" } });
    expect(battlefields[0].periodGoals.map((goal: { ref: string }) => goal.ref)).toEqual(["p1@1", "p2@1"]);
    const onlyCompany = ontologyToolResult({ ...snapshot, company }, "2026-10", { part: "company" });
    expect(Object.keys(onlyCompany)).not.toContain("battlefields");
    expect((ontologyToolResult(snapshot, "2026-10", { battlefieldId: "nope" }).battlefields as unknown[])).toEqual([]);
    const many = { ...company, components: Array.from({ length: 24 }, () => ({ block: "身份", type: "vision", text: long })) };
    const cut = ontologyToolResult({ ...snapshot, company: many, strategy: many }, "2026-10");
    expect(cut.truncated).toBe(true);
    expect(JSON.stringify(cut).length).toBeLessThan(15_000);
    const context = { period: "2026-10", battlefields: [{ id: "growth", sixMonthOutcome: "本地" }, { id: "other", sixMonthOutcome: "本地二" }] };
    const merged = mergeWorldGoalsIntoContext(context, snapshot) as Record<string, any>;
    expect(merged.battlefields).toEqual([{ id: "growth", sixMonthOutcome: "本体长期目标", goalSource: "本体" }, { id: "other", sixMonthOutcome: "本地二" }]);
    expect(merged.ontology).toBeUndefined();
    expect(worldDisplayText("TK、FDD 与 TKOS、TokenOps")).toBe("词元云集、房懂懂 与 TKOS、TokenOps");
    expect(worldDisplayText("词元云集（TK）、房懂懂（FDD）")).toBe("词元云集、房懂懂");
  });
});

describe("接入 app：健康接口与回退", () => {
  it("/api/healthz 报告 world 状态（不含凭证）；本体出错时报告错误码与状态，页面不报错", async () => {
    const t = await createTestApp();
    stubWorld(fakeWorld());
    const runtime = { async run() { return { assistantMessage: "test", runtimeEntries: [] }; } };
    const app = await buildApp({ pool: t.pool, env: { ...t.env, ...env }, conversationRuntime: runtime });
    try {
      await app.ready();
      const health = (await app.inject({ url: "/api/healthz" })).json();
      expect(health.world).toMatchObject({ configured: true, instance: "demo", reads: true, writes: false });
      expect(JSON.stringify(health)).not.toContain(FAKE_TOKEN);
      await vi.waitFor(async () => expect((await app.inject({ url: "/api/healthz" })).json().world.state).toBe("connected"));
      const login = await app.inject({ method: "POST", url: "/api/auth/login", headers: { origin: t.publicOrigin }, payload: { loginId: TEST_CEO.loginId, passcode: TEST_CEO.passcode } });
      const cookie = String(login.headers["set-cookie"]).split(";")[0];
      // 本体出错且没有缓存：首页照常
      clearWorldReadCache();
      const failing = await buildApp({ pool: t.pool, env: { ...t.env, ...env }, conversationRuntime: runtime });
      try {
        stubWorld(objectsFail(401, { error: { code: "UNAUTHENTICATED", message: "no" } }));
        await failing.ready();
        expect((await failing.inject({ url: "/api/cards/home", headers: { cookie } })).statusCode).toBe(200);
        await vi.waitFor(async () => expect((await failing.inject({ url: "/api/healthz" })).json().world).toMatchObject({ state: "error", errorCode: "UNAUTHENTICATED", httpStatus: 401 }));
      } finally { await failing.close(); }
    } finally {
      await app.close();
      await t.close();
    }
  }, 30_000);
});

describe("对话：按需工具 read_ontology（不进每轮上下文包）", () => {
  const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  const message = (content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"]): AssistantMessage =>
    ({ role: "assistant", api: "openai-responses", provider: "warmap", model: "fake-light", content, usage, stopReason, timestamp: Date.now() });
  function stream(final: AssistantMessage) {
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

  it("一号位能调用、拿到本体结果；成员看不到这个工具；上下文包里没有本体一节", async () => {
    const tools: string[][] = [];
    const prompts: string[] = [];
    const queries: unknown[] = [];
    let calls = 0;
    const runtime = await createPiConversationRuntime({ peopleDirectory: loadPeopleDirectory(testEnv),
      baseUrl: "https://provider.invalid/v1/responses", apiKey: "test-key", modelId: "fake-light",
      globalContext: async () => ({ period: "2026-10", battlefields: [] }),
      readOntology: async (query) => { queries.push(query); return { source: "本体", company: { title: "投资组合", ref: "c@1" } }; },
      streamSimple: (_model, context) => {
        calls++;
        tools.push(context.tools?.map((tool) => tool.name) ?? []);
        prompts.push(JSON.stringify(context.messages.at(-1)));
        if (calls === 1) return stream(message([{ type: "toolCall", id: "onto", name: "read_ontology", arguments: { part: "company" } }], "toolUse"));
        return stream(message([{ type: "text", text: "本体里登记的是投资组合" }], "stop"));
      } });
    const turn = (viewer: { personId: string; displayName: string; role: "ceo" | "member" }) => ({ scope: "global", viewer, message: "公司在本体里怎么登记的", currentObject: null,
      referencesSnapshot: [], runtimeEntries: [], piSessionId: randomUUID(), signal: new AbortController().signal, emit: () => undefined });
    try {
      const result = await runtime.run(turn({ personId: "person-fixture-001", displayName: "测试甲", role: "ceo" }));
      expect(result.assistantMessage).toBe("本体里登记的是投资组合");
      expect(tools[0]).toContain("read_ontology");
      expect(queries).toEqual([{ part: "company" }]);
      expect(prompts[0]).not.toContain("ontology");
      expect(prompts[1]).toContain("c@1");
      await runtime.run(turn({ personId: "person-fixture-002", displayName: "测试乙", role: "member" }));
      expect(tools.at(-1)).not.toContain("read_ontology");
    } finally { await runtime.close?.(); }
  }, 20_000);
});
