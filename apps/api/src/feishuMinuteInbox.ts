import type { Pool } from "pg";
import type { TFeishuMinuteInboxItem, TFeishuMinutePerson, TWorldAnchor } from "@warmap/contracts";
import { FeishuApiError } from "./feishu/client.js";
import type { FeishuEnv } from "./feishu/config.js";
import { activeUserAccessToken, isMeetingMinute, type FeishuMinutesApi } from "./feishu/minutes.js";
import { feishuConnected } from "./feishu/oauth.js";
import { enqueueJob, type JobHandler, type RecurringJob } from "./jobs.js";
import { minuteFromEvent, type MeetingMinutesService } from "./meetingMinutes.js";
import type { Query } from "./meetingStore.js";
import { logEvent } from "./observability.js";
import type { PeopleDirectory } from "./peopleDirectory.js";

/**
 * 飞书里直接开的会待整理（204_feishu_minute_inbox.sql）：上线后飞书视频会议生成、还没对上天枢会议的妙记，只给所有者本人。
 * - 发现：每 5 分钟扫一次连好飞书的人名下最近 7 天的妙记（「妙记生成」事件另排一次），只用所有者本人的授权读；
 *   只收视频会议生成的、本人名下的、上线以后生成的，已登记或已挂在天枢会上的不再查；
 * - 列表：本人待整理、7 天以内的，新的在前；参会人按飞书实际参会名单对到人员目录，所有者排第一；
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

type InboxRow = { minute_token: string; title: string; starts_at: Date; ends_at: Date; attendee_open_ids: string[] };

export function createFeishuMinuteInboxService(deps: {
  pool: Pool;
  peopleDirectory: PeopleDirectory;
  /** Task 3 整理、记到时用。 */
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

  /** 本人待整理的妙记（7 天以内，新的在前）。 */
  async function listFor(ownerId: string): Promise<TFeishuMinuteInboxItem[]> {
    const rows = (await q(
      `SELECT minute_token, title, starts_at, ends_at, attendee_open_ids FROM feishu_minute_inbox
        WHERE owner_id = $1 AND status = 'pending' AND starts_at > $2 ORDER BY starts_at DESC`,
      [ownerId, new Date(now().getTime() - MINUTE_INBOX_WINDOW_MS)],
    )).rows as InboxRow[];
    if (!rows.length) return [];
    const openIds = [...new Set(rows.flatMap((row) => row.attendee_open_ids))];
    const personOf = new Map(openIds.length
      ? (await q("SELECT open_id, person_id FROM feishu_identities WHERE open_id = ANY($1::text[])", [openIds])).rows.map((row) => [row.open_id as string, row.person_id as string])
      : []);
    const people = directory();
    return rows.map((row) => {
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
        attendees, otherAttendees, suggestion: null };
    });
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

  return { scan, afterMinuteEvent, listFor, ignore };
}

export type FeishuMinuteInboxService = ReturnType<typeof createFeishuMinuteInboxService>;

export function feishuMinuteInboxJobs(service: FeishuMinuteInboxService): { handlers: Record<string, JobHandler>; recurring: RecurringJob[] } {
  return {
    handlers: { [MINUTE_INBOX_SCAN_KIND]: async () => { await service.scan(); } },
    recurring: [{ kind: MINUTE_INBOX_SCAN_KIND, everyMs: SCAN_EVERY_MS }],
  };
}
