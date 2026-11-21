/**
 * 会议录音路由与流水线（外部服务全用假实现，不走网络、不调 ffmpeg）：
 * 开始 → 分片 → 结束 → 后台拼接/转码/上传/识别 → 会议记录候选（volc_asr），再走既有的「确认会议记录映射」。
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Value } from "@sinclair/typebox/value";
import { MeetingCardPayload, MeetingRecording } from "@warmap/contracts";
import { createTestApp, preflightCandidate, type TestApp } from "./helpers.js";
import type { PreflightAgent, PreflightAgentInput } from "../src/meetingPreflight.js";
import type { PostMeetingAgent } from "../src/outcome.js";
import type { RecordingDeps } from "../src/meetingRecordings.js";
import { assertRecordingConfigured } from "../src/recordingConfig.js";
import { AsrRejected, mapResult, type QueryResult, type SubmitOptions } from "../src/volcAsr.js";
import type { VoiceprintDeps } from "../src/voiceprints.js";
import type { PcmSegment } from "../src/recordingMedia.js";

const preflightAgent: PreflightAgent = {
  async generate(input: PreflightAgentInput) {
    return { candidate: preflightCandidate(input.issues.map((issue) => `issue:${issue.id}`)) };
  },
};

const outcomeAgent: PostMeetingAgent = {
  async generate() {
    return { candidate: { summary: "会议确认了渠道方向", items: [] }, runId: "outcome-run-recording" };
  },
};

/** 厂商返回的原样形状：说话人从 0 起编号。 */
const VENDOR_RAW = {
  audio_info: { duration: 36000 },
  result: {
    text: "…",
    utterances: [
      { text: "我确认这个方向。", start_time: 5400, end_time: 7000, additions: { speaker: "0" } },
      { text: "先做渠道。", start_time: 7200, end_time: 8000, additions: { speaker: "0" } },
      { text: "我周五前给排期。", start_time: 20900, end_time: 23000, additions: { speaker: "1" } },
    ],
  },
};
const DONE: QueryResult = { state: "done", ...mapResult(VENDOR_RAW), raw: VENDOR_RAW };

function fakeDeps(over: Partial<RecordingDeps> = {}) {
  const log = {
    transcodedInput: [] as string[],
    uploads: [] as { key: string; filePath: string; contentType: string }[],
    submits: [] as SubmitOptions[],
    queries: [] as string[],
  };
  const deps: RecordingDeps = {
    configured: () => ({ tos: true, asr: true }),
    assertConfigured: () => undefined,
    async transcode(inputPath, outputPath) {
      log.transcodedInput.push((await readFile(inputPath)).toString("utf8"));
      await writeFile(outputPath, "fake mp3");
      return outputPath;
    },
    async upload(key, filePath, contentType) {
      log.uploads.push({ key, filePath, contentType });
    },
    presign: (key) => `https://tos.example/${key}?X-Tos-Signature=fake`,
    async submit(opts) {
      log.submits.push(opts);
      return "task-fake-1";
    },
    async query(taskId) {
      log.queries.push(taskId);
      // 第一次还在跑，第二次出结果：走一遍轮询
      return log.queries.length < 2 ? { state: "running" } : DONE;
    },
    pollIntervalMs: 1,
    maxWaitMs: 60_000,
    ...over,
  };
  return { deps, log };
}

let storageDir: string;

beforeEach(async () => {
  storageDir = await mkdtemp(join(tmpdir(), "warmap-recordings-test-"));
});

afterEach(async () => {
  await rm(storageDir, { recursive: true, force: true });
});

async function newApp(deps: RecordingDeps): Promise<TestApp> {
  return createTestApp({ recordingStorageDir: storageDir }, undefined, { preflightAgent, outcomeAgent, recordingDeps: deps });
}

async function scheduledMeeting(t: TestApp, externalId: string): Promise<{ cookie: string; meetingId: string }> {
  const issue = await t.app.inject({
    method: "POST",
    url: "/api/dri/issues",
    headers: { authorization: `Bearer ${t.env.driServiceToken}` },
    payload: {
      externalId: `dri-recording-${externalId}`,
      submitterPersonId: "person-fixture-002",
      title: `是否在六月前调整渠道投入（${externalId}）`,
      whyNow: "渠道窗口在六月关闭",
      sourceRef: `dri://planning/${externalId}`,
      location: { level: "battlefield", battlefieldId: "growth" },
    },
  });
  expect(issue.statusCode).toBe(201);
  const issueId = issue.json().cards[0].objectRef.id as string;
  const cookie = await t.loginCookie();
  const card = await t.app.inject({ method: "GET", url: `/api/cards/issues/${issueId}`, headers: { cookie } });
  const descriptor = card.json().cards[0].actions.find((a: { actionType: string }) => a.actionType === "issue.create_meeting");
  const meeting = await t.app.inject({
    method: "POST",
    url: "/api/actions/execute",
    headers: { cookie, origin: t.publicOrigin },
    payload: {
      actionId: descriptor.actionId,
      input: { title: "渠道投入决策会", scheduledAt: "2026-06-01T10:00:00.000+08:00", leadDriId: "person-fixture-002", ceoParticipantId: "person-fixture-001", participants: ["person-fixture-002"], issueIds: [issueId] },
    },
  });
  expect(meeting.statusCode).toBe(200);
  return { cookie, meetingId: meeting.json().cards[0].objectRef.id as string };
}

const start = (t: TestApp, cookie: string, meetingId: string) =>
  t.app.inject({ method: "POST", url: `/api/meetings/${meetingId}/recordings`, headers: { cookie, origin: t.publicOrigin } });
const chunk = (t: TestApp, cookie: string, meetingId: string, recordingId: string, seq: number | string, body: string | Buffer, contentType = "audio/webm") =>
  t.app.inject({
    method: "PUT",
    url: `/api/meetings/${meetingId}/recordings/${recordingId}/chunks/${seq}`,
    headers: { cookie, origin: t.publicOrigin, "content-type": contentType },
    payload: typeof body === "string" ? Buffer.from(body) : body,
  });
const finish = (t: TestApp, cookie: string, meetingId: string, recordingId: string) =>
  t.app.inject({ method: "POST", url: `/api/meetings/${meetingId}/recordings/${recordingId}/finish`, headers: { cookie, origin: t.publicOrigin } });
const getRecording = async (t: TestApp, cookie: string, meetingId: string, recordingId: string) =>
  (await t.app.inject({ method: "GET", url: `/api/meetings/${meetingId}/recordings/${recordingId}`, headers: { cookie } })).json();
const meetingCard = async (t: TestApp, cookie: string, meetingId: string) =>
  (await t.app.inject({ method: "GET", url: `/api/cards/meetings/${meetingId}`, headers: { cookie } })).json().cards[0];

describe("会议录音 → 会议记录候选", () => {
  it("starts, takes chunks idempotently in seq order, finishes into a volc_asr candidate that the existing mapping Action confirms", async () => {
    const { deps, log } = fakeDeps();
    const t = await newApp(deps);
    try {
      const { cookie, meetingId } = await scheduledMeeting(t, "happy");
      const versionBefore = (await meetingCard(t, cookie, meetingId)).version as number;

      const started = await start(t, cookie, meetingId);
      expect(started.statusCode).toBe(201);
      const { recordingId } = started.json() as { recordingId: string };
      // 一场会只有一份在途录音：再开始返回同一份
      const again = await start(t, cookie, meetingId);
      expect(again.statusCode).toBe(200);
      expect(again.json()).toEqual({ recordingId });
      const recordingCard = await meetingCard(t, cookie, meetingId);
      expect(recordingCard.payload.recording).toEqual({ id: recordingId, status: "recording", error: null });
      // 录音状态不 bump Meeting version（进行中的 Action 不失效）
      expect(recordingCard.version).toBe(versionBefore);

      // 乱序到达、带 codecs 参数、octet-stream、重传同一 seq
      expect((await chunk(t, cookie, meetingId, recordingId, 2, "C")).statusCode).toBe(200);
      expect((await chunk(t, cookie, meetingId, recordingId, 0, "A", "audio/webm;codecs=opus")).statusCode).toBe(200);
      expect((await chunk(t, cookie, meetingId, recordingId, 10, "D", "application/octet-stream")).statusCode).toBe(200);
      const fourth = await chunk(t, cookie, meetingId, recordingId, 1, "B");
      expect(fourth.json()).toMatchObject({ id: recordingId, status: "recording", chunkCount: 4, error: null, finishedAt: null });
      expect(Value.Check(MeetingRecording, fourth.json())).toBe(true);
      const duplicate = await chunk(t, cookie, meetingId, recordingId, 0, "X");
      expect(duplicate.statusCode).toBe(200);
      expect(duplicate.json().chunkCount).toBe(4);

      const finished = await finish(t, cookie, meetingId, recordingId);
      expect(finished.statusCode).toBe(202);
      expect(finished.json()).toMatchObject({ id: recordingId, status: "transcoding", chunkCount: 4 });
      expect(finished.json().finishedAt).toEqual(expect.any(String));
      await t.recordings!.idle();

      const done = await getRecording(t, cookie, meetingId, recordingId);
      expect(done).toMatchObject({ id: recordingId, status: "done", error: null });
      // 按 seq 数字序拼（10 在 2 之后），重传不覆盖第一次
      expect(log.transcodedInput).toEqual(["ABCD"]);
      expect(log.uploads).toEqual([{ key: `meeting-recordings/${meetingId}/${recordingId}.mp3`, filePath: join(storageDir, recordingId, "recording.mp3"), contentType: "audio/mpeg" }]);
      expect(log.submits[0].url).toBe(`https://tos.example/meeting-recordings/${meetingId}/${recordingId}.mp3?X-Tos-Signature=fake`);
      expect(log.submits[0].hotwords).toEqual(expect.arrayContaining(["测试乙", "渠道投入决策会"]));
      expect(log.queries).toEqual(["task-fake-1", "task-fake-1"]);
      // 分片拼完即删；厂商原文整份留存
      expect(existsSync(join(storageDir, recordingId, "chunks"))).toBe(false);
      expect(JSON.parse(await readFile(join(storageDir, recordingId, "asr-result.json"), "utf8"))).toEqual(VENDOR_RAW);
      const row = (await t.sql("SELECT raw_path, tos_key, asr_task_id FROM meeting_recordings WHERE id = $1", [recordingId]))[0];
      expect(row).toEqual({ raw_path: `${recordingId}/recording.webm`, tos_key: `meeting-recordings/${meetingId}/${recordingId}.mp3`, asr_task_id: "task-fake-1" });

      const card = await meetingCard(t, cookie, meetingId);
      expect(Value.Check(MeetingCardPayload, card.payload)).toBe(true);
      expect(card.payload.status).toBe("scheduled");
      expect(card.payload.recording).toEqual({ id: recordingId, status: "done", error: null });
      expect(card.payload.transcriptCandidate).toMatchObject({
        turnCount: 2,
        speakerCount: 2,
        firstOffsetSeconds: 5,
        lastOffsetSeconds: 20,
        source: {
          format: "volc_asr",
          parserVersion: "volc-asr.v1",
          sizeBytes: 8,
          sha256: createHash("sha256").update("fake mp3").digest("hex"),
          timeAnchor: done.createdAt,
          url: `${t.publicOrigin}/meetings/${meetingId}#transcript`,
          contentHash: expect.stringMatching(/^[0-9a-f]{64}$/),
        },
      });
      expect(card.payload.transcriptCandidate.source.fileName).toMatch(/^会议录音 \d{1,2}月\d{1,2}日 \d{2}:\d{2}\.mp3$/);
      expect(card.payload.transcriptCandidate.speakers.map((s: { speakerName: string }) => s.speakerName)).toEqual(["说话人 1", "说话人 2"]);
      expect(card.payload.transcriptCandidate.sampleTurns[0]).toEqual({ speakerName: "说话人 1", offsetSeconds: 5, text: "我确认这个方向。先做渠道。" });

      // 录音已结束：再传分片 409，再结束返回当前状态
      expect((await chunk(t, cookie, meetingId, recordingId, 11, "E")).json().code).toBe("RECORDING_NOT_ACTIVE");
      expect((await finish(t, cookie, meetingId, recordingId)).json()).toMatchObject({ status: "done" });

      // 既有的说话人映射 Action 收尾：turn 时间 = 录音开始 + offset
      const confirm = (card.actions as { actionType: string; actionId: string }[]).find((a) => a.actionType === "meeting.confirm_transcript_candidate");
      const confirmed = await t.app.inject({
        method: "POST",
        url: "/api/actions/execute",
        headers: { cookie, origin: t.publicOrigin },
        payload: {
          actionId: confirm!.actionId,
          input: { speakerMappings: [{ speakerName: "说话人 1", personId: "person-fixture-001" }, { speakerName: "说话人 2", personId: "person-fixture-002" }], confirmAddParticipants: true },
        },
      });
      expect(confirmed.statusCode).toBe(200);
      const transcript = confirmed.json().cards[0].payload.transcript;
      expect(transcript.source).toMatchObject({ format: "volc_asr", timeAnchor: done.createdAt });
      expect(transcript.turns.map((turn: { speakerId: string; startedAt: string }) => [turn.speakerId, turn.startedAt])).toEqual([
        ["person-fixture-001", new Date(Date.parse(done.createdAt) + 5_000).toISOString()],
        ["person-fixture-002", new Date(Date.parse(done.createdAt) + 20_000).toISOString()],
      ]);

      const health = await t.app.inject({ method: "GET", url: "/healthz" });
      expect(health.json().dependencies.recording).toEqual({ tos: true, asr: true });
    } finally {
      await t.close();
    }
  });

  it("marks the recording failed with the vendor's reason and allows a new recording afterwards", async () => {
    const { deps } = fakeDeps({
      async query() {
        throw new AsrRejected("这份录音里没有检测到人声。可能是麦克风没收上声音，或者传错了文件。", "20000003");
      },
    });
    const t = await newApp(deps);
    try {
      const { cookie, meetingId } = await scheduledMeeting(t, "failed");
      const { recordingId } = (await start(t, cookie, meetingId)).json();
      await chunk(t, cookie, meetingId, recordingId, 0, "A");
      expect((await finish(t, cookie, meetingId, recordingId)).statusCode).toBe(202);
      await t.recordings!.idle();

      expect(await getRecording(t, cookie, meetingId, recordingId)).toMatchObject({ status: "failed", error: expect.stringContaining("没有检测到人声") });
      const card = await meetingCard(t, cookie, meetingId);
      expect(card.payload.recording).toMatchObject({ id: recordingId, status: "failed", error: expect.stringContaining("没有检测到人声") });
      expect(card.payload.transcriptCandidate).toBeNull();

      const next = await start(t, cookie, meetingId);
      expect(next.statusCode).toBe(201);
      expect(next.json().recordingId).not.toBe(recordingId);
    } finally {
      await t.close();
    }
  });

  it("fails finish with a clear not-configured error naming the missing variables and keeps the recording open", async () => {
    const keys = ["TOS_ACCESS_KEY", "TOS_SECRET_KEY", "TOS_ENDPOINT", "TOS_REGION", "TOS_BUCKET", "VOLC_ASR_API_KEY", "VOLC_ASR_APP_KEY", "VOLC_ASR_ACCESS_KEY"];
    const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
    for (const key of keys) delete process.env[key];
    const { deps, log } = fakeDeps({ assertConfigured: assertRecordingConfigured });
    const t = await newApp(deps);
    try {
      const { cookie, meetingId } = await scheduledMeeting(t, "not-configured");
      const { recordingId } = (await start(t, cookie, meetingId)).json();
      await chunk(t, cookie, meetingId, recordingId, 0, "A");
      const res = await finish(t, cookie, meetingId, recordingId);
      expect(res.statusCode).toBe(503);
      expect(res.json()).toMatchObject({ code: "RECORDING_NOT_CONFIGURED", message: expect.stringContaining("TOS_BUCKET") });
      await t.recordings!.idle();
      expect(await getRecording(t, cookie, meetingId, recordingId)).toMatchObject({ status: "recording", chunkCount: 1, finishedAt: null });
      expect(log.transcodedInput).toEqual([]);
    } finally {
      await t.close();
      for (const key of keys) if (saved[key] !== undefined) process.env[key] = saved[key];
    }
  });

  it("does not write the candidate when the meeting is no longer scheduled by the time recognition finishes", async () => {
    let t: TestApp;
    let meetingId = "";
    const { deps } = fakeDeps({
      async query() {
        await t.sql("UPDATE meetings SET status = 'cancelled' WHERE id = $1", [meetingId]);
        return DONE;
      },
    });
    t = await newApp(deps);
    try {
      const created = await scheduledMeeting(t, "cancelled");
      meetingId = created.meetingId;
      const { recordingId } = (await start(t, created.cookie, meetingId)).json();
      await chunk(t, created.cookie, meetingId, recordingId, 0, "A");
      await finish(t, created.cookie, meetingId, recordingId);
      await t.recordings!.idle();
      expect(await getRecording(t, created.cookie, meetingId, recordingId)).toMatchObject({ status: "failed", error: expect.stringContaining("不是待开状态") });
      expect((await t.sql("SELECT transcript_candidate FROM meetings WHERE id = $1", [meetingId]))[0].transcript_candidate).toBeNull();
    } finally {
      await t.close();
    }
  });

  it("保留先确认的飞书版本，并把稍后完成的本机转写交给同场伙伴", async () => {
    let t: TestApp;
    let meetingId = "";
    const original = { source:{format:"feishu_minutes", contentHash:"first-version"}, turns:[] };
    const { deps } = fakeDeps({ async query() {
      await t.sql(`UPDATE meetings SET transcript=$2::jsonb, status='held', minute_token='confirmed', minute_binding='source_id'
        WHERE id=$1`, [meetingId, JSON.stringify(original)]);
      return DONE;
    }});
    t = await newApp(deps);
    try {
      const created = await scheduledMeeting(t,"late-local");
      meetingId = created.meetingId;
      const { recordingId } = (await start(t,created.cookie,meetingId)).json();
      await chunk(t,created.cookie,meetingId,recordingId,0,"A");
      await finish(t,created.cookie,meetingId,recordingId);
      await t.recordings!.idle();
      const [meeting] = await t.sql("SELECT transcript,transcript_candidate FROM meetings WHERE id=$1",[meetingId]);
      expect(meeting).toEqual({transcript:original,transcript_candidate:null});
      const [recording] = await t.sql("SELECT status,transcript_candidate FROM meeting_recordings WHERE id=$1",[recordingId]);
      expect(recording).toMatchObject({status:"done",transcript_candidate:{source:{format:"volc_asr"}}});
      const read = await t.app.inject({ method:"GET",url:`/api/me/partner-meetings/${meetingId}/record?recordingId=${recordingId}`,
        headers:{cookie:await t.memberCookie()} });
      expect(read.statusCode).toBe(200);
      expect(read.json().text).toContain("我周五前给排期。");
    } finally {
      await t.close();
    }
  });

  it("recovers on restart: resumes polling transcribing recordings, fails ones stuck mid-pipeline, leaves live recordings alone", async () => {
    const { deps, log } = fakeDeps({ query: async (taskId) => (log.queries.push(taskId), DONE) });
    const t = await newApp(deps);
    try {
      const a = await scheduledMeeting(t, "resume");
      const b = await scheduledMeeting(t, "stuck");
      const c = await scheduledMeeting(t, "live");
      const ra = (await start(t, a.cookie, a.meetingId)).json().recordingId as string;
      const rb = (await start(t, b.cookie, b.meetingId)).json().recordingId as string;
      const rc = (await start(t, c.cookie, c.meetingId)).json().recordingId as string;
      // 模拟崩溃前的状态：a 已提交识别，b 正在上传
      await mkdir(join(storageDir, ra), { recursive: true });
      await writeFile(join(storageDir, ra, "recording.mp3"), "fake mp3");
      await t.sql("UPDATE meeting_recordings SET status = 'transcribing', asr_task_id = 'task-before-restart', finished_at = now() WHERE id = $1", [ra]);
      await t.sql("UPDATE meeting_recordings SET status = 'uploading', finished_at = now() WHERE id = $1", [rb]);

      await t.recordings!.recoverInterrupted();
      await t.recordings!.idle();

      expect(log.queries).toEqual(["task-before-restart"]);
      expect(log.submits).toEqual([]);
      expect(await getRecording(t, a.cookie, a.meetingId, ra)).toMatchObject({ status: "done" });
      expect((await meetingCard(t, a.cookie, a.meetingId)).payload.transcriptCandidate.source.format).toBe("volc_asr");
      expect(await getRecording(t, b.cookie, b.meetingId, rb)).toMatchObject({ status: "failed", error: expect.stringContaining("上传到对象存储时重启") });
      expect(await getRecording(t, c.cookie, c.meetingId, rc)).toMatchObject({ status: "recording" });
    } finally {
      await t.close();
    }
  });

  it("主持人能开始、上传、结束和读取本场录音", async () => {
    const { deps } = fakeDeps();
    const t = await newApp(deps);
    try {
      const { meetingId } = await scheduledMeeting(t, "host");
      const host = await t.memberCookie();
      const started = await start(t, host, meetingId);
      expect(started.statusCode).toBe(201);
      const { recordingId } = started.json() as { recordingId: string };
      expect((await chunk(t, host, meetingId, recordingId, 0, "host audio")).statusCode).toBe(200);
      expect((await finish(t, host, meetingId, recordingId)).statusCode).toBe(202);
      expect((await t.app.inject({ method: "GET", url: `/api/meetings/${meetingId}/recordings/${recordingId}`, headers: { cookie: host } })).statusCode).toBe(200);
      await t.recordings!.idle();
    } finally { await t.close(); }
  });

  it("guards the boundary: non-host member, 20 MiB per chunk, unknown recording 404", async () => {
    const { deps } = fakeDeps();
    const t = await newApp(deps);
    try {
      const { cookie, meetingId } = await scheduledMeeting(t, "guards");
      const member = await t.memberCookie();
      await t.sql("UPDATE meetings SET lead_dri_id=$2 WHERE id=$1", [meetingId, "another-host"]);
      expect((await start(t, member, meetingId)).statusCode).toBe(404);
      const { recordingId } = (await start(t, cookie, meetingId)).json();
      expect((await chunk(t, member, meetingId, recordingId, 0, "A")).statusCode).toBe(404);
      expect((await finish(t, member, meetingId, recordingId)).statusCode).toBe(404);
      expect((await t.app.inject({ method: "GET", url: `/api/meetings/${meetingId}/recordings/${recordingId}`, headers: { cookie: member } })).statusCode).toBe(404);
      const tooBig = await chunk(t, cookie, meetingId, recordingId, 0, Buffer.alloc(20 * 1024 * 1024 + 1));
      expect(tooBig.statusCode).toBe(413);
      expect((await chunk(t, cookie, meetingId, recordingId, -1, "A")).statusCode).toBe(400);
      expect((await chunk(t, cookie, meetingId, "00000000-0000-4000-8000-000000000000", 0, "A")).statusCode).toBe(404);
      expect((await t.app.inject({ method: "GET", url: `/api/meetings/${meetingId}/recordings/not-a-uuid`, headers: { cookie } })).statusCode).toBe(404);
      expect((await start(t, cookie, "00000000-0000-4000-8000-000000000000")).statusCode).toBe(404);
    } finally {
      await t.close();
    }
  });
});

/**
 * 声纹预填：识别完成后按「说话人 N」截音频做 1:N，只把分数够高、且在人员目录里的人预填成建议。
 * 4 个说话人：1 号 8 秒、2 号 20 秒（截 15 秒）、3 号 1 秒（太短不比）、4 号 5 秒。
 */
const VOICE_RAW = {
  result: {
    utterances: [
      { text: "我先说一下背景。", start_time: 0, end_time: 4000, additions: { speaker: "0" } },
      { text: "渠道这个季度要调整。", start_time: 5000, end_time: 9000, additions: { speaker: "0" } },
      { text: "我这边的排期是这样安排的。", start_time: 10000, end_time: 30000, additions: { speaker: "1" } },
      { text: "好。", start_time: 31000, end_time: 32000, additions: { speaker: "2" } },
      { text: "我补充一点数据。", start_time: 33000, end_time: 38000, additions: { speaker: "3" } },
    ],
  },
};
const VOICE_DONE: QueryResult = { state: "done", ...mapResult(VOICE_RAW), raw: VOICE_RAW };

/** 假 ffmpeg 把截取的时间段写进「PCM」，假 1:N 按第一段的开始时刻决定打分。 */
function fakeVoiceprint(scoreByStart: Record<number, { voicePrintId: string; score: number } | Error>) {
  const log = { clips: [] as { segments: PcmSegment[]; maxSeconds: number; outputPath: string }[], verifies: 0 };
  const deps: VoiceprintDeps = {
    configured: () => true,
    requireConfig: () => ({ groupId: "tianshu" }),
    async toPcm(_inputPath, outputPath, opts) {
      log.clips.push({ segments: opts.segments!, maxSeconds: opts.maxSeconds, outputPath });
      await writeFile(outputPath, JSON.stringify(opts.segments));
    },
    async groupVerify({ pcm, groupId, topN }) {
      log.verifies++;
      expect({ groupId, topN }).toEqual({ groupId: "tianshu", topN: 1 });
      const hit = scoreByStart[(JSON.parse(pcm.toString("utf8")) as PcmSegment[])[0].startMs];
      if (hit instanceof Error) throw hit;
      return hit ? [hit] : [];
    },
    enroll: async () => "unused",
    update: async () => undefined,
    remove: async () => undefined,
  };
  return { deps, log };
}

async function recordWithVoiceprint(voiceprint: VoiceprintDeps, externalId: string) {
  const { deps } = fakeDeps({ query: async () => VOICE_DONE, voiceprint });
  const t = await newApp(deps);
  await t.sql(
    `INSERT INTO person_voiceprints (person_id, provider_voiceprint_id, group_id, consented_at)
     VALUES ('person-fixture-001', 'vp-ceo', 'tianshu', now()), ('person-fixture-002', 'vp-member', 'tianshu', now()), ('person-gone', 'vp-gone', 'tianshu', now())`,
  );
  const { cookie, meetingId } = await scheduledMeeting(t, externalId);
  const { recordingId } = (await start(t, cookie, meetingId)).json();
  await chunk(t, cookie, meetingId, recordingId, 0, "A");
  await finish(t, cookie, meetingId, recordingId);
  await t.recordings!.idle();
  const recording = await getRecording(t, cookie, meetingId, recordingId);
  const candidate = (await meetingCard(t, cookie, meetingId)).payload.transcriptCandidate;
  const suggested = Object.fromEntries(
    (candidate?.speakers ?? []).map((s: { speakerName: string; suggestedPersonId: string | null }) => [s.speakerName, s.suggestedPersonId]),
  );
  return { t, recording, candidate, suggested, recordingId };
}

describe("声纹预填说话人", () => {
  it("suggests a known person at or above 85, skips lower scores, unknown people and speakers with under 3 s of speech", async () => {
    const { deps, log } = fakeVoiceprint({
      0: { voicePrintId: "vp-ceo", score: 85 },
      10000: { voicePrintId: "vp-member", score: 84.9 },
      33000: { voicePrintId: "vp-gone", score: 99 },
    });
    const { t, recording, candidate, suggested, recordingId } = await recordWithVoiceprint(deps, "voice-threshold");
    try {
      expect(recording).toMatchObject({ status: "done", error: null });
      expect(suggested).toEqual({ "说话人 1": "person-fixture-001", "说话人 2": null, "说话人 3": null, "说话人 4": null });
      expect(candidate.speakers[0]).toMatchObject({ suggestedDisplayName: "测试甲" });
      expect(candidate.warnings).toContain("说话人「说话人 1」按声纹建议为「测试甲」（相似度 85），请确认");
      expect(candidate.warnings).toContain("说话人「说话人 2」未命中人员目录，需要人工映射");
      // 3 号只说了 1 秒，不比；2 号 20 秒只截 15 秒；长句优先
      expect(log.verifies).toBe(3);
      expect(log.clips.map((c) => c.segments)).toEqual([
        [{ startMs: 0, endMs: 4000 }, { startMs: 5000, endMs: 9000 }],
        [{ startMs: 10000, endMs: 25000 }],
        [{ startMs: 33000, endMs: 38000 }],
      ]);
      expect(log.clips.every((c) => c.maxSeconds === 15)).toBe(true);
      // 截出来的片段用完即删
      expect((await readdir(join(storageDir, recordingId))).filter((name) => name.startsWith("voiceprint-"))).toEqual([]);
    } finally {
      await t.close();
    }
  });

  it("never suggests the same person for two speakers: the higher score keeps it", async () => {
    const { deps } = fakeVoiceprint({
      0: { voicePrintId: "vp-ceo", score: 88 },
      10000: { voicePrintId: "vp-ceo", score: 92 },
      33000: { voicePrintId: "vp-member", score: 90 },
    });
    const { t, suggested } = await recordWithVoiceprint(deps, "voice-dedupe");
    try {
      expect(suggested).toEqual({ "说话人 1": null, "说话人 2": "person-fixture-001", "说话人 3": null, "说话人 4": "person-fixture-002" });
    } finally {
      await t.close();
    }
  });

  it("survives matcher errors: a failing speaker is skipped, a failing matcher leaves the candidate without suggestions", async () => {
    const partial = fakeVoiceprint({
      0: new Error("腾讯云声纹接口报错（InternalError.FailedVoicePrintVerify）"),
      10000: { voicePrintId: "vp-member", score: 90 },
    });
    const first = await recordWithVoiceprint(partial.deps, "voice-partial");
    try {
      expect(first.recording).toMatchObject({ status: "done", error: null });
      expect(first.suggested).toEqual({ "说话人 1": null, "说话人 2": "person-fixture-002", "说话人 3": null, "说话人 4": null });
    } finally {
      await first.t.close();
    }

    const broken = fakeVoiceprint({});
    broken.deps.requireConfig = () => {
      throw new Error("数据库抖了一下");
    };
    const second = await recordWithVoiceprint(broken.deps, "voice-broken");
    try {
      expect(second.recording).toMatchObject({ status: "done", error: null });
      expect(Object.values(second.suggested)).toEqual([null, null, null, null]);
      expect(broken.log.clips).toEqual([]);
    } finally {
      await second.t.close();
    }
  });

  it("skips matching silently when voiceprint is not configured", async () => {
    const { deps, log } = fakeVoiceprint({ 0: { voicePrintId: "vp-ceo", score: 99 } });
    deps.configured = () => false;
    const { t, recording, suggested } = await recordWithVoiceprint(deps, "voice-off");
    try {
      expect(recording).toMatchObject({ status: "done" });
      expect(Object.values(suggested)).toEqual([null, null, null, null]);
      expect(log.clips).toEqual([]);
    } finally {
      await t.close();
    }
  });
});
