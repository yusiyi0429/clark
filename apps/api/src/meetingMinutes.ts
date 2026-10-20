import { createHash } from "node:crypto";
import type { Pool } from "pg";
import type { TMeetingMinutesFailure, TMeetingMinutesFetchResponse, TMeetingMinutesStatus, TPersonResult, TTranscriptSource } from "@warmap/contracts";
import type { PeopleDirectory } from "./peopleDirectory.js";
import type { FeishuEnv } from "./feishu/config.js";
import { FeishuApiError } from "./feishu/client.js";
import { activeUserAccessToken, MINUTES_NOT_READY_CODE, type FeishuMinuteInfo, type FeishuMinutesApi } from "./feishu/minutes.js";
import type { JobHandler, RecurringJob } from "./jobs.js";
import { minutesStatusOf } from "./meetingDecisionView.js";
import { getMeetingRow, meetingColumns, type MeetingRow, type Query } from "./meetingStore.js";
import { logEvent } from "./observability.js";
import type { PostMeetingAgent } from "./outcome.js";
import { buildTranscriptCandidate, executeConfirmTranscriptCandidate, saveTranscriptCandidate } from "./transcriptCandidate.js";
import { capturedAtOf, transcriptContentHash } from "./transcriptHash.js";
import { FEISHU_TRANSCRIPT_PARSER_VERSION, parseFeishuTranscriptText } from "./transcriptMarkdown.js";

/**
 * 会议链路 G：会开完以后自动拿飞书妙记。
 * - 订阅「妙记生成」（minutes.minute.generated_v1，长连接收进 feishu_events，再由 jobs 交到这里），另有每 5 分钟一次的轮询兜底；
 * - 妙记还没生成时会议记为 waiting（对话里问到就答「还在生成」）；飞书没接、主持人没授权、或等了 24 小时还没有，记为 manual，退回现有的手动上传；
 * - 全文取 /artifacts 的 data.transcript（与 lark-cli 读到的逐字相同，来源记下摘要值）；读取失败记 failed 和原因，
 *   原文还没好（not_ready）的照常跟着轮询和事件再取，主持人或创建人也可以「再读一次」或贴妙记链接；
 * - 拿到逐字稿先生成候选（与手动上传同一条路）；说话人都能唯一对上人时直接确认，开始解读纪要，对不上的留给主持人在会议页确认；
 * - 实际参会名单从飞书会议拿（中途加入的也算），拿不到就退回手填的参会人。
 */
export const MEETING_MINUTES_POLL_KIND = "meeting.minutes_poll";
export const FEISHU_MINUTES_EVENT = "minutes.minute.generated_v1";
const POLL_EVERY_MS = 5 * 60_000;
/** 开完多久以内的会才自动去拿（更早的会照旧手动上传）。 */
const RECENT_MS = 48 * 60 * 60_000;
/** 等妙记最多等多久，过了就退回手动上传。 */
const GIVE_UP_MS = 24 * 60 * 60_000;
/** 妙记的开始时刻和会议计划开始时刻最多差多少还算同一场会。 */
const MATCH_WINDOW_MS = 3 * 60 * 60_000;
/** 还在等妙记的会：waiting，以及读的时候原文还没好的（failed / not_ready）。 */
const STILL_WAITING = "(minutes_status = 'waiting' OR (minutes_status = 'failed' AND minutes_failure = 'not_ready'))";
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
  const source = event.minute_source as { source_type?: unknown; source_entity_id?: unknown } | undefined;
  return { minuteToken: token, feishuMeetingId: typeof source?.source_entity_id === "string" && source.source_entity_id ? source.source_entity_id : null };
}

export function createMeetingMinutesService(deps: MeetingMinutesDeps) {
  const { pool, peopleDirectory, outcomeAgent, secret, feishu } = deps;
  const feishuWebOrigin = deps.feishuWebOrigin?.replace(/\/+$/, "");
  const now = deps.now ?? (() => new Date());
  const q: Query = pool.query.bind(pool);

  const identity = async (personId: string): Promise<FeishuIdentity | null> =>
    ((await q("SELECT person_id, open_id, name FROM feishu_identities WHERE person_id = $1", [personId])).rows[0] as FeishuIdentity | undefined) ?? null;
  const tokenFor = (personId: string) => (feishu ? activeUserAccessToken(q, feishu.env, personId, now()) : Promise.resolve(null));

  /** failed 也记等待起点：原文还没好的跟着轮询再取，等满 24 小时同样退回手动上传。 */
  async function setStatus(meetingId: string, status: TMeetingMinutesStatus, error: string | null = null, failure: TMeetingMinutesFailure | null = null): Promise<void> {
    await q(
      `UPDATE meetings SET minutes_status = $2, minutes_error = $3, minutes_failure = $4,
         minutes_waiting_since = CASE WHEN $2 IN ('waiting', 'failed') THEN COALESCE(minutes_waiting_since, now()) ELSE minutes_waiting_since END
       WHERE id = $1`,
      [meetingId, status, error, failure],
    );
  }

  async function fail(meetingId: string, failure: TMeetingMinutesFailure, error: string): Promise<IngestResult> {
    await setStatus(meetingId, "failed", error, failure);
    logEvent({ event: "meeting.minutes", objectRef: `meeting:${meetingId}`, status: "failed", errorCode: failure });
    return { kind: "failed" };
  }

  /** 开完的会记为 waiting（飞书拿得到）或 manual（拿不到）；等太久的也退回 manual。 */
  async function markEnded(at: Date): Promise<void> {
    const ended = await q(
      `SELECT id, lead_dri_id FROM meetings
        WHERE status = 'scheduled' AND minutes_status = 'none' AND transcript IS NULL AND transcript_candidate IS NULL
          AND COALESCE(ended_at, ends_at) <= $1 AND COALESCE(ended_at, ends_at) > $2`,
      [at, new Date(at.getTime() - RECENT_MS)],
    );
    for (const row of ended.rows as { id: string; lead_dri_id: string }[]) {
      const reachable = Boolean(feishu && await identity(row.lead_dri_id) && await tokenFor(row.lead_dri_id));
      await setStatus(row.id, reachable ? "waiting" : "manual", reachable ? null : "主持人没有可用的飞书授权");
    }
    await q(
      `UPDATE meetings SET minutes_status = 'manual', minutes_failure = NULL, minutes_error = '等了 24 小时还没拿到妙记'
        WHERE ${STILL_WAITING} AND minutes_waiting_since < $1 AND transcript IS NULL AND transcript_candidate IS NULL`,
      [new Date(at.getTime() - GIVE_UP_MS)],
    );
    // 已经有逐字稿或候选的（手动上传、录音转写）一律算 ready，轮询不再管。
    await q(`UPDATE meetings SET minutes_status = 'ready', minutes_failure = NULL
      WHERE minutes_status IN ('waiting', 'manual', 'failed') AND (transcript IS NOT NULL OR transcript_candidate IS NOT NULL)`);
  }

  async function waitingMeetings(): Promise<MeetingRow[]> {
    return (await q(`SELECT ${meetingColumns()} FROM meetings WHERE ${STILL_WAITING} AND status = 'scheduled'
      AND transcript IS NULL AND transcript_candidate IS NULL ORDER BY scheduled_at`)).rows as MeetingRow[];
  }

  /** 实际参会名单：飞书会议的参会人 open_id 换成天枢的人；一个都对不上时不改（退回手填名单）。 */
  async function actualAttendees(token: string, feishuMeetingId: string): Promise<string[] | null> {
    if (!feishu) return null;
    const openIds = await feishu.api.meetingParticipants(token, feishuMeetingId).catch(() => [] as string[]);
    if (!openIds.length) return null;
    const mapped = (await q("SELECT person_id FROM feishu_identities WHERE open_id = ANY($1::text[]) ORDER BY person_id", [openIds])).rows.map((row) => row.person_id as string);
    return mapped.length ? mapped : null;
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
   * → 生成候选（来源带地址、标题、摘要值和读取时刻）→ 说话人都对得上就直接确认并解读纪要。读不到或解析不了记 failed 和原因；
   * 自动拉取遇到临时故障不改状态（下一轮再取）。候选没能写进去时把妙记还回去，不让它锁在这场会上。
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
    if (attendees) await q("UPDATE meetings SET attendees_actual = $2::jsonb WHERE id = $1", [meeting.id, JSON.stringify(attendees)]);

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
    const candidate = buildTranscriptCandidate(parsed.transcript.turns, await peopleWithFeishuNames(), source);
    const saved = await saveTranscriptCandidate(pool, meeting.id, candidate);
    if (!("row" in saved)) {
      await q("UPDATE meetings SET minute_token = $3 WHERE id = $1 AND minute_token = $2", [meeting.id, minute.token, meeting.minute_token]);
      return { kind: "rejected", status: saved.status, code: saved.code, message: saved.message };
    }
    await setStatus(meeting.id, "ready");
    logEvent({ event: "meeting.minutes", objectRef: `meeting:${meeting.id}`, status: "fetched" });

    // 说话人都唯一对上、且不重复时直接确认；否则留给主持人在会议页确认说话人。
    const ids = candidate.speakers.map((speaker) => speaker.suggestedPersonId);
    if (ids.every(Boolean) && new Set(ids).size === ids.length) {
      await executeConfirmTranscriptCandidate(pool, peopleDirectory, outcomeAgent, secret,
        { actionType: "meeting.confirm_transcript_candidate", objectType: "meeting", objectId: meeting.id, objectVersion: saved.row.version },
        { speakerMappings: candidate.speakers.map((speaker) => ({ speakerName: speaker.speakerName, personId: speaker.suggestedPersonId! })), confirmAddParticipants: true },
        `feishu-minutes:${minute.token}`);
    }
    return { kind: "ready" };
  }

  /** 按 token 读（再读一次、贴链接）：先取妙记详情（标题、开会时刻），再走 ingest。 */
  async function ingestByToken(api: FeishuMinutesApi, meeting: MeetingRow, token: string, minuteToken: string, replace: boolean): Promise<IngestResult> {
    let minute: FeishuMinuteInfo;
    try {
      minute = await api.getMinute(token, minuteToken);
    } catch (error) {
      return fail(meeting.id, minutesFailureOf(error), (error as Error).message);
    }
    return ingest(api, meeting, minute, token, minute.meetingId, { replace, manual: true });
  }

  /** 妙记和会议对得上：同一个主持人名下，开始时刻离计划开始最近（3 小时以内）。 */
  function closest(meeting: MeetingRow, minutes: FeishuMinuteInfo[]): FeishuMinuteInfo | null {
    const start = meeting.scheduled_at.getTime();
    const scored = minutes
      .filter((minute) => minute.createdAt && Math.abs(minute.createdAt.getTime() - start) <= MATCH_WINDOW_MS)
      .sort((a, b) => Math.abs(a.createdAt!.getTime() - start) - Math.abs(b.createdAt!.getTime() - start));
    return scored[0] ?? null;
  }

  /** 主持人名下、这场会前后的妙记里开始时刻最近的一份（已对到别的会的不算）。 */
  async function findMinute(api: FeishuMinutesApi, meeting: MeetingRow, openId: string, token: string): Promise<FeishuMinuteInfo | null> {
    const listed = await api.listMinutes(token, { openId }, {
      start: new Date(meeting.scheduled_at.getTime() - MATCH_WINDOW_MS), end: new Date(meeting.ends_at.getTime() + MATCH_WINDOW_MS) });
    const used = new Set((await q("SELECT minute_token FROM meetings WHERE minute_token IS NOT NULL AND id <> $1", [meeting.id])).rows.map((row) => row.minute_token as string));
    return closest(meeting, listed.filter((item) => !used.has(item.token)));
  }

  /** 轮询兜底：每场还在等的会，用主持人的授权列他名下这段时间的妙记。 */
  async function poll(): Promise<void> {
    if (!feishu) return;
    for (const meeting of await waitingMeetings()) {
      const host = await identity(meeting.lead_dri_id);
      const token = host ? await tokenFor(meeting.lead_dri_id) : null;
      if (!host || !token) {
        await setStatus(meeting.id, "manual", "主持人没有可用的飞书授权");
        continue;
      }
      try {
        const minute = await findMinute(feishu.api, meeting, host.open_id, token);
        if (minute) await ingest(feishu.api, meeting, minute, token, minute.meetingId);
      } catch (error) {
        logEvent({ event: "meeting.minutes", objectRef: `meeting:${meeting.id}`, status: "poll_failed", errorCode: error instanceof FeishuApiError ? String(error.code) : "POLL_FAILED" });
      }
    }
  }

  /**
   * 「妙记生成」事件：先按飞书会议 id 对；对不上就拿每场 waiting 的会的主持人授权去读这份妙记，
   * 读得到、属于主持人、开始时刻对得上的就是它。
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
      const host = await identity(meeting.lead_dri_id);
      const token = host ? await tokenFor(meeting.lead_dri_id) : null;
      if (!host || !token) continue;
      const minute = await feishu.api.getMinute(token, found.minuteToken).catch(() => null);
      if (!minute || (minute.ownerOpenId && minute.ownerOpenId !== host.open_id)) continue;
      if (!byFeishuId && !closest(meeting, [minute])) continue;
      const result = await ingest(feishu.api, meeting, { ...minute, meetingId: minute.meetingId ?? found.feishuMeetingId }, token, found.feishuMeetingId);
      if (result.kind !== "taken") return;
    }
  }

  /** 主持人和建会的人（没记时按主持人算）能再读、贴链接；别人一律当会议不存在。 */
  async function fetchableMeeting(meetingId: string, viewerId: string): Promise<MeetingRow | null> {
    const meeting = await getMeetingRow(q, meetingId);
    return meeting && (meeting.lead_dri_id === viewerId || (meeting.created_by ?? meeting.lead_dri_id) === viewerId) ? meeting : null;
  }

  async function respond(meetingId: string, result: IngestResult): Promise<MinutesFetchResult> {
    if (result.kind === "rejected") return { error: { status: result.status, code: result.code, message: result.message } };
    if (result.kind === "taken") return { error: { status: 409, code: "MINUTE_TAKEN", message: "这份妙记已经对到别的会上了" } };
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
    const host = await identity(meeting.lead_dri_id);
    const token = host ? await tokenFor(meeting.lead_dri_id) : null;
    if (!feishu || !host || !token) return respond(meeting.id, await fail(meeting.id, "no_permission", "主持人没有可用的飞书授权"));
    if (meeting.minute_token) return respond(meeting.id, await ingestByToken(feishu.api, meeting, token, meeting.minute_token, false));
    let minute: FeishuMinuteInfo | null;
    try {
      minute = await findMinute(feishu.api, meeting, host.open_id, token);
    } catch (error) {
      return respond(meeting.id, await fail(meeting.id, minutesFailureOf(error), (error as Error).message));
    }
    // 没找到多半是妙记还没生成：记 not_ready，轮询和「妙记生成」事件照常接着找。
    if (!minute) return respond(meeting.id, await fail(meeting.id, "not_ready", "主持人名下还没有这场会的妙记"));
    return respond(meeting.id, await ingest(feishu.api, meeting, minute, token, minute.meetingId, { manual: true }));
  }

  /** 贴妙记链接：用主持人的授权按链接里的 token 读（换掉原来对上的那份）；逐字稿已经确认过的不再读。 */
  async function readLink(meetingId: string, viewerId: string, url: string): Promise<MinutesFetchResult> {
    const meeting = await fetchableMeeting(meetingId, viewerId);
    if (!meeting) return { error: MEETING_NOT_FOUND };
    const minuteToken = minuteTokenFromUrl(url);
    if (!minuteToken) return { error: { status: 400, code: "INVALID_MINUTES_URL", message: "只认飞书妙记链接：https://<租户>.feishu.cn/minutes/<token>" } };
    if (meeting.transcript) return { error: { status: 409, code: "TRANSCRIPT_ALREADY_IMPORTED", message: "这场会的逐字稿已经确认过了" } };
    if (meeting.status !== "scheduled") return { error: NOT_SCHEDULED };
    const token = await tokenFor(meeting.lead_dri_id);
    if (!feishu || !token) return respond(meeting.id, await fail(meeting.id, "no_permission", "主持人没有可用的飞书授权"));
    return respond(meeting.id, await ingestByToken(feishu.api, meeting, token, minuteToken, true));
  }

  return {
    markEnded,
    poll,
    onMinuteGenerated,
    refetch,
    readLink,
    async tick(): Promise<void> {
      await markEnded(now());
      await poll();
    },
  };
}

export type MeetingMinutesService = ReturnType<typeof createMeetingMinutesService>;

export function meetingMinutesJobs(service: MeetingMinutesService): { handlers: Record<string, JobHandler>; recurring: RecurringJob[]; events: Record<string, (payload: Record<string, unknown>) => Promise<void>> } {
  return {
    handlers: { [MEETING_MINUTES_POLL_KIND]: () => service.tick() },
    recurring: [{ kind: MEETING_MINUTES_POLL_KIND, everyMs: POLL_EVERY_MS }],
    events: { [FEISHU_MINUTES_EVENT]: (payload) => service.onMinuteGenerated(payload) },
  };
}
