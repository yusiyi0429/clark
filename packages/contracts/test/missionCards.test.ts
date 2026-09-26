import { describe, expect, it } from "vitest";
import { Value } from "@sinclair/typebox/value";
import {
  ExecuteMissionRoundActionRequest, MissionCardField, MissionRoundDraftPayload, MissionRoundSummary,
  CreateMissionRequest, MissionEditInput, MissionCardPayload,
  ConversationScope, CreateMissionCardFeedbackRequest, MissionCardGroupView, MarkMissionCardReadRequest,
  MissionRoundDecideInput, MissionRoundConfirmInput, MissionCardFeedbackView,
} from "../src/index.js";
import { buildOpenApiDocument } from "../src/openapi.js";

const now = "2026-10-01T00:00:00.000Z";
const summary = {
  roundId: "round-1", period: "2026-10", battlefieldId: "growth", battlefieldName: "增长", version: 1,
  phase: "draft", round: 1, openedAt: null, closesAt: null, reviewAt: null, serverNow: now,
  approver: true, deciderName: "拍板人", todo: "可以统一开放讨论", placeholder: true, goals: null,
  counts: { cards: 1, feedback: 0, pending: 0, conflicts: 0, dependencies: 1, late: 0 },
  cards: [{ cardId: "card-1", ownerId: "owner", ownerName: "Owner", roleLabel: null, missionCount: 2, line: "未开放", pending: 0, firstPendingFeedbackId: null, mine: false }],
};

describe("Mission round contracts", () => {
  it("bounds review decisions and requires a substantive collaboration conclusion", () => {
    for (const decision of ["accept", "decline"]) expect(Value.Check(MissionRoundDecideInput, { decision })).toBe(true);
    for (const invalid of [{ decision: "later" }, { decision: "accept", authorId: "forged" }, {}]) expect(Value.Check(MissionRoundDecideInput, invalid)).toBe(false);
    expect(Value.Check(MissionRoundConfirmInput, { note: "已逐人核对交接时间和验收证据。" })).toBe(true);
    for (const note of ["", " \n\t ", "字".repeat(2001)]) expect(Value.Check(MissionRoundConfirmInput, { note })).toBe(false);
    expect(Value.Check(MissionRoundConfirmInput, { note: "已核对", confirmedBy: "forged" })).toBe(false);
  });
  it("publishes authoritative conflict reasons and a cross-card pending destination", () => {
    expect(Value.Check(MissionCardGroupView.properties.roundVersion, 2)).toBe(true);
    expect(Value.Check(MissionCardGroupView.properties.roundVersion, 0)).toBe(false);
    expect(Value.Check(MissionCardFeedbackView.properties.acceptBlockedReason, "同一字段已采纳另一条")).toBe(true);
    expect(Value.Check(MissionCardFeedbackView.properties.acceptBlockedReason, null)).toBe(true);
    expect(Value.Check(MissionRoundSummary, { ...summary, counts: { ...summary.counts, cards: -1 } })).toBe(false);
    expect(Value.Check(MissionRoundSummary, { ...summary, cards: [{ ...summary.cards[0], pending: 1, firstPendingFeedbackId: "feedback-1" }] })).toBe(true);
    const schemas = buildOpenApiDocument().components.schemas;
    expect(schemas.MissionRoundDecideInput).toBeDefined();
    expect(schemas.MissionRoundConfirmInput).toBeDefined();
  });
  it("defines bounded feedback, private card scopes and group event/read shapes", () => {
    const request = { clientId: '00000000-0000-4000-8000-000000000000', kind: 'quote', round: 1, body: '评论', missionId: 'mission', field: 'outcome', quote: '原文', sourceVersion: 1 };
    // UUID format validation is performed by Fastify; schema properties and ranges are checked here.
    const { format: _format, ...clientId } = CreateMissionCardFeedbackRequest.properties.clientId;
    const schema = { ...CreateMissionCardFeedbackRequest, properties: { ...CreateMissionCardFeedbackRequest.properties, clientId } };
    expect(Value.Check(schema, request)).toBe(true);
    for (const invalid of [{ field: 'ownerId' }, { round: 0 }, { sourceVersion: 0 }, { quote: '字'.repeat(2001) }, { body: '' }, { authorId: 'forged' }]) expect(Value.Check(schema, { ...request, ...invalid })).toBe(false);
    expect(Value.Check(ConversationScope, 'mission-card:00000000-0000-4000-8000-000000000000')).toBe(true);
    expect(Value.Check(MarkMissionCardReadRequest, { lastReadSeq: -1 })).toBe(false);
    expect(Value.Check(MissionCardGroupView, { roundVersion: 1, members: [], lastReadSeq: 0, unread: 0, entries: [{ type: 'opening', at: now, text: '开场' }, { type: 'divider', at: now, text: '截止' }] })).toBe(true);
  });
  it("publishes round and personal card endpoints with authenticated reads and versioned actions", () => {
    const doc = buildOpenApiDocument();
    expect(doc.paths["/api/mission-rounds/{roundId}"]?.get.responses?.["200"]).toBeDefined();
    expect(doc.paths["/api/mission-rounds/{roundId}"]?.get.responses?.["404"]).toBeDefined();
    expect(doc.paths["/api/mission-rounds/actions/execute"]?.post.responses?.["403"]).toBeDefined();
    expect(doc.paths["/api/mission-rounds/actions/execute"]?.post.responses?.["409"]).toBeDefined();
    expect(doc.components.schemas.MissionRoundSummary).toBeDefined();
    expect(doc.components.schemas.MissionRoundDraftPayload).toBeDefined();
    for (const path of ["/api/mission-cards/{cardId}", "/api/mission-cards/{cardId}/feedback", "/api/mission-cards/{cardId}/group", "/api/mission-cards/{cardId}/group/read"]) expect(doc.paths[path]).toBeDefined();
    expect(doc.components.schemas.PersonalMissionCardPayload).toBeDefined();
  });

  it("keeps stored Mission card status distinct from the round's projected closed phase", () => {
    expect(Value.Check(MissionRoundSummary, summary)).toBe(true);
    expect(Value.Check(MissionRoundSummary, { ...summary, phase: "closed", goals: { sixMonthOutcome: "半年结果", monthOutcome: "本月结果", signedAt: now } })).toBe(true);
    for (const invalid of [{ phase: "working" }, { period: "2026-13" }, { round: 0 }, { version: 0 }, { counts: { ...summary.counts, pending: -1 } }]) {
      expect(Value.Check(MissionRoundSummary, { ...summary, ...invalid })).toBe(false);
    }
    const personalCard = MissionCardPayload.properties.personalCard;
    expect(Value.Check(personalCard, null)).toBe(true);
    expect(Value.Check(personalCard, { cardId: "card", roundId: "round", status: "draft" })).toBe(true);
    expect(Value.Check(personalCard, { cardId: "card", roundId: "round", status: "confirmed" })).toBe(true);
    expect(Value.Check(personalCard, { cardId: "card", roundId: "round", status: "closed" })).toBe(false);
  });

  it("describes a draft slot without inventing a persisted round or personal card", () => {
    const draft = { period: "2026-10", battlefieldId: "growth", battlefieldName: "增长", placeholder: true, todo: "整理个人卡草稿", serverNow: now };
    expect(Value.Check(MissionRoundDraftPayload, draft)).toBe(true);
    expect(Value.Check(MissionRoundDraftPayload, { ...draft, roundId: "invented" })).toBe(false);
    expect(Value.Check(ExecuteMissionRoundActionRequest, { actionId: "signed", viewCardId: "card-1" })).toBe(true);
    expect(Value.Check(ExecuteMissionRoundActionRequest, { actionId: "signed", input: {} })).toBe(true);
    expect(Value.Check(ExecuteMissionRoundActionRequest, { actionId: "signed", actorId: "another" })).toBe(false);
  });

  it("allows all twelve discussable fields but never owner changes or provenance rewrites", () => {
    for (const field of ["title", "why", "outcome", "successEvidence", "boundaries", "keyPath", "milestones", "resources", "dependencies", "humanAgentSplit", "risk", "retrospect"]) {
      expect(Value.Check(MissionCardField, field)).toBe(true);
    }
    expect(Value.Check(MissionCardField, "ownerId")).toBe(false);
    for (const field of ["keyPath", "resources", "humanAgentSplit", "retrospect"] as const) {
      expect(Value.Check(MissionEditInput, { [field]: "新内容" })).toBe(true);
      expect(Value.Check(MissionEditInput, { [field]: "字".repeat(4001) })).toBe(false);
      expect(CreateMissionRequest.properties[field]).toBeDefined();
      expect(MissionCardPayload.required).toContain(field);
    }
    expect(Value.Check(MissionEditInput, { placeholder: false })).toBe(false);
    expect(MissionCardPayload.required).toContain("placeholder");
    expect(MissionCardPayload.required).toContain("personalCard");
  });
});
