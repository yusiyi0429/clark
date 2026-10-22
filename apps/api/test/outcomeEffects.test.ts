import { describe, expect, it } from "vitest";
import type { TPostMeetingCandidate } from "@warmap/contracts";
import { createTestApp, preflightCandidate, seedLegacyOutcome, testEnv, type TestApp } from "./helpers.js";
import type { PostMeetingAgent, PostMeetingAgentInput } from "../src/outcome.js";
import type { PreflightAgent, PreflightAgentInput } from "../src/meetingPreflight.js";
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

/**
 * 旧格式会议的逐条条目（会议卡之前的会后抽取，seedLegacyOutcome 写入；逐条确认已停，只读）：
 * item-1 decision、item-2 todo（抽取完成即推送成执行事项）、item-3 ceoJudgment、item-4 reopenWhen、item-5 open。
 */
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

const OPEN_ONLY: TPostMeetingCandidate = { summary: "只有未决事项", items: [{ kind: "open", text: "TokenOps 最低验证力量", turnId: "turn-001", quote: "TokenOps 保留最低验证力量" }] };

/** 现在的会后整理只生成会议卡（逐条条目只在旧会议里，用 seedLegacyOutcome 写）。 */
function outcomeAgent(): PostMeetingAgent & { calls: PostMeetingAgentInput[] } {
  const agent = {
    calls: [] as PostMeetingAgentInput[],
    async generate(input: PostMeetingAgentInput) {
      agent.calls.push(input);
      return { candidate: { summary: "灯塔项目优先", sections: [{ heading: "资源", body: "已定：灯塔项目优先。", turnIds: ["turn-001"] }], objectChanges: [], actionItems: [] } };
    },
  };
  return agent;
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

/** 一条 Issue → Meeting → held → 会后整理完成，再写成旧格式会议（逐条条目）。 */
async function readyOutcome(
  t: TestApp,
  legacy: (issueId: string) => TPostMeetingCandidate = candidate,
  seed: { confirmDecisions?: boolean } = {},
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
  expect(imported.json().cards[0].payload.outcome).toMatchObject({ status: "ready" });
  await seedLegacyOutcome(t.pool, meetingId, legacy(issueId), seed);
  const card = await meetingCard(t, cookie, meetingId);
  expect(card.payload).toMatchObject({ outcome: { status: "ready" } });
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
  review: { status: string; effectRef: string | null; anchorId?: string | null; reason?: string | null } | null;
};

async function issueReceipts(t: TestApp, issueId: string): Promise<Record<string, unknown>[]> {
  return (await t.sql("SELECT receipts FROM issues WHERE id = $1", [issueId]))[0].receipts as Record<string, unknown>[];
}


describe("旧格式会议的逐条条目（只读）", () => {
  it("moves a Meeting with no reviewable items straight to reviewed", async () => {
    const t = await createTestApp({}, undefined, { preflightAgent, outcomeAgent: outcomeAgent() });
    try {
      const { cookie, meetingId, card } = await readyOutcome(t, () => OPEN_ONLY);
      // 没有可审阅条目：按文档直接 reviewed，并且不暴露任何逐项 Action
      expect(card.payload.status).toBe("reviewed");
      expect(outcomeOf(card).outcome.items[0].review).toBeNull();
      const actions = (await meetingCard(t, cookie, meetingId)).actions as CardAction[];
      expect(actions.filter((a) => a.itemId)).toHaveLength(0);
    } finally {
      await t.close();
    }
  });

  it("allows replacing the transcript of a reviewed Meeting with no confirmed effect", async () => {
    const t = await createTestApp({}, undefined, { preflightAgent, outcomeAgent: outcomeAgent() });
    try {
      const { cookie, meetingId, card } = await readyOutcome(t, () => OPEN_ONLY);
      expect(card.payload.status).toBe("reviewed");
      const replace = await meetingActionId(t, cookie, meetingId, "meeting.replace_transcript");
      expect(replace).toBeTruthy();
      const replaced = await execute(t, cookie, replace, {
        transcript: { schemaVersion: "warmap-transcript.v1", meetingId, turns: TURNS },
        confirmReplace: true,
      });
      expect(replaced.statusCode).toBe(200);
      const payload = replaced.json().cards[0].payload;
      // 旧 Outcome 作废，Meeting 回到 held 并重新整理：现在生成的是会议卡，不再有逐条条目
      expect(payload.status).toBe("held");
      expect(payload.outcome).toMatchObject({ status: "ready", items: [], summary: "" });
      expect((await t.sql("SELECT draft_status FROM meeting_cards WHERE meeting_id = $1", [meetingId]))[0].draft_status).toBe("draft_ready");
    } finally {
      await t.close();
    }
  });

  it("delegates a meeting Receipt revoke from the Issue page so Outcome and Meeting do not drift", async () => {
    const t = await createTestApp({}, undefined, { preflightAgent, outcomeAgent: outcomeAgent() });
    try {
      const { cookie, issueId, meetingId } = await readyOutcome(t, candidate, { confirmDecisions: true });

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
      const { cookie, issueId, meetingId } = await readyOutcome(t, candidate, { confirmDecisions: true });
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
});
