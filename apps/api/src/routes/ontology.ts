import { WeeklyProgressQuery, WeeklyProgressResponse, WorldSourceParams, WorldSourceView } from "@warmap/contracts";
import { readWorldSource } from "../company.js";
import { personDisplayNames } from "../people.js";
import { loadWeeklyProgress, weekRange } from "../weeklyProgress.js";
import type { AppInstance, RouteContext } from "./shared.js";

export function registerOntologyRoutes(app: AppInstance, ctx: RouteContext): void {
  const { env, fail, requireServiceToken, q, now, peopleDirectory } = ctx;
  app.get("/api/ontology/weekly-progress", {
    onRequest: (req, reply, done) => {
      if (!env.ontologyServiceToken) {
        fail(reply, 503, "ONTOLOGY_SYNC_DISABLED", "本体同步未配置");
        return;
      }
      requireServiceToken(env.ontologyServiceToken)(req, reply, done);
    },
    schema: { querystring: WeeklyProgressQuery, response: { 200: WeeklyProgressResponse } },
  }, async (req, reply) => {
    let range: ReturnType<typeof weekRange>;
    try { range = weekRange(req.query.week, now()); }
    catch (error) {
      if (error instanceof RangeError) return fail(reply, 400, "INVALID_INPUT", error.message);
      throw error;
    }
    reply.header("Cache-Control", "no-store");
    return loadWeeklyProgress(q, range, personDisplayNames(peopleDirectory));
  });

  // 出处卡：答案里的 cite:world:<ref> 点开后读的那个对象。按本人授权的域读，不在范围里的和不存在的一样回 404。
  app.get("/api/ontology/objects/:id", { preHandler: ctx.requirePerson, schema: { params: WorldSourceParams, response: { 200: WorldSourceView } } }, async (req, reply) => {
    reply.header("Cache-Control", "no-store");
    const person = req.person!;
    const result = await readWorldSource(env, { personId: person.personId, role: person.role }, req.params.id, AbortSignal.timeout(20_000));
    switch (result.status) {
      case "ready": return result.source;
      case "not_found": case "coverage_unavailable": return fail(reply, 404, "WORLD_OBJECT_NOT_FOUND", "读不到这个本体对象");
      case "not_configured": return fail(reply, 503, "WORLD_NOT_CONFIGURED", "本体读取尚未配置");
      default: return fail(reply, 503, "WORLD_UNAVAILABLE", "本体暂时读不到");
    }
  });
}
