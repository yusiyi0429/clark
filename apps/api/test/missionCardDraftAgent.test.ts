import { describe, expect, it } from "vitest";
import type { Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { createAssistantMessageEventStream, type Context } from "@earendil-works/pi-ai";
import { createMissionCardDraftAgent, MissionCardDraftCandidate, MissionCardDraftQualityError, MissionCardDraftQualityReview,
  type MissionCardDraftCandidateValue, type MissionCardDraftInput } from "../src/missionCardDraftAgent.js";
import { MISSION_CARD_WRITING_BASIS_SOURCE } from "../src/missionCardWritingRules.js";
import { createTestDb } from "./helpers.js";
import { migrate } from "../src/migrate.js";

const input: MissionCardDraftInput = {
  period: "2026-10", owner: { personId: "sun-mingze", displayName: "孙铭泽" },
  battlefield: { id: "product", code: "01", name: "产品闭环", sixMonthOutcome: "双身份下的产品工作闭环可复用", missionAnchors: ["可复核的界面与权限证据"] },
  plan: { companyOutcome: "业务判断和真实结果可复核", monthOutcome: "验证 CEO 与 DRI 共用身份时的界面与权限闭环", signedAt: "2026-09-30T02:00:00Z" },
  previousCard: null, previousReview: null, capabilities: [{ code: "product", name: "产品验证" }],
  companyMemory: [{ title: "双身份评审试点",
    text: "当前已出现双身份界面与权限分界，需要建立真实任务卡里的可复核评审机制。Demo、手册、Workshop是可能的观察载体，但验收应判断真实环境的判断、行为和结果；交付时间、阈值和资源尚未确定。" }],
  knownMissions: [],
};
const mission: MissionCardDraftCandidateValue["missions"][number] = {
  capabilityCode: "product", title: "双身份评审机制可复用",
  why: "为签发的双身份界面与权限闭环目标提供可复核的评审机制；删掉这场战役，真实任务卡中权限分界与判断结果仍缺验证依据。",
  outcome: "CEO 与 DRI 共用身份时，界面与权限评审机制能在真实任务卡中复用，权限分界与实际判断结果可复核。",
  successEvidence: ["在真实任务卡中复用评审机制，能依据记录复核身份与权限分界以及实际判断、行为和结果；Demo 或 Workshop 仅作为观察载体，核验场景与判定口径待确认。"],
  boundaries: "负责双身份评审机制及界面与权限闭环核验；不负责公司战略或分派其他成员任务，涉及其他对象的具体交接分界待确认。",
  timeBoundary: "待确认：本月内真正影响评审责任成立的窗口和交接条件，尚无具体起止日期依据。",
  keyPath: "从现有双身份界面与权限分界出发，先明确哪些判断能够核验，再验证机制在真实任务卡中成立，最后判断它是否可复用。",
  tradeoffs: "待确认：评审范围、验证深度与速度之间怎样选择，以及暂缓范围带来的代价。",
  milestones: ["待确认 · 真实任务卡中的权限分界可核验", "待确认 · 评审机制能在真实任务卡中复用，责任关联尚待明确"],
  resources: "", dependencies: "待确认：实质影响评审机制验证成立的访问与证据条件。",
  humanAgentSplit: "", risk: "", retrospect: "",
  basis: "签发的双身份闭环本月目标、战场长期目标及双身份评审试点认知；时间、取舍、阈值、资源和具体交接分界待确认。",
};
const draft = (patch: Partial<typeof mission> = {}): MissionCardDraftCandidateValue => ({ missions: [{ ...mission, ...patch }] });

function review(candidate: MissionCardDraftCandidateValue): Static<typeof MissionCardDraftQualityReview> {
  return { checks: candidate.missions.map((m, missionIndex) => ({ missionIndex, assessments: {
    name: { passed: true, excerpt: m.title, reason: "名称明确识别双身份评审机制这场战役。", correction: null },
    result: { passed: true, excerpt: m.outcome, reason: "最终状态是机制可复用且判断结果可复核，能独立判断成立。", correction: null },
    necessity: { passed: true, excerpt: m.why, reason: "明确链接签发目标并说明删除后的结果缺口。", correction: null },
    evidence: { passed: true, excerpt: m.successEvidence[0], reason: "观察真实判断、行为和结果；Demo和Workshop仅作载体，未拿活动数量验收。", correction: null },
    boundary: { passed: true, excerpt: m.boundaries, reason: "给出负责与不负责范围，未确定交接边界明确待确认。", correction: null },
    timeBoundary: { passed: true, excerpt: m.timeBoundary, reason: "来源未提供具体责任窗口，候选明确留下要确认的窗口与条件，未编日期。", correction: null },
    tradeoffs: { passed: true, excerpt: m.tradeoffs, reason: "识别范围、验证深度与速度的主动取舍及代价，需要决策的缺口明确待确认。", correction: null },
    plan: { passed: true, excerpt: m.keyPath, reason: "路径停留在从现状到机制成立与复用的主逻辑，没有下钻Activity。", correction: null },
    milestone: { passed: true, excerpt: m.milestones[0], reason: "里程碑是战役状态且无无依据日期。", correction: null },
    grounding: { passed: true, excerpt: m.basis, reason: "对照签发目标和双身份评审试点，具体时间、阈值与资源没有依据而明确待确认。", correction: null },
    scope: { passed: true, excerpt: m.keyPath, reason: "这是一场必要战役，没有强凑第二Mission或Task全景。", correction: null },
  } })) };
}

function stream(candidate: unknown) {
  const events = createAssistantMessageEventStream();
  queueMicrotask(() => events.push({ type: "done", reason: "toolUse", message: {
    role: "assistant", api: "openai-responses", provider: "warmap", model: "fake-heavy",
    content: [{ type: "toolCall", id: "submit-1", name: "submit_candidate", arguments: candidate as Record<string, unknown> }],
    stopReason: "toolUse", timestamp: Date.now(), usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  } }));
  return events;
}
function agent(query: Parameters<typeof createMissionCardDraftAgent>[0]["query"], outputs: unknown[]) {
  const contexts: Context[] = [];
  const instance = createMissionCardDraftAgent({ query, baseUrl: "https://provider.invalid/v1/responses", apiKey: "test", modelId: "fake-heavy",
    streamSimple: (_model, context) => {
      contexts.push(context);
      if (!outputs.length) throw new Error("unexpected extra model call");
      expect(context.tools?.map((tool) => tool.name)).toEqual(["submit_candidate"]);
      return stream(outputs.shift());
    } });
  return { instance, contexts };
}

describe("TKOS Mission Card 起草与内容质量门槛", () => {
  it("结构与实际写入限制对齐，单场战役可成立，新时间与取舍字段必填，扩展可空", () => {
    expect(Value.Check(MissionCardDraftCandidate, draft())).toBe(true);
    expect(Value.Check(MissionCardDraftCandidate, draft({ title: "名".repeat(201) }))).toBe(false);
    expect(Value.Check(MissionCardDraftCandidate, draft({ successEvidence: ["证".repeat(501)] }))).toBe(false);
    expect(Value.Check(MissionCardDraftCandidate, draft({ milestones: ["态".repeat(501)] }))).toBe(false);
    expect(Value.Check(MissionCardDraftCandidate, draft({ why: " " }))).toBe(false);
    expect(Value.Check(MissionCardDraftCandidate, { missions: [] })).toBe(false);
    expect(Value.Check(MissionCardDraftCandidate, { missions: Array.from({ length: 5 }, () => mission) })).toBe(false);
    expect(Value.Check(MissionCardDraftCandidate, { missions: [{ ...mission, ownerId: "invented-dri" }] })).toBe(false);
    const { timeBoundary: _time, ...withoutTime } = mission;
    const { tradeoffs: _tradeoffs, ...withoutTradeoffs } = mission;
    expect(Value.Check(MissionCardDraftCandidate, { missions: [withoutTime] })).toBe(false);
    expect(Value.Check(MissionCardDraftCandidate, { missions: [withoutTradeoffs] })).toBe(false);
  });

  it("真实结果机制可以用Demo或Workshop作载体，独立逐项审阅通过后返回真实审阅记录", async () => {
    await createTestDb(async ({ db }) => {
      await migrate(db);
      const candidate = draft(), { instance, contexts } = agent(db.query.bind(db), [candidate, review(candidate)]);
      const result = await instance.generate(input);
      expect(result.candidate).toEqual(candidate);
      expect(result.reviewRunIds).toHaveLength(1);
      expect(result.draftRunIds).toEqual([result.runId]);
      expect(result.basisSource).toBe(MISSION_CARD_WRITING_BASIS_SOURCE);
      expect(contexts).toHaveLength(2);
      expect(contexts[0].systemPrompt).toContain("1 到 4 场真实成立");
      expect(contexts[0].systemPrompt).toContain("不能把 signedAt 当交付日");
      expect(contexts[0].systemPrompt).not.toContain("日期开头");
      expect(contexts[1].systemPrompt).toContain("独立内容审阅");
      expect(JSON.stringify(contexts[1].messages)).toContain("双身份评审试点");
      const rows = (await db.query("SELECT id,kind,input_snapshot,candidate_output FROM agent_runs ORDER BY started_at,id")).rows;
      expect(rows).toHaveLength(2);
      const assessment = rows.find((row) => row.kind === "mission-card-draft-check");
      expect(assessment.id).toBe(result.reviewRunIds![0]);
      expect(assessment.input_snapshot.draft).toEqual(candidate);
      expect(assessment.candidate_output.checks[0].assessments.evidence.reason).toContain("真实判断");
    });
  });

  it("拒绝把活动交付当结果，带具体字段与改法修一次再独立审阅；不会默认补第二Mission", async () => {
    await createTestDb(async ({ db }) => {
      await migrate(db);
      const bad = draft({ outcome: "完成手册、Demo、培训", successEvidence: ["交付3份材料并举办2次Workshop"] });
      const failed = review(bad);
      failed.checks[0].assessments.result = { passed: false, excerpt: bad.missions[0].outcome,
        reason: "动作交付不能独立判定战役结果。", correction: "改为评审机制在真实任务卡可复用以及判断结果可复核的最终状态。" };
      failed.checks[0].assessments.evidence = { passed: false, excerpt: bad.missions[0].successEvidence[0],
        reason: "活动数量没有依据，也不能代表真实结果成立。", correction: "改用真实判断、行为和结果的核验；阈值和场景缺依据时写待确认。" };
      const good = draft(), { instance, contexts } = agent(db.query.bind(db), [bad, failed, good, review(good)]);
      const result = await instance.generate(input);
      expect(result.candidate).toEqual(good);
      expect(result.reviewRunIds).toHaveLength(2);
      expect(result.draftRunIds).toHaveLength(2);
      expect(contexts).toHaveLength(4);
      expect(JSON.stringify(contexts[2].messages)).toContain("missions[0].outcome");
      expect(JSON.stringify(contexts[2].messages)).toContain("阈值和场景缺依据时写待确认");
      expect((await db.query("SELECT count(*)::int AS n FROM agent_runs")).rows[0].n).toBe(4);
    });
  });

  it("审阅引用必须是当前字段真实原文；伪造逐项通过也不能绕过质量门槛，最多修一次", async () => {
    await createTestDb(async ({ db }) => {
      await migrate(db);
      const candidate = draft(), fabricated = review(candidate);
      fabricated.checks[0].assessments.result.excerpt = "在真实客户上线后，转化率提升50%";
      const { instance, contexts } = agent(db.query.bind(db), [candidate, fabricated, candidate, fabricated]);
      let failure: unknown;
      try { await instance.generate(input); } catch (cause) { failure = cause; }
      expect(failure).toBeInstanceOf(MissionCardDraftQualityError);
      expect((failure as MissionCardDraftQualityError).message).toContain("审阅依据不是这项 Mission 的原文片段");
      expect((failure as MissionCardDraftQualityError).reviewRunIds).toHaveLength(2);
      expect((failure as MissionCardDraftQualityError).basisSource).toBe(MISSION_CARD_WRITING_BASIS_SOURCE);
      expect(contexts).toHaveLength(4);
    });
  });

  it("真实来源不支持具体时间时拒绝编造日期；重复/遗漏Mission的审阅不能放行", async () => {
    await createTestDb(async ({ db }) => {
      await migrate(db);
      const invented = draft({ timeBoundary: "10/12 完成交付", milestones: ["10/12 评审机制可复用"] }), failed = review(invented);
      failed.checks[0].assessments.grounding = { passed: false, excerpt: invented.missions[0].timeBoundary,
        reason: "输入只提供period与signedAt，不支持10/12交付日期。", correction: "保留已知本月周期；真正影响责任的起止与交接条件写具体待确认，不借签发时间造日期。" };
      const good = { missions: [mission, { ...mission, title: "权限判断证据可复核" }] }, incomplete = review(good);
      incomplete.checks[1].missionIndex = 0;
      const { instance, contexts } = agent(db.query.bind(db), [invented, failed, good, incomplete]);
      await expect(instance.generate(input)).rejects.toThrow("质量审阅遗漏或重复 Mission");
      expect(JSON.stringify(contexts[2].messages)).toContain("不支持10/12交付日期");
      expect(contexts).toHaveLength(4);
    });
  });

  it("调用前已取消则不开始模型或留下伪成功候选", async () => {
    let queries = 0;
    const query = async () => { queries++; return { rows: [], rowCount: 0, command: "", oid: 0, fields: [] }; };
    const { instance, contexts } = agent(query, []);
    const abort = new AbortController(); abort.abort();
    await expect(instance.generate(input, abort.signal)).rejects.toBeInstanceOf(MissionCardDraftQualityError);
    expect(queries).toBe(0); expect(contexts).toHaveLength(0);
  });

  it("审阅刚结束时上游取消也不返回可用候选，保留起草和审阅的完整记录", async () => {
    await createTestDb(async ({ db }) => {
      await migrate(db);
      const controller = new AbortController();
      let reviewerRunId: unknown;
      const query: Parameters<typeof createMissionCardDraftAgent>[0]["query"] = async (sql, params) => {
        const result = await db.query(sql, params);
        if (/INSERT INTO agent_runs/.test(sql) && params?.[1] === "mission-card-draft-check") reviewerRunId = params[0];
        if (/UPDATE agent_runs/.test(sql) && params?.[0] === reviewerRunId) controller.abort();
        return result;
      };
      const candidate = draft(), { instance, contexts } = agent(query, [candidate, review(candidate)]);
      let failure: unknown;
      try { await instance.generate(input, controller.signal); } catch (cause) { failure = cause; }
      expect(failure).toBeInstanceOf(MissionCardDraftQualityError);
      expect((failure as MissionCardDraftQualityError).draftRunIds).toHaveLength(1);
      expect((failure as MissionCardDraftQualityError).reviewRunIds).toEqual([reviewerRunId]);
      expect(contexts).toHaveLength(2);
      expect((await db.query("SELECT count(*)::int AS n FROM agent_runs")).rows[0].n).toBe(2);
    });
  });
});
