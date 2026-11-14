import type { FastifyReply } from "fastify";
import { PeopleDirectoryResponse, PersonDirectoryResponse, type TCard, type TCardCollection, type TReferenceSnapshot } from "@warmap/contracts";
import { listBattlefieldCards } from "../battlefields.js";
import { listCapabilityCards } from "../capabilities.js";
import { canReadMission, getMissionRow, listMissionCards, projectMissionCard } from "../missions.js";
import { listMissionRoundCards, type MissionRoundPerson } from "../missionRounds.js";
import { getIssueRow, listPendingIssueCards, projectIssueCard } from "../issues.js";
import { getMeetingRow, hasMeetingNotice, listMeetingRows, projectMeetingCard } from "../meetingStore.js";
import { companyPeriod, getMonthlyPlanNotice, getMonthlyPlanRow, listMonthlyPlanRows, projectMonthlyPlanCard } from "../monthlyPlans.js";
import { isRealPerson, personDisplayNames } from "../people.js";
import { projectRadarCard } from "../signals.js";
import { listMyTasks } from "../tasks.js";
import { readMemberWork } from "../memberWork.js";
import { meetingForViewer, type MinuteReader } from "../partnerMeetings.js";
import { idParams, type AppInstance, type RouteContext } from "./shared.js";

/** CEO 首页的 Card 集合（首页与对话的场景锚点共用同一份投影，不另写一套汇总）。 */
export async function readHomeCards(ctx: RouteContext, person: MissionRoundPerson, minutes?: MinuteReader): Promise<TCardCollection> {
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
    // 天枢自己的月度计划关着（TIANSHU_MONTHLY_CYCLE，缺省关，月初拆解走 M2）时不出「月度计划待签发」。
    env.tianshuMonthlyCycle ? getMonthlyPlanNotice(q, env.sessionSecret, at) : null,
    listMissionRoundCards(q, people, env.sessionSecret, person, undefined, at),
  ]);
  // 会前通知看 scheduled；会后的会议记录待确认走 /api/me/meeting-cards（不再单列给 CEO 确认的战略项）
  const meetings = await Promise.all(meetingRows.filter((row) => hasMeetingNotice(row, person.personId, at))
    .map(async row => projectMeetingCard(await meetingForViewer(q,minutes,row,person), env.sessionSecret, at)));
  const monthly = monthlyNotice && (monthlyNotice.payload as { status?: string }).status !== "confirmed" ? [monthlyNotice] : [];
  return { cards: [radarCard, ...battlefields, ...capabilities, ...issues, ...meetings, ...missions, ...monthly, ...rounds] };
}

/**
 * 首页上本人能看到的东西（对话的场景锚点与给独立 Chat 的 /internal/home-cards 共用，不带 Action）：
 * CEO 是公司首页的 Card；成员是我的工作台上本人的执行事项、任务卡与战场。
 */
export async function readHomeSnapshots(ctx: RouteContext, person: MissionRoundPerson, minutes?: MinuteReader): Promise<TReferenceSnapshot[]> {
  const { q, env, peopleDirectory } = ctx;
  if (person.role === "ceo") return (await readHomeCards(ctx, person, minutes)).cards.map((card) => ({
    cardId: card.id, version: card.version, kind: card.kind, title: card.title, objectRef: card.objectRef, payload: card.payload,
  }));
  const [tasks, { work }] = await Promise.all([
    listMyTasks(q, person.personId, personDisplayNames(peopleDirectory)),
    readMemberWork(q, peopleDirectory.searchPeople(undefined), env.sessionSecret, person, ctx.now()),
  ]);
  const item = (type: string, id: string, title: string, payload: unknown, version = 1): TReferenceSnapshot =>
    ({ cardId: `${type}:${id}`, version, kind: type, title, objectRef: { type, id, version }, payload });
  return [
    ...tasks.map((task) => item("task", task.id, task.title, { task }, task.version)),
    ...work.missionCards.map((card) => item("mission-card", card.cardId, `${card.battlefieldName} · ${card.period} 任务卡`, card)),
    ...work.battlefields.map((field) => item("battlefield", field.id, field.name, { period: work.period, ...field })),
  ];
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
  // 人员名册：CEO 和成员约会议选参会人；只给真人的 personId 和名字（角色、来源不出去）。
  app.get("/api/people/directory", { preHandler: ctx.requirePerson, schema: { response: { 200: PersonDirectoryResponse } } }, async () => ({
    people: peopleDirectory.searchPeople(undefined).filter(isRealPerson).map(({ personId, displayName }) => ({ personId, displayName })),
  }));
  app.get("/api/cards/home", { preHandler: requireCEO }, async (req): Promise<TCardCollection> => readHomeCards(ctx, req.person!, app.meetingFollowThrough.minutes));
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

  app.get("/api/cards/meetings", { preHandler: requireCEO }, async (req): Promise<TCardCollection> => {
    const rows = await listMeetingRows(q);
    return { cards: await Promise.all(rows.map(async row => projectMeetingCard(await meetingForViewer(q,app.meetingFollowThrough.minutes,row,req.person!), env.sessionSecret))) };
  });

  app.get(
    "/api/cards/meetings/:id",
    { preHandler: requireCEO, schema: { params: idParams } },
    async (req, reply): Promise<TCardCollection | FastifyReply> => {
      const meeting = await getMeetingRow(q, req.params.id);
      return meeting ? { cards: [projectMeetingCard(await meetingForViewer(q,app.meetingFollowThrough.minutes,meeting,req.person!), env.sessionSecret)] } : fail(reply, 404, "CARD_NOT_FOUND", "Card 不存在");
    },
  );

  // 会前通知与 Meeting 详情是同一 projector 的投影，不保存第二份 Meeting。
  // 月度通知与月度页面同样读取同一 MonthlyPlan 持久对象。
  app.get("/api/cards/notifications", { preHandler: requireCEO }, async (req): Promise<TCardCollection> => {
    const at = now();
    const rows = (await listMeetingRows(q)).filter((row) => hasMeetingNotice(row, req.person!.personId, at));
    const monthlyNotice = env.tianshuMonthlyCycle ? await getMonthlyPlanNotice(q, env.sessionSecret, at) : null;
    const cards = await Promise.all(rows.map(async row => projectMeetingCard(await meetingForViewer(q,app.meetingFollowThrough.minutes,row,req.person!), env.sessionSecret, at)));
    return { cards: [...(monthlyNotice ? [monthlyNotice] : []), ...cards] };
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
