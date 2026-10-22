import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { Value } from "@sinclair/typebox/value";
import { IssueDecisionHistory, MeetingDecisionHistoryResponse, type TPostMeetingCandidate } from "@warmap/contracts";
import { createTestApp, preflightCandidate, seedLegacyOutcome, type TestApp } from "./helpers.js";
import type { PostMeetingAgent, PostMeetingAgentInput } from "../src/outcome.js";
import type { PreflightAgent, PreflightAgentInput } from "../src/meetingPreflight.js";
import { createObjectMaterial } from "../src/objectMaterials.js";
import { NO_EFFECTIVE_DECISION, NO_EXECUTION_EVIDENCE, PENDING_CANDIDATE_NOTE } from "../src/issueDecisionHistory.js";

const CEO_ID = "person-fixture-001";
const DRI_ID = "person-fixture-002";

const TURNS = [
  { id: "turn-001", speakerId: CEO_ID, startedAt: "2026-05-01T10:00:05+08:00", text: "先统一验收标准，定制需审批。" },
  { id: "turn-002", speakerId: CEO_ID, startedAt: "2026-05-01T10:01:05+08:00", text: "两家大单允许定制验收。" },
  { id: "turn-003", speakerId: DRI_ID, startedAt: "2026-05-01T10:02:05+08:00", text: "我下周把验收清单发给客户。" },
];

/** 第一场确认“先统一验收标准”；第二场提出“两家大单允许定制验收”（确认后又撤回）。旧格式会议的逐条条目（seedLegacyOutcome 写入）。 */
function legacyCandidate(issueId: string, title: string): TPostMeetingCandidate {
  const second = title.includes("第二场");
  return {
    summary: second ? "讨论大单定制" : "确定统一验收标准",
    items: [second
      ? { kind: "decision", text: "两家大单允许定制验收", turnId: "turn-002", quote: "两家大单允许定制验收", issueId }
      : { kind: "decision", text: "先统一验收标准，定制需审批", turnId: "turn-001", quote: "先统一验收标准，定制需审批", issueId }],
  };
}

/** 现在的会后整理只生成会议卡；逐条条目由 holdWithOutcome 按旧会议写入。 */
function outcomeAgent(): PostMeetingAgent {
  return {
    async generate(input: PostMeetingAgentInput) {
      return { candidate: { summary: input.meeting.title, sections: [{ heading: "验收", body: "已定：按会上说的办。", turnIds: [] }], objectChanges: [], actionItems: [] } };
    },
  };
}

function recordingPreflight(): PreflightAgent & { calls: PreflightAgentInput[]; refs?: (input: PreflightAgentInput) => string[] } {
  const agent: PreflightAgent & { calls: PreflightAgentInput[]; refs?: (input: PreflightAgentInput) => string[] } = {
    calls: [],
    async generate(input) {
      agent.calls.push(input);
      return { candidate: preflightCandidate(agent.refs ? agent.refs(input) : [`meeting:${input.meeting.id}`]) };
    },
  };
  return agent;
}

async function createIssue(t: TestApp, externalId: string, location: unknown = { level: "battlefield", battlefieldId: "growth" }): Promise<string> {
  const res = await t.app.inject({
    method: "POST",
    url: "/api/dri/issues",
    headers: { authorization: `Bearer ${t.env.driServiceToken}` },
    payload: { externalId, submitterPersonId: DRI_ID, title: "签约前是否把统一验收清单设为刚性前置", whyNow: "两家大单本月签约", sourceRef: `dri://test/${externalId}`, location },
  });
  expect(res.statusCode).toBe(201);
  return res.json().cards[0].objectRef.id as string;
}

async function importMeeting(t: TestApp, externalId: string, title: string, scheduledAt: string, issueId: string): Promise<string> {
  const res = await t.app.inject({
    method: "POST",
    url: "/api/dri/meetings",
    headers: { authorization: `Bearer ${t.env.driServiceToken}` },
    payload: { externalId, title, scheduledAt, leadDriId: DRI_ID, ceoParticipantId: CEO_ID, participants: [DRI_ID], issueIds: [issueId] },
  });
  expect(res.statusCode).toBe(201);
  return res.json().cards[0].objectRef.id as string;
}

async function holdWithOutcome(t: TestApp, meetingId: string, seed: { confirmDecisions?: boolean } = {}): Promise<void> {
  const res = await t.app.inject({
    method: "POST",
    url: `/api/dri/meetings/${meetingId}/transcript`,
    headers: { authorization: `Bearer ${t.env.driServiceToken}` },
    payload: { schemaVersion: "warmap-transcript.v1", meetingId, turns: TURNS },
  });
  expect(res.statusCode).toBe(200);
  expect(res.json().cards[0].payload.outcome).toMatchObject({ status: "ready" });
  const meeting = (await t.sql("SELECT title, issue_ids FROM meetings WHERE id = $1", [meetingId]))[0];
  await seedLegacyOutcome(t.pool, meetingId, legacyCandidate(meeting.issue_ids[0], meeting.title), seed);
}

/** 议题页撤回一条回执（旧会议的会上决定回执由议题页代为撤回，会议条目跟着回到待处理）。 */
async function revokeReceipt(t: TestApp, cookie: string, issueId: string, receiptId: string) {
  const card = (await t.app.inject({ method: "GET", url: `/api/cards/issues/${issueId}`, headers: { cookie } })).json().cards[0];
  const descriptor = card.actions.find((action: { actionType: string; itemId?: string }) => action.actionType === "issue.revoke_receipt" && action.itemId === receiptId);
  expect(descriptor, "issue.revoke_receipt 应可用").toBeTruthy();
  const res = await t.app.inject({ method: "POST", url: "/api/actions/execute", headers: { cookie, origin: t.publicOrigin }, payload: { actionId: descriptor.actionId, input: { reason: "会后撤回" } } });
  expect(res.statusCode).toBe(200);
}

describe("feedback 9：有效历史决定、此后执行变化、本次待判断分层", () => {
  it("连续三场讨论同一议题：第一场仍有效的决定不遗漏，撤回与被替代的不作约束，未确认候选不冒充决定", async () => {
    const preflight = recordingPreflight();
    const t = await createTestApp({}, undefined, { preflightAgent: preflight, outcomeAgent: outcomeAgent() });
    try {
      const cookie = await t.loginCookie();
      const issueId = await createIssue(t, "history-chain");

      // 客户包导入的更早历史：4/01 的决定被 4/10 的决定替代
      const oldId = randomUUID();
      const newId = randomUUID();
      await t.sql(
        `INSERT INTO issue_decision_history (id, issue_id, external_id, decided_at, decided_by, decision_text, option_label, source_ref, status, superseded_by, status_at)
         VALUES ($1::uuid, $3::uuid, 'd-old', '2026-04-01T02:00:00Z', $4, '大单一律按客户要求定制验收', NULL, '2026-04-01 销售例会纪要第 2 条', 'superseded', $2::text, '2026-04-10T02:00:00Z'::timestamptz),
                ($2::uuid, $3::uuid, 'd-new', '2026-04-10T02:00:00Z', $4, '定制验收必须经交付负责人评估', '评估后再定', '2026-04-10 交付周会纪要第 1 条', 'effective', NULL, NULL)`,
        [oldId, newId, issueId, CEO_ID],
      );

      // 第一场：当时已确认“先统一验收标准”（旧会议的逐条确认）
      const first = await importMeeting(t, "m-1", "验收标准第一场", "2026-05-01T10:00:00+08:00", issueId);
      await holdWithOutcome(t, first, { confirmDecisions: true });

      // 第二场：当时确认了“两家大单允许定制验收”，随后在议题页撤回 → 回到待确认候选
      const second = await importMeeting(t, "m-2", "验收标准第二场", "2026-05-15T10:00:00+08:00", issueId);
      await holdWithOutcome(t, second, { confirmDecisions: true });
      const secondReceipt = ((await t.sql("SELECT receipts FROM issues WHERE id = $1", [issueId]))[0].receipts as { id: string; decisionText: string }[])
        .find((receipt) => receipt.decisionText === "两家大单允许定制验收")!;
      await revokeReceipt(t, cookie, issueId, secondReceipt.id);

      // 此后的执行事实：阶段反馈（有一条早于所有有效决定，不应列出）、群讨论、材料修订
      await t.sql(
        `INSERT INTO monthly_plans (id, version, period, status, company_outcome, battlefields, todos, negotiation, generation, confirmed_at)
         VALUES ($1, 1, '2026-05', 'confirmed', '五月目标', '[]'::jsonb, '[]'::jsonb, $2::jsonb, '{"status":"ready"}'::jsonb, '2026-05-01T00:00:00Z')`,
        [randomUUID(), JSON.stringify({ edits: [], checkedItemIds: [], note: "", feedback: [
          { id: "fb-early", externalId: "fb-early", battlefieldId: "growth", text: "三月旧反馈", observedAt: "2026-03-01T00:00:00Z", sourceRef: "三月周报" },
          { id: "fb-1", externalId: "fb-1", battlefieldId: "growth", text: "5 月标准上线 2 家，1 家因客户机房延期", observedAt: "2026-05-20T00:00:00Z", sourceRef: "交付周报 5/20" },
        ] })],
      );
      const message = await t.sql(
        "INSERT INTO thread_messages (object_type, object_id, author_id, kind, content) VALUES ('meeting', $1, $2, 'member', '客户提出合同验收条款不能改') RETURNING id",
        [second, DRI_ID],
      );
      const material = await createObjectMaterial(t.pool, { objectType: "issue", objectId: issueId }, { personId: CEO_ID, role: "ceo", displayName: "测试甲" },
        "客户条款", "客户要求按合同原条款验收", "客户原话", null);

      // 第三场：会前预审拿到完整分层
      preflight.refs = (input) => [input.decisionHistory[0].effective[0].ref, "feedback:fb-1"];
      const third = await importMeeting(t, "m-3", "验收标准第三场", "2026-06-01T10:00:00+08:00", issueId);
      const input = preflight.calls.at(-1)!;
      expect(input.meeting.id).toBe(third);
      const history = input.decisionHistory[0];
      const receipts = (await t.sql("SELECT receipts FROM issues WHERE id = $1", [issueId]))[0].receipts as { id: string; decisionText: string; revokedAt?: string }[];
      const firstReceipt = receipts.find((receipt) => receipt.decisionText === "先统一验收标准，定制需审批")!;
      const revokedReceipt = receipts.find((receipt) => receipt.decisionText === "两家大单允许定制验收")!;
      expect(revokedReceipt.revokedAt).toBeTruthy();

      expect(history.effective.map((entry) => entry.ref)).toEqual([`decision:${newId}`, `decision:${firstReceipt.id}`]);
      expect(history.effective[1]).toMatchObject({
        text: "先统一验收标准，定制需审批", status: "effective", confirmedVia: "meeting.confirm_item",
        decidedBy: { personId: CEO_ID, displayName: "测试甲" },
        source: { kind: "meeting-item", meetingId: first, meetingTitle: "验收标准第一场", turnId: "turn-001", quote: "先统一验收标准，定制需审批" },
      });
      expect(history.effective[0]).toMatchObject({ confirmedVia: "imported", option: { id: null, label: "评估后再定" },
        source: { kind: "imported", importedRef: "2026-04-10 交付周会纪要第 1 条" } });
      expect(history.inactive.map((entry) => [entry.ref, entry.status])).toEqual([
        [`decision:${oldId}`, "superseded"],
        [`decision:${revokedReceipt.id}`, "revoked"],
      ]);
      expect(history.inactive[0].supersededBy).toBe(`decision:${newId}`);
      // 撤回后的决定回到候选：只在 pending，且明确不是决定
      expect(history.pending).toEqual([expect.objectContaining({
        kind: "outcome_candidate", text: "两家大单允许定制验收", note: PENDING_CANDIDATE_NOTE,
        source: expect.objectContaining({ meetingId: second, turnId: "turn-002" }),
      })]);
      expect(history.effective.some((entry) => entry.text.includes("两家大单"))).toBe(false);
      // 执行变化：起算于最早仍有效决定（4/10），早于它的反馈不列
      expect(history.changesSince).toBe("2026-04-10T02:00:00.000Z");
      expect(history.changes.map((change) => change.ref)).toEqual(expect.arrayContaining([
        "feedback:fb-1", `discussion:${Number(message[0].id)}`, `material:${material.id}@v1`,
      ]));
      expect(history.changes.map((change) => change.ref)).not.toContain("feedback:fb-early");
      expect(history.changes.find((change) => change.kind === "discussion")).toMatchObject({ author: { displayName: "测试乙" } });
      expect(history.changesNote).toBeNull();
      expect(history.relatedMeetings.map((meeting) => meeting.id)).toEqual([first, second, third]);

      // 预审记录了作为约束的决定与只供审计的失效决定；引用有效决定与执行变化被接受
      const card = (await t.app.inject({ method: "GET", url: `/api/cards/meetings/${third}`, headers: { cookie } })).json().cards[0];
      expect(card.payload.preflight.status).toBe("ready");
      expect(card.payload.preflight.inputCoverage).toMatchObject({
        decisionHistory: "available",
        evidence: { decisionRefs: [`decision:${newId}`, `decision:${firstReceipt.id}`], inactiveDecisionRefs: [`decision:${oldId}`, `decision:${revokedReceipt.id}`] },
      });
      expect(card.payload.preflight.entries[0].sourceRefs).toEqual([`decision:${newId}`, "feedback:fb-1"]);

      // 读接口：议题页与会议页拿到同一份分层，契约合法
      const issueHistory = await t.app.inject({ method: "GET", url: `/api/issues/${issueId}/history`, headers: { cookie } });
      expect(issueHistory.statusCode).toBe(200);
      expect(Value.Check(IssueDecisionHistory, issueHistory.json())).toBe(true);
      expect(issueHistory.json().effective.map((entry: { ref: string }) => entry.ref)).toEqual(history.effective.map((entry) => entry.ref));
      const meetingHistory = await t.app.inject({ method: "GET", url: `/api/meetings/${third}/history`, headers: { cookie } });
      expect(meetingHistory.statusCode).toBe(200);
      expect(Value.Check(MeetingDecisionHistoryResponse, meetingHistory.json())).toBe(true);
      expect(meetingHistory.json().issues[0].issueId).toBe(issueId);
      expect((await t.app.inject({ method: "GET", url: `/api/issues/${randomUUID()}/history`, headers: { cookie } })).statusCode).toBe(404);
      expect((await t.app.inject({ method: "GET", url: `/api/issues/${issueId}/history` })).statusCode).toBe(401);
    } finally {
      await t.close();
    }
  });

  it("没有有效决定时只列本次待判断；有决定但之后没有执行证据时明确写待补", async () => {
    const t = await createTestApp({}, undefined, { preflightAgent: recordingPreflight() });
    try {
      const cookie = await t.loginCookie();
      const pendingOnly = await createIssue(t, "history-empty", { level: "company", relatedBattlefieldIds: [] });
      const empty = (await t.app.inject({ method: "GET", url: `/api/issues/${pendingOnly}/history`, headers: { cookie } })).json();
      expect(empty).toMatchObject({ issueStatus: "pending", effective: [], inactive: [], changes: [], changesSince: null, changesNote: NO_EFFECTIVE_DECISION });
      expect(empty.pending).toEqual([expect.objectContaining({ kind: "issue_pending", ref: `issue:${pendingOnly}` })]);

      const decided = await createIssue(t, "history-no-evidence", { level: "company", relatedBattlefieldIds: [] });
      await t.sql(
        `INSERT INTO issue_decision_history (id, issue_id, external_id, decided_at, decided_by, decision_text, source_ref, status)
         VALUES ($1, $2, 'd-1', '2026-04-10T02:00:00Z', $3, '定制验收必须经交付负责人评估', '交付周会纪要', 'effective')`,
        [randomUUID(), decided, CEO_ID],
      );
      const noEvidence = (await t.app.inject({ method: "GET", url: `/api/issues/${decided}/history`, headers: { cookie } })).json();
      expect(noEvidence.effective).toHaveLength(1);
      expect(noEvidence.changes).toEqual([]);
      expect(noEvidence.changesNote).toBe(NO_EXECUTION_EVIDENCE);
      // 导入的历史决定不改变议题当前状态，本次仍待判断
      expect(noEvidence.issueStatus).toBe("pending");
      expect(noEvidence.pending.map((item: { kind: string }) => item.kind)).toEqual(["issue_pending"]);
    } finally {
      await t.close();
    }
  });
});
