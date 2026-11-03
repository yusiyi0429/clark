import { mkdtemp, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import type { TCollectionView, TConversationCard, TRequestListItem, TScheduleItem } from "@warmap/contracts";
import { hashSecret } from "../src/session.js";
import type { CollectionAgent } from "../src/collectionAgent.js";
import { createConversationEntries, type EntryStep } from "../src/conversationEntries.js";
import { cellText, createFeishuBitable, createMockBitable } from "../src/feishu/bitable.js";
import type { RequestAgent } from "../src/delivery/requestAgent.js";
import { loadPeopleDirectory } from "../src/peopleDirectory.js";
import { createPiConversationRuntime } from "../src/piConversationRuntime.js";
import { createTestApp, TEST_CEO, TEST_MEMBER, testEnv, type TestApp } from "./helpers.js";

// ③ 信息收集：发起人测试甲（CEO），收件人测试乙、测试丙；测试丁不在名单里。
const THIRD = { personId: "person-fixture-003", loginId: "ceshib", passcode: "8642" } as const;
const FOURTH = { personId: "person-fixture-004", loginId: "ceshid", passcode: "9753" } as const;
const MONDAY_10 = new Date("2026-10-19T02:00:00Z"); // 上海时间 10/19 周一 10:00
const FRIDAY_18 = new Date("2026-10-23T10:00:00Z");
const HOUR = 3_600_000;

/** 假 Agent：「开销」→ expense，「进展」→ method_progress，其余不支持；点名乙和丙；原话有「每周」就每周固定。 */
const agent: CollectionAgent = {
  async draft(input) {
    const scenario = input.prompt.includes("开销") ? "expense" : input.prompt.includes("进展") ? "method_progress" : "unsupported";
    return { scenario, title: scenario === "expense" ? "灯塔项目每周开销" : "方法部周进展", recipientIds: [TEST_MEMBER.personId, THIRD.personId, "person-not-in-directory"],
      deadline: input.prompt.includes("周四") ? "2026-10-22 18:00" : null, weekly: input.prompt.includes("每周") };
  },
};

let t: TestApp | undefined;
afterEach(async () => { await t?.close(); t = undefined; });

async function setup(collectionsEnabled = true) {
  const dir = await mkdtemp(join(tmpdir(), "warmap-collections-test-"));
  const seed = join(dir, "people.json");
  await writeFile(seed, JSON.stringify({ schemaVersion: "company-people.v1", people: [
    { personId: TEST_CEO.personId, displayName: "测试甲", roles: ["ceo"] },
    { personId: TEST_MEMBER.personId, displayName: "测试乙", roles: ["dri", "participant"] },
    { personId: THIRD.personId, displayName: "测试丙", roles: ["dri", "participant"] },
    { personId: FOURTH.personId, displayName: "测试丁", roles: ["dri", "participant"] },
  ] }));
  const clock = { now: MONDAY_10 };
  const bitable = createMockBitable();
  t = await createTestApp({ companyPeopleSeed: seed, collectionsEnabled }, undefined, { collectionAgent: agent, bitable, monthlyNow: () => clock.now });
  for (const who of [THIRD, FOURTH]) {
    await t.sql("INSERT INTO member_access (person_id, login_id, passcode_hash, must_change) VALUES ($1, $2, $3, FALSE)", [who.personId, who.loginId, hashSecret(who.passcode)]);
  }
  const app = t.app, origin = t.publicOrigin;
  const login = async (who: { loginId: string; passcode: string }) => {
    const res = await app.inject({ method: "POST", url: "/api/auth/login", headers: { origin }, payload: { loginId: who.loginId, passcode: who.passcode } });
    expect(res.statusCode).toBe(200);
    return (res.headers["set-cookie"] as string).split(";")[0];
  };
  const cookies = { ceo: await t.loginCookie(), b: await t.memberCookie(), c: await login(THIRD), d: await login(FOURTH) };
  type Who = keyof typeof cookies;
  const call = (who: Who, method: "GET" | "POST", url: string, payload?: unknown) =>
    app.inject({ method, url, headers: { cookie: cookies[who], origin }, ...(payload === undefined ? {} : { payload: payload as object }) });
  const round = async (who: Who, requestId: string) => {
    const res = await call(who, "GET", `/api/requests/${requestId}/collection`);
    expect(res.statusCode, res.body).toBe(200);
    return (res.json() as { collection: TCollectionView }).collection;
  };
  const act = (who: Who, view: TCollectionView, actionType: string, input?: unknown) => {
    const action = view.actions.find((candidate) => candidate.actionType === actionType);
    expect(action, `${who} 应能 ${actionType}`).toBeDefined();
    return call(who, "POST", "/api/collections/actions/execute", { actionId: action!.actionId, ...(input === undefined ? {} : { input }) });
  };
  const draft = async (prompt: string) => {
    const res = await call("ceo", "POST", "/api/collections/draft", { prompt });
    expect(res.statusCode, res.body).toBe(200);
    return res.json() as { collection: TCollectionView; steps: { label: string; status: string; result: string | null }[] };
  };
  /** 起草并发给乙和丙，返回第一轮（发起人看到的汇总）。 */
  const launch = async (prompt: string, input: Partial<{ recipientIds: string[]; deadlineAt: string; weekly: boolean }> = {}) => {
    const { collection } = await draft(prompt);
    const sent = await act("ceo", collection, "collection.send", { recipientIds: [TEST_MEMBER.personId, THIRD.personId], deadlineAt: collection.deadlineAt, weekly: collection.weekly, ...input });
    expect(sent.statusCode, sent.body).toBe(200);
    return (sent.json() as { collection: TCollectionView }).collection;
  };
  const notifications = async (who: Who) =>
    ((await call(who, "GET", "/api/me/notifications")).json() as { notifications: { kind: string; objectId: string; text: string }[] }).notifications;
  const tick = () => app.collectionJobs.handlers["collection.tick"]({}, { id: "1", kind: "collection.tick", dedupe_key: randomUUID(), attempts: 1, payload: {} });
  return { call, round, act, draft, launch, notifications, tick, clock, bitable, sql: t.sql };
}

describe("③ 信息收集", () => {
  it("起草：判断场景、按场景固定的栏、去掉不在名单里的人；没说截止就是本周五 18:00；不支持的场景如实拒绝", async () => {
    const { draft, call } = await setup();
    const { collection, steps } = await draft("每周五下班前收一下大家这周在灯塔项目上的开销");
    expect(steps.map((step) => [step.label, step.status, step.result])).toEqual([
      ["判断场景", "done", "每周开销"], ["起草收集表", "done", "5 栏 · 2 人"], ["等你确认", "current", null]]);
    expect(collection).toMatchObject({ status: "draft", scenario: "expense", title: "灯塔项目每周开销", weekly: true, round: null, deadlineAt: FRIDAY_18.toISOString() });
    expect(collection.fields.filter((field) => field.required).map((field) => field.label)).toEqual(["本周开销（元）", "用途", "对应项目", "票据"]);
    expect(collection.candidates.map((person) => person.displayName)).toEqual(["测试乙", "测试丙"]);
    expect(collection.directory.map((person) => person.personId)).not.toContain(TEST_CEO.personId);

    const unsupported = await call("ceo", "POST", "/api/collections/draft", { prompt: "收一下大家对体验构想的反馈" });
    expect(unsupported.statusCode).toBe(422);
    expect(unsupported.json()).toMatchObject({ code: "COLLECTION_SCENARIO_UNSUPPORTED" });

    // 草稿只有发起人看得到。
    expect((await call("b", "GET", `/api/collections/${collection.id}`)).statusCode).toBe(404);
  });

  it("发出的就是预览那一版；接收人只看到自己那一行，发起人看到汇总；收到的通知和列表里有「已填」", async () => {
    const { draft, act, call, round, notifications } = await setup();
    const v1 = (await draft("收一下这周的开销，周四截止")).collection;
    expect(v1.deadlineAt).toBe(new Date("2026-10-22T10:00:00Z").toISOString());
    const v2 = (await call("ceo", "POST", "/api/collections/draft", { prompt: "每周收一下这周的开销", collectionId: v1.id })).json() as { collection: TCollectionView };
    expect(v2.collection).toMatchObject({ id: v1.id, version: 2, weekly: true });
    const stale = await act("ceo", v1, "collection.send", { recipientIds: [TEST_MEMBER.personId], deadlineAt: v1.deadlineAt, weekly: false });
    expect(stale.statusCode).toBe(409);
    expect((await act("ceo", v2.collection, "collection.send", { recipientIds: [FOURTH.personId, "person-not-in-directory"], deadlineAt: v1.deadlineAt, weekly: false })).statusCode).toBe(400);
    expect((await act("ceo", v2.collection, "collection.send", { recipientIds: [TEST_MEMBER.personId], deadlineAt: "2026-10-01T00:00:00Z", weekly: false })).statusCode).toBe(400);

    const sent = (await act("ceo", v2.collection, "collection.send", { recipientIds: [TEST_MEMBER.personId, THIRD.personId], deadlineAt: v1.deadlineAt, weekly: true })).json() as { collection: TCollectionView };
    const summary = sent.collection;
    expect(summary).toMatchObject({ status: "active", weekly: true, counts: { total: 2, filled: 0, confirmed: 0 }, viewer: { isInitiator: true, isRecipient: false } });
    expect(summary.round).toMatchObject({ weekStart: "2026-10-19", deadlineAt: v1.deadlineAt });
    expect(summary.entries.map((entry) => [entry.displayName, entry.status, `${entry.filled}/${entry.required}`])).toEqual([["测试乙", "empty", "0/4"], ["测试丙", "empty", "0/4"]]);
    // 重放发送不再开第二轮。
    expect((await act("ceo", v2.collection, "collection.send", { recipientIds: [TEST_MEMBER.personId, THIRD.personId], deadlineAt: v1.deadlineAt, weekly: true })).statusCode).toBe(200);

    const requestId = summary.round!.requestId;
    const mine = await round("b", requestId);
    expect(mine.entries.map((entry) => entry.displayName)).toEqual(["测试乙"]);
    expect(mine.counts.total).toBe(2);
    expect(mine.actions.map((action) => action.actionType).sort()).toEqual(["collection.confirm", "collection.save"]);
    expect((await call("d", "GET", `/api/requests/${requestId}/collection`)).statusCode).toBe(404);

    const request = (await call("b", "GET", `/api/requests/${requestId}`)).json() as { request: { kind: string; title: string; actions: { actionType: string }[] } };
    expect(request.request).toMatchObject({ kind: "collection", title: "灯塔项目每周开销（10/19 周）" });
    expect(request.request.actions.map((action) => action.actionType)).toEqual(["request.ask"]);
    expect((await notifications("b")).map((item) => item.text)).toContain("测试甲请你填：灯塔项目每周开销（10/19 周）");
    const inbox = ((await call("b", "GET", "/api/me/requests?box=inbox")).json() as { items: TRequestListItem[] }).items;
    expect(inbox.find((item) => item.id === requestId)?.fieldsFilled).toEqual({ filled: 0, required: 4 });
  });

  it("本人改自己那一行、填齐了才能确认；确认后不能再改，发起人收到通知，全部确认后这一轮完成", async () => {
    const { launch, round, act, call, sql } = await setup();
    const requestId = (await launch("收一下这周的开销")).round!.requestId;
    const mine = await round("b", requestId);
    const partial = await act("b", mine, "collection.save", { values: { amount: "1200", purpose: "云服务器", unknown: "丢掉" } });
    expect(partial.statusCode).toBe(200);
    const saved = (partial.json() as { collection: TCollectionView }).collection;
    expect(saved.entries[0]).toMatchObject({ values: { amount: "1200", purpose: "云服务器" }, filled: 2, required: 4, status: "empty" });
    expect((await act("b", saved, "collection.confirm")).statusCode).toBe(409);

    const full = (await act("b", saved, "collection.save", { values: { amount: "1200", purpose: "云服务器", project: "灯塔", receipt: "https://example.com/r.pdf" } })).json() as { collection: TCollectionView };
    expect(full.collection.entries[0].status).toBe("filled");
    const confirmed = (await act("b", full.collection, "collection.confirm")).json() as { collection: TCollectionView };
    expect(confirmed.collection.entries[0].status).toBe("confirmed");
    expect(confirmed.collection.actions).toEqual([]);
    expect((await act("b", full.collection, "collection.save", { values: { amount: "1" } })).statusCode).toBe(409);
    // CEO 的通知栏不读 /api/me/notifications：通知照样落库（请求列表里用 unread 标出来）。
    expect(await sql("SELECT kind, actor_id FROM notifications WHERE person_id = $1 AND object_id = $2", [TEST_CEO.personId, requestId])).toEqual([{ kind: "request_done", actor_id: TEST_MEMBER.personId }]);
    const sent = ((await call("ceo", "GET", "/api/me/requests?box=sent")).json() as { items: TRequestListItem[] }).items;
    expect(sent.find((item) => item.id === requestId)).toMatchObject({ unread: true, recipientsDone: 1 });

    const summary = await round("ceo", requestId);
    expect(summary.counts).toEqual({ total: 2, filled: 1, confirmed: 1 });
    expect(summary.entries.map((entry) => entry.status)).toEqual(["confirmed", "empty"]);
    const third = await round("c", requestId);
    await act("c", third, "collection.save", { values: { amount: "0", purpose: "无", project: "灯塔", receipt: "无" } });
    await act("c", await round("c", requestId), "collection.confirm");
    const request = (await call("ceo", "GET", `/api/requests/${requestId}`)).json() as { request: { status: string } };
    expect(request.request.status).toBe("done");
  });

  it("方法部门的表：本周周复盘已提交的用它起草；没提交的等提交后由后台补上，本人改过的不覆盖", async () => {
    const { launch, round, act, tick, sql } = await setup();
    const body = (overall: string) => ({
      overall: { text: overall, sources: [] }, progress: { text: "完成 V1 拆解 [会议纪要](cite:meeting:1)。", sources: [] }, issues: { text: "评审排期紧", sources: [] },
      implications: { text: "", sources: [] }, actions: { text: "先砍范围", sources: [] }, nextWeek: { text: "上线第二版", sources: [] },
    });
    const review = (personId: string, overall: string) => sql(`INSERT INTO weekly_reviews (id, person_id, week_start, status, body, submitted_at, created_at, updated_at)
      VALUES ($1, $2, '2026-10-19', 'submitted', $3::jsonb, now(), now(), now())`, [randomUUID(), personId, JSON.stringify(body(overall))]);
    await review(TEST_MEMBER.personId, "本周推进顺利");
    const requestId = (await launch("方法部门每周收一下大家的进展")).round!.requestId;
    const b = (await round("b", requestId)).entries[0];
    expect(b).toMatchObject({ draftFrom: "weekly_review", status: "filled", values: { progress: "本周推进顺利\n完成 V1 拆解。", issues: "评审排期紧", nextWeek: "上线第二版" } });
    expect((await round("c", requestId)).entries[0]).toMatchObject({ draftFrom: null, status: "empty", values: {} });

    await review(THIRD.personId, "丙这周的判断");
    await tick();
    expect((await round("c", requestId)).entries[0]).toMatchObject({ draftFrom: "weekly_review", values: { progress: "丙这周的判断\n完成 V1 拆解。" } });

    // 乙改过自己那一行：之后不再被周复盘覆盖（这里重置草稿来源模拟「周复盘后到」）。
    await act("b", await round("b", requestId), "collection.save", { values: { progress: "我自己写的", issues: "无", nextWeek: "继续" } });
    await sql("UPDATE collection_entries SET draft_review_id = NULL WHERE person_id = $1", [TEST_MEMBER.personId]);
    await tick();
    expect((await round("b", requestId)).entries[0].values.progress).toBe("我自己写的");
  });

  it("后台：截止前 3 小时只提醒一次没确认的人；「填完了主动提醒」只记影子、不发通知", async () => {
    const { launch, round, act, tick, clock, notifications, sql } = await setup();
    const requestId = (await launch("收一下这周的开销")).round!.requestId;
    const b = await round("b", requestId);
    await act("b", b, "collection.save", { values: { amount: "10", purpose: "打车", project: "灯塔", receipt: "无" } });
    await act("c", await round("c", requestId), "collection.save", { values: { amount: "20", purpose: "打车", project: "灯塔", receipt: "无" } });
    await act("c", await round("c", requestId), "collection.confirm");

    clock.now = new Date(MONDAY_10.getTime() + 20 * 60_000);
    await tick();
    expect((await sql("SELECT shadow_nudge_at FROM collection_entries WHERE person_id = $1", [TEST_MEMBER.personId]))[0].shadow_nudge_at).toBeNull();
    clock.now = new Date(MONDAY_10.getTime() + 31 * 60_000);
    await tick();
    expect((await sql("SELECT shadow_nudge_at FROM collection_entries WHERE person_id = $1", [TEST_MEMBER.personId]))[0].shadow_nudge_at).toEqual(clock.now);
    expect((await notifications("b")).filter((item) => item.kind === "collection_reminder")).toEqual([]);

    clock.now = new Date(FRIDAY_18.getTime() - 4 * HOUR);
    await tick();
    expect((await notifications("b")).filter((item) => item.kind === "collection_reminder")).toEqual([]);
    clock.now = new Date(FRIDAY_18.getTime() - 2 * HOUR);
    await tick();
    await tick();
    expect((await notifications("b")).filter((item) => item.kind === "collection_reminder").map((item) => item.text)).toEqual(["截止前提醒：灯塔项目每周开销（10/19 周）"]);
    expect((await notifications("c")).filter((item) => item.kind === "collection_reminder")).toEqual([]);
  });

  it("每周固定：上一轮发出 7 天后开下一轮（名单照旧）；停用后不再开，定时任务区里看得到", async () => {
    const { launch, tick, clock, call, notifications } = await setup();
    const first = await launch("每周收一下这周的开销");
    clock.now = new Date(MONDAY_10.getTime() + 6 * 24 * HOUR);
    await tick();
    const schedules = async () => ((await call("ceo", "GET", "/api/me/schedules")).json() as { items: TScheduleItem[] }).items;
    let item = (await schedules()).find((entry) => entry.origin === "collection")!;
    expect(item).toMatchObject({ name: "灯塔项目每周开销", category: "collect", cadence: "每周五 18:00 截止", active: true,
      nextRunAt: new Date(MONDAY_10.getTime() + 7 * 24 * HOUR).toISOString(), href: `/requests/${first.round!.requestId}` });

    clock.now = new Date(MONDAY_10.getTime() + 7 * 24 * HOUR + 60_000);
    await tick();
    await tick();
    const titles = (await notifications("b")).filter((entry) => entry.kind === "request_received").map((entry) => entry.text);
    expect(titles).toEqual(["测试甲请你填：灯塔项目每周开销（10/26 周）", "测试甲请你填：灯塔项目每周开销（10/19 周）"]);
    const second = (await call("ceo", "GET", `/api/collections/${first.id}`)).json() as { collection: TCollectionView };
    expect(second.collection.round).toMatchObject({ weekStart: "2026-10-26", deadlineAt: new Date(FRIDAY_18.getTime() + 7 * 24 * HOUR).toISOString() });

    item = (await schedules()).find((entry) => entry.origin === "collection")!;
    expect((await call("ceo", "POST", "/api/collections/actions/execute", { actionId: item.actions[0].actionId })).statusCode).toBe(200);
    clock.now = new Date(MONDAY_10.getTime() + 14 * 24 * HOUR + 60_000);
    await tick();
    expect((await notifications("b")).filter((entry) => entry.kind === "request_received")).toHaveLength(2);
    expect((await schedules()).find((entry) => entry.origin === "collection")).toMatchObject({ active: false, nextRunAt: null, actions: [] });
  });

  it("定时任务区：成员看得到上手时搬过来的本机任务，没有周五起草周复盘", async () => {
    const { call, sql } = await setup();
    await sql(`INSERT INTO schedules (id, person_id, name, cadence, command, source, source_device_id, source_key, created_at)
      VALUES ($1, $2, '每周发周报', '0 18 * * 5', 'codex run', 'local', 'dev-1', 'weekly-report', now())`, [randomUUID(), TEST_MEMBER.personId]);
    const items = ((await call("b", "GET", "/api/me/schedules")).json() as { items: TScheduleItem[] }).items;
    expect(items.map((item) => [item.origin, item.name, item.cadence])).toEqual([["local", "每周发周报", "0 18 * * 5"]]);
  });

  it("收集关闭时定时任务里没有收集项", async () => {
    const { call, sql } = await setup(false);
    await sql(`INSERT INTO collections (id, initiator_id, prompt, scenario, title, fields, deadline_at, weekly, status, sent_at)
      VALUES ($1, $2, '每周收一下这周的开销', 'expense', '灯塔项目每周开销', '[]'::jsonb, $3, TRUE, 'active', now())`, [randomUUID(), TEST_CEO.personId, FRIDAY_18]);
    const res = await call("ceo", "GET", "/api/me/schedules");
    expect(res.statusCode).toBe(200);
    expect((res.json() as { items: TScheduleItem[] }).items.filter((item) => item.category === "collect")).toEqual([]);
    expect((await call("ceo", "POST", "/api/collections/draft", { prompt: "每周收一下这周的开销" })).statusCode).toBe(404);
    expect(t!.app.collectionJobs).toEqual({ handlers: {}, recurring: [] });
  });

  it("飞书多维表格：发出后建表、每人一行；天枢改的推上去，飞书里改的读回来", async () => {
    const { launch, round, act, tick, bitable, sql } = await setup();
    const requestId = (await launch("收一下这周的开销")).round!.requestId;
    expect((await sql("SELECT sync_error FROM collections"))[0].sync_error).toBeNull();
    const [table] = [...bitable.tables.values()];
    expect(table.columns.map((column) => `${column.name}:${column.type}`)).toEqual(["填写人:text", "周:text", "本周开销（元）:number", "用途:text", "对应项目:text", "票据:text", "备注:text", "已确认:checkbox"]);
    expect([...table.rows.values()].map((row) => row["填写人"])).toEqual(["测试乙", "测试丙"]);

    await act("b", await round("b", requestId), "collection.save", { values: { amount: "88.5", purpose: "午饭" } });
    const recordId = (await sql("SELECT record_id FROM collection_entries WHERE person_id = $1", [TEST_MEMBER.personId]))[0].record_id as string;
    expect(table.rows.get(recordId)).toMatchObject({ "本周开销（元）": 88.5, 用途: "午饭", 已确认: false });

    table.rows.set(recordId, { ...table.rows.get(recordId)!, 对应项目: "灯塔", 票据: "https://example.com/r" });
    await tick();
    expect((await round("b", requestId)).entries[0]).toMatchObject({ values: { amount: "88.5", purpose: "午饭", project: "灯塔", receipt: "https://example.com/r" }, status: "filled" });
    expect((await sql("SELECT sync_error FROM collections"))[0].sync_error).toBeNull();
  });

  it("每周固定的后续各轮沿用第一轮建的那张表，每人每轮追加一行、带「周」；只有新建的收集才新建表（D-46）", async () => {
    const { launch, tick, clock, bitable, sql } = await setup();
    const first = await launch("每周收一下这周的开销");
    expect(bitable.tables.size).toBe(1);
    clock.now = new Date(MONDAY_10.getTime() + 7 * 24 * HOUR + 60_000);
    await tick();
    expect((await sql("SELECT count(*)::int AS n FROM collection_rounds WHERE collection_id = $1", [first.id]))[0].n).toBe(2);
    expect(bitable.tables.size).toBe(1);
    const [table] = [...bitable.tables.values()];
    expect([...table.rows.values()].map((row) => `${row["填写人"]}·${row["周"]}`).sort())
      .toEqual(["测试丙·10/19 周", "测试丙·10/26 周", "测试乙·10/19 周", "测试乙·10/26 周"]);

    await launch("收一下这周的开销");
    expect(bitable.tables.size).toBe(2);
  });

  it("对话入口：判断场景 → 起草收集表 → 等你确认，回答后面挂草稿卡；不支持的场景停在第一步", async () => {
    const { sql } = await setup();
    const steps: EntryStep[] = [];
    const cards: TConversationCard[] = [];
    const people = [{ personId: TEST_MEMBER.personId, displayName: "测试乙" }, { personId: THIRD.personId, displayName: "测试丙" }];
    const entries = createConversationEntries({
      pool: t!.pool, agent: {} as RequestAgent, secret: t!.env.sessionSecret, viewer: { personId: TEST_CEO.personId, role: "ceo" }, message: "", names: new Map([[TEST_CEO.personId, "测试甲"], [TEST_MEMBER.personId, "测试乙"], [THIRD.personId, "测试丙"]]),
      people, directory: people, now: () => MONDAY_10, fingerprint: "test",
      collections: { agent, deps: { pool: t!.pool, bitable: createMockBitable(), isCeo: () => true, names: () => new Map(), now: () => MONDAY_10 } },
      onStep: (step) => steps.push(step), onCard: (card) => cards.push(card),
    });
    const result = await entries.startCollection({ prompt: "每周收一下大家的进展" });
    expect(result).toMatchObject({ drafted: true, title: "方法部周进展", weekly: true, deadline: "10/23 周五 18:00", suggestedRecipients: ["测试乙", "测试丙"] });
    const last = new Map(steps.map((step) => [step.id, step]));
    expect([...last.values()].map((step) => [step.label, step.status])).toEqual([["判断场景", "done"], ["起草收集表", "done"], ["等你确认", "active"]]);
    expect(cards).toEqual([{ kind: "collection_draft", collectionId: result.collectionId }]);
    expect((await sql("SELECT status FROM collections"))[0].status).toBe("draft");

    steps.length = 0;
    const refused = await entries.startCollection({ prompt: "收一下大家的反馈" });
    expect(refused).toMatchObject({ drafted: false });
    expect(steps.findLast((step) => step.id === "collection-scenario")).toMatchObject({ status: "done", result: "不是开销或周进展" });
  });
});

describe("对话里的「发起信息收集」", () => {
  it("收集关闭时不给模型 start_collection", async () => {
    const seen: string[][] = [];
    const runtime = await createPiConversationRuntime({ peopleDirectory: loadPeopleDirectory(testEnv),
      baseUrl: "https://provider.invalid/v1/responses", apiKey: "test-key", modelId: "fake-light",
      streamSimple: (_model, context) => {
        seen.push(context.tools?.map((tool) => tool.name) ?? []);
        const stream = createAssistantMessageEventStream();
        const message: AssistantMessage = { role: "assistant", api: "openai-responses", provider: "warmap", model: "test", content: [{ type: "text", text: "好的" }],
          stopReason: "stop", timestamp: Date.now(), usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
        queueMicrotask(() => stream.push({ type: "done", reason: "stop", message }));
        return stream;
      } });
    const entries = (collections: boolean) => createConversationEntries({
      pool: {} as never, agent: {} as RequestAgent, secret: "s", viewer: { personId: TEST_CEO.personId, role: "ceo" }, message: "", names: new Map(), people: [], directory: [],
      now: () => MONDAY_10, fingerprint: "test", onStep: () => undefined, onCard: () => undefined,
      ...(collections ? { collections: { agent, deps: { pool: {} as never, bitable: createMockBitable(), isCeo: () => true, names: () => new Map(), now: () => MONDAY_10 } } } : {}),
    });
    const base = { scope: "global" as const, viewer: { personId: TEST_CEO.personId, displayName: "测试甲", role: "ceo" as const },
      currentObject: null, referencesSnapshot: [], signal: new AbortController().signal, emit: () => undefined, message: "每周收一下开销", runtimeEntries: [] };
    try {
      await runtime.run({ ...base, piSessionId: randomUUID(), entries: entries(false) });
      await runtime.run({ ...base, piSessionId: randomUUID(), entries: entries(true) });
      expect(seen[0]).toContain("request_help");
      expect(seen[0]).not.toContain("start_collection");
      expect(seen[1]).toContain("start_collection");
    } finally {
      await runtime.close?.();
    }
  });
});

describe("飞书多维表格适配层（live，假 fetch）", () => {
  it("建表、加协作者、写行、分页读回；单元格换成文字", async () => {
    const calls: { method: string; url: string; body: unknown }[] = [];
    const replies: Record<string, unknown>[] = [
      { code: 0, data: { app: { app_token: "app1", url: "https://x.feishu.cn/base/app1" } } },
      { code: 0, data: { table_id: "tbl1" } },
      { code: 0, data: {} },
      { code: 0, data: { record: { record_id: "rec1" } } },
      { code: 0, data: { items: [{ record_id: "rec1", fields: { 用途: [{ text: "午", type: "text" }, { text: "饭", type: "text" }] } }], has_more: true, page_token: "p2" } },
      { code: 0, data: { items: [{ record_id: "rec2", fields: { 本周开销: 12 } }], has_more: false } },
    ];
    const fetch = (async (url: string, init: RequestInit) => {
      calls.push({ method: init.method ?? "GET", url, body: init.body ? JSON.parse(String(init.body)) : undefined });
      return new Response(JSON.stringify(replies.shift()));
    }) as typeof globalThis.fetch;
    const live = createFeishuBitable({ fetch });
    const table = await live.createTable({ accessToken: "u", name: "开销", columns: [{ name: "用途", type: "text" }, { name: "本周开销", type: "number" }], editorOpenIds: ["ou_1"] });
    expect(table).toEqual({ appToken: "app1", tableId: "tbl1", url: "https://x.feishu.cn/base/app1" });
    expect(await live.upsertRecord({ accessToken: "u", table, recordId: null, fields: { 用途: "午饭" } })).toBe("rec1");
    const records = await live.listRecords({ accessToken: "u", table });
    expect(records.map((record) => [record.recordId, cellText(Object.values(record.fields)[0])])).toEqual([["rec1", "午饭"], ["rec2", "12"]]);
    expect(calls.map((call) => `${call.method} ${call.url.replace("https://open.feishu.cn/open-apis", "")}`)).toEqual([
      "POST /bitable/v1/apps",
      "POST /bitable/v1/apps/app1/tables",
      "POST /drive/v1/permissions/app1/members?type=bitable&need_notification=false",
      "POST /bitable/v1/apps/app1/tables/tbl1/records",
      "GET /bitable/v1/apps/app1/tables/tbl1/records?page_size=500",
      "GET /bitable/v1/apps/app1/tables/tbl1/records?page_size=500&page_token=p2",
    ]);
    expect(calls[1].body).toEqual({ table: { name: "开销", default_view_name: "全部", fields: [{ field_name: "用途", type: 1 }, { field_name: "本周开销", type: 2 }] } });
    expect(calls[2].body).toEqual({ member_type: "openid", member_id: "ou_1", perm: "edit" });
  });

  it("接口返回业务错误时抛出，不吞掉", async () => {
    const live = createFeishuBitable({ fetch: (async () => new Response(JSON.stringify({ code: 99991672, msg: "no permission" }))) as unknown as typeof globalThis.fetch });
    await expect(live.createTable({ accessToken: "u", name: "x", columns: [], editorOpenIds: [] })).rejects.toThrow("no permission");
  });
});
