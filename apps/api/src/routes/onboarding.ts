import { CompleteOnboardingResponse, OnboardingResponse } from "@warmap/contracts";
import { completeOnboarding, readOnboarding } from "../onboarding.js";
import type { AppInstance, RouteContext } from "./shared.js";

export function registerOnboardingRoutes(app: AppInstance, ctx: RouteContext): void {
  const { q, companyMemory, voiceprints, env, now, requirePerson } = ctx;
  app.get(
    "/api/me/onboarding",
    { preHandler: requirePerson, schema: { response: { 200: OnboardingResponse } } },
    async (req) => readOnboarding({ q, companyMemory, voiceprints, person: req.person!, companyName: env.companyName, now: now(), secret: env.sessionSecret, draftsDirectory: env.missionCardDraftsDir }),
  );
  app.post(
    "/api/me/onboarding/complete",
    { preHandler: requirePerson, schema: { response: { 200: CompleteOnboardingResponse } } },
    async (req) => {
      await completeOnboarding(q, req.person!.personId, now());
      return { onboarded: true as const };
    },
  );
}
