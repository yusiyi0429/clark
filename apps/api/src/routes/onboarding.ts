import { CompleteOnboardingResponse, OnboardingResponse, ScheduleMigrationResponse, UpdateScheduleMigrationRequest, UpdateWorkBasisRequest,
  WorkBasisResponse } from "@warmap/contracts";
import { completeOnboarding, readOnboarding, resetOnboarding } from "../onboarding.js";
import { readScheduleMigration, readWorkBasis, saveScheduleMigration, saveWorkBasis, type FeishuDocReader } from "../onboardingLists.js";
import type { AppInstance, RouteContext } from "./shared.js";

/** feishu：读本人工作依据里飞书文档的标题、修订时间和修订人；没配飞书时为空。 */
export function registerOnboardingRoutes(app: AppInstance, ctx: RouteContext, feishu?: FeishuDocReader): void {
  const { pool, q, fail, peopleDirectory, voiceprints, env, now, requirePerson } = ctx;
  app.get(
    "/api/me/onboarding",
    { preHandler: requirePerson, schema: { response: { 200: OnboardingResponse } } },
    async (req) => readOnboarding({ q, peopleDirectory, voiceprints, person: req.person!, companyName: env.companyName, now: now(), secret: env.sessionSecret,
      delegationStep: env.onboardingDelegationStep === true }),
  );
  app.post(
    "/api/me/onboarding/complete",
    { preHandler: requirePerson, schema: { response: { 200: CompleteOnboardingResponse } } },
    async (req) => {
      await completeOnboarding(q, req.person!.personId, now());
      return { onboarded: true as const };
    },
  );
  app.delete("/api/me/onboarding/complete", { preHandler: requirePerson }, async (req, reply) => {
    await resetOnboarding(q, req.person!.personId);
    return reply.code(204).send();
  });

  // 上手最后一页的工作依据清单与搬家清单：候选现算，提交只收勾选的 key。
  app.get("/api/me/work-basis", { preHandler: requirePerson, schema: { response: { 200: WorkBasisResponse } } },
    async (req) => ({ candidates: await readWorkBasis(q, req.person!.personId, feishu, now()) }));
  app.put("/api/me/work-basis", { preHandler: requirePerson, schema: { body: UpdateWorkBasisRequest, response: { 200: WorkBasisResponse } } }, async (req, reply) => {
    const saved = await saveWorkBasis(pool, req.person!.personId, req.body.keys, feishu, now());
    return saved.ok ? { candidates: saved.candidates } : fail(reply, 400, "INVALID_INPUT", saved.message);
  });
  app.get("/api/me/schedule-migration", { preHandler: requirePerson, schema: { response: { 200: ScheduleMigrationResponse } } },
    async (req) => ({ candidates: await readScheduleMigration(q, req.person!.personId) }));
  app.put("/api/me/schedule-migration", { preHandler: requirePerson, schema: { body: UpdateScheduleMigrationRequest, response: { 200: ScheduleMigrationResponse } } }, async (req, reply) => {
    const saved = await saveScheduleMigration(pool, req.person!.personId, req.body.keys, now());
    return saved.ok ? { candidates: saved.candidates } : fail(reply, 400, "INVALID_INPUT", saved.message);
  });
}
