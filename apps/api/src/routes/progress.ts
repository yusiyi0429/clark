import { BattlefieldSummariesResponse, ProgressOverviewResponse } from "@warmap/contracts";
import type { BattlefieldSummaries } from "../battlefieldSummary.js";
import { readProgressOverview } from "../progress.js";
import type { AppInstance, RouteContext } from "./shared.js";

/** 全局进展。可见范围在仓储层（progress.ts）判：CEO 看全部，其他人看同一战场的人。 */
export function registerProgressRoutes(app: AppInstance, ctx: RouteContext, summaries: BattlefieldSummaries): void {
  app.get("/api/progress", {
    preHandler: ctx.requirePerson,
    schema: { response: { 200: ProgressOverviewResponse } },
  }, async (req) => ({ progress: await readProgressOverview(ctx.q, req.person!, ctx.peopleDirectory.searchPeople(undefined), ctx.now()) }));
  // 战场进展汇总：CEO 看全部战场，其他人看自己所在的战场；今天这份还没有时当场开始整理（battlefieldSummary.ts）。
  app.get("/api/progress/battlefield-summaries", {
    preHandler: ctx.requirePerson,
    schema: { response: { 200: BattlefieldSummariesResponse } },
  }, async (req) => summaries.read(req.person!));
}
