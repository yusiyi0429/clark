import type { TPartnerMeetingItem, TPartnerMeetingRecordResponse, TStoredTranscriptCandidate } from "@warmap/contracts";
import type { FeishuCalendarFeedService } from "./feishuCalendarFeed.js";
import { meetingJoinUrl } from "./feishu/calendar.js";
import type { MeetingMinutesService } from "./meetingMinutes.js";
import { transcriptContentHash } from "./transcriptHash.js";
import { getMeetingRow, partnerMeetingColumns, projectPreflight, UUID_PATTERN, type MeetingRow, type Query } from "./meetingStore.js";

const DAY = 86_400_000;
type Viewer = { personId: string; role: "ceo" | "member" };
export type MinuteReader = Pick<MeetingMinutesService, "checkMinuteFor" | "readMinuteFor">;
type AudienceRow = Pick<MeetingRow, "ceo_participant_id" | "lead_dri_id" | "created_by" | "invited_person_ids" | "participants" | "attendees_actual">;
type FeedRow = Pick<MeetingRow, "id" | "title" | "status" | "scheduled_at" | "ends_at" | "ended_at" | "started_at" | "minute_token" |
  "minute_binding" | "minutes_status" | "minutes_failure" | "minutes_error" | "feishu_event_status" | "feishu_event_join_url" |
  "feishu_event_id" | "preflight" | "group_inputs" | "latest_recording"> & AudienceRow & {
    has_transcript: boolean; transcript_format: string | null; transcript_url: string | null; has_candidate: boolean;
    outcome_status: string | null; mine: number; recording_sources?: string[];
  };
type ItemStatus = Pick<TPartnerMeetingItem,"stage"|"statusText"|"needsAction">;
const status = (stage: ItemStatus["stage"], statusText: string, needsAction = false): ItemStatus => ({ stage, statusText, needsAction });
const unavailable = { error: { status: 404, code: "MEETING_NOT_FOUND", message: "会议不存在" } } as const;
const proven = (row: Pick<MeetingRow,"minute_binding">) => row.minute_binding === "source_id" || row.minute_binding === "owner";
const confirmedRoster = (row: AudienceRow) => row.invited_person_ids ?? row.participants.map(p => p.personId).filter(id => id !== row.ceo_participant_id);
/** 权限或职务不自动订阅会议。拿得到的实际名单（包括空的内部名单）优先。 */
export function isPartnerMeetingRecipient(row: AudienceRow, personId: string, afterMeeting: boolean): boolean {
  if (row.lead_dri_id === personId) return true;
  if (!afterMeeting && row.created_by === personId) return true;
  return (afterMeeting ? row.attendees_actual ?? confirmedRoster(row) : confirmedRoster(row)).includes(personId);
}

export async function leftPartnerMeeting(q: Query, meetingId: string, personId: string) {
  return (await q("SELECT 1 FROM thread_members WHERE object_type='meeting' AND object_id=$1 AND person_id=$2 AND left_at IS NOT NULL", [meetingId, personId])).rows.length > 0;
}

function feishuTranscript(row: MeetingRow): boolean {
  const format = row.transcript?.source?.format ?? row.transcript_candidate?.source.format;
  return format === "feishu_minutes" || (!format && Boolean(row.transcript && (row.minute_token || row.minute_binding)));
}

/** A direct link has to establish both application access and the caller's current permission to read the actual source text. */
export async function canReadMeetingSource(q: Query, minutes: MinuteReader | undefined, row: MeetingRow, viewer: Viewer): Promise<boolean> {
  if (!feishuTranscript(row)) return true;
  if (!minutes || row.status === "cancelled" || !row.minute_token || !proven(row)
    || (viewer.role !== "ceo" && !isPartnerMeetingRecipient(row,viewer.personId,true) && row.created_by !== viewer.personId)
    || await leftPartnerMeeting(q,row.id,viewer.personId)) return false;
  const source = row.transcript?.source ?? row.transcript_candidate?.source;
  const current = await minutes.readMinuteFor(viewer.personId,row.minute_token);
  return !("error" in current) && Boolean(source?.contentHash && source.contentHash === transcriptContentHash(current.text));
}

export async function meetingForViewer(q: Query, minutes: MinuteReader | undefined, row: MeetingRow, viewer: Viewer): Promise<MeetingRow> {
  if (await canReadMeetingSource(q,minutes,row,viewer)) return row;
  return { ...row, transcript: null, transcript_candidate: null, outcome: null, decisions: [], card_confirmed: false,
    minutes_status: "failed", minutes_failure: "no_permission" };
}

function safeLink(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return (url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

function preflightText(row: FeedRow): string {
  const report = projectPreflight(row);
  if (report.status === "failed") return "预审失败，打开会议查看原因";
  if (report.status === "pending") return "预审排队中";
  if (report.status === "running") return "预审生成中";
  if (report.staleInputs || report.inputsChangedDuringRun) return "材料或讨论有变化，预审待更新";
  return `预审已出${report.decision || report.summary?.priorityAction || report.brief ? " · " + (report.decision || report.summary?.priorityAction || report.brief).slice(0,120) : ""}`;
}

function realRecord(row: FeedRow): boolean {
  return row.has_transcript && (row.transcript_format !== "feishu_minutes" || proven(row));
}

export function partnerMeetingStatus(row: FeedRow, now: Date, personId: string): ItemStatus {
  const host = row.lead_dri_id === personId;
  if (realRecord(row)) {
    if (row.outcome_status === "failed") return status("ready", "逐字稿已到 · 会后整理失败", host || row.created_by === personId);
    return status("ready", row.mine ? `记录已到 · ${row.mine} 条待你确认` :
      row.outcome_status === "pending" || row.outcome_status === "running" ? "逐字稿已到 · 会议卡生成中" : "会议记录已到", row.mine > 0);
  }
  if (row.has_transcript && row.transcript_format === "feishu_minutes") return status("processing", "等妙记所有者核对场次");
  if (row.has_candidate) return status(host ? "attention" : "processing", host ? "逐字稿待你确认说话人" : "逐字稿待主持人确认", host);
  const rec = row.latest_recording;
  if (rec?.status === "failed") return status("attention", "录音转写失败，打开会议查看原因", host);
  if (rec?.status === "transcoding" || rec?.status === "uploading" || rec?.status === "transcribing")
    return status("processing", rec.status === "transcribing" ? "录音转写中" : rec.status === "transcoding" ? "录音转码中" : "录音上传中");
  if (rec?.status === "recording") return status(row.ended_at ? "attention" : "live", row.ended_at ? "会议已结束，录音待上传" : "录音进行中", Boolean(row.ended_at && host));
  if (row.started_at && !row.ended_at && row.status === "scheduled" && (!row.minutes_status || row.minutes_status === "none"))
    return status("live", "会议进行中");
  if (row.minutes_failure === "not_ready" || row.minutes_status === "waiting") return status("processing", "等飞书妙记");
  if (row.minutes_failure === "no_permission" || (row.minutes_status === "manual" && row.minutes_error?.includes("授权")))
    return status("attention", "缺少飞书授权，会议记录尚未取回", host || row.created_by === personId);
  if (row.minutes_status === "failed" || row.minutes_status === "manual")
    return status("attention", row.minutes_failure === "not_found" ? "飞书里找不到这份妙记" :
      row.minutes_status === "manual" ? "尚未拿到会议记录，可补记录" : "妙记读取失败，可在会议页重试", host || row.created_by === personId);
  if (row.ended_at || row.ends_at <= now || row.status !== "scheduled")
    return row.feishu_event_status === "booked" && !row.started_at && !row.ended_at
      ? status("attention", "未收到开始记录，可核对场次", host)
      : row.feishu_event_status === "booked" && now.getTime() - (row.ended_at ?? row.ends_at).getTime() < 2*3_600_000
        ? status("processing", "等飞书妙记") : status("attention", "缺会议记录，可在会议页补录", host);
  if (row.feishu_event_status === "waiting_auth") return status("scheduled", "待组织者连接飞书", row.created_by === personId || (!row.created_by && host));
  if (row.feishu_event_status === "failed") return status("scheduled", "飞书建会失败，可在会议页重试", host || row.created_by === personId);
  if (row.feishu_event_status === "pending") return status("scheduled", "飞书建会中");
  if (row.feishu_event_status === "booked" && !meetingJoinUrl(row.feishu_event_join_url)) return status("scheduled", "已预约 · 飞书尚未返回入会地址");
  return status("scheduled", row.scheduled_at <= now ? "已到预约时间" : "已预约", row.preflight.status === "failed" && host);
}

function afterMeeting(row: FeedRow, now: Date): boolean {
  return Boolean(row.ended_at || row.status !== "scheduled" || row.has_transcript || row.has_candidate || row.ends_at <= now);
}

function noLongerReadable(error: { code: string; message: string }): ItemStatus {
  if (error.code === "MINUTES_NOT_READY") return status("processing", error.message);
  return status("attention", error.message, error.code === "FEISHU_NOT_CONNECTED");
}

export async function listPartnerMeetings(q: Query, minutes: MinuteReader, calendar: FeishuCalendarFeedService, viewer: Viewer, now: Date): Promise<TPartnerMeetingItem[]> {
  const { personId } = viewer;
  const cutoff = new Date(now.getTime() - 7*DAY);
  const through = new Date(now.getTime() + 7*DAY);
  const [meetings, inbox, events] = await Promise.all([
    q(`SELECT ${partnerMeetingColumns()}, mine.n AS mine FROM meetings m
      LEFT JOIN LATERAL (SELECT count(*)::integer AS n FROM meeting_cards k,
        jsonb_array_elements(COALESCE(k.decisions,'[]') || COALESCE(k.action_items,'[]')) e
        WHERE k.meeting_id=m.id AND e#>>'{review,status}'='pending' AND COALESCE(e->>'ownerPersonId',m.lead_dri_id)=$1
          AND (k.current_revision IS NULL OR k.action_items @> jsonb_build_array(e))) mine ON true
      WHERE m.status<>'cancelled' AND (
        m.lead_dri_id=$1 OR m.created_by=$1 OR m.attendees_actual ? $1 OR $1=ANY(m.invited_person_ids)
        OR (m.invited_person_ids IS NULL AND m.participants @> jsonb_build_array(jsonb_build_object('personId',$1::text))))
      AND NOT EXISTS (SELECT 1 FROM thread_members t WHERE t.object_type='meeting' AND t.object_id=m.id::text AND t.person_id=$1 AND t.left_at IS NOT NULL)
      AND (COALESCE(m.ended_at,m.ends_at) >= $2 OR mine.n>0 OR m.transcript IS NOT NULL OR m.minutes_status IN ('waiting','failed','manual')
        OR m.transcript_candidate IS NOT NULL OR m.outcome->>'status' IN ('failed','pending','running')
        OR m.status='scheduled' AND m.transcript IS NULL) ORDER BY m.scheduled_at,m.id`, [personId,cutoff]),
    q(`SELECT i.minute_token,i.title,i.starts_at,i.ends_at,i.source_url FROM feishu_minute_inbox i WHERE i.owner_id=$1 AND i.status='pending'
      AND NOT EXISTS(SELECT 1 FROM meetings m WHERE m.minute_token=i.minute_token AND m.minute_binding IN ('source_id','owner'))
      ORDER BY i.starts_at DESC`, [personId]),
    calendar.listFor(personId),
  ]);
  const items: TPartnerMeetingItem[] = [];
  const booked = new Set<string>();
  for (const row of meetings.rows as FeedRow[]) {
    if (row.feishu_event_id) booked.add(row.feishu_event_id);
    const ended = afterMeeting(row, now);
    if (!isPartnerMeetingRecipient(row, personId, ended)) continue;
    const manager = row.lead_dri_id === personId || row.created_by === personId;
    if (row.transcript_format === "feishu_minutes" && !proven(row)) {
      if (!manager) continue;
      // A pending minute is its owner's sole receipt until the association is established.
      if (inbox.rows.some(i => i.minute_token === row.minute_token)) continue;
    }
    let summary = partnerMeetingStatus(row, now, personId);
    const sources: NonNullable<TPartnerMeetingItem["sources"]> = [];
    const recordPath = `/api/me/partner-meetings/${encodeURIComponent(row.id)}/record`;
    if (realRecord(row) && row.transcript_format !== "feishu_minutes")
      sources.push({ label: row.transcript_format === "volc_asr" ? "本机录音逐字稿" : "已确认的会议记录", recordHref: recordPath, sourceUrl: safeLink(row.transcript_url) });
    if (row.minute_token && proven(row)) {
      const source = await minutes.checkMinuteFor(personId, row.minute_token, false, true);
      if (source.error && !sources.length) summary = noLongerReadable(source.error);
      if (!source.error) {
        sources.push({ label: "飞书妙记", recordHref: sources.length || row.has_candidate ? recordPath + "?source=feishu" : recordPath, sourceUrl: safeLink(source.sourceUrl) });
      }
    }
    const join = !ended && row.feishu_event_status === "booked" ? meetingJoinUrl(row.feishu_event_join_url) : null;
    for (const recordingId of row.recording_sources ?? []) {
      if (realRecord(row) || row.lead_dri_id === personId)
        sources.push({ label:"本机录音转写（原始）", recordHref:`${recordPath}?recordingId=${recordingId}`, sourceUrl:null });
    }
    if (realRecord(row) && sources.length && summary.stage === "attention" && row.transcript_format === "feishu_minutes")
      summary = status("ready","本机录音转写可读 · 飞书妙记暂不可读");
    items.push({ id: `meeting:${row.id}`, meetingId: row.id, at: row.scheduled_at.toISOString(), endsAt: row.ends_at.toISOString(), title: row.title,
      ...summary, href: viewer.role === "ceo" ? `/meetings/${row.id}` : `/me/work/meetings/${row.id}`,
      source: row.transcript_format === "feishu_minutes" || (!row.has_transcript && (row.feishu_event_status || row.minute_token)) ? "feishu" : "tianshu",
      joinUrl: join, canStartRecording: !ended && row.status === "scheduled" && (row.lead_dri_id === personId || viewer.role === "ceo") && !row.latest_recording,
      preflightText: ended ? null : preflightText(row), recordHref: sources[0]?.recordHref ?? null, sourceUrl: sources[0]?.sourceUrl ?? null,
      ...(sources.length ? { sources } : {}),
    });
  }
  for (const row of inbox.rows) {
    const source = await minutes.checkMinuteFor(personId, row.minute_token, true, true);
    if (source.error?.code === "MINUTE_NOT_FOUND" || source.error?.code === "MINUTES_NOT_FOUND") continue;
    const token = encodeURIComponent(row.minute_token);
    items.push({ id: `feishu-minute:${row.minute_token}`, meetingId: null, title: row.title, at: row.starts_at.toISOString(), endsAt: row.ends_at.toISOString(),
      stage: "unmatched", statusText: source.error?.message ?? "妙记已发现 · 待你选择场次", needsAction: true, source: "feishu", joinUrl: null,
      href: `/me/work/buddy#minute-${token}`, sourceUrl: source.error ? null : safeLink(source.sourceUrl) ?? safeLink(row.source_url),
      recordHref: source.error ? null : `/api/me/partner-meetings/minutes/${token}` });
  }
  for (const event of events) {
    if (new Date(event.startsAt) > through || new Date(event.endsAt) <= now || booked.has(event.eventId) || booked.has(event.eventId.replace(/_\d+$/,""))) continue;
    const sourceUrl = safeLink(event.url);
    items.push({ id: `feishu-event:${event.eventId}`, meetingId: null, title: event.title, at: event.startsAt, endsAt: event.endsAt,
      allDay: event.allDay, stage: "scheduled", statusText: "飞书日程", needsAction: false, source: "feishu", joinUrl: null,
      sourceUrl, href: sourceUrl ?? "/me/work/buddy" });
  }
  const upcoming = (i: TPartnerMeetingItem) => i.stage === "live" ? 0 : i.stage === "scheduled" ? 1 : 2;
  return items.sort((a,b) => upcoming(a)-upcoming(b) || (upcoming(a) === 1 ? a.at.localeCompare(b.at) : b.at.localeCompare(a.at)) || a.id.localeCompare(b.id));
}

type RecordResult = TPartnerMeetingRecordResponse | { error: { status: number; code: string; message: string } };
export async function readPartnerMeetingRecord(q: Query, minutes: MinuteReader, viewer: Viewer, meetingId: string, source?: "tianshu" | "feishu", recordingId?: string): Promise<RecordResult> {
  const row = await getMeetingRow(q, meetingId);
  if (!row || row.status === "cancelled" || !isPartnerMeetingRecipient(row, viewer.personId, true) || await leftPartnerMeeting(q,meetingId,viewer.personId)) return unavailable;
  const transcript = row.transcript;
  if (recordingId) {
    if (!UUID_PATTERN.test(recordingId) || (!transcript && row.lead_dri_id !== viewer.personId)) return unavailable;
    const result = await q("SELECT transcript_candidate FROM meeting_recordings WHERE meeting_id=$1 AND id=$2 AND status='done'",[meetingId,recordingId]);
    const candidate = result.rows[0]?.transcript_candidate as TStoredTranscriptCandidate | null;
    if (!candidate) return unavailable;
    return { title:row.title, sourceUrl:null, text:candidate.turns.map(turn=>`${turn.speakerName} · ${turn.offsetSeconds} 秒\n${turn.text}`).join("\n\n") };
  }
  if (source === "feishu" || (source !== "tianshu" && (!transcript || feishuTranscript(row)))) {
    if (!row.minute_token || !proven(row)) return unavailable;
    return minutes.readMinuteFor(viewer.personId, row.minute_token);
  }
  if (!transcript || feishuTranscript(row)) return unavailable;
  const speakers = new Map(row.participants.map(p => [p.personId,p.displayName]));
  for (const p of transcript.unmappedSpeakers ?? []) speakers.set(p.id,p.name);
  const text = transcript.turns.map(turn => `${speakers.get(turn.speakerId) ?? "发言人"} · ${turn.startedAt ?? ""}\n${turn.text}`).join("\n\n");
  return { title: row.title, text, sourceUrl: safeLink(transcript.source?.url) };
}

export async function readPartnerMinute(q: Query, minutes: MinuteReader, viewer: Viewer, token: string): Promise<RecordResult> {
  const owned = await q(`SELECT 1 FROM feishu_minute_inbox i WHERE i.minute_token=$1 AND i.owner_id=$2 AND i.status='pending'
    AND NOT EXISTS(SELECT 1 FROM meetings m WHERE m.minute_token=i.minute_token AND m.minute_binding IN ('source_id','owner'))`, [token,viewer.personId]);
  return owned.rows.length ? minutes.readMinuteFor(viewer.personId, token, true) : unavailable;
}
