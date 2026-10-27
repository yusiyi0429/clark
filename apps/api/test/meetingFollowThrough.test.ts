import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { Value } from "@sinclair/typebox/value";
import { MeetingOutcomeState, NotificationList, TaskView, type TPostMeetingCandidate } from "@warmap/contracts";
import { createTestApp, preflightCandidate, seedLegacyOutcome, TEST_CEO, TEST_MEMBER, type TestApp } from "./helpers.js";
import { assessOutcomeCandidate, type PostMeetingAgent } from "../src/outcome.js";
import type { PreflightAgent, PreflightAgentInput } from "../src/meetingPreflight.js";
import { hashSecret } from "../src/session.js";

// 旧格式会议的会后闭环：todo 推送成执行事项、成员处理与退回、成员通知；逐条确认和战略项分流已停（会后只有会议卡一个入口）。
const PEOPLE_SEED = fileURLToPath(new URL("./fixtures/company-people-candidate.json", import.meta.url));
const CEO = TEST_CEO.personId; // 测试甲
const LEAD = TEST_MEMBER.personId; // 测试乙：主持人
const OWNER = "person-fixture-003"; // 测试丙
const OWNER_LOGIN = { loginId: "ceshib", passcode: "3579" };

const TURNS = [
  { id: "turn-001", speakerId: CEO, text: "测试丙下周一前把渠道名单整理好。" },
  { id: "turn-002", speakerId: LEAD, text: "我周五前提交资源排期。" },
  { id: "turn-003", speakerId: CEO, text: "风险清单也要有人跟，外部承诺我自己去谈。" },
  { id: "turn-004", speakerId: OWNER, text: "东南亚要不要整体撤出，这件事得请 CEO 拍板。" },
];

/** item-1 点名给测试丙、item-2 主持人自己认领、item-3 无负责人、item-4 CEO 自己的、item-5 战略议题。 */
const CANDIDATE: TPostMeetingCandidate = {
  summary: "会议分派三项执行事项，并提出一个战略议题",
  items: [
    { kind: "todo", text: "整理渠道名单", turnId: "turn-001", quote: "测试丙下周一前把渠道名单整理好", ownerPersonId: OWNER, dueDate: "2026-06-08" },
    { kind: "todo", text: "周五前提交资源排期", turnId: "turn-002", quote: "我周五前提交资源排期", ownerPersonId: LEAD },
    { kind: "todo", text: "跟进风险清单", turnId: "turn-003", quote: "风险清单也要有人跟" },
    { kind: "todo", text: "外部承诺由 CEO 去谈", turnId: "turn-003", quote: "外部承诺我自己去谈", ownerPersonId: CEO },
    {
      kind: "strategic",
      text: "是否整体撤出东南亚",
      turnId: "turn-004",
      quote: "东南亚要不要整体撤出",
      title: "是否整体撤出东南亚市场",
      brief: "测试丙提出东南亚业务是否整体撤出，需要 CEO 拍板。",
      judgmentKind: "company_direction",
    },
  ],
};

const preflightAgent: PreflightAgent = {
  async generate(input: PreflightAgentInput) {
    return { candidate: preflightCandidate(input.issues.map((issue) => `issue:${issue.id}`)) };
  },
};

const outcomeAgent: PostMeetingAgent = {
  async generate() {
    return { candidate: structuredClone(CANDIDATE) };
  },
};

function newApp(): Promise<TestApp> {
  return createTestApp({ companyPeopleSeed: PEOPLE_SEED }, undefined, { preflightAgent, outcomeAgent });
}

type CardAction = { actionType: string; actionId: string; itemId?: string; label: string };
type Item = { id: string; kind: string; review: { status: string; effectRef: string | null } | null } & Record<string, unknown>;

/** Issue → Meeting（主持人测试乙，参会测试丙）→ 导入逐字稿 → 抽取 ready。 */
async function readyMeeting(t: TestApp): Promise<{ ceo: string; meetingId: string; items: Item[] }> {
  const ceo = await t.loginCookie();
  const issue = await t.app.inject({
    method: "POST",
    url: "/api/dri/issues",
    headers: { authorization: `Bearer ${t.env.driServiceToken}` },
    payload: {
      externalId: `follow-through-${Math.random().toString(36).slice(2)}`,
      submitterPersonId: LEAD,
      title: "是否调整东南亚渠道投入",
      whyNow: "渠道窗口将在六月关闭",
      sourceRef: "dri://test/follow-through",
      location: { level: "battlefield", battlefieldId: "growth" },
    },
  });
  expect(issue.statusCode).toBe(201);
  const issueCard = issue.json().cards[0];
  const create = (issueCard.actions as CardAction[]).find((a) => a.actionType === "issue.create_meeting")!;
  const created = await t.app.inject({
    method: "POST",
    url: "/api/actions/execute",
    headers: { cookie: ceo, origin: t.publicOrigin },
    payload: {
      actionId: create.actionId,
      input: {
        title: "渠道投入决策会",
        scheduledAt: "2026-06-01T10:00:00.000+08:00",
        leadDriId: LEAD,
        ceoParticipantId: CEO,
        participants: [LEAD, OWNER],
        issueIds: [issueCard.objectRef.id],
      },
    },
  });
  expect(created.statusCode).toBe(200);
  const meetingId = created.json().cards[0].objectRef.id as string;
  const imported = await t.app.inject({
    method: "POST",
    url: `/api/dri/meetings/${meetingId}/transcript`,
    headers: { authorization: `Bearer ${t.env.driServiceToken}` },
    payload: { schemaVersion: "warmap-transcript.v1", meetingId, turns: TURNS },
  });
  expect(imported.statusCode).toBe(200);
  // 会后逐条条目只在旧格式会议里：现在的会后整理只生成会议卡，这里写成旧会议的样子（todo 照旧推成执行事项）。
  await seedLegacyOutcome(t.pool, meetingId, CANDIDATE);
  const outcome = (await t.sql("SELECT outcome FROM meetings WHERE id = $1", [meetingId]))[0].outcome;
  expect(outcome.status).toBe("ready");
  return { ceo, meetingId, items: outcome.items as Item[] };
}

async function meetingCard(t: TestApp, cookie: string, meetingId: string) {
  return (await t.app.inject({ method: "GET", url: `/api/cards/meetings/${meetingId}`, headers: { cookie } })).json().cards[0];
}

async function execute(t: TestApp, cookie: string, meetingId: string, actionType: string, itemId?: string, input?: unknown) {
  const card = await meetingCard(t, cookie, meetingId);
  const action = (card.actions as CardAction[]).find((a) => a.actionType === actionType && a.itemId === itemId);
  expect(action, `${actionType} ${itemId}`).toBeDefined();
  return t.app.inject({
    method: "POST",
    url: "/api/actions/execute",
    headers: { cookie, origin: t.publicOrigin },
    payload: { actionId: action!.actionId, input },
  });
}

const taskIdOf = (item: Item) => item.review!.effectRef!.replace(/^task:/, "");

async function ownerCookie(t: TestApp): Promise<string> {
  await t.sql(
    "INSERT INTO member_access (person_id, login_id, passcode_hash, must_change) VALUES ($1, $2, $3, FALSE)",
    [OWNER, OWNER_LOGIN.loginId, hashSecret(OWNER_LOGIN.passcode)],
  );
  const login = await t.app.inject({ method: "POST", url: "/api/auth/login", headers: { origin: t.publicOrigin }, payload: OWNER_LOGIN });
  expect(login.statusCode).toBe(200);
  return (login.headers["set-cookie"] as string).split(";")[0];
}

const me = (t: TestApp, cookie: string, method: "GET" | "PATCH" | "POST", url: string, payload?: unknown) =>
  t.app.inject({ method, url, headers: { cookie, origin: t.publicOrigin }, ...(payload === undefined ? {} : { payload }) });

describe("会后自动推送执行事项", () => {
  it("每条 todo 推给负责人，无负责人给主持人，CEO 自己的不推送；负责人收到通知", async () => {
    const t = await newApp();
    try {
      const { ceo, meetingId, items } = await readyMeeting(t);
      expect(Value.Check(MeetingOutcomeState, (await meetingCard(t, ceo, meetingId)).payload.outcome)).toBe(true);
      expect(items.map((item) => item.review?.status)).toEqual(["confirmed", "confirmed", "confirmed", "pending", "pending"]);
      for (const item of items.slice(0, 3)) expect(item.review!.effectRef).toMatch(/^task:[0-9a-f-]{36}$/);
      expect(items[0]).toMatchObject({ dueDate: "2026-06-08" });
      expect(items[4]).toMatchObject({
        kind: "strategic",
        speakerId: OWNER,
        title: "是否整体撤出东南亚市场",
        brief: "测试丙提出东南亚业务是否整体撤出，需要 CEO 拍板。",
        judgmentKind: "company_direction",
      });

      const tasks = await t.sql(
        `SELECT id::text, owner_id, title, status, due_date::text, source_quote, created_by, origin_meeting_id::text, origin_item_id, version
           FROM tasks ORDER BY origin_item_id`,
      );
      expect(tasks).toEqual([
        { id: taskIdOf(items[0]), owner_id: OWNER, title: "整理渠道名单", status: "not_started", due_date: "2026-06-08", source_quote: "测试丙下周一前把渠道名单整理好", created_by: "meeting", origin_meeting_id: meetingId, origin_item_id: "item-1", version: 1 },
        { id: taskIdOf(items[1]), owner_id: LEAD, title: "周五前提交资源排期", status: "not_started", due_date: null, source_quote: "我周五前提交资源排期", created_by: "meeting", origin_meeting_id: meetingId, origin_item_id: "item-2", version: 1 },
        { id: taskIdOf(items[2]), owner_id: LEAD, title: "跟进风险清单", status: "not_started", due_date: null, source_quote: "风险清单也要有人跟", created_by: "meeting", origin_meeting_id: meetingId, origin_item_id: "item-3", version: 1 },
      ]);
      expect(await t.sql("SELECT person_id, role FROM task_members ORDER BY person_id")).toEqual([
        { person_id: LEAD, role: "owner" },
        { person_id: LEAD, role: "owner" },
        { person_id: OWNER, role: "owner" },
      ]);
      const notifications = await t.sql("SELECT person_id, kind, object_type, object_id FROM notifications ORDER BY person_id, object_id");
      expect(notifications).toHaveLength(3);
      expect(notifications.every((row) => row.kind === "meeting_action_assigned" && row.object_type === "task")).toBe(true);
      expect(notifications.filter((row) => row.person_id === CEO)).toHaveLength(0);
      expect(notifications.filter((row) => row.person_id === LEAD).map((row) => row.object_id).sort())
        .toEqual([taskIdOf(items[1]), taskIdOf(items[2])].sort());

      // 已推送的执行事项是已确认效果：不再允许替换逐字稿；CEO 的 todo 与战略项只读，没有逐条动作
      const actions = (await meetingCard(t, ceo, meetingId)).actions as CardAction[];
      expect(actions.some((a) => a.actionType === "meeting.replace_transcript")).toBe(false);
      expect(actions.filter((a) => a.itemId)).toEqual([]);
    } finally {
      await t.close();
    }
  });

  it("同一会议条目重复抽取不会重复建执行事项或重复通知", async () => {
    const t = await newApp();
    try {
      const { ceo, meetingId, items } = await readyMeeting(t);
      await t.sql("UPDATE meetings SET outcome = jsonb_set(outcome, '{status}', '\"failed\"') WHERE id = $1", [meetingId]);
      const retried = await execute(t, ceo, meetingId, "meeting.retry_outcome");
      expect(retried.statusCode).toBe(200);
      const again = retried.json().cards[0].payload.outcome.items as Item[];
      expect(again.slice(0, 3).map((item) => item.review?.effectRef)).toEqual(items.slice(0, 3).map((item) => item.review?.effectRef));
      expect(await t.sql("SELECT id FROM tasks")).toHaveLength(3);
      expect(await t.sql("SELECT id FROM notifications")).toHaveLength(3);
    } finally {
      await t.close();
    }
  });
});

describe("成员的执行事项", () => {
  it("我的工作台按新到旧列出我负责的执行事项；只有负责人能改状态，旧版本 409", async () => {
    const t = await newApp();
    try {
      const { meetingId, items } = await readyMeeting(t);
      const lead = await t.memberCookie();
      const home = await me(t, lead, "GET", "/api/me/home");
      expect(home.statusCode).toBe(200);
      const myTasks = home.json().myTasks as Record<string, unknown>[];
      expect(myTasks.map((task) => task.id)).toEqual([taskIdOf(items[2]), taskIdOf(items[1])]);
      for (const task of myTasks) expect(Value.Check(TaskView, task)).toBe(true);
      expect(myTasks[1]).toMatchObject({
        version: 1,
        title: "周五前提交资源排期",
        status: "not_started",
        source: "meeting",
        mission: null,
        dueDate: null,
        returnReason: null,
        origin: { type: "meeting", meetingId, meetingTitle: "渠道投入决策会", quote: "我周五前提交资源排期" },
      });
      const thread = await me(t, lead, "GET", `/api/threads/task/${taskIdOf(items[1])}`);
      expect(thread.statusCode).toBe(200);
      expect(thread.json()).toMatchObject({ unread: 0, members: [{ personId: LEAD }] });

      // 别人的执行事项一律 404
      const others = await me(t, lead, "PATCH", `/api/me/tasks/${taskIdOf(items[0])}`, { version: 1, status: "in_progress" });
      expect(others.statusCode).toBe(404);
      expect(others.json().code).toBe("TASK_NOT_FOUND");
      expect((await me(t, lead, "PATCH", "/api/me/tasks/not-a-uuid", { version: 1, status: "in_progress" })).statusCode).toBe(404);

      const started = await me(t, lead, "PATCH", `/api/me/tasks/${taskIdOf(items[1])}`, { version: 1, status: "in_progress" });
      expect(started.statusCode).toBe(200);
      expect(started.json()).toMatchObject({ id: taskIdOf(items[1]), version: 2, status: "in_progress" });

      const stale = await me(t, lead, "PATCH", `/api/me/tasks/${taskIdOf(items[1])}`, { version: 1, status: "not_started" });
      expect(stale.statusCode).toBe(409);
      expect(stale.json()).toMatchObject({ code: "VERSION_CONFLICT", latestTask: { version: 2, status: "in_progress" } });

      // 退回只能走退回接口，完成只能走验收
      expect((await me(t, lead, "PATCH", `/api/me/tasks/${taskIdOf(items[1])}`, { version: 2, status: "returned" })).statusCode).toBe(400);
      expect((await me(t, lead, "PATCH", `/api/me/tasks/${taskIdOf(items[1])}`, { version: 2, status: "done" })).statusCode).toBe(400);
      expect((await me(t, await t.loginCookie(), "GET", "/api/me/home")).statusCode).toBe(403);
      expect((await t.app.inject({ method: "GET", url: "/api/me/home" })).statusCode).toBe(401);
    } finally {
      await t.close();
    }
  });

  it("退回要写原因并通知主持人；主持人退回自己的执行事项不给自己发通知", async () => {
    const t = await newApp();
    try {
      const { items } = await readyMeeting(t);
      const owner = await ownerCookie(t);
      expect((await me(t, owner, "POST", `/api/me/tasks/${taskIdOf(items[0])}/return`, { version: 1, reason: "x".repeat(201) })).statusCode).toBe(400);
      const returned = await me(t, owner, "POST", `/api/me/tasks/${taskIdOf(items[0])}/return`, { version: 1, reason: "渠道名单归市场部" });
      expect(returned.statusCode).toBe(200);
      expect(returned.json()).toMatchObject({ version: 2, status: "returned", returnReason: "渠道名单归市场部" });
      expect(Value.Check(TaskView, returned.json())).toBe(true);

      const lead = await t.memberCookie();
      const texts = ((await me(t, lead, "GET", "/api/me/notifications")).json().notifications as { kind: string; text: string }[])
        .filter((n) => n.kind === "task_returned")
        .map((n) => n.text);
      expect(texts).toEqual(["测试丙 退回了执行事项「整理渠道名单」：渠道名单归市场部"]);

      const own = await me(t, lead, "POST", `/api/me/tasks/${taskIdOf(items[1])}/return`, { version: 1, reason: "排期改由财务出" });
      expect(own.statusCode).toBe(200);
      expect(await t.sql("SELECT person_id FROM notifications WHERE kind = 'task_returned'")).toEqual([{ person_id: LEAD }]);

      // 别人不能退回
      expect((await me(t, owner, "POST", `/api/me/tasks/${taskIdOf(items[2])}/return`, { version: 1, reason: "不归我" })).statusCode).toBe(404);
    } finally {
      await t.close();
    }
  });
});

describe("旧会议的会后条目", () => {
  it("原文和完整纪要只给实际参会的人；逐条决定只读，首页不再单列待 CEO 确认的战略项", async () => {
    const t = await newApp();
    try {
      const { ceo, meetingId } = await readyMeeting(t);
      // 战略项还没处理，会议也不再进 CEO 首页（不再有 CEO 单独确认的卡）。
      const home = (await t.app.inject({ method: "GET", url: "/api/cards/home", headers: { cookie: ceo } })).json().cards as { id: string }[];
      expect(home.some((card) => card.id === `meeting:${meetingId}`)).toBe(false);

      // 飞书参会名单里只有主持人：测试丙（手填的参会人）看不到原文和完整纪要，主持人看得到。
      await t.pool.query("UPDATE meetings SET attendees_actual = $2::jsonb WHERE id = $1", [meetingId, JSON.stringify([LEAD])]);
      await t.pool.query(
        `INSERT INTO meeting_decisions (id, meeting_id, tier, ordinal, statement, item_ids, recommendation) VALUES (gen_random_uuid(), $1, 'host', 1, '周五前提交资源排期', '["item-2"]'::jsonb, 'confirmed')`,
        [meetingId],
      );
      const host = await t.memberCookie();
      const hostCard = (await t.app.inject({ method: "GET", url: `/api/me/cards/meetings/${meetingId}`, headers: { cookie: host } })).json();
      expect(hostCard.payload).toMatchObject({ attended: true, outcome: { summary: CANDIDATE.summary } });
      expect(hostCard.payload.transcript.turns).toHaveLength(4);
      expect(hostCard.payload.decisions.map((d: { statement: string; canReview: boolean }) => [d.statement, d.canReview])).toEqual([["周五前提交资源排期", false]]);
      const owner = await ownerCookie(t);
      const ownerCard = (await t.app.inject({ method: "GET", url: `/api/me/cards/meetings/${meetingId}`, headers: { cookie: owner } })).json();
      expect(ownerCard.payload.attended).toBe(false);
      expect(ownerCard.payload).not.toHaveProperty("transcript");
      expect(ownerCard.payload).not.toHaveProperty("decisions");
      expect(ownerCard.payload.outcome).not.toHaveProperty("summary");
      expect(ownerCard.payload.attendees).toBeUndefined();
    } finally {
      await t.close();
    }
  });
});

describe("成员通知", () => {
  it("只返回我的通知，文案按对象当前状态组合；未读在前；seen 只标我的", async () => {
    const t = await newApp();
    try {
      await readyMeeting(t);
      const lead = await t.memberCookie();
      const list = await me(t, lead, "GET", "/api/me/notifications");
      expect(list.statusCode).toBe(200);
      expect(Value.Check(NotificationList, list.json())).toBe(true);
      const notifications = list.json().notifications as { id: string; kind: string; text: string; objectType: string; readAt: string | null }[];
      expect(notifications.map((n) => n.text).sort()).toEqual([
        "会议「渠道投入决策会」给你分配了执行事项「周五前提交资源排期」",
        "会议「渠道投入决策会」给你分配了执行事项「跟进风险清单」",
      ]);
      expect(notifications.every((n) => n.kind === "meeting_action_assigned" && n.objectType === "task" && n.readAt === null)).toBe(true);
      // 通知栏正文只写事情本身，会议名进小字。
      expect((notifications as unknown as { subject?: string; source?: string }[]).map((n) => `${n.source}|${n.subject}`).sort())
        .toEqual(["渠道投入决策会|周五前提交资源排期", "渠道投入决策会|跟进风险清单"]);

      const ownerNotification = (await t.sql("SELECT id::text FROM notifications WHERE person_id = $1", [OWNER]))[0].id as string;
      const seen = await me(t, lead, "POST", "/api/me/seen", { notificationIds: [notifications[0].id, ownerNotification] });
      expect(seen.statusCode).toBe(204);
      expect((await t.sql("SELECT read_at FROM notifications WHERE id = $1", [ownerNotification]))[0].read_at).toBeNull();
      const after = (await me(t, lead, "GET", "/api/me/notifications")).json().notifications as { id: string; readAt: string | null }[];
      // 未读在前，已读的排到后面
      expect(after.map((n) => n.id)).toEqual([notifications[1].id, notifications[0].id]);
      expect(after[1].readAt).not.toBeNull();

      expect((await me(t, lead, "POST", "/api/me/seen", { notificationIds: [] })).statusCode).toBe(400);
      expect((await t.app.inject({ method: "GET", url: "/api/me/notifications" })).statusCode).toBe(401);
    } finally {
      await t.close();
    }
  });
});

describe("战略项与截止日期的确定性校验", () => {
  const participants = [
    { personId: CEO, displayName: "测试甲", roles: ["ceo"], sourceRef: "people:1", updatedAt: "2026-05-01T00:00:00.000Z" },
    { personId: LEAD, displayName: "测试乙", roles: ["dri"], sourceRef: "people:2", updatedAt: "2026-05-01T00:00:00.000Z" },
    { personId: OWNER, displayName: "测试丙", roles: ["participant"], sourceRef: "people:3", updatedAt: "2026-05-01T00:00:00.000Z" },
  ];
  const assess = (items: unknown[]) =>
    assessOutcomeCandidate({ candidate: { summary: "s", items }, turns: TURNS, participants, ceoParticipantId: CEO, issueIds: [] });
  const strategic = CANDIDATE.items[4];

  it("战略项可以引用任何人的发言；todo 可带合法截止日期", () => {
    const result = assess([strategic, CANDIDATE.items[0]]);
    expect(result).toMatchObject({ ok: true, warnings: [] });
    if (!result.ok) return;
    expect(result.items[0]).toMatchObject({ kind: "strategic", speakerId: OWNER, title: strategic.title, brief: strategic.brief, judgmentKind: "company_direction", review: { status: "pending" } });
    expect(result.items[1]).toMatchObject({ kind: "todo", dueDate: "2026-06-08" });
  });

  it("D-40/D-41：改公司方向 / LTO / PO（含 Mission 本月结果目标或成功标准）、跨战场调资源的推给 CEO；只影响本战场打法、计划、执行的降成会上的决定", () => {
    const result = assess([
      { ...strategic, judgmentKind: "external_commitment" },
      { ...strategic, judgmentKind: "major_risk" },
      { ...strategic, judgmentKind: "mission_boundary" },
      { ...strategic, judgmentKind: "resource_allocation" },
      strategic,
    ].map((item) => JSON.parse(JSON.stringify(item))));
    expect(result).toMatchObject({ ok: true, warnings: [] });
    if (!result.ok) return;
    expect(result.items.map((item) => [item.kind, item.judgmentKind])).toEqual([
      ["decision", null], ["decision", null], ["strategic", "mission_boundary"], ["strategic", "resource_allocation"], ["strategic", "company_direction"],
    ]);
    expect(result.items[0]).not.toHaveProperty("title");
    expect(result.items[0]).toMatchObject({ text: strategic.text, quote: strategic.quote, review: { status: "pending" } });
  });

  it("缺字段、日期不存在、说明超过两句、引文不在 turn 里的条目进入 warnings", () => {
    const result = assess([
      { ...strategic, title: undefined },
      { ...strategic, judgmentKind: undefined },
      { ...CANDIDATE.items[1], dueDate: "2026-02-30" },
      { ...strategic, brief: "第一句。第二句。第三句。" },
      { ...strategic, quote: "我周五前提交资源排期" },
    ].map((item) => JSON.parse(JSON.stringify(item))));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.items).toHaveLength(0);
    expect(result.warnings.map((warning) => warning.reason)).toEqual([
      "strategic 缺少 title、brief 或 judgmentKind",
      "strategic 缺少 title、brief 或 judgmentKind",
      "dueDate 不是有效日期: 2026-02-30",
      "brief 最多两句话",
      "quote 不是被引用 turn 中的连续引文",
    ]);
  });

  it("多填了别的类型才用的字段：只丢掉这些字段、整条保留，并在日志里记一条警告", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const result = assess([
        { ...CANDIDATE.items[1], title: "不该有标题", brief: "不适用", judgmentKind: "company_direction", parentIndex: 0 },
        { ...strategic, dueDate: "2026-06-08" },
        { ...CANDIDATE.items[0] },
      ]);
      expect(result).toMatchObject({ ok: true, warnings: [] });
      if (!result.ok) return;
      expect(result.items).toHaveLength(3);
      expect(result.items[0]).toMatchObject({ kind: "todo", text: CANDIDATE.items[1].text, judgmentKind: null, parentItemId: null });
      expect(result.items[0]).not.toHaveProperty("title");
      expect(result.items[0]).not.toHaveProperty("brief");
      expect(result.items[1]).toMatchObject({ kind: "strategic", title: strategic.title });
      expect(result.items[1]).not.toHaveProperty("dueDate");
      expect(result.items[2]).toMatchObject({ kind: "todo", dueDate: "2026-06-08" });
      expect(warn).toHaveBeenCalledTimes(2);
      expect(String(warn.mock.calls[0][0])).toContain("brief(占位), judgmentKind, parentIndex, title");
      expect(String(warn.mock.calls[1][0])).toContain("dueDate");
    } finally {
      warn.mockRestore();
    }
  });

  it("D-42：负责人只对决定和待办生效；战略项带了对不上的负责人时整条保留、负责人为空", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const result = assess([
        { ...strategic, ownerPersonId: LEAD },
        { ...CANDIDATE.items[1], ownerPersonId: OWNER },
      ]);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.items).toHaveLength(1);
      expect(result.items[0]).toMatchObject({ kind: "strategic", title: strategic.title, judgmentKind: "company_direction", ownerPersonId: null });
      expect(String(warn.mock.calls[0][0])).toContain("#1 (strategic) 丢掉不适用的字段: ownerPersonId");
      // 待办照旧：负责人对不上就拒收
      expect(result.warnings.map((warning) => warning.reason)).toEqual([`owner 无法由该 turn 确定: ${OWNER}`]);
    } finally {
      warn.mockRestore();
    }
  });

  it("decision 顺手带了 judgmentKind 和 parentIndex：去掉这两个字段，作为主决定保留", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const decision = { kind: "decision", text: "CEO 去谈外部承诺", turnId: "turn-003", quote: "外部承诺我自己去谈" };
      const result = assess([
        CANDIDATE.items[2],
        // parentIndex 指向自己、指向 todo，都不是子决定
        { ...decision, judgmentKind: "external_commitment", parentIndex: 1 },
        { ...decision, judgmentKind: "major_risk", parentIndex: 0 },
        // 真的子决定照旧挂在主决定下
        { ...decision, text: "子决定", parentIndex: 1, judgmentKind: "company_direction" },
      ]);
      expect(result).toMatchObject({ ok: true, warnings: [] });
      if (!result.ok) return;
      expect(result.items.map((item) => [item.kind, item.judgmentKind, item.parentItemId])).toEqual([
        ["todo", null, null],
        ["decision", null, null],
        ["decision", null, null],
        ["decision", null, "item-2"],
      ]);
      expect(String(warn.mock.calls[0][0])).toContain("#2 (decision) 丢掉不适用的字段: judgmentKind, parentIndex");
      expect(String(warn.mock.calls[1][0])).toContain("#3 (decision) 丢掉不适用的字段: judgmentKind, parentIndex");
      expect(String(warn.mock.calls[2][0])).toContain("#4 (decision) 丢掉不适用的字段: judgmentKind");
    } finally {
      warn.mockRestore();
    }
  });

  it("「不适用」、null、空串、-1 这类占位值当没填，不废掉整份候选也不拒收这一条", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const placeholders = { ownerPersonId: "不适用", issueId: null, judgmentKind: "不适用", parentIndex: -1, title: "", brief: "N/A", dueDate: "无" };
      const result = assess([
        { kind: "decision", text: "CEO 去谈外部承诺", turnId: "turn-003", quote: "外部承诺我自己去谈", ...placeholders },
        { ...CANDIDATE.items[2], ...placeholders },
        { ...strategic, ...placeholders, title: strategic.title, brief: strategic.brief, judgmentKind: strategic.judgmentKind },
        // 战略项的必填项只填了占位，照旧按缺字段拒收
        { ...strategic, title: "不适用" },
      ]);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.items.map((item) => [item.kind, item.ownerPersonId, item.issueId, item.judgmentKind, item.parentItemId])).toEqual([
        ["decision", null, null, null, null],
        ["todo", null, null, null, null],
        ["strategic", null, null, "company_direction", null],
      ]);
      expect(result.items[1]).not.toHaveProperty("dueDate");
      expect(result.warnings.map((warning) => warning.reason)).toEqual(["strategic 缺少 title、brief 或 judgmentKind"]);
    } finally {
      warn.mockRestore();
    }
  });

  it("丢掉不适用字段之后，适用字段的真错误照旧拒收", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const result = assess([{ ...CANDIDATE.items[1], dueDate: "2026-02-30", judgmentKind: "company_direction" }]);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.items).toHaveLength(0);
      expect(result.warnings.map((warning) => warning.reason)).toEqual(["dueDate 不是有效日期: 2026-02-30"]);
      // 字段缺失、类型不对：整份候选不合 schema
      expect(assess([{ ...CANDIDATE.items[0], quote: undefined }])).toMatchObject({ ok: false });
      expect(assess([{ ...CANDIDATE.items[0], parentIndex: "0" }])).toMatchObject({ ok: false });
    } finally {
      warn.mockRestore();
    }
  });

  it("标题超过 40 字、说明超过 120 字、日期格式不对时整份候选不合 schema", () => {
    expect(assess([{ ...strategic, title: "长".repeat(41) }])).toMatchObject({ ok: false });
    expect(assess([{ ...strategic, brief: "长".repeat(121) }])).toMatchObject({ ok: false });
    expect(assess([{ ...CANDIDATE.items[0], dueDate: "6月8日" }])).toMatchObject({ ok: false });
    expect(assess([{ ...strategic, title: "长".repeat(40), brief: "长".repeat(120) }])).toMatchObject({ ok: true });
  });
});
