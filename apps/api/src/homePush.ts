import type { Pool } from "pg";
import type { TNotificationSettings, TWaitingItem, TWaitingTarget, TWorkHomeResponse } from "@warmap/contracts";
import { inTransaction } from "./collector.js";
import { FEISHU_NOTIFY_KIND, type FeishuNotice } from "./feishu/notify.js";
import { enqueueJob, type JobHandler, type RecurringJob } from "./jobs.js";
import { logEvent } from "./observability.js";
import type { Query } from "./meetingStore.js";
import { shanghaiLabel } from "./workdays.js";

/**
 * 飞书推送（新首页设计 13.2）：把首页「等你」里急的几件推到本人和天枢机器人的单聊（「天枢伙伴」那条对话），发送走 feishu/notify.ts 的队列。
 * - 推：卡住正在跑的活、而本人 10 分钟内没在网页上打开天枢的（验收两次没过、额度用完要定、批准等了 10 分钟）；
 *   要本人确认、离截止不到 24 小时的（Mission Card、复盘）。CEO 要拍板的是原有的 ceoFeishuNotices.ts，不在这里。
 * - 同一件只推一次（feishu_pushes 记着）；离上一条不到 10 分钟的攒着，到 10 分钟合成一条；22:00 到 08:00 不推，08:00 把那时还在等的合成一条。
 * - 每件带一个打开天枢那一处的链接，不放批准、回答这类操作（云端不指挥本机）。
 * - 本人在「偏好」里关了飞书通知、或没关联飞书的，不推。
 */
export const HOME_PUSH_KIND = "feishu.home_push";
const EVERY_MS = 60_000;
/** 本人多久没在网页上打开天枢算「不在天枢里」；批准等多久算没人理；多久里的几件合成一条。 */
const AWAY_MS = 10 * 60_000;
const APPROVAL_MS = 10 * 60_000;
const MERGE_MS = 10 * 60_000;
const DUE_MS = 24 * 3_600_000;
/** 上海时间 22:00 到 08:00 不推。 */
const QUIET_FROM = 22;
const QUIET_UNTIL = 8;
const MAX_LINKS = 5;

/** 本人的通知开关；没有行是开。 */
export async function readNotificationSettings(q: Query, personId: string): Promise<TNotificationSettings> {
  const row = (await q("SELECT feishu FROM person_settings WHERE person_id=$1", [personId])).rows[0] as { feishu: boolean } | undefined;
  return { feishu: row?.feishu ?? true };
}

export async function writeNotificationSettings(q: Query, personId: string, settings: TNotificationSettings): Promise<TNotificationSettings> {
  await q("INSERT INTO person_settings(person_id,feishu) VALUES($1,$2) ON CONFLICT (person_id) DO UPDATE SET feishu=EXCLUDED.feishu", [personId, settings.feishu]);
  return settings;
}

/** 本人在网页上打开着天枢（浏览器会话的请求）：记下时间，同一个人一分钟最多写一次，写失败不影响请求。 */
export function createPresence(q: Query, now: () => Date) {
  const written = new Map<string, number>();
  return (personId: string): void => {
    const at = now();
    if (at.getTime() - (written.get(personId) ?? 0) < 60_000) return;
    written.set(personId, at.getTime());
    q("INSERT INTO person_settings(person_id,web_seen_at) VALUES($1,$2) ON CONFLICT (person_id) DO UPDATE SET web_seen_at=EXCLUDED.web_seen_at", [personId, at])
      .catch(() => written.delete(personId));
  };
}

/** 「等你」一行在网页里的地址（和网页 lib/home/derive.ts 的 waitingHref 一致）。 */
export function waitingPath(open: TWaitingTarget): string {
  const id = encodeURIComponent(open.id);
  switch (open.kind) {
    case "card": return `/me/work/cards/${id}`;
    case "topic": return `/me/work/topics/${id}`;
    case "project": return `/me/work/projects/${id}`;
    case "task_detail": return `/me/work/tasks/${id}/info`;
    case "transfer": return `/me/work/transfers/${id}`;
    case "month": return `/me/work/month/${id}`;
    case "connections": return "/me/work/settings/connections";
    case "meeting": return `/me/meetings/${id}`;
    case "mission_card": return open.round ? "/me" : `/me/mission-cards/${id}`;
    case "role": return "/me/team";
  }
}

const dueSoon = (item: TWaitingItem, now: Date) => {
  const left = item.dueAt ? Date.parse(item.dueAt) - now.getTime() : NaN;
  return left > 0 && left <= DUE_MS;
};

/** 这一行推不推（13.2）。away：本人 10 分钟内没在网页上打开天枢。 */
export function pushable(item: TWaitingItem, away: boolean, now: Date): boolean {
  switch (item.kind) {
    case "verdict": case "quota": return away;
    case "approval": return away && !!item.at && now.getTime() - Date.parse(item.at) >= APPROVAL_MS;
    case "mission_card": return dueSoon(item, now);
    case "month": return item.month?.step === "review" && dueSoon(item, now);
    default: return false;
  }
}

/** 同一件只推一次：等的是同一件事（id），换了一轮（时间、截止变了）算新的一件。 */
export const pushKey = (item: TWaitingItem) => `${item.id}|${item.at ?? ""}|${item.dueAt ?? ""}`;

const line = (item: TWaitingItem) => [item.title, item.source].filter(Boolean).join(" · ")
  + (item.dueAt && (item.kind === "mission_card" || item.kind === "month") ? `（${shanghaiLabel(new Date(item.dueAt))} 截止）` : "");

/** 一条消息：一件时标题是那一件，几件时「N 件等你」，每件一行结论、一个链接。 */
export function pushNotice(personId: string, items: TWaitingItem[]): FeishuNotice {
  const links = items.slice(0, MAX_LINKS).map((item) => ({ label: items.length === 1 ? "打开天枢" : item.title.slice(0, 20), path: waitingPath(item.open) }));
  if (items.length > MAX_LINKS) links.push({ label: "打开天枢", path: "/me/work" });
  return items.length === 1 ? { personId, title: items[0].title, body: line(items[0]) || items[0].title, links }
    : { personId, title: `${items.length} 件等你`, body: items.map(line).join("\n"), links };
}

const quiet = (at: Date) => {
  const hour = (at.getUTCHours() + 8) % 24;
  return hour >= QUIET_FROM || hour < QUIET_UNTIL;
};

/** 每分钟看一次关联了飞书、开着通知的人（DRI 工作台的人）；一个人读失败不影响别人。 */
export function homePushJobs(deps: { pool: Pool; now: () => Date; people: () => string[]; readHome: (personId: string) => Promise<TWorkHomeResponse> }):
  { handlers: Record<string, JobHandler>; recurring: RecurringJob[] } {
  const q: Query = deps.pool.query.bind(deps.pool);

  async function push(personId: string, items: TWaitingItem[], at: Date): Promise<void> {
    await inTransaction(deps.pool, async (tx) => {
      const keys = items.map(pushKey);
      const sent = new Set(((await tx("SELECT key FROM feishu_pushes WHERE person_id=$1 AND key=ANY($2::text[])", [personId, keys])).rows as { key: string }[])
        .map((row) => row.key));
      const fresh = items.filter((item) => !sent.has(pushKey(item)));
      if (!fresh.length) return;
      const last = (await tx("SELECT max(sent_at) AS at FROM feishu_pushes WHERE person_id=$1", [personId])).rows[0]?.at as Date | null;
      // 离上一条不到 10 分钟：攒着，到点和之后来的合成一条。
      if (last && at.getTime() - last.getTime() < MERGE_MS) return;
      await tx("INSERT INTO feishu_pushes(person_id,key,sent_at) SELECT $1,unnest($2::text[]),$3 ON CONFLICT DO NOTHING", [personId, fresh.map(pushKey), at]);
      await enqueueJob(tx, { kind: FEISHU_NOTIFY_KIND, dedupeKey: `${FEISHU_NOTIFY_KIND}:home:${personId}:${at.toISOString()}`, payload: pushNotice(personId, fresh) });
    });
  }

  async function tick(): Promise<void> {
    const at = deps.now();
    if (quiet(at)) return;
    const linked = new Set(((await q("SELECT person_id FROM feishu_identities")).rows as { person_id: string }[]).map((row) => row.person_id));
    const settings = new Map(((await q("SELECT person_id,feishu,web_seen_at FROM person_settings")).rows as { person_id: string; feishu: boolean; web_seen_at: Date | null }[])
      .map((row) => [row.person_id, row]));
    for (const personId of deps.people()) {
      const setting = settings.get(personId);
      if (!linked.has(personId) || setting?.feishu === false) continue;
      try {
        const away = !setting?.web_seen_at || at.getTime() - setting.web_seen_at.getTime() >= AWAY_MS;
        const items = (await deps.readHome(personId)).waiting.filter((item) => pushable(item, away, at));
        if (items.length) await push(personId, items, at);
      } catch (cause) {
        logEvent({ event: "home_push.failed", personId, error: (cause as Error)?.message ?? String(cause) });
      }
    }
  }

  return { handlers: { [HOME_PUSH_KIND]: tick }, recurring: [{ kind: HOME_PUSH_KIND, everyMs: EVERY_MS }] };
}
