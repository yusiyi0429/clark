import { createHash } from "node:crypto";
import type { Pool } from "pg";
import type { TMeetingMinutesFailure, TMeetingMinutesFetchResponse, TMeetingMinutesStatus, TPersonResult, TTranscriptSource } from "@warmap/contracts";
import type { PeopleDirectory } from "./peopleDirectory.js";
import type { FeishuEnv } from "./feishu/config.js";
import { FeishuApiError } from "./feishu/client.js";
import { activeUserAccessToken, MINUTES_NOT_READY_CODE, type FeishuMinuteInfo, type FeishuMinutesApi } from "./feishu/minutes.js";
import { enqueueJob, type JobHandler, type RecurringJob } from "./jobs.js";
import { MINUTES_GIVE_UP_MS, MINUTES_RECENT_MS, minutesStatusOf } from "./meetingDecisionView.js";
import { getMeetingRow, meetingColumns, type MeetingRow, type Query } from "./meetingStore.js";
import { logEvent } from "./observability.js";
import type { PostMeetingAgent } from "./outcome.js";
import { buildTranscriptCandidate, executeConfirmTranscriptCandidate, saveTranscriptCandidate, suggestByAttendees } from "./transcriptCandidate.js";
import { capturedAtOf, transcriptContentHash } from "./transcriptHash.js";
import { FEISHU_TRANSCRIPT_PARSER_VERSION, parseFeishuTranscriptText } from "./transcriptMarkdown.js";

/**
 * 会议链路 G：会开完以后自动拿飞书妙记。
 * - 订阅「妙记生成」（minutes.minute.generated_v1，长连接收进 feishu_events，再由 jobs 交到这里），另有每 5 分钟一次的轮询兜底；
 *   刚开完的会（开始等妙记 15 分钟以内）另外每 30 秒找一次；
 * - 妙记还没生成时会议记为 waiting（对话里问到就答「还在生成」）；飞书没接、主持人和建会的人都没授权、或等了 2 小时还没有，记为 manual，退回现有的手动上传；
 * - 全文取 /artifacts 的 data.transcript（与 lark-cli 读到的逐字相同，来源记下摘要值）；读取失败记 failed 和原因，
 *   原文还没好（not_ready）的照常跟着轮询和事件再取，主持人或创建人也可以「再读一次」或贴妙记链接；
 * - 拿到逐字稿先生成候选（与手动上传同一条路），直接确认并开始解读纪要：对得上人的说话人对到那个人，对不上的保留飞书原名（FR-4.2，不做发言人纠正）；
 * - 用户自己上传了（有候选或逐字稿）的会不再自动去拿，也不覆盖用户上传的内容；
 * - 实际参会名单从飞书会议拿（中途加入的也算），拿不到就退回手填的参会人；
 * - 在飞书约上的会跟着飞书会议真实开始和结束（「会议开始 / 会议结束」事件）：开始记 started_at，结束记 ended_at 并马上排一次轮询；
 *   到点没开始的不进等妙记（页面上是还没开、过了预约结束 30 分钟是没开成），但预约结束后 2 小时内照样找妙记，防事件丢了、会其实开过。
 */
export const MEETING_MINUTES_POLL_KIND = "meeting.minutes_poll";
export const FEISHU_MINUTES_EVENT = "minutes.minute.generated_v1";
export const FEISHU_MEETING_STARTED_EVENT = "vc.meeting.meeting_started_v1";
export const FEISHU_MEETING_ENDED_EVENT = "vc.meeting.meeting_ended_v1";
/** 企业会议开始 / 结束：结构和上面相同、全公司的会都推，作为天枢日历建的会收不到上面两个事件时的保底。 */
export const FEISHU_ALL_MEETING_STARTED_EVENT = "vc.meeting.all_meeting_started_v1";
export const FEISHU_ALL_MEETING_ENDED_EVENT = "vc.meeting.all_meeting_ended_v1";
const POLL_EVERY_MS = 5 * 60_000;
/** 刚开完的会：开始等妙记后的 15 分钟内，每 30 秒再找一次（只找这些会）。 */
export const MEETING_MINUTES_FAST_POLL_KIND = "meeting.minutes_fast_poll";
const FAST_POLL_EVERY_MS = 30_000;
const FAST_POLL_WINDOW_MS = 15 * 60_000;
/** 妙记的开始时刻和会议计划开始时刻最多差多少还算同一场会。 */
const MATCH_WINDOW_MS = 3 * 60 * 60_000;
/** 还在等妙记的会：waiting，以及读的时候原文还没好的（failed / not_ready）。 */
const STILL_WAITING = "(minutes_status = 'waiting' OR (minutes_status = 'failed' AND minutes_failure = 'not_ready'))";
/** 在飞书约上、还没收到飞书会议开始或结束（主持人也没点「结束会议」）的会：到点不算开完。 */
const UNSTARTED = "(feishu_event_status IS NOT DISTINCT FROM 'booked' AND started_at IS NULL AND ended_at IS NULL)";
const NO_AUTH = "主持人和建会的人都没有可用的飞书授权";
/** a44afae6 之前记下的同一原因。 */
const LEGACY_NO_AUTH = "主持人没有可用的飞书授权";
const MEETING_NOT_FOUND = { status: 404 as const, code: "MEETING_NOT_FOUND", message: "Meeting 不存在" };
const NOT_SCHEDULED = { status: 409 as const, code: "MEETING_NOT_SCHEDULED", message: "只有 scheduled Meeting 可以导入会议记录" };

export type MeetingMinutesDeps = {
  pool: Pool;
  peopleDirectory: PeopleDirectory;
  outcomeAgent: PostMeetingAgent;
  secret: string;
  /** 飞书没配时为空：开完的会直接记 manual。 */
  feishu?: { env: Pick<FeishuEnv, "tokenKey" | "tokenKeyVersion">; api: FeishuMinutesApi };
  /** FEISHU_WEB_ORIGIN：来源地址拼 <origin>/minutes/<minute_token>；不配时不带地址。 */
  feishuWebOrigin?: string;
  now?: () => Date;
};

type FeishuIdentity = { person_id: string; open_id: string; name: string | null };
type IngestResult = { kind: "ready" | "failed" | "taken" } | { kind: "rejected"; status: 404 | 409; code: string; message: string };
/** 代读结果：text 是飞书原文；contentHash 算它，confirmedContentHash 是确认时那份逐字稿来源记下的（没有为 null）。 */
type TranscriptRead = { meetingId: string; source: { url: string | null; title: string }; text: string; contentHash: string; confirmedContentHash: string | null };
const SHANGHAI_MINUTE = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
/** 「10/26 16:03」：北京时间。 */
function monthDayTime(at: Date): string {
  const parts = Object.fromEntries(SHANGHAI_MINUTE.formatToParts(at).map((part) => [part.type, part.value]));
  return `${Number(parts.month)}/${Number(parts.day)} ${parts.hour}:${parts.minute}`;
}

type MinutesFetchResult = TMeetingMinutesFetchResponse | { error: { status: 400 | 404 | 409; code: string; message: string } };

/** 飞书错误码归到读取失败的原因（待联调：按开放平台妙记错误码，2091002 / 2091004 不存在或已删，2091005 与 99991672 / 99991679 没权限）。 */
const NO_PERMISSION_CODES = new Set([2091005, 99991672, 99991679]);
const NOT_FOUND_CODES = new Set([2091002, 2091004]);
function minutesFailureOf(error: unknown): TMeetingMinutesFailure {
  if (!(error instanceof FeishuApiError)) return "fetch_failed";
  if (NO_PERMISSION_CODES.has(error.code)) return "no_permission";
  if (NOT_FOUND_CODES.has(error.code)) return "not_found";
  return error.code === MINUTES_NOT_READY_CODE ? "not_ready" : "fetch_failed";
}

/** 临时故障（网络、超时、飞书 5xx）：自动拉取时不改状态，下一轮照常再取。 */
function isTransient(error: unknown): boolean {
  return !(error instanceof FeishuApiError) || (error.httpStatus ?? 0) >= 500;
}

/** 会议已有飞书会议号、妙记来自别的飞书会议：不自动挂。 */
const sourceConflicts = (meeting: Pick<MeetingRow, "feishu_meeting_id">, minuteMeetingId: string | null) =>
  Boolean(meeting.feishu_meeting_id && minuteMeetingId && minuteMeetingId !== meeting.feishu_meeting_id);

/** 妙记链接里的 token：只认 https://<租户>.feishu.cn/minutes/<token>，token 只收小写字母和数字；不对时为 null。 */
function minuteTokenFromUrl(url: string): string | null {
  let parsed: URL;
  try { parsed = new URL(url.trim()); } catch { return null; }
  if (parsed.protocol !== "https:" || !parsed.hostname.endsWith(".feishu.cn")) return null;
  const token = /^\/minutes\/([^/]+)\/?$/.exec(parsed.pathname)?.[1];
  return token && /^[a-z0-9]+$/.test(token) ? token : null;
}

/** 对话里问到这场会的纪要时怎么答；已经有纪要时为 null（照常回答）。 */
export function minutesReplyFor(row: Pick<MeetingRow, "transcript" | "transcript_candidate"> & { minutes_status?: TMeetingMinutesStatus | null }): string | null {
  const status = minutesStatusOf(row);
  if (status === "waiting") return "飞书妙记还在生成，生成后会自动整理纪要。";
  if (status === "manual") return "这场会的妙记没能自动拿到，主持人可以在会议页上传妙记。";
  if (status === "failed") return "这场会的妙记没能读到，主持人可以在会议页再读一次或贴妙记链接。";
  return null;
}

/** 给对话用：按会议 id 读状态（不检查可见范围，调用方已检查）。 */
export async function meetingMinutesReply(q: Query, meetingId: string): Promise<{ status: TMeetingMinutesStatus; reply: string | null } | null> {
  const row = await getMeetingRow(q, meetingId);
  return row ? { status: minutesStatusOf(row), reply: minutesReplyFor(row) } : null;
}

/** 事件里的妙记 token 与来源会议：SDK 交来的是拍平后的事件（header 与 event 同层），也兼容没拍平的。 */
export function minuteFromEvent(payload: Record<string, unknown>): { minuteToken: string; feishuMeetingId: string | null } | null {
  const event = (payload.event as Record<string, unknown> | undefined) ?? payload;
  const token = event.minute_token ?? (event.minute as { token?: unknown } | undefined)?.token;
  if (typeof token !== "string" || !token) return null;
  const source = (event.generated_source ?? event.minute_source) as { source_type?: unknown; source_entity_id?: unknown } | undefined;
  return { minuteToken: token, feishuMeetingId: typeof source?.source_entity_id === "string" && source.source_entity_id ? source.source_entity_id : null };
}

type FeishuMeetingEvent = { feishuMeetingId: string | null; meetingNo: string | null; calendarEventId: string | null; startTime: Date | null; endTime: Date | null };

const textOf = (value: unknown): string | null => (typeof value === "string" && value ? value : null);
/** 事件里的时刻：飞书原始事件是秒级时间戳字符串，也认 RFC3339；没有或认不出（含 "0"）为 null。 */
function eventTime(value: unknown): Date | null {
  const raw = textOf(value);
  const ms = raw === null ? NaN : /^\d+$/.test(raw) ? Number(raw) * 1000 : Date.parse(raw);
  return ms > 0 ? new Date(ms) : null;
}

/**
 * 「会议开始 / 会议结束」事件里的会：SDK 交来的是拍平后的事件（header 与 event 同层），会在 meeting 下（id、meeting_no、calendar_event_id，
 * start_time / end_time 是秒级时间戳字符串）；也兼容没拍平的和平铺的（meeting_id、RFC3339 时刻）。日程 id 和会议号都没有时为 null。
 */
export function feishuMeetingFromEvent(payload: Record<string, unknown>): FeishuMeetingEvent | null {
  const event = (payload.event as Record<string, unknown> | undefined) ?? payload;
  const meeting = (event.meeting as Record<string, unknown> | undefined) ?? event;
  const calendarEventId = textOf(meeting.calendar_event_id);
  const meetingNo = textOf(meeting.meeting_no);
  if (!calendarEventId && !meetingNo) return null;
  return { feishuMeetingId: textOf(meeting.id) ?? textOf(meeting.meeting_id), meetingNo, calendarEventId,
    startTime: eventTime(meeting.start_time), endTime: eventTime(meeting.end_time) };
}

export function createMeetingMinutesService(deps: MeetingMinutesDeps) {
  const { pool, peopleDirectory, outcomeAgent, secret, feishu } = deps;
  const feishuWebOrigin = deps.feishuWebOrigin?.replace(/\/+$/, "");
  const now = deps.now ?? (() => new Date());
  const q: Query = pool.query.bind(pool);

  const identity = async (personId: string): Promise<FeishuIdentity | null> =>
    ((await q("SELECT person_id, open_id, name FROM feishu_identities WHERE person_id = $1", [personId])).rows[0] as FeishuIdentity | undefined) ?? null;
  const tokenFor = (personId: string) => (feishu ? activeUserAccessToken(q, feishu.env, personId, now()) : Promise.resolve(null));

  /** 拿妙记用谁的授权：先主持人，再建会的人（没记或同一人时只有主持人）；只留关联了飞书、授权还能用的。 */
  async function fetchers(meeting: { lead_dri_id: string; created_by?: string | null }): Promise<{ openId: string; token: string }[]> {
    const found: { openId: string; token: string }[] = [];
    for (const personId of new Set([meeting.lead_dri_id, meeting.created_by ?? meeting.lead_dri_id])) {
      const person = await identity(personId);
      const token = person ? await tokenFor(personId) : null;
      if (person && token) found.push({ openId: person.open_id, token });
    }
    return found;
  }

  /** failed 也记等待起点：原文还没好的跟着轮询再取，等满 2 小时同样退回手动上传。 */
  async function setStatus(meetingId: string, status: TMeetingMinutesStatus, error: string | null = null, failure: TMeetingMinutesFailure | null = null,
    since: Date | null = null): Promise<void> {
    await q(
      `UPDATE meetings SET minutes_status = $2, minutes_error = $3, minutes_failure = $4,
         minutes_waiting_since = CASE WHEN $2 IN ('waiting', 'failed') THEN COALESCE(minutes_waiting_since, $5, now()) ELSE minutes_waiting_since END
       WHERE id = $1`,
      [meetingId, status, error, failure, since],
    );
  }

  async function fail(meetingId: string, failure: TMeetingMinutesFailure, error: string): Promise<IngestResult> {
    await setStatus(meetingId, "failed", error, failure);
    logEvent({ event: "meeting.minutes", objectRef: `meeting:${meetingId}`, status: "failed", errorCode: failure });
    return { kind: "failed" };
  }

  /** 开完的会记为 waiting（飞书拿得到，从开完那一刻算起）或 manual（拿不到）；等太久的也退回 manual。 */
  async function markEnded(at: Date): Promise<void> {
    const ended = await q(
      `SELECT id, lead_dri_id, created_by, COALESCE(ended_at, ends_at) AS ended FROM meetings
        WHERE status = 'scheduled' AND minutes_status = 'none' AND transcript IS NULL AND transcript_candidate IS NULL AND NOT ${UNSTARTED}
          AND COALESCE(ended_at, ends_at) <= $1 AND COALESCE(ended_at, ends_at) > $2`,
      [at, new Date(at.getTime() - MINUTES_RECENT_MS)],
    );
    for (const row of ended.rows as { id: string; lead_dri_id: string; created_by: string | null; ended: Date }[]) {
      const reachable = Boolean(feishu && (await fetchers(row)).length);
      await setStatus(row.id, reachable ? "waiting" : "manual", reachable ? null : NO_AUTH, null, row.ended);
    }
    await q(
      `UPDATE meetings SET minutes_status = 'manual', minutes_failure = NULL, minutes_error = '等了 2 小时还没拿到妙记'
        WHERE ${STILL_WAITING} AND minutes_waiting_since < $1 AND transcript IS NULL AND transcript_candidate IS NULL`,
      [new Date(at.getTime() - MINUTES_GIVE_UP_MS)],
    );
    // 已经有逐字稿或候选的（手动上传、录音转写）一律算 ready，轮询不再管。
    await q(`UPDATE meetings SET minutes_status = 'ready', minutes_failure = NULL
      WHERE minutes_status IN ('waiting', 'manual', 'failed') AND (transcript IS NOT NULL OR transcript_candidate IS NOT NULL)`);
  }

  async function waitingMeetings(): Promise<MeetingRow[]> {
    return (await q(`SELECT ${meetingColumns()} FROM meetings WHERE ${STILL_WAITING} AND status = 'scheduled'
      AND transcript IS NULL AND transcript_candidate IS NULL ORDER BY scheduled_at`)).rows as MeetingRow[];
  }

  /** 找妙记的会：等妙记的，加上在飞书约上、到点没收到开始事件、预约结束 2 小时以内的（不记等妙记，找到了照常接管）。 */
  async function searchedMeetings(): Promise<MeetingRow[]> {
    const at = now();
    const unstarted = (await q(`SELECT ${meetingColumns()} FROM meetings WHERE status = 'scheduled' AND minutes_status = 'none' AND ${UNSTARTED}
      AND transcript IS NULL AND transcript_candidate IS NULL AND ends_at <= $1 AND ends_at > $2 ORDER BY scheduled_at`,
    [at, new Date(at.getTime() - MINUTES_GIVE_UP_MS)])).rows as MeetingRow[];
    return [...await waitingMeetings(), ...unstarted];
  }

  /** 实际参会名单：飞书会议的参会人 open_id 换成天枢的人；一个都对不上时不改（退回手填名单）。 */
  /** 飞书会议的实际参会人：认得的（连过飞书的）换成 person_id，认不得的只记个数（排除法要求名单里每个人都认得）。 */
  async function actualAttendees(token: string, feishuMeetingId: string): Promise<{ personIds: string[]; unknown: number } | null> {
    if (!feishu) return null;
    const openIds = await feishu.api.meetingParticipants(token, feishuMeetingId).catch(() => [] as string[]);
    if (!openIds.length) return null;
    const rows = (await q("SELECT open_id, person_id FROM feishu_identities WHERE open_id = ANY($1::text[]) ORDER BY person_id", [openIds])).rows as { open_id: string; person_id: string }[];
    return { personIds: rows.map((row) => row.person_id), unknown: openIds.filter((openId) => !rows.some((row) => row.open_id === openId)).length };
  }

  /** 说话人对人：人员目录的显示名之外，再认飞书账号的名字。 */
  async function peopleWithFeishuNames(): Promise<TPersonResult[]> {
    const people = peopleDirectory.searchPeople(undefined);
    const aliases = (await q("SELECT person_id, name FROM feishu_identities WHERE name IS NOT NULL")).rows as { person_id: string; name: string }[];
    const extra = aliases.flatMap((alias) => {
      const person = people.find((candidate) => candidate.personId === alias.person_id);
      return person && person.displayName !== alias.name ? [{ ...person, displayName: alias.name }] : [];
    });
    return [...people, ...extra];
  }

  /**
   * 逐字稿全文：先取 /artifacts 的 data.transcript；这个接口回任何飞书错误（没权限、非 JSON、没有逐字稿等）都退回导出接口
   * （摘要值可能和 Chat 侧对不上，记一条日志），失败原因按导出接口的错误算。网络错误不算接口不可用，不退回。
   */
  async function readFullText(api: FeishuMinutesApi, meetingId: string, token: string, minuteToken: string): Promise<string> {
    try {
      return await api.artifactTranscript(token, minuteToken);
    } catch (error) {
      if (!(error instanceof FeishuApiError)) throw error;
      logEvent({ event: "meeting.minutes", objectRef: `meeting:${meetingId}`, status: "artifacts_unavailable", errorCode: String(error.code) });
      return api.exportTranscript(token, minuteToken);
    }
  }

  /**
   * 拿到妙记：先把妙记记到这场会上（同一份妙记只对一场会；贴链接时可以换掉原来对上的那份）→ 读逐字稿全文 → 记下飞书会议与实际参会名单
   * → 生成候选（来源带地址、标题、摘要值和读取时刻）→ 直接确认并解读纪要。读不到或解析不了记 failed 和原因；
   * 自动拉取遇到临时故障不改状态（下一轮再取）；读的过程中用户自己上传了候选的，不覆盖。候选没能写进去时把妙记还回去，不让它锁在这场会上。
   */
  async function ingest(api: FeishuMinutesApi, meeting: MeetingRow, minute: FeishuMinuteInfo, token: string, feishuMeetingId: string | null,
    { replace = false, manual = false }: { replace?: boolean; manual?: boolean } = {}): Promise<IngestResult> {
    const claimed = await q(
      `UPDATE meetings SET minute_token = $2, feishu_meeting_id = COALESCE($3, feishu_meeting_id)
        WHERE id = $1 AND (minute_token IS NULL OR minute_token = $2 OR $4)
          AND NOT EXISTS (SELECT 1 FROM meetings other WHERE other.minute_token = $2 AND other.id <> $1)`,
      [meeting.id, minute.token, feishuMeetingId ?? minute.meetingId, replace],
    );
    if (!claimed.rowCount) return { kind: "taken" };
    // 待整理里有这份妙记的：已挂上，不再提示。
    const inbox = await q("UPDATE feishu_minute_inbox SET status = 'attached', meeting_id = $1, updated_at = now() WHERE minute_token = $2 AND status = 'pending'",
      [meeting.id, minute.token]);
    if (inbox.rowCount) logEvent({ event: "feishu_minute_inbox", objectRef: `feishu_minute:${minute.token}`, status: "auto_attached", meetingId: meeting.id });
    let text: string;
    try {
      text = await readFullText(api, meeting.id, token, minute.token);
    } catch (error) {
      if (!manual && isTransient(error)) {
        logEvent({ event: "meeting.minutes", objectRef: `meeting:${meeting.id}`, status: "read_retry", errorCode: error instanceof FeishuApiError ? String(error.code) : "NETWORK" });
        return { kind: "failed" };
      }
      return fail(meeting.id, minutesFailureOf(error), (error as Error).message);
    }
    const capturedAt = capturedAtOf(now());
    const parsed = parseFeishuTranscriptText(text);
    if (!parsed.ok) return fail(meeting.id, "fetch_failed", `妙记逐字稿解析失败：${parsed.error.message}`);
    const meetingRef = feishuMeetingId ?? minute.meetingId;
    const attendees = meetingRef ? await actualAttendees(token, meetingRef) : null;
    if (attendees?.personIds.length) await q("UPDATE meetings SET attendees_actual = $2::jsonb WHERE id = $1", [meeting.id, JSON.stringify(attendees.personIds)]);

    const bytes = Buffer.from(text, "utf8");
    const title = minute.title || meeting.title;
    const source: TTranscriptSource = {
      format: "feishu_minutes",
      fileName: `${title.slice(0, 200)}.txt`,
      sizeBytes: Math.max(1, bytes.length),
      sha256: createHash("sha256").update(bytes).digest("hex"),
      parserVersion: FEISHU_TRANSCRIPT_PARSER_VERSION,
      timeAnchor: parsed.startedAt ?? minute.createdAt?.toISOString() ?? meeting.scheduled_at.toISOString(),
      ...(feishuWebOrigin ? { url: `${feishuWebOrigin}/minutes/${encodeURIComponent(minute.token)}` } : {}),
      title: title.slice(0, 300),
      contentHash: transcriptContentHash(text),
      capturedAt,
    };
    const people = await peopleWithFeishuNames();
    const candidate = suggestByAttendees(buildTranscriptCandidate(parsed.transcript.turns, people, source), attendees, people);
    const saved = await saveTranscriptCandidate(pool, meeting.id, candidate, undefined, { keepExisting: !manual });
    if (!("row" in saved)) {
      await q("UPDATE meetings SET minute_token = $3 WHERE id = $1 AND minute_token = $2", [meeting.id, minute.token, meeting.minute_token]);
      // 妙记还回去了、也没有别的会挂着：回到待整理。
      await q(`UPDATE feishu_minute_inbox SET status = 'pending', meeting_id = NULL, updated_at = now()
        WHERE minute_token = $1 AND status = 'attached' AND NOT EXISTS (SELECT 1 FROM meetings WHERE minute_token = $1)`, [minute.token]);
      return { kind: "rejected", status: saved.status, code: saved.code, message: saved.message };
    }
    await setStatus(meeting.id, "ready");
    logEvent({ event: "meeting.minutes", objectRef: `meeting:${meeting.id}`, status: "fetched" });

    // 不等主持人对说话人，直接确认：对得上人的对到那个人（几个说话人可以对到同一人），对不上的保留飞书原名。
    await executeConfirmTranscriptCandidate(pool, peopleDirectory, outcomeAgent, secret,
      { actionType: "meeting.confirm_transcript_candidate", objectType: "meeting", objectId: meeting.id, objectVersion: saved.row.version },
      {
        speakerMappings: candidate.speakers.flatMap((speaker) => speaker.suggestedPersonId ? [{ speakerName: speaker.speakerName, personId: speaker.suggestedPersonId }] : []),
        confirmAddParticipants: true,
      },
      `feishu-minutes:${minute.token}`);
    return { kind: "ready" };
  }

  /** 按 token 读（再读一次、贴链接）：先取妙记详情（标题、开会时刻），谁的授权先读得到就用谁的，再走 ingest。 */
  async function ingestByToken(api: FeishuMinutesApi, meeting: MeetingRow, readers: { token: string }[], minuteToken: string, replace: boolean): Promise<IngestResult> {
    let lastError: unknown;
    for (const { token } of readers) {
      try {
        const minute = await api.getMinute(token, minuteToken);
        return ingest(api, meeting, minute, token, minute.meetingId, { replace, manual: true });
      } catch (error) {
        lastError = error;
      }
    }
    return fail(meeting.id, minutesFailureOf(lastError), (lastError as Error).message);
  }

  /** 妙记和会议对得上：同一个主持人名下，开始时刻离计划开始最近（3 小时以内）。 */
  function closest(meeting: MeetingRow, minutes: FeishuMinuteInfo[]): FeishuMinuteInfo | null {
    const start = meeting.scheduled_at.getTime();
    const scored = minutes
      .filter((minute) => minute.createdAt && Math.abs(minute.createdAt.getTime() - start) <= MATCH_WINDOW_MS)
      .sort((a, b) => Math.abs(a.createdAt!.getTime() - start) - Math.abs(b.createdAt!.getTime() - start));
    return scored[0] ?? null;
  }

  /** 这个人名下、这场会前后的妙记里开始时刻最近的一份（已对到别的会的、来自别的飞书会议的不算）。 */
  async function findMinute(api: FeishuMinutesApi, meeting: MeetingRow, openId: string, token: string): Promise<FeishuMinuteInfo | null> {
    const listed = await api.listMinutes(token, { openId }, {
      start: new Date(meeting.scheduled_at.getTime() - MATCH_WINDOW_MS), end: new Date(meeting.ends_at.getTime() + MATCH_WINDOW_MS) });
    const used = new Set((await q("SELECT minute_token FROM meetings WHERE minute_token IS NOT NULL AND id <> $1", [meeting.id])).rows.map((row) => row.minute_token as string));
    return closest(meeting, listed.filter((item) => !used.has(item.token) && !sourceConflicts(meeting, item.meetingId)));
  }

  /** 按授权顺序找：谁名下先找到就用谁的授权；都没找到时，只有每个人都出错才带上错误（否则算妙记还没生成）。 */
  async function findFirst(api: FeishuMinutesApi, meeting: MeetingRow, readers: { openId: string; token: string }[]):
    Promise<{ minute: FeishuMinuteInfo; token: string } | { minute: null; error: unknown }> {
    let error: unknown = null;
    let answered = false;
    for (const { openId, token } of readers) {
      try {
        const minute = await findMinute(api, meeting, openId, token);
        if (minute) return { minute, token };
        answered = true;
      } catch (caught) {
        error = caught;
      }
    }
    return { minute: null, error: answered ? null : error };
  }

  /** 轮询兜底：每场还在等的会，先用主持人的授权列他名下这段时间的妙记，没找到再用建会的人的。 */
  async function poll(): Promise<void> {
    if (!feishu) return;
    await pollMeetings(await searchedMeetings());
  }

  /** 刚开完的会（开始等妙记 15 分钟以内）：每 30 秒单独找一次，妙记一般会后 1–3 分钟就有；找到了、过了 15 分钟就回到 5 分钟一次。 */
  async function pollRecent(): Promise<void> {
    if (!feishu) return;
    const recent = (await q(`SELECT ${meetingColumns()} FROM meetings WHERE ${STILL_WAITING} AND status = 'scheduled'
      AND transcript IS NULL AND transcript_candidate IS NULL AND minutes_waiting_since > $1 ORDER BY scheduled_at`,
    [new Date(now().getTime() - FAST_POLL_WINDOW_MS)])).rows as MeetingRow[];
    await pollMeetings(recent);
  }

  async function pollMeetings(meetings: MeetingRow[]): Promise<void> {
    if (!feishu) return;
    for (const meeting of meetings) {
      const readers = await fetchers(meeting);
      if (!readers.length) {
        // 没开成的会没人能读也不改状态。
        if (meeting.minutes_status !== "none") await setStatus(meeting.id, "manual", NO_AUTH);
        continue;
      }
      try {
        const found = await findFirst(feishu.api, meeting, readers);
        if (found.minute) await ingest(feishu.api, meeting, found.minute, found.token, found.minute.meetingId);
        else if (found.error) throw found.error;
      } catch (error) {
        logEvent({ event: "meeting.minutes", objectRef: `meeting:${meeting.id}`, status: "poll_failed", errorCode: error instanceof FeishuApiError ? String(error.code) : "POLL_FAILED" });
      }
    }
  }

  /**
   * 「妙记生成」事件：先按飞书会议 id 对；对不上就拿每场 waiting 的会的主持人（再是建会的人）授权去读这份妙记，
   * 读得到、属于这个人、开始时刻对得上、不是别的飞书会议的就是它。
   */
  async function onMinuteGenerated(payload: Record<string, unknown>): Promise<void> {
    if (!feishu) return;
    const found = minuteFromEvent(payload);
    if (!found) return;
    const byFeishuId = found.feishuMeetingId
      ? (await q(`SELECT ${meetingColumns()} FROM meetings WHERE feishu_meeting_id = $1 AND transcript IS NULL AND transcript_candidate IS NULL LIMIT 1`, [found.feishuMeetingId])).rows[0] as MeetingRow | undefined
      : undefined;
    const candidates = byFeishuId ? [byFeishuId] : await waitingMeetings();
    for (const meeting of candidates) {
      for (const { openId, token } of await fetchers(meeting)) {
        const minute = await feishu.api.getMinute(token, found.minuteToken).catch(() => null);
        if (!minute || (minute.ownerOpenId && minute.ownerOpenId !== openId)) continue;
        if (!byFeishuId && (!closest(meeting, [minute]) || sourceConflicts(meeting, minute.meetingId ?? found.feishuMeetingId))) break;
        const result = await ingest(feishu.api, meeting, { ...minute, meetingId: minute.meetingId ?? found.feishuMeetingId }, token, found.feishuMeetingId);
        if (result.kind !== "taken") return;
        break;
      }
    }
  }

  /** 事件对上的会（还没开完的 scheduled 会）：先按日程 id，对不上再按入会链接（https://vc.feishu.cn/j/<会议号>）的会议号；都对不上为 null。 */
  async function liveMeetingId(found: FeishuMeetingEvent): Promise<string | null> {
    const byCalendar = found.calendarEventId
      ? (await q("SELECT id FROM meetings WHERE feishu_event_id = $1 AND status = 'scheduled' LIMIT 1", [found.calendarEventId])).rows[0] : undefined;
    if (byCalendar || !found.meetingNo) return (byCalendar?.id as string | undefined) ?? null;
    return ((await q("SELECT id FROM meetings WHERE substring(feishu_event_join_url from '/j/([0-9]+)') = $1 AND status = 'scheduled' LIMIT 1",
      [found.meetingNo])).rows[0]?.id as string | undefined) ?? null;
  }

  /**
   * 「会议开始」：记真实开始时刻（只记第一次）和飞书会议 id；对不上天枢的会就不管（飞书里直接开的会以后另做）。
   * 第一次开始时，还没有逐字稿和候选、却记着等妙记、读取失败这些（改期前留下的）：先清回 none，会议页回到会中。
   */
  async function onMeetingStarted(payload: Record<string, unknown>): Promise<void> {
    const found = feishuMeetingFromEvent(payload);
    const meetingId = found && await liveMeetingId(found);
    if (!found || !meetingId) return;
    await q(`UPDATE meetings SET minutes_status = 'none', minutes_waiting_since = NULL, minutes_failure = NULL, minutes_error = NULL
      WHERE id = $1 AND started_at IS NULL AND minutes_status <> 'none' AND transcript IS NULL AND transcript_candidate IS NULL`, [meetingId]);
    await q("UPDATE meetings SET started_at = COALESCE(started_at, $2), feishu_meeting_id = COALESCE($3, feishu_meeting_id) WHERE id = $1",
      [meetingId, found.startTime ?? now(), found.feishuMeetingId]);
  }

  /**
   * 「会议结束」：记结束时刻（只记第一次）和飞书会议 id，马上排一次妙记轮询（与「结束会议」同一个去重键），从结束那一刻开始等妙记；
   * 开超了时、已经按预约结束进了等妙记的，等待起点改成真实结束。
   */
  async function onMeetingEnded(payload: Record<string, unknown>): Promise<void> {
    const found = feishuMeetingFromEvent(payload);
    const meetingId = found && await liveMeetingId(found);
    if (!found || !meetingId) return;
    await q(
      `UPDATE meetings SET ended_at = COALESCE(ended_at, $2), feishu_meeting_id = COALESCE($3, feishu_meeting_id),
         minutes_waiting_since = CASE WHEN ended_at IS NULL AND minutes_status = 'waiting' THEN $2 ELSE minutes_waiting_since END
       WHERE id = $1`,
      [meetingId, found.endTime ?? now(), found.feishuMeetingId],
    );
    await enqueueJob(q, { kind: MEETING_MINUTES_POLL_KIND, dedupeKey: `${MEETING_MINUTES_POLL_KIND}:end:${meetingId}` });
  }

  /** 主持人和建会的人（没记时按主持人算）能再读、贴链接；别人一律当会议不存在。 */
  async function fetchableMeeting(meetingId: string, viewerId: string): Promise<MeetingRow | null> {
    const meeting = await getMeetingRow(q, meetingId);
    return meeting && (meeting.lead_dri_id === viewerId || (meeting.created_by ?? meeting.lead_dri_id) === viewerId) ? meeting : null;
  }

  /** 妙记已经对到别的会上：说出是哪场会（会名和开会时刻），对不上就只说已经用过。 */
  async function takenMessage(meetingId: string, minuteToken: string | undefined): Promise<string> {
    const other = minuteToken
      ? (await q("SELECT title, scheduled_at FROM meetings WHERE minute_token = $1 AND id <> $2 LIMIT 1", [minuteToken, meetingId])).rows[0] as { title: string; scheduled_at: Date } | undefined
      : undefined;
    return other ? `这份妙记已经用在「${other.title}」（${monthDayTime(other.scheduled_at)}）上了，一份妙记只能对一场会` : "这份妙记已经用在别的会上了，一份妙记只能对一场会";
  }

  async function respond(meetingId: string, result: IngestResult, minuteToken?: string): Promise<MinutesFetchResult> {
    if (result.kind === "rejected") return { error: { status: result.status, code: result.code, message: result.message } };
    if (result.kind === "taken") return { error: { status: 409, code: "MINUTE_TAKEN", message: await takenMessage(meetingId, minuteToken) } };
    const row = (await getMeetingRow(q, meetingId))!;
    const status = minutesStatusOf(row);
    return { minutesStatus: status, minutesFailure: status === "failed" ? row.minutes_failure ?? null : null };
  }

  /** 「再读一次」：等待中、没拿到、读取失败时立即再取；已经对上妙记的按它读，没有就按轮询的规则找。 */
  async function refetch(meetingId: string, viewerId: string): Promise<MinutesFetchResult> {
    const meeting = await fetchableMeeting(meetingId, viewerId);
    if (!meeting) return { error: MEETING_NOT_FOUND };
    const status = minutesStatusOf(meeting);
    if (status === "ready") return { error: { status: 409, code: "MINUTES_READY", message: "逐字稿已经读完了" } };
    if (status === "none") return { error: { status: 409, code: "MINUTES_NOT_EXPECTED", message: "这场会还没到读妙记的时候，可以贴妙记链接" } };
    if (meeting.status !== "scheduled") return { error: NOT_SCHEDULED };
    const readers = await fetchers(meeting);
    if (!feishu || !readers.length) return respond(meeting.id, await fail(meeting.id, "no_permission", NO_AUTH));
    if (meeting.minute_token) return respond(meeting.id, await ingestByToken(feishu.api, meeting, readers, meeting.minute_token, false));
    const found = await findFirst(feishu.api, meeting, readers);
    if (found.minute) return respond(meeting.id, await ingest(feishu.api, meeting, found.minute, found.token, found.minute.meetingId, { manual: true }));
    if (found.error) return respond(meeting.id, await fail(meeting.id, minutesFailureOf(found.error), (found.error as Error).message));
    // 没找到多半是妙记还没生成：记 not_ready，轮询和「妙记生成」事件照常接着找。
    return respond(meeting.id, await fail(meeting.id, "not_ready", "主持人和建会的人名下都还没有这场会的妙记"));
  }

  /** 贴妙记链接：用主持人（读不到再用建会的人）的授权按链接里的 token 读（换掉原来对上的那份）；逐字稿已经确认过的不再读。 */
  async function readLink(meetingId: string, viewerId: string, url: string): Promise<MinutesFetchResult> {
    const meeting = await fetchableMeeting(meetingId, viewerId);
    if (!meeting) return { error: MEETING_NOT_FOUND };
    const minuteToken = minuteTokenFromUrl(url);
    if (!minuteToken) return { error: { status: 400, code: "INVALID_MINUTES_URL", message: "只认飞书妙记链接：https://<租户>.feishu.cn/minutes/<token>" } };
    if (meeting.transcript) return { error: { status: 409, code: "TRANSCRIPT_ALREADY_IMPORTED", message: "这场会的逐字稿已经确认过了" } };
    if (meeting.status !== "scheduled") return { error: NOT_SCHEDULED };
    const readers = await fetchers(meeting);
    if (!feishu || !readers.length) return respond(meeting.id, await fail(meeting.id, "no_permission", NO_AUTH));
    return respond(meeting.id, await ingestByToken(feishu.api, meeting, readers, minuteToken, true), minuteToken);
  }

  /**
   * 待整理的妙记整理或记到会上以后读（feishuMinuteInbox.ts 的后台任务）：只用妙记所有者本人的授权，按 token 走和「再读一次」同一条路。
   * 会不在、不是 scheduled、已有逐字稿或候选、记着的不是这份妙记 → rejected；原文还没好 → not_ready、临时读不到 → fetch_failed（都交给任务退避重试）。
   */
  async function ingestForOwner(meetingId: string, minuteToken: string, ownerId: string): Promise<"ready" | "not_ready" | "fetch_failed" | "failed" | "taken" | "rejected"> {
    const meeting = await getMeetingRow(q, meetingId);
    if (!meeting || meeting.status !== "scheduled" || meeting.transcript || meeting.transcript_candidate || meeting.minute_token !== minuteToken) return "rejected";
    const token = await tokenFor(ownerId);
    if (!feishu || !token) {
      await fail(meetingId, "no_permission", "妙记所有者没有可用的飞书授权");
      return "failed";
    }
    const result = await ingestByToken(feishu.api, meeting, [{ token }], minuteToken, false);
    if (result.kind !== "failed") return result.kind;
    const failure = (await getMeetingRow(q, meetingId))?.minutes_failure;
    return failure === "not_ready" || failure === "fetch_failed" ? failure : "failed";
  }

  /**
   * 有人刚连上飞书：他主持或建的会里，因为没有可用授权退回手动（或读的时候没权限）、还没有逐字稿和候选、开完 48 小时以内的，
   * 回到等妙记（从现在起再等 2 小时），并马上排一次轮询，不等下一个 5 分钟。返回接着等的会有几场。
   */
  async function resumeFor(personId: string): Promise<number> {
    const at = now();
    const resumed = await q(
      `UPDATE meetings SET minutes_status = 'waiting', minutes_error = NULL, minutes_failure = NULL, minutes_waiting_since = $3
        WHERE status = 'scheduled' AND transcript IS NULL AND transcript_candidate IS NULL AND (lead_dri_id = $1 OR created_by = $1)
          AND COALESCE(ended_at, ends_at) > $2 AND COALESCE(ended_at, ends_at) <= $3
          AND ((minutes_status = 'manual' AND minutes_error = ANY($4::text[])) OR (minutes_status = 'failed' AND minutes_failure = 'no_permission'))`,
      [personId, new Date(at.getTime() - MINUTES_RECENT_MS), at, [NO_AUTH, LEGACY_NO_AUTH]],
    );
    if (resumed.rowCount) {
      await enqueueJob(q, { kind: MEETING_MINUTES_POLL_KIND, dedupeKey: `${MEETING_MINUTES_POLL_KIND}:connect:${personId}:${at.getTime()}`, runAt: at });
    }
    return resumed.rowCount ?? 0;
  }

  /**
   * 给独立 Chat 代读（10/21 与人豪约定）：用提问人本人的飞书授权读这场会对上的妙记全文；Chat 不拿飞书凭据。
   * 读不到就返回原因，不退回天枢存的逐字稿。不检查会议可见范围，调用方已检查。不记全文和 token。
   */
  async function transcriptFor(meetingId: string, personId: string): Promise<TranscriptRead | { error: { status: 403 | 404 | 409 | 502 | 503; code: string; message: string } }> {
    const meeting = await getMeetingRow(q, meetingId);
    const minuteToken = meeting?.minute_token;
    if (!meeting || !minuteToken) return { error: { status: 404, code: "NO_FEISHU_MINUTES", message: "这场会没有飞书妙记" } };
    if (!feishu) return { error: { status: 503, code: "FEISHU_UNAVAILABLE", message: "飞书没接" } };
    const token = await tokenFor(personId);
    if (!token) return { error: { status: 403, code: "FEISHU_NOT_CONNECTED", message: "提问人没有可用的飞书授权" } };
    let text: string;
    try {
      text = await readFullText(feishu.api, meetingId, token, minuteToken);
    } catch (error) {
      const failure = minutesFailureOf(error);
      if (failure === "no_permission") return { error: { status: 403, code: "FEISHU_NO_PERMISSION", message: "提问人在飞书里没有这份妙记的权限" } };
      if (failure === "not_ready") return { error: { status: 409, code: "MINUTES_NOT_READY", message: "妙记还在生成" } };
      if (failure === "not_found") return { error: { status: 404, code: "MINUTES_NOT_FOUND", message: "飞书里找不到这份妙记" } };
      return { error: { status: 502, code: "FEISHU_UNAVAILABLE", message: "飞书暂时读不到" } };
    }
    const source = meeting.transcript?.source;
    return {
      meetingId,
      source: { url: source?.url ?? (feishuWebOrigin ? `${feishuWebOrigin}/minutes/${encodeURIComponent(minuteToken)}` : null), title: source?.title ?? meeting.title },
      text,
      contentHash: transcriptContentHash(text),
      confirmedContentHash: source?.contentHash ?? null,
    };
  }

  return {
    markEnded,
    poll,
    pollRecent,
    onMinuteGenerated,
    onMeetingStarted,
    onMeetingEnded,
    refetch,
    readLink,
    resumeFor,
    transcriptFor,
    ingestForOwner,
    async tick(): Promise<void> {
      await markEnded(now());
      await poll();
    },
  };
}

export type MeetingMinutesService = ReturnType<typeof createMeetingMinutesService>;

export function meetingMinutesJobs(service: MeetingMinutesService): { handlers: Record<string, JobHandler>; recurring: RecurringJob[]; events: Record<string, (payload: Record<string, unknown>) => Promise<void>> } {
  return {
    handlers: { [MEETING_MINUTES_POLL_KIND]: () => service.tick(), [MEETING_MINUTES_FAST_POLL_KIND]: () => service.pollRecent() },
    recurring: [{ kind: MEETING_MINUTES_POLL_KIND, everyMs: POLL_EVERY_MS }, { kind: MEETING_MINUTES_FAST_POLL_KIND, everyMs: FAST_POLL_EVERY_MS }],
    events: {
      [FEISHU_MINUTES_EVENT]: (payload) => service.onMinuteGenerated(payload),
      [FEISHU_MEETING_STARTED_EVENT]: (payload) => service.onMeetingStarted(payload),
      [FEISHU_MEETING_ENDED_EVENT]: (payload) => service.onMeetingEnded(payload),
      [FEISHU_ALL_MEETING_STARTED_EVENT]: (payload) => service.onMeetingStarted(payload),
      [FEISHU_ALL_MEETING_ENDED_EVENT]: (payload) => service.onMeetingEnded(payload),
    },
  };
}
