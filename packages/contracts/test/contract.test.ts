import { describe, expect, it } from "vitest";
import { buildOpenApiDocument } from "../src/openapi.js";
import {
  ApiError,
  ActionDescriptor,
  Card,
  ConversationMessageRequest,
  ConversationScope,
  ConversationSseEvent,
  CreateMeetingRequest,
  DriIssueImportRequest,
  DriMonthlyPlanFeedbackRequest,
  DriMonthlyPlanTodoFeedbackRequest,
  MeetingCardPayload,
  MonthlyDraftCandidate,
  MonthlyPlanCardPayload,
  PreflightCandidate,
  RadarCandidateSubmission,
  RadarScanResponse,
  RequestSupplementRequest,
  SignalStateRequest,
  UpdateMeetingDraftRequest,
  UpdateMonthlyPlanDraftRequest,
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
        "/api/dri/monthly-feedback",
        "/api/dri/todo-feedback",
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
});

describe("meeting public contract", () => {
  const candidate = {
    entries: [{ kind: "agenda", title: "议程", body: "先对齐选择", sourceRefs: ["issue:00000000-0000-4000-8000-000000000001"] }],
    basis: "依据关联 Issue",
    brief: "CEO 会前需确认节奏",
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
    };
    expect(Value.Check(MeetingCardPayload, payload)).toBe(true);
    expect(Value.Check(MeetingCardPayload, { ...payload, status: "postponed" })).toBe(false);
    expect(Value.Check(MeetingCardPayload, {
      ...payload,
      draft: { ...payload.draft, supplementRequests: [{ ...payload.draft, exportStatus: "sent" }] },
    })).toBe(false);
  });
});

describe("monthly plan public contract", () => {
  const candidate = {
    companyOutcome: "完成渠道结构切换",
    battlefields: [{ battlefieldId: "growth", outcome: "增长战场完成渠道切换" }],
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
      todos: [{ id: "todo-1", title: "待办", ownerId: "person-002", sourceRef: "issue:1" }],
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
