import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { Pool } from "pg";
import type {
  TMeetingActionItem, TMeetingCardConfirmation, TMeetingCardConfirmRequest, TMeetingCardDecision, TMeetingCardDraft, TMeetingCardFrozenPayload, TMeetingCardKind,
  TMeetingCardOwnerRequest, TMeetingCardReviewRequest, TMeetingCardSync, TMeetingCardView, TMeetingConfirmedObjectChange, TMeetingDraftChange, TMeetingItemReview, TMeetingObjectResult,
  TMeetingRecordStatus,
} from "@warmap/contracts";
import { enqueueJob, JOB_MAX_ATTEMPTS, type JobHandler } from "./jobs.js";
import { payloadHash } from "./meetingCardHash.js";
import { getMeetingRow, UUID_PATTERN, type MeetingRow, type Query } from "./meetingStore.js";
import { appliedChanges, initialObjectResults, supersedeObjects, worldErrorLabel, writtenRevisionRefs, type MeetingObjectSync } from "./meetingObjectSync.js";
import { logEvent } from "./observability.js";
import { WorldError, worldRef, type WorldClient } from "./worldClient.js";
import type { MeetingEventWorld } from "./worldMeetingEvent.js";

/**
 * 整卡确认与写本体（FR-5.1、5.3、5.5）：
 * - 主持人或创建人带 draftVersion 确认，一个事务里冻结一个确认版本（revision 加一）、存确认和待同步回执、排 meeting.world_sync；
 *   同一草稿版本只算一次确认（拍板 8）：再确认不出新版本（事件失败的按同一版重写；先不写入、再选写入的改成写入；写过再选不写入不动）。
 *   已有确认版时要选修改原因：correction 更正原记录、followup 会后新决定。confirmation.confirmedBy 是确认人的 personId（拍板 9）。
 * - 冻结时 relatedObjectRefs 换成确认时的 <对象 id>@<版本>（确认时本体读不到、选了不写入的，到同一草稿改成写入时再补版本），
 *   修改去掉 stale，算 payloadHash；行动项快照存确认表，不进 payload。
 * - 行动项（拍板 4）：确认时只存进这次的快照，不建执行事项（10/30 起会后分派关掉，执行事项由本人建）。
 *   10/30 之前推成执行事项的行动项带着 taskId，照旧留着，不回改那件执行事项。
 * - 写本体按 revision 串行（jobs worker 逐条执行）：一直写最早一版待写的，前次写成的那条在写的时候现找（写入中又确认了新版，新版指回刚写成的那条）。
 *   NETWORK_ERROR 抛出交给 jobs 按原幂等键重放，其他错误记 failed 和原因（拍板 8：不设正文上限，本体回超长就如实记下）；
 *   任务最后一次仍是网络错误：可能已经写进去了，台账记待核验、回执照网络错留着，1 小时后排一条核验（meeting.world_verify）按同一幂等键重放原请求，
 *   拿到回执照写成收尾，明确的业务错误记 failed；核验仍是网络错按 jobs 退避，最后一次还是网络错就停在待核验，不记失败。
 *   原因记短标签（worldErrorLabel），本体原话只进日志。
 * - 选了不写入：回执 skipped，不发请求；已经写进去的不撤回。
 * - 对象修改（meetingObjectSync）：确认时排好每条的回执（上一版已改成、这次没动的沿用结果），新版确认后旧版还没提交的作废；
 *   事件写成后同一任务里接着按顺序提交这一版的修改。
 * - 决策逐条确认（10/28，decisions 不为 null 的会议卡）：决策和行动项只由责任人本人在通知栏或会议页逐条点（没有负责人的行动项由主持人点），
 *   别人不能代点（斯一第 4 条）；行动项「接下」只记在会议卡上，不建执行事项（10/30 起）。没有责任人的决策，冻结前由主持人在参会人里补归属，再由那个人确认（斯一第 3 条，10/29）。决策都有了结果、或生成满 48 小时，自动冻结 revision 1（meeting.card_freeze，confirmedBy 为 null）：
 *   payload v2 只放已确认的决策和行动项（各带确认人），不带对象修改（斯一第 7 条：确认决策不等于批准修改）；
 *   没有已确认的决策时不写本体（记录正文能写时除外，见 recordText）。冻结前不能整卡确认（409 REVIEW_PER_ITEM）；冻结后的修改照旧由主持人确认出新版本。
 */
export const MEETING_WORLD_SYNC_KIND = "meeting.world_sync";
export const MEETING_CARD_FREEZE_KIND = "meeting.card_freeze";
export const MEETING_WORLD_VERIFY_KIND = "meeting.world_verify";
const VERIFY_DELAY_MS = 60 * 60_000;
export const PENDING_REVIEW: TMeetingItemReview = { status: "pending", by: null, at: null, reason: null };

type Viewer = { personId: string; isCeo: boolean };
type ConfirmError = { status: number; code: string; message: string; view?: TMeetingCardView };
type ConfirmResult = { view: TMeetingCardView } | { error: ConfirmError };
type Reviewable = { id: string; ownerPersonId: string | null; review?: TMeetingItemReview };

/** 当前确认版连同它的同步回执。 */
type ConfirmationRow = {
  revision: number; draft_version: number; kind: TMeetingCardKind; payload: TMeetingCardFrozenPayload; confirmation: TMeetingCardConfirmation;
  action_items: TMeetingActionItem[]; write_to_world: boolean; created_at: Date;
  event_status: TMeetingCardSync["event"]["status"]; event_id: string | null; event_error: string | null; objects: TMeetingObjectResult[];
};

export async function currentConfirmation(q: Query, meetingId: string): Promise<ConfirmationRow | null> {
  const row = (await q(
    `SELECT c.revision, c.draft_version, c.kind, c.payload, c.confirmation, c.action_items, c.write_to_world, c.created_at, s.event_status, s.event_id, s.event_error, s.objects
       FROM meeting_cards k
       JOIN meeting_card_confirmations c ON c.meeting_id = k.meeting_id AND c.revision = k.current_revision
       JOIN meeting_card_syncs s ON s.meeting_id = c.meeting_id AND s.revision = c.revision
      WHERE k.meeting_id = $1`,
    [meetingId],
  )).rows[0] as ConfirmationRow | undefined;
  return row ?? null;
}

/** 会议卡视图里的确认版和同步回执。 */
export function confirmedView(row: ConfirmationRow | null): Pick<TMeetingCardView, "confirmed" | "sync"> {
  if (!row) return { confirmed: null, sync: null };
  return {
    confirmed: { payload: row.payload, confirmation: row.confirmation, kind: row.kind, actionItems: row.action_items },
    sync: { revision: row.revision, writeToWorld: row.write_to_world, event: { status: row.event_status, eventId: row.event_id, error: row.event_error }, objects: row.objects },
  };
}

const bareRef = (ref: string) => ref.replace(/@\d+$/, "");
/** 修改里人定的部分（目标标题、原内容、版本、stale 由服务填）。 */
const decided = ({ id, targetRef, after, basisSectionIds }: TMeetingConfirmedObjectChange) => ({ id, targetRef, after, basisSectionIds });
/** 行动项里人定的部分（taskId、review 由服务填）。 */
const itemDecided = ({ taskId: _taskId, review: _review, ...item }: TMeetingActionItem) => item;
const recordOf = ({ meetingId, title, occurredAt, participants, summary, sections, sources }: TMeetingCardDraft | TMeetingCardFrozenPayload) =>
  ({ meetingId, title, occurredAt, participants, summary, sections, sources });
/**
 * 草稿和确认版的会议内容（payload 部分）不同（不算服务填的修改字段和挂点对象的版本）。v2 不带对象修改，不比。
 */
function contentDiffers(draft: TMeetingCardDraft, payload: TMeetingCardFrozenPayload): boolean {
  const changes = payload.decisions ? [] : draft.objectChanges;
  return !isDeepStrictEqual(
    { ...recordOf(payload), relatedObjectRefs: payload.relatedObjectRefs.map(bareRef), objectChanges: payload.objectChanges.map(decided) },
    { ...recordOf(draft), relatedObjectRefs: [...new Set(draft.relatedObjectRefs)], objectChanges: changes.map(decided) },
  );
}

/**
 * 冻结的 payload：草稿的会议内容加挂点对象版本。decisions 为 null（10/28 之前的会议卡）出 v1；
 * 否则出 v2，只放已确认的决策和行动项（带确认人和出处位置），不带对象修改（不提交）。
 */
function frozenPayload(draft: TMeetingCardDraft, revision: number, relatedObjectRefs: string[], decisions: TMeetingCardDecision[] | null,
  items: TMeetingActionItem[]): TMeetingCardFrozenPayload {
  const base = { ...recordOf(draft), relatedObjectRefs, revision };
  if (!decisions) return { schemaVersion: "meeting-card.v1", ...base, objectChanges: draft.objectChanges.map(({ stale: _stale, ...change }) => change) };
  const sourceRefsOf = (ids: string[]) => draft.sections.filter((section) => ids.includes(section.id)).flatMap((section) => section.sourceRefs);
  const confirmed = <T extends Reviewable & { basisSectionIds: string[] }>(list: T[]) => list.flatMap((item) => item.review?.status === "confirmed"
    ? [{ item, review: { confirmedBy: item.review.by!, confirmedAt: item.review.at!, sourceRefs: sourceRefsOf(item.basisSectionIds) } }] : []);
  return {
    schemaVersion: "meeting-card.v2", ...base, objectChanges: [],
    decisions: confirmed(decisions).map(({ item: { id, text, ownerPersonId, basisSectionIds }, review }) => ({ id, text, ownerPersonId, basisSectionIds, ...review })),
    actionItems: confirmed(items).map(({ item: { id, text, ownerPersonId, dueDate, basisSectionIds }, review }) => ({ id, text, ownerPersonId, dueDate, basisSectionIds, ...review })),
  };
}
/** 行动项和确认时的快照不同（不算 taskId）。 */
const itemsDiffer = (items: TMeetingActionItem[], snapshot: TMeetingActionItem[]) => !isDeepStrictEqual(items.map(itemDecided), snapshot.map(itemDecided));
/**
 * 草稿和当前确认版比（Ruling 21，确认和会议卡视图用同一份判断）：content 会议内容不同或有目标已变的修改（确认出新版本、要选原因）；
 * items 只有行动项不同（确认不出新版本）；none 没有不同或还没有确认版。
 */
export function draftChangeOf(draft: TMeetingCardDraft | null, items: TMeetingActionItem[], current: Pick<ConfirmationRow, "payload" | "action_items"> | null): TMeetingDraftChange {
  if (!draft || !current) return "none";
  if (contentDiffers(draft, current.payload) || draft.objectChanges.some((change) => change.stale)) return "content";
  return itemsDiffer(items, current.action_items) ? "items" : "none";
}

/** 会议页「这场会在本体里」的记录状态（GET /api/meetings/:id/world），由确认表和回执算出；nameOf 把确认人的 personId 换成显示名。 */
export type MeetingRecordState = { status: TMeetingRecordStatus; version: number; eventId: string | null; confirmedAt: string | null; excludedBy: string | null; at: string | null };
export async function meetingRecordState(q: Query, meetingId: string, nameOf: (personId: string) => string): Promise<MeetingRecordState> {
  const card = (await q("SELECT draft, action_items FROM meeting_cards WHERE meeting_id = $1", [meetingId])).rows[0] as
    { draft: TMeetingCardDraft | null; action_items: TMeetingActionItem[] } | undefined;
  const current = await currentConfirmation(q, meetingId);
  const written = (await q(
    "SELECT event_id, updated_at FROM meeting_card_syncs WHERE meeting_id = $1 AND event_status = 'succeeded' ORDER BY revision DESC LIMIT 1", [meetingId],
  )).rows[0] as { event_id: string; updated_at: Date } | undefined;
  const base = { eventId: written?.event_id ?? null, at: written ? new Date(written.updated_at).toISOString() : null };
  if (!current) return { status: "pending", version: 0, confirmedAt: null, excludedBy: null, ...base };
  const status: TMeetingRecordStatus = draftChangeOf(card?.draft ?? null, card?.action_items ?? [], current) !== "none" ? "edit_pending"
    : !current.write_to_world ? "excluded"
    : current.event_status === "succeeded" ? "committed" : current.event_status === "failed" ? "failed" : "writing";
  return { status, version: current.revision, confirmedAt: new Date(current.created_at).toISOString(),
    excludedBy: current.write_to_world || !current.confirmation.confirmedBy ? null : nameOf(current.confirmation.confirmedBy), ...base };
}

export type MeetingCardConfirmDeps = {
  pool: Pool;
  /** 确认时读挂点对象的当前版本（本体可写时才有）。 */
  world?: Pick<WorldClient, "getHead">;
  /** 会议事件：本体可写时才有。 */
  meetingWorld?: MeetingEventWorld;
  /** 对象修改：本体可写时才有。 */
  objectSync?: MeetingObjectSync;
  /** 确认人的显示名（会议成员里没有的人从人员目录取），只用在写入的 reason 里。 */
  names?: () => Map<string, string>;
  /** 最新的会议卡视图（会议卡服务的 view）。 */
  view: (meetingId: string, viewer: Viewer) => Promise<{ view: TMeetingCardView } | { error: { status: number; code: string; message: string } }>;
  /** 记录正文能不能写进本体（等斯一答复，MEETING_WORLD_RECORD_TEXT，默认不能）：不能时会议事件只带已确认的决策和行动项，没有已确认决策的会不写。 */
  recordText?: boolean;
  /**
   * 会议写本体整个关掉了（MEETING_WORLD_WRITES_OFF，会后链切到 Nexus 以后）：这时 meetingWorld、objectSync 都没有，读挂点的 world 还在。
   * 整卡确认、修改不管选没选写入都按「不写入」记（不然回执停在「写入中」却没有任务去写）；重试写入没有可重试的。
   */
  writesOff?: boolean;
  now?: () => Date;
};

const NOT_FOUND = { error: { status: 404, code: "MEETING_NOT_FOUND", message: "会议不存在" } } as const;
const WORLD_UNAVAILABLE = { error: { status: 503, code: "WORLD_UNAVAILABLE", message: "读不到所属对象的当前版本，稍后再确认" } } as const;
const bad = (code: string, message: string): ConfirmResult => ({ error: { status: 400, code, message } });
const isHostOrCreator = (meeting: Pick<MeetingRow, "lead_dri_id" | "created_by">, personId: string) =>
  meeting.lead_dri_id === personId || (meeting.created_by ?? meeting.lead_dri_id) === personId;
/** 锁住会议卡后的结果：别人刚改过草稿（changed）、刚确认过（rerun），或这次做完了（done）。 */
type Locked = "changed" | "rerun" | "done";

export function createMeetingCardConfirmService(deps: MeetingCardConfirmDeps) {
  const { pool } = deps;
  const q: Query = pool.query.bind(pool);
  const now = deps.now ?? (() => new Date());
  /** 排一次本体同步（只在本体可写时）；按会议串行由 jobs worker 逐条执行保证。 */
  const queueSync = async (client: Query, meetingId: string) => {
    if (deps.meetingWorld) await enqueueJob(client, { kind: MEETING_WORLD_SYNC_KIND, dedupeKey: `${MEETING_WORLD_SYNC_KIND}:${meetingId}:${randomUUID()}`, payload: { meetingId } });
  };
  const latestView = async (meetingId: string, viewer: Viewer) => (await deps.view(meetingId, viewer) as { view: TMeetingCardView }).view;
  const changed = async (meetingId: string, viewer: Viewer): Promise<ConfirmResult> => ({ error: { status: 409, code: "DRAFT_CHANGED",
    message: "会议卡已被修改，请查看最新内容", view: await latestView(meetingId, viewer) } });
  const nameOf = (participants: MeetingRow["participants"], personId: string) =>
    participants.find((person) => person.personId === personId)?.displayName ?? deps.names?.().get(personId) ?? personId;

  /** 一个事务；读到冲突时提交的是空事务（等同回滚）。连接在返回前放回，之后再读本体、重走确认。 */
  async function transaction<T>(run: (cq: Query) => Promise<T>): Promise<T> {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const result = await run(client.query.bind(client));
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
  /** 锁住会议卡，核对草稿版本和当前确认版没被别人动过。 */
  async function lockCard(cq: Query, meetingId: string, draftVersion: number, currentRevision: number | null) {
    const locked = (await cq("SELECT draft_version, current_revision, action_items, decisions FROM meeting_cards WHERE meeting_id = $1 FOR UPDATE", [meetingId])).rows[0] as
      { draft_version: number; current_revision: number | null; action_items: TMeetingActionItem[]; decisions: TMeetingCardDecision[] | null };
    const conflict: Locked | null = locked.draft_version !== draftVersion ? "changed" : locked.current_revision !== currentRevision ? "rerun" : null;
    return { locked, conflict };
  }

  /** 挂点对象带上当前版本；本体读不到抛错。 */
  async function versionedRefs(ids: string[]): Promise<string[]> {
    if (!deps.world) throw new WorldError(503, "WORLD_NOT_CONFIGURED", "本体不可写");
    const refs: string[] = [];
    for (const id of new Set(ids.map(bareRef))) refs.push(worldRef(await deps.world.getHead(id)));
    return refs;
  }
  const logReadFailure = (meetingId: string, error: unknown) =>
    logEvent({ event: "meeting_card.world_read", objectRef: `meeting:${meetingId}`, status: "failed", errorCode: (error as { code?: string }).code ?? "WORLD_READ_FAILED" });

  async function confirm(meetingId: string, viewer: Viewer, request: TMeetingCardConfirmRequest): Promise<ConfirmResult> {
    const input = deps.writesOff ? { ...request, writeToWorld: false } : request;
    if (!UUID_PATTERN.test(meetingId)) return NOT_FOUND;
    const meeting = await getMeetingRow(q, meetingId);
    if (!meeting || !isHostOrCreator(meeting, viewer.personId)) return NOT_FOUND;
    const card = (await q("SELECT draft, action_items, decisions, draft_version, current_revision FROM meeting_cards WHERE meeting_id = $1", [meetingId])).rows[0] as
      { draft: TMeetingCardDraft | null; action_items: TMeetingActionItem[]; decisions: TMeetingCardDecision[] | null; draft_version: number; current_revision: number | null } | undefined;
    if (!card?.draft) return { error: { status: 409, code: "CARD_NOT_READY", message: "会议卡草稿还没生成" } };
    // 逐条确认的会议卡冻结前不能整卡确认（主持人不能替责任人确认）：到期或都有结果后自动冻结。
    if (card.decisions && !card.current_revision) return { error: { status: 409, code: "REVIEW_PER_ITEM", message: "这场会的决策由责任人逐条确认" } };
    if (input.draftVersion !== card.draft_version) return changed(meetingId, viewer);
    const current = card.current_revision ? await currentConfirmation(q, meetingId) : null;
    // 同一草稿版本只算一次确认（拍板 8）：不出新版本、不要求选原因。
    if (current && current.draft_version === input.draftVersion) {
      if (!current.write_to_world && input.writeToWorld) return enableWrite(meetingId, viewer, input, current);
      // 再选写入、这一版事件失败的按同一版重写；选过写入再选不写入：不管事件什么状态都不动（不撤回、不追加、不重排），原样返回。
      if (input.writeToWorld && current.write_to_world && current.event_status === "failed") await requeue(meetingId, current.revision);
      return { view: await latestView(meetingId, viewer) };
    }

    const draft = card.draft;
    // 会议内容没变（只改了行动项，或改了又改回）：不出新版本、不要求选原因（Ruling 20、21）。
    if (current && draftChangeOf(draft, card.action_items, current) !== "content") return confirmItems(meetingId, viewer, input, current);
    const at = now();
    const occurredAt = draft.occurredAt ? Date.parse(draft.occurredAt) : NaN;
    if (!draft.title.trim()) return bad("TITLE_REQUIRED", "会议名不能为空");
    if (Number.isNaN(occurredAt) || occurredAt > at.getTime()) return bad("OCCURRED_AT_REQUIRED", "确认前要填会议实际开始时间，不能是将来的时刻");
    if (input.writeToWorld && !draft.relatedObjectRefs.length) return bad("RELATED_OBJECT_REQUIRED", "写进本体要至少挂一个对象");
    if (current && !input.kind) return bad("KIND_REQUIRED", "修改要选原因：更正原记录或会后新决定");
    const reason = input.reason?.trim() || null;

    let relatedObjectRefs: string[];
    try {
      relatedObjectRefs = await versionedRefs(draft.relatedObjectRefs);
    } catch (error) {
      logReadFailure(meetingId, error);
      // 不写入时本体读不到也能确认（只留天枢）：挂点对象先不带版本，之后改成写入时再补。
      if (input.writeToWorld) return WORLD_UNAVAILABLE;
      relatedObjectRefs = [...new Set(draft.relatedObjectRefs)];
    }

    let kind: TMeetingCardKind = "first";
    const outcome = await transaction(async (cq): Promise<Locked> => {
      const { locked, conflict } = await lockCard(cq, meetingId, input.draftVersion, card.current_revision);
      if (conflict) return conflict;
      const revision = (locked.current_revision ?? 0) + 1;
      kind = locked.current_revision ? input.kind! : "first";
      // 逐条确认的会议卡走到这里时已经冻结过，修改不动逐条状态。
      const { action_items: actionItems, decisions } = locked;
      const payload = frozenPayload(draft, revision, relatedObjectRefs, decisions, actionItems);
      const confirmation: TMeetingCardConfirmation = { revision, confirmedBy: viewer.personId, confirmedAt: at.toISOString(), payloadHash: payloadHash(payload) };
      // 上一版已改成的同一处修改沿用结果，不再提交（回执现读，锁住后不会再出新版本）。
      const applied = appliedChanges(locked.current_revision ? await currentConfirmation(cq, meetingId) : null);
      await insertRevision(cq, { meetingId, draft, draftVersion: input.draftVersion, kind, reason, payload, confirmation, actionItems, decisions,
        writeToWorld: input.writeToWorld, at, applied });
      return "done";
    });
    // 读和锁之间别人改了草稿：409；别人刚确认过（比如连点两次）：照最新的确认版重新走一遍。
    if (outcome === "changed") return changed(meetingId, viewer);
    if (outcome === "rerun") return confirm(meetingId, viewer, input);
    logEvent({ event: "meeting_card.confirm", objectRef: `meeting:${meetingId}`, status: kind });
    return { view: await latestView(meetingId, viewer) };
  }

  /**
   * 存一个确认版本（整卡确认和自动冻结共用，在锁住会议卡的事务里）：确认表、待同步回执、作废上一版没提交的修改；
   * 草稿的 stale 清掉（差异已经看过）、实际时间按 payload 补上，草稿版本不变（同一草稿再确认还认得出来）；第一次确认时会后事项算处理完；选了写入就排写本体。
   */
  async function insertRevision(cq: Query, input: {
    meetingId: string; draft: TMeetingCardDraft; draftVersion: number; kind: TMeetingCardKind; reason: string | null; payload: TMeetingCardFrozenPayload;
    confirmation: TMeetingCardConfirmation; actionItems: TMeetingActionItem[]; decisions: TMeetingCardDecision[] | null; writeToWorld: boolean; at: Date;
    applied: ReturnType<typeof appliedChanges>;
  }): Promise<void> {
    const { meetingId, payload, writeToWorld, at } = input;
    const { revision } = payload;
    await cq(
      `INSERT INTO meeting_card_confirmations (meeting_id, revision, draft_version, kind, reason, payload, confirmation, action_items, write_to_world, created_at)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8::jsonb, $9, $10)`,
      [meetingId, revision, input.draftVersion, input.kind, input.reason, JSON.stringify(payload), JSON.stringify(input.confirmation), JSON.stringify(input.actionItems), writeToWorld, at],
    );
    await cq("INSERT INTO meeting_card_syncs (meeting_id, revision, event_status, objects, updated_at) VALUES ($1, $2, $3, $4::jsonb, $5)",
      [meetingId, revision, writeToWorld ? "pending" : "skipped", JSON.stringify(initialObjectResults(payload.objectChanges, writeToWorld, input.applied)), at]);
    await supersedeObjects(cq, meetingId, revision);
    const draft = { ...input.draft, occurredAt: payload.occurredAt, objectChanges: input.draft.objectChanges.map((change) => ({ ...change, stale: false })) };
    await cq(`UPDATE meeting_cards SET current_revision = $2, draft = $3::jsonb, action_items = $4::jsonb, decisions = $5::jsonb, updated_at = now() WHERE meeting_id = $1`,
      [meetingId, revision, JSON.stringify(draft), JSON.stringify(input.actionItems), input.decisions ? JSON.stringify(input.decisions) : null]);
    // 第一次确认：会后事项算处理完；10/28 之前提醒主持人和创建人的「会议记录待确认」标为已读。
    await cq("UPDATE meetings SET status = 'reviewed', version = version + 1, updated_at = now() WHERE id = $1 AND status = 'held'", [meetingId]);
    await cq("UPDATE notifications SET read_at = now() WHERE kind = 'meeting_card_pending' AND object_id = $1 AND read_at IS NULL", [meetingId]);
    if (writeToWorld) await queueSync(cq, meetingId);
  }

  /** 一条决策或行动项本人处理后的状态。 */
  const reviewed = (by: string, at: string, verdict: TMeetingCardReviewRequest["verdict"], reason: string | null): TMeetingItemReview =>
    ({ status: verdict === "confirm" ? "confirmed" : "rejected", by, at, reason });

  /**
   * 逐条确认一条决策或行动项：只有责任人本人能点（没有负责人的行动项由主持人点），别人（包括主持人、创建人）当会议不存在。
   * 没有责任人的决策主持人点 409 OWNER_REQUIRED（先补归属）。行动项「接下」「退回」只记在会议卡上，不建执行事项。
   * 决策都有了结果，排一次冻结。返回最新会议卡；点的人读不了会议卡时 view 为 null。
   */
  async function review(meetingId: string, viewer: Viewer, input: TMeetingCardReviewRequest): Promise<{ view: TMeetingCardView | null } | { error: ConfirmError }> {
    if (!UUID_PATTERN.test(meetingId)) return NOT_FOUND;
    const meeting = await getMeetingRow(q, meetingId);
    if (!meeting) return NOT_FOUND;
    const reason = input.reason?.trim() ?? "";
    if (input.verdict === "reject" && !reason) return bad("REASON_REQUIRED", "要写一句原因");
    const at = now().toISOString();
    const outcome = await transaction(async (cq): Promise<"missing" | "reviewed" | "frozen" | "unowned" | "done"> => {
      const card = (await cq("SELECT decisions, action_items, current_revision FROM meeting_cards WHERE meeting_id = $1 FOR UPDATE", [meetingId])).rows[0] as
        { decisions: TMeetingCardDecision[] | null; action_items: TMeetingActionItem[]; current_revision: number | null } | undefined;
      const list: Reviewable[] = !card ? [] : input.kind === "decision" ? card.decisions ?? [] : card.action_items;
      const item = list.find((candidate) => candidate.id === input.id);
      if (!card || !item?.review) return "missing";
      if (input.kind === "decision" && !item.ownerPersonId) {
        if (meeting.lead_dri_id !== viewer.personId) return "missing";
        return card.current_revision ? "frozen" : item.review.status !== "pending" ? "reviewed" : "unowned";
      }
      if ((item.ownerPersonId ?? meeting.lead_dri_id) !== viewer.personId) return "missing";
      const result = reviewed(viewer.personId, at, input.verdict, input.verdict === "reject" ? reason : null);
      if (item.review.status !== "pending") return "reviewed";
      if (input.kind === "decision") {
        if (card.current_revision) return "frozen";
        const decisions = card.decisions!.map((decision) => (decision.id === item.id ? { ...decision, review: result } : decision));
        await cq("UPDATE meeting_cards SET decisions = $2::jsonb, updated_at = now() WHERE meeting_id = $1", [meetingId, JSON.stringify(decisions)]);
        if (decisions.every((decision) => decision.review.status !== "pending")) {
          await enqueueJob(cq, { kind: MEETING_CARD_FREEZE_KIND, dedupeKey: `${MEETING_CARD_FREEZE_KIND}:${meetingId}:decided`, payload: { meetingId } });
        }
        return "done";
      }
      const items = card.action_items.map((candidate) => (candidate.id === item.id ? { ...candidate, review: result } : candidate));
      await cq("UPDATE meeting_cards SET action_items = $2::jsonb, updated_at = now() WHERE meeting_id = $1", [meetingId, JSON.stringify(items)]);
      return "done";
    });
    if (outcome === "missing") return NOT_FOUND;
    const found = await deps.view(meetingId, viewer);
    const view = "view" in found ? found.view : null;
    if (outcome === "reviewed") return { error: { status: 409, code: "ALREADY_REVIEWED", message: "这一条已经处理过了", ...(view ? { view } : {}) } };
    if (outcome === "frozen") return { error: { status: 409, code: "CARD_FROZEN", message: "这场会的决策已经定版", ...(view ? { view } : {}) } };
    if (outcome === "unowned") return { error: { status: 409, code: "OWNER_REQUIRED", message: "这条决策还没有责任人，先交给一位参会人", ...(view ? { view } : {}) } };
    logEvent({ event: "meeting_card.review", objectRef: `meeting:${meetingId}`, status: `${input.kind}:${input.verdict}` });
    return { view };
  }

  /**
   * 冻结前主持人给没有责任人的决策补归属（斯一第 3 条）：只能选参会人；责任人写上后确认状态仍是待确认，由那个人自己在通知栏或会议页点。
   * 别人当会议不存在；返回最新会议卡。
   */
  async function assignOwner(meetingId: string, viewer: Viewer, input: TMeetingCardOwnerRequest): Promise<{ view: TMeetingCardView | null } | { error: ConfirmError }> {
    if (!UUID_PATTERN.test(meetingId)) return NOT_FOUND;
    const meeting = await getMeetingRow(q, meetingId);
    if (!meeting || meeting.lead_dri_id !== viewer.personId) return NOT_FOUND;
    if (!meeting.participants.some((person) => person.personId === input.ownerPersonId)) return bad("NOT_PARTICIPANT", "只能交给这场会的参会人");
    const outcome = await transaction(async (cq): Promise<"missing" | "owned" | "reviewed" | "frozen" | "done"> => {
      const card = (await cq("SELECT decisions, current_revision FROM meeting_cards WHERE meeting_id = $1 FOR UPDATE", [meetingId])).rows[0] as
        { decisions: TMeetingCardDecision[] | null; current_revision: number | null } | undefined;
      const decision = card?.decisions?.find((candidate) => candidate.id === input.id);
      if (!card || !decision) return "missing";
      if (card.current_revision) return "frozen";
      if (decision.ownerPersonId) return "owned";
      if (decision.review.status !== "pending") return "reviewed";
      const decisions = card.decisions!.map((candidate) => (candidate.id === decision.id ? { ...candidate, ownerPersonId: input.ownerPersonId } : candidate));
      await cq("UPDATE meeting_cards SET decisions = $2::jsonb, updated_at = now() WHERE meeting_id = $1", [meetingId, JSON.stringify(decisions)]);
      return "done";
    });
    if (outcome === "missing") return NOT_FOUND;
    const found = await deps.view(meetingId, viewer);
    const view = "view" in found ? found.view : null;
    const conflict = { owned: ["OWNER_SET", "这条决策已经有责任人"], reviewed: ["ALREADY_REVIEWED", "这一条已经处理过了"], frozen: ["CARD_FROZEN", "这场会的决策已经定版"] } as const;
    if (outcome !== "done") return { error: { status: 409, code: conflict[outcome][0], message: conflict[outcome][1], ...(view ? { view } : {}) } };
    logEvent({ event: "meeting_card.assign_owner", objectRef: `meeting:${meetingId}`, status: "decision" });
    return { view };
  }

  /**
   * 自动冻结（meeting.card_freeze：决策都有了结果，或生成满 48 小时）：还没冻结的逐条确认会议卡冻结 revision 1，confirmedBy 为 null。
   * 实际时间没填的用会议实际开始（没有就预约时间）。写本体要：选了写入、挂了对象、本体可写，并且有已确认的决策（记录正文能写时没有也写）；
   * 要写时读不到挂点对象的版本就抛错，交给 jobs 重试。已冻结、10/28 之前的会议卡不动。
   */
  async function freeze(meetingId: string): Promise<void> {
    if (!UUID_PATTERN.test(meetingId)) return;
    const meeting = await getMeetingRow(q, meetingId);
    const card = (await q("SELECT draft, decisions, current_revision, write_to_world FROM meeting_cards WHERE meeting_id = $1", [meetingId])).rows[0] as
      { draft: TMeetingCardDraft | null; decisions: TMeetingCardDecision[] | null; current_revision: number | null; write_to_world: boolean } | undefined;
    if (!meeting || !card?.draft || !card.decisions || card.current_revision) return;
    const canWrite = Boolean(deps.meetingWorld) && card.write_to_world && card.draft.relatedObjectRefs.length > 0;
    const relatedObjectRefs = canWrite ? await versionedRefs(card.draft.relatedObjectRefs) : [...new Set(card.draft.relatedObjectRefs)];
    const at = now();
    const done = await transaction(async (cq) => {
      const locked = (await cq("SELECT draft, decisions, action_items, draft_version, current_revision, write_to_world FROM meeting_cards WHERE meeting_id = $1 FOR UPDATE",
        [meetingId])).rows[0] as { draft: TMeetingCardDraft; decisions: TMeetingCardDecision[] | null; action_items: TMeetingActionItem[]; draft_version: number;
          current_revision: number | null; write_to_world: boolean };
      if (locked.current_revision || !locked.decisions) return false;
      const draft = { ...locked.draft, occurredAt: locked.draft.occurredAt ?? (meeting.started_at ?? meeting.scheduled_at).toISOString() };
      const payload = frozenPayload(draft, 1, relatedObjectRefs, locked.decisions, locked.action_items);
      const writeToWorld = canWrite && locked.write_to_world && (payload.decisions!.length > 0 || Boolean(deps.recordText));
      const confirmation: TMeetingCardConfirmation = { revision: 1, confirmedBy: null, confirmedAt: at.toISOString(), payloadHash: payloadHash(payload) };
      await insertRevision(cq, { meetingId, draft, draftVersion: locked.draft_version, kind: "first", reason: null, payload, confirmation,
        actionItems: locked.action_items, decisions: locked.decisions, writeToWorld, at, applied: appliedChanges(null) });
      return true;
    });
    if (done) logEvent({ event: "meeting_card.freeze", objectRef: `meeting:${meetingId}`, status: "frozen" });
  }

  /**
   * 确认后会议内容没变（Ruling 20、21）：当前确认版不变，只换掉它的行动项快照，草稿版本记成这一版
   * （同一草稿再确认按原样返回）；不出新版本。这一版原先不写入、这次选了写入的，记完接着按同一草稿改成写入（enableWrite）。
   */
  async function confirmItems(meetingId: string, viewer: Viewer, input: TMeetingCardConfirmRequest, current: ConfirmationRow): Promise<ConfirmResult> {
    const outcome = await transaction(async (cq): Promise<Locked> => {
      const { locked, conflict } = await lockCard(cq, meetingId, input.draftVersion, current.revision);
      if (conflict) return conflict;
      await cq("UPDATE meeting_card_confirmations SET action_items = $3::jsonb, draft_version = $4 WHERE meeting_id = $1 AND revision = $2",
        [meetingId, current.revision, JSON.stringify(locked.action_items), input.draftVersion]);
      return "done";
    });
    if (outcome === "changed") return changed(meetingId, viewer);
    if (outcome === "rerun") return confirm(meetingId, viewer, input);
    logEvent({ event: "meeting_card.confirm", objectRef: `meeting:${meetingId}`, status: "action_items" });
    if (!current.write_to_world && input.writeToWorld) return confirm(meetingId, viewer, input);
    return { view: await latestView(meetingId, viewer) };
  }

  /**
   * 同一草稿先选了不写入、再选写入（拍板 8）：同一个确认版本改成写入，回执 skipped → pending，排写本体；不出新版本、不要求选原因。
   * 确认时本体读不到、挂点对象没带版本的，现在补上版本（摘要值跟着重算；还没写过，冻结内容只差版本号）；还读不到就 503。
   */
  async function enableWrite(meetingId: string, viewer: Viewer, input: TMeetingCardConfirmRequest, current: ConfirmationRow): Promise<ConfirmResult> {
    let { payload, confirmation } = current;
    if (!payload.relatedObjectRefs.length) return bad("RELATED_OBJECT_REQUIRED", "写进本体要至少挂一个对象");
    if (payload.relatedObjectRefs.some((ref) => ref === bareRef(ref))) {
      try {
        payload = { ...payload, relatedObjectRefs: await versionedRefs(payload.relatedObjectRefs) };
      } catch (error) {
        logReadFailure(meetingId, error);
        return WORLD_UNAVAILABLE;
      }
      confirmation = { ...confirmation, payloadHash: payloadHash(payload) };
    }
    const outcome = await transaction(async (cq): Promise<Locked> => {
      const { conflict } = await lockCard(cq, meetingId, input.draftVersion, current.revision);
      if (conflict) return conflict;
      await cq(`UPDATE meeting_card_confirmations SET write_to_world = TRUE, payload = $3::jsonb, confirmation = $4::jsonb
        WHERE meeting_id = $1 AND revision = $2 AND write_to_world = FALSE`, [meetingId, current.revision, JSON.stringify(payload), JSON.stringify(confirmation)]);
      await cq(`UPDATE meeting_card_syncs SET event_status = 'pending', objects = $3::jsonb, updated_at = now()
        WHERE meeting_id = $1 AND revision = $2 AND event_status = 'skipped'`, [meetingId, current.revision, JSON.stringify(initialObjectResults(payload.objectChanges, true, appliedChanges(current)))]);
      await queueSync(cq, meetingId);
      return "done";
    });
    if (outcome === "changed") return changed(meetingId, viewer);
    if (outcome === "rerun") return confirm(meetingId, viewer, input);
    logEvent({ event: "meeting_card.confirm", objectRef: `meeting:${meetingId}`, status: "write_enabled" });
    return { view: await latestView(meetingId, viewer) };
  }

  /** 失败的（或还在等的）这一版重排写入；返回是否重排了。 */
  function requeue(meetingId: string, revision: number, statuses: string[] = ["failed"]): Promise<boolean> {
    return transaction(async (cq) => {
      const updated = await cq(
        `UPDATE meeting_card_syncs SET event_status = 'pending', event_error = NULL, updated_at = now()
          WHERE meeting_id = $1 AND revision = $2 AND event_status = ANY($3::text[])`,
        [meetingId, revision, statuses],
      );
      if (updated.rowCount) await queueSync(cq, meetingId);
      return Boolean(updated.rowCount);
    });
  }

  /** 重试当前确认版的会议事件（失败的，或网络失败后还在等的）；对象修改的重试不在本期（拍板 5）。 */
  async function retry(meetingId: string, viewer: Viewer): Promise<ConfirmResult> {
    if (!UUID_PATTERN.test(meetingId)) return NOT_FOUND;
    const meeting = await getMeetingRow(q, meetingId);
    if (!meeting || !isHostOrCreator(meeting, viewer.personId)) return NOT_FOUND;
    const current = await currentConfirmation(q, meetingId);
    if (deps.writesOff || !current || !await requeue(meetingId, current.revision, ["failed", "pending"])) {
      return { error: { status: 409, code: "NOTHING_TO_RETRY", message: "当前确认版没有要重试的写入" } };
    }
    return { view: await latestView(meetingId, viewer) };
  }

  /**
   * 这场会的本体同步（jobs worker 逐条执行）：按 revision 从早到晚，先逐条提交这一版还没提交的对象修改，再写会议事件
   * （content.refs 只列这一版写成的修改；前次写成的那条事件在写的时候现找）。10/21 之前按「先事件后修改」排下、事件已写成的那一版，接着提交剩下的修改。
   * lastAttempt：任务最后一次重跑，对象修改的网络错误也记失败；事件的网络错误记待核验（见文件头）。verify：核验任务在跑。
   */
  async function syncWorld(meetingId: string, lastAttempt = false, verify = false): Promise<void> {
    const world = deps.meetingWorld;
    if (!world || !UUID_PATTERN.test(meetingId)) return;
    for (;;) {
      const row = (await q(
        `SELECT c.revision, c.kind, c.payload, c.confirmation, m.participants, s.event_status, s.objects FROM meeting_card_syncs s
           JOIN meeting_card_confirmations c ON c.meeting_id = s.meeting_id AND c.revision = s.revision
           JOIN meetings m ON m.id = s.meeting_id
          WHERE s.meeting_id = $1 AND (s.event_status = 'pending' OR ($2 AND s.event_status = 'succeeded' AND s.objects @> '[{"status":"pending"}]'::jsonb))
          ORDER BY s.revision LIMIT 1`,
        [meetingId, Boolean(deps.objectSync)],
      )).rows[0] as (Pick<ConfirmationRow, "revision" | "kind" | "payload" | "confirmation" | "event_status" | "objects"> & Pick<MeetingRow, "participants">) | undefined;
      if (!row) return;
      if (row.event_status === "succeeded") {
        await deps.objectSync!.run(meetingId, row.revision, row.payload.objectChanges, row.objects, lastAttempt);
        continue;
      }
      let objects = row.objects;
      if (deps.objectSync && objects.some((object) => object.status === "pending")) {
        await deps.objectSync.run(meetingId, row.revision, row.payload.objectChanges, objects, lastAttempt);
        objects = (await q("SELECT objects FROM meeting_card_syncs WHERE meeting_id = $1 AND revision = $2", [meetingId, row.revision])).rows[0].objects;
      }
      const previous = (await q(
        `SELECT revision, event_id, event_subject_refs, event_occurred_at FROM meeting_card_syncs
          WHERE meeting_id = $1 AND revision < $2 AND event_status = 'succeeded' ORDER BY revision DESC LIMIT 1`,
        [meetingId, row.revision],
      )).rows[0] as { revision: number; event_id: string; event_subject_refs: string[] | null; event_occurred_at: string | null } | undefined;
      // 写进 reason 的确认人：整卡确认的那个人；自动冻结的是逐条确认决策的人。
      const confirmers = row.confirmation.confirmedBy ? [row.confirmation.confirmedBy] : [...new Set((row.payload.decisions ?? []).map((decision) => decision.confirmedBy))];
      try {
        const written = await world.write({ meetingId, kind: row.kind, payload: row.payload, confirmation: row.confirmation, recordText: Boolean(deps.recordText),
          confirmerName: confirmers.map((personId) => nameOf(row.participants, personId)).join("、"),
          previous: previous ? { eventId: previous.event_id, revision: previous.revision, subjectRefs: previous.event_subject_refs, occurredAt: previous.event_occurred_at } : null,
          revisionRefs: writtenRevisionRefs(row.payload.objectChanges, objects) });
        // 记下实际写进去的 subject_refs 和 occurred_at：之后更正这条时沿用。
        await q(`UPDATE meeting_card_syncs SET event_status = 'succeeded', event_id = $3, event_error = NULL, event_subject_refs = $4::jsonb, event_occurred_at = $5,
            updated_at = now() WHERE meeting_id = $1 AND revision = $2`,
          [meetingId, row.revision, written.eventId, JSON.stringify(written.subjectRefs), written.occurredAt]);
        logEvent({ event: "meeting.world_event", objectRef: `meeting:${meetingId}`, status: "committed" });
      } catch (error) {
        const code = world.errorCode(error);
        logEvent({ event: "meeting.world_event", objectRef: `meeting:${meetingId}`, status: "world_failed", errorCode: code, message: error instanceof Error ? error.message : undefined });
        const label = worldErrorLabel(code);
        if (code === "NETWORK_ERROR") {
          await q("UPDATE meeting_card_syncs SET event_error = $3, updated_at = now() WHERE meeting_id = $1 AND revision = $2", [meetingId, row.revision, label]);
          if (!lastAttempt && !verify) throw error;
          const key = await world.markUnverified(meetingId, row.revision);
          if (!lastAttempt) throw error;
          if (!verify) {
            await enqueueJob(q, { kind: MEETING_WORLD_VERIFY_KIND, dedupeKey: `${MEETING_WORLD_VERIFY_KIND}:${key}:${randomUUID()}`, payload: { meetingId },
              runAt: new Date(now().getTime() + VERIFY_DELAY_MS) });
          }
          return;
        }
        await q("UPDATE meeting_card_syncs SET event_status = 'failed', event_error = $3, updated_at = now() WHERE meeting_id = $1 AND revision = $2",
          [meetingId, row.revision, label]);
      }
    }
  }

  return { confirm, review, assignOwner, freeze, retry, syncWorld };
}

export type MeetingCardConfirmService = ReturnType<typeof createMeetingCardConfirmService>;

export function meetingCardConfirmJobs(service: MeetingCardConfirmService): Record<string, JobHandler> {
  const meetingIdOf = (payload: unknown) => String((payload as { meetingId?: unknown }).meetingId);
  return {
    [MEETING_WORLD_SYNC_KIND]: (payload, job) => service.syncWorld(meetingIdOf(payload), job.attempts >= JOB_MAX_ATTEMPTS),
    [MEETING_WORLD_VERIFY_KIND]: (payload, job) => service.syncWorld(meetingIdOf(payload), job.attempts >= JOB_MAX_ATTEMPTS, true),
    [MEETING_CARD_FREEZE_KIND]: (payload) => service.freeze(meetingIdOf(payload)),
  };
}
