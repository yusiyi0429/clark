import type {
  TDecisionHistoryChange,
  TDecisionHistoryEntry,
  TDecisionHistoryPending,
  TDecisionHistoryPerson,
  TDecisionHistorySource,
  TIssueDecisionHistory,
  TMeetingDecisionHistoryResponse,
  TMeetingOutcomeItem,
  TMeetingOutcomeState,
  TIssueLocation,
} from "@warmap/contracts";
import type { IssueReceiptRow, IssueResearch } from "./issues.js";
import { decisionRef, discussionRef, groupMaterialRef } from "./meetingEvidence.js";
import { UUID_PATTERN, type Query } from "./meetingStore.js";
import { canAccessObjectMaterials, type MaterialViewer } from "./objectMaterials.js";
import { isActiveMember, type ThreadRef } from "./threads.js";

/**
 * 议题有效历史分层（feedback 9 / H05）。
 *
 * - effective：仍有效的已确认决定。来源有三种：issue.decide/decide_override 产生的 Issue Receipt、
 *   会后 decision 确认产生的 Receipt（带会议条目、逐字稿 turn 与原话）、客户包导入的历史决定
 *   （issue_decision_history，原始纪要出处）。另含会后已确认、指向本议题的 CEO 判断（kind=judgment）。
 * - inactive：已撤回（Receipt.revokedAt / 导入 revoked）或被替代（导入 superseded）的决定，只供审计，
 *   不得当作约束。
 * - changes：最早一条仍有效决定之后、有日期和出处的执行事实：本议题战场的月度阶段反馈、
 *   本议题及相关会议的群讨论（带导入的发言性质）、群材料修订、客户资料导入的执行/外部事实、战场外部信号。没有就明确写“未获得执行证据（待补）”，不推断完成率。
 * - pending：本次待判断的议题本身和会后尚未确认的 decision 候选，明确不是决定。
 *
 * 检索按议题 id 关联所有相关会议（不限一场）与全部 Receipt/导入决定；权限沿原生规则：
 * 群讨论要求 viewer 是群成员，材料修订走 canAccessObjectMaterials。
 */

export const DECISION_HISTORY_CHANGES_MAX = 30;
export const DECISION_HISTORY_SIGNALS_MAX = 5;
export const NO_EXECUTION_EVIDENCE = "决定之后未获得执行证据（待补），不推断完成情况。";
export const NO_EFFECTIVE_DECISION = "暂无仍有效的已确认决定，执行变化不单独列出。";
export const PENDING_ISSUE_NOTE = "本次待判断，尚未形成决定。";
export const PENDING_CANDIDATE_NOTE = "会后候选尚未经 CEO 确认，不是决定。";

type IssueSqlRow = {
  id: string; title: string; status: "pending" | "decided" | "dismissed"; location: TIssueLocation;
  research: IssueResearch; receipts: IssueReceiptRow[]; created_at: Date;
};
type MeetingSqlRow = {
  id: string; title: string; status: string; scheduled_at: Date; issue_ids: string[]; outcome: TMeetingOutcomeState | null;
};
type HistorySqlRow = {
  id: string; external_id: string; decided_at: Date; decided_by: string; decision_text: string; option_label: string | null;
  source_ref: string; meeting_id: string | null; status: "effective" | "superseded" | "revoked"; superseded_by: string | null;
  status_at: Date | null; status_reason: string | null; revoked_by: string | null;
};

export type DecisionHistoryOptions = {
  names: Map<string, string>;
  /** 产品内唯一的 CEO；Issue 决定与会后确认都只能由 CEO 执行。 */
  ceo?: { personId: string; displayName: string } | null;
};

const iso = (value: Date | string) => (value instanceof Date ? value : new Date(value)).toISOString();

function battlefieldsOf(location: TIssueLocation): string[] {
  if (location.level === "battlefield") return [location.battlefieldId];
  if (location.level === "company") return location.relatedBattlefieldIds;
  return [];
}

/** 会后条目指向的议题：显式 issueId 优先，否则只有单一关联议题时无歧义（与 decisionIssueId 同规则）。 */
function itemTargetsIssue(meeting: MeetingSqlRow, item: TMeetingOutcomeItem, issueId: string): boolean {
  return (item.issueId ?? (meeting.issue_ids.length === 1 ? meeting.issue_ids[0] : null)) === issueId;
}

function researchOptions(research: IssueResearch | null | undefined): { id: string; label: string }[] {
  const doc = research?.status === "ready" ? research.doc as { options?: { id: string; label: string }[] } | undefined : undefined;
  return (doc?.options ?? []).map((option) => ({ id: option.id, label: option.label }));
}

function meetingSource(meeting: MeetingSqlRow | undefined, item: TMeetingOutcomeItem | undefined, meetingId: string, outcomeItemId?: string): TDecisionHistorySource {
  return {
    kind: "meeting-item",
    meetingId,
    ...(meeting ? { meetingTitle: meeting.title, meetingAt: iso(meeting.scheduled_at) } : {}),
    ...(outcomeItemId ? { outcomeItemId } : {}),
    ...(item ? { turnId: item.turnId, quote: item.quote } : {}),
  };
}

export async function issueDecisionHistory(
  q: Query,
  issueId: string,
  viewer: MaterialViewer,
  options: DecisionHistoryOptions,
): Promise<TIssueDecisionHistory | null> {
  if (!UUID_PATTERN.test(issueId)) return null;
  const issue = (await q(
    "SELECT id::text AS id, title, status, location, research, receipts, created_at FROM issues WHERE id = $1",
    [issueId],
  )).rows[0] as IssueSqlRow | undefined;
  if (!issue) return null;
  const person = (personId: string | null | undefined): TDecisionHistoryPerson | null =>
    personId ? { personId, displayName: options.names.get(personId) ?? personId } : null;
  const ceo: TDecisionHistoryPerson | null = options.ceo ? { personId: options.ceo.personId, displayName: options.ceo.displayName } : null;

  const imported = (await q(
    `SELECT id::text AS id, external_id, decided_at, decided_by, decision_text, option_label, source_ref, meeting_id::text AS meeting_id,
            status, superseded_by, status_at, status_reason, revoked_by
       FROM issue_decision_history WHERE issue_id = $1 ORDER BY decided_at, id`,
    [issueId],
  )).rows as HistorySqlRow[];

  // 所有相关会议：会议议程含本议题，或某条 Receipt / 导入决定出自该会议。
  const referencedMeetingIds = [
    ...issue.receipts.flatMap((receipt) => receipt.source?.kind === "meeting-item" ? [receipt.source.meetingId] : []),
    ...imported.flatMap((row) => row.meeting_id ? [row.meeting_id] : []),
  ].filter((id) => UUID_PATTERN.test(id));
  const meetings = (await q(
    `SELECT id::text AS id, title, status, scheduled_at, issue_ids, outcome FROM meetings
      WHERE status <> 'cancelled' AND (issue_ids ? $1 OR id = ANY($2::uuid[]))
      ORDER BY scheduled_at, id`,
    [issueId, referencedMeetingIds],
  )).rows as MeetingSqlRow[];
  const meetingById = new Map(meetings.map((meeting) => [meeting.id, meeting]));

  const entries: TDecisionHistoryEntry[] = [];
  const docOptions = researchOptions(issue.research);
  for (const receipt of issue.receipts) {
    const confirmedVia: TDecisionHistoryEntry["confirmedVia"] = receipt.actionType === "meeting.confirm_item"
      ? "meeting.confirm_item" : receipt.actionType === "issue.decide_override" ? "issue.decide_override" : "issue.decide";
    let source: TDecisionHistorySource = { kind: "issue-receipt", receiptId: receipt.id };
    const sourceRefs = [decisionRef(receipt.id)];
    if (receipt.source?.kind === "meeting-item") {
      const meeting = meetingById.get(receipt.source.meetingId);
      const item = meeting?.outcome?.items.find((candidate) => candidate.id === receipt.source!.outcomeItemId);
      source = { ...meetingSource(meeting, item, receipt.source.meetingId, receipt.source.outcomeItemId), receiptId: receipt.id };
      sourceRefs.push(`meeting:${receipt.source.meetingId}`, `transcript:${receipt.source.meetingId}`);
    } else {
      sourceRefs.push(`issue:${issue.id}`);
    }
    // 只有决定时的预研仍是当前这一份，选项文字才可信；预研重跑后只保留选项 id。
    const sameResearch = !receipt.researchRunId || receipt.researchRunId === issue.research.runId;
    const option = receipt.optionId
      ? { id: receipt.optionId, label: sameResearch ? docOptions.find((candidate) => candidate.id === receipt.optionId)?.label ?? null : null }
      : null;
    entries.push({
      ref: decisionRef(receipt.id),
      issueId: issue.id,
      kind: "decision",
      text: receipt.decisionText,
      decidedAt: iso(receipt.createdAt),
      decidedBy: ceo,
      confirmedVia,
      option,
      status: receipt.revokedAt ? "revoked" : "effective",
      statusAt: receipt.revokedAt ? iso(receipt.revokedAt) : null,
      statusReason: receipt.revokedAt ? receipt.revokeReason ?? null : null,
      supersededBy: null,
      revokedBy: null,
      source,
      sourceRefs,
    });
  }
  for (const row of imported) {
    const meeting = row.meeting_id ? meetingById.get(row.meeting_id) : undefined;
    entries.push({
      ref: decisionRef(row.id),
      issueId: issue.id,
      kind: "decision",
      text: row.decision_text,
      decidedAt: iso(row.decided_at),
      decidedBy: person(row.decided_by),
      confirmedVia: "imported",
      option: row.option_label ? { id: null, label: row.option_label } : null,
      status: row.status,
      statusAt: row.status_at ? iso(row.status_at) : null,
      statusReason: row.status_reason,
      supersededBy: row.superseded_by ? decisionRef(row.superseded_by) : null,
      revokedBy: row.revoked_by ? decisionRef(row.revoked_by) : null,
      source: {
        kind: "imported",
        importedRef: row.source_ref,
        ...(row.meeting_id ? { meetingId: row.meeting_id } : {}),
        ...(meeting ? { meetingTitle: meeting.title, meetingAt: iso(meeting.scheduled_at) } : {}),
      },
      sourceRefs: [decisionRef(row.id), ...(row.meeting_id ? [`meeting:${row.meeting_id}`] : [])],
    });
  }

  const pending: TDecisionHistoryPending[] = [];
  if (issue.status === "pending") {
    pending.push({ ref: `issue:${issue.id}`, kind: "issue_pending", text: issue.title, at: iso(issue.created_at),
      options: docOptions, source: null, note: PENDING_ISSUE_NOTE });
  }
  for (const meeting of meetings) {
    if (meeting.status !== "held" && meeting.status !== "reviewed") continue;
    if (meeting.outcome?.status !== "ready") continue;
    for (const item of meeting.outcome.items) {
      if (!itemTargetsIssue(meeting, item, issue.id)) continue;
      if (item.kind === "ceoJudgment" && item.review?.status === "confirmed") {
        // 会后已确认的 CEO 判断只留在 MeetingOutcome：同样是确认过的立场，归入有效层，但标为 judgment。
        entries.push({
          ref: `outcome:${meeting.id}#${item.id}`,
          issueId: issue.id,
          kind: "judgment",
          text: item.text,
          decidedAt: iso(meeting.scheduled_at),
          decidedBy: ceo,
          confirmedVia: "meeting.confirm_item",
          option: null,
          status: "effective",
          statusAt: null,
          statusReason: null,
          supersededBy: null,
          revokedBy: null,
          source: meetingSource(meeting, item, meeting.id, item.id),
          sourceRefs: [`outcome:${meeting.id}#${item.id}`, `meeting:${meeting.id}`, `transcript:${meeting.id}`],
        });
      } else if (item.kind === "decision" && item.review?.status === "pending") {
        pending.push({ ref: `outcome:${meeting.id}#${item.id}`, kind: "outcome_candidate", text: item.text, at: iso(meeting.scheduled_at),
          options: [], source: meetingSource(meeting, item, meeting.id, item.id), note: PENDING_CANDIDATE_NOTE });
      }
    }
  }

  entries.sort((a, b) => a.decidedAt.localeCompare(b.decidedAt) || a.ref.localeCompare(b.ref));
  const effective = entries.filter((entry) => entry.status === "effective");
  const inactive = entries.filter((entry) => entry.status !== "effective");
  const changesSince = effective[0]?.decidedAt ?? null;
  const changes = changesSince
    ? await executionChanges(q, issue, meetings, viewer, changesSince, person)
    : [];
  return {
    issueId: issue.id,
    issueTitle: issue.title,
    issueStatus: issue.status,
    effective,
    changes,
    changesSince,
    changesNote: !changesSince ? NO_EFFECTIVE_DECISION : changes.length ? null : NO_EXECUTION_EVIDENCE,
    pending,
    inactive,
    relatedMeetings: meetings.map((meeting) => ({ id: meeting.id, title: meeting.title, status: meeting.status, scheduledAt: iso(meeting.scheduled_at) })),
  };
}

async function executionChanges(
  q: Query,
  issue: IssueSqlRow,
  meetings: MeetingSqlRow[],
  viewer: MaterialViewer,
  since: string,
  person: (personId: string | null | undefined) => TDecisionHistoryPerson | null,
): Promise<TDecisionHistoryChange[]> {
  const changes: TDecisionHistoryChange[] = [];
  const sinceTime = Date.parse(since);
  const battlefields = battlefieldsOf(issue.location);

  // 1. 战场月度阶段反馈（DRI 叙述，带 observedAt 与来源）。
  if (battlefields.length) {
    const plans = (await q("SELECT period, negotiation FROM monthly_plans ORDER BY period")).rows as {
      period: string; negotiation: { feedback?: { id: string; battlefieldId?: string; text: string; evidenceRef?: string; observedAt: string; sourceRef: string }[] };
    }[];
    for (const plan of plans) {
      for (const feedback of plan.negotiation?.feedback ?? []) {
        if (!feedback.battlefieldId || !battlefields.includes(feedback.battlefieldId)) continue;
        if (!(Date.parse(feedback.observedAt) > sinceTime)) continue;
        changes.push({ ref: `feedback:${feedback.id}`, kind: "monthly_feedback", at: iso(feedback.observedAt), text: feedback.text, author: null,
          sourceRef: feedback.evidenceRef ? `${feedback.sourceRef}；证据：${feedback.evidenceRef}` : feedback.sourceRef });
      }
    }
  }

  // 2/3. 本议题及相关会议的群讨论与群材料修订，按原生权限读取。
  const objects: (ThreadRef & { title: string })[] = [
    { objectType: "issue", objectId: issue.id, title: issue.title },
    ...meetings.map((meeting) => ({ objectType: "meeting" as const, objectId: meeting.id, title: meeting.title })),
  ];
  for (const ref of objects) {
    if (await isActiveMember(q, ref, viewer.personId)) {
      const messages = (await q(
        `SELECT id, author_id, content, stance, created_at FROM thread_messages
          WHERE object_type = $1 AND object_id = $2 AND kind = 'member' AND created_at > $3 ORDER BY id`,
        [ref.objectType, ref.objectId, since],
      )).rows as { id: string | number; author_id: string; content: string; stance: string | null; created_at: Date }[];
      for (const message of messages) {
        changes.push({ ref: discussionRef(Number(message.id)), kind: "discussion", at: iso(message.created_at), text: message.content,
          author: person(message.author_id), sourceRef: `${ref.objectType === "issue" ? "议题" : "会议"}群讨论 · ${ref.title}`,
          ...(message.stance ? { stance: message.stance } : {}) });
      }
    }
    if (await canAccessObjectMaterials(q, ref, viewer)) {
      const revisions = (await q(
        `SELECT m.id::text AS id, m.file_name, m.owner_id, r.version, r.requested_by, r.summary, r.created_at
           FROM object_materials m JOIN material_revisions r ON r.material_id = m.id
          WHERE m.object_type = $1 AND m.object_id = $2 AND m.deleted_at IS NULL AND r.created_at > $3
          ORDER BY r.created_at, r.version`,
        [ref.objectType, ref.objectId, since],
      )).rows as { id: string; file_name: string; owner_id: string; version: number; requested_by: string | null; summary: string | null; created_at: Date }[];
      for (const revision of revisions) {
        const text = revision.version === 1
          ? `上传《${revision.file_name}》`
          : `《${revision.file_name}》更新到 v${revision.version}${revision.summary ? `：${revision.summary}` : ""}`;
        changes.push({ ref: groupMaterialRef(revision.id, revision.version), kind: "material_revision", at: iso(revision.created_at), text,
          author: person(revision.requested_by ?? revision.owner_id), sourceRef: `${ref.objectType === "issue" ? "议题" : "会议"}群材料 · ${ref.title}` });
      }
    }
  }

  // 4. 客户资料导入的执行/外部事实（issue_execution_facts）：有日期与出处，关联到哪些历史决定。
  const facts = (await q(
    `SELECT id::text AS id, occurred_at, fact_text, source_ref, nature, related_decision_ids FROM issue_execution_facts
      WHERE issue_id = $1 AND occurred_at > $2 ORDER BY occurred_at, id`,
    [issue.id, since],
  )).rows as { id: string; occurred_at: Date; fact_text: string; source_ref: string; nature: "execution" | "external"; related_decision_ids: string[] }[];
  for (const fact of facts) {
    changes.push({ ref: `fact:${fact.id}`, kind: "execution_fact", at: iso(fact.occurred_at),
      text: fact.nature === "external" ? `外部事实：${fact.fact_text}` : fact.fact_text, author: null, sourceRef: fact.source_ref,
      ...(fact.related_decision_ids.length ? { relatedDecisionRefs: fact.related_decision_ids } : {}) });
  }

  // 5. 本议题战场的外部信号：只取决定之后最近几条，标为外部信号，不当作执行结果。
  if (battlefields.length) {
    const signals = (await q(
      `SELECT id::text AS id, source_title, summary, published_at FROM signals
        WHERE location->>'type' = 'battlefield' AND location->>'id' = ANY($1::text[]) AND published_at > $2
        ORDER BY published_at DESC LIMIT ${DECISION_HISTORY_SIGNALS_MAX}`,
      [battlefields, since],
    )).rows as { id: string; source_title: string; summary: string; published_at: Date }[];
    for (const signal of signals) {
      changes.push({ ref: `signal:${signal.id}`, kind: "signal", at: iso(signal.published_at), text: `外部信号：${signal.summary}`, author: null,
        sourceRef: signal.source_title });
    }
  }

  changes.sort((a, b) => a.at.localeCompare(b.at) || a.ref.localeCompare(b.ref));
  return changes.slice(-DECISION_HISTORY_CHANGES_MAX);
}

/** 一场会议每个关联议题的历史分层，顺序同会议 issue_ids。 */
export async function meetingDecisionHistory(
  q: Query,
  meetingId: string,
  viewer: MaterialViewer,
  options: DecisionHistoryOptions,
): Promise<TMeetingDecisionHistoryResponse | null> {
  if (!UUID_PATTERN.test(meetingId)) return null;
  const meeting = (await q("SELECT id::text AS id, issue_ids FROM meetings WHERE id = $1", [meetingId])).rows[0] as { id: string; issue_ids: string[] } | undefined;
  if (!meeting) return null;
  const issues: TIssueDecisionHistory[] = [];
  for (const issueId of meeting.issue_ids) {
    const history = await issueDecisionHistory(q, issueId, viewer, options);
    if (history) issues.push(history);
  }
  return { meetingId: meeting.id, issues };
}
