import { FeishuApiError } from "./client.js";

/**
 * 飞书日历的适配层（天枢约会时自动在飞书约上，meetingFeishuEvent.ts）。都用建会的人本人的 user_access_token（用户身份），他就是组织者：
 * - 主日历：POST /calendar/v4/calendars/primary → data.calendars[0].calendar.calendar_id（calendar:calendar:readonly）
 * - 建日程：POST /calendar/v4/calendars/{calendar_id}/events?idempotency_key=<会议 id>（calendar:calendar.event:create）；
 *   起止是秒级 timestamp 字符串 + timezone，vchat.vc_type = "vc" 是飞书视频会议，vchat.meeting_settings.auto_record 开自动录制；
 *   返回 data.event.event_id、vchat.meeting_url（会议链接；没有时用 app_link 打开日程）
 * - 加参与人：POST /calendar/v4/calendars/{calendar_id}/events/{event_id}/attendees?user_id_type=open_id，
 *   body {attendees: [{type: "user", user_id}], need_notification: true}（calendar:calendar.event:update）
 * - 改时间：PATCH /calendar/v4/calendars/{calendar_id}/events/{event_id}，body {summary, start_time, end_time, need_notification}（calendar:calendar.event:update）
 * - 删除：DELETE /calendar/v4/calendars/{calendar_id}/events/{event_id}?need_notification=true（calendar:calendar.event:delete）
 * 路径、参数和字段按 lark-cli 1.0.93 的 `lark-cli schema calendar.calendars.primary / calendar.events.create / calendar.events.patch /
 * calendar.events.delete / calendar.event.attendees.create` 与 `lark-cli calendar +create / +update / +delete --dry-run` 打出的请求核对（10/21）。
 * 建日程还没在真飞书上跑过，等后台开通日历权限后验证（特别是建好时 vchat.meeting_url 有没有值）。
 */
const OPEN_API = "https://open.feishu.cn/open-apis";
const TIMEOUT_MS = 15_000;
const TIMEZONE = "Asia/Shanghai";

export type FeishuCalendarEventInput = { summary: string; start: Date; end: Date };
export type FeishuCalendarEvent = { eventId: string; joinUrl: string | null };

export type FeishuCalendarApi = {
  primaryCalendarId(userAccessToken: string): Promise<string>;
  /** idempotencyKey 相同的重复请求不会建第二个日程。 */
  createEvent(userAccessToken: string, calendarId: string, input: FeishuCalendarEventInput, idempotencyKey: string): Promise<FeishuCalendarEvent>;
  addAttendees(userAccessToken: string, calendarId: string, eventId: string, openIds: string[]): Promise<void>;
  updateEvent(userAccessToken: string, calendarId: string, eventId: string, input: FeishuCalendarEventInput): Promise<void>;
  deleteEvent(userAccessToken: string, calendarId: string, eventId: string): Promise<void>;
};

type Fetch = typeof fetch;
const at = (date: Date) => ({ timestamp: String(Math.floor(date.getTime() / 1000)), timezone: TIMEZONE });
const eventPath = (calendarId: string, eventId?: string) =>
  `/calendar/v4/calendars/${encodeURIComponent(calendarId)}/events${eventId ? `/${encodeURIComponent(eventId)}` : ""}`;

export function createFeishuCalendarApi({ fetch: fetchImpl = fetch }: { fetch?: Fetch } = {}): FeishuCalendarApi {
  async function call(userAccessToken: string, path: string, init: RequestInit = {}): Promise<Record<string, unknown>> {
    const response = await fetchImpl(`${OPEN_API}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${userAccessToken}`, "content-type": "application/json; charset=utf-8", ...(init.headers ?? {}) },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const text = await response.text();
    let body: Record<string, unknown>;
    try { body = JSON.parse(text) as Record<string, unknown>; } catch { throw new FeishuApiError(0, `飞书接口返回了非 JSON 响应（HTTP ${response.status}）`, response.status); }
    const code = Number(body.code ?? -1);
    if (code !== 0) throw new FeishuApiError(code, String(body.msg ?? "飞书接口失败"), response.status);
    return (body.data ?? {}) as Record<string, unknown>;
  }
  return {
    async primaryCalendarId(userAccessToken) {
      const data = await call(userAccessToken, "/calendar/v4/calendars/primary", { method: "POST" });
      const id = ((data.calendars ?? []) as { calendar?: { calendar_id?: unknown } }[])[0]?.calendar?.calendar_id;
      if (typeof id !== "string" || !id) throw new FeishuApiError(0, "飞书没有返回主日历");
      return id;
    },
    async createEvent(userAccessToken, calendarId, input, idempotencyKey) {
      const data = await call(userAccessToken, `${eventPath(calendarId)}?idempotency_key=${encodeURIComponent(idempotencyKey)}`, {
        method: "POST",
        body: JSON.stringify({
          summary: input.summary,
          start_time: at(input.start),
          end_time: at(input.end),
          vchat: { vc_type: "vc", meeting_settings: { auto_record: true } },
        }),
      });
      const event = (data.event ?? {}) as { event_id?: unknown; app_link?: unknown; vchat?: { meeting_url?: unknown } };
      if (typeof event.event_id !== "string" || !event.event_id) throw new FeishuApiError(0, "飞书没有返回日程 ID");
      const link = [event.vchat?.meeting_url, event.app_link].find((value): value is string => typeof value === "string" && value.length > 0);
      return { eventId: event.event_id, joinUrl: link ?? null };
    },
    async addAttendees(userAccessToken, calendarId, eventId, openIds) {
      await call(userAccessToken, `${eventPath(calendarId, eventId)}/attendees?user_id_type=open_id`, {
        method: "POST",
        body: JSON.stringify({ attendees: openIds.map((openId) => ({ type: "user", user_id: openId })), need_notification: true }),
      });
    },
    async updateEvent(userAccessToken, calendarId, eventId, input) {
      await call(userAccessToken, eventPath(calendarId, eventId), {
        method: "PATCH",
        body: JSON.stringify({ summary: input.summary, start_time: at(input.start), end_time: at(input.end), need_notification: true }),
      });
    },
    async deleteEvent(userAccessToken, calendarId, eventId) {
      await call(userAccessToken, `${eventPath(calendarId, eventId)}?need_notification=true`, { method: "DELETE" });
    },
  };
}
