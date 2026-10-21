import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Client } from "pg";
import { Value } from "@sinclair/typebox/value";
import { Card, MeetingCardPayload, type TPreflightCandidate } from "@warmap/contracts";
import { buildApp } from "../src/app.js";
import { loadPeopleDirectory } from "../src/peopleDirectory.js";
import { migrate } from "../src/migrate.js";
import { createTestApp, createTestDb, preflightCandidate, seedTestAccess, testEnv, TEST_LOGIN, type TestApp } from "./helpers.js";
import { recoverInterruptedPreflight, runPreflight, type PreflightAgent, type PreflightAgentInput } from "../src/meetingPreflight.js";
import type { DriExportRequest } from "../src/meetingStore.js";

const MEETING_INPUT = {
  title: "渠道投入决策会",
  scheduledAt: "2026-06-01T10:00:00.000+08:00",
  leadDriId: "person-fixture-002",
  ceoParticipantId: "person-fixture-001",
  participants: ["person-fixture-002"],
};

type FakeAgent = PreflightAgent & { calls: PreflightAgentInput[] };

/** 可编排的 Preflight Agent：第 failFirst 次调用返回不合法 sourceRef，之后返回合法候选。 */
function fakeAgent(failFirst = false): FakeAgent {
  const agent = {
    calls: [] as PreflightAgentInput[],
    async generate(input: PreflightAgentInput) {
      agent.calls.push(input);
      if (failFirst && agent.calls.length === 1) {
        return { candidate: preflightCandidate(["memory:not-a-section"]) };
      }
      return { candidate: validCandidate(input), runId: `preflight-run-${agent.calls.length}` };
    },
  };
  return agent;
}

function validCandidate(input: PreflightAgentInput): TPreflightCandidate {
  const candidate = preflightCandidate(input.issues.map((issue) => `issue:${issue.id}`));
  candidate.entries[0].sourceRefs.push(`meeting:${input.meeting.id}`);
  return candidate;
}

async function createIssue(t: TestApp, externalId: string): Promise<{ id: string }> {
  const res = await t.app.inject({
    method: "POST",
    url: "/api/dri/issues",
    headers: { authorization: `Bearer ${t.env.driServiceToken}` },
    payload: {
      externalId,
      submitterPersonId: "person-fixture-002",
      title: `是否在六月前调整渠道投入（${externalId}）`,
      whyNow: "渠道窗口在六月关闭",
      sourceRef: `dri://planning/${externalId}`,
      location: { level: "battlefield", battlefieldId: "growth" },
    },
  });
  expect(res.statusCode).toBe(201);
  return { id: res.json().cards[0].objectRef.id as string };
}

async function cardAction(t: TestApp, cookie: string, url: string, actionType: string): Promise<string> {
  const res = await t.app.inject({ method: "GET", url, headers: { cookie } });
  const descriptor = res.json().cards[0].actions.find((action: { actionType: string }) => action.actionType === actionType);
  expect(descriptor, `${url} 应提供 ${actionType}`).toBeTruthy();
  return descriptor.actionId as string;
}

const issueAction = (t: TestApp, cookie: string, issueId: string, actionType: string) =>
  cardAction(t, cookie, `/api/cards/issues/${issueId}`, actionType);
const meetingAction = (t: TestApp, cookie: string, meetingId: string, actionType: string) =>
  cardAction(t, cookie, `/api/cards/meetings/${meetingId}`, actionType);

async function execute(t: TestApp, cookie: string, actionId: string, input?: unknown) {
  return t.app.inject({
    method: "POST",
    url: "/api/actions/execute",
    headers: { cookie, origin: t.publicOrigin },
    payload: { actionId, input },
  });
}

/** 用独立连接检查拒绝/冲突路径是否残留 idle-in-transaction（行锁泄漏）。 */
async function expectNoIdleInTransaction(t: TestApp): Promise<void> {
  const dbName = (await t.sql("SELECT current_database() AS db"))[0].db as string;
  const base = process.env.TEST_PG_URL ?? "postgres://postgres:postgres@localhost:54329/postgres";
  const probe = new Client({ connectionString: base.replace(/\/postgres$/, `/${dbName}`) });
  try {
    await probe.connect();
    const idle = await probe.query(
      "SELECT count(*)::int AS count FROM pg_stat_activity WHERE state LIKE 'idle in transaction%' AND datname = $1",
      [dbName],
    );
    expect(Number(idle.rows[0].count)).toBe(0);
  } finally {
    await probe.end();
  }
}

/** 从 Issue 创建一个 preflight ready 的 scheduled Meeting。 */
async function readyMeeting(t: TestApp, externalId: string): Promise<{
  cookie: string; issueId: string; meetingId: string; card: Record<string, unknown>;
}> {
  const issue = await createIssue(t, externalId);
  const cookie = await t.loginCookie();
  const created = await execute(t, cookie, await issueAction(t, cookie, issue.id, "issue.create_meeting"), {
    ...MEETING_INPUT,
    issueIds: [issue.id],
  });
  expect(created.statusCode).toBe(200);
  return { cookie, issueId: issue.id, meetingId: created.json().cards[0].objectRef.id as string, card: created.json().cards[0] };
}

describe("会前材料替换后的预审 Context", () => {
  it("上传新材料后预审只用 新材料+Issue 标题，不再注入旧研究结果", async () => {
    const agent = fakeAgent();
    const t = await createTestApp({}, undefined, { preflightAgent: agent });
    try {
      const issue = await createIssue(t, "dri-preflight-ctx");
      await t.sql("UPDATE issues SET research = $2::jsonb WHERE id = $1", [
        issue.id,
        JSON.stringify({ status: "ready", pendingSince: null, runId: "run-old", previousRunIds: [], error: null, doc: { summary: "旧研究结论", options: [], evidence: [], unknowns: [], sources: [] } }),
      ]);
      const cookie = await t.loginCookie();
      const created = await execute(t, cookie, await issueAction(t, cookie, issue.id, "issue.create_meeting"), {
        ...MEETING_INPUT,
        issueIds: [issue.id],
      });
      expect(created.statusCode).toBe(200);
      const meetingId = created.json().cards[0].objectRef.id as string;

      // 无材料时：旧研究结果进入 Context
      expect(agent.calls[0].materials).toHaveLength(0);
      expect((agent.calls[0].issues[0].research as { doc?: unknown }).doc).toBeTruthy();

      // 真实替换链路：预审 ready 后先「返回编辑材料」解锁，再上传新材料
      const unlocked = await execute(t, cookie, await meetingAction(t, cookie, meetingId, "meeting.edit_materials"), {});
      expect(unlocked.statusCode).toBe(200);
      const boundary = "----preflight-ctx";
      const res = await t.app.inject({
        method: "POST",
        url: `/api/meetings/${meetingId}/materials`,
        headers: { cookie, origin: t.publicOrigin, "content-type": `multipart/form-data; boundary=${boundary}` },
        payload: Buffer.concat([
          Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="新材料.md"\r\nContent-Type: text/markdown\r\n\r\n`),
          Buffer.from("替换后的会前材料正文"),
          Buffer.from(`\r\n--${boundary}--\r\n`),
        ]),
      });
      expect(res.statusCode).toBe(200);
      const rerun = await execute(t, cookie, await meetingAction(t, cookie, meetingId, "meeting.run_preflight"), {});
      expect(rerun.statusCode).toBe(200);
      const last = agent.calls.at(-1)!;
      expect(last.materials.length).toBeGreaterThan(0);
      expect(last.materials[0].extractedText).toContain("替换后的会前材料正文");
      expect(last.issues[0].title).toContain("渠道投入");
      expect(last.issues[0].research).toBeNull();
    } finally {
      await t.close();
    }
  });
});

describe("Issue → Meeting Card/Action user journey", () => {
  it("creates a scheduled Meeting from an Issue and projects the same object on the card, notification and conversation", async () => {
    const agent = fakeAgent();
    const t = await createTestApp({}, undefined, { preflightAgent: agent, monthlyNow: () => new Date("2026-05-31T00:00:00Z") });
    try {
      const issue = await createIssue(t, "dri-meeting-001");
      const cookie = await t.loginCookie();

      const created = await execute(t, cookie, await issueAction(t, cookie, issue.id, "issue.create_meeting"), {
        ...MEETING_INPUT,
        issueIds: [issue.id],
      });
      expect(created.statusCode).toBe(200);
      const meetingCard = created.json().cards[0];
      expect(Value.Check(Card, meetingCard)).toBe(true);
      expect(Value.Check(MeetingCardPayload, meetingCard.payload)).toBe(true);
      expect(meetingCard.kind).toBe("meeting");
      const payload = meetingCard.payload;
      expect(payload.status).toBe("scheduled");
      expect(payload.issueIds).toEqual([issue.id]);
      expect(payload.preflight.status).toBe("ready");
      expect(payload.preflight.entries.map((entry: { id: string }) => entry.id)).toEqual([
        "entry-1", "entry-2", "entry-3", "entry-4", "entry-5", "entry-6", "entry-7",
      ]);
      expect(payload.preflight).toMatchObject({
        readiness: "revise",
        inputCoverage: { background: "available", purpose: "derived", relatedMeeting: "missing" },
        taskDefinition: { primaryRole: "research_analysis", maturity: "internal_alignment" },
      });
      // CEO 身份可确定识别，participant 保存创建时的身份快照
      expect(payload.ceoParticipantId).toBe("person-fixture-001");
      expect(payload.participants).toEqual(expect.arrayContaining([
        expect.objectContaining({ personId: "person-fixture-001", displayName: "测试甲", roles: ["ceo"] }),
        expect.objectContaining({ personId: "person-fixture-002", displayName: "测试乙", roles: ["dri", "participant"] }),
      ]));
      expect(meetingCard.conversation).toEqual({ scope: `meeting:${meetingCard.objectRef.id}` });
      expect(meetingCard.actions.map((action: { actionType: string }) => action.actionType))
        .toEqual(expect.arrayContaining(["meeting.update_draft", "meeting.request_supplement", "meeting.cancel"]));
      expect(meetingCard.actions.map((action: { actionType: string }) => action.actionType)).not.toContain("meeting.retry_preflight");

      // 对象页面：同一 Meeting Card
      const detail = await t.app.inject({ method: "GET", url: `/api/cards/meetings/${meetingCard.objectRef.id}`, headers: { cookie } });
      expect(detail.statusCode).toBe(200);
      expect(detail.json().cards[0].objectRef).toEqual(meetingCard.objectRef);

      // 会前通知：同一 projector、同一对象
      const notifications = await t.app.inject({ method: "GET", url: "/api/cards/notifications", headers: { cookie } });
      const notification = notifications.json().cards.find((card: { objectRef: { id: string } }) => card.objectRef.id === meetingCard.objectRef.id);
      expect(notification).toMatchObject({ id: meetingCard.id, version: meetingCard.version, conversation: meetingCard.conversation });

      // 独立 Conversation：meeting scope 可用，引用由后端生成可信快照
      const scope = `meeting:${meetingCard.objectRef.id}`;
      const history = await t.app.inject({ method: "GET", url: `/api/conversations/${scope}/messages`, headers: { cookie } });
      expect(history.statusCode).toBe(200);
      const sent = await t.app.inject({
        method: "POST",
        url: `/api/conversations/${scope}/messages`,
        headers: { cookie, origin: t.publicOrigin },
        payload: { message: "先看哪条依据？", references: [{ cardId: meetingCard.id, version: meetingCard.version }] },
      });
      expect(sent.statusCode).toBe(200);
      const state = await t.conversationState(scope);
      expect(state.messages[0].references_snapshot[0]).toMatchObject({
        cardId: meetingCard.id,
        kind: "meeting",
        payload: { status: "scheduled" },
      });
      const conversationRun = (await t.agentRuns()).find((run) => run.kind === "conversation");
      expect(conversationRun?.input_snapshot).toMatchObject({
        currentObject: {
          cardId: meetingCard.id,
          payload: {
            preflight: { status: "ready", readiness: "revise" },
            linkedIssues: [{ cardId: `issue:${issue.id}`, title: expect.stringContaining("是否在六月前调整渠道投入") }],
          },
        },
      });

      // Agent 只在创建时运行一次，输入包含关联 Issue
      expect(agent.calls).toHaveLength(1);
      expect(agent.calls[0].issues[0]).toMatchObject({ id: issue.id });
    } finally {
      await t.close();
    }
  });

  it("regenerates the preflight and clears stale checks when an Issue joins", async () => {
    const t = await createTestApp({}, undefined, { preflightAgent: fakeAgent() });
    try {
      const { cookie, issueId, meetingId } = await readyMeeting(t, "dri-join-100");
      await execute(t, cookie, await meetingAction(t, cookie, meetingId, "meeting.update_draft"), { checkedEntryIds: ["entry-1"] });
      const second = await createIssue(t, "dri-join-101");

      const joined = await execute(t, cookie, await issueAction(t, cookie, second.id, "issue.join_meeting"), { meetingId });
      expect(joined.statusCode).toBe(200);
      const payload = joined.json().cards[0].payload;
      expect(payload.issueIds).toEqual(expect.arrayContaining([issueId, second.id]));
      // 会前材料覆盖当前全部关联 Issue
      expect(payload.preflight.status).toBe("ready");
      const refs = payload.preflight.entries.flatMap((entry: { sourceRefs: string[] }) => entry.sourceRefs);
      expect(refs).toContain(`issue:${issueId}`);
      expect(refs).toContain(`issue:${second.id}`);
      // 条目整体重建：旧核对自动失效，不留下指向旧表述的确认
      expect(payload.draft.checkedEntryIds).toEqual([]);
    } finally {
      await t.close();
    }
  });

  it("releases the row lock on rejected and conflicting actions so later actions still succeed", async () => {
    const t = await createTestApp({}, undefined, { preflightAgent: fakeAgent() });
    try {
      const { cookie, meetingId } = await readyMeeting(t, "dri-lock-100");
      const bad = await execute(t, cookie, await meetingAction(t, cookie, meetingId, "meeting.update_draft"), {
        checkedEntryIds: ["entry-99"],
      });
      expect(bad.statusCode).toBe(400);
      await expectNoIdleInTransaction(t);

      // 同一 Meeting 的下一个 Action 不能被上一次拒绝的 Action 阻塞
      const after = await execute(t, cookie, await meetingAction(t, cookie, meetingId, "meeting.update_draft"), { note: "重新保存" });
      expect(after.statusCode).toBe(200);

      // version 冲突路径（stale join）同样必须结束事务
      const second = await createIssue(t, "dri-lock-101");
      const joinAction = await issueAction(t, cookie, second.id, "issue.join_meeting");
      await t.sql("UPDATE issues SET version = version + 1 WHERE id = $1", [second.id]);
      const stale = await execute(t, cookie, joinAction, { meetingId });
      expect(stale.statusCode).toBe(409);
      await expectNoIdleInTransaction(t);
      const stillWorks = await execute(t, cookie, await meetingAction(t, cookie, meetingId, "meeting.update_draft"), { note: "冲突后仍可保存" });
      expect(stillWorks.statusCode).toBe(200);
    } finally {
      await t.close();
    }
  });

  it("rejects stale or dismissed-issue meeting actions with the latest issue card", async () => {
    const t = await createTestApp({}, undefined, { preflightAgent: fakeAgent() });
    try {
      const { cookie, meetingId } = await readyMeeting(t, "dri-stale-100");

      // 旧 actionId：Issue 已变化后不能再新建 Meeting
      const issue = await createIssue(t, "dri-stale-101");
      const stale = await issueAction(t, cookie, issue.id, "issue.create_meeting");
      await t.sql("UPDATE issues SET version = version + 1 WHERE id = $1", [issue.id]);
      const res = await execute(t, cookie, stale, { ...MEETING_INPUT, issueIds: [issue.id] });
      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe("VERSION_CONFLICT");
      expect(res.json().latestCard.id).toBe(`issue:${issue.id}`);

      // 旧 actionId：Issue 已变化后不能再加入 Meeting
      const joiner = await createIssue(t, "dri-stale-102");
      const joinAction = await issueAction(t, cookie, joiner.id, "issue.join_meeting");
      await t.sql("UPDATE issues SET version = version + 1 WHERE id = $1", [joiner.id]);
      const joined = await execute(t, cookie, joinAction, { meetingId });
      expect(joined.statusCode).toBe(409);
      expect(joined.json().latestCard.id).toBe(`issue:${joiner.id}`);
      expect((await t.sql("SELECT issue_ids FROM meetings WHERE id = $1", [meetingId]))[0].issue_ids).not.toContain(joiner.id);
    } finally {
      await t.close();
    }
  });

  it("treats joining an Issue that is already in the Meeting as a no-op", async () => {
    const agent = fakeAgent();
    const t = await createTestApp({}, undefined, { preflightAgent: agent });
    try {
      const { cookie, meetingId } = await readyMeeting(t, "dri-noop-100");
      const second = await createIssue(t, "dri-noop-101");
      expect((await execute(t, cookie, await issueAction(t, cookie, second.id, "issue.join_meeting"), { meetingId })).statusCode).toBe(200);
      const callsAfterJoin = agent.calls.length;
      await execute(t, cookie, await meetingAction(t, cookie, meetingId, "meeting.update_draft"), { checkedEntryIds: ["entry-1"] });

      // Issue 版本变化后再次加入同一 Meeting：不得重跑预审或清掉核对
      await t.sql("UPDATE issues SET version = version + 1 WHERE id = $1", [second.id]);
      const again = await execute(t, cookie, await issueAction(t, cookie, second.id, "issue.join_meeting"), { meetingId });
      expect(again.statusCode).toBe(200);
      expect(agent.calls.length).toBe(callsAfterJoin);
      expect(again.json().cards[0].payload.draft.checkedEntryIds).toEqual(["entry-1"]);
    } finally {
      await t.close();
    }
  });

  it("joins an existing scheduled Meeting from another Issue and stays idempotent on replay", async () => {
    const agent = fakeAgent();
    const t = await createTestApp({}, undefined, { preflightAgent: agent });
    try {
      const { cookie, meetingId } = await readyMeeting(t, "dri-meeting-002");
      const second = await createIssue(t, "dri-meeting-003");

      const joinAction = await issueAction(t, cookie, second.id, "issue.join_meeting");
      const joined = await execute(t, cookie, joinAction, { meetingId });
      expect(joined.statusCode).toBe(200);
      expect(joined.json().cards[0].payload.issueIds).toEqual(expect.arrayContaining([second.id]));

      // 重放同一 Action：不产生第二次加入
      const replay = await execute(t, cookie, joinAction, { meetingId });
      expect(replay.statusCode).toBe(200);
      const row = (await t.sql("SELECT issue_ids FROM meetings WHERE id = $1", [meetingId]))[0];
      expect((row.issue_ids as string[]).filter((id) => id === second.id)).toHaveLength(1);

      // 加入不存在的 Meeting 被拒绝
      const missing = await execute(t, cookie, joinAction, { meetingId: "00000000-0000-4000-8000-000000000000" });
      expect(missing.statusCode).toBe(404);
    } finally {
      await t.close();
    }
  });
});

describe("DRI service Meeting import", () => {
  function post(t: TestApp, payload: unknown, token = t.env.driServiceToken) {
    return t.app.inject({
      method: "POST",
      url: "/api/dri/meetings",
      headers: { authorization: `Bearer ${token}` },
      payload: payload as Record<string, unknown>,
    });
  }

  it("rejects anonymous, wrong-token and CEO-session callers", async () => {
    const t = await createTestApp();
    try {
      expect((await t.app.inject({ method: "POST", url: "/api/dri/meetings", payload: {} })).statusCode).toBe(401);
      const cookie = await t.loginCookie();
      const ceoSession = await t.app.inject({ method: "POST", url: "/api/dri/meetings", headers: { cookie }, payload: {} });
      expect(ceoSession.statusCode).toBe(401);
    } finally {
      await t.close();
    }
  });

  it("imports legal metadata into a scheduled Meeting with identity snapshots and returns the same object on replay", async () => {
    const agent = fakeAgent();
    const t = await createTestApp({}, undefined, { preflightAgent: agent });
    try {
      const issue = await createIssue(t, "dri-meeting-100");
      const body = { ...MEETING_INPUT, externalId: "dri-meeting-100", issueIds: [issue.id] };

      const first = await post(t, body);
      expect(first.statusCode).toBe(201);
      const card = first.json().cards[0];
      expect(Value.Check(Card, card)).toBe(true);
      expect(card.payload).toMatchObject({
        status: "scheduled",
        // 未给 endsAt：按开始后 60 分钟补齐
        endsAt: "2026-06-01T03:00:00.000Z",
        endedAt: null,
        preflight: { status: "ready" },
        originRef: { type: "dri", externalId: "dri-meeting-100" },
      });
      expect(card.payload.participants).toEqual(expect.arrayContaining([
        expect.objectContaining({ personId: "person-fixture-001", roles: ["ceo"] }),
      ]));

      const replay = await post(t, body);
      expect(replay.statusCode).toBe(200);
      expect(replay.json().cards[0].objectRef).toEqual(card.objectRef);
      expect(await t.sql("SELECT count(*)::int AS count FROM meetings")).toEqual([{ count: 1 }]);

      const conflict = await post(t, { ...body, title: "改了标题" });
      expect(conflict.statusCode).toBe(409);
      expect(conflict.json().code).toBe("DRI_MEETING_EXTERNAL_ID_CONFLICT");
    } finally {
      await t.close();
    }
  });

  it.each([
    ["未知 participant", (body: Record<string, unknown>) => ({ ...body, participants: ["person-looked-up-by-name"] })],
    ["ceoParticipantId 没有 ceo 角色", (body: Record<string, unknown>) => ({ ...body, ceoParticipantId: "person-fixture-002" })],
    ["leadDriId 没有 dri 角色", (body: Record<string, unknown>) => ({ ...body, leadDriId: "person-fixture-001" })],
    ["引用不存在的 Issue", (body: Record<string, unknown>) => ({ ...body, issueIds: ["00000000-0000-4000-8000-000000000001"] })],
    ["scheduledAt 不可解析", (body: Record<string, unknown>) => ({ ...body, scheduledAt: "下周三下午" })],
    ["endsAt 不晚于 scheduledAt", (body: Record<string, unknown>) => ({ ...body, endsAt: body.scheduledAt })],
  ])("rejects %s before creating a Meeting", async (_label, mutate) => {
    const t = await createTestApp();
    try {
      const issue = await createIssue(t, "dri-meeting-200");
      const body = mutate({ ...MEETING_INPUT, externalId: "dri-meeting-200", issueIds: [issue.id] });
      const res = await t.app.inject({
        method: "POST",
        url: "/api/dri/meetings",
        headers: { authorization: `Bearer ${t.env.driServiceToken}` },
        payload: body as Record<string, unknown>,
      });
      expect(res.statusCode).toBe(400);
      expect(await t.sql("SELECT count(*)::int AS count FROM meetings")).toEqual([{ count: 0 }]);
    } finally {
      await t.close();
    }
  });
});

describe("Candidate Preflight", () => {
  it("clears stale checks when a triggered preflight regeneration fails", async () => {
    let calls = 0;
    const agent: PreflightAgent = {
      async generate(input) {
        calls += 1;
        if (calls === 2) throw new Error("model down");
        return { candidate: validCandidate(input) };
      },
    };
    const t = await createTestApp({}, undefined, { preflightAgent: agent });
    try {
      const { cookie, meetingId } = await readyMeeting(t, "dri-fail-regen-100");
      await execute(t, cookie, await meetingAction(t, cookie, meetingId, "meeting.update_draft"), { checkedEntryIds: ["entry-1", "entry-2"] });
      const second = await createIssue(t, "dri-fail-regen-101");

      const joined = await execute(t, cookie, await issueAction(t, cookie, second.id, "issue.join_meeting"), { meetingId });
      expect(joined.statusCode).toBe(200);
      expect(joined.json().cards[0].payload.preflight).toMatchObject({ status: "failed", error: { code: "preflight_agent_failed" } });
      // 旧条目即将被重建：核对必须失效
      expect(joined.json().cards[0].payload.draft.checkedEntryIds).toEqual([]);
    } finally {
      await t.close();
    }
  });

  it("aborts a hung preflight agent and records a visible failure", async () => {
    await createTestDb(async ({ db, pool }) => {
      await migrate(db);
      const meetingId = randomUUID();
      await db.query(
        `INSERT INTO meetings
           (id, version, title, status, scheduled_at, ends_at, lead_dri_id, ceo_participant_id,
            participants, issue_ids, preflight, draft, origin_ref)
         VALUES ($1, 1, '挂起预审', 'scheduled', now(), now() + interval '60 minutes', 'person-fixture-002', 'person-fixture-001',
                 '[]'::jsonb, '[]'::jsonb, $2::jsonb, $3::jsonb, '{}'::jsonb)`,
        [
          meetingId,
          JSON.stringify({ status: "pending", pendingSince: new Date().toISOString(), runId: null, entries: [], basis: "", brief: "", error: null, generatedAt: null }),
          JSON.stringify({ readIssueIds: [], carriedIssueIds: [], checkedEntryIds: [], editsByEntryId: {}, supplementRequests: [], note: "" }),
        ],
      );
      const agent: PreflightAgent = {
        generate: (_input, signal) => new Promise((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        }),
      };
      await runPreflight(pool, loadPeopleDirectory(testEnv), agent, meetingId, { timeoutMs: 30 });
      const row = await db.query("SELECT preflight FROM meetings WHERE id = $1", [meetingId]);
      expect(row.rows[0].preflight).toMatchObject({ status: "failed", error: { code: "preflight_agent_failed" } });
      expect(String((row.rows[0].preflight as { error: { message: string } }).error.message)).toContain("Preflight exceeded 30ms");
    });
  });

  it("fails visibly on an invalid candidate and only regenerates on an explicit retry", async () => {
    const agent = fakeAgent(true);
    const t = await createTestApp({}, undefined, { preflightAgent: agent });
    try {
      const { cookie, meetingId, card } = await readyMeeting(t, "dri-meeting-300");
      expect(card.payload.status).toBe("scheduled");
      expect(card.payload.preflight).toMatchObject({
        status: "failed",
        error: { code: "invalid_source_ref" },
        entries: [],
      });
      expect(card.actions.map((action: { actionType: string }) => action.actionType)).toContain("meeting.retry_preflight");
      // 失败可见且不自动重试
      expect(agent.calls).toHaveLength(1);

      const retryAction = await meetingAction(t, cookie, meetingId, "meeting.retry_preflight");
      const retried = await execute(t, cookie, retryAction);
      expect(retried.statusCode).toBe(200);
      expect(retried.json().cards[0].payload.preflight).toMatchObject({ status: "ready", error: null });
      expect(agent.calls).toHaveLength(2);

      // 重放同一 retry Action：幂等返回，不再调用 Agent
      const replay = await execute(t, cookie, retryAction);
      expect(replay.statusCode).toBe(200);
      expect(replay.json().cards[0].payload.preflight.status).toBe("ready");
      expect(agent.calls).toHaveLength(2);
    } finally {
      await t.close();
    }
  });

  it("regenerates a ready advisor preflight only through the explicit action", async () => {
    const agent = fakeAgent();
    const t = await createTestApp({}, undefined, { preflightAgent: agent });
    try {
      const { cookie, meetingId, card } = await readyMeeting(t, "dri-meeting-regenerate");
      expect(card.actions.map((action: { actionType: string }) => action.actionType)).toContain("meeting.regenerate_preflight");
      await execute(t, cookie, await meetingAction(t, cookie, meetingId, "meeting.update_draft"), { checkedEntryIds: ["entry-1"] });

      const regenerate = await meetingAction(t, cookie, meetingId, "meeting.regenerate_preflight");
      const regenerated = await execute(t, cookie, regenerate);
      expect(regenerated.statusCode).toBe(200);
      expect(regenerated.json().cards[0].payload).toMatchObject({
        preflight: { status: "ready", readiness: "revise", taskDefinition: { primaryRole: "research_analysis" } },
        draft: { checkedEntryIds: [] },
      });
      expect(agent.calls).toHaveLength(2);

      const replay = await execute(t, cookie, regenerate);
      expect(replay.statusCode).toBe(200);
      expect(agent.calls).toHaveLength(2);
    } finally {
      await t.close();
    }
  });

  it("injects the latest related historical Meeting and Transcript into the four-input context", async () => {
    const agent = fakeAgent();
    const t = await createTestApp({}, undefined, { preflightAgent: agent });
    try {
      const first = await readyMeeting(t, "dri-meeting-history");
      await t.sql(
        "UPDATE meetings SET status = 'held', transcript = $2::jsonb WHERE id = $1",
        [first.meetingId, JSON.stringify({ schemaVersion: "warmap-transcript.v1", meetingId: first.meetingId, turns: [{ id: "turn-1", speakerId: "person-fixture-001", text: "先验证渠道窗口" }] })],
      );
      const second = await execute(t, first.cookie, await issueAction(t, first.cookie, first.issueId, "issue.create_meeting"), {
        ...MEETING_INPUT,
        title: "渠道投入复议会",
        scheduledAt: "2026-06-08T10:00:00.000+08:00",
        issueIds: [first.issueId],
      });
      expect(second.statusCode).toBe(200);
      expect(agent.calls).toHaveLength(2);
      expect(agent.calls[1]).toMatchObject({
        inputCoverage: { relatedMeeting: "available" },
        relatedMeetings: [{ id: first.meetingId, status: "held", matchedBy: expect.arrayContaining(["shared_issue"]),
          sourceRefs: [`meeting:${first.meetingId}`, `transcript:${first.meetingId}`] }],
      });
    } finally {
      await t.close();
    }
  });

  it("keeps the Meeting scheduled when the Preflight Agent throws", async () => {
    const agent: PreflightAgent = { async generate() { throw new Error("model unreachable"); } };
    const t = await createTestApp({}, undefined, { preflightAgent: agent });
    try {
      const issue = await createIssue(t, "dri-meeting-301");
      const cookie = await t.loginCookie();
      const created = await execute(t, cookie, await issueAction(t, cookie, issue.id, "issue.create_meeting"), {
        ...MEETING_INPUT,
        issueIds: [issue.id],
      });
      expect(created.statusCode).toBe(200);
      expect(created.json().cards[0].payload).toMatchObject({
        status: "scheduled",
        preflight: { status: "failed", error: { code: "preflight_agent_failed" } },
      });
    } finally {
      await t.close();
    }
  });
});

  it("rejects a CEO question that cannot say why now / why CEO", async () => {
    const agent: PreflightAgent = {
      async generate(input) {
        const candidate = preflightCandidate(input.issues.map((issue) => `issue:${issue.id}`));
        candidate.entries = candidate.entries.map((entry) => {
          if (entry.kind !== "leader_lens") return entry;
          const { ceoDecision: _dropped, ...rest } = entry;
          return rest;
        });
        return { candidate };
      },
    };
    const t = await createTestApp({}, undefined, { preflightAgent: agent });
    try {
      const { card } = await readyMeeting(t, "dri-meeting-invalid-structure");
      expect(card.payload.preflight).toMatchObject({
        status: "failed",
        error: { code: "invalid_preflight_candidate", message: "leader_lens「华南转化依据」必须说明为什么现在、为什么需要 CEO 判断" },
      });
    } finally {
      await t.close();
    }
  });

  it("rejects a leader_lens statement that falls back to disclaimer wording", async () => {
    const agent: PreflightAgent = {
      async generate(input) {
        const candidate = preflightCandidate(input.issues.map((issue) => `issue:${issue.id}`));
        candidate.entries = candidate.entries.map((entry) =>
          entry.kind === "leader_lens" ? { ...entry, body: "视角预判，非权威发言：首先追问代价" } : entry,
        );
        return { candidate };
      },
    };
    const t = await createTestApp({}, undefined, { preflightAgent: agent });
    try {
      const { card } = await readyMeeting(t, "dri-meeting-lens-disclaimer");
      expect(card.payload.preflight).toMatchObject({
        status: "failed",
        error: { code: "invalid_preflight_candidate", message: "leader_lens 不得出现“视角预判”“非权威发言”" },
      });
    } finally {
      await t.close();
    }
  });

  it("rejects a candidate whose visible prose uses a turn phrase", async () => {
    const agent: PreflightAgent = {
      async generate(input) {
        const candidate = preflightCandidate(input.issues.map((issue) => `issue:${issue.id}`));
        candidate.entries = candidate.entries.map((entry) =>
          entry.kind === "core_judgment" ? { ...entry, body: "这不是材料问题，而是决策节奏问题" } : entry,
        );
        return { candidate };
      },
    };
    const t = await createTestApp({}, undefined, { preflightAgent: agent });
    try {
      const { card } = await readyMeeting(t, "dri-meeting-turn-phrase");
      expect(card.payload.preflight).toMatchObject({
        status: "failed",
        error: { code: "invalid_preflight_candidate", message: "Preflight 出现翻案句：不是……而是……" },
      });
    } finally {
      await t.close();
    }
  });

  describe("persistent read/checked/carry state", () => {
  it("persists read, carried, checked and note state across page visits", async () => {
    const t = await createTestApp({}, undefined, { preflightAgent: fakeAgent() });
    try {
      const { cookie, issueId, meetingId } = await readyMeeting(t, "dri-meeting-400");
      const saved = await execute(t, cookie, await meetingAction(t, cookie, meetingId, "meeting.update_draft"), {
        readIssueIds: [issueId],
        carriedIssueIds: [issueId],
        checkedEntryIds: ["entry-1", "entry-2"],
        note: "会上先谈渠道投入",
      });
      expect(saved.statusCode).toBe(200);
      expect(saved.json().cards[0].payload.draft).toMatchObject({
        readIssueIds: [issueId],
        carriedIssueIds: [issueId],
        checkedEntryIds: ["entry-1", "entry-2"],
        note: "会上先谈渠道投入",
      });

      const revisited = await t.app.inject({ method: "GET", url: `/api/cards/meetings/${meetingId}`, headers: { cookie } });
      expect(revisited.json().cards[0].payload.draft.checkedEntryIds).toEqual(["entry-1", "entry-2"]);
    } finally {
      await t.close();
    }
  });

  it("clears the check of an entry as soon as its content is edited", async () => {
    const t = await createTestApp({}, undefined, { preflightAgent: fakeAgent() });
    try {
      const { cookie, issueId, meetingId } = await readyMeeting(t, "dri-meeting-401");
      const checked = await execute(t, cookie, await meetingAction(t, cookie, meetingId, "meeting.update_draft"), {
        readIssueIds: [issueId],
        checkedEntryIds: ["entry-1"],
      });
      expect(checked.statusCode).toBe(200);

      const edited = await execute(t, cookie, await meetingAction(t, cookie, meetingId, "meeting.update_draft"), {
        editsByEntryId: { "entry-1": "改写后的核对表述" },
      });
      expect(edited.statusCode).toBe(200);
      const draft = edited.json().cards[0].payload.draft;
      expect(draft.editsByEntryId).toEqual({ "entry-1": "改写后的核对表述" });
      expect(draft.checkedEntryIds).toEqual([]);
    } finally {
      await t.close();
    }
  });

  it("rejects draft state that references unknown issues or entries, and reports version conflicts with the latest card", async () => {
    const t = await createTestApp({}, undefined, { preflightAgent: fakeAgent() });
    try {
      const { cookie, issueId, meetingId } = await readyMeeting(t, "dri-meeting-402");
      const bad = await execute(t, cookie, await meetingAction(t, cookie, meetingId, "meeting.update_draft"), {
        readIssueIds: [issueId],
        checkedEntryIds: ["entry-99"],
      });
      expect(bad.statusCode).toBe(400);
      expect(bad.json().code).toBe("INVALID_DRAFT");

      const staleAction = await meetingAction(t, cookie, meetingId, "meeting.update_draft");
      const first = await execute(t, cookie, staleAction, { note: "第一版" });
      expect(first.statusCode).toBe(200);
      const conflict = await execute(t, cookie, staleAction, { note: "旧版本上的另一份修改" });
      expect(conflict.statusCode).toBe(409);
      expect(conflict.json().code).toBe("VERSION_CONFLICT");
      expect(conflict.json().latestCard.id).toBe(`meeting:${meetingId}`);
    } finally {
      await t.close();
    }
  });
});

describe("Supplement Request honest export status", () => {
  it("keeps pending_export when no real channel is configured and never claims delivered", async () => {
    const t = await createTestApp({}, undefined, { preflightAgent: fakeAgent() });
    try {
      const { cookie, meetingId } = await readyMeeting(t, "dri-supplement-001");
      const res = await execute(t, cookie, await meetingAction(t, cookie, meetingId, "meeting.request_supplement"), {
        entryId: "entry-1",
        targetDriId: "person-fixture-002",
        text: "请补充六月渠道申报口径",
      });
      expect(res.statusCode).toBe(200);
      const requests = res.json().cards[0].payload.draft.supplementRequests;
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({
        targetDriId: "person-fixture-002",
        entryId: "entry-1",
        exportStatus: "pending_export",
        exportRef: null,
      });
      expect(JSON.stringify(requests)).not.toContain('"delivered"');
    } finally {
      await t.close();
    }
  });

  it("records delivered only from a real channel receipt and failed when the channel errors", async () => {
    let calls = 0;
    const exporter = {
      calls: [] as DriExportRequest[],
      async export(request: DriExportRequest): Promise<{ exportRef: string }> {
        calls += 1;
        exporter.calls.push(request);
        if (calls === 1) return { exportRef: "dri-msg-001" };
        throw new Error("dri channel unreachable");
      },
    };
    const t = await createTestApp({}, undefined, { preflightAgent: fakeAgent(), driExporter: exporter });
    try {
      const { cookie, meetingId } = await readyMeeting(t, "dri-supplement-002");
      const delivered = await execute(t, cookie, await meetingAction(t, cookie, meetingId, "meeting.request_supplement"), {
        targetDriId: "person-fixture-002",
        text: "请补充证据",
      });
      expect(delivered.statusCode).toBe(200);
      expect(delivered.json().cards[0].payload.draft.supplementRequests[0]).toMatchObject({
        exportStatus: "delivered",
        exportRef: "dri-msg-001",
      });

      const failed = await execute(t, cookie, await meetingAction(t, cookie, meetingId, "meeting.request_supplement"), {
        targetDriId: "person-fixture-002",
        text: "第二份请求",
      });
      expect(failed.json().cards[0].payload.draft.supplementRequests[1]).toMatchObject({
        exportStatus: "failed",
        exportRef: null,
        error: "dri channel unreachable",
      });

      // 重放第一次请求：幂等返回，不重新外发
      expect(exporter.calls).toHaveLength(2);
    } finally {
      await t.close();
    }
  });

  it("rejects an unknown targetDriId without saving a request", async () => {
    const t = await createTestApp({}, undefined, { preflightAgent: fakeAgent() });
    try {
      const { cookie, meetingId } = await readyMeeting(t, "dri-supplement-003");
      const unknown = await execute(t, cookie, await meetingAction(t, cookie, meetingId, "meeting.request_supplement"), {
        targetDriId: "person-not-in-seed",
        text: "x",
      });
      expect(unknown.statusCode).toBe(400);
      expect(unknown.json().code).toBe("INVALID_PARTICIPANT");
      expect((await t.sql("SELECT draft FROM meetings WHERE id = $1", [meetingId]))[0].draft.supplementRequests).toHaveLength(0);
    } finally {
      await t.close();
    }
  });
});

describe("cancel a scheduled Meeting", () => {
  async function setup(t: TestApp) {
    const { cookie, meetingId, card } = await readyMeeting(t, `dri-cancel-${Math.random().toString(36).slice(2, 8)}`);
    const action = (actionType: string) => {
      const descriptor = card.actions.find((a: { actionType: string }) => a.actionType === actionType);
      expect(descriptor).toBeTruthy();
      return (descriptor as { actionId: string }).actionId;
    };
    return { cookie, meetingId, cancelAction: action("meeting.cancel"), draftAction: action("meeting.update_draft"), supplementAction: action("meeting.request_supplement") };
  }

  it("cancels only a scheduled Meeting and removes it from pre-meeting notifications", async () => {
    const t = await createTestApp({}, undefined, { preflightAgent: fakeAgent() });
    try {
      const { cookie, meetingId, cancelAction } = await setup(t);
      const cancelled = await execute(t, cookie, cancelAction);
      expect(cancelled.statusCode).toBe(200);
      expect(cancelled.json().cards[0].payload.status).toBe("cancelled");
      expect(cancelled.json().cards[0].actions).toEqual([]);

      const replay = await execute(t, cookie, cancelAction);
      expect(replay.statusCode).toBe(200);
      expect((await t.sql("SELECT count(*)::int AS count FROM meetings WHERE status = 'cancelled'"))[0]).toEqual({ count: 1 });

      const notifications = await t.app.inject({ method: "GET", url: "/api/cards/notifications", headers: { cookie } });
      expect(notifications.json().cards.some((card: { objectRef: { id: string } }) => card.objectRef.id === meetingId)).toBe(false);
    } finally {
      await t.close();
    }
  });

  it.each(["held", "reviewed"] as const)("refuses to cancel a %s Meeting", async (status) => {
    const t = await createTestApp({}, undefined, { preflightAgent: fakeAgent() });
    try {
      const { cookie, meetingId, cancelAction } = await setup(t);
      await t.sql("UPDATE meetings SET status = $2 WHERE id = $1", [meetingId, status]);
      const res = await execute(t, cookie, cancelAction);
      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe("MEETING_NOT_CANCELLABLE");
      expect((await t.sql("SELECT status FROM meetings WHERE id = $1", [meetingId]))[0].status).toBe(status);
    } finally {
      await t.close();
    }
  });

  it("refuses to prepare or request supplements after cancellation", async () => {
    const t = await createTestApp({}, undefined, { preflightAgent: fakeAgent() });
    try {
      const { cookie, cancelAction, draftAction, supplementAction } = await setup(t);
      expect((await execute(t, cookie, cancelAction)).statusCode).toBe(200);
      expect((await execute(t, cookie, draftAction, { note: "x" })).statusCode).toBe(409);
      expect((await execute(t, cookie, supplementAction, { targetDriId: "person-fixture-002", text: "x" })).statusCode).toBe(409);
    } finally {
      await t.close();
    }
  });
});

describe("edit a scheduled Meeting", () => {
  // 默认 fixture 只有一个 dri，换主持需要第二个合法 DRI；写一份临时人员目录，不动共享 fixture。
  async function peopleSeedDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "warmap-people-"));
    await writeFile(
      join(dir, "company-people.json"),
      JSON.stringify({
        schemaVersion: "company-people.v1",
        people: [
          { personId: "person-fixture-001", displayName: "测试甲", roles: ["ceo"] },
          { personId: "person-fixture-002", displayName: "测试乙", roles: ["dri", "participant"] },
          { personId: "person-fixture-003", displayName: "测试丙", roles: ["dri", "participant"] },
        ],
      }),
    );
    return dir;
  }

  async function setup(t: TestApp) {
    const { cookie, meetingId, card } = await readyMeeting(t, `dri-edit-${randomUUID().slice(0, 8)}`);
    const descriptor = card.actions.find((a: { actionType: string }) => a.actionType === "meeting.edit_details");
    expect(descriptor, "scheduled Meeting 应提供 meeting.edit_details").toBeTruthy();
    return { cookie, meetingId, version: card.objectRef.version as number, editAction: (descriptor as { actionId: string }).actionId };
  }

  it("edits title, time and lead DRI in place: id stable, version+1, participants follow the new lead", async () => {
    const seedDir = await peopleSeedDir();
    const t = await createTestApp({ companyPeopleSeed: join(seedDir, "company-people.json") }, undefined, { preflightAgent: fakeAgent() });
    try {
      const { cookie, meetingId, version, editAction } = await setup(t);
      const input = { title: "渠道投入决策会（改）", scheduledAt: "2026-07-02T09:30:00.000+08:00", leadDriId: "person-fixture-003" };

      const edited = await execute(t, cookie, editAction, input);
      expect(edited.statusCode).toBe(200);
      const card = edited.json().cards[0];
      expect(card.objectRef).toMatchObject({ id: meetingId, version: version + 1 });
      expect(card.title).toBe("渠道投入决策会（改）");
      expect(card.payload.leadDriId).toBe("person-fixture-003");
      expect(new Date(card.payload.scheduledAt).toISOString()).toBe("2026-07-02T01:30:00.000Z");
      // 原主持仍保留为参会人，新主持排在 ceo 之后
      expect(card.payload.participants.map((p: { personId: string }) => p.personId)).toEqual(["person-fixture-001", "person-fixture-003", "person-fixture-002"]);

      const row = (await t.sql("SELECT title, lead_dri_id, participants, version FROM meetings WHERE id = $1", [meetingId]))[0];
      expect(row).toMatchObject({ title: "渠道投入决策会（改）", lead_dri_id: "person-fixture-003", version: version + 1 });
      expect((row.participants as { personId: string }[]).map((p) => p.personId)).toEqual(["person-fixture-001", "person-fixture-003", "person-fixture-002"]);

      // 同一 actionId 重放：幂等，不再 version+1
      const replay = await execute(t, cookie, editAction, input);
      expect(replay.statusCode).toBe(200);
      expect(replay.json().cards[0].objectRef.version).toBe(version + 1);
    } finally {
      await t.close();
      await rm(seedDir, { recursive: true, force: true });
    }
  });

  it("refuses to edit a non-scheduled Meeting and keeps it unchanged", async () => {
    const t = await createTestApp({}, undefined, { preflightAgent: fakeAgent() });
    try {
      const { cookie, meetingId, editAction } = await setup(t);
      await t.sql("UPDATE meetings SET status = 'held' WHERE id = $1", [meetingId]);
      const res = await execute(t, cookie, editAction, { title: "不该生效" });
      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe("MEETING_NOT_SCHEDULED");
      expect((await t.sql("SELECT title FROM meetings WHERE id = $1", [meetingId]))[0].title).toBe("渠道投入决策会");
    } finally {
      await t.close();
    }
  });

  it("rejects an illegal lead DRI, an unparsable time and an empty body", async () => {
    const t = await createTestApp({}, undefined, { preflightAgent: fakeAgent() });
    try {
      const { cookie, editAction } = await setup(t);
      const notDri = await execute(t, cookie, editAction, { leadDriId: "person-fixture-001" });
      expect(notDri.statusCode).toBe(400);
      expect(notDri.json().code).toBe("INVALID_LEAD_DRI");

      const badTime = await execute(t, cookie, editAction, { scheduledAt: "不是时间" });
      expect(badTime.statusCode).toBe(400);
      expect(badTime.json().code).toBe("INVALID_INPUT");

      const empty = await execute(t, cookie, editAction, {});
      expect(empty.statusCode).toBe(400);
      expect(empty.json().code).toBe("INVALID_INPUT");
    } finally {
      await t.close();
    }
  });

  it("keeps the planned duration when only scheduledAt moves, and validates endsAt against the start", async () => {
    const t = await createTestApp({}, undefined, { preflightAgent: fakeAgent() });
    try {
      const { cookie, meetingId, editAction } = await setup(t);
      // 先把时长拉到 90 分钟：只改 endsAt 时对照当前开始时间
      const widened = await execute(t, cookie, editAction, { endsAt: "2026-06-01T11:30:00.000+08:00" });
      expect(widened.statusCode).toBe(200);
      expect(widened.json().cards[0].payload.endsAt).toBe("2026-06-01T03:30:00.000Z");

      const moved = await execute(t, cookie, await meetingAction(t, cookie, meetingId, "meeting.edit_details"), { scheduledAt: "2026-06-03T14:00:00.000+08:00" });
      expect(moved.statusCode).toBe(200);
      expect(moved.json().cards[0].payload).toMatchObject({ scheduledAt: "2026-06-03T06:00:00.000Z", endsAt: "2026-06-03T07:30:00.000Z" });

      const rangeAction = await meetingAction(t, cookie, meetingId, "meeting.edit_details");
      for (const input of [
        { endsAt: "2026-06-03T13:00:00.000+08:00" },
        { scheduledAt: "2026-06-04T10:00:00.000+08:00", endsAt: "2026-06-04T10:00:00.000+08:00" },
        { endsAt: "不是时间" },
      ]) {
        const res = await execute(t, cookie, rangeAction, input);
        expect(res.statusCode).toBe(400);
        expect(res.json()).toMatchObject({ code: "INVALID_INPUT", fieldErrors: { endsAt: expect.any(String) } });
      }
      const row = (await t.sql("SELECT scheduled_at, ends_at FROM meetings WHERE id = $1", [meetingId]))[0];
      expect([row.scheduled_at.toISOString(), row.ends_at.toISOString()]).toEqual(["2026-06-03T06:00:00.000Z", "2026-06-03T07:30:00.000Z"]);
    } finally {
      await t.close();
    }
  });
});

describe("Meeting 计划结束时间与「这场会开完了」", () => {
  type ActionCard = { objectRef: { version: number }; actions: { actionType: string; actionId: string; label: string }[] };
  const actionTypes = (card: ActionCard) => card.actions.map((action) => action.actionType);
  const actionOf = (card: ActionCard, actionType: string) => {
    const descriptor = card.actions.find((action) => action.actionType === actionType);
    expect(descriptor, `应提供 ${actionType}`).toBeTruthy();
    return descriptor!;
  };
  const meetingCard = async (t: TestApp, cookie: string, meetingId: string): Promise<ActionCard & { payload: Record<string, unknown> }> =>
    (await t.app.inject({ method: "GET", url: `/api/cards/meetings/${meetingId}`, headers: { cookie } })).json().cards[0];

  it("defaults endsAt to scheduledAt + 60 minutes, accepts an explicit endsAt and rejects one not after the start", async () => {
    const t = await createTestApp({}, undefined, { preflightAgent: fakeAgent() });
    try {
      const { card } = await readyMeeting(t, "dri-ends-100");
      expect(card.payload).toMatchObject({ scheduledAt: "2026-06-01T02:00:00.000Z", endsAt: "2026-06-01T03:00:00.000Z", endedAt: null });

      const issue = await createIssue(t, "dri-ends-101");
      const cookie = await t.loginCookie();
      const createAction = await issueAction(t, cookie, issue.id, "issue.create_meeting");
      for (const endsAt of [MEETING_INPUT.scheduledAt, "2026-06-01T09:00:00.000+08:00", "不是时间"]) {
        const res = await execute(t, cookie, createAction, { ...MEETING_INPUT, endsAt, issueIds: [issue.id] });
        expect(res.statusCode).toBe(400);
        expect(res.json()).toMatchObject({ code: "INVALID_INPUT", fieldErrors: { endsAt: expect.any(String) } });
      }
      expect(await t.sql("SELECT count(*)::int AS count FROM meetings")).toEqual([{ count: 1 }]);

      const created = await execute(t, cookie, createAction, { ...MEETING_INPUT, endsAt: "2026-06-01T11:30:00.000+08:00", issueIds: [issue.id] });
      expect(created.statusCode).toBe(200);
      expect(created.json().cards[0].payload).toMatchObject({ endsAt: "2026-06-01T03:30:00.000Z", endedAt: null });
    } finally {
      await t.close();
    }
  });

  it("meeting.end records endedAt without changing status, bumps version and is no longer offered", async () => {
    const t = await createTestApp({}, undefined, { preflightAgent: fakeAgent() });
    try {
      const { cookie, meetingId, card } = await readyMeeting(t, "dri-end-100");
      const created = card as unknown as ActionCard;
      const end = actionOf(created, "meeting.end");
      expect(end.label).toBe("结束会议");

      const ended = await execute(t, cookie, end.actionId);
      expect(ended.statusCode).toBe(200);
      const endedCard = ended.json().cards[0];
      expect(Value.Check(MeetingCardPayload, endedCard.payload)).toBe(true);
      expect(endedCard.payload.status).toBe("scheduled");
      expect(endedCard.payload.endedAt).toEqual(expect.any(String));
      expect(endedCard.objectRef.version).toBe(created.objectRef.version + 1);
      expect(actionTypes(endedCard)).not.toContain("meeting.end");
      // 开完马上排一次妙记轮询，不等下一个 5 分钟。
      expect((await t.sql("SELECT dedupe_key FROM jobs WHERE kind = 'meeting.minutes_poll'")).map((row) => row.dedupe_key))
        .toEqual([`meeting.minutes_poll:end:${meetingId}`]);
      // 其余 scheduled Action 不受影响
      expect(actionTypes(endedCard)).toEqual(expect.arrayContaining(["meeting.edit_details", "meeting.cancel"]));

      // 同一 actionId 重放：幂等，不再 version+1
      const replay = await execute(t, cookie, end.actionId);
      expect(replay.statusCode).toBe(200);
      expect(replay.json().cards[0].objectRef.version).toBe(created.objectRef.version + 1);

      const row = (await t.sql("SELECT status, ended_at FROM meetings WHERE id = $1", [meetingId]))[0];
      expect(row.status).toBe("scheduled");
      expect(row.ended_at.toISOString()).toBe(endedCard.payload.endedAt);
      expect(actionTypes(await meetingCard(t, cookie, meetingId))).not.toContain("meeting.end");
    } finally {
      await t.close();
    }
  });

  it("主持人拿到结束与重新安排操作，并且执行和冲突响应都保持成员投影", async () => {
    const t = await createTestApp({}, undefined, { preflightAgent: fakeAgent() });
    try {
      const { cookie, meetingId, card } = await readyMeeting(t, "member-host-end");
      const member = await t.memberCookie();
      const memberCard = (await t.app.inject({ method: "GET", url: `/api/me/cards/meetings/${meetingId}`, headers: { cookie: member } })).json();
      expect(memberCard.actions.map((action: { actionType: string }) => action.actionType)).toEqual(["meeting.reschedule", "meeting.end"]);
      expect(memberCard.payload).not.toHaveProperty("draft");
      expect((await execute(t, member, actionOf(card as ActionCard, "meeting.edit_details").actionId, { title: "越权修改" })).statusCode).toBe(403);
      expect((await execute(t, cookie, actionOf(card as ActionCard, "meeting.edit_details").actionId, { title: "CEO 改名" })).statusCode).toBe(200);
      const stale = await execute(t, member, actionOf(memberCard, "meeting.end").actionId);
      expect(stale.statusCode).toBe(409);
      expect(stale.json().latestCard.payload).not.toHaveProperty("draft");
      const fresh = (await t.app.inject({ method: "GET", url: `/api/me/cards/meetings/${meetingId}`, headers: { cookie: member } })).json();
      const ended = await execute(t, member, actionOf(fresh, "meeting.end").actionId);
      expect(ended.statusCode).toBe(200);
      expect(ended.json().cards[0].payload.endedAt).toEqual(expect.any(String));
      expect(ended.json().cards[0].payload).not.toHaveProperty("draft");
      expect(ended.json().cards[0].actions.map((action: { actionType: string }) => action.actionType)).toEqual(["meeting.reschedule"]);

      const other = await readyMeeting(t, "member-not-host-end");
      await t.sql("UPDATE meetings SET lead_dri_id=$2 WHERE id=$1", [other.meetingId, "another-host"]);
      const visible = (await t.app.inject({ method: "GET", url: `/api/me/cards/meetings/${other.meetingId}`, headers: { cookie: member } })).json();
      expect(visible.actions).toEqual([]);
      expect((await execute(t, member, actionOf(other.card as ActionCard, "meeting.end").actionId)).statusCode).toBe(404);
    } finally { await t.close(); }
  }, 20_000);

  it.each(["cancelled", "held"] as const)("neither offers nor executes meeting.end on a %s Meeting", async (status) => {
    const t = await createTestApp({}, undefined, { preflightAgent: fakeAgent() });
    try {
      const { cookie, meetingId, card } = await readyMeeting(t, `dri-end-${status}`);
      const end = actionOf(card as unknown as ActionCard, "meeting.end");
      await t.sql("UPDATE meetings SET status = $2 WHERE id = $1", [meetingId, status]);
      expect(actionTypes(await meetingCard(t, cookie, meetingId))).not.toContain("meeting.end");

      const res = await execute(t, cookie, end.actionId);
      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe("MEETING_NOT_ENDABLE");
      expect((await t.sql("SELECT status, ended_at FROM meetings WHERE id = $1", [meetingId]))[0]).toEqual({ status, ended_at: null });
      await expectNoIdleInTransaction(t);
    } finally {
      await t.close();
    }
  });

  it("rejects a stale meeting.end with the latest card like other Meeting actions", async () => {
    const t = await createTestApp({}, undefined, { preflightAgent: fakeAgent() });
    try {
      const { cookie, meetingId, card } = await readyMeeting(t, "dri-end-stale");
      const created = card as unknown as ActionCard;
      const end = actionOf(created, "meeting.end");
      expect((await execute(t, cookie, actionOf(created, "meeting.edit_details").actionId, { title: "改名后" })).statusCode).toBe(200);

      const stale = await execute(t, cookie, end.actionId);
      expect(stale.statusCode).toBe(409);
      expect(stale.json().code).toBe("VERSION_CONFLICT");
      expect(stale.json().latestCard).toMatchObject({ id: `meeting:${meetingId}`, payload: { endedAt: null } });
      expect((await t.sql("SELECT ended_at FROM meetings WHERE id = $1", [meetingId]))[0].ended_at).toBeNull();
      await expectNoIdleInTransaction(t);
    } finally {
      await t.close();
    }
  });
});

describe("startup recovery of an interrupted preflight", () => {
  it("marks a stale pending preflight as failed and waits for an explicit retry", async () => {
    await createTestDb(async ({ db, pool }) => {
      await migrate(db);
      const agent: PreflightAgent = { async generate() { throw new Error("should not run"); } };
      const app = await buildApp({ pool, env: testEnv, preflightAgent: agent });
      try {
        const issue = await app.inject({
          method: "POST",
          url: "/api/dri/issues",
          headers: { authorization: `Bearer ${testEnv.driServiceToken}` },
          payload: {
            externalId: "dri-recover-001",
            submitterPersonId: "person-fixture-002",
            title: "恢复测试议题",
            whyNow: "窗口临近",
            sourceRef: "dri://planning/recover-001",
            location: { level: "battlefield", battlefieldId: "growth" },
          },
        });
        const issueId = issue.json().cards[0].objectRef.id as string;
        const created = await app.inject({
          method: "POST",
          url: "/api/dri/meetings",
          headers: { authorization: `Bearer ${testEnv.driServiceToken}` },
          payload: { ...MEETING_INPUT, externalId: "dri-recover-meeting-001", issueIds: [issueId] },
        });
        expect(created.statusCode).toBe(201);
        const meetingId = created.json().cards[0].objectRef.id as string;
        // 模拟进程在预审运行前崩溃：pending 且 pendingSince 已过期
        await db.query("UPDATE meetings SET preflight = $2::jsonb WHERE id = $1", [
          meetingId,
          JSON.stringify({ status: "pending", pendingSince: "2026-05-02T01:00:00.000Z", runId: null, entries: [], basis: "", brief: "", error: null, generatedAt: null }),
        ]);
        expect(await recoverInterruptedPreflight(db.query.bind(db), { now: () => new Date("2026-05-02T03:00:00.000Z") })).toBe(1);

        await seedTestAccess(db);
        const login = await app.inject({
          method: "POST",
          url: "/api/auth/login",
          headers: { origin: testEnv.publicOrigin },
          payload: TEST_LOGIN,
        });
        const card = await app.inject({
          method: "GET",
          url: `/api/cards/meetings/${meetingId}`,
          headers: { cookie: (login.headers["set-cookie"] as string).split(";")[0] },
        });
        expect(card.json().cards[0].payload.preflight).toMatchObject({
          status: "failed",
          error: { code: "preflight_interrupted" },
        });
        // 再次恢复不重复改动，也不自动重试
        await expect(recoverInterruptedPreflight(db.query.bind(db), { now: () => new Date("2026-05-02T03:00:00.000Z") })).resolves.toBe(0);
      } finally {
        await app.close();
      }
    });
  });
});

describe("预审在后台跑（巡检 P1-5/6）", () => {
  /** 模型要等放行才回：接口不能等它。 */
  function gatedAgent() {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const inner = fakeAgent();
    const agent: FakeAgent & { release: () => void } = {
      background: true,
      calls: inner.calls,
      release: () => release(),
      async generate(input) { await gate; return inner.generate(input); },
    };
    return agent;
  }
  async function waitReady(t: TestApp, cookie: string, meetingId: string) {
    for (let i = 0; i < 100; i += 1) {
      const card = (await t.app.inject({ method: "GET", url: `/api/cards/meetings/${meetingId}`, headers: { cookie } })).json().cards[0];
      if (card.payload.preflight.status !== "running") return card;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error("预审一直没跑完");
  }

  it("新建会议、加入已有会议都在预审跑完前返回「预审中」，跑完后变为 ready", async () => {
    const agent = gatedAgent();
    const t = await createTestApp({}, undefined, { preflightAgent: agent });
    try {
      const issue = await createIssue(t, "bg-preflight-1");
      const cookie = await t.loginCookie();
      const created = await execute(t, cookie, await issueAction(t, cookie, issue.id, "issue.create_meeting"), { ...MEETING_INPUT, issueIds: [issue.id] });
      expect(created.statusCode).toBe(200);
      const meetingId = created.json().cards[0].objectRef.id as string;
      expect(created.json().cards[0].payload.preflight.status).toBe("running");
      const second = await createIssue(t, "bg-preflight-2");
      const joined = await execute(t, cookie, await issueAction(t, cookie, second.id, "issue.join_meeting"), { meetingId });
      expect(joined.statusCode).toBe(200);
      expect(joined.json().cards[0].payload.issueIds).toEqual(expect.arrayContaining([issue.id, second.id]));
      expect(joined.json().cards[0].payload.preflight.status).toBe("running");
      agent.release();
      const ready = await waitReady(t, cookie, meetingId);
      expect(ready.payload.preflight.status).toBe("ready");
      // 两次触发都跑了，但只有最后一次的结果落库：条目覆盖两条议题
      const refs = ready.payload.preflight.entries.flatMap((entry: { sourceRefs: string[] }) => entry.sourceRefs);
      expect(refs).toEqual(expect.arrayContaining([`issue:${issue.id}`, `issue:${second.id}`]));
    } finally {
      agent.release();
      await t.close();
    }
  });
});

describe("启动后补跑会前预审（巡检 P1-17）", () => {
  it("没跑过的、被重启打断的预审在启动后自动在后台重跑，说明文案是人话", async () => {
    await createTestDb(async ({ db, pool }) => {
      await migrate(db);
      const setup = await buildApp({ pool, env: testEnv, preflightAgent: fakeAgent() });
      const ids: string[] = [];
      try {
        for (const n of [1, 2]) {
          const issue = await setup.inject({ method: "POST", url: "/api/dri/issues", headers: { authorization: `Bearer ${testEnv.driServiceToken}` },
            payload: { externalId: `dri-resume-${n}`, submitterPersonId: "person-fixture-002", title: `补跑议题 ${n}`, whyNow: "窗口临近",
              sourceRef: `dri://planning/resume-${n}`, location: { level: "battlefield", battlefieldId: "growth" } } });
          const created = await setup.inject({ method: "POST", url: "/api/dri/meetings", headers: { authorization: `Bearer ${testEnv.driServiceToken}` },
            payload: { ...MEETING_INPUT, externalId: `dri-resume-meeting-${n}`, issueIds: [issue.json().cards[0].objectRef.id] } });
          ids.push(created.json().cards[0].objectRef.id as string);
        }
      } finally { await setup.close(); }
      const stale = (status: string) => JSON.stringify({ status, pendingSince: "2026-05-02T01:00:00.000Z", runId: null, entries: [], basis: "", brief: "", error: null, generatedAt: null });
      await db.query("UPDATE meetings SET preflight = $2::jsonb WHERE id = $1", [ids[0], stale("pending")]);
      await db.query("UPDATE meetings SET preflight = $2::jsonb WHERE id = $1", [ids[1], stale("running")]);
      expect(await recoverInterruptedPreflight(db.query.bind(db), { now: () => new Date("2026-05-02T03:00:00.000Z") })).toBe(2);
      const interrupted = (await db.query("SELECT preflight FROM meetings WHERE id = $1", [ids[1]])).rows[0].preflight;
      expect(interrupted.error.message).toBe("会前预审还没完成，可以重新预审。");
      expect(interrupted.error.message).not.toMatch(/进程|显式/);

      const agent = { ...fakeAgent(), background: true };
      const app = await buildApp({ pool, env: testEnv, preflightAgent: agent });
      try {
        await app.ready();
        let statuses: string[] = [];
        for (let i = 0; i < 100; i += 1) {
          statuses = (await db.query("SELECT preflight->>'status' AS s FROM meetings WHERE id = ANY($1::uuid[]) ORDER BY id", [ids])).rows.map((row) => row.s);
          if (statuses.every((status) => status === "ready")) break;
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        expect(statuses).toEqual(["ready", "ready"]);
      } finally { await app.close(); }
    });
  });
});
