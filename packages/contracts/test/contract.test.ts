import { describe, expect, it } from "vitest";
import { buildOpenApiDocument } from "../src/openapi.js";
import {
  ApiError,
  ActionDescriptor,
  BattlefieldCardPayload,
  BattlefieldManagementResponse,
  CapabilityManagementResponse,
  CapabilitySupportRef,
  Card,
  ConversationMessageRequest,
  ConversationScope,
  ConversationSseEvent,
  CreateBattlefieldRequest,
  CreateCapabilityRequest,
  CreateMeetingRequest,
  DriIssueImportRequest,
  DriMonthlyPlanFeedbackRequest,
  DriMonthlyPlanTodoFeedbackRequest,
  MeetingCardPayload,
  MeetingConfirmItemInput,
  MeetingDismissItemInput,
  MeetingRevokeEffectInput,
  MissionValue,
  MonthlyDraftCandidate,
  MonthlyPlanCardPayload,
  MonthlyPlanExport,
  MeetingOutcomeState,
  OutcomeReview,
  PatchBattlefieldRequest,
  PatchCapabilityRequest,
  PatchStrategyConfigRequest,
  PostMeetingCandidate,
  PreflightCandidate,
  ReplaceTranscriptRequest,
  IssueReceipt,
  RadarCandidateSubmission,
  RadarAnchor,
  RadarScanResponse,
  ResearchDoc,
  RequestSupplementRequest,
  SignalStateRequest,
  StrategyConfigResponse,
  UpdateMeetingDraftRequest,
  UpdateMonthlyPlanDraftRequest,
  WarmapTranscript,
  WebSearchInput,
  WebSearchResponse,
} from "../src/index.js";
import { Value } from "@sinclair/typebox/value";

describe("openapi contract", () => {
  const doc = buildOpenApiDocument();

  it("exposes the public API surface", () => {
    const paths = Object.keys(doc.paths);
    expect(paths).toEqual(
      expect.arrayContaining([
        "/api/auth/login",
        "/api/auth/logout",
        "/api/auth/session",
        "/api/cards/home",
        "/api/cards/issues/{id}",
        "/api/cards/radar",
        "/api/cards/signals",
        "/api/cards/signals/{id}",
        "/api/radar/scans/manual",
        "/api/dri/issues",
        "/api/cards/monthly-plans",
        "/api/cards/monthly-plans/{id}",
        "/api/cards/battlefields",
        "/api/dri/monthly-feedback",
        "/api/dri/todo-feedback",
        "/api/dri/monthly-exports",
        "/api/dri/monthly-exports/{effectRef}/delivered",
        "/api/dri/monthly-exports/{effectRef}/failed",
        "/api/dri/monthly-exports/{effectRef}/re-export",
        "/api/signals/{id}/state",
        "/api/actions/execute",
        "/api/conversations/{scope}/messages",
        "/healthz",
      ]),
    );
  });

  it("publishes card, action and error schemas as components", () => {
    expect(Object.keys(doc.components.schemas)).toEqual(
      expect.arrayContaining([
        "Card",
        "ActionDescriptor",
        "ApiError",
        "DriIssueImportRequest",
        "MonthlyPlanCardPayload",
        "MonthlyPlanExport",
        "MonthlyPlanExportListResponse",
        "SignMonthlyPlanRequest",
        "BattlefieldCardPayload",
        "MonthlyDraftCandidate",
        "UpdateMonthlyPlanDraftRequest",
        "DriMonthlyPlanFeedbackRequest",
      ]),
    );
  });
  it("version conflict responses document ApiError", () => {
    const execute = doc.paths["/api/actions/execute"].post;
    expect(execute.responses["409"]).toBeDefined();
    expect(execute.responses["409"].content["application/json"].schema).toMatchObject({
      $ref: "#/components/schemas/ApiError",
    });
  });
});

describe("card envelope schema", () => {
  it("rejects a card without kind, version or actions", () => {
    const bad = { schemaVersion: 1, id: "home", title: "x" };
    expect(Value.Check(Card, bad)).toBe(false);
  });

  it("accepts a well-formed card with one action descriptor", () => {
    const card = {
      schemaVersion: 1,
      id: "home:default",
      version: 3,
      kind: "home",
      objectRef: { type: "home", id: "default", version: 3 },
      title: "首页",
      payload: {},
      actions: [
        { actionId: "tok", actionType: "home.dismiss_notice", label: "知道了" },
      ],
    };
    expect(Value.Check(Card, card)).toBe(true);
    expect(Value.Check(ActionDescriptor, card.actions[0])).toBe(true);
  });
});

describe("conversation public contract", () => {
  it("accepts stable global/object scopes and trusted-reference input only", () => {
    expect(Value.Check(ConversationScope, "global")).toBe(true);
    for (const type of ["issue", "signal", "meeting", "monthly-plan"]) {
      expect(Value.Check(ConversationScope, `${type}:fixture-001`)).toBe(true);
    }
    expect(Value.Check(ConversationScope, "home:default")).toBe(false);
    expect(Value.Check(ConversationMessageRequest, {
      message: "比较这些依据",
      references: [{ cardId: "home:default", version: 1 }],
    })).toBe(true);
    expect(Value.Check(ConversationMessageRequest, {
      message: "伪造",
      references: [{ cardId: "home:default", version: 1, payload: { trusted: false } }],
    })).toBe(false);
  });

  it("defines message, tool lifecycle, usage, error and done SSE events", () => {
    const common = { runId: "run-1", scope: "global", sequence: 1 };
    for (const event of [
      { ...common, type: "message", delta: "回答" },
      { ...common, type: "tool", phase: "started", toolCallId: "tool-1", name: "search_people" },
      { ...common, type: "tool", phase: "completed", toolCallId: "tool-1", name: "search_people", isError: false },
      { ...common, type: "usage", input: 3, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 5 },
      { ...common, type: "compaction", phase: "started" },
      { ...common, type: "compaction", phase: "completed" },
      { ...common, type: "warning", code: "RUNTIME_RECREATED", message: "执行态已重建" },
      { ...common, type: "error", code: "RUNTIME_FAILED", message: "模型失败" },
      { ...common, type: "done", status: "completed" },
    ]) expect(Value.Check(ConversationSseEvent, event)).toBe(true);
  });

  it("defines the strict replaceable Web Search Tool contract", () => {
    expect(Value.Check(WebSearchInput, { query: "latest", freshness: "week", domains: ["example.com"] })).toBe(true);
    expect(Value.Check(WebSearchInput, { query: "latest", freshness: "forever" })).toBe(false);
    expect(Value.Check(WebSearchResponse, {
      results: [{ title: "公告", url: "https://example.com", excerpt: "内容", provider: "fake" }],
      warnings: [],
    })).toBe(true);
  });
});

describe("issue import and promotion public contract", () => {
  it("accepts stable DRI JSON import and a structured Radar promotion candidate", () => {
    expect(Value.Check(DriIssueImportRequest, {
      externalId: "dri-issue-001",
      submitterPersonId: "person-fixture-002",
      title: "是否调整增长投入",
      whyNow: "季度预算将在本周锁定",
      sourceRef: "dri://planning/001",
      location: { level: "battlefield", battlefieldId: "growth" },
      urgency: { level: "red", decisionBy: "2026-05-04T10:00:00.000+08:00", reason: "预算锁定后不可调整" },
    })).toBe(true);

    expect(Value.Check(RadarCandidateSubmission, {
      candidates: [{
        sourceFingerprint: "a".repeat(64),
        anchorId: "anchor-market",
        summary: "竞争对手发布新价格",
        strategicImpact: "可能改变本季度定价选择",
        evidenceQuote: "价格将在六月一日调整",
        unknowns: [],
        score: { relevance: 5, impact: 4, urgency: 3 },
        promotion: {
          decisionKind: "resource_allocation",
          decisionQuestion: "是否在六月前调整渠道投入？",
          options: ["调整投入", "维持现状"],
          location: { level: "battlefield", battlefieldId: "growth" },
          urgency: {
            level: "red",
            reason: "渠道窗口即将关闭",
            decisionBy: "2026-06-01T00:00:00.000+08:00",
            decisionByEvidence: { quote: "六月一日前完成渠道申报" },
          },
        },
      }],
    })).toBe(true);
  });
});

describe("radar public contract", () => {
  it("accepts only bounded strict Radar candidate submissions", () => {
    const candidate = {
      candidates: [{
        sourceFingerprint: "a".repeat(64),
        anchorId: "anchor-market",
        summary: "竞争对手发布新价格",
        strategicImpact: "可能改变本季度定价选择",
        evidenceQuote: "价格将在六月一日调整",
        unknowns: ["覆盖哪些地区"],
        score: { relevance: 4, impact: 5, urgency: 3 },
        promotion: {
          decisionKind: "resource_allocation",
          decisionQuestion: "是否在六月前调整渠道投入？",
          options: ["调整投入", "维持现状"],
          location: { level: "battlefield", battlefieldId: "growth" },
          urgency: { level: "gray" },
        },
      }],
    };
    expect(Value.Check(RadarCandidateSubmission, candidate)).toBe(true);
    expect(Value.Check(RadarCandidateSubmission, {
      ...candidate,
      candidates: [{ ...candidate.candidates[0], extra: "模型越界字段" }],
    })).toBe(false);
    expect(Value.Check(RadarCandidateSubmission, {
      candidates: [{ ...candidate.candidates[0], score: { relevance: 9, impact: 5, urgency: 3 } }],
    })).toBe(false);
  });

  it("keeps Signal state flags independently optional and exposes scan outcomes", () => {
    expect(Value.Check(SignalStateRequest, { read: true })).toBe(true);
    expect(Value.Check(SignalStateRequest, { saved: true, dismissed: false })).toBe(true);
    expect(Value.Check(SignalStateRequest, {})).toBe(false);
    expect(Value.Check(RadarScanResponse, {
      trigger: "manual",
      status: "completed",
      companyDay: "2026-05-02",
      createdSignals: 1,
      warnings: [],
    })).toBe(true);
  });

  it("marks meeting-reopen anchors with an explicit source and originRef", () => {
    const anchor = { id: "meeting-reopen:m:item-1", title: "六月前风险清单", query: "六月风险", location: { type: "company" }, source: "meeting-reopen", originRef: "meeting:m:reopen:item-1" };
    expect(Value.Check(RadarAnchor, anchor)).toBe(true);
    expect(Value.Check(RadarAnchor, { id: "a", title: "t", query: "q", location: { type: "company" } })).toBe(true);
    expect(Value.Check(RadarAnchor, { ...anchor, extra: true })).toBe(false);
  });
});

describe("meeting public contract", () => {
  const sourceRefs = ["issue:00000000-0000-4000-8000-000000000001"];
  const entry = (kind: string, title: string) => ({ kind, title, body: title, sourceRefs });
  const candidate = {
    taskDefinition: {
      materialPurpose: "说明渠道投入选择",
      reviewPurpose: "支持 CEO 会前判断",
      primaryRole: "research_analysis",
      secondaryRole: null,
      maturity: "internal_alignment",
      readerAction: "判断是否进入决策讨论",
      nonGoal: "不替 CEO 批准投入",
    },
    readiness: "revise",
    entries: [
      entry("core_judgment", "核心判断"),
      entry("strategic_alignment", "战略一致性"),
      entry("positive_signal", "积极信号"),
      entry("risk_calibration", "风险校准"),
      entry("meeting_question", "追问一"),
      entry("meeting_question", "追问二"),
      entry("meeting_question", "追问三"),
      entry("next_step", "下一步"),
      entry("leader_lens", "视角预判，非权威发言"),
    ],
    basis: "依据关联 Issue",
    brief: "CEO 会前需确认节奏",
    summary: { criticalIssue: "证据不足", priorityAction: "补充选择后果" },
  };

  it("accepts a strict Preflight candidate and rejects model overreach", () => {
    expect(Value.Check(PreflightCandidate, candidate)).toBe(true);
    expect(Value.Check(PreflightCandidate, { ...candidate, entries: [] })).toBe(false);
    expect(Value.Check(PreflightCandidate, {
      ...candidate,
      entries: [{ ...candidate.entries[0], sourceRefs: [] }],
    })).toBe(false);
    expect(Value.Check(PreflightCandidate, {
      ...candidate,
      entries: [{ ...candidate.entries[0], kind: "decision" }],
    })).toBe(false);
    expect(Value.Check(PreflightCandidate, { ...candidate, extra: true })).toBe(false);
  });

  it("accepts Meeting creation and draft/supplement commands only with complete inputs", () => {
    const create = {
      title: "渠道投入决策会",
      scheduledAt: "2026-06-01T10:00:00.000+08:00",
      leadDriId: "person-002",
      ceoParticipantId: "person-001",
      participants: ["person-002"],
      issueIds: ["00000000-0000-4000-8000-000000000001"],
    };
    expect(Value.Check(CreateMeetingRequest, create)).toBe(true);
    expect(Value.Check(CreateMeetingRequest, { ...create, participants: [] })).toBe(false);
    expect(Value.Check(CreateMeetingRequest, { ...create, issueIds: [] })).toBe(false);
    expect(Value.Check(UpdateMeetingDraftRequest, { checkedEntryIds: ["entry-1"], editsByEntryId: { "entry-1": "改" } })).toBe(true);
    expect(Value.Check(UpdateMeetingDraftRequest, { note: 3 })).toBe(false);
    expect(Value.Check(RequestSupplementRequest, { targetDriId: "person-002", text: "请补充证据" })).toBe(true);
    expect(Value.Check(RequestSupplementRequest, { targetDriId: "person-002", text: "" })).toBe(false);
  });

  it("types the Meeting card payload with snapshot participants and honest supplement status", () => {
    const payload = {
      status: "scheduled",
      scheduledAt: "2026-06-01T02:00:00.000Z",
      leadDriId: "person-002",
      ceoParticipantId: "person-001",
      participants: [{ personId: "person-001", displayName: "CEO", roles: ["ceo"], sourceRef: "seed#person-001", updatedAt: "2026-05-01T00:00:00.000Z" }],
      issueIds: ["00000000-0000-4000-8000-000000000001"],
      originRef: { type: "issue", issueId: "00000000-0000-4000-8000-000000000001" },
      preflight: { status: "ready", pendingSince: null, runId: "run-1", entries: [], basis: "b", brief: "c", error: null, generatedAt: "2026-05-01T00:00:00.000Z" },
      draft: { readIssueIds: [], carriedIssueIds: [], checkedEntryIds: [], editsByEntryId: {}, supplementRequests: [], note: "" },
      materials: [],
      transcript: null,
      outcome: null,
    };
    expect(Value.Check(MeetingCardPayload, payload)).toBe(true);
    expect(Value.Check(MeetingCardPayload, { ...payload, status: "postponed" })).toBe(false);
    expect(Value.Check(MeetingCardPayload, {
      ...payload,
      draft: { ...payload.draft, supplementRequests: [{ ...payload.draft, exportStatus: "sent" }] },
    })).toBe(false);
  });

  it("accepts only the versioned warmap-transcript.v1 shape", () => {
    const file = {
      schemaVersion: "warmap-transcript.v1",
      meetingId: "00000000-0000-4000-8000-000000000001",
      turns: [
        { id: "turn-001", speakerId: "person-001", startedAt: "2026-06-01T10:00:05+08:00", text: "决定" },
        { id: "turn-002", speakerId: "person-002", text: "我来跟进" },
      ],
    };
    expect(Value.Check(WarmapTranscript, file)).toBe(true);
    expect(Value.Check(WarmapTranscript, { ...file, schemaVersion: "warmap-transcript.v2" })).toBe(false);
    expect(Value.Check(WarmapTranscript, { ...file, turns: [] })).toBe(false);
    expect(Value.Check(WarmapTranscript, { ...file, turns: [{ ...file.turns[0], extra: true }] })).toBe(false);
    expect(Value.Check(WarmapTranscript, { ...file, extra: true })).toBe(false);
    // 危险替换必须携带服务端可验证的二次确认
    expect(Value.Check(ReplaceTranscriptRequest, { transcript: file, confirmReplace: true })).toBe(true);
    expect(Value.Check(ReplaceTranscriptRequest, { transcript: file })).toBe(false);
  });

  it("types the extracted MeetingOutcome items with turn-bound quotes and per-item review", () => {
    const state = {
      status: "ready",
      pendingSince: null,
      startedAt: null,
      runId: "run-1",
      previousRunIds: [],
      error: null,
      summary: "会议形成一项待办",
      extractedAt: "2026-06-01T02:05:00.000Z",
      warnings: [],
      items: [
        {
          id: "item-1",
          kind: "todo",
          text: "提交排期",
          turnId: "turn-002",
          quote: "我来跟进",
          speakerId: "person-002",
          ownerPersonId: "person-002",
          issueId: null,
          judgmentKind: null,
          parentItemId: null,
          review: { status: "pending", effectRef: null },
        },
        {
          id: "item-2",
          kind: "open",
          text: "覆盖哪些地区",
          turnId: "turn-001",
          quote: "决定",
          speakerId: "person-001",
          ownerPersonId: null,
          issueId: null,
          judgmentKind: null,
          parentItemId: null,
          review: null,
        },
      ],
    };
    expect(Value.Check(MeetingOutcomeState, state)).toBe(true);
    expect(Value.Check(MeetingOutcomeState, { ...state, status: "reviewing" })).toBe(false);
    expect(Value.Check(MeetingOutcomeState, { ...state, items: [{ ...state.items[0], review: { status: "sent" } }] })).toBe(false);
    expect(Value.Check(MeetingOutcomeState, { ...state, items: [{ ...state.items[0], extra: true }] })).toBe(false);
  });

  it("keeps PostMeeting candidates strict so free text cannot smuggle unknown kinds", () => {
    const candidate = {
      summary: "s",
      items: [{ kind: "decision", text: "t", turnId: "turn-001", quote: "q", judgmentKind: "mission_boundary" }],
    };
    expect(Value.Check(PostMeetingCandidate, candidate)).toBe(true);
    expect(Value.Check(PostMeetingCandidate, { ...candidate, items: [{ ...candidate.items[0], kind: "promise" }] })).toBe(false);
    expect(Value.Check(PostMeetingCandidate, { ...candidate, items: [{ ...candidate.items[0], judgmentKind: "budget" }] })).toBe(false);
  });

  it("carries per-item effect details and accepts only versioned review commands", () => {
    const confirmed = {
      status: "confirmed",
      effectRef: "meeting:00000000-0000-4000-8000-000000000001:todo:item-1",
      handoff: { exportStatus: "pending_export", exportRef: null, error: null },
      anchorId: null,
      reason: null,
    };
    expect(Value.Check(OutcomeReview, confirmed)).toBe(true);
    expect(Value.Check(OutcomeReview, { ...confirmed, status: "pending", handoff: { exportStatus: "sent", exportRef: null, error: null } })).toBe(false);
    expect(Value.Check(MeetingConfirmItemInput, {})).toBe(true);
    expect(Value.Check(MeetingConfirmItemInput, { itemId: "item-1" })).toBe(false);
    expect(Value.Check(MeetingDismissItemInput, { reason: "不是本次决定" })).toBe(true);
    expect(Value.Check(MeetingDismissItemInput, { reason: 3 })).toBe(false);
    expect(Value.Check(MeetingRevokeEffectInput, {})).toBe(true);
    expect(Value.Check(MeetingRevokeEffectInput, { effectRef: "x" })).toBe(false);
  });

  it("records a meeting-item source on an Issue Receipt", () => {
    const receipt = {
      id: "receipt-1",
      actionType: "meeting.confirm_item",
      effectRef: "meeting:00000000-0000-4000-8000-000000000001:decision:item-1",
      decisionText: "灯塔项目优先",
      researchStatusAtDecision: "pending",
      override: false,
      source: { kind: "meeting-item", meetingId: "00000000-0000-4000-8000-000000000001", outcomeItemId: "item-1" },
      createdAt: "2026-06-01T02:05:00.000Z",
    };
    expect(Value.Check(IssueReceipt, receipt)).toBe(true);
    expect(Value.Check(IssueReceipt, { ...receipt, source: { kind: "radar" } })).toBe(false);
  });
});

describe("monthly plan public contract", () => {
  const candidate = {
    companyOutcome: "完成渠道结构切换",
    battlefields: [{ battlefieldId: "growth", outcome: "增长战场完成渠道切换" }],
    capabilities: [{ capabilityId: "re-architecture", outcome: "能力完成真实客户进入" }],
    todos: [{ title: "完成渠道合同复核", ownerId: "person-002", sourceRef: "issue:decision-1" }],
  };

  it("accepts only a strict Candidate Material without execution state", () => {
    expect(Value.Check(MonthlyDraftCandidate, candidate)).toBe(true);
    expect(Value.Check(MonthlyDraftCandidate, { ...candidate, extra: true })).toBe(false);
    expect(Value.Check(MonthlyDraftCandidate, { ...candidate, companyOutcome: "" })).toBe(false);
    expect(Value.Check(MonthlyDraftCandidate, {
      ...candidate,
      todos: [{ ...candidate.todos[0], status: "done" }],
    })).toBe(false);
  });

  it("accepts partial CEO edits, including company-level todos without a battlefield", () => {
    expect(Value.Check(UpdateMonthlyPlanDraftRequest, { companyOutcome: "CEO 结果" })).toBe(true);
    expect(Value.Check(UpdateMonthlyPlanDraftRequest, { capabilities: [{ capabilityId: "re-architecture", outcome: "能力结果" }] })).toBe(true);
    expect(Value.Check(UpdateMonthlyPlanDraftRequest, { capabilities: [{ capabilityId: "re-architecture" }] })).toBe(false);
    expect(Value.Check(UpdateMonthlyPlanDraftRequest, {
      todos: [{ title: "公司级待办", ownerId: "person-002", sourceRef: "monthly-plan:2026-05" }],
      checkedItemIds: ["company"],
    })).toBe(true);
    expect(Value.Check(UpdateMonthlyPlanDraftRequest, {})).toBe(false);
    expect(Value.Check(UpdateMonthlyPlanDraftRequest, { todos: [{ title: "无来源", ownerId: "person-002" }] })).toBe(false);
  });

  it("types the card payload and keeps narrative feedback free of todo execution state", () => {
    const payload = {
      period: "2026-06",
      status: "negotiating",
      companyOutcome: "公司结果",
      battlefields: [{ battlefieldId: "growth", outcome: "战场结果" }],
      capabilities: [{ capabilityId: "re-architecture", outcome: "能力结果" }],
      todos: [{ id: "todo-1", title: "待办", ownerId: "person-002", sourceRef: "issue:1" }],
      exports: [
        {
          effectRef: "monthly-plan:2026-06:todo:todo-1",
          todoId: "todo-1",
          title: "待办",
          ownerId: "person-002",
          dueAt: null,
          sourceRef: "issue:1",
          status: "pending_export",
          exportRef: null,
          error: null,
          createdAt: "2026-06-02T00:00:00.000Z",
          updatedAt: "2026-06-02T00:00:00.000Z",
        },
      ],
      negotiation: {
        edits: [{ at: "2026-06-02T00:00:00.000Z", fields: ["companyOutcome"] }],
        checkedItemIds: ["company"],
        feedback: [{
          id: "feedback-1",
          externalId: "dri-1",
          text: "渠道复核已完成",
          evidenceRef: "dri://evidence/1",
          observedAt: "2026-06-10T00:00:00.000Z",
          sourceRef: "dri://retro/1",
        }],
        note: "",
      },
      generation: {
        status: "ready",
        pendingSince: "2026-06-01T00:00:00.000Z",
        runId: "run-1",
        previousRunIds: [],
        error: null,
        generatedAt: "2026-06-01T00:01:00.000Z",
      },
      confirmedAt: null,
    };
    expect(Value.Check(MonthlyPlanCardPayload, payload)).toBe(true);
    expect(Value.Check(MonthlyPlanCardPayload, { ...payload, status: "signed" })).toBe(false);
    expect(Value.Check(MonthlyPlanCardPayload, {
      ...payload,
      todos: [{ ...payload.todos[0], status: "done" }],
    })).toBe(false);
  });

  it("accepts DRI narrative feedback requests with observedAt and todo scope", () => {
    const base = {
      externalId: "dri-1",
      period: "2026-06",
      submitterPersonId: "person-002",
      sourceRef: "dri://retro/1",
      text: "渠道复核已完成",
      observedAt: "2026-06-10T00:00:00.000Z",
    };
    expect(Value.Check(DriMonthlyPlanFeedbackRequest, base)).toBe(true);
    expect(Value.Check(DriMonthlyPlanFeedbackRequest, { ...base, period: "2026-13" })).toBe(false);
    expect(Value.Check(DriMonthlyPlanFeedbackRequest, { ...base, observedAt: undefined })).toBe(false);
    expect(Value.Check(DriMonthlyPlanFeedbackRequest, { ...base, status: "done" })).toBe(false);
    expect(Value.Check(DriMonthlyPlanTodoFeedbackRequest, { ...base, todoId: "todo-1" })).toBe(true);
    expect(Value.Check(DriMonthlyPlanTodoFeedbackRequest, base)).toBe(false);
  });

  it("keeps DRI export status honest and battlefield projection free of execution state", () => {
    const exported = {
      effectRef: "monthly-plan:2026-06:todo:todo-1",
      todoId: "todo-1",
      title: "待办",
      ownerId: "person-002",
      dueAt: null,
      sourceRef: "issue:1",
      status: "pending_export",
      exportRef: null,
      error: null,
      createdAt: "2026-06-02T00:00:00.000Z",
      updatedAt: "2026-06-02T00:00:00.000Z",
    };
    expect(Value.Check(MonthlyPlanExport, exported)).toBe(true);
    expect(Value.Check(MonthlyPlanExport, { ...exported, status: "delivered" })).toBe(true);
    expect(Value.Check(MonthlyPlanExport, { ...exported, status: "done" })).toBe(false);
    expect(Value.Check(MonthlyPlanExport, { ...exported, percent: 50 })).toBe(false);

    const battlefield = {
      battlefieldId: "growth",
      code: "01",
      sortOrder: 10,
      name: "增长战场",
      ownerId: "person-002",
      ownerDisplayName: "陈珂",
      sixMonthOutcome: "验证渠道结构",
      missions: [{ code: "01-1", title: "未来组织范式设计与确认" }],
      period: "2026-06",
      target: "增长战场完成渠道切换",
      pendingIssues: [
        { id: "issue-1", title: "渠道投入是否调整", urgency: "red", location: { level: "battlefield", battlefieldId: "growth" } },
      ],
      todos: [
        { id: "todo-1", title: "待办", ownerId: "person-002", dueAt: null, sourceRef: "issue:1", exportStatus: "pending_export", exportRef: null },
      ],
      latestFeedback: { text: "渠道复核已完成", observedAt: "2026-06-10T00:00:00.000Z", sourceRef: "dri://retro/1", evidenceRef: null },
    };
    expect(Value.Check(BattlefieldCardPayload, battlefield)).toBe(true);
    // 负责人只存 personId，投影现查 displayName
    expect(Value.Check(BattlefieldCardPayload, { ...battlefield, ownerId: "", ownerDisplayName: "待指派" })).toBe(true);
    expect(Value.Check(BattlefieldCardPayload, { ...battlefield, positioning: "旧字段" })).toBe(false);
    // 不展示 Agent 推测的完成百分比与执行状态
    expect(Value.Check(BattlefieldCardPayload, { ...battlefield, progress: 0.5 })).toBe(false);
    expect(Value.Check(BattlefieldCardPayload, {
      ...battlefield,
      todos: [{ ...battlefield.todos[0], status: "done" }],
    })).toBe(false);
  });
});

describe("strategy map config contracts", () => {
  it("keeps Mission a plain value object with no execution fields", () => {
    expect(Value.Check(MissionValue, { code: "01-1", title: "未来组织范式设计与确认" })).toBe(true);
    expect(Value.Check(MissionValue, { code: "01-1", title: "x", status: "done" })).toBe(false);
    expect(Value.Check(MissionValue, { title: "缺少编号" })).toBe(false);
  });

  it("models capability support refs as a three-way union", () => {
    expect(Value.Check(CapabilitySupportRef, { type: "mission", missionCode: "02-1" })).toBe(true);
    expect(Value.Check(CapabilitySupportRef, { type: "battlefield", battlefieldId: "growth" })).toBe(true);
    expect(Value.Check(CapabilitySupportRef, { type: "all-battlefields" })).toBe(true);
    expect(Value.Check(CapabilitySupportRef, { type: "mission" })).toBe(false);
    expect(Value.Check(CapabilitySupportRef, { type: "all-battlefields", battlefieldId: "growth" })).toBe(false);
  });

  it("requires code and integer sortOrder on battlefield/capability writes", () => {
    const battlefield = { code: "01", sortOrder: 10, name: "灯塔项目", sixMonthOutcome: "六个月目标" };
    expect(Value.Check(CreateBattlefieldRequest, battlefield)).toBe(true);
    expect(Value.Check(CreateBattlefieldRequest, { ...battlefield, code: undefined })).toBe(false);
    expect(Value.Check(CreateBattlefieldRequest, { ...battlefield, sortOrder: 10.5 })).toBe(false);
    expect(Value.Check(CreateBattlefieldRequest, { ...battlefield, ownerId: "" })).toBe(true);
    expect(Value.Check(CreateBattlefieldRequest, {
      ...battlefield,
      missions: [{ code: "01-1", title: "未来组织范式设计与确认" }],
    })).toBe(true);

    const capability = { code: "02", sortOrder: 20, name: "Re-architecture", sixMonthOutcome: "六个月目标" };
    expect(Value.Check(CreateCapabilityRequest, capability)).toBe(true);
    expect(Value.Check(CreateCapabilityRequest, { ...capability, group: "" })).toBe(true);
    expect(Value.Check(CreateCapabilityRequest, {
      ...capability,
      supportRefs: [{ type: "mission", missionCode: "01-1" }, { type: "all-battlefields" }],
    })).toBe(true);

    // PATCH 至少一项，且 ownerId/group 允许清空
    expect(Value.Check(PatchBattlefieldRequest, {})).toBe(false);
    expect(Value.Check(PatchBattlefieldRequest, { ownerId: "" })).toBe(true);
    expect(Value.Check(PatchCapabilityRequest, { group: "" })).toBe(true);
    expect(Value.Check(PatchCapabilityRequest, { sixMonthOutcome: "新目标" })).toBe(true);
  });

  it("exposes the LTCO strategy config and structured management projections", () => {
    expect(Value.Check(StrategyConfigResponse, { version: 1, ltco: "春节前…" })).toBe(true);
    expect(Value.Check(PatchStrategyConfigRequest, { ltco: "" })).toBe(true);
    expect(Value.Check(PatchStrategyConfigRequest, { version: 2, ltco: "x" })).toBe(false);

    expect(Value.Check(CapabilityManagementResponse, {
      capabilities: [{
        id: "re-architecture", version: 1, code: "02", sortOrder: 20, name: "Re-architecture",
        group: "", sixMonthOutcome: "目标", supportRefs: [{ type: "all-battlefields" }],
      }],
    })).toBe(true);

    expect(Value.Check(BattlefieldManagementResponse, {
      battlefields: [{
        id: "growth", version: 1, code: "01", sortOrder: 10, name: "灯塔项目",
        ownerId: "", ownerDisplayName: "待指派", sixMonthOutcome: "目标", missions: [], pendingIssueCount: 0,
      }],
      issues: [],
    })).toBe(true);
  });
});

describe("error envelope schema", () => {
  it("carries code, retryable and optional latestCard for version conflicts", () => {
    const err = {
      code: "VERSION_CONFLICT",
      message: "对象已被修改",
      retryable: false,
      requestId: "req_1",
      latestCard: {
        schemaVersion: 1,
        id: "home:default",
        version: 4,
        kind: "home",
        objectRef: { type: "home", id: "default", version: 4 },
        title: "首页",
        payload: {},
        actions: [],
      },
    };
    expect(Value.Check(ApiError, err)).toBe(true);
    expect(Value.Check(ApiError, { code: "X" })).toBe(false);
  });
});

describe("research doc source contract", () => {
  const doc = (url: string) => ({
    summary: "渠道政策需要重新判断",
    options: [
      { id: "adjust", label: "调整渠道", consequences: ["短期投入上升"] },
      { id: "hold", label: "保持观察", consequences: ["可能错过窗口"] },
    ],
    evidence: [{ quote: "原文引文", sourceTitle: "内部材料" }],
    unknowns: [],
    sources: [{ title: "来源标题", url }],
  });

  it("只接受真实 http(s) 来源，拒绝模型自编的 file:// 与 urn: 地址", () => {
    expect(Value.Check(ResearchDoc, doc("https://www.cnbc.com/2026/09/17/example.html"))).toBe(true);
    expect(Value.Check(ResearchDoc, doc("file:///repo/apps/api/CompanyMemory.md"))).toBe(false);
    expect(Value.Check(ResearchDoc, doc("urn:issue:3d119c0a"))).toBe(false);
  });

  it("evidence.sourceUrl 给的是同一约束", () => {
    const withSourceUrl = (url: string) => ({
      ...doc("https://example.com/a"),
      evidence: [{ quote: "原文引文", sourceTitle: "内部材料", sourceUrl: url }],
    });
    expect(Value.Check(ResearchDoc, withSourceUrl("https://example.com/b"))).toBe(true);
    expect(Value.Check(ResearchDoc, withSourceUrl("file:///repo/apps/api/CompanyMemory.md"))).toBe(false);
  });
});
