import { WorkersResponse } from "@warmap/contracts";
import { personDisplayNames } from "../people.js";
import { listWorkers } from "../workers.js";
import type { AppInstance, RouteContext } from "./shared.js";

/**
 * worker 列表（契约 workers.ts）：网页读 GET /api/me/workers（本人）；伙伴的「worker 摘要」工具读 GET /internal/me/workers，
 * 照现有 /internal：Authorization: Bearer <INTERNAL_CHAT_TOKEN> 加 X-Owner-Id，没配 INTERNAL_CHAT_TOKEN 时不注册，不进公开 OpenAPI。
 */
export function registerWorkerRoutes(app: AppInstance, ctx: RouteContext): void {
  const { q, env, fail, requirePerson, requireServiceToken, peopleDirectory } = ctx;
  const workers = (ownerId: string) => listWorkers({ q, planTasks: ctx.planTasks, now: ctx.now(), names: personDisplayNames(peopleDirectory),
    reviewModel: env.review?.model ?? env.heavyModel }, ownerId);

  app.get("/api/me/workers", { preHandler: requirePerson, schema: { response: { 200: WorkersResponse } } }, async (req) => workers(req.person!.personId));

  if (!env.internalChatToken) return;
  app.get("/internal/me/workers", { onRequest: requireServiceToken(env.internalChatToken), schema: { response: { 200: WorkersResponse } } }, async (req, reply) => {
    const id = req.headers["x-owner-id"];
    if (typeof id !== "string" || !peopleDirectory.searchPeople(undefined).some((person) => person.personId === id)) return fail(reply, 404, "OWNER_NOT_FOUND", "提问人不在人员目录");
    return workers(id);
  });
}
