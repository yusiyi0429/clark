import { describe, expect, it } from "vitest";
import { Value } from "@sinclair/typebox/value";
import { Card, MeetingCardPayload, MeetingOutcomeState, type TPostMeetingCandidate } from "@warmap/contracts";
import { createTestApp, preflightCandidate, testEnv, type TestApp } from "./helpers.js";
import type { PostMeetingAgent, PostMeetingAgentInput } from "../src/outcome.js";
import type { DriExportRequest, DriExporter, PreflightAgent, PreflightAgentInput } from "../src/meetings.js";
import { signActionId } from "../src/actionToken.js";

const MEETING_INPUT = {
  title: "渠道投入决策会",
  scheduledAt: "2026-06-01T10:00:00.000+08:00",
  leadDriId: "person-fixture-002",
  ceoParticipantId: "person-fixture-001",
  participants: ["person-fixture-002"],
};

const TURNS = [
  { id: "turn-001", speakerId: "person-fixture-001", startedAt: "2026-06-01T10:00:05+08:00", text: "灯塔项目优先，TokenOps 保留最低验证力量。" },
  { id: "turn-002", speakerId: "person-fixture-002", startedAt: "2026-06-01T10:00:20+08:00", text: "我周五前提交资源排期。" },
  { id: "turn-003", speakerId: "person-fixture-001", startedAt: "2026-06-01T10:01:00+08:00", text: "外部承诺先不签，六月前给我风险清单。" },
];

/** item-1 decision、item-2 todo、item-3 ceoJudgment、item-4 reopenWhen、item-5 open。 */
function candidate(issueId: string): TPostMeetingCandidate {
  return {
    summary: "会议形成一项决定、一项待办、一项判断与一个复议条件",
    items: [
      { kind: "decision", text: "灯塔项目优先", turnId: "turn-001", quote: "灯塔项目优先", issueId },
      { kind: "todo", text: "周五前提交资源排期", turnId: "turn-002", quote: "我周五前提交资源排期", ownerPersonId: "person-fixture-002" },
      { kind: "ceoJudgment", text: "外部承诺先不签", turnId: "turn-003", quote: "外部承诺先不签", judgmentKind: "external_commitment" },
      { kind: "reopenWhen", text: "六月前给我风险清单", turnId: "turn-003", quote: "六月前给我风险清单", parentIndex: 0 },
      { kind: "open", text: "TokenOps 最低验证力量", turnId: "turn-001", quote: "TokenOps 保留最低验证力量" },
    ],
  };
}

const preflightAgent: PreflightAgent = {
  async generate(input: PreflightAgentInput) {
    return { candidate: preflightCandidate(input.issues.map((issue) => `issue:${issue.id}`)) };
  },
};

function outcomeAgent(): PostMeetingAgent & { calls: PostMeetingAgentInput[] } {
  const agent = {
    calls: [] as PostMeetingAgentInput[],
    async generate(input: PostMeetingAgentInput) {
      agent.calls.push(input);
      return { candidate: candidate(input.issues[0].id) };
    },
  };
  return agent;
}

type RecordingExporter = DriExporter & { calls: DriExportRequest[] };
function recordingExporter(outcome: "delivered" | "failed" = "delivered"): RecordingExporter {
  const exporter: RecordingExporter = {
    calls: [],
    async export(request: DriExportRequest) {
      exporter.calls.push(request);
      if (outcome === "failed") throw new Error("dri channel unreachable");
      return { exportRef: "dri-handoff-001" };
    },
  };
  return exporter;
}

async function createIssue(t: TestApp, externalId: string): Promise<string> {
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
  return res.json().cards[0].objectRef.id as string;
}

/** 一条 Issue → Meeting → held → ready Outcome 的完整链路。 */
async function readyOutcome(
  t: TestApp,
): Promise<{ cookie: string; issueId: string; meetingId: string; card: Record<string, unknown> }> {
  const issueId = await createIssue(t, `ticket11-${Math.random().toString(36).slice(2)}`);
  const cookie = await t.loginCookie();
  const issueCard = await t.app.inject({ method: "GET", url: `/api/cards/issues/${issueId}`, headers: { cookie } });
  const descriptor = issueCard.json().cards[0].actions.find((a: { actionType: string }) => a.actionType === "issue.create_meeting");
  const created = await t.app.inject({
    method: "POST",
    url: "/api/actions/execute",
    headers: { cookie, origin: t.publicOrigin },
    payload: { actionId: descriptor.actionId, input: { ...MEETING_INPUT, issueIds: [issueId] } },
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
  const card = imported.json().cards[0];
  expect(card.payload.outcome).toMatchObject({ status: "ready" });
  return { cookie, issueId, meetingId, card };
}

async function meetingCard(t: TestApp, cookie: string, meetingId: string): Promise<Record<string, unknown>> {
  const res = await t.app.inject({ method: "GET", url: `/api/cards/meetings/${meetingId}`, headers: { cookie } });
  return res.json().cards[0];
}

type CardAction = { actionType: string; actionId: string; itemId?: string };

async function meetingActionId(
  t: TestApp,
  cookie: string,
  meetingId: string,
  actionType: string,
  itemId?: string,
): Promise<string | undefined> {
  const card = await meetingCard(t, cookie, meetingId);
  return (card.actions as CardAction[]).find((a) => a.actionType === actionType && (!itemId || a.itemId === itemId))?.actionId;
}

async function execute(t: TestApp, cookie: string, actionId: string | undefined, input?: unknown) {
  return t.app.inject({
    method: "POST",
    url: "/api/actions/execute",
    headers: { cookie, origin: t.publicOrigin },
    payload: { actionId, input },
  });
}

const outcomeOf = (card: Record<string, unknown>) => card.payload as { outcome: { items: OutcomeItem[]; status: string } };
type OutcomeItem = {
  id: string;
  kind: string;
  review: { status: string; effectRef: string | null; anchorId?: string | null; handoff?: { exportStatus: string; exportRef: string | null } | null; reason?: string | null } | null;
};

async function issueReceipts(t: TestApp, issueId: string): Promise<Record<string, unknown>[]> {
  return (await t.sql("SELECT receipts FROM issues WHERE id = $1", [issueId]))[0].receipts as Record<string, unknown>[];
}

async function anchors(t: TestApp): Promise<Record<string, unknown>[]> {
  return (await t.sql("SELECT anchors FROM radar_config WHERE id = 'default'"))[0].anchors as Record<string, unknown>[];
}

describe("item-by-item Outcome review", () => {
  it("moves a Meeting with no reviewable items straight to reviewed", async () => {
    const openOnly: PostMeetingAgent = {
      async generate() {
        return { candidate: { summary: "只有未决事项", items: [{ kind: "open", text: "TokenOps 最低验证力量", turnId: "turn-001", quote: "TokenOps 保留最低验证力量" }] } };
      },
    };
    const t = await createTestApp({}, undefined, { preflightAgent, outcomeAgent: openOnly });
    try {
      const { cookie, meetingId, card } = await readyOutcome(t);
      // 没有可审阅条目：按文档直接 reviewed，并且不暴露任何逐项 Action
      expect(card.payload.status).toBe("reviewed");
      expect(outcomeOf(card).outcome.items[0].review).toBeNull();
      const actions = (await meetingCard(t, cookie, meetingId)).actions as CardAction[];
      expect(actions.filter((a) => a.itemId)).toHaveLength(0);
    } finally {
      await t.close();
    }
  });

  it("replays a dismiss action fingerprint without a second review effect", async () => {
    const t = await createTestApp({}, undefined, { preflightAgent, outcomeAgent: outcomeAgent() });
    try {
      const { cookie, meetingId } = await readyOutcome(t);
      const actionId = await meetingActionId(t, cookie, meetingId, "meeting.dismiss_item", "item-3");
      expect((await execute(t, cookie, actionId, { reason: "不是本次决定" })).statusCode).toBe(200);
      const replay = await execute(t, cookie, actionId, { reason: "不是本次决定" });
      expect(replay.statusCode).toBe(200);
      expect(outcomeOf(replay.json().cards[0]).outcome.items[2].review).toMatchObject({ status: "dismissed", reason: "不是本次决定" });
    } finally {
      await t.close();
    }
  });

  it("allows replacing the transcript of a reviewed Meeting with no confirmed effect", async () => {
    let calls = 0;
    const agent: PostMeetingAgent = {
      async generate(input) {
        calls += 1;
        return {
          candidate: calls === 1
            ? { summary: "只有未决事项", items: [{ kind: "open", text: "TokenOps 最低验证力量", turnId: "turn-001", quote: "TokenOps 保留最低验证力量" }] }
            : candidate(input.issues[0].id),
        };
      },
    };
    const t = await createTestApp({}, undefined, { preflightAgent, outcomeAgent: agent });
    try {
      const { cookie, meetingId, card } = await readyOutcome(t);
      expect(card.payload.status).toBe("reviewed");
      const replace = await meetingActionId(t, cookie, meetingId, "meeting.replace_transcript");
      expect(replace).toBeTruthy();
      const replaced = await execute(t, cookie, replace, {
        transcript: { schemaVersion: "warmap-transcript.v1", meetingId, turns: TURNS },
        confirmReplace: true,
      });
      expect(replaced.statusCode).toBe(200);
      const payload = replaced.json().cards[0].payload;
      // 旧 Outcome 作废，Meeting 回到 held 并重新抽取
      expect(payload.status).toBe("held");
      expect(payload.outcome.items).toHaveLength(5);
    } finally {
      await t.close();
    }
  });

  it("keeps every reviewable item pending with an open item only displayed, and exposes no Issue creation", async () => {
    const t = await createTestApp({}, undefined, { preflightAgent, outcomeAgent: outcomeAgent() });
    try {
      const { cookie, meetingId, card } = await readyOutcome(t);
      const items = outcomeOf(card).outcome.items;
      expect(items.map((item) => item.id)).toEqual(["item-1", "item-2", "item-3", "item-4", "item-5"]);
      expect(items.slice(0, 4).map((item) => item.review?.status)).toEqual(["pending", "pending", "pending", "pending"]);
      // open 只展示，不带 Review
      expect(items[4]).toMatchObject({ kind: "open", review: null });

      const actions = (await meetingCard(t, cookie, meetingId)).actions as CardAction[];
      expect(actions.filter((a) => a.actionType === "meeting.confirm_item").map((a) => a.itemId)).toEqual(["item-1", "item-2", "item-3"]);
      expect(actions.filter((a) => a.actionType === "meeting.dismiss_item").map((a) => a.itemId)).toEqual(["item-1", "item-2", "item-3", "item-4"]);
      // open item 没有确认/忽略，也没有任何创建 Issue 的 Action
      expect(actions.some((a) => a.itemId === "item-5")).toBe(false);
      expect(actions.some((a) => a.actionType.includes("issue"))).toBe(false);
    } finally {
      await t.close();
    }
  });

  it("creates an exact Issue Receipt for a confirmed decision and keeps other items untouched", async () => {
    const t = await createTestApp({}, undefined, { preflightAgent, outcomeAgent: outcomeAgent() });
    try {
      const { cookie, issueId, meetingId } = await readyOutcome(t);
      const confirmed = await execute(t, cookie, await meetingActionId(t, cookie, meetingId, "meeting.confirm_item", "item-1"));
      expect(confirmed.statusCode).toBe(200);
      const card = confirmed.json().cards[0];
      expect(Value.Check(Card, card)).toBe(true);
      expect(Value.Check(MeetingCardPayload, card.payload)).toBe(true);
      expect(Value.Check(MeetingOutcomeState, card.payload.outcome)).toBe(true);
      const items = outcomeOf(card).outcome.items;
      expect(items[0].review).toMatchObject({
        status: "confirmed",
        effectRef: `meeting:${meetingId}:decision:item-1`,
      });
      expect(items[1].review?.status).toBe("pending");

      const receipts = await issueReceipts(t, issueId);
      expect(receipts).toHaveLength(1);
      expect(receipts[0]).toMatchObject({
        actionType: "meeting.confirm_item",
        effectRef: `meeting:${meetingId}:decision:item-1`,
        decisionText: "灯塔项目优先",
        source: { kind: "meeting-item", meetingId, outcomeItemId: "item-1" },
      });
      expect(receipts[0].revokedAt).toBeUndefined();
      expect((await t.sql("SELECT status FROM issues WHERE id = $1", [issueId]))[0].status).toBe("decided");

      // Issue 页面投影精确来源，并提供撤回 Action
      const issueCard = (await t.app.inject({ method: "GET", url: `/api/cards/issues/${issueId}`, headers: { cookie } })).json().cards[0];
      expect(issueCard.payload.receipts[0]).toMatchObject({ source: { kind: "meeting-item", meetingId, outcomeItemId: "item-1" } });
      expect(issueCard.actions.some((a: CardAction) => a.actionType === "issue.revoke_receipt")).toBe(true);
    } finally {
      await t.close();
    }
  });

  it("does not offer confirm for a decision whose linked Issue cannot be resolved", async () => {
    const t = await createTestApp({}, undefined, { preflightAgent, outcomeAgent: outcomeAgent() });
    try {
      const { cookie, meetingId } = await readyOutcome(t);
      const row = (await t.sql("SELECT outcome, issue_ids FROM meetings WHERE id = $1", [meetingId]))[0];
      const outcome = row.outcome as { items: OutcomeItem[] };
      outcome.items[0].issueId = null;
      // 关联多个 Issue 且 decision 未指定 issueId：无法确定精确 Receipt 目标
      await t.sql("UPDATE meetings SET outcome = $2::jsonb, issue_ids = $3::jsonb WHERE id = $1", [
        meetingId,
        JSON.stringify(outcome),
        JSON.stringify([...(row.issue_ids as string[]), "00000000-0000-4000-8000-000000000099"]),
      ]);
      const card = await meetingCard(t, cookie, meetingId);
      const actions = card.actions as CardAction[];
      expect(actions.some((a) => a.actionType === "meeting.confirm_item" && a.itemId === "item-1")).toBe(false);
      expect(actions.some((a) => a.actionType === "meeting.dismiss_item" && a.itemId === "item-1")).toBe(true);

      const forced = signActionId(testEnv.sessionSecret, {
        actionType: "meeting.confirm_item", objectType: "meeting", objectId: meetingId,
        objectVersion: (card.objectRef as { version: number }).version, itemId: "item-1",
      });
      const res = await execute(t, cookie, forced);
      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe("DECISION_ITEM_WITHOUT_ISSUE");
    } finally {
      await t.close();
    }
  });

  it("confirms a todo into a DRI Handoff with pending_export and confirms a CEO judgment without touching CompanyMemory", async () => {
    const t = await createTestApp({}, undefined, { preflightAgent, outcomeAgent: outcomeAgent() });
    try {
      const { cookie, issueId, meetingId } = await readyOutcome(t);
      const todo = await execute(t, cookie, await meetingActionId(t, cookie, meetingId, "meeting.confirm_item", "item-2"));
      expect(todo.statusCode).toBe(200);
      expect(outcomeOf(todo.json().cards[0]).outcome.items[1].review).toMatchObject({
        status: "confirmed",
        effectRef: `meeting:${meetingId}:todo:item-2`,
        handoff: { exportStatus: "pending_export", exportRef: null },
      });

      const judgment = await execute(t, cookie, await meetingActionId(t, cookie, meetingId, "meeting.confirm_item", "item-3"));
      expect(judgment.statusCode).toBe(200);
      expect(outcomeOf(judgment.json().cards[0]).outcome.items[2].review).toMatchObject({
        status: "confirmed",
        effectRef: `meeting:${meetingId}:judgment:item-3`,
      });
      // CEO 判断只保留在 MeetingOutcome：不写 Issue Receipt，也不写 Radar anchor
      expect(await issueReceipts(t, issueId)).toHaveLength(0);
      expect(await anchors(t)).toHaveLength(0);

      // 确认一项后另一项仍独立 pending
      expect(outcomeOf(judgment.json().cards[0]).outcome.items[0].review?.status).toBe("pending");
    } finally {
      await t.close();
    }
  });

  it("revokes a confirmed CEO judgment back to pending without external side effects", async () => {
    const t = await createTestApp({}, undefined, { preflightAgent, outcomeAgent: outcomeAgent() });
    try {
      const { cookie, issueId, meetingId } = await readyOutcome(t);
      await execute(t, cookie, await meetingActionId(t, cookie, meetingId, "meeting.confirm_item", "item-3"));
      const revoked = await execute(t, cookie, await meetingActionId(t, cookie, meetingId, "meeting.revoke_effect", "item-3"));
      expect(revoked.statusCode).toBe(200);
      expect(outcomeOf(revoked.json().cards[0]).outcome.items[2].review?.status).toBe("pending");
      // judgment 只存在于 Outcome：不产生 Receipt 或 anchor
      expect(await issueReceipts(t, issueId)).toHaveLength(0);
      expect(await anchors(t)).toHaveLength(0);
    } finally {
      await t.close();
    }
  });

  it("dismisses an item without effect and confirms the todo through a real DRI channel only on receipt", async () => {
    const exporter = recordingExporter("delivered");
    const t = await createTestApp({}, undefined, { preflightAgent, outcomeAgent: outcomeAgent(), driExporter: exporter });
    try {
      const { cookie, meetingId } = await readyOutcome(t);
      const dismissed = await execute(t, cookie, await meetingActionId(t, cookie, meetingId, "meeting.dismiss_item", "item-3"), { reason: "不是本次决定" });
      expect(dismissed.statusCode).toBe(200);
      expect(outcomeOf(dismissed.json().cards[0]).outcome.items[2].review).toMatchObject({ status: "dismissed", reason: "不是本次决定" });

      const confirmed = await execute(t, cookie, await meetingActionId(t, cookie, meetingId, "meeting.confirm_item", "item-2"));
      expect(confirmed.statusCode).toBe(200);
      const handoff = outcomeOf(confirmed.json().cards[0]).outcome.items[1].review?.handoff;
      expect(handoff).toMatchObject({ exportStatus: "delivered", exportRef: "dri-handoff-001" });
      expect(exporter.calls).toHaveLength(1);
      expect(exporter.calls[0]).toMatchObject({ effectRef: `meeting:${meetingId}:todo:item-2`, targetDriId: "person-fixture-002", text: "周五前提交资源排期" });
    } finally {
      await t.close();
    }
  });

  it("records a failed export without rolling back the confirmed item", async () => {
    const t = await createTestApp({}, undefined, { preflightAgent, outcomeAgent: outcomeAgent(), driExporter: recordingExporter("failed") });
    try {
      const { cookie, meetingId } = await readyOutcome(t);
      const confirmed = await execute(t, cookie, await meetingActionId(t, cookie, meetingId, "meeting.confirm_item", "item-2"));
      expect(confirmed.statusCode).toBe(200);
      expect(outcomeOf(confirmed.json().cards[0]).outcome.items[1].review).toMatchObject({
        status: "confirmed",
        handoff: { exportStatus: "failed", error: "dri channel unreachable" },
      });
    } finally {
      await t.close();
    }
  });

  it("refuses to revoke a delivered todo and hides the revoke Action instead of faking recovery", async () => {
    const t = await createTestApp({}, undefined, { preflightAgent, outcomeAgent: outcomeAgent(), driExporter: recordingExporter("delivered") });
    try {
      const { cookie, meetingId } = await readyOutcome(t);
      await execute(t, cookie, await meetingActionId(t, cookie, meetingId, "meeting.confirm_item", "item-2"));
      const card = await meetingCard(t, cookie, meetingId);
      const actions = card.actions as CardAction[];
      expect(actions.some((a) => a.actionType === "meeting.revoke_effect" && a.itemId === "item-2")).toBe(false);

      // 即使绕过 Web 直接提交，也只返回明确 warning，不改变状态
      const version = (card.objectRef as { version: number }).version;
      const forced = signActionId(testEnv.sessionSecret, { actionType: "meeting.revoke_effect", objectType: "meeting", objectId: meetingId, objectVersion: version, itemId: "item-2" });
      const res = await execute(t, cookie, forced);
      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe("EFFECT_NOT_REVOCABLE");
      expect(res.json().message).toContain("不能自动撤回");
      expect(outcomeOf(await meetingCard(t, cookie, meetingId)).outcome.items[1].review?.handoff?.exportStatus).toBe("delivered");
    } finally {
      await t.close();
    }
  });

  it("confirms two items independently and revoking one leaves the other effect intact", async () => {
    const t = await createTestApp({}, undefined, { preflightAgent, outcomeAgent: outcomeAgent() });
    try {
      const { cookie, issueId, meetingId } = await readyOutcome(t);
      await execute(t, cookie, await meetingActionId(t, cookie, meetingId, "meeting.confirm_item", "item-1"));
      await execute(t, cookie, await meetingActionId(t, cookie, meetingId, "meeting.confirm_item", "item-2"));

      const revokedTodo = await execute(t, cookie, await meetingActionId(t, cookie, meetingId, "meeting.revoke_effect", "item-2"));
      expect(revokedTodo.statusCode).toBe(200);
      const afterTodo = outcomeOf(revokedTodo.json().cards[0]).outcome.items;
      expect(afterTodo[1].review?.status).toBe("pending");
      expect(afterTodo[0].review?.status).toBe("confirmed");
      // decision 的 Issue Receipt 不被 todo 撤回影响
      expect((await issueReceipts(t, issueId)).filter((r) => !r.revokedAt)).toHaveLength(1);

      const revokedDecision = await execute(t, cookie, await meetingActionId(t, cookie, meetingId, "meeting.revoke_effect", "item-1"));
      expect(revokedDecision.statusCode).toBe(200);
      expect(outcomeOf(revokedDecision.json().cards[0]).outcome.items[0].review?.status).toBe("pending");
      expect((await issueReceipts(t, issueId)).filter((r) => !r.revokedAt)).toHaveLength(0);
      expect((await t.sql("SELECT status FROM issues WHERE id = $1", [issueId]))[0].status).toBe("pending");
    } finally {
      await t.close();
    }
  });

  it("replays a confirm action fingerprint without producing a second Receipt and rejects a stale version", async () => {
    const t = await createTestApp({}, undefined, { preflightAgent, outcomeAgent: outcomeAgent() });
    try {
      const { cookie, issueId, meetingId } = await readyOutcome(t);
      const actionId = await meetingActionId(t, cookie, meetingId, "meeting.confirm_item", "item-1");
      const first = await execute(t, cookie, actionId);
      expect(first.statusCode).toBe(200);

      const replay = await execute(t, cookie, actionId);
      expect(replay.statusCode).toBe(200);
      expect(outcomeOf(replay.json().cards[0]).outcome.items[0].review?.status).toBe("confirmed");
      expect(await issueReceipts(t, issueId)).toHaveLength(1);

      // 旧 version 上签发的另一个 Action：冲突并返回最新 Card
      const card = await meetingCard(t, cookie, meetingId);
      const version = (card.objectRef as { version: number }).version;
      const stale = signActionId(testEnv.sessionSecret, { actionType: "meeting.confirm_item", objectType: "meeting", objectId: meetingId, objectVersion: version - 1, itemId: "item-2" });
      const conflict = await execute(t, cookie, stale);
      expect(conflict.statusCode).toBe(409);
      expect(conflict.json().code).toBe("VERSION_CONFLICT");
      expect(conflict.json().latestCard.id).toBe(`meeting:${meetingId}`);
      expect(outcomeOf(await meetingCard(t, cookie, meetingId)).outcome.items[1].review?.status).toBe("pending");
    } finally {
      await t.close();
    }
  });

  it("delegates a meeting Receipt revoke from the Issue page so Outcome and Meeting do not drift", async () => {
    const t = await createTestApp({}, undefined, { preflightAgent, outcomeAgent: outcomeAgent() });
    try {
      const { cookie, issueId, meetingId } = await readyOutcome(t);
      await execute(t, cookie, await meetingActionId(t, cookie, meetingId, "meeting.confirm_item", "item-1"));

      const issueCard = (await t.app.inject({ method: "GET", url: `/api/cards/issues/${issueId}`, headers: { cookie } })).json().cards[0];
      const revoke = (issueCard.actions as CardAction[]).find((a) => a.actionType === "issue.revoke_receipt")!;
      const revoked = await execute(t, cookie, revoke.actionId, { reason: "会议决定撤回" });
      expect(revoked.statusCode).toBe(200);
      expect(revoked.json().cards[0].payload.status).toBe("pending");
      expect(revoked.json().cards[0].payload.receipts[0]).toMatchObject({ revokeReason: "会议决定撤回" });

      // Outcome item 与 Meeting 状态同步回退，不是只改 Receipt
      const meeting = outcomeOf(await meetingCard(t, cookie, meetingId));
      expect(meeting.outcome.items[0].review?.status).toBe("pending");
      expect(meeting.outcome.status).toBe("ready");
      expect((await t.sql("SELECT status FROM meetings WHERE id = $1", [meetingId]))[0].status).toBe("held");
    } finally {
      await t.close();
    }
  });

  it("rejects a stale Issue version when delegating a meeting Receipt revoke", async () => {
    const t = await createTestApp({}, undefined, { preflightAgent, outcomeAgent: outcomeAgent() });
    try {
      const { cookie, issueId, meetingId } = await readyOutcome(t);
      await execute(t, cookie, await meetingActionId(t, cookie, meetingId, "meeting.confirm_item", "item-1"));
      const issueCard = (await t.app.inject({ method: "GET", url: `/api/cards/issues/${issueId}`, headers: { cookie } })).json().cards[0];
      const receiptId = issueCard.payload.receipts[0].id as string;
      const stale = signActionId(testEnv.sessionSecret, {
        actionType: "issue.revoke_receipt", objectType: "issue", objectId: issueId,
        objectVersion: issueCard.objectRef.version - 1, itemId: receiptId,
      });
      const res = await execute(t, cookie, stale, { reason: "旧 Card" });
      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe("VERSION_CONFLICT");
      // 未产生撤回 effect
      expect((await issueReceipts(t, issueId))[0].revokedAt).toBeUndefined();
    } finally {
      await t.close();
    }
  });

  it("only confirms a reopenWhen after its parent decision and writes a Radar anchor", async () => {
    const t = await createTestApp({}, undefined, { preflightAgent, outcomeAgent: outcomeAgent() });
    try {
      const { cookie, meetingId } = await readyOutcome(t);
      // 父 decision 未确认时 Card 不暴露 confirm，直接提交也被拒绝
      expect(await meetingActionId(t, cookie, meetingId, "meeting.confirm_item", "item-4")).toBeUndefined();
      const card = await meetingCard(t, cookie, meetingId);
      const forced = signActionId(testEnv.sessionSecret, {
        actionType: "meeting.confirm_item", objectType: "meeting", objectId: meetingId,
        objectVersion: (card.objectRef as { version: number }).version, itemId: "item-4",
      });
      const rejected = await execute(t, cookie, forced);
      expect(rejected.statusCode).toBe(409);
      expect(rejected.json().code).toBe("PARENT_DECISION_NOT_CONFIRMED");

      await execute(t, cookie, await meetingActionId(t, cookie, meetingId, "meeting.confirm_item", "item-1"));
      const confirmed = await execute(t, cookie, await meetingActionId(t, cookie, meetingId, "meeting.confirm_item", "item-4"));
      expect(confirmed.statusCode).toBe(200);
      expect(outcomeOf(confirmed.json().cards[0]).outcome.items[3].review).toMatchObject({
        status: "confirmed",
        effectRef: `meeting:${meetingId}:reopen:item-4`,
      });
      const written = await anchors(t);
      expect(written).toHaveLength(1);
      expect(written[0]).toMatchObject({ id: `meeting-reopen:${meetingId}:item-4`, title: "六月前给我风险清单", source: "meeting-reopen" });
    } finally {
      await t.close();
    }
  });

  it("cleans child conditions and anchors when the parent decision is dismissed or revoked", async () => {
    const t = await createTestApp({}, undefined, { preflightAgent, outcomeAgent: outcomeAgent() });
    try {
      const { cookie, meetingId } = await readyOutcome(t);
      await execute(t, cookie, await meetingActionId(t, cookie, meetingId, "meeting.confirm_item", "item-1"));
      await execute(t, cookie, await meetingActionId(t, cookie, meetingId, "meeting.confirm_item", "item-4"));
      expect(await anchors(t)).toHaveLength(1);

      const revoked = await execute(t, cookie, await meetingActionId(t, cookie, meetingId, "meeting.revoke_effect", "item-1"));
      expect(revoked.statusCode).toBe(200);
      // 父 decision 撤回：子条件回 pending，anchor 同步删除
      expect(outcomeOf(revoked.json().cards[0]).outcome.items[3].review?.status).toBe("pending");
      expect(await anchors(t)).toHaveLength(0);

      // dismiss 路径：父被忽略时其 pending 子条件自动 dismissed
      const dismissed = await execute(t, cookie, await meetingActionId(t, cookie, meetingId, "meeting.dismiss_item", "item-1"), { reason: "改由其他会议讨论" });
      expect(dismissed.statusCode).toBe(200);
      const items = outcomeOf(dismissed.json().cards[0]).outcome.items;
      expect(items[0].review?.status).toBe("dismissed");
      expect(items[3].review).toMatchObject({ status: "dismissed", reason: "parent_dismissed" });
      expect(await anchors(t)).toHaveLength(0);
    } finally {
      await t.close();
    }
  });

  it("replays a revoke action fingerprint without revoking twice or drifting the other items", async () => {
    const t = await createTestApp({}, undefined, { preflightAgent, outcomeAgent: outcomeAgent() });
    try {
      const { cookie, issueId, meetingId } = await readyOutcome(t);
      await execute(t, cookie, await meetingActionId(t, cookie, meetingId, "meeting.confirm_item", "item-1"));
      const revoke = await meetingActionId(t, cookie, meetingId, "meeting.revoke_effect", "item-1");
      const first = await execute(t, cookie, revoke);
      expect(first.statusCode).toBe(200);

      const replay = await execute(t, cookie, revoke);
      expect(replay.statusCode).toBe(200);
      expect(outcomeOf(replay.json().cards[0]).outcome.items[0].review?.status).toBe("pending");
      // 只产生一个撤回 effect：Issue 仍只有那一个已撤回的 Receipt
      const receipts = await issueReceipts(t, issueId);
      expect(receipts).toHaveLength(1);
      expect(receipts[0].revokedAt).toBeTruthy();
    } finally {
      await t.close();
    }
  });

  it("moves the Meeting to reviewed only after every reviewable item is processed, and back to held on revoke", async () => {
    const t = await createTestApp({}, undefined, { preflightAgent, outcomeAgent: outcomeAgent() });
    try {
      const { cookie, meetingId } = await readyOutcome(t);
      for (const [itemId, actionType] of [
        ["item-1", "meeting.confirm_item"],
        ["item-2", "meeting.dismiss_item"],
        ["item-3", "meeting.confirm_item"],
      ] as const) {
        await execute(t, cookie, await meetingActionId(t, cookie, meetingId, actionType, itemId));
      }
      // 只剩 item-4（父 decision 已确认）
      expect((await t.sql("SELECT status FROM meetings WHERE id = $1", [meetingId]))[0].status).toBe("held");
      const last = await execute(t, cookie, await meetingActionId(t, cookie, meetingId, "meeting.confirm_item", "item-4"));
      expect(last.statusCode).toBe(200);
      expect(last.json().cards[0].payload.status).toBe("reviewed");
      expect((await t.sql("SELECT status FROM meetings WHERE id = $1", [meetingId]))[0].status).toBe("reviewed");

      const revoked = await execute(t, cookie, await meetingActionId(t, cookie, meetingId, "meeting.revoke_effect", "item-1"));
      expect(revoked.statusCode).toBe(200);
      expect(revoked.json().cards[0].payload.status).toBe("held");
    } finally {
      await t.close();
    }
  });
});
