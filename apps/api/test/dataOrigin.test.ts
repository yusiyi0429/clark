import { describe, expect, it } from "vitest";
import { Value } from "@sinclair/typebox/value";
import { BattlefieldCardPayload } from "@warmap/contracts";
import { createTestApp, preflightCandidate, type TestApp } from "./helpers.js";
import type { PreflightAgent, PreflightAgentInput } from "../src/meetingPreflight.js";
import { ISSUE_AI_SUGGESTED_ORIGIN, issueOriginFields } from "../src/dataOrigin.js";
import { globalConversationContext } from "../src/conversationContext.js";
import { listBattlefieldCards } from "../src/battlefields.js";
import { SYSTEM_PROMPT } from "../src/piConversationRuntime.js";
import { PREFLIGHT_PROMPT } from "../src/preflightAgent.js";

// 数据来源性质（方法团队 10/12 规则；反馈会议后界面不再标「AI 建议」「模拟」）：AI 候选议题、模拟指标、建议原则的性质字段仍一路带到 API 与 Agent 上下文；
// Agent 不在回答里标注这些来源，没有性质字段的旧数据一项都不多。

describe("数据来源标注：投影", () => {
  it("议题来源字段只认 origin_ref.nature=ai_suggested", () => {
    expect(issueOriginFields({ nature: "ai_suggested", whyNow: "x" })).toEqual({ nature: "ai_suggested", origin: ISSUE_AI_SUGGESTED_ORIGIN });
    expect(issueOriginFields({ whyNow: "x" })).toEqual({});
    expect(issueOriginFields(null)).toEqual({});
    expect(issueOriginFields({ nature: "real" })).toEqual({});
  });

  it("正式提示词不带来源性质规则；预审提示词不要求写标注", () => {
    // 提示词里这几个标签只作为“不要写”的反例出现，不再有要求写明 / 标注的句子。
    for (const prompt of [PREFLIGHT_PROMPT, SYSTEM_PROMPT]) {
      expect(prompt).not.toMatch(/必须(?:说明|写明)[^。]{0,12}AI 建议/);
      expect(prompt).not.toMatch(/后面标「（模拟）」|注明「模拟数据」|标「模拟」/);
    }
    expect(SYSTEM_PROMPT).not.toContain("数据来源性质");
    expect(PREFLIGHT_PROMPT).toContain("nature=ai_suggested");
    expect(PREFLIGHT_PROMPT).toContain("不写「AI 建议」这类来源标注");
    expect(ISSUE_AI_SUGGESTED_ORIGIN).not.toContain("AI 建议");
  });
});

type RecordingAgent = PreflightAgent & { calls: PreflightAgentInput[] };
function recordingAgent(): RecordingAgent {
  const agent: RecordingAgent = {
    calls: [],
    async generate(input) {
      agent.calls.push(input);
      return { candidate: preflightCandidate([`meeting:${input.meeting.id}`]) };
    },
  };
  return agent;
}

async function importIssue(t: TestApp, externalId: string, title: string): Promise<string> {
  const res = await t.app.inject({
    method: "POST", url: "/api/dri/issues", headers: { authorization: `Bearer ${t.env.driServiceToken}` },
    payload: { externalId, submitterPersonId: "person-fixture-002", title, whyNow: "两家大单本月签约", sourceRef: `dri://test/${externalId}`,
      location: { level: "battlefield", battlefieldId: "growth" } },
  });
  expect(res.statusCode).toBe(201);
  return res.json().cards[0].objectRef.id as string;
}

async function actionOf(t: TestApp, cookie: string, url: string, actionType: string): Promise<string> {
  const res = await t.app.inject({ method: "GET", url, headers: { cookie } });
  const descriptor = res.json().cards[0].actions.find((action: { actionType: string }) => action.actionType === actionType);
  expect(descriptor).toBeTruthy();
  return descriptor.actionId as string;
}

describe("数据来源标注：API、Agent 上下文与会前预审", () => {
  it("AI 建议议题：议题卡、战场卡、首页对话上下文、预审输入都带来源；真实议题一项不多", async () => {
    const agent = recordingAgent();
    const t = await createTestApp({}, undefined, { preflightAgent: agent });
    try {
      const q = t.pool.query.bind(t.pool);
      const aiId = await importIssue(t, "origin-ai", "是否把验收清单前置到签约前");
      const realId = await importIssue(t, "origin-real", "是否调整研发排期");
      // 演示资料包导入时 importer 写的就是 origin_ref.nature（见 demo-api importer）。
      await t.sql(`UPDATE issues SET origin_ref = origin_ref || '{"nature":"ai_suggested"}'::jsonb WHERE id = $1`, [aiId]);
      const cookie = await t.loginCookie();

      const cardOf = async (id: string) => (await t.app.inject({ method: "GET", url: `/api/cards/issues/${id}`, headers: { cookie } })).json().cards[0];
      expect((await cardOf(aiId)).payload.nature).toBe("ai_suggested");
      expect("nature" in (await cardOf(realId)).payload).toBe(false);

      const battlefields = await listBattlefieldCards(q, "2026-10", new Map());
      const growth = battlefields.find((card) => card.objectRef.id === "growth")!;
      expect(Value.Check(BattlefieldCardPayload, growth.payload)).toBe(true);
      const pending = (growth.payload as { pendingIssues: { id: string; nature?: string }[] }).pendingIssues;
      expect(pending.find((issue) => issue.id === aiId)?.nature).toBe("ai_suggested");
      expect("nature" in pending.find((issue) => issue.id === realId)!).toBe(false);

      const context = await globalConversationContext(q, new Date("2026-10-11T02:00:00Z"));
      const contextIssues = context.pendingIssues as Record<string, unknown>[];
      expect(contextIssues.find((issue) => issue.id === aiId)).toMatchObject({ nature: "ai_suggested", origin: ISSUE_AI_SUGGESTED_ORIGIN });
      const real = contextIssues.find((issue) => issue.id === realId)!;
      expect("nature" in real || "origin" in real || "origin_ref" in real).toBe(false);

      // 关联 AI 建议议题的会议：预审输入里的议题带来源，提示词要求报告写明「AI 建议」。
      const created = await t.app.inject({
        method: "POST", url: "/api/actions/execute", headers: { cookie, origin: t.publicOrigin },
        payload: { actionId: await actionOf(t, cookie, `/api/cards/issues/${aiId}`, "issue.create_meeting"),
          input: { title: "交付周会", scheduledAt: "2026-10-20T10:00:00.000+08:00", leadDriId: "person-fixture-002", ceoParticipantId: "person-fixture-001",
            participants: ["person-fixture-002"], issueIds: [aiId, realId] } },
      });
      expect(created.statusCode).toBe(200);
      const meetingId = created.json().cards[0].objectRef.id as string;
      await t.app.inject({
        method: "POST", url: "/api/actions/execute", headers: { cookie, origin: t.publicOrigin },
        payload: { actionId: await actionOf(t, cookie, `/api/cards/meetings/${meetingId}`, "meeting.regenerate_preflight"), input: {} },
      });
      const input = agent.calls.at(-1)!;
      expect(input.issues.find((issue) => issue.id === aiId)).toMatchObject({ nature: "ai_suggested", origin: ISSUE_AI_SUGGESTED_ORIGIN });
      expect("nature" in input.issues.find((issue) => issue.id === realId)!).toBe(false);
    } finally {
      await t.close();
    }
  });

  it("雷达升级的 AI 建议议题：战场卡带 fromRadar；资料包导入的 AI 建议议题不带", async () => {
    const t = await createTestApp();
    try {
      const q = t.pool.query.bind(t.pool);
      const importedId = await importIssue(t, "origin-imported", "是否把验收清单前置到签约前");
      const radarId = await importIssue(t, "origin-radar", "是否跟进竞品降价");
      await t.sql(`UPDATE issues SET origin_ref = origin_ref || '{"nature":"ai_suggested"}'::jsonb WHERE id = ANY($1::uuid[])`, [[importedId, radarId]]);
      await t.sql(`UPDATE issues SET origin = 'radar' WHERE id = $1`, [radarId]);

      const growth = (await listBattlefieldCards(q, "2026-10", new Map())).find((card) => card.objectRef.id === "growth")!;
      expect(Value.Check(BattlefieldCardPayload, growth.payload)).toBe(true);
      const pending = (growth.payload as { pendingIssues: { id: string; nature?: string; fromRadar?: boolean }[] }).pendingIssues;
      expect(pending.find((issue) => issue.id === radarId)).toMatchObject({ nature: "ai_suggested", fromRadar: true });
      expect("fromRadar" in pending.find((issue) => issue.id === importedId)!).toBe(false);

    } finally {
      await t.close();
    }
  });
});
