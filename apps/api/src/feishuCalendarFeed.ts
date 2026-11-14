import type { Pool } from "pg";
import type { TFeishuCalendarEvent } from "@warmap/contracts";
import { FeishuApiError } from "./feishu/client.js";
import type { FeishuCalendarApi, FeishuCalendarInstance } from "./feishu/calendar.js";
import type { FeishuEnv } from "./feishu/config.js";
import { activeUserAccessToken } from "./feishu/minutes.js";
import { logEvent } from "./observability.js";

/**
 * 飞书日程只读显示（10/28 定 A）：连了飞书的人，读本人飞书主日历接下来 7 天的日程，在「会议安排」里和天枢的会排在一起，标「飞书日程」。
 * 只显示：不建天枢会议、不进会议链路、不写本体。天枢自己约的会（meetings.feishu_event_id）不重复列；取消的、本人拒绝或被移出的不列；已经结束的不列。
 * 首页 10–20 秒轮询一次，按人缓存 5 分钟，不每次都问飞书；读失败记日志、1 分钟后再试，期间返回空。
 */
const RANGE_MS = 7 * 24 * 60 * 60 * 1000;
const CACHE_MS = 5 * 60 * 1000;
const FAILURE_CACHE_MS = 60 * 1000;
const HIDDEN_RSVP = new Set(["decline", "removed"]);

export type FeishuCalendarFeedService = { listFor(personId: string): Promise<TFeishuCalendarEvent[]> };

/** 日程视图给的是「这一次」的 id：单次日程是「日程 id_0」，重复日程是「日程 id_开始时间」；去掉末尾的 _数字 才对得上天枢存的日程 id。 */
const baseEventId = (instanceId: string) => instanceId.replace(/_\d+$/, "");

/** 全天日程只有日期：按北京时间当天 0 点算。 */
function instant(time: FeishuCalendarInstance["start"]): Date | null {
  if (time.timestamp) return new Date(Number(time.timestamp) * 1000);
  if (time.date) return new Date(`${time.date}T00:00:00+08:00`);
  return null;
}

export function createFeishuCalendarFeedService({ pool, feishu, now = () => new Date() }: {
  pool: Pool;
  feishu?: { env: Pick<FeishuEnv, "tokenKey" | "tokenKeyVersion">; api: FeishuCalendarApi };
  now?: () => Date;
}): FeishuCalendarFeedService {
  const q = pool.query.bind(pool);
  const cache = new Map<string, { token: string; until: number; events: TFeishuCalendarEvent[] }>();
  const calendars = new Map<string, string>();

  async function read(personId: string, at: Date, token: string): Promise<TFeishuCalendarEvent[]> {
    if (!feishu) return [];
    let calendarId = calendars.get(personId);
    if (!calendarId) {
      calendarId = await feishu.api.primaryCalendarId(token);
      calendars.set(personId, calendarId);
    }
    const instances = (await feishu.api.listInstances(token, calendarId, at, new Date(at.getTime() + RANGE_MS)))
      .filter((item) => item.status !== "cancelled" && !HIDDEN_RSVP.has(item.selfRsvpStatus ?? ""));
    const ids = [...new Set(instances.flatMap((item) => [item.eventId,baseEventId(item.eventId)]))];
    const booked = new Set(ids.length
      ? (await q("SELECT feishu_event_id FROM meetings WHERE feishu_event_id=ANY($1::text[])",[ids])).rows.map((row) => String(row.feishu_event_id))
      : []);
    return instances.flatMap((item) => {
      const startsAt = instant(item.start);
      const endsAt = instant(item.end);
      if (!startsAt || !endsAt || endsAt.getTime() <= at.getTime() || booked.has(item.eventId) || booked.has(baseEventId(item.eventId))) return [];
      return [{ eventId: item.eventId, title: item.summary.trim() || "无主题日程", startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString(),
        allDay: !item.start.timestamp, url: item.appLink }];
    }).sort((a, b) => a.startsAt.localeCompare(b.startsAt));
  }

  return {
    async listFor(personId) {
      const at = now();
      const token = feishu && await activeUserAccessToken(q, feishu.env, personId, at);
      if (!token) {
        cache.delete(personId);
        calendars.delete(personId);
        return [];
      }
      const hit = cache.get(personId);
      if (hit && hit.token === token && hit.until > at.getTime()) return hit.events.filter((event) => Date.parse(event.endsAt) > at.getTime());
      if (hit && hit.token !== token) calendars.delete(personId);
      try {
        const events = await read(personId, at, token);
        cache.set(personId, { token, until: at.getTime() + CACHE_MS, events });
        return events;
      } catch (error) {
        // 授权失效（重新连飞书后）换了主日历也能自愈：下次重新取主日历。
        calendars.delete(personId);
        cache.set(personId, { token, until: at.getTime() + FAILURE_CACHE_MS, events: [] });
        logEvent({ event: "feishu.calendar_feed", objectRef: `person:${personId}`, status: "failed", errorCode: error instanceof FeishuApiError ? String(error.code) : "FEISHU_CALENDAR_FEED" });
        return [];
      }
    },
  };
}
