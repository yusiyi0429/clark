import type { TMeetingCardPayload, TResearchDoc, TWeeklyProgressResponse } from "@warmap/contracts";
import type { Query } from "./meetingStore.js";
import type { MemoryPerson } from "./companyMemory.js";
import { getIssueRow, listPendingIssueCards, projectIssueCard } from "./issues.js";
import { getMeetingRow, hasPendingStrategicItem, listMeetingRows, projectMeetingCard } from "./meetingStore.js";
import { companyPeriod, getMonthlyPlanNotice } from "./monthlyPlans.js";
import { listMissionRoundCards, listMissionRoundDraftCards } from "./missionRounds.js";
import { readMissionCardForAgent } from "./mcpMissionCards.js";
import { loadWeeklyProgress, weekRange } from "./weeklyProgress.js";

type Context = { q: Query; secret: string; now: Date; names: Map<string, string>; people: MemoryPerson[];
  personId: string; draftDir?: string };
const short = (value: string, max = 600) => value.length > max ? `${value.slice(0, max)}…` : value;

/** 与 CEO 首页同源的待处理投影，只摘可读字段；Card actions 从不进入 MCP 结果。 */
export async function listPending(ctx: Context) {
  const period = companyPeriod(ctx.now);
  const person = { personId: ctx.personId, role: "ceo" as const };
  const [issues, meetingRows, monthly, rounds, draftSlots] = await Promise.all([
    listPendingIssueCards(ctx.q, ctx.secret), listMeetingRows(ctx.q), getMonthlyPlanNotice(ctx.q, ctx.secret, ctx.now),
    listMissionRoundCards(ctx.q, ctx.people, ctx.secret, person, undefined, ctx.now),
    listMissionRoundDraftCards(ctx.q, ctx.people, ctx.secret, person, period, ctx.now, ctx.draftDir),
  ]);
  const issueItems = issues.map((card) => {
    const payload = card.payload as { urgency: { level: string; decisionBy?: string }; status: string };
    return { kind: card.kind, id: card.objectRef.id, title: card.title, urgency: payload.urgency.level,
      status: payload.status, at: payload.urgency.decisionBy ?? null, href: `/issues/${card.objectRef.id}` };
  });
  const meetingItems = meetingRows.filter((row) => row.status === "scheduled" || hasPendingStrategicItem(row.outcome)).map((row) => ({
    kind: "meeting", id: row.id, title: row.title, urgency: null, status: row.status === "scheduled" ? "待开会" : "会后条目待确认",
    at: row.scheduled_at.toISOString(), href: `/meetings/${row.id}`,
  }));
  const monthlyItems = monthly && (monthly.payload as { status?: string }).status !== "confirmed" ? [{
    kind: monthly.kind, id: monthly.objectRef.id, title: monthly.title, urgency: null,
    status: "月度计划待签发", at: null, href: `/plans/${period}`,
  }] : [];
  const roundItems = [...rounds, ...draftSlots].map((card) => {
    const payload = card.payload as { todo?: string | null; closesAt?: string | null };
    return { kind: card.kind, id: card.objectRef.id, title: card.title, urgency: null,
      status: payload.todo ?? "任务卡待处理", at: payload.closesAt ?? null,
      href: card.navigation?.[0]?.href ?? "/" };
  });
  return { items: [...issueItems, ...meetingItems, ...monthlyItems, ...roundItems] };
}

export async function getIssue(ctx: Context, issueId: string) {
  const row = await getIssueRow(ctx.q, issueId);
  if (!row) return null;
  const card = projectIssueCard(row, ctx.secret);
  const doc = row.research.doc as TResearchDoc | null | undefined;
  const activeReceipt = [...row.receipts].reverse().find((receipt) => !receipt.revokedAt);
  const meetings = (await listMeetingRows(ctx.q)).filter((meeting) => meeting.issue_ids.includes(issueId));
  const location = row.location;
  const locationId = location.level === "battlefield" ? location.battlefieldId : location.level === "capability" ? location.capabilityId : null;
  const config = locationId && location.level !== "company" ? (await ctx.q(`SELECT name FROM ${location.level === "battlefield" ? "battlefield_config" : "capability_config"} WHERE id=$1`, [locationId])).rows[0] : null;
  const related = location.level === "company" && location.relatedBattlefieldIds.length
    ? (await ctx.q("SELECT id,name FROM battlefield_config WHERE id=ANY($1::text[])", [location.relatedBattlefieldIds])).rows as { id: string; name: string }[] : [];
  return { id: issueId, title: card.title, location: { ...location, name: config?.name ?? null,
    relatedBattlefields: location.level === "company" ? location.relatedBattlefieldIds.map((id) =>
      ({ id, name: related.find((item) => item.id === id)?.name ?? id })) : [] }, urgency: row.urgency,
    status: row.status, currentJudgment: activeReceipt?.decisionText ?? doc?.summary ?? null,
    candidatePaths: doc?.options.map((option) => ({ label: option.label, consequences: option.consequences.map((text) => short(text)) })) ?? [],
    research: { status: row.research.status, summary: doc ? short(doc.summary) : null,
      evidence: doc?.evidence.slice(0, 5).map((item) => ({ quote: short(item.quote), sourceTitle: item.sourceTitle })) ?? [],
      unknowns: doc?.unknowns.slice(0, 5).map((item) => short(item)) ?? [] },
    meetings: meetings.map((meeting) => ({ id: meeting.id, title: meeting.title, scheduledAt: meeting.scheduled_at.toISOString(),
      status: meeting.status, href: `/meetings/${meeting.id}` })), href: `/issues/${issueId}` };
}

export async function getMeeting(ctx: Context, meetingId: string) {
  const row = await getMeetingRow(ctx.q, meetingId);
  if (!row) return null;
  const card = projectMeetingCard(row, ctx.secret);
  const payload = card.payload as TMeetingCardPayload;
  return { id: meetingId, title: card.title, scheduledAt: payload.scheduledAt, endsAt: payload.endsAt,
    endedAt: payload.endedAt, host: ctx.names.get(payload.leadDriId) ?? payload.leadDriId,
    participants: payload.participants.map((person) => ({ personId: person.personId, displayName: person.displayName })),
    status: payload.status, preflight: { status: payload.preflight.status, brief: short(payload.preflight.brief),
      readiness: payload.preflight.readiness ?? null,
      summary: payload.preflight.summary ? { criticalIssue: short(payload.preflight.summary.criticalIssue),
        priorityAction: short(payload.preflight.summary.priorityAction) } : null },
    agenda: payload.preflight.entries.filter((entry) => entry.kind === "agenda" || entry.kind === "meeting_question")
      .map((entry) => ({ title: entry.title, body: short(payload.draft.editsByEntryId[entry.id] ?? entry.body) })),
    outcome: payload.outcome ? { status: payload.outcome.status, summary: short(payload.outcome.summary),
      items: payload.outcome.items.map((item) => ({ kind: item.kind, text: short(item.text), status: item.review?.status ?? "open" })) } : null,
    href: `/meetings/${meetingId}` };
}

export async function getMissionCard(ctx: Context, cardId: string) {
  return readMissionCardForAgent(ctx.q, ctx.people, ctx.secret,
    { personId: ctx.personId, role: "ceo" }, cardId, ctx.now);
}

type TaskScope = { id: string; status: "not_started" | "in_progress" | "done" | "returned";
  owner_id: string; battlefield_id: string | null; battlefield_name: string | null };
export async function companyProgress(ctx: Context, filters: { week?: string; battlefieldId?: string; personId?: string }) {
  const range = weekRange(filters.week, ctx.now);
  const [weekly, rows, battlefields] = await Promise.all([
    loadWeeklyProgress(ctx.q, range, ctx.names),
    ctx.q(`SELECT t.id::text,t.status,t.owner_id,r.battlefield_id,b.name AS battlefield_name FROM tasks t
      LEFT JOIN missions m ON m.id=t.mission_id
      LEFT JOIN personal_mission_cards c ON c.id=m.personal_mission_card_id
      LEFT JOIN mission_rounds r ON r.id=c.round_id
      LEFT JOIN battlefield_config b ON b.id=r.battlefield_id`),
    ctx.q("SELECT id,name FROM battlefield_config ORDER BY sort_order,code,id"),
  ]);
  const scopes = rows.rows as TaskScope[];
  const byTask = new Map(scopes.map((row) => [row.id, row]));
  const people: TWeeklyProgressResponse["people"] = weekly.people
    .filter((person) => !filters.personId || person.personId === filters.personId)
    .map((person) => ({ ...person, items: person.items.filter((item) =>
      !filters.battlefieldId || byTask.get(item.itemId)?.battlefield_id === filters.battlefieldId) }))
    .filter((person) => person.items.length > 0);
  const counts = new Map<string | null, { battlefieldId: string | null; battlefieldName: string; not_started: number;
    in_progress: number; done: number; returned: number }>();
  for (const battlefield of battlefields.rows as { id: string; name: string }[]) {
    if (!filters.battlefieldId || filters.battlefieldId === battlefield.id) counts.set(battlefield.id,
      { battlefieldId: battlefield.id, battlefieldName: battlefield.name, not_started: 0, in_progress: 0, done: 0, returned: 0 });
  }
  for (const row of scopes) {
    if (filters.battlefieldId && row.battlefield_id !== filters.battlefieldId || filters.personId && row.owner_id !== filters.personId) continue;
    const key = row.battlefield_id;
    let group = counts.get(key);
    if (!group) {
      group = { battlefieldId: key, battlefieldName: row.battlefield_name ?? "未归属", not_started: 0, in_progress: 0, done: 0, returned: 0 };
      counts.set(key, group);
    }
    group[row.status]++;
  }
  return { week: weekly.week, from: weekly.from, to: weekly.to, people, statusByBattlefield: [...counts.values()]
    .sort((a, b) => a.battlefieldName.localeCompare(b.battlefieldName, "zh-CN")) };
}
