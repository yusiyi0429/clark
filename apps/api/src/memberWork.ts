import type { TMemberWork, TPersonalMissionCardPayload } from "@warmap/contracts";
import { listBattlefieldRows } from "./battlefields.js";
import type { MemoryPerson } from "./companyMemory.js";
import type { Query } from "./meetingStore.js";
import { companyPeriod, type MonthlyPlanRow } from "./monthlyPlans.js";
import type { MissionRoundPerson } from "./missionRounds.js";
import { getPersonalMissionCard } from "./personalMissionCards.js";

type Plan = Pick<MonthlyPlanRow, "status" | "battlefields">;

/** 首次引导与日常工作台共用，参与关系和月份不在两个入口各算一遍。 */
export async function readMemberWork(q: Query, people: MemoryPerson[], secret: string, person: MissionRoundPerson, now: Date): Promise<{
  work: TMemberWork; deciders: Map<string, string>;
}> {
  const period = companyPeriod(now);
  const [battlefields, plans, missionRows, ownedCards] = await Promise.all([
    listBattlefieldRows(q),
    q("SELECT status,battlefields FROM monthly_plans WHERE period=$1", [period]),
    q("SELECT id,code,title,battlefield_ids FROM missions WHERE period=$1 AND owner_id=$2 ORDER BY code,id", [period, person.personId]),
    q(`SELECT c.id FROM personal_mission_cards c JOIN mission_rounds r ON r.id=c.round_id
      JOIN battlefield_config b ON b.id=r.battlefield_id WHERE r.period=$1 AND c.owner_id=$2 ORDER BY b.sort_order,b.code,c.sort_order,c.id`, [period, person.personId]),
  ]);
  const plan = plans.rows[0] as Plan | undefined;
  const missionCards: TMemberWork["missionCards"] = [];
  const deciders = new Map<string, string>();
  for (const entry of ownedCards.rows as { id: string }[]) {
    const card = await getPersonalMissionCard(q, people, secret, person, entry.id, now);
    if (!card) continue;
    const { round, card: personal } = card.payload as TPersonalMissionCardPayload;
    deciders.set(round.roundId, round.deciderName);
    missionCards.push({ cardId: personal.cardId, roundId: round.roundId, period: round.period,
      battlefieldId: round.battlefieldId, battlefieldName: round.battlefieldName, phase: round.phase,
      status: personal.status, closesAt: round.closesAt, serverNow: round.serverNow,
      missionCount: personal.missions.length, placeholder: round.placeholder, href: `/me/mission-cards/${personal.cardId}` });
  }
  const missions = (missionRows.rows as { id: string; code: string; title: string; battlefield_ids: string[] }[])
    .map(({ id, code, title, battlefield_ids }) => ({ id, code, title, battlefieldIds: battlefield_ids }));
  const participating = new Set(missions.flatMap((mission) => mission.battlefieldIds));
  for (const card of missionCards) participating.add(card.battlefieldId);
  return { deciders, work: {
    period, planStatus: plan?.status ?? "none", missions, missionCards,
    battlefields: battlefields.filter((field) => field.owner_id === person.personId || participating.has(field.id))
      .map(({ id, name, owner_id }) => {
        const monthTarget = plan?.status === "confirmed" ? plan.battlefields.find((field) => field.battlefieldId === id)?.outcome ?? null : null;
        const monthTargetState = !plan ? "none" : plan.status === "confirmed" ? "confirmed" : "negotiating";
        return { id, name, isDri: owner_id === person.personId, monthTarget, monthTargetState,
          monthTargetText: monthTargetState === "none" ? "本月目标还没出来" : monthTargetState === "negotiating" ? "本月目标还在协商" : monthTarget || "这个战场的本月目标还没有登记" };
      }),
  } };
}
