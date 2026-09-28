import { WeeklyProgressQuery, WeeklyProgressResponse } from "@warmap/contracts";
import { personDisplayNames } from "../people.js";
import { loadWeeklyProgress, weekRange } from "../weeklyProgress.js";
import type { AppInstance, RouteContext } from "./shared.js";

export function registerOntologyRoutes(app: AppInstance, ctx: RouteContext): void {
  const { env, fail, requireServiceToken, q, now, companyMemory } = ctx;
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
    return loadWeeklyProgress(q, range, personDisplayNames(companyMemory));
  });
}
