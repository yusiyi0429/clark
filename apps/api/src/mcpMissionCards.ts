import type { TPersonalMissionCardPayload } from "@warmap/contracts";
import type { DirectoryPerson as MemoryPerson } from "./peopleDirectory.js";
import type { Query } from "./meetingStore.js";
import { canApprove, missionCardWriteProblem, type MissionRoundPerson } from "./missionRounds.js";
import { getPersonalMissionCard, visiblePersonalMissionCard } from "./personalMissionCards.js";
import { listMissionCardAnnotations } from "./missionCardAnnotations.js";

/** Shared projection for private card conversations and personal MCP. No action credentials escape. */
export async function readMissionCardForAgent(q: Query, people: MemoryPerson[], secret: string,
  person: MissionRoundPerson, cardId: string, now: Date) {
  const card = await getPersonalMissionCard(q, people, secret, person, cardId, now);
  if (!card) return null;
  const payload = card.payload as TPersonalMissionCardPayload;
  const summary = payload.round.cards.find((entry) => entry.cardId === cardId);
  const annotations = await listMissionCardAnnotations(q, people, secret, person, cardId, now);
  // All reads recheck membership, including history; membership revoked mid-read must fail closed.
  const visible = await visiblePersonalMissionCard(q, person, cardId);
  if (!annotations || !visible || visible.round.window_seq !== payload.round.round) return null;
  return {
    id: cardId, title: card.title, owner: { id: payload.card.ownerId, name: payload.card.ownerName },
    battlefield: { id: payload.round.battlefieldId, name: payload.round.battlefieldName }, period: payload.round.period,
    status: payload.card.status, goals: payload.round.goals, round: visible.round.window_seq,
    ownerConfirmedAt: visible.card.owner_confirmed_at?.toISOString() ?? null,
    reviewContext: { phase: payload.round.phase, snapshotAt: payload.round.closesAt,
      takenAt: payload.round.reviewAt, confirmedAt: payload.confirmation?.at ?? null },
    pendingOpinions: (summary?.pending ?? 0) + (summary?.pendingCorrections ?? 0),
    editable: payload.selfReview.canEdit && !missionCardWriteProblem(visible.round, visible.card, now)
      && visible.card.owner_id === person.personId,
    missions: payload.card.missions.map((mission) => ({ id: mission.missionId, version: mission.version,
      title: mission.title, outcome: mission.outcome, why: mission.why,
      timeBoundary: mission.timeBoundary, tradeoffs: mission.tradeoffs,
      successEvidence: mission.successEvidence, milestones: mission.milestones, keyPath: mission.keyPath,
      dependencies: mission.dependencies, risk: mission.risk, boundaries: mission.boundaries,
      resources: mission.resources, humanAgentSplit: mission.humanAgentSplit, retrospect: mission.retrospect,
    })),
    annotations: annotations.annotations, revisions: annotations.revisions,
    href: `/mission-cards/${cardId}`,
  };
}
