import type { TMemberBattlefieldResponse, TMissionCardPayload, TMissionRoundSummary } from "@warmap/contracts";
import { listBattlefieldRows } from "./battlefields.js";
import type { DirectoryPerson as MemoryPerson } from "./peopleDirectory.js";
import type { Query } from "./meetingStore.js";
import { readMemberWork } from "./memberWork.js";
import { getMissionRoundRow, missionCardLine, projectMissionRoundCard, type MissionRoundPerson } from "./missionRounds.js";
import { getMissionRow, projectMissionCard } from "./missions.js";

/** 参与者可看目标及本月名单；承诺正文仍走本人卡与当前拍板权的既有边界。 */
export async function readMemberBattlefield(q: Query, people: MemoryPerson[], secret: string, person: MissionRoundPerson, id: string, now: Date): Promise<TMemberBattlefieldResponse | null> {
  const { work } = await readMemberWork(q, people, secret, person, now);
  const participating = work.battlefields.find((field) => field.id === id);
  if (!participating) return null;
  const field = (await listBattlefieldRows(q)).find((item) => item.id === id);
  if (!field) return null;
  const names = new Map(people.map((item) => [item.personId, item.displayName]));
  const found = await q("SELECT id FROM mission_rounds WHERE battlefield_id=$1 AND period=$2", [id, work.period]);
  const row = found.rows[0] ? await getMissionRoundRow(q, found.rows[0].id) : null;
  const round = row ? (await projectMissionRoundCard(q, people, secret, person, row, now)).payload as TMissionRoundSummary : null;
  if (round) round.cards = round.cards.filter((card) => round.approver || card.mine);
  const missionCards: TMemberBattlefieldResponse["missionCards"] = [];
  if (row && round) {
    const roster = await q(`SELECT c.id,c.owner_id,c.role_label,c.owner_confirmed_at,
      (SELECT count(*)::int FROM missions m WHERE m.personal_mission_card_id=c.id) AS mission_count,
      (SELECT count(*)::int FROM mission_card_feedback f WHERE f.card_id=c.id) AS feedback_count
      FROM personal_mission_cards c WHERE c.round_id=$1 ORDER BY c.sort_order,c.owner_id,c.id`, [row.id]);
    for (const card of roster.rows as { id: string; owner_id: string; role_label: string | null; owner_confirmed_at: Date | null; mission_count: number; feedback_count: number }[]) {
      const canOpen = card.owner_id === person.personId || (round.phase === "confirmed" || !!card.owner_confirmed_at) && (round.approver || person.role === "ceo");
      missionCards.push({ cardId: card.id, ownerId: card.owner_id, ownerName: names.get(card.owner_id) ?? card.owner_id,
        roleLabel: card.role_label, missionCount: card.mission_count, feedbackCount: card.feedback_count,
        status: round.cards.find((item) => item.cardId === card.id)?.line ?? missionCardLine(round.phase, card.owner_confirmed_at, 0, 0, false),
        canOpen, href: canOpen ? `/me/mission-cards/${card.id}` : null });
    }
  }
  const myMissions: TMissionCardPayload[] = [];
  for (const mission of work.missions.filter((item) => item.battlefieldIds.includes(id))) {
    const missionRow = await getMissionRow(q, mission.id);
    if (missionRow) myMissions.push(projectMissionCard(missionRow, secret, names).payload as TMissionCardPayload);
  }
  return { ...participating, code: field.code, ownerId: field.owner_id, ownerName: names.get(field.owner_id) ?? field.owner_id,
    period: work.period, serverNow: now.toISOString(), sixMonthOutcome: field.six_month_outcome,
    missionCards, myMissions, round,
    confirmation: row?.confirmed_at && row.confirmed_by ? { byName: names.get(row.confirmed_by) ?? row.confirmed_by, at: row.confirmed_at.toISOString() } : null };
}
