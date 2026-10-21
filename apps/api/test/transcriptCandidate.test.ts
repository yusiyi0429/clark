import { describe, expect, it } from "vitest";
import JSZip from "jszip";
import { Value } from "@sinclair/typebox/value";
import { fileURLToPath } from "node:url";
import { Card, MeetingCardPayload, StoredTranscript, type TTranscriptSource } from "@warmap/contracts";
import { createTestApp, preflightCandidate, type TestApp } from "./helpers.js";
import type { PostMeetingAgent, PostMeetingAgentInput } from "../src/outcome.js";
import type { PreflightAgent, PreflightAgentInput } from "../src/meetingPreflight.js";
import { buildTranscriptCandidate } from "../src/transcriptCandidate.js";

const PEOPLE_SEED = fileURLToPath(new URL("./fixtures/company-people-candidate.json", import.meta.url));

const MEETING_INPUT = {
  title: "渠道投入决策会",
  scheduledAt: "2026-06-01T10:00:00.000+08:00",
  leadDriId: "person-fixture-002",
  ceoParticipantId: "person-fixture-001",
  participants: ["person-fixture-002"],
};

const MARKDOWN = [
  "### 关键词",
  "",
  "`渠道` `排期`",
  "",
  "### 文字记录",
  "",
  "测试甲 00:05",
  "我确认这个方向。",
  "",
  "测试乙 00:20",
  "我周五前给排期。",
  "",
  "测试丙 00:35",
  "我来跟进风险清单。",
  "",
].join("\n");

const preflightAgent: PreflightAgent = {
  async generate(input: PreflightAgentInput) {
    return { candidate: preflightCandidate(input.issues.map((issue) => `issue:${issue.id}`)) };
  },
};

function fakeOutcomeAgent(): PostMeetingAgent & { calls: PostMeetingAgentInput[] } {
  const agent: PostMeetingAgent & { calls: PostMeetingAgentInput[] } = {
    calls: [],
    async generate(input) {
      agent.calls.push(input);
      return {
        candidate: {
          summary: "会议形成一项待办",
          sections: [{ heading: "排期", body: "已定：测试乙周五前给排期。", turnIds: ["turn-0002"] }],
          objectChanges: [],
          actionItems: [{ text: "周五前给排期", ownerPersonId: "person-fixture-002", dueDate: null, basisSections: [1] }],
        },
        runId: "outcome-run-1",
      };
    },
  };
  return agent;
}

async function newApp(agent: PostMeetingAgent = fakeOutcomeAgent()): Promise<TestApp> {
  return createTestApp({ companyPeopleSeed: PEOPLE_SEED }, undefined, { preflightAgent, outcomeAgent: agent });
}

async function readyMeeting(t: TestApp, externalId: string): Promise<{ cookie: string; meetingId: string }> {
  const issue = await t.app.inject({
    method: "POST",
    url: "/api/dri/issues",
    headers: { authorization: `Bearer ${t.env.driServiceToken}` },
    payload: {
      externalId: `dri-candidate-${externalId}`,
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
    payload: { actionId: descriptor.actionId, input: { ...MEETING_INPUT, issueIds: [issueId] } },
  });
  expect(meeting.statusCode).toBe(200);
  return { cookie, meetingId: meeting.json().cards[0].objectRef.id as string };
}

function mdPart(fileName: string, content: string | Buffer): { boundary: string; payload: Buffer } {
  const boundary = "----warmap-md-boundary";
  return {
    boundary,
    payload: Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: text/markdown\r\n\r\n`),
      Buffer.from(content),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]),
  };
}

async function upload(t: TestApp, cookie: string, meetingId: string, content: string | Buffer, fileName = "meeting.md") {
  const { boundary, payload } = mdPart(fileName, content);
  return t.app.inject({
    method: "POST",
    url: `/api/meetings/${meetingId}/transcript-candidate`,
    headers: { cookie, origin: t.publicOrigin, "content-type": `multipart/form-data; boundary=${boundary}` },
    payload,
  });
}

async function meetingCard(t: TestApp, cookie: string, meetingId: string): Promise<Record<string, unknown>> {
  const res = await t.app.inject({ method: "GET", url: `/api/cards/meetings/${meetingId}`, headers: { cookie } });
  return res.json().cards[0];
}

async function actionId(t: TestApp, cookie: string, meetingId: string, actionType: string): Promise<string | undefined> {
  const card = await meetingCard(t, cookie, meetingId);
  return (card.actions as { actionType: string; actionId: string }[]).find((action) => action.actionType === actionType)?.actionId;
}

async function execute(t: TestApp, cookie: string, id: string | undefined, input?: unknown) {
  return t.app.inject({ method: "POST", url: "/api/actions/execute", headers: { cookie, origin: t.publicOrigin }, payload: { actionId: id, input } });
}

const MAPPINGS = [
  { speakerName: "测试甲", personId: "person-fixture-001" },
  { speakerName: "测试乙", personId: "person-fixture-002" },
  { speakerName: "测试丙", personId: "person-fixture-003" },
];

describe("buildTranscriptCandidate", () => {
  const source: TTranscriptSource = { format: "miaoji_markdown", fileName: "m.md", sizeBytes: 10, sha256: "a".repeat(64), parserVersion: "miaoji-markdown.v1", timeAnchor: null };
  const people = [
    { personId: "p1", displayName: "甲", roles: ["ceo"], sourceRef: "s", updatedAt: "t" },
    { personId: "p2", displayName: "乙", roles: ["participant"], sourceRef: "s", updatedAt: "t" },
    { personId: "p3", displayName: "乙", roles: ["participant"], sourceRef: "s", updatedAt: "t" },
  ];

  it("suggests only exact-unique displayName matches and warns on missing or duplicate names", () => {
    const turns = [
      { speakerName: "甲", offsetSeconds: 1, text: "a" },
      { speakerName: "乙", offsetSeconds: 2, text: "b" },
      { speakerName: "丙", offsetSeconds: 3, text: "c" },
      { speakerName: "甲", offsetSeconds: 4, text: "d" },
    ];
    const candidate = buildTranscriptCandidate(turns, people, source);
    expect(candidate.speakers).toEqual([
      { speakerName: "甲", turnCount: 2, suggestedPersonId: "p1", suggestedDisplayName: "甲" },
      { speakerName: "乙", turnCount: 1, suggestedPersonId: null, suggestedDisplayName: null },
      { speakerName: "丙", turnCount: 1, suggestedPersonId: null, suggestedDisplayName: null },
    ]);
    expect(candidate.warnings).toHaveLength(2);
    expect(candidate.turns).toEqual(turns);
  });
});

describe("妙记 Markdown Transcript 候选", () => {
  it("uploads a candidate without touching status, transcript or Outcome, then projects only a summary", async () => {
    const agent = fakeOutcomeAgent();
    const t = await newApp(agent);
    try {
      const { cookie, meetingId } = await readyMeeting(t, "upload");
      const before = (await t.sql("SELECT version FROM meetings WHERE id = $1", [meetingId]))[0].version as number;
      const res = await upload(t, cookie, meetingId, MARKDOWN);
      expect(res.statusCode).toBe(200);
      const card = res.json().cards[0];
      expect(Value.Check(Card, card)).toBe(true);
      expect(Value.Check(MeetingCardPayload, card.payload)).toBe(true);
      expect(card.payload.status).toBe("scheduled");
      expect(card.payload.transcript).toBeNull();
      expect(card.payload.outcome).toBeNull();
      expect(card.payload.transcriptCandidate).toMatchObject({
        turnCount: 3,
        speakerCount: 3,
        durationSeconds: 30,
        firstOffsetSeconds: 5,
        lastOffsetSeconds: 35,
        warnings: [],
        source: { format: "miaoji_markdown", fileName: "meeting.md", parserVersion: "miaoji-markdown.v1" },
      });
      expect(card.payload.transcriptCandidate.speakers.map((speaker: { speakerName: string }) => speaker.speakerName)).toEqual(["测试甲", "测试乙", "测试丙"]);
      expect(card.payload.transcriptCandidate.sampleTurns).toHaveLength(3);
      // 全量 turns 只在服务端；Card 投影不带 turns 字段
      expect(card.payload.transcriptCandidate.turns).toBeUndefined();
      expect(agent.calls).toHaveLength(0);

      const row = (await t.sql("SELECT version, status, transcript_candidate FROM meetings WHERE id = $1", [meetingId]))[0];
      expect(row.version).toBe(before + 1);
      expect((row.transcript_candidate as { turns: unknown[] }).turns).toHaveLength(3);
      expect(await actionId(t, cookie, meetingId, "meeting.confirm_transcript_candidate")).toBeTruthy();
      expect(await actionId(t, cookie, meetingId, "meeting.discard_transcript_candidate")).toBeTruthy();
    } finally {
      await t.close();
    }
  });

  it("rejects non-Markdown, oversize and structurally invalid uploads without creating a candidate", async () => {
    const t = await newApp();
    try {
      const { cookie, meetingId } = await readyMeeting(t, "upload-invalid");
      expect((await upload(t, cookie, meetingId, MARKDOWN, "transcript.json")).json()).toMatchObject({ code: "UNSUPPORTED_FILE_TYPE", message: "只收 txt、md、pdf、docx、html" });
      expect((await upload(t, cookie, meetingId, MARKDOWN, "旧版.doc")).json()).toMatchObject({ code: "DOC_NOT_SUPPORTED", message: "请另存为 docx 再上传" });
      expect((await upload(t, cookie, meetingId, " \n\n", "空.txt")).json().code).toBe("EMPTY_TRANSCRIPT");
      const oversize = await upload(t, cookie, meetingId, Buffer.alloc(20 * 1024 * 1024 + 1, "x"));
      expect(oversize.statusCode).toBe(413);
      expect(oversize.json().code).toBe("TRANSCRIPT_TOO_LARGE");
      const bad = await upload(t, cookie, meetingId, "### 文字记录\n\n测试甲 00:05\n");
      expect(bad.statusCode).toBe(400);
      expect(bad.json()).toMatchObject({ code: "EMPTY_TURN_TEXT" });
      expect((await t.sql("SELECT transcript_candidate, status FROM meetings WHERE id = $1", [meetingId]))[0]).toMatchObject({ transcript_candidate: null, status: "scheduled" });
    } finally {
      await t.close();
    }
  });

  it("re-uploading replaces the whole candidate and discard clears it", async () => {
    const t = await newApp();
    try {
      const { cookie, meetingId } = await readyMeeting(t, "replace-candidate");
      await upload(t, cookie, meetingId, MARKDOWN);
      const second = await upload(t, cookie, meetingId, MARKDOWN.replace("测试丙 00:35", "测试丙 00:40"), "second.md");
      expect(second.statusCode).toBe(200);
      expect(second.json().cards[0].payload.transcriptCandidate).toMatchObject({ source: { fileName: "second.md" }, lastOffsetSeconds: 40 });

      const discard = await actionId(t, cookie, meetingId, "meeting.discard_transcript_candidate");
      const cleared = await execute(t, cookie, discard, {});
      expect(cleared.statusCode).toBe(200);
      expect(cleared.json().cards[0].payload).toMatchObject({ status: "scheduled", transcript: null, transcriptCandidate: null });
      expect(await actionId(t, cookie, meetingId, "meeting.discard_transcript_candidate")).toBeUndefined();
      // 清除后可重新上传
      expect((await upload(t, cookie, meetingId, MARKDOWN)).statusCode).toBe(200);
    } finally {
      await t.close();
    }
  });

  it("refuses a candidate once a Transcript exists or the Meeting is not scheduled", async () => {
    const t = await newApp();
    try {
      const { cookie, meetingId } = await readyMeeting(t, "upload-guard");
      await t.sql("UPDATE meetings SET status = 'held' WHERE id = $1", [meetingId]);
      const res = await upload(t, cookie, meetingId, MARKDOWN);
      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe("MEETING_NOT_SCHEDULED");
    } finally {
      await t.close();
    }
  });

  it("clears the candidate when the scheduled Meeting is cancelled, leaving the rest of the Meeting intact", async () => {
    const t = await newApp();
    try {
      const { cookie, meetingId } = await readyMeeting(t, "cancel-clears-candidate");
      await upload(t, cookie, meetingId, MARKDOWN);
      const before = (await t.sql("SELECT title, scheduled_at, participants, issue_ids, preflight, draft, materials FROM meetings WHERE id = $1", [meetingId]))[0];

      const cancel = await actionId(t, cookie, meetingId, "meeting.cancel");
      expect(cancel).toBeTruthy();
      const res = await execute(t, cookie, cancel);
      expect(res.statusCode).toBe(200);
      const card = res.json().cards[0];
      expect(card.payload.status).toBe("cancelled");
      expect(card.payload.transcriptCandidate).toBeNull();
      expect(card.actions).toEqual([]);

      const row = (await t.sql("SELECT status, transcript, transcript_candidate, title, scheduled_at, participants, issue_ids, preflight, draft, materials FROM meetings WHERE id = $1", [meetingId]))[0];
      expect(row).toMatchObject({ status: "cancelled", transcript: null, transcript_candidate: null });
      expect(row.title).toBe(before.title);
      expect(row.scheduled_at).toEqual(before.scheduled_at);
      expect(row.participants).toEqual(before.participants);
      expect(row.issue_ids).toEqual(before.issue_ids);
      expect(row.preflight).toEqual(before.preflight);
      expect(row.draft).toEqual(before.draft);
      expect(row.materials).toEqual(before.materials);
    } finally {
      await t.close();
    }
  });
});

describe("meeting.confirm_transcript_candidate", () => {
  it("validates the mapping coverage before writing anything", async () => {
    const t = await newApp();
    try {
      const { cookie, meetingId } = await readyMeeting(t, "confirm-invalid");
      await upload(t, cookie, meetingId, MARKDOWN);
      const confirm = await actionId(t, cookie, meetingId, "meeting.confirm_transcript_candidate");

      const incomplete = await execute(t, cookie, confirm, { speakerMappings: MAPPINGS.slice(0, 2), confirmAddParticipants: true });
      expect(incomplete.statusCode).toBe(400);
      expect(incomplete.json().code).toBe("INCOMPLETE_SPEAKER_MAPPING");
      expect(incomplete.json().fieldErrors).toBeTruthy();

      const unknown = await execute(t, cookie, confirm, { speakerMappings: [...MAPPINGS.slice(0, 2), { speakerName: "测试丙", personId: "person-nope" }], confirmAddParticipants: true });
      expect(unknown.json().code).toBe("INVALID_SPEAKER_MAPPING");

      const unknownSpeaker = await execute(t, cookie, confirm, { speakerMappings: [...MAPPINGS, { speakerName: "测试丁", personId: "person-fixture-003" }], confirmAddParticipants: true });
      expect(unknownSpeaker.json().code).toBe("INVALID_SPEAKER_MAPPING");

      expect((await t.sql("SELECT status, transcript, participants FROM meetings WHERE id = $1", [meetingId]))[0]).toMatchObject({ status: "scheduled", transcript: null });
    } finally {
      await t.close();
    }
  });

  it("adds participants, writes the standard transcript with lock-time anchors and starts Outcome after COMMIT", async () => {
    const agent = fakeOutcomeAgent();
    const t = await newApp(agent);
    try {
      const { cookie, meetingId } = await readyMeeting(t, "confirm-ok");
      await upload(t, cookie, meetingId, MARKDOWN);
      const confirm = await actionId(t, cookie, meetingId, "meeting.confirm_transcript_candidate");
      const res = await execute(t, cookie, confirm, { speakerMappings: MAPPINGS, confirmAddParticipants: true });
      expect(res.statusCode).toBe(200);
      const payload = res.json().cards[0].payload;
      // 会后整理生成会议卡（待办留在卡片的行动项里，确认后才推），Meeting 停在 held 等整卡确认
      expect(payload.status).toBe("held");
      expect(payload.transcriptCandidate).toBeNull();
      expect(Value.Check(StoredTranscript, payload.transcript)).toBe(true);
      expect(payload.transcript.source).toMatchObject({ format: "miaoji_markdown", fileName: "meeting.md", timeAnchor: "2026-06-01T02:00:00.000Z" });
      expect(payload.transcript.turns.map((turn: { id: string; speakerId: string; startedAt: string }) => [turn.id, turn.speakerId, turn.startedAt])).toEqual([
        ["turn-0001", "person-fixture-001", "2026-06-01T02:00:05.000Z"],
        ["turn-0002", "person-fixture-002", "2026-06-01T02:00:20.000Z"],
        ["turn-0003", "person-fixture-003", "2026-06-01T02:00:35.000Z"],
      ]);
      // 测试丙按确认补齐为 participant；ceo/lead 不变
      expect((payload.participants as { personId: string }[]).map((participant) => participant.personId)).toEqual([
        "person-fixture-001",
        "person-fixture-002",
        "person-fixture-003",
      ]);
      expect(payload.outcome).toMatchObject({ status: "ready", error: null });
      expect(agent.calls).toHaveLength(1);
      expect(agent.calls[0].transcript.turns.map((turn) => turn.id)).toEqual(["turn-0001", "turn-0002", "turn-0003"]);
      // 确认后候选与后续候选 Action 一起消失
      expect(await actionId(t, cookie, meetingId, "meeting.confirm_transcript_candidate")).toBeUndefined();
    } finally {
      await t.close();
    }
  });

  it("lets several speakers map to the same person: each turn keeps that person and participants stay unique", async () => {
    const t = await newApp();
    try {
      const { cookie, meetingId } = await readyMeeting(t, "confirm-same-person");
      // 飞书把同一个人拆成两个说话人：测试丙 / Speaker 1 都是 003（确认时才补进参会人），Speaker 2 是已在会的 002
      await upload(t, cookie, meetingId, `${MARKDOWN}\nSpeaker 1 00:50\n风险清单我今天发。\n\nSpeaker 2 01:05\n排期我再对一下。\n`);
      const confirm = await actionId(t, cookie, meetingId, "meeting.confirm_transcript_candidate");
      const res = await execute(t, cookie, confirm, {
        speakerMappings: [...MAPPINGS, { speakerName: "Speaker 1", personId: "person-fixture-003" }, { speakerName: "Speaker 2", personId: "person-fixture-002" }],
        confirmAddParticipants: true,
      });
      expect(res.statusCode).toBe(200);
      const payload = res.json().cards[0].payload;
      expect(payload.transcript.turns.map((turn: { id: string; speakerId: string }) => [turn.id, turn.speakerId])).toEqual([
        ["turn-0001", "person-fixture-001"],
        ["turn-0002", "person-fixture-002"],
        ["turn-0003", "person-fixture-003"],
        ["turn-0004", "person-fixture-003"],
        ["turn-0005", "person-fixture-002"],
      ]);
      expect((payload.participants as { personId: string }[]).map((participant) => participant.personId)).toEqual([
        "person-fixture-001",
        "person-fixture-002",
        "person-fixture-003",
      ]);
    } finally {
      await t.close();
    }
  });

  it("invalidates a stale confirm Action after a version bump and replays the same Action idempotently", async () => {
    const agent = fakeOutcomeAgent();
    const t = await newApp(agent);
    try {
      const { cookie, meetingId } = await readyMeeting(t, "confirm-version");
      await upload(t, cookie, meetingId, MARKDOWN);
      const stale = await actionId(t, cookie, meetingId, "meeting.confirm_transcript_candidate");
      await t.sql("UPDATE meetings SET version = version + 1 WHERE id = $1", [meetingId]);
      const conflict = await execute(t, cookie, stale, { speakerMappings: MAPPINGS, confirmAddParticipants: true });
      expect(conflict.statusCode).toBe(409);
      expect(conflict.json().code).toBe("VERSION_CONFLICT");

      const fresh = await actionId(t, cookie, meetingId, "meeting.confirm_transcript_candidate");
      const done = await execute(t, cookie, fresh, { speakerMappings: MAPPINGS, confirmAddParticipants: true });
      expect(done.statusCode).toBe(200);
      const replay = await execute(t, cookie, fresh, { speakerMappings: MAPPINGS, confirmAddParticipants: true });
      expect(replay.statusCode).toBe(200);
      expect(agent.calls).toHaveLength(1);
    } finally {
      await t.close();
    }
  });

  it("leaves the Meeting untouched when the confirmation omits the explicit flag", async () => {
    const t = await newApp();
    try {
      const { cookie, meetingId } = await readyMeeting(t, "confirm-flag");
      await upload(t, cookie, meetingId, MARKDOWN);
      const confirm = await actionId(t, cookie, meetingId, "meeting.confirm_transcript_candidate");
      const res = await execute(t, cookie, confirm, { speakerMappings: MAPPINGS });
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe("INVALID_INPUT");
      expect((await t.sql("SELECT status, transcript, transcript_candidate FROM meetings WHERE id = $1", [meetingId]))[0]).toMatchObject({ status: "scheduled", transcript: null });
      expect((await t.sql("SELECT transcript_candidate FROM meetings WHERE id = $1", [meetingId]))[0].transcript_candidate).not.toBeNull();
    } finally {
      await t.close();
    }
  });
});

describe("会议记录多格式上传", () => {
  it("reads a Markdown file without the 文字记录 heading but with 姓名：内容 lines as a candidate", async () => {
    const t = await newApp();
    try {
      const { cookie, meetingId } = await readyMeeting(t, "speaker-lines");
      const content = "# 渠道周会\n\n测试甲：方向我确认。\n测试乙：我周五前给排期。\n测试甲：好。\n";
      const res = await upload(t, cookie, meetingId, content, "周会.md");
      expect(res.statusCode).toBe(200);
      const candidate = res.json().cards[0].payload.transcriptCandidate;
      expect(candidate).toMatchObject({ turnCount: 3, speakerCount: 2, source: { format: "speaker_lines", fileName: "周会.md", parserVersion: "speaker-lines.v1" } });
      expect(candidate.speakers.map((speaker: { speakerName: string }) => speaker.speakerName)).toEqual(["测试甲", "测试乙"]);
      expect(res.json().cards[0].payload.status).toBe("scheduled");
    } finally {
      await t.close();
    }
  });

  it("reads a Feishu txt export as a candidate", async () => {
    const t = await newApp();
    try {
      const { cookie, meetingId } = await readyMeeting(t, "feishu-text");
      const content = "2026-06-01 10:00:02 CST|26min 25s\n\n关键词:\n渠道、排期\n\n测试甲 00:00:05.120\n我确认这个方向。\n\n测试乙 00:00:20.000\n我周五前给排期。\n";
      const res = await upload(t, cookie, meetingId, content, "妙记.txt");
      expect(res.statusCode).toBe(200);
      expect(res.json().cards[0].payload.transcriptCandidate).toMatchObject({
        turnCount: 2, speakerCount: 2, firstOffsetSeconds: 5, lastOffsetSeconds: 20,
        source: { format: "feishu_text", fileName: "妙记.txt", parserVersion: "feishu-minutes-txt.v1" },
      });
    } finally {
      await t.close();
    }
  });

  it("imports plain notes as an unmapped 会议纪要 speaker and starts the meeting card right away", async () => {
    const agent = fakeOutcomeAgent();
    const t = await newApp(agent);
    try {
      const { cookie, meetingId } = await readyMeeting(t, "notes");
      const notes = "# 渠道周会纪要\n\n本周先把渠道排期定下来，预算按上月口径走。\n\n各组周五前交风险清单。\n";
      const res = await upload(t, cookie, meetingId, notes, "纪要.md");
      expect(res.statusCode).toBe(200);
      const payload = res.json().cards[0].payload;
      expect(payload.status).toBe("held");
      expect(payload.transcriptCandidate).toBeNull();
      expect(Value.Check(StoredTranscript, payload.transcript)).toBe(true);
      expect(payload.transcript.source).toMatchObject({ format: "meeting_notes", fileName: "纪要.md", parserVersion: "meeting-notes.v1" });
      expect(payload.transcript.unmappedSpeakers).toEqual([{ id: "speaker:1", name: "会议纪要" }]);
      expect(payload.transcript.turns.map((turn: { speakerId: string; text: string }) => [turn.speakerId, turn.text])).toEqual([
        ["speaker:1", "# 渠道周会纪要"],
        ["speaker:1", "本周先把渠道排期定下来，预算按上月口径走。"],
        ["speaker:1", "各组周五前交风险清单。"],
      ]);
      expect(agent.calls).toHaveLength(1);
      expect(payload.outcome).not.toBeNull();
    } finally {
      await t.close();
    }
  });

  it("reads html and docx uploads", async () => {
    const t = await newApp();
    try {
      const { cookie, meetingId } = await readyMeeting(t, "html-docx");
      const html = "<html><head><script>alert(1)</script></head><body><p>测试甲：方向我确认。</p><p>测试乙：我周五前给&amp;排期。</p></body></html>";
      const fromHtml = await upload(t, cookie, meetingId, html, "周会.html");
      expect(fromHtml.statusCode).toBe(200);
      expect(fromHtml.json().cards[0].payload.transcriptCandidate).toMatchObject({ speakerCount: 2, source: { format: "speaker_lines", fileName: "周会.html" } });
      const turns = (await t.sql("SELECT transcript_candidate FROM meetings WHERE id = $1", [meetingId]))[0].transcript_candidate.turns as { text: string }[];
      expect(turns.map((turn) => turn.text)).toEqual(["方向我确认。", "我周五前给&排期。"]);

      const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
      const zip = new JSZip();
      zip.file("[Content_Types].xml", `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`);
      zip.file("_rels/.rels", `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="word/document.xml"/></Relationships>`);
      zip.file("word/document.xml", `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>测试甲：方向我确认。</w:t></w:r></w:p><w:p><w:r><w:t>测试乙：我周五前给排期。</w:t></w:r></w:p></w:body></w:document>`);
      const docx = await zip.generateAsync({ type: "nodebuffer" });
      const fromDocx = await upload(t, cookie, meetingId, docx, "周会.docx");
      expect(fromDocx.statusCode).toBe(200);
      expect(fromDocx.json().cards[0].payload.transcriptCandidate).toMatchObject({ speakerCount: 2, source: { format: "speaker_lines", fileName: "周会.docx", sizeBytes: docx.length } });
    } finally {
      await t.close();
    }
  });
});
