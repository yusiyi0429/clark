import type { Pool } from "pg";
import type { ActionScope } from "./actionToken.js";
import type { FeishuCalendarApi } from "./feishu/calendar.js";
import { FeishuApiError } from "./feishu/client.js";
import type { FeishuEnv } from "./feishu/config.js";
import { activeUserAccessToken } from "./feishu/minutes.js";
import { FEISHU_CALENDAR_SCOPES } from "./feishu/oauth.js";
import { enqueueJob, type JobHandler } from "./jobs.js";
import { appendFingerprint, commit, getMeetingRow, updateMeeting, withMeetingLock, type MeetingActionOutcome, type MeetingRow, type Query } from "./meetingStore.js";
import { logEvent } from "./observability.js";

/**
 * 天枢约会时自动在飞书约上：会后飞书妙记自然归组织者，按「主持人→建会的人」的授权就找得到（meetingMinutes.ts）。
 * - 用建会的人（没记按主持人）本人的飞书授权，在他的主日历建日程：标题、起止同会议，带飞书视频会议、开自动录制；
 *   参会人按飞书身份（feishu_identities）的 open_id 加为日程参与人（发邀请），没有飞书身份的跳过，组织者本人不重复加；
 * - 建会（预约、配置页、议题建会）后排一个后台任务去约，不挡建会；飞书报错记 failed 和原因，按队列的退避重试，主持人也能点重试；
 * - 建会的人还没连飞书（或授权里没有日历权限）：记 waiting_auth，他连上飞书后补约他名下还没开始的会；
 * - 改时间（重新安排、编辑会议）更新日程，换主持带进来的新参会人补发邀请；取消会议删除日程。
 * 一次任务按会议当前的样子对齐飞书日程（没约过就建，约过就改，取消了就删），先后排的几次任务谁先跑都一样。
 */
export const MEETING_FEISHU_EVENT_KIND = "meeting.feishu_event";

export type MeetingFeishuEventDeps = {
  pool: Pool;
  /** 飞书没配时为空：不约。 */
  feishu?: { env: Pick<FeishuEnv, "tokenKey" | "tokenKeyVersion">; api: FeishuCalendarApi };
  now?: () => Date;
};

type SyncPayload = { meetingId: string; invite?: string[] };

export function createMeetingFeishuEventService(deps: MeetingFeishuEventDeps) {
  const { pool, feishu } = deps;
  const now = deps.now ?? (() => new Date());
  const q: Query = pool.query.bind(pool);

  const organizerOf = (row: MeetingRow) => row.feishu_event_organizer_id ?? row.created_by ?? row.lead_dri_id;

  async function setStatus(meetingId: string, status: NonNullable<MeetingRow["feishu_event_status"]>, error: string | null = null): Promise<void> {
    await q("UPDATE meetings SET feishu_event_status = $2, feishu_event_error = $3 WHERE id = $1", [meetingId, status, error]);
  }

  /** 本人能用来约会的授权：授权有效，且里面有日历权限；否则 null。 */
  async function calendarToken(personId: string): Promise<string | null> {
    if (!feishu) return null;
    const token = await activeUserAccessToken(q, feishu.env, personId, now());
    if (!token) return null;
    const granted = new Set(String((await q("SELECT scope FROM feishu_user_tokens WHERE person_id = $1", [personId])).rows[0]?.scope ?? "").split(/\s+/));
    return FEISHU_CALENDAR_SCOPES.every((scope) => granted.has(scope)) ? token : null;
  }

  /** 要邀请的人的 open_id：组织者本人不加，没有飞书身份的跳过。 */
  async function openIdsOf(personIds: string[], organizerId: string): Promise<string[]> {
    const ids = personIds.filter((id) => id !== organizerId);
    if (!ids.length) return [];
    return (await q("SELECT open_id FROM feishu_identities WHERE person_id = ANY($1::text[]) ORDER BY person_id", [ids])).rows.map((row) => row.open_id as string);
  }

  /**
   * 排一次对齐。trigger 区分这一次（进去重键）：create 建会（记 pending 和组织者；重放不改已有状态），其余只对已经在约的会排。
   * invite 是这次新加进来的参会人（换主持时）。
   */
  async function schedule(meetingId: string, trigger: string, invite: string[] = []): Promise<void> {
    if (!feishu) return;
    if (trigger === "create") {
      await q(`UPDATE meetings SET feishu_event_status = 'pending', feishu_event_organizer_id = COALESCE(created_by, lead_dri_id)
        WHERE id = $1 AND feishu_event_status IS NULL`, [meetingId]);
    } else if (!(await q("SELECT 1 FROM meetings WHERE id = $1 AND feishu_event_status IS NOT NULL", [meetingId])).rowCount) {
      return;
    }
    await enqueueJob(q, { kind: MEETING_FEISHU_EVENT_KIND, dedupeKey: `${MEETING_FEISHU_EVENT_KIND}:${meetingId}:${trigger}`,
      payload: { meetingId, ...(invite.length ? { invite } : {}) } satisfies SyncPayload });
  }

  /**
   * 按会议当前的样子对齐飞书日程。飞书报错记 failed 和原因再抛出去（队列按退避重试）。
   * 日程建好就先记下（取消时删得掉）；参与人加好才算 booked，没到 booked 的下一次把参会人整批再加一遍。
   */
  async function sync({ meetingId, invite = [] }: SyncPayload): Promise<void> {
    if (!feishu) return;
    const row = await getMeetingRow(q, meetingId);
    if (!row?.feishu_event_status || row.feishu_event_status === "cancelled") return;
    const cancelled = row.status === "cancelled";
    if (cancelled && !row.feishu_event_id) return setStatus(meetingId, "cancelled");
    // 开过的会不再动；还没约上、会已经过了的也不再约。
    if (!cancelled && (row.status !== "scheduled" || (!row.feishu_event_id && row.ends_at.getTime() <= now().getTime()))) return;
    const organizerId = organizerOf(row);
    const token = await calendarToken(organizerId);
    if (!token) return setStatus(meetingId, "waiting_auth");
    const { api } = feishu;
    try {
      if (cancelled) {
        await api.deleteEvent(token, row.feishu_calendar_id!, row.feishu_event_id!);
        return await setStatus(meetingId, "cancelled");
      }
      const input = { summary: row.title, start: row.scheduled_at, end: row.ends_at };
      let calendarId = row.feishu_calendar_id;
      let eventId = row.feishu_event_id;
      if (calendarId && eventId) {
        await api.updateEvent(token, calendarId, eventId, input);
      } else {
        calendarId = await api.primaryCalendarId(token);
        const event = await api.createEvent(token, calendarId, input, row.id);
        eventId = event.eventId;
        await q("UPDATE meetings SET feishu_calendar_id = $2, feishu_event_id = $3, feishu_event_join_url = $4, feishu_event_organizer_id = $5 WHERE id = $1",
          [meetingId, calendarId, eventId, event.joinUrl, organizerId]);
      }
      const openIds = await openIdsOf(row.feishu_event_status === "booked" ? invite : row.participants.map((person) => person.personId), organizerId);
      if (openIds.length) await api.addAttendees(token, calendarId, eventId, openIds);
      await setStatus(meetingId, "booked");
    } catch (error) {
      const message = (error as Error).message || "飞书接口失败";
      await setStatus(meetingId, "failed", message.slice(0, 500));
      logEvent({ event: "meeting.feishu_event", objectRef: `meeting:${meetingId}`, status: "failed", errorCode: error instanceof FeishuApiError ? String(error.code) : "FEISHU_EVENT" });
      throw error;
    }
  }

  /** 有人刚连上飞书：他约的、等他连飞书的会里还没开始的（以及已经取消、日程还没删的）补上。返回排了几场。 */
  async function resumeFor(personId: string): Promise<number> {
    if (!feishu) return 0;
    const at = now();
    const resumed = await q(
      `UPDATE meetings SET feishu_event_status = 'pending', feishu_event_error = NULL
        WHERE feishu_event_status = 'waiting_auth' AND COALESCE(feishu_event_organizer_id, created_by, lead_dri_id) = $1
          AND ((status = 'scheduled' AND scheduled_at > $2) OR (status = 'cancelled' AND feishu_event_id IS NOT NULL))
        RETURNING id`,
      [personId, at],
    );
    for (const { id } of resumed.rows as { id: string }[]) await schedule(id, `connect:${at.getTime()}`);
    return resumed.rowCount ?? 0;
  }

  /** 「重试」（meeting.retry_feishu_booking）：约失败的会回到 pending，马上排一次。 */
  async function retry(secret: string, scope: ActionScope, fingerprint: string, hostId?: string): Promise<MeetingActionOutcome> {
    const result = await withMeetingLock(pool, scope.objectId, secret, fingerprint, scope.objectVersion, async (client, row) => {
      if (row.status !== "scheduled" || row.feishu_event_status !== "failed")
        return { error: { status: 409, code: "FEISHU_BOOKING_NOT_FAILED", message: "只有在飞书没约上的会可以重试" } };
      const updated = await updateMeeting(client, row.id,
        "feishu_event_status = 'pending', feishu_event_error = NULL, version = version + 1, action_fingerprints = $2::jsonb",
        [JSON.stringify(appendFingerprint(row.action_fingerprints, fingerprint))]);
      return commit(client, updated, secret);
    }, hostId);
    if ("card" in result && !result.replayed) await schedule(scope.objectId, `retry:${result.card.version}`);
    return result;
  }

  return { schedule, sync, resumeFor, retry };
}

export type MeetingFeishuEventService = ReturnType<typeof createMeetingFeishuEventService>;

export function meetingFeishuEventJobs(service: MeetingFeishuEventService): Record<string, JobHandler> {
  return { [MEETING_FEISHU_EVENT_KIND]: (payload) => service.sync(payload as SyncPayload) };
}
