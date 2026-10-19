import type { FastifyReply } from "fastify";
import { PeopleDirectoryResponse, type TCard, type TCardCollection } from "@warmap/contracts";
import { listBattlefieldCards } from "../battlefields.js";
import { listCapabilityCards } from "../capabilities.js";
import { canReadMission, getMissionRow, listMissionCards, projectMissionCard } from "../missions.js";
import { listMissionRoundCards } from "../missionRounds.js";
import { getIssueRow, listPendingIssueCards, projectIssueCard } from "../issues.js";
import { getMeetingRow, hasMeetingNotice, hasPendingStrategicItem, listMeetingRows, projectMeetingCard } from "../meetingStore.js";
import { companyPeriod, getMonthlyPlanNotice, getMonthlyPlanRow, listMonthlyPlanRows, projectMonthlyPlanCard } from "../monthlyPlans.js";
import { isRealPerson, personDisplayNames } from "../people.js";
import { projectRadarCard } from "../signals.js";
import { idParams, type AppInstance, type RouteContext, type SessionPerson } from "./shared.js";

/** CEO 首页的 Card 集合（首页与对话的场景锚点共用同一份投影，不另写一套汇总）。 */
export async function readHomeCards(ctx: RouteContext, person: SessionPerson): Promise<TCardCollection> {
  const { q, env, now, peopleDirectory, radar } = ctx;
  const at = now();
  const period = companyPeriod(at);
  const people = peopleDirectory.searchPeople(undefined);
  const [radarCard, battlefields, issues, capabilities, meetingRows, missions, monthlyNotice, rounds] = await Promise.all([
    projectRadarCard(q, radar.providerStatus, at),
    listBattlefieldCards(q, period, personDisplayNames(peopleDirectory)),
    listPendingIssueCards(q, env.sessionSecret),
    listCapabilityCards(q),
    listMeetingRows(q),
    // 首页只读当前公司周期的 Mission：战场卡 Mission 数、能力面板数量与入口都从这份 collection 派生，不保存汇总；历史周期留在 /api/cards/missions
    listMissionCards(q, env.sessionSecret, personDisplayNames(peopleDirectory), period, person),
    getMonthlyPlanNotice(q, env.sessionSecret, at),
    listMissionRoundCards(q, people, env.sessionSecret, person, undefined, at),
  ]);
  // 会前通知看 scheduled；会后有待 CEO 确认的战略议题的会议也进首页（通知栏「需要你确认」）
  const meetings = meetingRows
    .filter((row) => hasMeetingNotice(row, person.personId, at) || hasPendingStrategicItem(row.outcome))
    .map((row) => projectMeetingCard(row, env.sessionSecret, at));
  const monthly = monthlyNotice && (monthlyNotice.payload as { status?: string }).status !== "confirmed" ? [monthlyNotice] : [];
  return { cards: [radarCard, ...battlefields, ...capabilities, ...issues, ...meetings, ...missions, ...monthly, ...rounds] };
}

export function registerCardRoutes(app: AppInstance, ctx: RouteContext): void {
  const { q, env, fail, requireCEO, now, peopleDirectory, radar } = ctx;

  app.get("/api/people", { preHandler: requireCEO, schema: { response: { 200: PeopleDirectoryResponse } } }, async () => ({
    people: peopleDirectory.searchPeople(undefined).filter(isRealPerson).map((person) => ({
      personId: person.personId,
      displayName: person.displayName,
      roles: [...person.roles],
    })),
  }));
  app.get("/api/cards/home", { preHandler: requireCEO }, async (req): Promise<TCardCollection> => readHomeCards(ctx, req.person!));
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
  app.get("/api/cards/notifications", { preHandler: requireCEO }, async (req): Promise<TCardCollection> => {
    const at = now();
    const rows = (await listMeetingRows(q)).filter((row) => hasMeetingNotice(row, req.person!.personId, at));
    const monthlyNotice = await getMonthlyPlanNotice(q, env.sessionSecret, at);
    return { cards: [...(monthlyNotice ? [monthlyNotice] : []), ...rows.map((row) => projectMeetingCard(row, env.sessionSecret, at))] };
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

  // Mission Card：总览与详情共用同一 projector；关系显示名在投影时现查。
  app.get("/api/cards/missions", { preHandler: requireCEO }, async (req): Promise<TCardCollection> => ({
    cards: await listMissionCards(q, env.sessionSecret, personDisplayNames(peopleDirectory), undefined, req.person!),
  }));

  app.get(
    "/api/cards/missions/:id",
    { preHandler: requireCEO, schema: { params: idParams } },
    async (req, reply): Promise<TCardCollection | FastifyReply> => {
      const mission = await getMissionRow(q, req.params.id);
      return mission && await canReadMission(q, mission, req.person!)
        ? { cards: [projectMissionCard(mission, env.sessionSecret, personDisplayNames(peopleDirectory))] }
        : fail(reply, 404, "CARD_NOT_FOUND", "Card 不存在");
    },
  );

  // 战场 Card：正面读已签发计划目标，背面按 battlefieldId 投影 todo/feedback，与通知同源。
  app.get("/api/cards/battlefields", { preHandler: requireCEO }, async (): Promise<TCardCollection> => ({
    cards: await listBattlefieldCards(q, companyPeriod(now()), personDisplayNames(peopleDirectory)),
  }));
  // 单个战场（二级页）：与列表同一份投影，未登记的战场 404。
  app.get(
    "/api/cards/battlefields/:id",
    { preHandler: requireCEO, schema: { params: idParams } },
    async (req, reply): Promise<TCardCollection | FastifyReply> => {
      const cards = await listBattlefieldCards(q, companyPeriod(now()), personDisplayNames(peopleDirectory));
      const card = cards.find((item) => item.objectRef.id === req.params.id);
      return card ? { cards: [card] } : fail(reply, 404, "CARD_NOT_FOUND", "战场不存在");
    },
  );
}
