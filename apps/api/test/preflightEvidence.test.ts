import { describe, expect, it } from "vitest";
import { Value } from "@sinclair/typebox/value";
import { MeetingCardPayload, type TPreflightCandidate } from "@warmap/contracts";
import { createTestApp, preflightCandidate, type TestApp } from "./helpers.js";
import type { PreflightAgent, PreflightAgentInput } from "../src/meetingPreflight.js";
import { dropDuplicateQuestions, isDuplicateQuestion, preflightCandidateError, preflightEntries, withoutThinJudgment } from "../src/meetingPreflight.js";
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

/** 普通同步会：核心判断加一个要聊的问题，没有要拍板的事。 */
function syncCandidate(refs: string[]): TPreflightCandidate {
  const base = preflightCandidate(refs);
  return {
    ...base,
    decision: undefined,
    judgment: { headline: "本周交付按计划推进", body: "两家客户已上线，第三家等客户机房。", sourceRefs: refs },
    questions: [{ question: "第三家客户机房能否在周五前准备好？", why: "决定本月上线数是 3 家还是 2 家。", sourceRefs: refs }],
    decisions: [],
  };
}

const REFS = { allowed: new Set(["issue:x", "meeting:m", "material:00000000-0000-4000-8000-000000000001@v2"]),
  paragraphCounts: new Map([["material:00000000-0000-4000-8000-000000000001@v2", 3]]) };

describe("会前预审 v5：要聊的问题、要拍板的事与档位规则", () => {
  it("普通同步会可以没有要拍板的事，生成 ready 预审，卡片契约合法", async () => {
    const agent = recordingAgent();
    agent.build = (input) => syncCandidate([`meeting:${input.meeting.id}`]);
    const t = await createTestApp({}, undefined, { preflightAgent: agent });
    try {
      const { cookie, meetingId } = await scheduledMeeting(t, "sync-zero-questions");
      const meeting = await card(t, cookie, meetingId);
      expect(Value.Check(MeetingCardPayload, meeting.payload)).toBe(true);
      expect(meeting.payload.preflight).toMatchObject({ status: "ready", depth: "standard", brief: "本周交付按计划推进" });
      expect(meeting.payload.preflight.decision).toBeUndefined();
      const kinds = meeting.payload.preflight.entries.map((entry: { kind: string }) => entry.kind);
      expect(kinds).toEqual(["core_judgment", "discussion_question"]);
    } finally {
      await t.close();
    }
  });

  it("同一个问题出现在要聊的问题和要拍板的事时只留要拍板的事，来源并入保留项", async () => {
    const agent = recordingAgent();
    agent.build = (input) => {
      const candidate = preflightCandidate([`issue:${input.issues[0].id}`]);
      return { ...candidate, questions: [
        { question: "渠道预算是否在六月前转向华南？", why: "换个问法重复了要拍板的事。", sourceRefs: [`meeting:${input.meeting.id}`] },
        ...candidate.questions,
      ] };
    };
    const t = await createTestApp({}, undefined, { preflightAgent: agent });
    try {
      const { cookie, meetingId, issueId } = await scheduledMeeting(t, "dedupe-questions");
      const entries = (await card(t, cookie, meetingId)).payload.preflight.entries as { kind: string; title: string; sourceRefs: string[]; ceoDecision?: unknown }[];
      expect(entries.map((entry) => entry.kind)).toEqual(["core_judgment", "discussion_question", "meeting_question"]);
      expect(entries[1].title).toBe("华南转化率来自哪几家客户，样本够不够支撑整笔预算调整？");
      expect(entries[2]).toMatchObject({ kind: "meeting_question", title: "渠道预算是否在六月前转向华南" });
      expect(entries[2].sourceRefs).toEqual([`issue:${issueId}`, `meeting:${meetingId}`]);
      expect(entries[2].ceoDecision).toMatchObject({ whyCeo: expect.stringContaining("跨战场"), options: [expect.anything(), expect.anything()] });
    } finally {
      await t.close();
    }
  });

  it("近义问题与真正不同的问题区分开；要聊的问题之间也去重", () => {
    expect(isDuplicateQuestion("什么证据会推翻当前判断？", "什么证据会推翻当前推荐？")).toBe(true);
    expect(isDuplicateQuestion("为什么现在必须选择？", "为什么现在必须选择渠道投入，而不是再等一个季度？")).toBe(true);
    expect(isDuplicateQuestion("是否把 3 人周从标准连接器调给单客户定制？", "签约前是否把统一验收清单设为刚性前置？")).toBe(false);
    const base = preflightCandidate(["issue:x"]);
    const deduped = dropDuplicateQuestions({ ...base, decisions: [], questions: [
      { question: "什么证据会推翻当前推荐？", why: "一", sourceRefs: ["issue:a"] },
      { question: "什么证据会推翻当前判断？", why: "二", sourceRefs: ["issue:b"] },
      { question: "签约前是否把统一验收清单设为刚性前置？", why: "三", sourceRefs: ["issue:c"] },
    ] });
    expect(deduped.questions.map((item) => [item.question, item.sourceRefs])).toEqual([
      ["什么证据会推翻当前推荐？", ["issue:a", "issue:b"]],
      ["签约前是否把统一验收清单设为刚性前置？", ["issue:c"]],
    ]);
  });

  it("档位规则：战略会要写要定的事；信息不足时不写判断、只写缺什么；普通会要有核心判断和要聊的问题", () => {
    const base = preflightCandidate(["issue:x"]);
    expect(preflightCandidateError(base, REFS)).toBeNull();
    expect(preflightCandidateError({ ...base, depth: "strategic", decision: undefined }, REFS)?.message).toBe("depth=strategic 时必须写 decision（这场会要定的事）");
    expect(preflightCandidateError({ ...base, questions: [] }, REFS)?.message).toBe("depth=standard 时 questions 至少写 1 个");
    expect(preflightCandidateError({ ...base, gaps: ["缺本周数据"] }, REFS)?.message).toBe("depth=standard 时 gaps 必须为空数组，缺的事实写进 basis 或写成要聊的问题");
    const thin = { ...base, depth: "thin" as const, decision: undefined, judgment: undefined, decisions: [], questions: [], gaps: ["还没有本周完成情况，补上后能定月底是否按期"] };
    expect(preflightCandidateError(thin, REFS)).toBeNull();
    expect(preflightCandidateError({ ...thin, gaps: [] }, REFS)?.message).toBe("depth=thin 时 gaps 写 1 到 2 句：缺哪一项具体内容、补上之后能定什么");
    expect(preflightCandidateError({ ...thin, decisions: base.decisions }, REFS)?.message).toBe("depth=thin 时 decisions 必须为空数组");
    // 要拍板的事没有下限：普通会零条合法
    expect(preflightCandidateError({ ...base, decisions: [] }, REFS)).toBeNull();
    // 只有标题、时间、参会人和挂点名称：不能凭公司事实下判断，只能是 thin；thin 顺手填的判断和要定的事去掉，不算错
    const thinOnly = { ...REFS, thinOnly: true };
    expect(preflightCandidateError(base, thinOnly)?.message)
      .toBe("这场会除了标题、时间、参会人和挂点名称没有别的内容，公司事实不能代替会议内容：depth 只能是 thin，在 gaps 写缺什么");
    expect(preflightCandidateError({ ...thin, judgment: base.judgment, decision: "待补" }, thinOnly)).toBeNull();
    expect(withoutThinJudgment({ ...thin, judgment: base.judgment, decision: "待补" })).toEqual(thin);
    expect(withoutThinJudgment(base)).toBe(base);
  });

  it("翻案句指出是哪一处；引用必须在输入里，段落锚点超出范围时退回版本引用", () => {
    const base = preflightCandidate(["issue:x"]);
    const turned = { ...base, questions: [{ ...base.questions[0], why: "这不是样本问题，而是窗口问题" }] };
    expect(preflightCandidateError(turned, REFS)).toEqual({ code: "invalid_preflight_candidate", message: "questions[0].why 用了「不是……而是……」句式，改成正面直接陈述" });
    const unknown = { ...base, decisions: [{ ...base.decisions[0], sourceRefs: ["memory:not-a-section"] }] };
    expect(preflightCandidateError(unknown, REFS)).toEqual({ code: "invalid_source_ref",
      message: "decisions[0].sourceRefs 里的 memory:not-a-section 不在输入里，只能用输入里显式出现的引用" });
    const material = "material:00000000-0000-4000-8000-000000000001@v2";
    const anchored = { ...base, judgment: { ...base.judgment!, sourceRefs: [`${material}#p3`, `${material}#p9`, "issue:x"] } };
    expect(preflightCandidateError(anchored, REFS)).toBeNull();
    expect(preflightEntries(anchored, REFS)[0]).toMatchObject({ id: "entry-1", kind: "core_judgment", sourceRefs: [`${material}#p3`, material, "issue:x"] });
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
        return { ...candidate, judgment: { ...candidate.judgment!, sourceRefs: [`material:${created.id}@v2#p3`, `material:${created.id}@v2#p99`] } };
      };
      const ok = await regenerate(t, cookie, meetingId);
      expect(ok.payload.preflight.status).toBe("ready");
      expect(ok.payload.preflight.entries[0].sourceRefs).toEqual([`material:${created.id}@v2#p3`, `material:${created.id}@v2`]);

      agent.build = (input) => {
        const candidate = preflightCandidate([`meeting:${input.meeting.id}`]);
        return { ...candidate, judgment: { ...candidate.judgment!, sourceRefs: [`material:${created.id}@v1`] } };
      };
      const stale = await regenerate(t, cookie, meetingId);
      expect(stale.payload.preflight).toMatchObject({
        status: "failed",
        error: { code: "invalid_source_ref", message: `judgment.sourceRefs 里的 material:${created.id}@v1 不在输入里，只能用输入里显式出现的引用` },
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
