import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { Pool } from "pg";
import type {
  TMeetingActionItem, TMeetingCardConfirmation, TMeetingCardConfirmRequest, TMeetingCardDraft, TMeetingCardKind, TMeetingCardSync, TMeetingCardV1Payload,
  TMeetingCardView, TMeetingConfirmedObjectChange, TMeetingObjectResult, TMeetingRecordStatus,
} from "@warmap/contracts";
import { enqueueJob, JOB_MAX_ATTEMPTS, type JobHandler } from "./jobs.js";
import { payloadHash } from "./meetingCardHash.js";
import { getMeetingRow, UUID_PATTERN, type MeetingRow, type Query } from "./meetingStore.js";
import { initialObjectResults, supersedeObjects, type MeetingObjectSync } from "./meetingObjectSync.js";
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
 * - 写本体按 revision 串行（jobs worker 逐条执行）：一直写最早一版待写的，前次写成的那条在写的时候现找（写入中又确认了新版，新版指回刚写成的那条）。
 *   NETWORK_ERROR 抛出交给 jobs 按原幂等键重放，其他错误记 failed 和原因（拍板 8：不设正文上限，本体回超长就如实记下）。
 * - 选了不写入：回执 skipped，不发请求；已经写进去的不撤回。
 * - 对象修改（meetingObjectSync）：确认时排好每条的回执，新版确认后旧版还没提交的作废；事件写成后同一任务里接着按顺序提交这一版的修改。
 */
export const MEETING_WORLD_SYNC_KIND = "meeting.world_sync";

type Viewer = { personId: string; isCeo: boolean };
type ConfirmError = { status: number; code: string; message: string; view?: TMeetingCardView };
type ConfirmResult = { view: TMeetingCardView } | { error: ConfirmError };

/** 当前确认版连同它的同步回执。 */
type ConfirmationRow = {
  revision: number; draft_version: number; kind: TMeetingCardKind; payload: TMeetingCardV1Payload; confirmation: TMeetingCardConfirmation;
  write_to_world: boolean; created_at: Date;
  event_status: TMeetingCardSync["event"]["status"]; event_id: string | null; event_error: string | null; objects: TMeetingObjectResult[];
};

export async function currentConfirmation(q: Query, meetingId: string): Promise<ConfirmationRow | null> {
  const row = (await q(
    `SELECT c.revision, c.draft_version, c.kind, c.payload, c.confirmation, c.write_to_world, c.created_at, s.event_status, s.event_id, s.event_error, s.objects
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
    confirmed: { payload: row.payload, confirmation: row.confirmation, kind: row.kind },
    sync: { revision: row.revision, writeToWorld: row.write_to_world, event: { status: row.event_status, eventId: row.event_id, error: row.event_error }, objects: row.objects },
  };
}

const bareRef = (ref: string) => ref.replace(/@\d+$/, "");
/** 修改里人定的部分（目标标题、原内容、版本、stale 由服务填）。 */
const decided = ({ id, targetRef, after, basisSectionIds }: TMeetingConfirmedObjectChange) => ({ id, targetRef, after, basisSectionIds });
/** 草稿和确认版内容不同（不算服务填的修改字段和挂点对象的版本）。 */
function draftDiffers(draft: TMeetingCardDraft, payload: TMeetingCardV1Payload): boolean {
  const { revision: _revision, ...confirmed } = payload;
  return !isDeepStrictEqual(
    { ...confirmed, relatedObjectRefs: confirmed.relatedObjectRefs.map(bareRef), objectChanges: confirmed.objectChanges.map(decided) },
    { ...draft, relatedObjectRefs: [...new Set(draft.relatedObjectRefs)], objectChanges: draft.objectChanges.map(decided) },
  );
}

/** 会议页「这场会在本体里」的记录状态（GET /api/meetings/:id/world），由确认表和回执算出；nameOf 把确认人的 personId 换成显示名。 */
export type MeetingRecordState = { status: TMeetingRecordStatus; version: number; eventId: string | null; confirmedAt: string | null; excludedBy: string | null; at: string | null };
export async function meetingRecordState(q: Query, meetingId: string, nameOf: (personId: string) => string): Promise<MeetingRecordState> {
  const draft = (await q("SELECT draft FROM meeting_cards WHERE meeting_id = $1", [meetingId])).rows[0]?.draft as TMeetingCardDraft | null | undefined;
  const current = await currentConfirmation(q, meetingId);
  const written = (await q(
    "SELECT event_id, updated_at FROM meeting_card_syncs WHERE meeting_id = $1 AND event_status = 'succeeded' ORDER BY revision DESC LIMIT 1", [meetingId],
  )).rows[0] as { event_id: string; updated_at: Date } | undefined;
  const base = { eventId: written?.event_id ?? null, at: written ? new Date(written.updated_at).toISOString() : null };
  if (!current) return { status: "pending", version: 0, confirmedAt: null, excludedBy: null, ...base };
  const status: TMeetingRecordStatus = draft && draftDiffers(draft, current.payload) ? "edit_pending"
    : !current.write_to_world ? "excluded"
    : current.event_status === "succeeded" ? "committed" : current.event_status === "failed" ? "failed" : "pending";
  return { status, version: current.revision, confirmedAt: new Date(current.created_at).toISOString(),
    excludedBy: current.write_to_world ? null : nameOf(current.confirmation.confirmedBy), ...base };
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
  now?: () => Date;
};

const NOT_FOUND = { error: { status: 404, code: "MEETING_NOT_FOUND", message: "会议不存在" } } as const;
const WORLD_UNAVAILABLE = { error: { status: 503, code: "WORLD_UNAVAILABLE", message: "读不到挂点对象的当前版本，稍后再确认" } } as const;
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
    const locked = (await cq("SELECT draft_version, current_revision, action_items FROM meeting_cards WHERE meeting_id = $1 FOR UPDATE", [meetingId])).rows[0] as
      { draft_version: number; current_revision: number | null; action_items: TMeetingActionItem[] };
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

  async function confirm(meetingId: string, viewer: Viewer, input: TMeetingCardConfirmRequest): Promise<ConfirmResult> {
    if (!UUID_PATTERN.test(meetingId)) return NOT_FOUND;
    const meeting = await getMeetingRow(q, meetingId);
    if (!meeting || !isHostOrCreator(meeting, viewer.personId)) return NOT_FOUND;
    const card = (await q("SELECT draft, draft_version, current_revision FROM meeting_cards WHERE meeting_id = $1", [meetingId])).rows[0] as
      { draft: TMeetingCardDraft | null; draft_version: number; current_revision: number | null } | undefined;
    if (!card?.draft) return { error: { status: 409, code: "CARD_NOT_READY", message: "会议卡草稿还没生成" } };
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
      const objectChanges = draft.objectChanges.map(({ stale: _stale, ...change }) => change);
      const payload: TMeetingCardV1Payload = {
        schemaVersion: draft.schemaVersion, meetingId: draft.meetingId, revision, title: draft.title, occurredAt: draft.occurredAt, participants: draft.participants,
        relatedObjectRefs, summary: draft.summary, sections: draft.sections, sources: draft.sources, objectChanges,
      };
      const confirmation: TMeetingCardConfirmation = { revision, confirmedBy: viewer.personId, confirmedAt: at.toISOString(), payloadHash: payloadHash(payload) };
      await cq(
        `INSERT INTO meeting_card_confirmations (meeting_id, revision, draft_version, kind, reason, payload, confirmation, action_items, write_to_world, created_at)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8::jsonb, $9, $10)`,
        [meetingId, revision, input.draftVersion, kind, reason, JSON.stringify(payload), JSON.stringify(confirmation), JSON.stringify(locked.action_items), input.writeToWorld, at],
      );
      await cq("INSERT INTO meeting_card_syncs (meeting_id, revision, event_status, objects, updated_at) VALUES ($1, $2, $3, $4::jsonb, $5)",
        [meetingId, revision, input.writeToWorld ? "pending" : "skipped", JSON.stringify(initialObjectResults(objectChanges, input.writeToWorld)), at]);
      await supersedeObjects(cq, meetingId, revision);
      // 确认后草稿的 stale 清掉（差异已经看过、确认过）；草稿版本不变，同一草稿再确认还认得出来。
      await cq(`UPDATE meeting_cards SET current_revision = $2, draft = jsonb_set(draft, '{objectChanges}', $3::jsonb), updated_at = now() WHERE meeting_id = $1`,
        [meetingId, revision, JSON.stringify(draft.objectChanges.map((change) => ({ ...change, stale: false })))]);
      // 第一次确认：会后事项算处理完；主持人和创建人的「会议记录待确认」提醒标为已读。
      await cq("UPDATE meetings SET status = 'reviewed', version = version + 1, updated_at = now() WHERE id = $1 AND status = 'held'", [meetingId]);
      await cq("UPDATE notifications SET read_at = now() WHERE kind = 'meeting_card_pending' AND object_id = $1 AND read_at IS NULL", [meetingId]);
      if (input.writeToWorld) await queueSync(cq, meetingId);
      return "done";
    });
    // 读和锁之间别人改了草稿：409；别人刚确认过（比如连点两次）：照最新的确认版重新走一遍。
    if (outcome === "changed") return changed(meetingId, viewer);
    if (outcome === "rerun") return confirm(meetingId, viewer, input);
    logEvent({ event: "meeting_card.confirm", objectRef: `meeting:${meetingId}`, status: kind });
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
        WHERE meeting_id = $1 AND revision = $2 AND event_status = 'skipped'`, [meetingId, current.revision, JSON.stringify(initialObjectResults(payload.objectChanges, true))]);
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
    if (!current || !await requeue(meetingId, current.revision, ["failed", "pending"])) {
      return { error: { status: 409, code: "NOTHING_TO_RETRY", message: "当前确认版没有要重试的写入" } };
    }
    return { view: await latestView(meetingId, viewer) };
  }

  /**
   * 这场会的本体同步（jobs worker 逐条执行）：按 revision 从早到晚，先写待写的事件（前次写成的那条在写的时候现找），
   * 事件写成的接着提交这一版还没提交的对象修改。lastAttempt：任务最后一次重跑，对象修改的网络错误也记失败。
   */
  async function syncWorld(meetingId: string, lastAttempt = false): Promise<void> {
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
      const previous = (await q(
        `SELECT revision, event_id, event_subject_refs, event_occurred_at FROM meeting_card_syncs
          WHERE meeting_id = $1 AND revision < $2 AND event_status = 'succeeded' ORDER BY revision DESC LIMIT 1`,
        [meetingId, row.revision],
      )).rows[0] as { revision: number; event_id: string; event_subject_refs: string[] | null; event_occurred_at: string | null } | undefined;
      try {
        const written = await world.write({ meetingId, kind: row.kind, payload: row.payload, confirmation: row.confirmation,
          confirmerName: nameOf(row.participants, row.confirmation.confirmedBy),
          previous: previous ? { eventId: previous.event_id, revision: previous.revision, subjectRefs: previous.event_subject_refs, occurredAt: previous.event_occurred_at } : null });
        // 记下实际写进去的 subject_refs 和 occurred_at：之后更正这条时沿用。
        await q(`UPDATE meeting_card_syncs SET event_status = 'succeeded', event_id = $3, event_error = NULL, event_subject_refs = $4::jsonb, event_occurred_at = $5,
            updated_at = now() WHERE meeting_id = $1 AND revision = $2`,
          [meetingId, row.revision, written.eventId, JSON.stringify(written.subjectRefs), written.occurredAt]);
        logEvent({ event: "meeting.world_event", objectRef: `meeting:${meetingId}`, status: "committed" });
      } catch (error) {
        const code = world.errorCode(error);
        logEvent({ event: "meeting.world_event", objectRef: `meeting:${meetingId}`, status: "world_failed", errorCode: code });
        const text = error instanceof WorldError ? `${code}: ${error.message}` : code;
        if (code === "NETWORK_ERROR") {
          await q("UPDATE meeting_card_syncs SET event_error = $3, updated_at = now() WHERE meeting_id = $1 AND revision = $2", [meetingId, row.revision, text]);
          throw error;
        }
        await q("UPDATE meeting_card_syncs SET event_status = 'failed', event_error = $3, updated_at = now() WHERE meeting_id = $1 AND revision = $2",
          [meetingId, row.revision, text]);
      }
    }
  }

  return { confirm, retry, syncWorld };
}

export type MeetingCardConfirmService = ReturnType<typeof createMeetingCardConfirmService>;

export function meetingCardConfirmJobs(service: MeetingCardConfirmService): Record<string, JobHandler> {
  return { [MEETING_WORLD_SYNC_KIND]: (payload, job) => service.syncWorld(String((payload as { meetingId?: unknown }).meetingId), job.attempts >= JOB_MAX_ATTEMPTS) };
}
