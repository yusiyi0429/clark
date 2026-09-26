import { describe, expect, it } from "vitest";
import { Value } from "@sinclair/typebox/value";
import {
  ExecuteMissionRoundActionRequest, MissionCardField, MissionRoundDraftPayload, MissionRoundSummary,
  CreateMissionRequest, MissionEditInput, MissionCardPayload,
} from "../src/index.js";
import { buildOpenApiDocument } from "../src/openapi.js";

const now = "2026-10-01T00:00:00.000Z";
const summary = {
  roundId: "round-1", period: "2026-10", battlefieldId: "growth", battlefieldName: "增长", version: 1,
  phase: "draft", round: 1, openedAt: null, closesAt: null, reviewAt: null, serverNow: now,
  approver: true, deciderName: "拍板人", todo: "可以统一开放讨论", placeholder: true, goals: null,
  counts: { feedback: 0, pending: 0, conflicts: 0, dependencies: 1, late: 0 },
  cards: [{ cardId: "card-1", ownerId: "owner", ownerName: "Owner", roleLabel: null, missionCount: 2, line: "未开放", pending: 0, mine: false }],
};

describe("Mission round contracts", () => {
  it("publishes only the 04a endpoints with authenticated reads and versioned actions", () => {
    const doc = buildOpenApiDocument();
    expect(doc.paths["/api/mission-rounds/{roundId}"]?.get.responses?.["200"]).toBeDefined();
    expect(doc.paths["/api/mission-rounds/{roundId}"]?.get.responses?.["404"]).toBeDefined();
    expect(doc.paths["/api/mission-rounds/actions/execute"]?.post.responses?.["403"]).toBeDefined();
    expect(doc.paths["/api/mission-rounds/actions/execute"]?.post.responses?.["409"]).toBeDefined();
    expect(doc.components.schemas.MissionRoundSummary).toBeDefined();
    expect(doc.components.schemas.MissionRoundDraftPayload).toBeDefined();
    expect(doc.paths["/api/mission-cards/{cardId}/feedback"]).toBeUndefined();
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
