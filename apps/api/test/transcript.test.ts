import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { Value } from "@sinclair/typebox/value";
import {
  Card,
  MeetingCardPayload,
  MeetingOutcomeState,
  StoredTranscript,
  type TPostMeetingCandidate,
  type TPreflightCandidate,
} from "@warmap/contracts";
import { createTestApp, createTestDb, testEnv, type TestApp } from "./helpers.js";
import { recoverInterruptedOutcome, type PostMeetingAgent, type PostMeetingAgentInput } from "../src/outcome.js";
import type { PreflightAgent, PreflightAgentInput } from "../src/meetings.js";
import { migrate } from "../src/migrate.js";
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

function transcript(meetingId: string, turns: unknown = TURNS): Record<string, unknown> {
  return { schemaVersion: "warmap-transcript.v1", meetingId, turns };
}

function defaultCandidate(): TPostMeetingCandidate {
  return {
    summary: "会议形成一项方向决定与一项待办",
    items: [
      { kind: "decision", text: "灯塔项目优先", turnId: "turn-001", quote: "灯塔项目优先" },
      { kind: "todo", text: "周五前提交资源排期", turnId: "turn-002", quote: "我周五前提交资源排期", ownerPersonId: "person-fixture-002" },
      { kind: "ceoJudgment", text: "外部承诺先不签", turnId: "turn-003", quote: "外部承诺先不签", judgmentKind: "external_commitment" },
      { kind: "reopenWhen", text: "六月前", turnId: "turn-003", quote: "六月前", parentIndex: 0 },
      { kind: "open", text: "TokenOps 最低验证力量", turnId: "turn-001", quote: "TokenOps 保留最低验证力量" },
    ],
  };
}

type FakeOutcomeAgent = PostMeetingAgent & { calls: PostMeetingAgentInput[] };

function fakeOutcomeAgent(
  build: ((input: PostMeetingAgentInput, call: number) => unknown) | unknown = defaultCandidate(),
): FakeOutcomeAgent {
  const agent: FakeOutcomeAgent = {
    calls: [],
    async generate(input) {
      agent.calls.push(input);
      const candidate = typeof build === "function" ? (build as (input: PostMeetingAgentInput, call: number) => unknown)(input, agent.calls.length) : build;
      if (candidate instanceof Error) throw candidate;
      return { candidate, runId: `outcome-run-${agent.calls.length}` };
    },
  };
  return agent;
}

const preflightAgent: PreflightAgent = {
  async generate(input: PreflightAgentInput) {
    const candidate: TPreflightCandidate = {
      entries: [{ kind: "agenda", title: "议程", body: "对齐渠道投入", sourceRefs: input.issues.map((issue) => `issue:${issue.id}`) }],
      basis: "依据关联 Issue",
      brief: "会前确认渠道节奏",
    };
    return { candidate };
  },
};

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

/** 从 Issue 创建一个 preflight ready 的 scheduled Meeting。 */
async function readyMeeting(t: TestApp, externalId: string): Promise<{ cookie: string; issueId: string; meetingId: string }> {
  const issueId = await createIssue(t, `dri-transcript-${externalId}`);
  const cookie = await t.loginCookie();
  const card = await t.app.inject({ method: "GET", url: `/api/cards/issues/${issueId}`, headers: { cookie } });
  const descriptor = card.json().cards[0].actions.find((a: { actionType: string }) => a.actionType === "issue.create_meeting");
  const created = await t.app.inject({
    method: "POST",
    url: "/api/actions/execute",
    headers: { cookie, origin: t.publicOrigin },
    payload: { actionId: descriptor.actionId, input: { ...MEETING_INPUT, issueIds: [issueId] } },
  });
  expect(created.statusCode).toBe(200);
  return { cookie, issueId, meetingId: created.json().cards[0].objectRef.id as string };
}

async function meetingCard(t: TestApp, cookie: string, meetingId: string): Promise<Record<string, unknown>> {
  const res = await t.app.inject({ method: "GET", url: `/api/cards/meetings/${meetingId}`, headers: { cookie } });
  return res.json().cards[0];
}

async function meetingAction(t: TestApp, cookie: string, meetingId: string, actionType: string): Promise<string | undefined> {
  const card = await meetingCard(t, cookie, meetingId);
  return (card.actions as { actionType: string; actionId: string }[]).find((a) => a.actionType === actionType)?.actionId;
}

async function execute(t: TestApp, cookie: string, actionId: string | undefined, input?: unknown) {
  return t.app.inject({
    method: "POST",
    url: "/api/actions/execute",
    headers: { cookie, origin: t.publicOrigin },
    payload: { actionId, input },
  });
}

function multipartPart(body: unknown): { boundary: string; payload: Buffer } {
  const boundary = "----warmap-transcript-boundary";
  return {
    boundary,
    payload: Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="transcript.json"\r\nContent-Type: application/json\r\n\r\n`),
      Buffer.from(JSON.stringify(body)),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]),
  };
}

type Via = "web" | "service";

/** 两个入口共用同一个导入边界：只有认证与传输形式不同。 */
async function importVia(t: TestApp, via: Via, meetingId: string, cookie: string, body: unknown) {
  if (via === "web") {
    const { boundary, payload } = multipartPart(body);
    return t.app.inject({
      method: "POST",
      url: `/api/meetings/${meetingId}/transcript`,
      headers: { cookie, origin: t.publicOrigin, "content-type": `multipart/form-data; boundary=${boundary}` },
      payload,
    });
  }
  return t.app.inject({
    method: "POST",
    url: `/api/dri/meetings/${meetingId}/transcript`,
    headers: { authorization: `Bearer ${t.env.driServiceToken}` },
    payload: body as Record<string, unknown>,
  });
}

describe("warmap-transcript.v1 import boundary", () => {
  it.each<Via>(["web", "service"])("imports a valid transcript via %s, moves the Meeting to held and projects transcript plus outcome", async (via) => {
    const agent = fakeOutcomeAgent();
    const t = await createTestApp({}, undefined, { preflightAgent, outcomeAgent: agent });
    try {
      const { cookie, issueId, meetingId } = await readyMeeting(t, via);
      const res = await importVia(t, via, meetingId, cookie, transcript(meetingId));
      expect(res.statusCode).toBe(200);
      const card = res.json().cards[0];
      expect(Value.Check(Card, card)).toBe(true);
      expect(Value.Check(MeetingCardPayload, card.payload)).toBe(true);
      expect(Value.Check(StoredTranscript, card.payload.transcript)).toBe(true);
      expect(Value.Check(MeetingOutcomeState, card.payload.outcome)).toBe(true);
      expect(card.payload).toMatchObject({ status: "held", transcript: { meetingId } });
      expect(card.payload.outcome).toMatchObject({ status: "ready", error: null });

      const items = card.payload.outcome.items as { id: string; kind: string; turnId: string; quote: string; speakerId: string; parentItemId: string | null; review: { status: string } | null }[];
      expect(items.map((item) => item.id)).toEqual(["item-1", "item-2", "item-3", "item-4", "item-5"]);
      expect(items[0]).toMatchObject({ kind: "decision", turnId: "turn-001", quote: "灯塔项目优先", speakerId: "person-fixture-001", parentItemId: null });
      expect(items[1]).toMatchObject({ kind: "todo", ownerPersonId: "person-fixture-002", review: { status: "pending" } });
      expect(items[2]).toMatchObject({ kind: "ceoJudgment", speakerId: "person-fixture-001", judgmentKind: "external_commitment" });
      expect(items[3]).toMatchObject({ kind: "reopenWhen", parentItemId: "item-1" });
      // open 只展示，不带 Review
      expect(items[4]).toMatchObject({ kind: "open", review: null });
      // Agent 收到已保存的 turns 与关联 Issue，不吃原始上传对象
      expect(agent.calls).toHaveLength(1);
      expect(agent.calls[0].transcript.turns.map((turn) => turn.id)).toEqual(["turn-001", "turn-002", "turn-003"]);
      expect(agent.calls[0].issues.map((issue) => issue.id)).toEqual([issueId]);
      expect(agent.calls[0].meeting.ceoParticipantId).toBe("person-fixture-001");

      // 已 held 后不再接受普通导入，只能走危险替换 Action
      expect((await importVia(t, via, meetingId, cookie, transcript(meetingId))).statusCode).toBe(409);
    } finally {
      await t.close();
    }
  });

  it.each<[string, (body: Record<string, unknown>) => unknown, string]>([
    ["重复 turn ID", (body) => ({ ...body, turns: [TURNS[0], { ...TURNS[1], id: "turn-001" }] }), "DUPLICATE_TURN_ID"],
    ["未知 speakerId", (body) => ({ ...body, turns: [TURNS[0], { ...TURNS[1], speakerId: "person-by-name" }] }), "UNKNOWN_SPEAKER"],
    ["空文本", (body) => ({ ...body, turns: [TURNS[0], { ...TURNS[1], text: "   \n" }] }), "EMPTY_TURN_TEXT"],
    ["时间倒序", (body) => ({ ...body, turns: [TURNS[1], { ...TURNS[0], startedAt: "2026-06-01T09:59:00+08:00" }] }), "INVALID_TURN_TIME"],
    ["时间缺少时区", (body) => ({ ...body, turns: [{ ...TURNS[0], startedAt: "2026-06-01T10:00:05" }] }), "INVALID_TURN_TIME"],
    ["schemaVersion 不符", (body) => ({ ...body, schemaVersion: "warmap-transcript.v2" }), "INVALID_TRANSCRIPT"],
    ["meetingId 不一致", (body) => ({ ...body, meetingId: randomUUID() }), "TRANSCRIPT_MEETING_MISMATCH"],
    ["空 turns", (body) => ({ ...body, turns: [] }), "INVALID_TRANSCRIPT"],
  ])("rejects %s整份且不改变 Meeting（两个入口）", async (_label, mutate, code) => {
    const agent = fakeOutcomeAgent();
    const t = await createTestApp({}, undefined, { preflightAgent, outcomeAgent: agent });
    try {
      for (const via of ["web", "service"] as Via[]) {
        const { cookie, meetingId } = await readyMeeting(t, `${_label}-${via}`);
        const res = await importVia(t, via, meetingId, cookie, mutate(transcript(meetingId)));
        expect(res.statusCode).toBe(400);
        expect(res.json().code).toBe(code);
        const row = (await t.sql("SELECT status, transcript, outcome FROM meetings WHERE id = $1", [meetingId]))[0];
        expect(row).toMatchObject({ status: "scheduled", transcript: null, outcome: null });
      }
      // 整份拒绝不启动 Agent
      expect(agent.calls).toHaveLength(0);
    } finally {
      await t.close();
    }
  });

  it.each<Via>(["web", "service"])("enforces the same size limit on %s and never starts extraction on a rejected payload", async (via) => {
    const agent = fakeOutcomeAgent();
    const t = await createTestApp({}, undefined, { preflightAgent, outcomeAgent: agent });
    try {
      const { cookie, meetingId } = await readyMeeting(t, `oversize-${via}`);
      const huge = transcript(meetingId, [{ id: "turn-001", speakerId: "person-fixture-001", text: "x".repeat(1_200_000) }]);
      const res = await importVia(t, via, meetingId, cookie, huge);
      expect(res.statusCode).toBe(413);
      expect((await t.sql("SELECT status FROM meetings WHERE id = $1", [meetingId]))[0].status).toBe("scheduled");
      expect(agent.calls).toHaveLength(0);
    } finally {
      await t.close();
    }
  });

  it("rejects invalid UTF-8 in the multipart upload", async () => {
    const t = await createTestApp({}, undefined, { preflightAgent, outcomeAgent: fakeOutcomeAgent() });
    try {
      const { cookie, meetingId } = await readyMeeting(t, "bad-utf8");
      const boundary = "----warmap-bad-utf8";
      const payload = Buffer.concat([
        Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="transcript.json"\r\n\r\n`),
        Buffer.from([0x7b, 0xff, 0xfe, 0x7d]),
        Buffer.from(`\r\n--${boundary}--\r\n`),
      ]);
      const res = await t.app.inject({
        method: "POST",
        url: `/api/meetings/${meetingId}/transcript`,
        headers: { cookie, origin: t.publicOrigin, "content-type": `multipart/form-data; boundary=${boundary}` },
        payload,
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe("INVALID_TRANSCRIPT_ENCODING");
    } finally {
      await t.close();
    }
  });

  it("requires authentication on both entrypoints and rejects a CEO session on the service API", async () => {
    const t = await createTestApp({}, undefined, { preflightAgent, outcomeAgent: fakeOutcomeAgent() });
    try {
      const { cookie, meetingId } = await readyMeeting(t, "auth");
      const { boundary, payload } = multipartPart(transcript(meetingId));
      const anonymous = await t.app.inject({
        method: "POST",
        url: `/api/meetings/${meetingId}/transcript`,
        headers: { origin: t.publicOrigin, "content-type": `multipart/form-data; boundary=${boundary}` },
        payload,
      });
      expect(anonymous.statusCode).toBe(401);
      const crossOrigin = await t.app.inject({
        method: "POST",
        url: `/api/meetings/${meetingId}/transcript`,
        headers: { cookie, origin: "https://evil.example", "content-type": `multipart/form-data; boundary=${boundary}` },
        payload,
      });
      expect(crossOrigin.statusCode).toBe(403);
      const ceoOnService = await t.app.inject({
        method: "POST",
        url: `/api/dri/meetings/${meetingId}/transcript`,
        headers: { cookie },
        payload: transcript(meetingId),
      });
      expect(ceoOnService.statusCode).toBe(401);
    } finally {
      await t.close();
    }
  });
});

describe("deterministic PostMeeting candidate validation", () => {
  it("keeps a candidate whose quote only exists in another turn out of review items and records a warning", async () => {
    const candidate: TPostMeetingCandidate = {
      summary: "x",
      items: [
        // 引文来自 turn-002，却声称来自 turn-001：必须整项拒绝，不因全文包含而放行
        { kind: "decision", text: "排期决定", turnId: "turn-001", quote: "我周五前提交资源排期" },
        { kind: "todo", text: "保留最低验证力量", turnId: "turn-001", quote: "TokenOps 保留最低验证力量" },
      ],
    };
    const t = await createTestApp({}, undefined, { preflightAgent, outcomeAgent: fakeOutcomeAgent(candidate) });
    try {
      const { cookie, meetingId } = await readyMeeting(t, "quote-turn");
      const res = await importVia(t, "web", meetingId, cookie, transcript(meetingId));
      const outcome = res.json().cards[0].payload.outcome;
      expect(outcome.status).toBe("ready");
      expect(outcome.items.map((item: { id: string }) => item.id)).toEqual(["item-2"]);
      expect(outcome.warnings).toHaveLength(1);
      expect(outcome.warnings[0].reason).toContain("连续引文");
      expect(outcome.warnings[0].candidate).toMatchObject({ turnId: "turn-001" });
    } finally {
      await t.close();
    }
  });

  it("rejects unknown owners, owners not derivable from the turn, non-CEO judgments and out-of-scope issues", async () => {
    const candidate: TPostMeetingCandidate = {
      summary: "x",
      items: [
        { kind: "todo", text: "未知身份", turnId: "turn-002", quote: "我周五前提交资源排期", ownerPersonId: "person-not-in-seed" },
        { kind: "todo", text: "无法归属", turnId: "turn-002", quote: "我周五前提交资源排期", ownerPersonId: "person-fixture-001" },
        { kind: "ceoJudgment", text: "DRI 不能下 CEO 判断", turnId: "turn-002", quote: "我周五前提交资源排期", judgmentKind: "major_risk" },
        { kind: "decision", text: "无关 Issue", turnId: "turn-001", quote: "灯塔项目优先", issueId: "00000000-0000-4000-8000-000000000001" },
        { kind: "todo", text: "合法待办", turnId: "turn-002", quote: "我周五前提交资源排期", ownerPersonId: "person-fixture-002" },
      ],
    };
    const t = await createTestApp({}, undefined, { preflightAgent, outcomeAgent: fakeOutcomeAgent(candidate) });
    try {
      const { cookie, meetingId } = await readyMeeting(t, "owner");
      const res = await importVia(t, "service", meetingId, cookie, transcript(meetingId));
      const outcome = res.json().cards[0].payload.outcome;
      expect(outcome.items.map((item: { id: string }) => item.id)).toEqual(["item-5"]);
      expect(outcome.warnings.map((warning: { reason: string }) => warning.reason)).toEqual([
        "owner 不是该 Meeting 的 participant: person-not-in-seed",
        "owner 无法由该 turn 确定: person-fixture-001",
        "CEO 判断必须来自 CEO turn",
        "issueId 不属于该 Meeting: 00000000-0000-4000-8000-000000000001",
      ]);
    } finally {
      await t.close();
    }
  });

  it("accepts an owner explicitly named in the quote and a reopenWhen only for an accepted parent decision", async () => {
    const candidate: TPostMeetingCandidate = {
      summary: "x",
      items: [
        { kind: "todo", text: "点名归属", turnId: "turn-001", quote: "灯塔项目优先", ownerPersonId: "person-fixture-002" },
        { kind: "reopenWhen", text: "孤儿条件", turnId: "turn-001", quote: "灯塔项目优先", parentIndex: 7 },
      ],
    };
    const t = await createTestApp({}, undefined, { preflightAgent, outcomeAgent: fakeOutcomeAgent(candidate) });
    try {
      const { cookie, meetingId } = await readyMeeting(t, "named-owner");
      // 引文不含 speaker 之外的显示名 → 拒绝
      const res = await importVia(t, "web", meetingId, cookie, transcript(meetingId));
      const outcome = res.json().cards[0].payload.outcome;
      expect(outcome.items).toHaveLength(0);
      expect(outcome.warnings).toHaveLength(2);
      expect(outcome.warnings[1].reason).toContain("父 decision");
    } finally {
      await t.close();
    }
  });

  it("fails the whole extraction on a schema-invalid candidate and keeps the transcript", async () => {
    const t = await createTestApp({}, undefined, { preflightAgent, outcomeAgent: fakeOutcomeAgent({ summary: "x", items: [{ kind: "decision" }] }) });
    try {
      const { cookie, meetingId } = await readyMeeting(t, "invalid-candidate");
      const res = await importVia(t, "web", meetingId, cookie, transcript(meetingId));
      const payload = res.json().cards[0].payload;
      expect(payload.status).toBe("held");
      expect(payload.transcript.turns).toHaveLength(3);
      expect(payload.outcome).toMatchObject({ status: "failed", error: { code: "invalid_outcome_candidate" } });
    } finally {
      await t.close();
    }
  });
});

describe("outcome extraction failure and explicit retry", () => {
  it("keeps the raw transcript, exposes the failure and only retries on an explicit Action", async () => {
    let calls = 0;
    const agent: PostMeetingAgent & { calls: PostMeetingAgentInput[] } = {
      calls: [],
      async generate(input) {
        agent.calls.push(input);
        calls += 1;
        if (calls === 1) throw new Error("model unreachable");
        return { candidate: defaultCandidate() };
      },
    };
    const t = await createTestApp({}, undefined, { preflightAgent, outcomeAgent: agent });
    try {
      const { cookie, meetingId } = await readyMeeting(t, "retry");
      const imported = await importVia(t, "web", meetingId, cookie, transcript(meetingId));
      expect(imported.statusCode).toBe(200);
      const payload = imported.json().cards[0].payload;
      expect(payload.status).toBe("held");
      expect(payload.transcript.turns.map((turn: { id: string }) => turn.id)).toEqual(["turn-001", "turn-002", "turn-003"]);
      expect(payload.outcome).toMatchObject({ status: "failed", error: { code: "outcome_agent_failed", message: "model unreachable" } });
      // 失败可见且不自动重试
      expect(agent.calls).toHaveLength(1);

      const retryAction = await meetingAction(t, cookie, meetingId, "meeting.retry_outcome");
      expect(retryAction).toBeTruthy();
      const retried = await execute(t, cookie, retryAction);
      expect(retried.statusCode).toBe(200);
      expect(retried.json().cards[0].payload.outcome).toMatchObject({ status: "ready", error: null });
      expect(agent.calls).toHaveLength(2);
      // 保留原始 Transcript
      expect(retried.json().cards[0].payload.transcript.turns).toHaveLength(3);

      // 幂等重放同一 retry Action：不再调用 Agent
      const replay = await execute(t, cookie, retryAction);
      expect(replay.statusCode).toBe(200);
      expect(agent.calls).toHaveLength(2);

      // ready 后不再提供 retry Action
      expect(await meetingAction(t, cookie, meetingId, "meeting.retry_outcome")).toBeUndefined();
    } finally {
      await t.close();
    }
  });

  it("does not expose retry or replace before a Transcript is imported", async () => {
    const t = await createTestApp({}, undefined, { preflightAgent, outcomeAgent: fakeOutcomeAgent() });
    try {
      const { cookie, meetingId } = await readyMeeting(t, "retry-guard");
      expect(await meetingAction(t, cookie, meetingId, "meeting.retry_outcome")).toBeUndefined();
      expect(await meetingAction(t, cookie, meetingId, "meeting.replace_transcript")).toBeUndefined();
    } finally {
      await t.close();
    }
  });
});

const TURNS_B = [
  { id: "turn-001", speakerId: "person-fixture-001", startedAt: "2026-06-01T10:00:05+08:00", text: "灯塔项目优先，TokenOps 保留最低验证力量。" },
  { id: "turn-002", speakerId: "person-fixture-002", startedAt: "2026-06-01T10:00:20+08:00", text: "我下周三前提交资源排期，先保灯塔。" },
  { id: "turn-003", speakerId: "person-fixture-001", startedAt: "2026-06-01T10:01:00+08:00", text: "外部承诺先不签，六月前给我风险清单。" },
];

const CANDIDATE_B: TPostMeetingCandidate = {
  summary: "替换后的抽取",
  items: [{ kind: "todo", text: "下周三前提交排期", turnId: "turn-002", quote: "我下周三前提交资源排期", ownerPersonId: "person-fixture-002" }],
};

describe("dangerous Transcript replacement", () => {
  it("replaces the transcript through the dangerous Action, invalidates the old candidate and re-extracts", async () => {
    const agent = fakeOutcomeAgent((_input, call) => (call === 1 ? defaultCandidate() : CANDIDATE_B));
    const t = await createTestApp({}, undefined, { preflightAgent, outcomeAgent: agent });
    try {
      const { cookie, meetingId } = await readyMeeting(t, "replace");
      const imported = await importVia(t, "web", meetingId, cookie, transcript(meetingId));
      const before = imported.json().cards[0];
      expect((before.payload.outcome.items as unknown[]).length).toBe(5);
      const staleReplace = await meetingAction(t, cookie, meetingId, "meeting.replace_transcript");
      expect(staleReplace).toBeTruthy();

      // 版本变化即让旧 actionId 失效，替换本身也通过 bump version 生效
      await t.sql("UPDATE meetings SET version = version + 1 WHERE id = $1", [meetingId]);
      const conflict = await execute(t, cookie, staleReplace, { transcript: transcript(meetingId, TURNS_B), confirmReplace: true });
      expect(conflict.statusCode).toBe(409);
      expect(conflict.json().code).toBe("VERSION_CONFLICT");
      expect((await t.sql("SELECT transcript FROM meetings WHERE id = $1", [meetingId]))[0].transcript.turns[1].text).toContain("周五");

      const replaceAction = await meetingAction(t, cookie, meetingId, "meeting.replace_transcript");
      const replaced = await execute(t, cookie, replaceAction, { transcript: transcript(meetingId, TURNS_B), confirmReplace: true });
      expect(replaced.statusCode).toBe(200);
      const payload = replaced.json().cards[0].payload;
      expect(payload.status).toBe("held");
      expect(payload.transcript.turns[1].text).toContain("下周三");
      expect(payload.outcome.status).toBe("ready");
      // 旧 candidate 整体作废，只保留新一次抽取的 items
      expect(payload.outcome.items.map((item: { id: string }) => item.id)).toEqual(["item-1"]);
      expect(payload.outcome.items[0]).toMatchObject({ kind: "todo", quote: "我下周三前提交资源排期" });
      expect(payload.outcome.summary).toBe("替换后的抽取");
    } finally {
      await t.close();
    }
  });

  it("refuses replacement once any item has a confirmed effect", async () => {
    const t = await createTestApp({}, undefined, { preflightAgent, outcomeAgent: fakeOutcomeAgent() });
    try {
      const { cookie, meetingId } = await readyMeeting(t, "replace-guard");
      const imported = await importVia(t, "web", meetingId, cookie, transcript(meetingId));
      const replaceAction = await meetingAction(t, cookie, meetingId, "meeting.replace_transcript");
      const outcome = imported.json().cards[0].payload.outcome;
      outcome.items[0].review = { status: "confirmed", effectRef: `meeting:${meetingId}:decision:item-1` };
      await t.sql("UPDATE meetings SET outcome = $2::jsonb WHERE id = $1", [meetingId, JSON.stringify(outcome)]);

      // 已有 confirmed effect 时 Card 不再暴露危险替换
      expect(await meetingAction(t, cookie, meetingId, "meeting.replace_transcript")).toBeUndefined();
      const res = await execute(t, cookie, replaceAction, { transcript: transcript(meetingId, TURNS_B), confirmReplace: true });
      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe("OUTCOME_HAS_CONFIRMED_EFFECT");
      expect((await t.sql("SELECT transcript FROM meetings WHERE id = $1", [meetingId]))[0].transcript.turns[1].text).toContain("周五");
    } finally {
      await t.close();
    }
  });

  it("refuses replacement on a scheduled Meeting and rejects an invalid replacement transcript without touching state", async () => {
    const t = await createTestApp({}, undefined, { preflightAgent, outcomeAgent: fakeOutcomeAgent() });
    try {
      const { cookie, meetingId } = await readyMeeting(t, "replace-scheduled");
      expect(await meetingAction(t, cookie, meetingId, "meeting.replace_transcript")).toBeUndefined();
      const version = (await t.sql("SELECT version FROM meetings WHERE id = $1", [meetingId]))[0].version as number;
      const scheduledAction = signActionId(testEnv.sessionSecret, {
        actionType: "meeting.replace_transcript",
        objectType: "meeting",
        objectId: meetingId,
        objectVersion: version,
      });
      const scheduled = await execute(t, cookie, scheduledAction, { transcript: transcript(meetingId), confirmReplace: true });
      expect(scheduled.statusCode).toBe(409);
      expect(scheduled.json().code).toBe("MEETING_NOT_HELD");

      await importVia(t, "web", meetingId, cookie, transcript(meetingId));
      const replaceAction = await meetingAction(t, cookie, meetingId, "meeting.replace_transcript");
      const invalid = await execute(t, cookie, replaceAction, { transcript: transcript(meetingId, [{ ...TURNS[0], id: "turn-001" }, { ...TURNS[1], id: "turn-001" }]), confirmReplace: true });
      expect(invalid.statusCode).toBe(400);
      expect(invalid.json().code).toBe("DUPLICATE_TURN_ID");
      expect((await t.sql("SELECT transcript FROM meetings WHERE id = $1", [meetingId]))[0].transcript.turns).toHaveLength(3);
    } finally {
      await t.close();
    }
  });
  it("rejects a replacement without the explicit second confirmation and leaves state untouched", async () => {
    const t = await createTestApp({}, undefined, { preflightAgent, outcomeAgent: fakeOutcomeAgent() });
    try {
      const { cookie, meetingId } = await readyMeeting(t, "replace-confirm");
      await importVia(t, "web", meetingId, cookie, transcript(meetingId));
      const replaceAction = await meetingAction(t, cookie, meetingId, "meeting.replace_transcript");
      const res = await execute(t, cookie, replaceAction, { transcript: transcript(meetingId, TURNS_B) });
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe("INVALID_INPUT");
      expect((await t.sql("SELECT transcript FROM meetings WHERE id = $1", [meetingId]))[0].transcript.turns[1].text).toContain("周五");
    } finally {
      await t.close();
    }
  });
});

describe("startup recovery of an interrupted outcome extraction", () => {
  it("marks a stale pending/running extraction as a visible failure and waits for an explicit retry", async () => {
    await createTestDb(async ({ db, pool }) => {
      await migrate(db);
      const meetingId = randomUUID();
      const participants = [
        { personId: "person-fixture-001", displayName: "测试甲", roles: ["ceo"], sourceRef: "people:person-fixture-001", updatedAt: "2026-05-01T00:00:00.000Z" },
        { personId: "person-fixture-002", displayName: "测试乙", roles: ["dri"], sourceRef: "people:person-fixture-002", updatedAt: "2026-05-01T00:00:00.000Z" },
      ];
      await db.query(
        `INSERT INTO meetings
           (id, version, title, status, scheduled_at, lead_dri_id, ceo_participant_id,
            participants, issue_ids, preflight, draft, transcript, outcome, origin_ref)
         VALUES ($1, 1, '恢复测试', 'held', now(), 'person-fixture-002', 'person-fixture-001',
                 $2::jsonb, '[]'::jsonb, '{}'::jsonb, '{}'::jsonb, $3::jsonb, $4::jsonb, '{}'::jsonb)`,
        [
          meetingId,
          JSON.stringify(participants),
          JSON.stringify({ schemaVersion: "warmap-transcript.v1", meetingId, turns: TURNS, importedAt: "2026-06-01T02:01:00.000Z" }),
          JSON.stringify({ status: "running", pendingSince: "2026-06-01T02:01:00.000Z", startedAt: "2026-06-01T02:01:00.000Z", runId: randomUUID(), previousRunIds: [], error: null, summary: "", items: [], warnings: [], extractedAt: null }),
        ],
      );
      expect(await recoverInterruptedOutcome(pool.query.bind(pool), { now: () => new Date("2026-06-01T03:00:00.000Z") })).toBe(1);
      const row = await db.query("SELECT outcome FROM meetings WHERE id = $1", [meetingId]);
      expect(row.rows[0].outcome).toMatchObject({ status: "failed", error: { code: "outcome_interrupted" } });
      // 再恢复不重复改动，也不自动重试
      expect(await recoverInterruptedOutcome(pool.query.bind(pool), { now: () => new Date("2026-06-01T03:00:00.000Z") })).toBe(0);
    });
  });
});
