import { describe, expect, it } from "vitest";
import { Value } from "@sinclair/typebox/value";
import { MeetingCardPayload, type TPreflightCandidate } from "@warmap/contracts";
import { createTestApp, preflightCandidate, type TestApp } from "./helpers.js";
import type { PreflightAgent, PreflightAgentInput } from "../src/meetingPreflight.js";
import { isDuplicateQuestion, mergeDuplicateQuestions, preflightStructureError } from "../src/meetingPreflight.js";
import { createObjectMaterial, editObjectMaterial, type MaterialViewer } from "../src/objectMaterials.js";
import { collectMeetingEvidence } from "../src/meetingEvidence.js";

const CEO: MaterialViewer = { personId: "person-fixture-001", role: "ceo", displayName: "测试甲" };
const MEMBER: MaterialViewer = { personId: "person-fixture-002", role: "member", displayName: "测试乙" };
const MEETING_INPUT = {
  title: "交付周会",
  scheduledAt: "2026-06-01T10:00:00.000+08:00",
  leadDriId: "person-fixture-002",
  ceoParticipantId: "person-fixture-001",
  participants: ["person-fixture-002"],
};

type Build = (input: PreflightAgentInput) => TPreflightCandidate;
type RecordingAgent = PreflightAgent & { calls: PreflightAgentInput[]; build?: Build; during?: (input: PreflightAgentInput) => Promise<void> };

function recordingAgent(): RecordingAgent {
  const agent: RecordingAgent = {
    calls: [],
    async generate(input) {
      agent.calls.push(input);
      if (agent.during) await agent.during(input);
      return { candidate: agent.build ? agent.build(input) : preflightCandidate([`meeting:${input.meeting.id}`]) };
    },
  };
  return agent;
}

/** 普通同步会：只有核心判断与一条下一步，没有战略一致性、会议问题和一号位追问。 */
function syncCandidate(refs: string[]): TPreflightCandidate {
  const base = preflightCandidate(refs);
  return {
    ...base,
    readiness: "ready",
    entries: [
      { kind: "core_judgment", title: "核心判断", body: "本周交付按计划推进，没有需要 CEO 拍板的取舍", sourceRefs: refs },
      { kind: "next_step", title: "下一步", body: "负责人周五前同步两家客户的上线结果", sourceRefs: refs },
    ],
  };
}

async function execute(t: TestApp, cookie: string, actionId: string, input?: unknown) {
  return t.app.inject({ method: "POST", url: "/api/actions/execute", headers: { cookie, origin: t.publicOrigin }, payload: { actionId, input } });
}

async function card(t: TestApp, cookie: string, meetingId: string) {
  const res = await t.app.inject({ method: "GET", url: `/api/cards/meetings/${meetingId}`, headers: { cookie } });
  expect(res.statusCode).toBe(200);
  return res.json().cards[0];
}

async function actionOf(t: TestApp, cookie: string, url: string, actionType: string): Promise<string> {
  const res = await t.app.inject({ method: "GET", url, headers: { cookie } });
  const descriptor = res.json().cards[0].actions.find((action: { actionType: string }) => action.actionType === actionType);
  expect(descriptor, `${url} 应提供 ${actionType}`).toBeTruthy();
  return descriptor.actionId as string;
}

async function scheduledMeeting(t: TestApp, externalId: string) {
  const issue = await t.app.inject({
    method: "POST",
    url: "/api/dri/issues",
    headers: { authorization: `Bearer ${t.env.driServiceToken}` },
    payload: {
      externalId, submitterPersonId: "person-fixture-002", title: `是否把标准验收清单前置到签约前（${externalId}）`,
      whyNow: "两家大单本月签约", sourceRef: `dri://test/${externalId}`, location: { level: "battlefield", battlefieldId: "growth" },
    },
  });
  expect(issue.statusCode).toBe(201);
  const issueId = issue.json().cards[0].objectRef.id as string;
  const cookie = await t.loginCookie();
  const created = await execute(t, cookie, await actionOf(t, cookie, `/api/cards/issues/${issueId}`, "issue.create_meeting"), { ...MEETING_INPUT, issueIds: [issueId] });
  expect(created.statusCode).toBe(200);
  return { cookie, issueId, meetingId: created.json().cards[0].objectRef.id as string };
}

async function regenerate(t: TestApp, cookie: string, meetingId: string) {
  const res = await execute(t, cookie, await actionOf(t, cookie, `/api/cards/meetings/${meetingId}`, "meeting.regenerate_preflight"), {});
  expect(res.statusCode).toBe(200);
  return res.json().cards[0];
}

async function postDiscussion(t: TestApp, objectType: "meeting" | "issue", objectId: string, authorId: string, content: string): Promise<number> {
  const rows = await t.sql(
    "INSERT INTO thread_messages (object_type, object_id, author_id, kind, content) VALUES ($1, $2, $3, 'member', $4) RETURNING id",
    [objectType, objectId, authorId, content],
  );
  return Number(rows[0].id);
}

describe("feedback 18：CEO 问题不设下限、去重、说明为什么需要 CEO", () => {
  it("普通同步会没有会议问题和一号位追问也能生成 ready 预审，卡片契约合法", async () => {
    const agent = recordingAgent();
    agent.build = (input) => syncCandidate([`meeting:${input.meeting.id}`]);
    const t = await createTestApp({}, undefined, { preflightAgent: agent });
    try {
      const { cookie, meetingId } = await scheduledMeeting(t, "sync-zero-questions");
      const meeting = await card(t, cookie, meetingId);
      expect(Value.Check(MeetingCardPayload, meeting.payload)).toBe(true);
      expect(meeting.payload.preflight.status).toBe("ready");
      const kinds = meeting.payload.preflight.entries.map((entry: { kind: string }) => entry.kind);
      expect(kinds).toEqual(["core_judgment", "next_step"]);
      expect(kinds).not.toContain("meeting_question");
      expect(kinds).not.toContain("leader_lens");
    } finally {
      await t.close();
    }
  });

  it("同一疑问出现在会议问题和一号位追问时合并为一条，来源并入保留项", async () => {
    const agent = recordingAgent();
    agent.build = (input) => {
      const candidate = preflightCandidate([`issue:${input.issues[0].id}`]);
      candidate.entries = candidate.entries.map((entry) => entry.kind === "leader_lens"
        ? { ...entry, title: "一号位追问", body: "是否在六月前把渠道预算从华东转到华南，还是继续观望？", sourceRefs: [`meeting:${input.meeting.id}`] }
        : entry);
      return candidate;
    };
    const t = await createTestApp({}, undefined, { preflightAgent: agent });
    try {
      const { cookie, meetingId, issueId } = await scheduledMeeting(t, "dedupe-questions");
      const entries = (await card(t, cookie, meetingId)).payload.preflight.entries as { kind: string; body: string; sourceRefs: string[]; ceoDecision?: unknown }[];
      const questions = entries.filter((entry) => entry.kind === "meeting_question" || entry.kind === "leader_lens");
      expect(questions).toHaveLength(1);
      expect(questions[0]).toMatchObject({ kind: "meeting_question", body: "是否在六月前把渠道预算从华东转到华南？" });
      expect(questions[0].sourceRefs).toEqual([`issue:${issueId}`, `meeting:${meetingId}`]);
      expect(questions[0].ceoDecision).toMatchObject({ whyCeo: expect.stringContaining("跨战场"), options: [expect.anything(), expect.anything()] });
    } finally {
      await t.close();
    }
  });

  it("近义判断与真正不同的问题区分开", () => {
    expect(isDuplicateQuestion("什么证据会推翻当前判断？", "什么证据会推翻当前推荐？")).toBe(true);
    expect(isDuplicateQuestion("为什么现在必须选择？", "为什么现在必须选择渠道投入，而不是再等一个季度？")).toBe(true);
    expect(isDuplicateQuestion("是否把 3 人周从标准连接器调给单客户定制？", "签约前是否把统一验收清单设为刚性前置？")).toBe(false);
    const entry = (kind: "meeting_question" | "leader_lens", body: string, ref: string) => ({ kind, title: "问", body, sourceRefs: [ref] });
    const merged = mergeDuplicateQuestions([
      entry("leader_lens", "什么证据会推翻当前推荐？", "issue:a"),
      entry("meeting_question", "什么证据会推翻当前判断？", "issue:b"),
      entry("leader_lens", "签约前是否把统一验收清单设为刚性前置？", "issue:c"),
    ]);
    // meeting_question 优先保留，即使它出现得更晚
    expect(merged.merged).toBe(1);
    expect(merged.entries.map((item) => [item.kind, item.sourceRefs])).toEqual([
      ["meeting_question", ["issue:b", "issue:a"]],
      ["leader_lens", ["issue:c"]],
    ]);
  });

  it("会议问题必须给至少两个选项和影响；战略一致性最多一条", () => {
    const candidate = preflightCandidate(["issue:x"]);
    const noOptions = { ...candidate, entries: candidate.entries.map((entry) => entry.kind === "meeting_question"
      ? { ...entry, ceoDecision: { ...entry.ceoDecision!, options: [{ label: "只有一个", impact: "没有取舍" }] } } : entry) };
    expect(preflightStructureError(noOptions)).toBe("meeting_question「渠道预算是否转向华南」至少需要 2 个可选路径及其影响");
    const twoAlignments = { ...candidate, entries: [...candidate.entries, { kind: "strategic_alignment" as const, title: "又一条", body: "重复", sourceRefs: ["issue:x"] }] };
    expect(preflightStructureError(twoAlignments)).toBe("strategic_alignment 最多 1 条");
    expect(preflightStructureError(syncCandidate(["issue:x"]))).toBeNull();
  });
});

describe("feedback 12：预审与 Chat 读同一份最新群材料和群讨论", () => {
  it("重新预审读取材料 v2（不是 v1）与有权限的群讨论，无权限议题群的材料和发言不进入输入，并记录所用版本", async () => {
    const agent = recordingAgent();
    const t = await createTestApp({}, undefined, { preflightAgent: agent });
    try {
      const { cookie, meetingId, issueId } = await scheduledMeeting(t, "latest-material");
      // 首次预审：没有群材料、没有讨论，输入缺失要明确
      expect(agent.calls[0].inputCoverage).toMatchObject({ groupMaterials: "missing", discussions: "missing" });
      expect(agent.calls[0].groupMaterials).toEqual([]);

      const meetingRef = { objectType: "meeting" as const, objectId: meetingId };
      const created = await createObjectMaterial(t.pool, meetingRef, CEO, "交付周报", "## 本周进展\n\n第一版：标准上线 2 家", "首版", null);
      await editObjectMaterial(t.pool, meetingRef, created.id, CEO, 1, [{ find: "第一版：标准上线 2 家", replace: "第二版：标准上线 3 家，华东一家延期" }], "更新上线数字", null);
      const messageId = await postDiscussion(t, "meeting", meetingId, "person-fixture-002", "华东那家延期是因为客户机房没准备好，不是我们交付的问题");
      // 议题已有群但 CEO 不在群里：材料和讨论都无权读取
      await t.sql("INSERT INTO thread_members (object_type, object_id, person_id, added_by) VALUES ('issue', $1, 'person-fixture-002', 'person-fixture-002')", [issueId]);
      await createObjectMaterial(t.pool, { objectType: "issue", objectId: issueId }, MEMBER, "内部草稿", "只在议题群里的秘密报价 88 万", "草稿", null);
      await postDiscussion(t, "issue", issueId, "person-fixture-002", "议题群里的私下估算");

      const regenerated = await regenerate(t, cookie, meetingId);
      const input = agent.calls.at(-1)!;
      expect(input.groupMaterials).toHaveLength(1);
      expect(input.groupMaterials[0]).toMatchObject({
        sourceRef: `material:${created.id}@v2`, version: 2, state: "used", objectType: "meeting", fileName: "交付周报.md", owner: "测试甲",
      });
      expect(input.groupMaterials[0].text).toContain("第二版：标准上线 3 家");
      expect(input.groupMaterials[0].text).not.toContain("第一版");
      expect(input.groupMaterials[0].text).toMatch(/^\[p1\] ## 本周进展\n\n\[p2\] 第二版/);
      expect(input.discussions).toEqual([expect.objectContaining({
        sourceRef: `discussion:${messageId}`, author: "测试乙", objectType: "meeting", content: expect.stringContaining("客户机房"),
      })]);
      const serialized = JSON.stringify(input);
      expect(serialized).not.toContain("秘密报价");
      expect(serialized).not.toContain("私下估算");
      expect(input.inputCoverage).toMatchObject({ groupMaterials: "available", discussions: "available", sourceMaterial: "available" });

      expect(Value.Check(MeetingCardPayload, regenerated.payload)).toBe(true);
      const preflight = regenerated.payload.preflight;
      expect(preflight.status).toBe("ready");
      expect(preflight.inputCoverage.evidence).toMatchObject({
        viewerId: "person-fixture-001",
        materials: [{ id: created.id, version: 2, state: "used", truncated: false, sourceRef: `material:${created.id}@v2` }],
        discussionMessageIds: [messageId],
        skippedObjects: 1,
      });
      expect(preflight.staleInputs).toBeUndefined();
      expect(preflight.inputsChangedDuringRun).toBeUndefined();

      // Chat 侧复用同一个读取层，得到同一版本
      const shared = await collectMeetingEvidence(t.pool.query.bind(t.pool), meetingId, CEO, { names: new Map([["person-fixture-002", "测试乙"]]) });
      expect(shared?.materials.map((material) => material.sourceRef)).toEqual([`material:${created.id}@v2`]);
      expect(shared?.discussions.map((message) => message.id)).toEqual([messageId]);
    } finally {
      await t.close();
    }
  });

  it("引用旧版本被拒绝；段落锚点在范围内保留、超出范围退回版本引用", async () => {
    const agent = recordingAgent();
    const t = await createTestApp({}, undefined, { preflightAgent: agent });
    try {
      const { cookie, meetingId } = await scheduledMeeting(t, "material-refs");
      const meetingRef = { objectType: "meeting" as const, objectId: meetingId };
      const created = await createObjectMaterial(t.pool, meetingRef, CEO, "验收清单", "第一段\n\n第二段", "首版", null);
      await editObjectMaterial(t.pool, meetingRef, created.id, CEO, 1, [{ append: "第三段：签约前确认验收范围" }], "补充第三段", null);

      agent.build = (input) => {
        const candidate = preflightCandidate([`meeting:${input.meeting.id}`]);
        candidate.entries[0].sourceRefs = [`material:${created.id}@v2#p3`, `material:${created.id}@v2#p99`];
        return candidate;
      };
      const ok = await regenerate(t, cookie, meetingId);
      expect(ok.payload.preflight.status).toBe("ready");
      expect(ok.payload.preflight.entries[0].sourceRefs).toEqual([`material:${created.id}@v2#p3`, `material:${created.id}@v2`]);

      agent.build = (input) => {
        const candidate = preflightCandidate([`meeting:${input.meeting.id}`]);
        candidate.entries[0].sourceRefs = [`material:${created.id}@v1`];
        return candidate;
      };
      const stale = await regenerate(t, cookie, meetingId);
      expect(stale.payload.preflight).toMatchObject({
        status: "failed",
        error: { code: "invalid_source_ref", message: `Preflight sourceRef 不在允许来源内: material:${created.id}@v1` },
      });
    } finally {
      await t.close();
    }
  });

  it("生成期间材料被修改：报告保存但标记 inputsChangedDuringRun，并在卡片上给出 v2→v3 的过期提示", async () => {
    const agent = recordingAgent();
    const t = await createTestApp({}, undefined, { preflightAgent: agent });
    try {
      const { cookie, meetingId } = await scheduledMeeting(t, "changed-during-run");
      const meetingRef = { objectType: "meeting" as const, objectId: meetingId };
      const created = await createObjectMaterial(t.pool, meetingRef, CEO, "报价方案", "报价 80 万", "首版", null);
      await editObjectMaterial(t.pool, meetingRef, created.id, CEO, 1, [{ find: "报价 80 万", replace: "报价 75 万" }], "下调报价", null);
      agent.during = async () => {
        await editObjectMaterial(t.pool, meetingRef, created.id, CEO, 2, [{ find: "报价 75 万", replace: "报价 70 万" }], "再降", null);
      };
      const raced = await regenerate(t, cookie, meetingId);
      expect(agent.calls.at(-1)!.groupMaterials[0]).toMatchObject({ version: 2, text: expect.stringContaining("75 万") });
      expect(raced.payload.preflight).toMatchObject({
        status: "ready",
        inputsChangedDuringRun: true,
        staleInputs: { materials: [{ id: created.id, usedVersion: 2, currentVersion: 3, change: "updated" }], newDiscussionCount: 0 },
      });
      expect(Value.Check(MeetingCardPayload, raced.payload)).toBe(true);

      // 重新生成后用 v3，过期提示消失
      agent.during = undefined;
      const fresh = await regenerate(t, cookie, meetingId);
      expect(agent.calls.at(-1)!.groupMaterials[0]).toMatchObject({ version: 3, text: expect.stringContaining("70 万") });
      expect(fresh.payload.preflight.inputsChangedDuringRun).toBeUndefined();
      expect(fresh.payload.preflight.staleInputs).toBeUndefined();
    } finally {
      await t.close();
    }
  });

  it("报告完成后又上传材料、群里有新讨论：投影出过期提示，不冒充最新", async () => {
    const agent = recordingAgent();
    const t = await createTestApp({}, undefined, { preflightAgent: agent });
    try {
      const { cookie, meetingId } = await scheduledMeeting(t, "stale-after-ready");
      const before = await card(t, cookie, meetingId);
      expect(before.payload.preflight.status).toBe("ready");
      expect(before.payload.preflight.staleInputs).toBeUndefined();

      const added = await createObjectMaterial(t.pool, { objectType: "meeting", objectId: meetingId }, CEO, "客户反馈", "客户要求合同不改验收条款", "客户原话", null);
      await postDiscussion(t, "meeting", meetingId, "person-fixture-002", "客户今天又提了一次合同条款");
      const after = await card(t, cookie, meetingId);
      expect(after.version).toBe(before.version);
      expect(after.payload.preflight.staleInputs).toEqual({
        materials: [{ id: added.id, fileName: "客户反馈.md", objectType: "meeting", objectId: meetingId, usedVersion: null, currentVersion: 1, change: "added" }],
        newDiscussionCount: 1,
      });
      expect(Value.Check(MeetingCardPayload, after.payload)).toBe(true);
    } finally {
      await t.close();
    }
  });

  it("旧会前材料与同名群材料重复时只用群材料最新版", async () => {
    const agent = recordingAgent();
    const t = await createTestApp({}, undefined, { preflightAgent: agent });
    try {
      const { cookie, meetingId } = await scheduledMeeting(t, "legacy-dedupe");
      await t.sql("UPDATE meetings SET materials = $2::jsonb WHERE id = $1", [meetingId, JSON.stringify([
        { id: "legacy-1", fileName: "交付周报.md", mimeType: "text/markdown", sizeBytes: 10, receivedBy: "person-fixture-001", providedBy: "person-fixture-002",
          uploadedAt: "2026-05-30T00:00:00.000Z", kind: "primary", storageKey: "x/legacy-1", sha256: "0", extractedText: "旧版周报：上线 1 家" },
        { id: "legacy-2", fileName: "风险清单.md", mimeType: "text/markdown", sizeBytes: 10, receivedBy: "person-fixture-001", providedBy: "person-fixture-002",
          uploadedAt: "2026-05-30T00:00:00.000Z", kind: "primary", storageKey: "x/legacy-2", sha256: "0", extractedText: "风险：两家客户要求定制" },
      ])]);
      const group = await createObjectMaterial(t.pool, { objectType: "meeting", objectId: meetingId }, CEO, "交付周报", "群里的新版周报：上线 3 家", "群里新版", null);
      const regenerated = await regenerate(t, cookie, meetingId);
      const input = agent.calls.at(-1)!;
      expect(input.materials.map((material) => material.id)).toEqual(["legacy-2"]);
      expect(JSON.stringify(input)).not.toContain("旧版周报");
      expect(regenerated.payload.preflight.inputCoverage.evidence.legacyMaterials).toEqual([
        { id: "legacy-1", fileName: "交付周报.md", state: "duplicate", duplicateOf: `material:${group.id}@v1` },
        { id: "legacy-2", fileName: "风险清单.md", state: "used" },
      ]);
    } finally {
      await t.close();
    }
  });
});
