import { createHash } from "node:crypto";
import type { Pool } from "pg";
import type {
  TCard,
  TMeetingParticipant,
  TPersonResult,
  TStoredTranscript,
  TStoredTranscriptCandidate,
  TTranscriptCandidateSpeaker,
  TTranscriptSource,
  TTranscriptTurn,
  TUnmappedSpeaker,
  TWarmapTranscript,
} from "@warmap/contracts";
import type { ActionScope } from "./actionToken.js";
import type { PeopleDirectory } from "./peopleDirectory.js";
import {
  appendFingerprint,
  commit,
  getMeetingRow,
  meetingColumns,
  projectMeetingCard,
  updateMeeting,
  withMeetingLock,
  type MeetingActionError,
  type MeetingActionOutcome,
  type MeetingRow,
} from "./meetingStore.js";
import { pendingOutcome, runOutcome, validateTranscript, type PostMeetingAgent } from "./outcome.js";
import { logEvent } from "./observability.js";
import type { ParsedTranscriptTurn } from "./transcriptMarkdown.js";
import { extractTranscriptText, recognizeTranscript } from "./transcriptFile.js";
import { capturedAtOf, meetingTranscriptUrl, transcriptContentHash } from "./transcriptHash.js";
import { MINUTES_GIVE_UP_MS } from "./meetingDecisionView.js";

export type TranscriptCandidateResult =
  | { status: 200; card: TCard }
  | { status: 400 | 404 | 409; code: string; message: string; fieldErrors?: Record<string, string> };

export function projectPerson(person: TPersonResult): TMeetingParticipant {
  return { personId: person.personId, displayName: person.displayName, roles: [...person.roles], sourceRef: person.sourceRef, updatedAt: person.updatedAt };
}

/** 声纹 1:N 给出的说话人建议（录音识别路径）；score 为 0–100。 */
export type SpeakerSuggestion = { personId: string; displayName: string; score: number };

/**
 * 候选构建：exact displayName 只在人员目录唯一命中时给出建议；否则用声纹建议（录音识别的「说话人 N」只能靠它）；
 * 都没有就留空由 CEO 手选。建议只是预填，确认仍由人做。
 * speaker 顺序保持来源首次出现顺序，不合并相邻同说话人。
 */
export function buildTranscriptCandidate(
  turns: ParsedTranscriptTurn[],
  people: TPersonResult[],
  source: TTranscriptSource,
  voiceprint?: Map<string, SpeakerSuggestion>,
): TStoredTranscriptCandidate {
  const byName = new Map<string, TPersonResult[]>();
  for (const person of people) {
    const list = byName.get(person.displayName) ?? [];
    list.push(person);
    byName.set(person.displayName, list);
  }
  const order: string[] = [];
  const counts = new Map<string, number>();
  for (const turn of turns) {
    if (!counts.has(turn.speakerName)) order.push(turn.speakerName);
    counts.set(turn.speakerName, (counts.get(turn.speakerName) ?? 0) + 1);
  }
  const warnings: string[] = [];
  const speakers: TTranscriptCandidateSpeaker[] = order.map((speakerName) => {
    const matches = byName.get(speakerName) ?? [];
    const unique = matches.length === 1 ? matches[0] : null;
    const heard = unique ? undefined : voiceprint?.get(speakerName);
    if (heard) warnings.push(`说话人「${speakerName}」按声纹建议为「${heard.displayName}」（相似度 ${Math.round(heard.score)}），请确认`);
    else if (!unique) warnings.push(`说话人「${speakerName}」${matches.length === 0 ? "未命中人员目录" : "命中多个同名人员"}，需要人工映射`);
    return {
      speakerName,
      turnCount: counts.get(speakerName)!,
      suggestedPersonId: unique?.personId ?? heard?.personId ?? null,
      suggestedDisplayName: unique?.displayName ?? heard?.displayName ?? null,
    };
  });
  return { source, createdAt: new Date().toISOString(), speakers, turns, warnings };
}

const GENERIC_SPEAKER = /^(speaker|说话人)\s*\d+$/i;
/**
 * 飞书参会名单排除法（10/27）：按名字对完以后，只剩一个没对上的说话人、名单里也只剩一个没对上的人，而且名单里每个人都认得，就是他。
 * 只认飞书的泛称（Speaker 1、说话人 1）；别的名字（例如账号名「Nexus」）不猜。对不上就原样返回，留给主持人在会议卡上指定。
 */
export function suggestByAttendees(candidate: TStoredTranscriptCandidate, attendees: { personIds: string[]; unknown: number } | null, people: TPersonResult[]): TStoredTranscriptCandidate {
  if (!attendees || attendees.unknown > 0) return candidate;
  const open = candidate.speakers.filter((speaker) => !speaker.suggestedPersonId);
  const named = new Set(candidate.speakers.flatMap((speaker) => speaker.suggestedPersonId ? [speaker.suggestedPersonId] : []));
  const left = [...new Set(attendees.personIds)].filter((personId) => !named.has(personId));
  const person = left.length === 1 ? people.find((candidatePerson) => candidatePerson.personId === left[0]) : undefined;
  if (open.length !== 1 || !person || !GENERIC_SPEAKER.test(open[0].speakerName.trim())) return candidate;
  const speakerName = open[0].speakerName;
  return {
    ...candidate,
    speakers: candidate.speakers.map((speaker) => speaker.speakerName === speakerName
      ? { ...speaker, suggestedPersonId: person.personId, suggestedDisplayName: person.displayName } : speaker),
    warnings: [...candidate.warnings.filter((warning) => !warning.startsWith(`说话人「${speakerName}」`)),
      `说话人「${speakerName}」按飞书参会名单对到「${person.displayName}」`],
  };
}

/**
 * 上传会议记录（md/txt/html/docx/pdf）：认得出说话人的只生成候选并 bump version，不改 status、不跑 Outcome；
 * 认不出说话人的按纪要（「会议纪要」一个说话人）存候选后直接确认，和飞书妙记自动确认一样保留为未对上人的说话人，随即生成会议卡。
 * 来源地址是天枢会议页的逐字稿；sha256 算上传的原始字节，摘要值文本文件算原文、docx/pdf/html 算抽出的文字。
 */
export async function createTranscriptCandidate(
  pool: Pool,
  peopleDirectory: PeopleDirectory,
  outcomeAgent: PostMeetingAgent,
  secret: string,
  publicOrigin: string,
  meetingId: string,
  file: { fileName: string; buffer: Buffer },
  hostId?: string,
): Promise<TranscriptCandidateResult> {
  const meeting = await getMeetingRow(pool.query.bind(pool), meetingId);
  if (!meeting || (hostId !== undefined && meeting.lead_dri_id !== hostId)) return { status: 404, code: "MEETING_NOT_FOUND", message: "Meeting 不存在" };
  const extracted = await extractTranscriptText(file);
  if (!extracted.ok) return { status: 400, code: extracted.code, message: extracted.message };
  const parsed = recognizeTranscript(extracted.text);
  if (!parsed.ok) return { status: 400, code: parsed.code, message: parsed.line ? `${parsed.message}（第 ${parsed.line} 行）` : parsed.message };
  const sha256 = createHash("sha256").update(file.buffer).digest("hex");
  const source: TTranscriptSource = {
    format: parsed.format,
    fileName: file.fileName,
    sizeBytes: file.buffer.length,
    sha256,
    parserVersion: parsed.parserVersion,
    timeAnchor: meeting.scheduled_at.toISOString(),
    url: meetingTranscriptUrl(publicOrigin, meetingId),
    contentHash: transcriptContentHash(extracted.kind === "text" ? file.buffer.toString("utf8") : extracted.text),
    capturedAt: capturedAtOf(new Date()),
  };
  const candidate = buildTranscriptCandidate(parsed.turns, peopleDirectory.searchPeople(undefined), source);
  const saved = await saveTranscriptCandidate(pool, meetingId, candidate, hostId);
  if (!("row" in saved)) return saved;
  if (parsed.format !== "meeting_notes") return { status: 200, card: projectMeetingCard(saved.row, secret) };

  // 纪要没有说话人可对：同飞书妙记自动确认，对不上人的保留原名，直接生成会议卡。
  const confirmed = await executeConfirmTranscriptCandidate(pool, peopleDirectory, outcomeAgent, secret,
    { actionType: "meeting.confirm_transcript_candidate", objectType: "meeting", objectId: meetingId, objectVersion: saved.row.version },
    {
      speakerMappings: candidate.speakers.flatMap((speaker) => speaker.suggestedPersonId ? [{ speakerName: speaker.speakerName, personId: speaker.suggestedPersonId }] : []),
      confirmAddParticipants: true,
    },
    `meeting-notes:${sha256}:${saved.row.version}`, hostId, { background: true });
  if ("error" in confirmed) return { status: confirmed.error.status as 400 | 404 | 409, code: confirmed.error.code, message: confirmed.error.message };
  if (confirmed.conflict) return { status: 409, code: "VERSION_CONFLICT", message: "会议刚被改过，请重新上传" };
  return { status: 200, card: confirmed.card };
}

/**
 * 候选落库（妙记 Markdown 与会议录音识别共用）：行锁内确认没有已确认 Transcript、仍是 scheduled，
 * 整份替换候选并 bump version；不改 status、不跑 Outcome。keepExisting（自动拉妙记）：已有候选（用户自己上传的）时不替换。
 */
export async function saveTranscriptCandidate(
  pool: Pool,
  meetingId: string,
  candidate: TStoredTranscriptCandidate,
  hostId?: string,
  { keepExisting = false }: { keepExisting?: boolean } = {},
): Promise<{ row: MeetingRow } | { status: 404 | 409; code: string; message: string }> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const locked = await client.query<MeetingRow>(`SELECT ${meetingColumns()} FROM meetings WHERE id = $1 FOR UPDATE`, [meetingId]);
    if (locked.rowCount !== 1) {
      await client.query("ROLLBACK");
      return { status: 404, code: "MEETING_NOT_FOUND", message: "Meeting 不存在" };
    }
    const row = locked.rows[0];
    if (hostId !== undefined && row.lead_dri_id !== hostId) {
      await client.query("ROLLBACK");
      return { status: 404, code: "MEETING_NOT_FOUND", message: "Meeting 不存在" };
    }
    if (row.transcript) {
      await client.query("ROLLBACK");
      return { status: 409, code: "TRANSCRIPT_ALREADY_IMPORTED", message: "Transcript 已存在，不能生成候选" };
    }
    if (row.status !== "scheduled") {
      await client.query("ROLLBACK");
      return { status: 409, code: "MEETING_NOT_SCHEDULED", message: "只有 scheduled Meeting 可以导入会议记录" };
    }
    if (keepExisting && row.transcript_candidate) {
      await client.query("ROLLBACK");
      return { status: 409, code: "TRANSCRIPT_CANDIDATE_EXISTS", message: "已有会议记录候选" };
    }
    const updated = await client.query<MeetingRow>(
      `UPDATE meetings SET transcript_candidate = $2::jsonb, version = version + 1, updated_at = now() WHERE id = $1 RETURNING ${meetingColumns()}`,
      [meetingId, JSON.stringify(candidate)],
    );
    await client.query("COMMIT");
    return { row: updated.rows[0] };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/**
 * 确认候选：同事务补齐 participants、写标准 Transcript（startedAt = 锁内最新 scheduledAt + offset）、
 * 清候选、status→held、outcome→pending；提交后才启动既有 Outcome Agent。
 * 说话人不用全部对上（10/28）：没映射的不对到人，保留原名记进 unmappedSpeakers，发言的 speakerId 用合成编号 speaker:<n>
 * （n 是说话人首次出现的次序），不进参会人；会议卡上还能指定是谁，不拦任何事。
 */
export async function executeConfirmTranscriptCandidate(
  pool: Pool,
  peopleDirectory: PeopleDirectory,
  outcomeAgent: PostMeetingAgent,
  secret: string,
  scope: ActionScope,
  input: { speakerMappings: { speakerName: string; personId: string }[]; confirmAddParticipants: true },
  fingerprint: string,
  hostId?: string,
  /** 上传纪要时：逐字稿确认完就返回，会议卡在后台接着生成（会议页显示「生成会议卡」带用时），不让上传一直转圈。 */
  { background = false }: { background?: boolean } = {},
): Promise<MeetingActionOutcome> {
  const personById = new Map(peopleDirectory.searchPeople(undefined).map((person) => [person.personId, person]));
  const outcome = await withMeetingLock(pool, scope.objectId, secret, fingerprint, scope.objectVersion, async (client, row) => {
    if (row.status !== "scheduled") {
      return { error: { status: 409, code: "MEETING_NOT_SCHEDULED", message: "只有 scheduled Meeting 可以确认会议记录" } };
    }
    const candidate = row.transcript_candidate;
    if (!candidate) return { error: { status: 409, code: "NO_TRANSCRIPT_CANDIDATE", message: "没有待确认的会议记录候选" } };
    if (row.transcript) return { error: { status: 409, code: "TRANSCRIPT_ALREADY_IMPORTED", message: "Transcript 已存在" } };

    const known = new Set(candidate.speakers.map((speaker) => speaker.speakerName));
    const mappingBySpeaker = new Map<string, string>();
    const usedPersonIds = new Set<string>();
    const invalid = (message: string): { error: MeetingActionError } => ({
      error: { status: 400, code: "INVALID_SPEAKER_MAPPING", message, fieldErrors: { speakerMappings: message } },
    });
    for (const mapping of input.speakerMappings) {
      if (!known.has(mapping.speakerName)) return invalid(`未知说话人：${mapping.speakerName}`);
      if (mappingBySpeaker.has(mapping.speakerName)) return invalid(`说话人重复映射：${mapping.speakerName}`);
      if (!personById.has(mapping.personId)) return invalid(`personId 不在 company-people.v1：${mapping.personId}`);
      // 飞书会把同一个人拆成几个说话人（「刘人豪」与「Speaker 1」），几个说话人可以对到同一人
      mappingBySpeaker.set(mapping.speakerName, mapping.personId);
      usedPersonIds.add(mapping.personId);
    }
    const unmappedSpeakers: TUnmappedSpeaker[] = candidate.speakers.flatMap((speaker, index) =>
      mappingBySpeaker.has(speaker.speakerName) ? [] : [{ id: `speaker:${index + 1}`, name: speaker.speakerName }]);
    for (const speaker of unmappedSpeakers) mappingBySpeaker.set(speaker.name, speaker.id);

    const existingIds = new Set(row.participants.map((participant) => participant.personId));
    const added = [...usedPersonIds].filter((personId) => !existingIds.has(personId)).map((personId) => projectPerson(personById.get(personId)!));
    const participants = [...row.participants, ...added];

    // 录音识别与飞书妙记的 offset 相对实际开始时刻（绝对事实，不随改期漂移）；上传的妙记 Markdown 相对锁内最新 scheduledAt
    const absolute = candidate.source.format === "volc_asr" || candidate.source.format === "feishu_minutes";
    const anchorIso = absolute && candidate.source.timeAnchor ? candidate.source.timeAnchor : row.scheduled_at.toISOString();
    const anchor = Date.parse(anchorIso);
    const turns: TTranscriptTurn[] = candidate.turns.map((turn, index) => ({
      id: `turn-${String(index + 1).padStart(4, "0")}`,
      speakerId: mappingBySpeaker.get(turn.speakerName)!,
      startedAt: new Date(anchor + turn.offsetSeconds * 1000).toISOString(),
      text: turn.text,
    }));
    const transcriptInput: TWarmapTranscript = { schemaVersion: "warmap-transcript.v1", meetingId: row.id, turns };
    const validated = validateTranscript(transcriptInput, { id: row.id, participants, unmappedSpeakers });
    if (!validated.ok) {
      return { error: { status: 400, code: validated.code, message: validated.message, fieldErrors: validated.fieldErrors } };
    }
    const now = new Date().toISOString();
    const stored: TStoredTranscript = {
      ...validated.value,
      importedAt: now,
      source: { ...candidate.source, timeAnchor: anchorIso },
      ...(unmappedSpeakers.length ? { unmappedSpeakers } : {}),
    };
    const updated = await updateMeeting(
      client,
      row.id,
      "participants = $3::jsonb, transcript = $2::jsonb, transcript_candidate = NULL, outcome = $4::jsonb, status = 'held', version = version + 1, action_fingerprints = $5::jsonb",
      [
        JSON.stringify(stored),
        JSON.stringify(participants),
        JSON.stringify(pendingOutcome(new Date(now))),
        JSON.stringify(appendFingerprint(row.action_fingerprints, fingerprint)),
      ],
    );
    return commit(client, updated, secret);
  }, hostId);
  if ("error" in outcome || outcome.conflict || outcome.replayed) return outcome;
  if (background) {
    void runOutcome(pool, outcomeAgent, scope.objectId).catch((error: unknown) =>
      logEvent({ event: "meeting.outcome", objectRef: `meeting:${scope.objectId}`, status: "failed", errorCode: error instanceof Error ? error.name : "OUTCOME_FAILED" }));
  } else {
    await runOutcome(pool, outcomeAgent, scope.objectId);
  }
  return { card: projectMeetingCard((await getMeetingRow(pool.query.bind(pool), scope.objectId))!, secret) };
}

/**
 * 清除候选：scheduled only，version+1 使旧 actionId 失效；重上传允许整份替换。
 * 妙记跟着回到自动同步：会还没开完回到 none；开完不到 2 小时回到 waiting（等待起点按开完时刻算）；超过 2 小时按等太久退回手动导入。
 */
export async function executeDiscardTranscriptCandidate(
  pool: Pool,
  secret: string,
  scope: ActionScope,
  fingerprint: string,
  hostId?: string,
): Promise<MeetingActionOutcome> {
  return withMeetingLock(pool, scope.objectId, secret, fingerprint, scope.objectVersion, async (client, row) => {
    if (row.status !== "scheduled") {
      return { error: { status: 409, code: "MEETING_NOT_SCHEDULED", message: "只有 scheduled Meeting 可以清除会议记录候选" } };
    }
    if (!row.transcript_candidate) return { error: { status: 409, code: "NO_TRANSCRIPT_CANDIDATE", message: "没有待清除的会议记录候选" } };
    const updated = await updateMeeting(
      client,
      row.id,
      `transcript_candidate = NULL, version = version + 1, action_fingerprints = $2::jsonb,
       minutes_status = CASE WHEN ended_at IS NULL AND ends_at > now() THEN 'none'
         WHEN COALESCE(ended_at, ends_at) > now() - $3 * interval '1 millisecond' THEN 'waiting' ELSE 'manual' END,
       minutes_failure = NULL,
       minutes_error = CASE WHEN COALESCE(ended_at, ends_at) <= now() - $3 * interval '1 millisecond' THEN '等了 2 小时还没拿到妙记' END,
       minutes_waiting_since = CASE WHEN ended_at IS NULL AND ends_at > now() THEN minutes_waiting_since
         ELSE COALESCE(minutes_waiting_since, COALESCE(ended_at, ends_at)) END`,
      [JSON.stringify(appendFingerprint(row.action_fingerprints, fingerprint)), MINUTES_GIVE_UP_MS],
    );
    return commit(client, updated, secret);
  }, hostId);
}
