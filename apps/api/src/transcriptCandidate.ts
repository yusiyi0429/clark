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
  TWarmapTranscript,
} from "@warmap/contracts";
import type { ActionScope } from "./actionToken.js";
import type { CompanyMemoryRepository } from "./companyMemory.js";
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
import {
  MIAOJI_MARKDOWN_FORMAT,
  parseMiaojiMarkdown,
  TRANSCRIPT_PARSER_VERSION,
  type ParsedTranscriptTurn,
} from "./transcriptMarkdown.js";

export type TranscriptCandidateResult =
  | { status: 200; card: TCard }
  | { status: 400 | 404 | 409; code: string; message: string; fieldErrors?: Record<string, string> };

function projectPerson(person: TPersonResult): TMeetingParticipant {
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

/** 上传 Markdown 只生成候选并 bump version：不改 status、不跑 Outcome。 */
export async function createTranscriptCandidate(
  pool: Pool,
  companyMemory: CompanyMemoryRepository,
  secret: string,
  meetingId: string,
  file: { fileName: string; buffer: Buffer },
  hostId?: string,
): Promise<TranscriptCandidateResult> {
  const meeting = await getMeetingRow(pool.query.bind(pool), meetingId);
  if (!meeting || (hostId !== undefined && meeting.lead_dri_id !== hostId)) return { status: 404, code: "MEETING_NOT_FOUND", message: "Meeting 不存在" };
  const parsed = parseMiaojiMarkdown(file.buffer);
  if (!parsed.ok) {
    const message = parsed.error.line ? `${parsed.error.message}（第 ${parsed.error.line} 行）` : parsed.error.message;
    return { status: 400, code: parsed.error.code, message };
  }
  const source: TTranscriptSource = {
    format: MIAOJI_MARKDOWN_FORMAT,
    fileName: file.fileName,
    sizeBytes: file.buffer.length,
    sha256: createHash("sha256").update(file.buffer).digest("hex"),
    parserVersion: TRANSCRIPT_PARSER_VERSION,
    timeAnchor: meeting.scheduled_at.toISOString(),
  };
  const candidate = buildTranscriptCandidate(parsed.transcript.turns, companyMemory.searchPeople(undefined), source);
  const saved = await saveTranscriptCandidate(pool, meetingId, candidate, hostId);
  return "row" in saved ? { status: 200, card: projectMeetingCard(saved.row, secret) } : saved;
}

/**
 * 候选落库（妙记 Markdown 与会议录音识别共用）：行锁内确认没有已确认 Transcript、仍是 scheduled，
 * 整份替换候选并 bump version；不改 status、不跑 Outcome。
 */
export async function saveTranscriptCandidate(
  pool: Pool,
  meetingId: string,
  candidate: TStoredTranscriptCandidate,
  hostId?: string,
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
 */
export async function executeConfirmTranscriptCandidate(
  pool: Pool,
  companyMemory: CompanyMemoryRepository,
  outcomeAgent: PostMeetingAgent,
  secret: string,
  scope: ActionScope,
  input: { speakerMappings: { speakerName: string; personId: string }[]; confirmAddParticipants: true },
  fingerprint: string,
  hostId?: string,
): Promise<MeetingActionOutcome> {
  const personById = new Map(companyMemory.searchPeople(undefined).map((person) => [person.personId, person]));
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
      if (usedPersonIds.has(mapping.personId)) return invalid(`同一人不能映射多个说话人：${mapping.personId}`);
      mappingBySpeaker.set(mapping.speakerName, mapping.personId);
      usedPersonIds.add(mapping.personId);
    }
    const missing = [...known].filter((speakerName) => !mappingBySpeaker.has(speakerName));
    if (missing.length > 0) {
      return { error: { status: 400, code: "INCOMPLETE_SPEAKER_MAPPING", message: `缺少说话人映射：${missing.join("、")}`, fieldErrors: { speakerMappings: "missing mapping" } } };
    }

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
    const validated = validateTranscript(transcriptInput, { id: row.id, participants });
    if (!validated.ok) {
      return { error: { status: 400, code: validated.code, message: validated.message, fieldErrors: validated.fieldErrors } };
    }
    const now = new Date().toISOString();
    const stored: TStoredTranscript = {
      ...validated.value,
      importedAt: now,
      source: { ...candidate.source, timeAnchor: anchorIso },
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
  await runOutcome(pool, outcomeAgent, scope.objectId);
  return { card: projectMeetingCard((await getMeetingRow(pool.query.bind(pool), scope.objectId))!, secret) };
}

/** 清除候选：scheduled only，version+1 使旧 actionId 失效；重上传允许整份替换。 */
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
      "transcript_candidate = NULL, version = version + 1, action_fingerprints = $2::jsonb",
      [JSON.stringify(appendFingerprint(row.action_fingerprints, fingerprint))],
    );
    return commit(client, updated, secret);
  }, hostId);
}
