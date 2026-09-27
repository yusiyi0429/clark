import { describe, expect, it } from "vitest";
import { Value } from "@sinclair/typebox/value";
import { CompleteOnboardingResponse, LoginResponse, OnboardingResponse, SessionResponse } from "../src/index.js";
import { buildOpenApiDocument } from "../src/openapi.js";

const common = {
  displayName: "测试乙", companyName: null,
  next: { text: "可以开始了", action: "进入工作台", href: "/me" },
  voiceprint: { configured: false, enrolled: false, updatedAt: null },
};
const company = { sixMonthGoal: "", battlefields: [], capabilities: [], people: [] };
const work = { period: "2026-10", planStatus: "none", battlefields: [], missions: [], missionCards: [] };

describe("onboarding contract", () => {
  it("keeps session and login compatible with older responses", () => {
    for (const onboarded of [undefined, false, true]) {
      const state = onboarded === undefined ? {} : { onboarded };
      expect(Value.Check(SessionResponse, { authenticated: true, role: "member", ...state })).toBe(true);
      expect(Value.Check(LoginResponse, { authenticated: true, mustChangePasscode: false, ...state })).toBe(true);
    }
    expect(Value.Check(CompleteOnboardingResponse, { onboarded: true })).toBe(true);
    expect(Value.Check(CompleteOnboardingResponse, { onboarded: false })).toBe(false);
  });

  it("separates the CEO snapshot from member work and accepts each real plan state", () => {
    expect(Value.Check(OnboardingResponse, { ...common, role: "ceo", company })).toBe(true);
    for (const planStatus of ["none", "draft", "negotiating", "confirmed"]) {
      expect(Value.Check(OnboardingResponse, { ...common, role: "member", work: { ...work, planStatus } })).toBe(true);
    }
    expect(Value.Check(OnboardingResponse, { ...common, role: "member", company, work })).toBe(false);
    expect(Value.Check(OnboardingResponse, { ...common, role: "ceo", work })).toBe(false);
    expect(Value.Check(OnboardingResponse, { ...common, role: "member", work: { ...work, period: "2026-13" } })).toBe(false);
  });

  it("publishes both endpoints with their identity and origin errors", () => {
    const doc = buildOpenApiDocument();
    expect(doc.paths["/api/me/onboarding"].get.responses["401"]).toBeDefined();
    expect(doc.paths["/api/me/onboarding/complete"].post.responses["403"]).toBeDefined();
    expect(doc.components.schemas.OnboardingResponse).toBeDefined();
    expect(doc.components.schemas.CompleteOnboardingResponse).toBeDefined();
  });
});
