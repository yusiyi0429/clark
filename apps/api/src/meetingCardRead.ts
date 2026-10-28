import type { TCard, TMeetingActionItem, TMeetingCardConfirmation, TMeetingCardSync, TMeetingCardFrozenPayload, TMeetingCardKind } from "@warmap/contracts";
import { queryTokens } from "./company.js";
import { canReadMeetingCard, type Viewer } from "./meetingCard.js";
import { confirmedView, currentConfirmation } from "./meetingCardConfirm.js";
import { payloadHash } from "./meetingCardHash.js";
import { attendeesOf } from "./meetingDecisionView.js";
import { getMeetingRow, type MeetingRow, type Query } from "./meetingStore.js";
import { logEvent } from "./observability.js";

/**
 * 读会议的确认版（规格「提供给独立 Chat 的内部契约」、拍板 7、12）：
 * - 有会议卡的会只读当前确认版，读前核对 payloadHash；只有草稿时是 unconfirmed，草稿不算事实（FR-2）。
 * - 没有会议卡、会后整理已就绪的旧会议照旧格式（legacy）。
 * - 可读范围同会议卡：主持人、创建人、CEO、实际参会人；看不到的当不存在。
 */

/** 库里冻结的 payload 和确认时记下的摘要值对不上：不返回内容。 */
export class PayloadHashMismatchError extends Error {
  readonly code = "PAYLOAD_HASH_MISMATCH";
  constructor(meetingId: string) {
    super(`会议 ${meetingId} 的确认版正文和摘要值对不上`);
  }
}

type ConfirmedMeeting = { status: "confirmed"; kind: TMeetingCardKind; payload: TMeetingCardFrozenPayload; confirmation: TMeetingCardConfirmation; syncReceipt: TMeetingCardSync };
type CardRead = ConfirmedMeeting | { status: "unconfirmed" };
export type ConfirmedMeetingRead = CardRead | { status: "legacy"; summary: string; items: { kind: string; text: string; status: string }[] };

/** 有会议卡行的会：当前确认版（摘要值对不上抛 PayloadHashMismatchError）或未确认；没有会议卡行返回 null。不看可读范围。 */
async function readCard(q: Query, meetingId: string): Promise<CardRead | null> {
  if (!(await q("SELECT 1 FROM meeting_cards WHERE meeting_id = $1", [meetingId])).rowCount) return null;
  const current = await currentConfirmation(q, meetingId);
  if (!current) return { status: "unconfirmed" };
  if (payloadHash(current.payload) !== current.confirmation.payloadHash) throw new PayloadHashMismatchError(meetingId);
  return { status: "confirmed", kind: current.kind, payload: current.payload, confirmation: current.confirmation, syncReceipt: confirmedView(current).sync! };
}

/** 一场会的确认版；看不到或不存在返回 null。 */
export async function readConfirmedMeeting(q: Query, viewer: Viewer, meetingId: string): Promise<ConfirmedMeetingRead | null> {
  const meeting = await getMeetingRow(q, meetingId);
  if (!meeting || !canReadMeetingCard(meeting, viewer)) return null;
  const card = await readCard(q, meetingId);
  if (card) return card;
  const outcome = meeting.outcome;
  return outcome?.status === "ready"
    ? { status: "legacy", summary: outcome.summary, items: outcome.items.map((item) => ({ kind: item.kind, text: item.text, status: item.review?.status ?? "open" })) }
    : { status: "unconfirmed" };
}

const CATALOG_LIMIT = 5;
/** 每场会最多给几段命中的原文；段落超过 SNIPPET_MAX 字时只给命中词附近。 */
const MATCHES_PER_MEETING = 3;
const SNIPPET_MAX = 200;
const SNIPPET_BEFORE = 60;
export type ConfirmedMeetingFilter = { query?: string; from?: string; to?: string; participantId?: string; limit?: number };
type CatalogRow = Pick<MeetingRow, "id" | "lead_dri_id" | "created_by" | "attendees_actual" | "participants"> &
  { revision: number; payload: TMeetingCardFrozenPayload; confirmation: TMeetingCardConfirmation; action_items: TMeetingActionItem[] };
/** 确认版里能检索的一段：ref 是段落的稳定 id（summary、sec-N、chg-N、act-N），heading 是给人看的标题。 */
type Passage = { ref: string; kind: "summary" | "section" | "objectChange" | "actionItem"; heading: string; text: string; searchText: string };
type ConfirmedMeetingMatch = Pick<Passage, "ref" | "kind" | "heading"> & { snippet: string };

const hitsOf = (text: string, terms: string[]) => terms.filter((term) => text.toLowerCase().includes(term));

/** 确认版的摘要、正文段落、对象修改后的文字和确认时的行动项（行动项只按事项文字匹配）。 */
function passagesOf(row: CatalogRow): Passage[] {
  const { payload } = row;
  return [
    { ref: "summary", kind: "summary" as const, heading: "摘要", text: payload.summary, searchText: payload.summary },
    ...payload.sections.map((section) => ({ ref: section.id, kind: "section" as const, heading: section.heading, text: section.body,
      searchText: `${section.heading}\n${section.body}` })),
    ...payload.objectChanges.map((change) => ({ ref: change.id, kind: "objectChange" as const, heading: change.targetTitle ?? "对象修改",
      text: change.after.text, searchText: change.after.text })),
    ...row.action_items.map((item) => ({ ref: item.id, kind: "actionItem" as const, heading: item.dueDate ? `行动项 · 截止 ${item.dueDate}` : "行动项",
      text: item.text, searchText: item.text })),
  ];
}

/** 段落太长时从第一个命中词前 SNIPPET_BEFORE 字起截 SNIPPET_MAX 字（命中只在标题上时从头截）。 */
function snippetOf(text: string, terms: string[]): string {
  if (text.length <= SNIPPET_MAX) return text;
  const lower = text.toLowerCase();
  const at = Math.min(...terms.map((term) => lower.indexOf(term)).filter((index) => index >= 0), text.length);
  const start = at === text.length ? 0 : Math.max(0, at - SNIPPET_BEFORE);
  const end = Math.min(text.length, start + SNIPPET_MAX);
  return `${start > 0 ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`;
}

/**
 * 一场会对检索词的命中：score 是会议名和各段合起来命中了几个不同的词（0 表示不相关）；
 * matches 是命中的段落，命中词多的在前，同样多按原顺序，最多 MATCHES_PER_MEETING 段。
 */
function matchMeeting(row: CatalogRow, terms: string[]): { score: number; matches: ConfirmedMeetingMatch[] } {
  const hit = new Set(hitsOf(row.payload.title, terms));
  const hitPassages = passagesOf(row).flatMap((passage) => {
    const hits = hitsOf(passage.searchText, terms);
    hits.forEach((term) => hit.add(term));
    return hits.length ? [{ passage, hits }] : [];
  });
  const matches = hitPassages
    .sort((a, b) => b.hits.length - a.hits.length)
    .slice(0, MATCHES_PER_MEETING)
    .map(({ passage, hits }) => ({ ref: passage.ref, kind: passage.kind, heading: passage.heading, snippet: snippetOf(passage.text, hits) }));
  return { score: hit.size, matches };
}

/**
 * 有当前确认版、本人能读的会，最多 5 场（只用于定位）。from / to 比确认版的 occurredAt；participantId 按会议的实际参会人（personId）。
 * query 按 queryTokens 切词（拉丁字母和数字按词，汉字按二元组），每个词按子串、不分大小写匹配确认版的
 * 会议名、摘要、段落标题和正文、对象修改后的文字、行动项（10/23 诊断方案二）：命中任一个词就算，命中的词越多越靠前，同样多按实际发生时间从晚到早；带 query 时每场会附 matches（命中的段落和片段）。
 * 没有 query 时按实际发生时间从晚到早。正文和确认时的摘要值对不上的会不进目录（同详情接口，不返回被改过的正文）。
 */
export async function listConfirmedMeetings(q: Query, viewer: Viewer, filter: ConfirmedMeetingFilter) {
  const rows = (await q(
    `SELECT m.id, m.lead_dri_id, m.created_by, m.attendees_actual, m.participants, c.revision, c.payload, c.confirmation, c.action_items
       FROM meeting_cards k
       JOIN meeting_card_confirmations c ON c.meeting_id = k.meeting_id AND c.revision = k.current_revision
       JOIN meetings m ON m.id = k.meeting_id`,
  )).rows as CatalogRow[];
  const terms = queryTokens(filter.query ?? "");
  const at = (row: CatalogRow) => Date.parse(row.payload.occurredAt ?? "");
  return rows
    .filter((row) => canReadMeetingCard(row, viewer))
    .filter((row) => !filter.from || at(row) >= Date.parse(filter.from))
    .filter((row) => !filter.to || at(row) <= Date.parse(filter.to))
    .filter((row) => !filter.participantId || attendeesOf(row).personIds.includes(filter.participantId))
    .map((row) => ({ row, ...(terms.length ? matchMeeting(row, terms) : { score: 0, matches: [] }) }))
    .filter(({ score }) => !terms.length || score > 0)
    .filter(({ row }) => {
      if (payloadHash(row.payload) === row.confirmation.payloadHash) return true;
      logEvent({ event: "meeting_card.catalog", objectRef: `meeting:${row.id}`, status: "skipped", errorCode: "PAYLOAD_HASH_MISMATCH" });
      return false;
    })
    .sort((a, b) => b.score - a.score || at(b.row) - at(a.row))
    .slice(0, Math.min(filter.limit ?? CATALOG_LIMIT, CATALOG_LIMIT))
    .map(({ row, matches }) => ({ meetingId: row.id, title: row.payload.title, occurredAt: row.payload.occurredAt, participants: row.payload.participants,
      currentConfirmedVersion: row.revision, ...(terms.length ? { matches } : {}) }));
}

/** 现有读会议的地方（Chat、MCP、周复盘）用的会议卡事实：确认版的摘要、段落和同步状态；只有草稿时 unconfirmed。 */
export type MeetingCardFacts =
  | { status: "confirmed"; revision: number; summary: string; sections: { heading: string; body: string }[];
      eventStatus: TMeetingCardSync["event"]["status"]; objects: { title: string; status: TMeetingCardSync["objects"][number]["status"] }[] }
  | { status: "unconfirmed" };

/** 没有会议卡行（旧会议、还没整理成卡）返回 null，读的地方照旧。不看可读范围。 */
export async function meetingCardFacts(q: Query, meetingId: string): Promise<MeetingCardFacts | null> {
  const card = await readCard(q, meetingId);
  if (card?.status !== "confirmed") return card;
  const { payload, confirmation, syncReceipt } = card;
  return {
    status: "confirmed", revision: confirmation.revision, summary: payload.summary,
    sections: payload.sections.map(({ heading, body }) => ({ heading, body })),
    // 对象「已更新」只认 updated（读回核对过）。
    eventStatus: syncReceipt.event.status, objects: syncReceipt.objects.map(({ title, status }) => ({ title, status })),
  };
}

/**
 * 会议快照（Chat 当前对象、显式引用）：有会议卡的会把旧的逐条结论（outcome、decisions）换成 meetingCard 事实，
 * 给了 viewer 且他读不了会议卡时不带；旧会议原样。逐字稿等其他字段不动。
 */
export async function cardWithMeetingFacts(q: Query, meeting: MeetingRow, card: TCard, viewer?: Viewer): Promise<TCard> {
  const facts = await meetingCardFacts(q, meeting.id);
  if (!facts) return card;
  const { outcome: _outcome, decisions: _decisions, ...rest } = card.payload as Record<string, unknown>;
  return { ...card, payload: viewer && !canReadMeetingCard(meeting, viewer) ? rest : { ...rest, meetingCard: facts } };
}
