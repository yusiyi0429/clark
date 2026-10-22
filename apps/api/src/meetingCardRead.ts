import type { TCard, TMeetingCardConfirmation, TMeetingCardSync, TMeetingCardV1Payload } from "@warmap/contracts";
import { canReadMeetingCard, type Viewer } from "./meetingCard.js";
import { confirmedView, currentConfirmation } from "./meetingCardConfirm.js";
import { payloadHash } from "./meetingCardHash.js";
import { attendeesOf } from "./meetingDecisionView.js";
import { getMeetingRow, type MeetingRow, type Query } from "./meetingStore.js";

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

type ConfirmedMeeting = { status: "confirmed"; payload: TMeetingCardV1Payload; confirmation: TMeetingCardConfirmation; syncReceipt: TMeetingCardSync };
type CardRead = ConfirmedMeeting | { status: "unconfirmed" };
export type ConfirmedMeetingRead = CardRead | { status: "legacy"; summary: string; items: { kind: string; text: string; status: string }[] };

/** 有会议卡行的会：当前确认版（摘要值对不上抛 PayloadHashMismatchError）或未确认；没有会议卡行返回 null。不看可读范围。 */
async function readCard(q: Query, meetingId: string): Promise<CardRead | null> {
  if (!(await q("SELECT 1 FROM meeting_cards WHERE meeting_id = $1", [meetingId])).rowCount) return null;
  const current = await currentConfirmation(q, meetingId);
  if (!current) return { status: "unconfirmed" };
  if (payloadHash(current.payload) !== current.confirmation.payloadHash) throw new PayloadHashMismatchError(meetingId);
  return { status: "confirmed", payload: current.payload, confirmation: current.confirmation, syncReceipt: confirmedView(current).sync! };
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
export type ConfirmedMeetingFilter = { query?: string; from?: string; to?: string; participantId?: string; limit?: number };
type CatalogRow = Pick<MeetingRow, "id" | "lead_dri_id" | "created_by" | "attendees_actual" | "participants"> & { revision: number; payload: TMeetingCardV1Payload };

/**
 * 有当前确认版、本人能读的会，按实际发生时间从晚到早，最多 5 场（只用于定位）。
 * query 不分大小写匹配确认版的会议名、摘要和段落标题；from / to 比确认版的 occurredAt；participantId 按会议的实际参会人（personId）。
 */
export async function listConfirmedMeetings(q: Query, viewer: Viewer, filter: ConfirmedMeetingFilter) {
  const rows = (await q(
    `SELECT m.id, m.lead_dri_id, m.created_by, m.attendees_actual, m.participants, c.revision, c.payload
       FROM meeting_cards k
       JOIN meeting_card_confirmations c ON c.meeting_id = k.meeting_id AND c.revision = k.current_revision
       JOIN meetings m ON m.id = k.meeting_id`,
  )).rows as CatalogRow[];
  const needle = filter.query?.trim().toLowerCase();
  const at = (row: CatalogRow) => Date.parse(row.payload.occurredAt ?? "");
  return rows
    .filter((row) => canReadMeetingCard(row, viewer))
    .filter((row) => !needle || [row.payload.title, row.payload.summary, ...row.payload.sections.map((section) => section.heading)]
      .some((text) => text.toLowerCase().includes(needle)))
    .filter((row) => !filter.from || at(row) >= Date.parse(filter.from))
    .filter((row) => !filter.to || at(row) <= Date.parse(filter.to))
    .filter((row) => !filter.participantId || attendeesOf(row).personIds.includes(filter.participantId))
    .sort((a, b) => at(b) - at(a))
    .slice(0, Math.min(filter.limit ?? CATALOG_LIMIT, CATALOG_LIMIT))
    .map((row) => ({ meetingId: row.id, title: row.payload.title, occurredAt: row.payload.occurredAt, participants: row.payload.participants,
      currentConfirmedVersion: row.revision }));
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
