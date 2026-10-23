import type { Pool } from "pg";
import type {
  TFeishuMinuteInboxItem, TFeishuMinuteMeetingResponse, TFeishuMinutePerson, TFeishuMinuteSuggestion, TOrganizeFeishuMinuteRequest, TWorldAnchor,
} from "@warmap/contracts";
import { FeishuApiError } from "./feishu/client.js";
import type { FeishuEnv } from "./feishu/config.js";
import { activeUserAccessToken, isMeetingMinute, type FeishuMinutesApi } from "./feishu/minutes.js";
import { feishuConnected } from "./feishu/oauth.js";
import { enqueueJob, type JobHandler, type RecurringJob } from "./jobs.js";
import { minuteFromEvent, type MeetingMinutesService } from "./meetingMinutes.js";
import { insertMinuteMeeting, resolveAnchors, resolveParticipants } from "./meetings.js";
import type { Query } from "./meetingStore.js";
import { logEvent } from "./observability.js";
import type { PeopleDirectory } from "./peopleDirectory.js";
import { shanghaiDate } from "./workdays.js";

/**
 * 飞书里直接开的会待整理（204_feishu_minute_inbox.sql）：上线后飞书视频会议生成、还没对上天枢会议的妙记，只给所有者本人。
 * - 发现：每 5 分钟扫一次连好飞书的人名下最近 7 天的妙记（「妙记生成」事件另排一次），只用所有者本人的授权读；
 *   只收视频会议生成的、本人名下的、上线以后生成的，已登记或已挂在天枢会上的不再查；
 * - 列表：本人待整理、7 天以内的，新的在前；参会人按飞书实际参会名单对到人员目录，所有者排第一；
 * - 整理：本人待整理的建成一场已开完的会（所有者主持，参会人按飞书实际参会名单），再排一次后台任务用所有者本人的授权读妙记；
 * - 记到：属于天枢里约好的会的（列表里带建议），本人记到那场会上，同样排一次后台任务读妙记；轮询自动挂上的也记为已记到（meetingMinutes.ts）；
 * - 忽略：本人待整理的置为已忽略，不再提示。
 */
export const MINUTE_INBOX_SCAN_KIND = "meeting.minute_inbox_scan";
export const MINUTE_INBOX_INGEST_KIND = "meeting.minute_inbox_ingest";
export const MINUTE_INBOX_WINDOW_MS = 7 * 24 * 60 * 60_000;
const SCAN_EVERY_MS = 5 * 60_000;
const DEFAULT_TITLE = "飞书会议";

export type MinuteInboxError = { status: 400 | 404 | 409; code: string; message: string; fieldErrors?: Record<string, string> };

const MINUTE_NOT_FOUND: MinuteInboxError = { status: 404, code: "MINUTE_NOT_FOUND", message: "妙记不存在" };
const MINUTE_NOT_PENDING: MinuteInboxError = { status: 409, code: "MINUTE_NOT_PENDING", message: "这份妙记已经整理过了" };
const MINUTE_TAKEN: MinuteInboxError = { status: 409, code: "MINUTE_TAKEN", message: "这份妙记已经对到别的会上了" };

const SUGGESTION_CHANGED: MinuteInboxError = { status: 409, code: "SUGGESTION_CHANGED", message: "这份妙记对得上的会变了" };
/** 妙记的开始时刻和会议计划开始时刻最多差多少还算同一场会（与自动挂一致）。 */
const SUGGESTION_WINDOW = "interval '3 hours'";
/** 能记妙记的会：待开、还没对上妙记、用户也没上传过记录（不覆盖用户上传的）。 */
const OPEN_FOR_MINUTE = "status = 'scheduled' AND minute_token IS NULL AND transcript IS NULL AND transcript_candidate IS NULL";

type InboxRow = { minute_token: string; title: string; starts_at: Date; ends_at: Date; attendee_open_ids: string[]; feishu_meeting_id: string };
type OwnedRow = InboxRow & { status: string; meeting_id: string | null };

/**
 * 这份妙记属于天枢里约好的哪场会（只在能记妙记的会里找）：先按飞书会议号对（不看所有者是谁，取最早的一场）；
 * 没有时，在所有者主持或建的会里取计划开始离妙记开始最近的一场（3 小时以内；会上已有别的飞书会议号也算，由本人确认）。都没有为 null。
 */
export async function suggestionFor(q: Query, row: { owner_id: string; feishu_meeting_id: string; starts_at: Date }): Promise<TFeishuMinuteSuggestion | null> {
  const byFeishuId = (await q(`SELECT id, title FROM meetings WHERE ${OPEN_FOR_MINUTE} AND feishu_meeting_id = $1 ORDER BY scheduled_at LIMIT 1`,
    [row.feishu_meeting_id])).rows[0];
  const found = byFeishuId ?? (await q(
    `SELECT id, title FROM meetings WHERE ${OPEN_FOR_MINUTE} AND (lead_dri_id = $1 OR COALESCE(created_by, lead_dri_id) = $1)
       AND scheduled_at BETWEEN $2::timestamptz - ${SUGGESTION_WINDOW} AND $2::timestamptz + ${SUGGESTION_WINDOW}
     ORDER BY abs(extract(epoch FROM scheduled_at - $2::timestamptz)), scheduled_at LIMIT 1`,
    [row.owner_id, row.starts_at])).rows[0];
  return found ? { meetingId: found.id as string, title: found.title as string } : null;
}

export function createFeishuMinuteInboxService(deps: {
  pool: Pool;
  peopleDirectory: PeopleDirectory;
  /** 整理、记到以后用所有者本人的授权读妙记。 */
  minutes: MeetingMinutesService;
  anchorChoicesFor: (period: string) => Promise<TWorldAnchor[]>;
  /** 飞书没配时为空：扫描直接返回 0。 */
  feishu?: { env: Pick<FeishuEnv, "tokenKey" | "tokenKeyVersion">; api: FeishuMinutesApi };
  now?: () => Date;
}) {
  const { pool, peopleDirectory, feishu } = deps;
  const now = deps.now ?? (() => new Date());
  const q: Query = pool.query.bind(pool);
  const directory = () => new Map(peopleDirectory.searchPeople(undefined).map((person) => [person.personId, person]));

  /** 扫描：连好飞书、在人员目录里的人，各用本人授权列名下的妙记，登记新的待整理；一个人出错不影响下一个人。返回新登记几条。 */
  async function scan(): Promise<number> {
    if (!feishu) return 0;
    const at = now();
    const launchedAt = (await q("SELECT launched_at FROM feishu_minute_inbox_launch")).rows[0].launched_at as Date;
    const range = { start: new Date(Math.max(launchedAt.getTime(), at.getTime() - MINUTE_INBOX_WINDOW_MS)), end: at };
    const known: ReadonlySet<string> = new Set((await q(
      "SELECT minute_token FROM feishu_minute_inbox UNION SELECT minute_token FROM meetings WHERE minute_token IS NOT NULL",
    )).rows.map((row) => row.minute_token as string));
    const people = directory();
    const connected = ((await q(
      `SELECT i.person_id, i.open_id FROM feishu_identities i JOIN feishu_user_tokens t ON t.person_id = i.person_id
        WHERE t.status = 'active' ORDER BY i.person_id`,
    )).rows as { person_id: string; open_id: string }[]).filter((row) => people.has(row.person_id));
    let registered = 0;
    for (const person of connected) {
      try {
        if (!await feishuConnected(q, feishu.env, person.person_id, at)) continue;
        const token = await activeUserAccessToken(q, feishu.env, person.person_id, at);
        if (!token) continue;
        for (const minute of await feishu.api.listMinutes(token, { openId: person.open_id }, range, known)) {
          if (!isMeetingMinute(minute) || (minute.ownerOpenId && minute.ownerOpenId !== person.open_id)) continue;
          if (!minute.createdAt || minute.createdAt.getTime() < launchedAt.getTime()) continue;
          const attendees = await feishu.api.meetingParticipants(token, minute.meetingId!).catch(() => [] as string[]);
          const endsAt = new Date(minute.createdAt.getTime() + (minute.durationSeconds ?? 0) * 1000);
          const inserted = await q(
            `INSERT INTO feishu_minute_inbox (minute_token, owner_id, title, starts_at, ends_at, feishu_meeting_id, attendee_open_ids)
             VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb) ON CONFLICT (minute_token) DO NOTHING`,
            [minute.token, person.person_id, (minute.title.trim() || DEFAULT_TITLE).slice(0, 200), minute.createdAt, endsAt, minute.meetingId, JSON.stringify(attendees)],
          );
          if (!inserted.rowCount) continue;
          registered += 1;
          logEvent({ event: "feishu_minute_inbox", objectRef: `feishu_minute:${minute.token}`, status: "registered" });
        }
      } catch (error) {
        logEvent({ event: "feishu_minute_inbox", objectRef: `person:${person.person_id}`, status: "scan_failed",
          errorCode: error instanceof FeishuApiError ? String(error.code) : "SCAN_FAILED" });
      }
    }
    return registered;
  }

  /** 「妙记生成」事件：来源是飞书会议的，马上排一次扫描（同一份妙记只排一次）。 */
  async function afterMinuteEvent(payload: Record<string, unknown>): Promise<void> {
    const found = minuteFromEvent(payload);
    if (!found?.feishuMeetingId) return;
    await enqueueJob(q, { kind: MINUTE_INBOX_SCAN_KIND, dedupeKey: `${MINUTE_INBOX_SCAN_KIND}:event:${found.minuteToken}` });
  }

  /** 本人待整理的妙记（7 天以内，新的在前；妙记已挂在天枢会上的不列）。 */
  async function listFor(ownerId: string): Promise<TFeishuMinuteInboxItem[]> {
    const rows = (await q(
      `SELECT minute_token, title, starts_at, ends_at, attendee_open_ids, feishu_meeting_id FROM feishu_minute_inbox
        WHERE owner_id = $1 AND status = 'pending' AND starts_at > $2
          AND NOT EXISTS (SELECT 1 FROM meetings m WHERE m.minute_token = feishu_minute_inbox.minute_token) ORDER BY starts_at DESC`,
      [ownerId, new Date(now().getTime() - MINUTE_INBOX_WINDOW_MS)],
    )).rows as InboxRow[];
    if (!rows.length) return [];
    const openIds = [...new Set(rows.flatMap((row) => row.attendee_open_ids))];
    const personOf = new Map(openIds.length
      ? (await q("SELECT open_id, person_id FROM feishu_identities WHERE open_id = ANY($1::text[])", [openIds])).rows.map((row) => [row.open_id as string, row.person_id as string])
      : []);
    const people = directory();
    return Promise.all(rows.map(async (row) => {
      const attendees: TFeishuMinutePerson[] = [];
      const add = (personId: string) => {
        const person = people.get(personId);
        if (person && !attendees.some((item) => item.personId === personId)) attendees.push({ personId, displayName: person.displayName });
      };
      add(ownerId);
      let otherAttendees = 0;
      for (const openId of row.attendee_open_ids) {
        const personId = personOf.get(openId);
        if (personId && people.has(personId)) add(personId);
        else otherAttendees += 1;
      }
      return { minuteToken: row.minute_token, title: row.title, startsAt: row.starts_at.toISOString(), endsAt: row.ends_at.toISOString(),
        attendees, otherAttendees, suggestion: await suggestionFor(q, { owner_id: ownerId, feishu_meeting_id: row.feishu_meeting_id, starts_at: row.starts_at }) };
    }));
  }

  const ownedRow = async (query: Query, ownerId: string, minuteToken: string, lock = "") => ((await query(
    `SELECT minute_token, title, starts_at, ends_at, attendee_open_ids, status, meeting_id, feishu_meeting_id FROM feishu_minute_inbox
      WHERE minute_token = $1 AND owner_id = $2 ${lock}`, [minuteToken, ownerId])).rows[0] as OwnedRow | undefined);
  /** 本人这行能不能整理：没有 404；已整理的返回那场会；不是待整理 409；待整理为 null。 */
  const organizeState = (row: OwnedRow | undefined): TFeishuMinuteMeetingResponse | { error: MinuteInboxError } | null =>
    !row ? { error: MINUTE_NOT_FOUND } : row.status === "organized" ? { meetingId: row.meeting_id! } : row.status !== "pending" ? { error: MINUTE_NOT_PENDING } : null;

  /**
   * 整理：本人待整理的建成一场已开完的会（起止取妙记，所有者主持，挂点在开会那个月的选项里，参会人 = CEO、所有者、飞书实际参会人里对得上人员目录的），
   * 行锁里再判一次（连点、两个标签页只成一场，后到的拿到同一场）；妙记已被别的会挂走 409。建好后排一次读妙记。
   */
  async function organize(ownerId: string, minuteToken: string, input: TOrganizeFeishuMinuteRequest): Promise<TFeishuMinuteMeetingResponse | { error: MinuteInboxError }> {
    const title = input.title.trim();
    if (!title) return { error: { status: 400, code: "INVALID_INPUT", message: "会名不能为空", fieldErrors: { title: "required" } } };
    const row = await ownedRow(q, ownerId, minuteToken);
    const state = organizeState(row);
    if (state) return state;
    const anchors = resolveAnchors(input.anchors, await deps.anchorChoicesFor(shanghaiDate(row!.starts_at).slice(0, 7)));
    // 挂点、参会人的错误都是 400。
    if ("error" in anchors) return anchors as { error: MinuteInboxError };
    const ceo = peopleDirectory.searchPeople(undefined).find((person) => person.roles.includes("ceo"));
    if (!ceo) return { error: { status: 400, code: "INVALID_CEO", message: "company-people.v1 中没有 ceo 角色" } };
    const people = directory();
    const personOf = new Map(row!.attendee_open_ids.length
      ? (await q("SELECT open_id, person_id FROM feishu_identities WHERE open_id = ANY($1::text[])", [row!.attendee_open_ids])).rows.map((item) => [item.open_id as string, item.person_id as string])
      : []);
    const attendees = row!.attendee_open_ids.flatMap((openId) => { const personId = personOf.get(openId); return personId && people.has(personId) ? [personId] : []; });
    const resolved = resolveParticipants(peopleDirectory, { leadDriId: ownerId, ceoParticipantId: ceo.personId, participants: attendees }, { requireDriLead: false });
    if ("error" in resolved) return resolved as { error: MinuteInboxError };

    const client = await pool.connect();
    let meetingId: string | null;
    try {
      await client.query("BEGIN");
      const locked = await ownedRow(client.query.bind(client), ownerId, minuteToken, "FOR UPDATE");
      const again = organizeState(locked);
      if (again) {
        await client.query("ROLLBACK");
        return again;
      }
      // 会议要求结束晚于开始：妙记没有时长时，会议结束取开始后 1 分钟（待整理那条照飞书记）。
      const endsAt = new Date(Math.max(locked!.ends_at.getTime(), locked!.starts_at.getTime() + 60_000));
      meetingId = await insertMinuteMeeting(client, { title, startsAt: locked!.starts_at, endsAt, resolved, worldAnchors: anchors,
        minuteToken, feishuMeetingId: locked!.feishu_meeting_id, now: now() });
      if (!meetingId) {
        await client.query("ROLLBACK");
        return { error: MINUTE_TAKEN };
      }
      await client.query("UPDATE feishu_minute_inbox SET status = 'organized', meeting_id = $2, updated_at = now() WHERE minute_token = $1", [minuteToken, meetingId]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
    await enqueueIngest(minuteToken);
    logEvent({ event: "feishu_minute_inbox", objectRef: `feishu_minute:${minuteToken}`, status: "organized", meetingId });
    return { meetingId };
  }

  /** 整理、记到以后排一次读妙记（同一份妙记只排一次）。 */
  const enqueueIngest = (minuteToken: string) =>
    enqueueJob(q, { kind: MINUTE_INBOX_INGEST_KIND, dedupeKey: `${MINUTE_INBOX_INGEST_KIND}:${minuteToken}`, payload: { minuteToken } });

  /**
   * 记到：本人待整理的妙记记到建议的那场天枢里约好的会（会议号完全一致时，妙记所有者不是主持人也能记），一个事务里行锁重判；
   * 已记到同一场会的返回那场会；建议已经不是这场 409 SUGGESTION_CHANGED；妙记已被别的会挂走 409 MINUTE_TAKEN。记好后排一次读妙记。
   */
  async function attach(ownerId: string, minuteToken: string, meetingId: string): Promise<TFeishuMinuteMeetingResponse | { error: MinuteInboxError }> {
    const client = await pool.connect();
    const cq: Query = client.query.bind(client);
    const settle = async (result: TFeishuMinuteMeetingResponse | { error: MinuteInboxError }) => {
      await client.query("ROLLBACK");
      return result;
    };
    try {
      await client.query("BEGIN");
      const row = await ownedRow(cq, ownerId, minuteToken, "FOR UPDATE");
      if (!row) return await settle({ error: MINUTE_NOT_FOUND });
      if (row.status === "attached" && row.meeting_id === meetingId) return await settle({ meetingId });
      if (row.status !== "pending") return await settle({ error: MINUTE_NOT_PENDING });
      if ((await suggestionFor(cq, { owner_id: ownerId, feishu_meeting_id: row.feishu_meeting_id, starts_at: row.starts_at }))?.meetingId !== meetingId) {
        return await settle({ error: SUGGESTION_CHANGED });
      }
      let updated;
      try {
        updated = await cq(
          `UPDATE meetings SET minute_token = $2, feishu_meeting_id = COALESCE(feishu_meeting_id, $3), minutes_status = 'waiting', minutes_waiting_since = $4,
             minutes_failure = NULL, minutes_error = NULL
           WHERE id = $1 AND ${OPEN_FOR_MINUTE}`,
          [meetingId, minuteToken, row.feishu_meeting_id, now()],
        );
      } catch (error) {
        if ((error as { code?: string }).code === "23505") return await settle({ error: MINUTE_TAKEN });
        throw error;
      }
      if (!updated.rowCount) return await settle({ error: SUGGESTION_CHANGED });
      await cq("UPDATE feishu_minute_inbox SET status = 'attached', meeting_id = $2, updated_at = now() WHERE minute_token = $1", [minuteToken, meetingId]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
    await enqueueIngest(minuteToken);
    logEvent({ event: "feishu_minute_inbox", objectRef: `feishu_minute:${minuteToken}`, status: "attached", meetingId });
    return { meetingId };
  }

  /** 后台读妙记：已整理、已记到的才读，只用所有者本人的授权；原文还没好、临时读不到时抛错，交给任务退避重试。 */
  async function ingestQueued(payload: unknown): Promise<void> {
    const minuteToken = (payload as { minuteToken?: unknown } | null)?.minuteToken;
    if (typeof minuteToken !== "string") return;
    const row = (await q("SELECT owner_id, status, meeting_id FROM feishu_minute_inbox WHERE minute_token = $1", [minuteToken])).rows[0] as
      { owner_id: string; status: string; meeting_id: string | null } | undefined;
    if (!row || (row.status !== "organized" && row.status !== "attached")) return;
    const result = await deps.minutes.ingestForOwner(row.meeting_id!, minuteToken, row.owner_id);
    if (result === "not_ready") throw new Error("MINUTES_NOT_READY");
    if (result === "fetch_failed") throw new Error("MINUTES_FETCH_FAILED");
  }

  /** 忽略：本人待整理的置为已忽略（已忽略的再点照样成功）；已整理、已记到的 409；别人的或没有的 404。 */
  async function ignore(ownerId: string, minuteToken: string): Promise<{ ok: true } | { error: MinuteInboxError }> {
    const changed = await q(
      "UPDATE feishu_minute_inbox SET status = 'ignored', updated_at = now() WHERE minute_token = $1 AND owner_id = $2 AND status = 'pending'",
      [minuteToken, ownerId],
    );
    if (changed.rowCount) {
      logEvent({ event: "feishu_minute_inbox", objectRef: `feishu_minute:${minuteToken}`, status: "ignored" });
      return { ok: true };
    }
    const status = (await q("SELECT status FROM feishu_minute_inbox WHERE minute_token = $1 AND owner_id = $2", [minuteToken, ownerId])).rows[0]?.status as string | undefined;
    if (!status) return { error: MINUTE_NOT_FOUND };
    return status === "ignored" ? { ok: true } : { error: MINUTE_NOT_PENDING };
  }

  return { scan, afterMinuteEvent, listFor, organize, attach, ingestQueued, ignore };
}

export type FeishuMinuteInboxService = ReturnType<typeof createFeishuMinuteInboxService>;

export function feishuMinuteInboxJobs(service: FeishuMinuteInboxService): { handlers: Record<string, JobHandler>; recurring: RecurringJob[] } {
  return {
    handlers: { [MINUTE_INBOX_SCAN_KIND]: async () => { await service.scan(); }, [MINUTE_INBOX_INGEST_KIND]: (payload) => service.ingestQueued(payload) },
    recurring: [{ kind: MINUTE_INBOX_SCAN_KIND, everyMs: SCAN_EVERY_MS }],
  };
}
