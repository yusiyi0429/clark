import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { Pool } from "pg";
import type {
  TMeetingActionItem, TMeetingCardConfirmation, TMeetingCardConfirmRequest, TMeetingCardDraft, TMeetingCardKind, TMeetingCardSync, TMeetingCardV1Payload,
  TMeetingCardView, TMeetingObjectResult, TMeetingRecordStatus,
} from "@warmap/contracts";
import { enqueueJob, type JobHandler } from "./jobs.js";
import { payloadHash } from "./meetingCardHash.js";
import { getMeetingRow, UUID_PATTERN, type MeetingRow, type Query } from "./meetingStore.js";
import { logEvent } from "./observability.js";
import { WorldError, worldRef, type WorldClient } from "./worldClient.js";
import type { MeetingEventWorld } from "./worldMeetingEvent.js";

/**
 * 整卡确认与写本体（FR-5.1、5.3、5.5）：
 * - 主持人或创建人带 draftVersion 确认，一个事务里冻结一个确认版本（revision 加一）、存确认和待同步回执、排 meeting.world_sync；
 *   同一草稿版本再确认不出新版本（这一版事件失败的按同一版重写）。已有确认版时要选修改原因：correction 更正原记录、followup 会后新决定。
 * - 冻结时 relatedObjectRefs 换成确认时的 <对象 id>@<版本>、修改去掉 stale，算 payloadHash；行动项快照存确认表，不进 payload。
 * - 写本体按 revision 串行（jobs worker 逐条执行）：一直写最早一版待写的，前次写成的那条在写的时候现找（写入中又确认了新版，新版指回刚写成的那条）。
 *   NETWORK_ERROR 抛出交给 jobs 按原幂等键重放，其他错误记 failed 和原因（拍板 8：不设正文上限，本体回超长就如实记下）。
 * - 选了不写入：回执 skipped，不发请求；已经写进去的不撤回。
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
/** 草稿和确认版内容不同（不算 stale 和挂点对象的版本）。 */
function draftDiffers(draft: TMeetingCardDraft, payload: TMeetingCardV1Payload): boolean {
  const { revision: _revision, ...confirmed } = payload;
  return !isDeepStrictEqual(
    { ...confirmed, relatedObjectRefs: confirmed.relatedObjectRefs.map(bareRef) },
    { ...draft, relatedObjectRefs: [...new Set(draft.relatedObjectRefs)], objectChanges: draft.objectChanges.map(({ stale: _stale, ...change }) => change) },
  );
}

/** 会议页「这场会在本体里」的记录状态（GET /api/meetings/:id/world），由确认表和回执算出。 */
export type MeetingRecordState = { status: TMeetingRecordStatus; version: number; eventId: string | null; confirmedAt: string | null; excludedBy: string | null; at: string | null };
export async function meetingRecordState(q: Query, meetingId: string): Promise<MeetingRecordState> {
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
    excludedBy: current.write_to_world ? null : current.confirmation.confirmedBy, ...base };
}

export type MeetingCardConfirmDeps = {
  pool: Pool;
  /** 确认时读挂点对象的当前版本（本体可写时才有）。 */
  world?: Pick<WorldClient, "getHead">;
  /** 会议事件：本体可写时才有。 */
  meetingWorld?: MeetingEventWorld;
  /** 确认人的显示名（会议成员里没有的人从人员目录取）。 */
  names?: () => Map<string, string>;
  /** 最新的会议卡视图（会议卡服务的 view）。 */
  view: (meetingId: string, viewer: Viewer) => Promise<{ view: TMeetingCardView } | { error: { status: number; code: string; message: string } }>;
  now?: () => Date;
};

const NOT_FOUND = { error: { status: 404, code: "MEETING_NOT_FOUND", message: "会议不存在" } } as const;
const bad = (code: string, message: string): ConfirmResult => ({ error: { status: 400, code, message } });
const isHostOrCreator = (meeting: Pick<MeetingRow, "lead_dri_id" | "created_by">, personId: string) =>
  meeting.lead_dri_id === personId || (meeting.created_by ?? meeting.lead_dri_id) === personId;

export function createMeetingCardConfirmService(deps: MeetingCardConfirmDeps) {
  const { pool } = deps;
  const q: Query = pool.query.bind(pool);
  const now = deps.now ?? (() => new Date());
  /** 排一次本体同步（只在本体可写时）；按会议串行由 jobs worker 逐条执行保证。 */
  const queueSync = async (client: Query, meetingId: string) => {
    if (deps.meetingWorld) await enqueueJob(client, { kind: MEETING_WORLD_SYNC_KIND, dedupeKey: `${MEETING_WORLD_SYNC_KIND}:${meetingId}:${randomUUID()}`, payload: { meetingId } });
  };
  const latestView = async (meetingId: string, viewer: Viewer) => (await deps.view(meetingId, viewer) as { view: TMeetingCardView }).view;

  /** 冻结时挂点对象带上确认时的版本；本体读不到抛错。 */
  async function versionedRefs(ids: string[]): Promise<string[]> {
    if (!deps.world) throw new WorldError(503, "WORLD_NOT_CONFIGURED", "本体不可写");
    const refs: string[] = [];
    for (const id of new Set(ids)) refs.push(worldRef(await deps.world.getHead(id)));
    return refs;
  }

  async function confirm(meetingId: string, viewer: Viewer, input: TMeetingCardConfirmRequest): Promise<ConfirmResult> {
    if (!UUID_PATTERN.test(meetingId)) return NOT_FOUND;
    const meeting = await getMeetingRow(q, meetingId);
    if (!meeting || !isHostOrCreator(meeting, viewer.personId)) return NOT_FOUND;
    const changed = async (): Promise<ConfirmResult> => ({ error: { status: 409, code: "DRAFT_CHANGED", message: "会议卡已被修改，请查看最新内容",
      view: await latestView(meetingId, viewer) } });
    const card = (await q("SELECT draft, draft_version, current_revision FROM meeting_cards WHERE meeting_id = $1", [meetingId])).rows[0] as
      { draft: TMeetingCardDraft | null; draft_version: number; current_revision: number | null } | undefined;
    if (!card?.draft) return { error: { status: 409, code: "CARD_NOT_READY", message: "会议卡草稿还没生成" } };
    if (input.draftVersion !== card.draft_version) return changed();
    const current = card.current_revision ? await currentConfirmation(q, meetingId) : null;
    // 同一草稿、同样的写入选择再确认：不出新版本；这一版事件失败的按同一版重写。
    if (current && current.draft_version === input.draftVersion && current.write_to_world === input.writeToWorld) {
      if (current.event_status === "failed") await requeue(meetingId, current.revision);
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
      logEvent({ event: "meeting_card.world_read", objectRef: `meeting:${meetingId}`, status: "failed", errorCode: (error as { code?: string }).code ?? "WORLD_READ_FAILED" });
      // 不写入时本体读不到也能确认（只留天枢）：挂点对象不带版本。
      if (input.writeToWorld) return { error: { status: 503, code: "WORLD_UNAVAILABLE", message: "读不到挂点对象的当前版本，稍后再确认" } };
      relatedObjectRefs = [...new Set(draft.relatedObjectRefs)];
    }

    const client = await pool.connect();
    let kind: TMeetingCardKind;
    try {
      await client.query("BEGIN");
      const cq: Query = client.query.bind(client);
      const locked = (await cq("SELECT draft_version, current_revision, action_items FROM meeting_cards WHERE meeting_id = $1 FOR UPDATE", [meetingId])).rows[0] as
        { draft_version: number; current_revision: number | null; action_items: TMeetingActionItem[] };
      if (locked.draft_version !== input.draftVersion) { await client.query("ROLLBACK"); return changed(); }
      // 读和锁之间别人刚确认过（比如连点两次）：照最新的确认版重新走一遍。
      if (locked.current_revision !== card.current_revision) { await client.query("ROLLBACK"); return confirm(meetingId, viewer, input); }
      const revision = (locked.current_revision ?? 0) + 1;
      kind = locked.current_revision ? input.kind! : "first";
      const objectChanges = draft.objectChanges.map(({ stale: _stale, ...change }) => change);
      const payload: TMeetingCardV1Payload = {
        schemaVersion: draft.schemaVersion, meetingId: draft.meetingId, revision, title: draft.title, occurredAt: draft.occurredAt, participants: draft.participants,
        relatedObjectRefs, summary: draft.summary, sections: draft.sections, sources: draft.sources, objectChanges,
      };
      const confirmedBy = meeting.participants.find((person) => person.personId === viewer.personId)?.displayName ?? deps.names?.().get(viewer.personId) ?? viewer.personId;
      const confirmation: TMeetingCardConfirmation = { revision, confirmedBy, confirmedAt: at.toISOString(), payloadHash: payloadHash(payload) };
      await cq(
        `INSERT INTO meeting_card_confirmations (meeting_id, revision, draft_version, kind, reason, payload, confirmation, action_items, write_to_world, created_at)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8::jsonb, $9, $10)`,
        [meetingId, revision, input.draftVersion, kind, reason, JSON.stringify(payload), JSON.stringify(confirmation), JSON.stringify(locked.action_items), input.writeToWorld, at],
      );
      await cq("INSERT INTO meeting_card_syncs (meeting_id, revision, event_status, updated_at) VALUES ($1, $2, $3, $4)",
        [meetingId, revision, input.writeToWorld ? "pending" : "skipped", at]);
      // 确认后草稿的 stale 清掉（差异已经看过、确认过）；草稿版本不变，同一草稿再确认还认得出来。
      await cq(`UPDATE meeting_cards SET current_revision = $2, draft = jsonb_set(draft, '{objectChanges}', $3::jsonb), updated_at = now() WHERE meeting_id = $1`,
        [meetingId, revision, JSON.stringify(draft.objectChanges.map((change) => ({ ...change, stale: false })))]);
      // 第一次确认：会后事项算处理完。
      await cq("UPDATE meetings SET status = 'reviewed', version = version + 1, updated_at = now() WHERE id = $1 AND status = 'held'", [meetingId]);
      if (input.writeToWorld) await queueSync(cq, meetingId);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
    logEvent({ event: "meeting_card.confirm", objectRef: `meeting:${meetingId}`, status: kind });
    return { view: await latestView(meetingId, viewer) };
  }

  /** 失败的（或还在等的）这一版重排写入；返回是否重排了。 */
  async function requeue(meetingId: string, revision: number, statuses: string[] = ["failed"]): Promise<boolean> {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const cq: Query = client.query.bind(client);
      const updated = await cq(
        `UPDATE meeting_card_syncs SET event_status = 'pending', event_error = NULL, updated_at = now()
          WHERE meeting_id = $1 AND revision = $2 AND event_status = ANY($3::text[])`,
        [meetingId, revision, statuses],
      );
      if (updated.rowCount) await queueSync(cq, meetingId);
      await client.query("COMMIT");
      return Boolean(updated.rowCount);
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
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

  /** 这场会的本体同步（jobs worker 逐条执行）：按 revision 从早到晚写待写的版本，前次写成的那条在写的时候现找。 */
  async function syncWorld(meetingId: string): Promise<void> {
    const world = deps.meetingWorld;
    if (!world || !UUID_PATTERN.test(meetingId)) return;
    for (;;) {
      const row = (await q(
        `SELECT c.revision, c.kind, c.payload, c.confirmation FROM meeting_card_syncs s
           JOIN meeting_card_confirmations c ON c.meeting_id = s.meeting_id AND c.revision = s.revision
          WHERE s.meeting_id = $1 AND s.event_status = 'pending' ORDER BY s.revision LIMIT 1`,
        [meetingId],
      )).rows[0] as Pick<ConfirmationRow, "revision" | "kind" | "payload" | "confirmation"> | undefined;
      if (!row) return;
      const previous = (await q(
        "SELECT revision, event_id FROM meeting_card_syncs WHERE meeting_id = $1 AND revision < $2 AND event_status = 'succeeded' ORDER BY revision DESC LIMIT 1",
        [meetingId, row.revision],
      )).rows[0] as { revision: number; event_id: string } | undefined;
      try {
        const { eventId } = await world.write({ meetingId, kind: row.kind, payload: row.payload, confirmation: row.confirmation,
          previous: previous ? { eventId: previous.event_id, revision: previous.revision } : null });
        await q("UPDATE meeting_card_syncs SET event_status = 'succeeded', event_id = $3, event_error = NULL, updated_at = now() WHERE meeting_id = $1 AND revision = $2",
          [meetingId, row.revision, eventId]);
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
  return { [MEETING_WORLD_SYNC_KIND]: (payload) => service.syncWorld(String((payload as { meetingId?: unknown }).meetingId)) };
}
