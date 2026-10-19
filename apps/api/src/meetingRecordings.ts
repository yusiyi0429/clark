/**
 * 会议录音：浏览器分片上传 → 拼接 → ffmpeg 转 mp3 → 传 TOS → 火山录音文件识别（说话人分离）→ 轮询
 * → 写成 Meeting 的会议记录候选（source.format = volc_asr），之后沿用妙记那条「说话人映射 → 确认会议记录映射」路径。
 * （流水线移植自概念版 `lib/recording/pipeline.ts`，状态落 Postgres 的 meeting_recordings。）
 *
 * - 这条线一步都不做提炼：出来的是带说话人和时间的文字，到候选为止。
 * - 写候选前按「说话人 N」做一次声纹 1:N，只预填映射建议（见 voiceprints.ts），出错不影响候选。
 * - 火山任务 id 先落库再轮询：重启后靠它接着轮询，不重新提交（重提是重新计一次费）。
 * - 进程重启时正在拼接/转码/上传的那一份标为 failed，由人决定是否重录；`recording` 不动（浏览器可能还在传分片）。
 * - 录音状态变化不 bump Meeting version；只有候选写入时 bump（与妙记导入相同）。
 */
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Pool } from "pg";
import type { TMeetingRecording, TMeetingRecordingStatus, TTranscriptSource } from "@warmap/contracts";
import type { PeopleDirectory } from "./peopleDirectory.js";
import { getMeetingRow, UUID_PATTERN } from "./meetingStore.js";
import { logEvent } from "./observability.js";
import { RecordingNotConfigured, assertRecordingConfigured, recordingConfigured } from "./recordingConfig.js";
import { transcodeToMp3 } from "./recordingMedia.js";
import { presignGet, putFile } from "./recordingTos.js";
import { recordingFileName, utterancesToTurns } from "./recordingTranscript.js";
import { buildTranscriptCandidate, saveTranscriptCandidate, type SpeakerSuggestion } from "./transcriptCandidate.js";
import { realVoiceprintDeps, suggestSpeakersByVoiceprint, type VoiceprintDeps } from "./voiceprints.js";
import { queryTask, submitTask, type QueryResult, type SubmitOptions } from "./volcAsr.js";

export const DEFAULT_RECORDING_STORAGE_DIR = "/tmp/warmap-meeting-recordings";
/** 单片上限：前端每 10 秒一片，opus 音频一片远小于此。 */
export const MAX_RECORDING_CHUNK_BYTES = 20 * 1024 * 1024;
export const RECORDING_PARSER_VERSION = "volc-asr.v1";
/** 预签名给厂商下载用，要够长到把一份大文件下完。 */
const ASR_URL_TTL_SECONDS = 24 * 3600;
const CHUNK_FILE = /^(\d+)\.part$/;

/** 外部依赖边界：测试注入假实现，生产用 realRecordingDeps。 */
export type RecordingDeps = {
  configured(): { tos: boolean; asr: boolean };
  /** 缺配时抛 RecordingNotConfigured（消息写明缺哪个变量，不含值）。 */
  assertConfigured(): void;
  transcode(inputPath: string, outputPath: string): Promise<string>;
  upload(key: string, filePath: string, contentType: string): Promise<void>;
  presign(key: string, expiresSeconds: number): string;
  submit(opts: SubmitOptions): Promise<string>;
  query(taskId: string): Promise<QueryResult>;
  pollIntervalMs: number;
  /** 一份录音最多等多久：文档说标准版 3 小时内出结果，这里 60 分钟就收，免得一下午过去才说超时。 */
  maxWaitMs: number;
  /** 声纹预填说话人（腾讯云 1:N）；不给就不做。 */
  voiceprint?: VoiceprintDeps;
};

export const realRecordingDeps: RecordingDeps = {
  configured: recordingConfigured,
  assertConfigured: assertRecordingConfigured,
  transcode: (inputPath, outputPath) => transcodeToMp3(inputPath, outputPath),
  upload: putFile,
  presign: presignGet,
  submit: submitTask,
  query: queryTask,
  pollIntervalMs: 10_000,
  maxWaitMs: 60 * 60 * 1000,
  voiceprint: realVoiceprintDeps,
};

type RecordingRow = {
  id: string;
  meeting_id: string;
  status: TMeetingRecordingStatus;
  chunk_count: number;
  raw_path: string | null;
  tos_key: string | null;
  asr_task_id: string | null;
  error: string | null;
  created_by: string;
  created_at: Date;
  updated_at: Date;
  finished_at: Date | null;
};

export type RecordingFailure = { ok: false; status: 404 | 409 | 503; code: string; message: string };
export type RecordingResult<T> = { ok: true; value: T } | RecordingFailure;

export type MeetingRecordingService = {
  /** scheduled only；已有在途录音时返回它（created=false）。 */
  start(meetingId: string, createdBy: string): Promise<RecordingResult<{ recordingId: string; created: boolean }>>;
  /** 同一 seq 重传幂等：第一次写入为准。 */
  putChunk(meetingId: string, recordingId: string, seq: number, body: Buffer): Promise<RecordingResult<TMeetingRecording>>;
  /** 结束录音并在后台跑流水线；已结束的重复调用返回当前状态。 */
  finish(meetingId: string, recordingId: string): Promise<RecordingResult<TMeetingRecording>>;
  get(meetingId: string, recordingId: string): Promise<TMeetingRecording | null>;
  /** 启动补偿：transcribing 且有任务 id 的接着轮询（不 await 轮询本身），其余卡在中间的标 failed。 */
  recoverInterrupted(): Promise<void>;
  configured(): { tos: boolean; asr: boolean };
  /** 等所有在途流水线 settle（测试用）。 */
  idle(): Promise<void>;
  /** 停止轮询；进行中的轮询停在 transcribing，下次启动由 recoverInterrupted 接上。 */
  close(): void;
};

const CANDIDATE_REJECTED: Record<string, string> = {
  TRANSCRIPT_ALREADY_IMPORTED: "识别完成，但这场会的会议记录已经确认过了，录音识别结果没有覆盖它。",
  MEETING_NOT_SCHEDULED: "识别完成，但这场会已经不是待开状态（已确认会议记录或已取消），识别结果没有写入。",
  MEETING_NOT_FOUND: "识别完成，但这场会不在了。",
};

const INTERRUPTED = {
  transcoding: "服务在转码这份录音时重启，处理中断了（录音文件仍保存在服务器上）。",
  uploading: "服务在把这份录音上传到对象存储时重启，处理中断了（录音文件仍保存在服务器上）。",
  submitting: "服务在提交语音识别时重启，处理中断了（录音文件仍保存在服务器上）。",
};

function view(row: RecordingRow): TMeetingRecording {
  return {
    id: row.id,
    status: row.status,
    chunkCount: row.chunk_count,
    error: row.error,
    createdAt: row.created_at.toISOString(),
    finishedAt: row.finished_at?.toISOString() ?? null,
  };
}

const failure = (status: RecordingFailure["status"], code: string, message: string): RecordingFailure => ({ ok: false, status, code, message });
const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

/** 喂给厂商的热词：参会人和会议标题。人名是通用模型最容易认错的东西。 */
function hotwordsOf(title: string, participantNames: string[]): string[] {
  return [...participantNames, ...title.split(/[\s·、,，]+/)].filter((word) => word.length >= 2);
}

export function createMeetingRecordingService({
  pool,
  storageDir,
  peopleDirectory,
  deps = realRecordingDeps,
}: {
  pool: Pool;
  storageDir: string;
  peopleDirectory: PeopleDirectory;
  deps?: RecordingDeps;
}): MeetingRecordingService {
  const q = pool.query.bind(pool);
  const inflight = new Set<Promise<void>>();
  const sleepers = new Set<() => void>();
  let closed = false;

  const recordingDir = (id: string) => join(storageDir, id);
  const chunksDir = (id: string) => join(recordingDir(id), "chunks");
  const rawKey = (id: string) => `${id}/recording.webm`;
  const mp3Path = (id: string) => join(recordingDir(id), "recording.mp3");

  function track(promise: Promise<void>): void {
    inflight.add(promise);
    const settle = () => inflight.delete(promise);
    promise.then(settle, settle);
  }

  /** 可被 close() 提前叫醒的等待；定时器不钉住进程。 */
  function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const wake = () => {
        clearTimeout(timer);
        sleepers.delete(wake);
        resolve();
      };
      const timer = setTimeout(wake, ms);
      timer.unref?.();
      sleepers.add(wake);
    });
  }

  async function row(id: string): Promise<RecordingRow | null> {
    const result = await q("SELECT * FROM meeting_recordings WHERE id = $1", [id]);
    return (result.rows[0] as RecordingRow | undefined) ?? null;
  }

  async function findRow(meetingId: string, recordingId: string): Promise<RecordingRow | null> {
    if (!UUID_PATTERN.test(meetingId) || !UUID_PATTERN.test(recordingId)) return null;
    const result = await q("SELECT * FROM meeting_recordings WHERE id = $1 AND meeting_id = $2", [recordingId, meetingId]);
    return (result.rows[0] as RecordingRow | undefined) ?? null;
  }

  async function update(id: string, assignments: string, params: unknown[] = []): Promise<void> {
    await q(`UPDATE meeting_recordings SET ${assignments}, updated_at = now() WHERE id = $1`, [id, ...params]);
  }

  async function markFailed(id: string, err: unknown): Promise<void> {
    const said = message(err);
    logEvent({ event: "meeting_recording.failed", objectRef: `meeting-recording:${id}`, errorCode: err instanceof Error ? err.name : "Error", reason: said });
    await q(
      "UPDATE meeting_recordings SET status = 'failed', error = $2, updated_at = now() WHERE id = $1 AND status NOT IN ('done', 'failed')",
      [id, said.slice(0, 2000)],
    ).catch(() => undefined);
  }

  /**
   * 分片按 seq **数字序**拼（`10.part` 的字符串序在 `2.part` 前面）：MediaRecorder 只有第一片带 webm 容器头，
   * 顺序错一片整个文件从那里往后都解不开。拼完删分片，免得一场会在磁盘上两份。
   */
  async function concatChunks(id: string, outPath: string): Promise<void> {
    const names = await readdir(chunksDir(id)).catch(() => [] as string[]);
    const parts = names
      .map((name) => CHUNK_FILE.exec(name))
      .filter((match): match is RegExpExecArray => match !== null)
      .map((match) => ({ name: match[0], seq: Number(match[1]) }))
      .sort((a, b) => a.seq - b.seq);
    if (!parts.length) throw new Error("这一场录音一片都没收到。");
    const out = await open(outPath, "w", 0o600);
    try {
      for (const part of parts) await out.write(await readFile(join(chunksDir(id), part.name)));
    } finally {
      await out.close();
    }
    await rm(chunksDir(id), { recursive: true, force: true });
  }

  /** 等厂商认完。每一轮先回库看一眼还是不是这一份在 transcribing（可能已被别处改掉）。 */
  async function poll(id: string, taskId: string): Promise<void> {
    const until = Date.now() + deps.maxWaitMs;
    for (;;) {
      if (closed) return;
      const current = await row(id);
      if (!current || current.status !== "transcribing" || current.asr_task_id !== taskId) return;
      const out = await deps.query(taskId);
      if (out.state === "done") {
        await complete(current, out);
        return;
      }
      if (Date.now() > until) {
        throw new Error(`等了 ${Math.round(deps.maxWaitMs / 60_000)} 分钟，火山那边还没识别完（任务 ${taskId}）。`);
      }
      await sleep(deps.pollIntervalMs);
    }
  }

  /** 厂商原文先整份落盘（映射猜错时能照原文重放，不用再花一次钱），再写候选，最后翻成 done。 */
  async function complete(current: RecordingRow, out: Extract<QueryResult, { state: "done" }>): Promise<void> {
    await writeFile(join(recordingDir(current.id), "asr-result.json"), JSON.stringify(out.raw), { mode: 0o600 });
    const turns = utterancesToTurns(out.utterances, out.speakers);
    const mp3 = mp3Path(current.id);
    const source: TTranscriptSource = {
      format: "volc_asr",
      fileName: recordingFileName(current.created_at),
      sizeBytes: (await stat(mp3)).size,
      sha256: await sha256File(mp3),
      parserVersion: RECORDING_PARSER_VERSION,
      timeAnchor: current.created_at.toISOString(),
    };
    const people = peopleDirectory.searchPeople(undefined);
    const candidate = buildTranscriptCandidate(turns, people, source, await voiceprintSuggestions(current.id, out, mp3, people));
    const saved = await saveTranscriptCandidate(pool, current.meeting_id, candidate);
    if (!("row" in saved)) throw new Error(CANDIDATE_REJECTED[saved.code] ?? `识别完成，但没能写成会议记录候选：${saved.message}`);
    await update(current.id, "status = 'done'");
  }

  /** 声纹只是预填建议：任何失败只记日志、不带建议照常写候选，不能让一份已经识别完的录音失败。 */
  async function voiceprintSuggestions(
    id: string,
    out: Extract<QueryResult, { state: "done" }>,
    mp3: string,
    people: ReturnType<PeopleDirectory["searchPeople"]>,
  ): Promise<Map<string, SpeakerSuggestion> | undefined> {
    if (!deps.voiceprint) return undefined;
    try {
      return await suggestSpeakersByVoiceprint({
        q,
        deps: deps.voiceprint,
        mp3Path: mp3,
        workDir: recordingDir(id),
        utterances: out.utterances,
        speakers: out.speakers,
        people,
        objectRef: `meeting-recording:${id}`,
      });
    } catch (err) {
      logEvent({ event: "voiceprint.match_failed", objectRef: `meeting-recording:${id}`, errorCode: err instanceof Error ? err.name : "Error", reason: message(err) });
      return undefined;
    }
  }

  async function runPipeline(id: string): Promise<void> {
    const started = await row(id);
    if (!started || started.status !== "transcoding") return;
    try {
      const meeting = await getMeetingRow(q, started.meeting_id);
      if (!meeting) throw new Error("这场会不在了。");
      // 拼接 + 规整
      const rawPath = join(storageDir, rawKey(id));
      await concatChunks(id, rawPath);
      await update(id, "raw_path = $2", [rawKey(id)]);
      const mp3 = await deps.transcode(rawPath, mp3Path(id));
      // 传上去：火山那个接口只接 URL
      await update(id, "status = 'uploading'");
      const key = `meeting-recordings/${meeting.id}/${id}.mp3`;
      await deps.upload(key, mp3, "audio/mpeg");
      const url = deps.presign(key, ASR_URL_TTL_SECONDS);
      // 交给厂商；任务 id 先落库再轮询
      await update(id, "status = 'transcribing', tos_key = $2", [key]);
      const taskId = await deps.submit({ url, hotwords: hotwordsOf(meeting.title, meeting.participants.map((p) => p.displayName)) });
      await update(id, "asr_task_id = $2", [taskId]);
      await poll(id, taskId);
    } catch (err) {
      await markFailed(id, err);
    }
  }

  return {
    async start(meetingId, createdBy) {
      const meeting = await getMeetingRow(q, meetingId);
      if (!meeting) return failure(404, "MEETING_NOT_FOUND", "Meeting 不存在");
      if (meeting.status !== "scheduled") return failure(409, "MEETING_NOT_SCHEDULED", "只有 scheduled Meeting 可以录音");
      for (;;) {
        const inserted = await q(
          `INSERT INTO meeting_recordings (id, meeting_id, status, created_by) VALUES ($1, $2, 'recording', $3)
           ON CONFLICT (meeting_id) WHERE status IN ('recording', 'uploading', 'transcoding', 'transcribing') DO NOTHING
           RETURNING id`,
          [randomUUID(), meetingId, createdBy],
        );
        if (inserted.rowCount === 1) return { ok: true, value: { recordingId: String(inserted.rows[0].id), created: true } };
        const active = await q(
          "SELECT id FROM meeting_recordings WHERE meeting_id = $1 AND status IN ('recording', 'uploading', 'transcoding', 'transcribing')",
          [meetingId],
        );
        // 冲突后那一份恰好走完时再插一次
        if (active.rowCount === 1) return { ok: true, value: { recordingId: String(active.rows[0].id), created: false } };
      }
    },

    async putChunk(meetingId, recordingId, seq, body) {
      const current = await findRow(meetingId, recordingId);
      if (!current) return failure(404, "RECORDING_NOT_FOUND", "录音不存在");
      if (current.status !== "recording") return failure(409, "RECORDING_NOT_ACTIVE", "这份录音已经结束，不能再追加分片");
      const dir = chunksDir(recordingId);
      await mkdir(dir, { recursive: true, mode: 0o700 });
      const target = join(dir, `${seq}.part`);
      const exists = await access(target).then(() => true, () => false);
      if (!exists) {
        // 同目录先写临时文件再 rename：不会留下半片，也不跨文件系统（没有 EXDEV）
        const tmp = `${target}.${randomUUID()}.tmp`;
        await writeFile(tmp, body, { mode: 0o600 });
        await rename(tmp, target);
      }
      const count = (await readdir(dir)).filter((name) => CHUNK_FILE.test(name)).length;
      const updated = await q("UPDATE meeting_recordings SET chunk_count = $2, updated_at = now() WHERE id = $1 RETURNING *", [recordingId, count]);
      return { ok: true, value: view(updated.rows[0] as RecordingRow) };
    },

    async finish(meetingId, recordingId) {
      const current = await findRow(meetingId, recordingId);
      if (!current) return failure(404, "RECORDING_NOT_FOUND", "录音不存在");
      if (current.status !== "recording") return { ok: true, value: view(current) };
      try {
        deps.assertConfigured();
      } catch (err) {
        // 缺配时录音保持 recording、分片都留着：配好后再结束一次即可
        if (err instanceof RecordingNotConfigured) return failure(503, "RECORDING_NOT_CONFIGURED", err.message);
        throw err;
      }
      const moved = await q(
        "UPDATE meeting_recordings SET status = 'transcoding', finished_at = now(), updated_at = now() WHERE id = $1 AND status = 'recording' RETURNING *",
        [recordingId],
      );
      if (moved.rowCount !== 1) return { ok: true, value: view((await row(recordingId))!) };
      track(runPipeline(recordingId));
      return { ok: true, value: view(moved.rows[0] as RecordingRow) };
    },

    async get(meetingId, recordingId) {
      const current = await findRow(meetingId, recordingId);
      return current ? view(current) : null;
    },

    async recoverInterrupted() {
      await q(
        `UPDATE meeting_recordings
            SET status = 'failed',
                error = CASE status WHEN 'transcoding' THEN $1 WHEN 'uploading' THEN $2 ELSE $3 END,
                updated_at = now()
          WHERE status IN ('transcoding', 'uploading') OR (status = 'transcribing' AND asr_task_id IS NULL)`,
        [INTERRUPTED.transcoding, INTERRUPTED.uploading, INTERRUPTED.submitting],
      );
      const resumable = await q("SELECT id, asr_task_id FROM meeting_recordings WHERE status = 'transcribing' AND asr_task_id IS NOT NULL");
      for (const { id, asr_task_id: taskId } of resumable.rows as { id: string; asr_task_id: string }[]) {
        track(poll(id, taskId).catch((err) => markFailed(id, err)));
      }
    },

    configured: () => deps.configured(),

    async idle() {
      while (inflight.size > 0) await Promise.allSettled([...inflight]);
    },

    close() {
      closed = true;
      for (const wake of [...sleepers]) wake();
    },
  };
}
