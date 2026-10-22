import { ProgressOverviewResponse } from "@warmap/contracts";
import { readProgressOverview } from "../progress.js";
import type { AppInstance, RouteContext } from "./shared.js";

/** 全局进展。可见范围在仓储层（progress.ts）判：CEO 看全部，其他人看同一战场的人。 */
export function registerProgressRoutes(app: AppInstance, ctx: RouteContext): void {
  app.get("/api/progress", {
    preHandler: ctx.requirePerson,
    schema: { response: { 200: ProgressOverviewResponse } },
  }, async (req) => ({ progress: await readProgressOverview(ctx.q, req.person!, ctx.peopleDirectory.searchPeople(undefined), ctx.now()) }));
}
