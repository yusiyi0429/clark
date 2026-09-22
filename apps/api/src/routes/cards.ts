import type { FastifyReply } from "fastify";
import { PeopleDirectoryResponse, type TCardCollection } from "@warmap/contracts";
import { listBattlefieldCards } from "../battlefields.js";
import { listCapabilityCards } from "../capabilities.js";
import { getIssueRow, listPendingIssueCards, projectIssueCard } from "../issues.js";
import { getMeetingRow, listMeetingRows, projectMeetingCard } from "../meetingStore.js";
import { companyPeriod, getMonthlyPlanNotice, getMonthlyPlanRow, listMonthlyPlanRows, projectMonthlyPlanCard } from "../monthlyPlans.js";
import { personDisplayNames } from "../people.js";
import { projectRadarCard } from "../signals.js";
import { idParams, type AppInstance, type RouteContext } from "./shared.js";

export function registerCardRoutes(app: AppInstance, ctx: RouteContext): void {
  const { q, env, fail, requireCEO, now, companyMemory, radar } = ctx;

  app.get("/api/people", { preHandler: requireCEO, schema: { response: { 200: PeopleDirectoryResponse } } }, async () => ({
    people: companyMemory.searchPeople(undefined).map((person) => ({
      personId: person.personId,
      displayName: person.displayName,
      roles: [...person.roles],
    })),
  }));
  app.get("/api/cards/home", { preHandler: requireCEO }, async (): Promise<TCardCollection> => {
    const [radarCard, battlefields, issues, capabilities, meetingRows, monthlyNotice] = await Promise.all([
      projectRadarCard(q, radar.providerStatus),
      listBattlefieldCards(q, companyPeriod(now()), personDisplayNames(companyMemory)),
      listPendingIssueCards(q, env.sessionSecret),
      listCapabilityCards(q),
      listMeetingRows(q),
      getMonthlyPlanNotice(q, env.sessionSecret, now()),
    ]);
    const meetings = meetingRows
      .filter((row) => row.status === "scheduled")
      .map((row) => projectMeetingCard(row, env.sessionSecret));
    const monthly = monthlyNotice && (monthlyNotice.payload as { status?: string }).status !== "confirmed" ? [monthlyNotice] : [];
    return { cards: [radarCard, ...battlefields, ...capabilities, ...issues, ...meetings, ...monthly] };
  });
  app.get(
    "/api/cards/issues/:id",
    {
      preHandler: requireCEO,
      schema: { params: idParams },
    },
    async (req, reply): Promise<TCardCollection | FastifyReply> => {
      const issue = await getIssueRow(q, req.params.id);
      return issue
        ? { cards: [projectIssueCard(issue, env.sessionSecret)] }
        : fail(reply, 404, "CARD_NOT_FOUND", "Card 不存在");
    },
  );

  app.get("/api/cards/meetings", { preHandler: requireCEO }, async (): Promise<TCardCollection> => {
    const rows = await listMeetingRows(q);
    return { cards: rows.map((row) => projectMeetingCard(row, env.sessionSecret)) };
  });

  app.get(
    "/api/cards/meetings/:id",
    { preHandler: requireCEO, schema: { params: idParams } },
    async (req, reply): Promise<TCardCollection | FastifyReply> => {
      const meeting = await getMeetingRow(q, req.params.id);
      return meeting ? { cards: [projectMeetingCard(meeting, env.sessionSecret)] } : fail(reply, 404, "CARD_NOT_FOUND", "Card 不存在");
    },
  );

  // 会前通知与 Meeting 详情是同一 projector 的投影，不保存第二份 Meeting。
  // 月度通知与月度页面同样读取同一 MonthlyPlan 持久对象。
  app.get("/api/cards/notifications", { preHandler: requireCEO }, async (): Promise<TCardCollection> => {
    const rows = (await listMeetingRows(q)).filter((row) => row.status === "scheduled");
    const monthlyNotice = await getMonthlyPlanNotice(q, env.sessionSecret, now());
    return { cards: [...(monthlyNotice ? [monthlyNotice] : []), ...rows.map((row) => projectMeetingCard(row, env.sessionSecret))] };
  });

  app.get("/api/cards/monthly-plans", { preHandler: requireCEO }, async (): Promise<TCardCollection> => {
    const rows = await listMonthlyPlanRows(q);
    return { cards: rows.map((row) => projectMonthlyPlanCard(row, env.sessionSecret)) };
  });

  app.get(
    "/api/cards/monthly-plans/:id",
    { preHandler: requireCEO, schema: { params: idParams } },
    async (req, reply): Promise<TCardCollection | FastifyReply> => {
      const row = await getMonthlyPlanRow(q, req.params.id);
      return row ? { cards: [projectMonthlyPlanCard(row, env.sessionSecret)] } : fail(reply, 404, "CARD_NOT_FOUND", "Card 不存在");
    },
  );

  // 战场 Card：正面读已签发计划目标，背面按 battlefieldId 投影 todo/feedback，与通知同源。
  app.get("/api/cards/battlefields", { preHandler: requireCEO }, async (): Promise<TCardCollection> => ({
    cards: await listBattlefieldCards(q, companyPeriod(now()), personDisplayNames(companyMemory)),
  }));
}
