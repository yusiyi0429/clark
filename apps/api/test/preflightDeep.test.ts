import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { Value } from "@sinclair/typebox/value";
import { MeetingCardPayload, type TPreflightCandidate, type TPreflightProgress } from "@warmap/contracts";
import { createTestApp, preflightCandidate, type TestApp } from "./helpers.js";
import type { PreflightAgent, PreflightAgentHooks, PreflightAgentInput } from "../src/meetingPreflight.js";
import { PREFLIGHT_PROMPT, preflightThinkingLevel } from "../src/preflightAgent.js";
import { PreflightProgressRecorder, cleanThought, createAgentProgressHandler, createCandidateProgress, latestParagraphLead, materialStepLabel } from "../src/preflightProgress.js";
import { MEETING_QUESTION_MIN_OPTIONS } from "../src/promptRules.js";

const MEETING_INPUT = {
  title: "增长战场渠道复盘会",
  scheduledAt: "2026-06-01T10:00:00.000+08:00",
  leadDriId: "person-fixture-002",
  ceoParticipantId: "person-fixture-001",
  participants: ["person-fixture-002"],
};

type Hooked = PreflightAgent & { calls: PreflightAgentInput[]; during?: (input: PreflightAgentInput, hooks?: PreflightAgentHooks) => Promise<void>;
  build?: (input: PreflightAgentInput) => TPreflightCandidate };

function hookedAgent(): Hooked {
  const agent: Hooked = {
    calls: [],
    async generate(input, _signal, hooks) {
      agent.calls.push(input);
      if (agent.during) await agent.during(input, hooks);
      return { candidate: agent.build ? agent.build(input) : preflightCandidate([`meeting:${input.meeting.id}`]) };
    },
  };
  return agent;
}

async function execute(t: TestApp, cookie: string, actionId: string, input?: unknown) {
  return t.app.inject({ method: "POST", url: "/api/actions/execute", headers: { cookie, origin: t.publicOrigin }, payload: { actionId, input } });
}

async function actionOf(t: TestApp, cookie: string, url: string, actionType: string): Promise<string> {
  const res = await t.app.inject({ method: "GET", url, headers: { cookie } });
  const descriptor = res.json().cards[0].actions.find((action: { actionType: string }) => action.actionType === actionType);
  expect(descriptor, `${url} 应提供 ${actionType}`).toBeTruthy();
  return descriptor.actionId as string;
}

async function importIssue(t: TestApp, externalId: string, battlefieldId = "growth"): Promise<string> {
  const issue = await t.app.inject({
    method: "POST",
    url: "/api/dri/issues",
    headers: { authorization: `Bearer ${t.env.driServiceToken}` },
    payload: {
      externalId, submitterPersonId: "person-fixture-002", title: `渠道投入是否转向华南（${externalId}）`,
      whyNow: "华南窗口六月关闭", sourceRef: `dri://test/${externalId}`, location: { level: "battlefield", battlefieldId: "growth" },
    },
  });
  expect(issue.statusCode).toBe(201);
  const issueId = issue.json().cards[0].objectRef.id as string;
  if (battlefieldId !== "growth") {
    await t.sql("UPDATE issues SET location = $2::jsonb WHERE id = $1", [issueId, JSON.stringify({ level: "battlefield", battlefieldId })]);
  }
  return issueId;
}

const outcomeItem = (id: string, text: string, status: "confirmed" | "pending", battlefieldIds: string[] | null) => ({
  id, kind: "decision", text, turnId: "t1", quote: text, speakerId: "person-fixture-001", ownerPersonId: null, issueId: null,
  judgmentKind: null, parentItemId: null, review: { status, effectRef: null }, ...(battlefieldIds ? { scope: { battlefieldIds } } : {}),
});

/** 直接写一场已开的会（导入的历史会议常常没挂议题）。 */
async function heldMeeting(t: TestApp, options: { title: string; at: string; issueIds?: string[]; leadDriId?: string;
  items?: ReturnType<typeof outcomeItem>[] }): Promise<string> {
  const id = randomUUID();
  const outcome = options.items ? { status: "ready", pendingSince: null, startedAt: null, runId: null, previousRunIds: [], error: null,
    summary: `${options.title}纪要`, items: options.items, warnings: [], extractedAt: options.at } : null;
  await t.sql(
    `INSERT INTO meetings (id, version, title, status, scheduled_at, ends_at, lead_dri_id, ceo_participant_id, participants, issue_ids, preflight, draft, origin_ref, transcript, outcome)
     VALUES ($1, 1, $2, 'held', $3, $3::timestamptz + interval '1 hour', $4, 'person-fixture-001', '[]'::jsonb, $5::jsonb,
             (SELECT preflight FROM meetings LIMIT 1), (SELECT draft FROM meetings LIMIT 1), '{}'::jsonb, $6::jsonb, $7::jsonb)`,
    [id, options.title, options.at, options.leadDriId ?? "person-fixture-003", JSON.stringify(options.issueIds ?? []),
      JSON.stringify({ schemaVersion: "warmap-transcript.v1", meetingId: id, turns: [{ id: "t1", speakerId: "person-fixture-001", text: "先验证渠道窗口" }] }),
      outcome ? JSON.stringify(outcome) : null],
  );
  return id;
}

async function scheduleMeeting(t: TestApp, issueId: string) {
  const cookie = await t.loginCookie();
  const created = await execute(t, cookie, await actionOf(t, cookie, `/api/cards/issues/${issueId}`, "issue.create_meeting"), { ...MEETING_INPUT, issueIds: [issueId] });
  expect(created.statusCode).toBe(200);
  return { cookie, meetingId: created.json().cards[0].objectRef.id as string };
}

describe("会前预审 v4：历史会议按战场找", () => {
  it("没挂议题的同战场会议（会后条目写了作用范围）也接得上；已确认与待确认分层；别的战场不进来；共享议题与同战场去重", async () => {
    const agent = hookedAgent();
    const t = await createTestApp({}, undefined, { preflightAgent: agent });
    try {
      const issueId = await importIssue(t, "bf-history");
      const otherIssue = await importIssue(t, "bf-other", "other-field");
      // 第一场预审要有一份 preflight / draft 模板可抄：先建本次会议，再插历史会议，最后重新预审。
      const { cookie, meetingId } = await scheduleMeeting(t, issueId);
      const strategy = await heldMeeting(t, { title: "增长战场业务战略会", at: "2026-05-12T02:00:00Z", items: [
        outcomeItem("d1", "渠道投入以华东存量客户为主线", "confirmed", ["growth"]),
        outcomeItem("d2", "华南只做轻量试点，不得变成单纯价格战", "pending", ["growth"]),
        outcomeItem("d3", "已忽略的条目", "pending", ["growth"]),
      ] });
      await t.sql("UPDATE meetings SET outcome = jsonb_set(outcome, '{items,2,review,status}', '\"dismissed\"') WHERE id = $1", [strategy]);
      const shared = await heldMeeting(t, { title: "渠道投入初议", at: "2026-05-20T02:00:00Z", issueIds: [issueId] });
      await heldMeeting(t, { title: "别的战场的会", at: "2026-05-25T02:00:00Z", issueIds: [otherIssue] });
      await heldMeeting(t, { title: "一年前的会", at: "2025-03-01T02:00:00Z", items: [outcomeItem("x", "旧决定", "confirmed", ["growth"])] });

      const regenerate = await execute(t, cookie, await actionOf(t, cookie, `/api/cards/meetings/${meetingId}`, "meeting.regenerate_preflight"), {});
      expect(regenerate.statusCode).toBe(200);
      const input = agent.calls.at(-1)!;
      expect(input.scope.battlefields.map((battlefield) => battlefield.id)).toEqual(["growth"]);
      expect(input.relatedMeetings.map((meeting) => meeting.title)).toEqual(["渠道投入初议", "增长战场业务战略会"]);
      const [sharedMeeting, strategyMeeting] = input.relatedMeetings;
      expect(sharedMeeting.id).toBe(shared);
      // 共享议题的会同时也在同一战场：只出现一次，两条路径都记下。
      expect(sharedMeeting.matchedBy).toEqual(expect.arrayContaining(["shared_issue", "battlefield"]));
      expect(strategyMeeting.matchedBy).toEqual(["battlefield"]);
      expect(strategyMeeting.confirmedDecisions).toEqual([expect.objectContaining({ ref: `outcome:${strategy}#d1`, text: "渠道投入以华东存量客户为主线" })]);
      expect(strategyMeeting.pendingDecisions.map((decision) => decision.ref)).toEqual([`outcome:${strategy}#d2`]);
      expect(input.inputCoverage.relatedMeeting).toBe("available");

      // 会后条目引用在白名单里：预审引用 7/12 那类会的决定不会被判成非法来源。
      agent.build = (next) => preflightCandidate([`outcome:${strategy}#d1`, `issue:${next.issues[0].id}`]);
      const again = await execute(t, cookie, await actionOf(t, cookie, `/api/cards/meetings/${meetingId}`, "meeting.regenerate_preflight"), {});
      expect(again.statusCode).toBe(200);
      const payload = again.json().cards[0].payload;
      expect(Value.Check(MeetingCardPayload, payload)).toBe(true);
      expect(payload.preflight.status).toBe("ready");
      expect(payload.preflight.inputCoverage.evidence.relatedMeetings).toEqual([
        expect.objectContaining({ id: shared, matchedBy: expect.arrayContaining(["shared_issue"]) }),
        expect.objectContaining({ id: strategy, matchedBy: ["battlefield"], confirmedDecisions: 1, pendingDecisions: 1 }),
      ]);
      expect(payload.preflight.inputCoverage.evidence.decisionRefs).toContain(`outcome:${strategy}#d1`);
    } finally {
      await t.close();
    }
  });

  it("没挂议题、也没写作用范围的会：主持人是战场负责人时算同战场；同战场其他议题的有效决定一并带上", async () => {
    const agent = hookedAgent();
    const t = await createTestApp({}, undefined, { preflightAgent: agent });
    try {
      await t.sql("UPDATE battlefield_config SET owner_id = 'person-fixture-002' WHERE id = 'growth'");
      const issueId = await importIssue(t, "bf-owner");
      const sibling = await importIssue(t, "bf-sibling");
      const receiptId = randomUUID();
      await t.sql("UPDATE issues SET status = 'decided', receipts = $2::jsonb WHERE id = $1", [sibling, JSON.stringify([{
        id: receiptId, actionType: "issue.decide", actionFingerprint: "fp", effectRef: `issue:${sibling}`, decisionText: "华东续约优先",
        researchStatusAtDecision: "ready", override: false, createdAt: "2026-05-10T02:00:00.000Z" }])]);
      const { cookie, meetingId } = await scheduleMeeting(t, issueId);
      const owned = await heldMeeting(t, { title: "负责人主持的战略会", at: "2026-05-18T02:00:00Z", leadDriId: "person-fixture-002" });
      await heldMeeting(t, { title: "别人主持的会", at: "2026-05-19T02:00:00Z", leadDriId: "person-fixture-003" });
      await execute(t, cookie, await actionOf(t, cookie, `/api/cards/meetings/${meetingId}`, "meeting.regenerate_preflight"), {});
      const input = agent.calls.at(-1)!;
      expect(input.relatedMeetings.map((meeting) => meeting.id)).toEqual([owned]);
      expect(input.battlefieldDecisions).toEqual([expect.objectContaining({ ref: `decision:${receiptId}`, issueId: sibling, text: "华东续约优先" })]);
    } finally {
      await t.close();
    }
  });
});

describe("会前预审 v4：过程可见", () => {
  it("每一步按实际发生的顺序写进库，运行中刷新能读到，完成后保留并记下模型", async () => {
    const agent = hookedAgent();
    agent.model = { id: "test-sol", thinking: "high" };
    let midRun: TPreflightProgress | undefined;
    let midStatus: string | undefined;
    const t = await createTestApp({}, undefined, { preflightAgent: agent });
    try {
      const issueId = await importIssue(t, "progress-order");
      const { cookie, meetingId } = await scheduleMeeting(t, issueId);
      agent.during = async (input, hooks) => {
        const emit = hooks!.onEvent!;
        emit({ type: "thinking_start" });
        emit({ type: "thinking_delta", delta: "**对照历史决定与材料里的待决题**\n" });
        emit({ type: "tool_start", toolCallId: "c1", name: "search_sections", args: { query: "增长战场 责任边界" } });
        emit({ type: "tool_end", toolCallId: "c1", name: "search_sections", isError: false,
          result: { content: [{ type: "text", text: JSON.stringify({ results: [{ id: "a#s1", title: "增长战场的责任边界" }] }) }] } });
        emit({ type: "tool_args", name: "submit_candidate", args: { taskDefinition: {}, readiness: "revise", materialQuestions: { total: 2, items: [
          { question: "是否转向华南", verdict: "ceo", reason: "跨战场预算" }] } } });
        emit({ type: "tool_args", name: "submit_candidate", args: { taskDefinition: {}, readiness: "revise", materialQuestions: { total: 2, items: [
          { question: "是否转向华南", verdict: "ceo", reason: "跨战场预算" }, { question: "首批渠道选谁", verdict: "owner", reason: "负责人可定" }] },
          entries: [{ kind: "core_judgment", title: "先定渠道主线" }, { kind: "meeting_question", title: "华南是否转向" }] } });
        // 节流写库之后再读一次卡片：运行中的进度已经在库里。
        await new Promise((resolve) => setTimeout(resolve, 900));
        const res = await t.app.inject({ method: "GET", url: `/api/cards/meetings/${meetingId}`, headers: { cookie } });
        midStatus = res.json().cards[0].payload.preflight.status;
        midRun = res.json().cards[0].payload.preflight.progress;
        void input;
      };
      const regenerate = await execute(t, cookie, await actionOf(t, cookie, `/api/cards/meetings/${meetingId}`, "meeting.regenerate_preflight"), {});
      expect(regenerate.statusCode).toBe(200);

      expect(midStatus).toBe("running");
      expect(midRun!.finishedAt).toBeUndefined();
      expect(midRun!.thought).toBe("对照历史决定与材料里的待决题");
      const midLabels = midRun!.steps.map((step) => step.label);
      expect(midLabels).toContain("已查找企业知识「增长战场 责任边界」");
      expect(midLabels).toContain("第 1 题「是否转向华南」：需要一号位判断");
      expect(midLabels).toContain("第 2 题「首批渠道选谁」：负责人职责内可定");
      expect(midLabels).toContain("已形成核心判断：先定渠道主线");

      const payload = regenerate.json().cards[0].payload;
      expect(Value.Check(MeetingCardPayload, payload)).toBe(true);
      const progress = payload.preflight.progress as TPreflightProgress;
      expect(progress.finishedAt).toBeTruthy();
      expect(progress.thought).toBeUndefined();
      expect(progress.steps.every((step) => step.state === "done")).toBe(true);
      const keys = progress.steps.map((step) => step.key);
      // 顺序：读取输入 → 开始分析 → 企业知识 → 写结论 → 待决题 → 条目 → 核对。
      const order = ["collect", "analysis", "knowledge:1", "compose", "material_questions", "material_question:1", "material_question:2", "entry:1", "check"];
      expect(order.map((key) => keys.indexOf(key))).toEqual([...order.map((key) => keys.indexOf(key))].sort((a, b) => a - b));
      expect(order.every((key) => keys.includes(key))).toBe(true);
      expect(progress.steps.find((step) => step.key === "material_questions")!.label).toBe("已逐条判断材料自带的 2 道待决题：1 道需要一号位判断，1 道负责人可定");
      expect(progress.steps.find((step) => step.key === "check")!.label).toBe("已核对引用和结构");
      expect(payload.preflight.model).toEqual({ id: "test-sol", thinking: "high" });
      // 时间点单调：每一步的出现时间不早于前一步。
      const times = progress.steps.map((step) => Date.parse(step.at));
      expect(times).toEqual([...times].sort((a, b) => a - b));
    } finally {
      await t.close();
    }
  });

  it("失败时过程照样保留，最后一步写明没有完成；重新预审从头记，不带上一次的步骤", async () => {
    const agent = hookedAgent();
    const t = await createTestApp({}, undefined, { preflightAgent: agent });
    try {
      const issueId = await importIssue(t, "progress-fail");
      const { cookie, meetingId } = await scheduleMeeting(t, issueId);
      agent.during = async () => { throw new Error("model unreachable"); };
      const failed = await execute(t, cookie, await actionOf(t, cookie, `/api/cards/meetings/${meetingId}`, "meeting.regenerate_preflight"), {});
      const preflight = failed.json().cards[0].payload.preflight;
      expect(preflight.status).toBe("failed");
      expect(preflight.progress.steps.at(-1)).toMatchObject({ key: "failed", label: "预审没有完成", detail: "model unreachable" });
      agent.during = undefined;
      const retried = await execute(t, cookie, await actionOf(t, cookie, `/api/cards/meetings/${meetingId}`, "meeting.retry_preflight"), {});
      const ready = retried.json().cards[0].payload.preflight;
      expect(ready.status).toBe("ready");
      expect(ready.progress.steps.map((step: { key: string }) => step.key)).not.toContain("failed");
    } finally {
      await t.close();
    }
  });

  it("候选写作的进度只在一项写完之后计数：待决题第几道、会议问题第几条", () => {
    const writes: TPreflightProgress[] = [];
    const recorder = new PreflightProgressRecorder(async (progress) => { writes.push(progress); }, () => new Date("2026-10-13T00:00:00Z"), 0);
    const onCandidate = createCandidateProgress(recorder).candidate;
    onCandidate({ readiness: "revise", materialQuestions: { total: 5, items: [{ question: "第一题", verdict: "ceo", reason: "跨战场" }] } });
    expect(recorder.snapshot().steps.find((step) => step.key === "material_questions")!.label).toBe("正在逐条判断材料自带的 5 道待决题（0/5）");
    onCandidate({ readiness: "revise", materialQuestions: { total: 5, items: [{ question: "第一题", verdict: "ceo", reason: "跨战场" }, { question: "第二" }] } });
    expect(recorder.snapshot().steps.find((step) => step.key === "material_questions")!.label).toBe("正在逐条判断材料自带的 5 道待决题（1/5）");
    onCandidate({ readiness: "revise", materialQuestions: { total: 5, items: [{ question: "第一题", verdict: "ceo", reason: "跨战场" }] },
      entries: [{ kind: "meeting_question", title: "华南是否转向" }] }, true);
    const labels = recorder.snapshot().steps.map((step) => step.label);
    expect(labels).toContain("已形成会议问题：华南是否转向");
    expect(labels).toContain("已形成 1 条判断与建议，其中会议问题 1 条");
  });

  it("阶段性结论工具：待决题先于最终候选显示（total 写在后面也能计数）；历史对照写出是哪一条决定", () => {
    const recorder = new PreflightProgressRecorder(async () => undefined, () => new Date("2026-10-13T00:00:00Z"), 0);
    const refLabels = new Map([["outcome:m1#d4", "技术型 FDE 保持轻团队，不得演变为单纯 Token 转售"]]);
    const handler = createAgentProgressHandler(recorder, { refLabels });
    const label = (key: string) => recorder.snapshot().steps.find((step) => step.key === key)?.label;
    handler({ type: "tool_args", name: "report_material_questions", args: { items: [{ question: "首批上游选谁", verdict: "owner", reason: "负责人可定" }, { question: "房懂懂" }] } });
    expect(label("material_questions")).toBe("正在逐条判断材料自带的待决题（已判断 1 道）");
    expect(label("material_question:1")).toBe("第 1 题「首批上游选谁」：负责人职责内可定");
    handler({ type: "tool_args", name: "report_material_questions", final: true, args: { items: [
      { question: "首批上游选谁", verdict: "owner", reason: "负责人可定" }, { question: "房懂懂 001 是否验证国产路线", verdict: "ceo", reason: "跨战场" }], total: 2 } });
    expect(label("material_questions")).toBe("已逐条判断材料自带的 2 道待决题：1 道需要一号位判断，1 道负责人可定");
    expect(label("compose")).toBeUndefined();
    handler({ type: "tool_args", name: "report_history_check", final: true, args: { checks: [
      { ref: "outcome:m1#d4", relation: "tension", note: "材料把交易分发放在近期重点" }] } });
    expect(label("history_check:1")).toBe("「技术型 FDE 保持轻团队，不得演变为单纯 Token 转售」：存在张力");
    expect(recorder.snapshot().steps.find((step) => step.key === "history_check:1")!.detail).toBe("材料把交易分发放在近期重点");
    expect(label("history_checks")).toBe("已对照 1 条历史决定：存在张力 1");
    // 阶段性结论交完：显示在权衡取舍；最终候选里重复的待决题不会把已完成的进度拉回去。
    handler({ type: "tool_end", toolCallId: "r2", name: "report_history_check", isError: false, result: {} });
    expect(recorder.snapshot().steps.find((step) => step.key === "deliberate")).toMatchObject({ state: "active", label: "正在权衡取舍，形成会议问题、一号位追问与开放分歧" });
    handler({ type: "tool_args", name: "submit_candidate", args: { materialQuestions: { total: 2, items: [{ question: "首批上游选谁" }] } } });
    expect(label("material_questions")).toBe("已逐条判断材料自带的 2 道待决题：1 道需要一号位判断，1 道负责人可定");
    expect(recorder.snapshot().steps.find((step) => step.key === "deliberate")!.state).toBe("done");
    expect(label("compose")).toBe("正在写出预审结论");
  });

  it("思考要点只上中文；英文小标题交给翻译，带称呼或运行环境字眼的不上屏", async () => {
    expect(cleanThought("Assessing the upstream partners")).toBeUndefined();
    expect(cleanThought("核对上游合作条件")).toBe("核对上游合作条件");
    expect(cleanThought(String.fromCharCode(0x738b, 0x603b) + "关心的取舍")).toBeUndefined();
    const recorder = new PreflightProgressRecorder(async () => undefined, () => new Date(), 0);
    const handler = createAgentProgressHandler(recorder, { translate: async () => "比较上游合作方式" });
    handler({ type: "thinking_delta", delta: "**Comparing upstream partnership models**\n" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(recorder.snapshot().thought).toBe("比较上游合作方式");
  });

  it("Claude 的思考摘要没有小标题：写完一段才把这一段的第一句交给翻译，还在写的那段不译", async () => {
    expect(latestParagraphLead("I need to weigh the upstream options. Then")).toBeUndefined();
    expect(latestParagraphLead("I need to weigh the upstream options. Then more.\n\nNext")).toBe("I need to weigh the upstream options.");
    const asked: string[] = [];
    const recorder = new PreflightProgressRecorder(async () => undefined, () => new Date(), 0);
    const handler = createAgentProgressHandler(recorder, { translate: async (text) => { asked.push(text); return "权衡上游合作的几种做法"; } });
    handler({ type: "thinking_start" });
    handler({ type: "thinking_delta", delta: "Let me weigh whether the upstream partnership should stay multi-vendor. " });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(asked).toEqual([]);
    handler({ type: "thinking_delta", delta: "That matters for the boundary.\n\nNow the history check" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(asked).toEqual(["Let me weigh whether the upstream partnership should stay multi-vendor."]);
    expect(recorder.snapshot().thought).toBe("权衡上游合作的几种做法");
  });
});

describe("会前预审 v4：提示词", () => {
  it("没有凑数要求：条目只有上限，没有「至少几条」「每类都要」之类的数量要求", () => {
    // 唯一的「至少」是会议问题的可选路径（一道取舍至少两条路），不是条目数量。
    const optionRule = `meeting_question 至少 ${MEETING_QUESTION_MIN_OPTIONS} 条`;
    const rest = PREFLIGHT_PROMPT.replace(optionRule, "").replace("至少两条可行路径", "");
    expect(rest).not.toMatch(/(至少|不少于|最少|不得少于|起码)\s*[0-9一二两三四五六七八九十]+\s*[条个道处项]/);
    expect(rest).not.toMatch(/凑满|凑齐|补足.{0,4}条|每类(都)?(至少|必须)/);
    expect(PREFLIGHT_PROMPT).toContain("数量没有下限");
    expect(PREFLIGHT_PROMPT).toContain("宁缺毋滥，不为凑数造问题");
    expect(PREFLIGHT_PROMPT).toContain("没有真实分歧就不写，不为凑类别编造");
  });

  it("逐条判断材料自带的待决题、分歧三类、追问写出不同回答的含义、近期会议分层", () => {
    for (const text of ["必须逐条判断，写进 materialQuestions", "ceo 是需要一号位判断", "owner 是负责人职责内可以定", "monitor 是事实还不够",
      "fact_gap 是事实不足", "judgment 是判断分歧", "value_tradeoff 是价值取舍", "可能得到的两三种回答", "impact 写这种回答意味着什么",
      "pendingDecisions 是会后候选，尚未经一号位确认", "battlefield 同一战场", "企业披露、待核验"]) {
      expect(PREFLIGHT_PROMPT).toContain(text);
    }
  });

  it("思考强度可配置，不认识的值回到 high", () => {
    expect(preflightThinkingLevel(undefined)).toBe("high");
    expect(preflightThinkingLevel("medium")).toBe("medium");
    expect(preflightThinkingLevel("XHIGH")).toBe("xhigh");
    expect(preflightThinkingLevel("max")).toBe("high");
  });
});

describe("预审过程里的材料名", () => {
  it("只写原始标题，不带资料包文字层抽取件的内部后缀「（PDF 文字版）.md」", () => {
    const label = materialStepLabel({ fileName: "FireworksAI_国内对标分析_V2（PDF 文字版）.md", version: 1, state: "readable", truncated: false, paragraphCount: 315 } as never);
    expect(label).toBe("已读取《FireworksAI_国内对标分析_V2》第 1 版，共 315 段");
    expect(materialStepLabel({ fileName: "交付周报.md", version: 2, state: "readable", truncated: false, paragraphCount: 3 } as never)).toBe("已读取《交付周报.md》第 2 版，共 3 段");
  });
});
