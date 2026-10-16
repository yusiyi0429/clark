import type { TIssueLocation, TMeetingOutcomeItem, TMeetingOutcomeState } from "@warmap/contracts";
import { decisionRef } from "./meetingEvidence.js";
import type { IssueReceiptRow } from "./issues.js";
import type { Query } from "./meetingStore.js";

/**
 * 预审对照的历史：近期会议与同一战场的已确认决定（v4）。
 *
 * 原来只按「共享议题」找最近一场已开的会；没有挂议题的战略会（如 7/12 词元云集业务战略会）因此接不上。
 * 现在按两条路径找，再按会议 id 去重：
 * 1. 共享议题：已开的会里挂了本次会议的任一议题；
 * 2. 同一战场或单元：本次会议议题所在的战场（议题挂战场，或集团级议题关联的战场）与单元（能力），
 *    已开的会里挂的议题在这些战场 / 单元下，或会后条目的作用范围写了这些战场，
 *    或会议没挂议题、也没写作用范围，但主持人是该战场的负责人。
 *
 * 会后条目按确认状态分两层：confirmed 是一号位确认过的决定，是本次判断的约束；
 * 其余（pending）是会后候选，尚未经一号位确认，只能写成「待确认」，不能当约束。
 * 同一战场里其他议题的有效决定（回执与导入的历史决定）另列，作为战场层面的约束。
 */

export type RelatedMatch = "shared_issue" | "battlefield" | "unit";

export type RelatedDecision = { ref: string; text: string; quote?: string; parentRef?: string };

export type PreflightRelatedMeeting = {
  id: string;
  title: string;
  status: "held" | "reviewed";
  scheduledAt: string;
  matchedBy: RelatedMatch[];
  /** 会后纪要的一句话总结；没有会后结论时为 null。 */
  summary: string | null;
  /** 一号位已确认的会后决定：本次判断的约束。 */
  confirmedDecisions: RelatedDecision[];
  /** 会后候选，尚未经一号位确认：只能写成待确认，不是决定。 */
  pendingDecisions: RelatedDecision[];
  /** 逐字稿（只给最近两场，超长截断）。 */
  transcript: unknown;
  transcriptTruncated: boolean;
  sourceRefs: string[];
};

export type BattlefieldDecision = {
  ref: string;
  issueId: string;
  issueTitle: string;
  text: string;
  decidedAt: string;
  via: "issue_receipt" | "imported";
};

export type PreflightHistoryScope = { battlefieldIds: string[]; unitIds: string[] };

/** 最近多少天内的会算「近期」。 */
export const RELATED_MEETING_WINDOW_DAYS = 180;
/** 最多对照几场会。 */
export const RELATED_MEETING_MAX = 3;
/** 带逐字稿的场数与每场逐字稿字数上限。 */
export const RELATED_TRANSCRIPT_MEETINGS = 2;
export const RELATED_TRANSCRIPT_MAX_CHARS = 20_000;
/** 同一战场其他议题的有效决定最多带几条。 */
export const BATTLEFIELD_DECISIONS_MAX = 10;

/** 议题位置 → 战场与单元。集团级议题按它关联的战场算。 */
export function historyScope(locations: unknown[]): PreflightHistoryScope {
  const battlefields = new Set<string>();
  const units = new Set<string>();
  for (const raw of locations) {
    const location = raw as TIssueLocation | null;
    if (!location || typeof location !== "object") continue;
    if (location.level === "battlefield" && location.battlefieldId) battlefields.add(location.battlefieldId);
    if (location.level === "company") for (const id of location.relatedBattlefieldIds ?? []) battlefields.add(id);
    if (location.level === "capability" && location.capabilityId) units.add(location.capabilityId);
  }
  return { battlefieldIds: [...battlefields], unitIds: [...units] };
}

type MeetingSqlRow = {
  id: string; title: string; status: "held" | "reviewed"; scheduled_at: Date; issue_ids: string[];
  lead_dri_id: string; transcript: { turns?: unknown[] } | null; outcome: TMeetingOutcomeState | null;
};

const outcomeItems = (outcome: TMeetingOutcomeState | null): TMeetingOutcomeItem[] =>
  outcome && Array.isArray(outcome.items) ? outcome.items : [];

/** 逐字稿按轮截断到字数上限，保留开头的轮次。 */
function clipTranscript(transcript: MeetingSqlRow["transcript"]): { value: unknown; truncated: boolean } {
  if (!transcript || !Array.isArray(transcript.turns)) return { value: transcript ?? null, truncated: false };
  const kept: unknown[] = [];
  let used = 0;
  for (const turn of transcript.turns) {
    const size = JSON.stringify(turn).length;
    if (used + size > RELATED_TRANSCRIPT_MAX_CHARS) return { value: { ...transcript, turns: kept }, truncated: true };
    kept.push(turn);
    used += size;
  }
  return { value: transcript, truncated: false };
}

function decisionsOf(meetingId: string, items: TMeetingOutcomeItem[]): { confirmed: RelatedDecision[]; pending: RelatedDecision[] } {
  const confirmed: RelatedDecision[] = [];
  const pending: RelatedDecision[] = [];
  for (const item of items) {
    if (item.kind !== "decision" && item.kind !== "ceoJudgment" && item.kind !== "strategic") continue;
    const status = item.review?.status;
    if (status === "dismissed") continue;
    const decision: RelatedDecision = {
      ref: `outcome:${meetingId}#${item.id}`,
      text: item.text,
      ...(item.quote && item.quote !== item.text ? { quote: item.quote.slice(0, 300) } : {}),
      ...(item.parentItemId ? { parentRef: `outcome:${meetingId}#${item.parentItemId}` } : {}),
    };
    (status === "confirmed" ? confirmed : pending).push(decision);
  }
  return { confirmed, pending };
}

/**
 * 本次会议之前、近期内已开过的相关会议：共享议题或同一战场 / 单元，按时间倒序去重，最多 RELATED_MEETING_MAX 场。
 * 共享议题的最近一场一定在内（与旧行为一致）。
 */
export async function relatedMeetingsForPreflight(
  q: Query,
  meeting: { id: string; issue_ids: string[]; scheduled_at: Date },
  scope: PreflightHistoryScope,
  { now = new Date(), max = RELATED_MEETING_MAX }: { now?: Date; max?: number } = {},
): Promise<PreflightRelatedMeeting[]> {
  const before = meeting.scheduled_at.getTime() < now.getTime() ? meeting.scheduled_at : now;
  const since = new Date(before.getTime() - RELATED_MEETING_WINDOW_DAYS * 24 * 3600 * 1000);
  const rows = (await q(
    `SELECT m.id::text AS id, m.title, m.status, m.scheduled_at, m.issue_ids, m.lead_dri_id, m.transcript, m.outcome
       FROM meetings m
      WHERE m.id <> $1
        AND m.status IN ('held', 'reviewed')
        AND m.scheduled_at <= $2
        AND (
          m.issue_ids ?| $4::text[]
          OR (m.scheduled_at >= $3 AND (
            EXISTS (
              SELECT 1 FROM issues i
               WHERE i.id::text IN (SELECT jsonb_array_elements_text(m.issue_ids))
                 AND ((i.location->>'level' = 'battlefield' AND i.location->>'battlefieldId' = ANY($5::text[]))
                   OR (i.location->>'level' = 'company' AND i.location->'relatedBattlefieldIds' ?| $5::text[])
                   OR (i.location->>'level' = 'capability' AND i.location->>'capabilityId' = ANY($6::text[])))
            )
            OR EXISTS (
              SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(m.outcome->'items') = 'array' THEN m.outcome->'items' ELSE '[]'::jsonb END) item
               WHERE item->'scope'->'battlefieldIds' ?| $5::text[]
            )
            OR (jsonb_array_length(m.issue_ids) = 0
              AND m.lead_dri_id IN (SELECT owner_id FROM battlefield_config WHERE id = ANY($5::text[]) AND owner_id <> ''))
          ))
        )
      ORDER BY m.scheduled_at DESC, m.id
      LIMIT 20`,
    [meeting.id, before, since, meeting.issue_ids, scope.battlefieldIds, scope.unitIds],
  )).rows as MeetingSqlRow[];
  if (!rows.length) return [];

  // 每场会挂的议题落在哪些战场 / 单元：用来写明「为什么找到它」。
  const issueIds = [...new Set(rows.flatMap((row) => row.issue_ids))];
  const locations = new Map<string, unknown>(issueIds.length
    ? ((await q("SELECT id::text AS id, location FROM issues WHERE id::text = ANY($1::text[])", [issueIds])).rows as { id: string; location: unknown }[])
      .map((row) => [row.id, row.location])
    : []);
  const owners = new Set(scope.battlefieldIds.length
    ? ((await q("SELECT owner_id FROM battlefield_config WHERE id = ANY($1::text[]) AND owner_id <> ''", [scope.battlefieldIds])).rows as { owner_id: string }[])
      .map((row) => row.owner_id)
    : []);
  const battlefields = new Set(scope.battlefieldIds);
  const units = new Set(scope.unitIds);

  const matched = rows.map((row) => {
    const matchedBy = new Set<RelatedMatch>();
    if (row.issue_ids.some((id) => meeting.issue_ids.includes(id))) matchedBy.add("shared_issue");
    const theirs = historyScope(row.issue_ids.map((id) => locations.get(id)));
    if (theirs.battlefieldIds.some((id) => battlefields.has(id))) matchedBy.add("battlefield");
    if (theirs.unitIds.some((id) => units.has(id))) matchedBy.add("unit");
    if (outcomeItems(row.outcome).some((item) => item.scope?.battlefieldIds.some((id) => battlefields.has(id)))) matchedBy.add("battlefield");
    if (!row.issue_ids.length && owners.has(row.lead_dri_id)) matchedBy.add("battlefield");
    return { row, matchedBy: [...matchedBy] };
  }).filter((item) => item.matchedBy.length > 0);

  const picked = matched.slice(0, max);
  const latestShared = matched.find((item) => item.matchedBy.includes("shared_issue"));
  if (latestShared && !picked.includes(latestShared)) picked.splice(max - 1, 1, latestShared);
  picked.sort((a, b) => b.row.scheduled_at.getTime() - a.row.scheduled_at.getTime());

  return picked.map(({ row, matchedBy }, index) => {
    const { confirmed, pending } = decisionsOf(row.id, outcomeItems(row.outcome));
    const withTranscript = index < RELATED_TRANSCRIPT_MEETINGS && Boolean(row.transcript);
    const clipped = withTranscript ? clipTranscript(row.transcript) : { value: null, truncated: false };
    return {
      id: row.id,
      title: row.title,
      status: row.status,
      scheduledAt: row.scheduled_at.toISOString(),
      matchedBy,
      summary: row.outcome?.status === "ready" && typeof row.outcome.summary === "string" ? row.outcome.summary : null,
      confirmedDecisions: confirmed,
      pendingDecisions: pending,
      transcript: clipped.value,
      transcriptTruncated: clipped.truncated,
      sourceRefs: [
        `meeting:${row.id}`,
        ...(withTranscript ? [`transcript:${row.id}`] : []),
        ...(row.outcome ? [`outcome:${row.id}`] : []),
        ...confirmed.map((decision) => decision.ref),
        ...pending.map((decision) => decision.ref),
      ],
    };
  });
}

type SiblingIssueRow = { id: string; title: string; receipts: IssueReceiptRow[] };
type ImportedDecisionRow = { id: string; issue_id: string; decision_text: string; decided_at: Date };

/**
 * 同一战场 / 单元里其他议题仍有效的决定（议题回执与导入的历史决定），按时间倒序最多 BATTLEFIELD_DECISIONS_MAX 条。
 * 本次会议自己的议题由 decisionHistory 负责，这里不重复。
 */
export async function battlefieldDecisionsForPreflight(
  q: Query,
  excludeIssueIds: string[],
  scope: PreflightHistoryScope,
): Promise<BattlefieldDecision[]> {
  if (!scope.battlefieldIds.length && !scope.unitIds.length) return [];
  const issues = (await q(
    `SELECT id::text AS id, title, receipts FROM issues
      WHERE NOT (id::text = ANY($1::text[]))
        AND ((location->>'level' = 'battlefield' AND location->>'battlefieldId' = ANY($2::text[]))
          OR (location->>'level' = 'company' AND location->'relatedBattlefieldIds' ?| $2::text[])
          OR (location->>'level' = 'capability' AND location->>'capabilityId' = ANY($3::text[])))`,
    [excludeIssueIds, scope.battlefieldIds, scope.unitIds],
  )).rows as SiblingIssueRow[];
  if (!issues.length) return [];
  const titles = new Map(issues.map((issue) => [issue.id, issue.title]));
  const out: BattlefieldDecision[] = [];
  for (const issue of issues) {
    for (const receipt of Array.isArray(issue.receipts) ? issue.receipts : []) {
      if (receipt.revokedAt) continue;
      out.push({ ref: decisionRef(receipt.id), issueId: issue.id, issueTitle: issue.title, text: receipt.decisionText,
        decidedAt: new Date(receipt.createdAt).toISOString(), via: "issue_receipt" });
    }
  }
  const imported = (await q(
    `SELECT id::text AS id, issue_id::text AS issue_id, decision_text, decided_at FROM issue_decision_history
      WHERE status = 'effective' AND issue_id::text = ANY($1::text[])`,
    [[...titles.keys()]],
  )).rows as ImportedDecisionRow[];
  for (const row of imported) {
    out.push({ ref: decisionRef(row.id), issueId: row.issue_id, issueTitle: titles.get(row.issue_id) ?? "", text: row.decision_text,
      decidedAt: row.decided_at.toISOString(), via: "imported" });
  }
  return out.sort((a, b) => b.decidedAt.localeCompare(a.decidedAt)).slice(0, BATTLEFIELD_DECISIONS_MAX);
}
