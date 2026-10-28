import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createTestApp, preflightCandidate, TEST_CEO, TEST_MEMBER, type TestApp } from "./helpers.js";
import type { PreflightAgent, PreflightAgentInput } from "../src/meetingPreflight.js";
import type { PreflightWorld } from "../src/preflightAnchors.js";
import { flushPreflightReruns } from "../src/preflightRerun.js";

// 会前预审 v5 的两类输入：按挂点读到的内容进预审；会议群里的材料变了，按最新材料自动重跑。
const SCHEDULED_AT = "2027-01-05T10:00:00.000+08:00";
const PO_ID = "<period-goal-tokenhub>";

type RecordingAgent = PreflightAgent & { calls: PreflightAgentInput[] };

function recordingAgent(world?: PreflightWorld): RecordingAgent {
  const agent: RecordingAgent = {
    calls: [],
    world,
    async generate(input) {
      agent.calls.push(input);
      return { candidate: preflightCandidate([`meeting:${input.meeting.id}`]) };
    },
  };
  return agent;
}

async function scheduledMeeting(t: TestApp): Promise<string> {
  const issue = await t.createIssue();
  const created = await t.app.inject({ method: "POST", url: "/api/dri/meetings", headers: { authorization: `Bearer ${t.env.driServiceToken}` },
    payload: {
      externalId: `preflight-inputs-${randomUUID()}`, title: "TokenHub 上游路线会", scheduledAt: SCHEDULED_AT,
      leadDriId: TEST_MEMBER.personId, ceoParticipantId: TEST_CEO.personId, participants: [TEST_MEMBER.personId], issueIds: [issue.objectRef.id],
    } });
  expect(created.statusCode, created.body).toBe(201);
  return created.json().cards[0].objectRef.id as string;
}

async function regenerate(t: TestApp, meetingId: string) {
  const cookie = await t.loginCookie();
  const card = (await t.app.inject({ method: "GET", url: `/api/cards/meetings/${meetingId}`, headers: { cookie } })).json().cards[0];
  const action = card.actions.find((item: { actionType: string }) => item.actionType === "meeting.regenerate_preflight");
  expect(action, "会议卡应提供重新预审").toBeTruthy();
  const res = await t.app.inject({ method: "POST", url: "/api/actions/execute", headers: { cookie, origin: t.publicOrigin },
    payload: { actionId: action.actionId, input: {} } });
  expect(res.statusCode, res.body).toBe(200);
  return res.json().cards[0];
}

const multipart = (name: string, body: string) => {
  const boundary = "----preflight-inputs-test";
  return { headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
    payload: Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: text/markdown\r\n\r\n${body}\r\n--${boundary}--\r\n`) };
};

describe("会前预审按挂点读内容", () => {
  it("本月目标读本体，Mission 与责任单元读天枢；本体读不到的只给名称，天枢里找不到的跳过；过程写明读到了什么", async () => {
    const reads: string[] = [];
    const world = {
      async getObject(id: string) {
        reads.push(id);
        if (id !== PO_ID) throw Object.assign(new Error("本体读不到"), { code: "WORLD_UNAVAILABLE" });
        return {
          business: { object_id: PO_ID, object_type: "PeriodGoal", title: "TokenHub 10 月目标", version: 3, attributes: { period: "2026-10" },
            blocks: [{ id: "target", display_name: "目标", components: [
              { id: "c1", type: "outcome", text: "月底完成 MVP 并进入内部真实使用" },
              { id: "c2", type: "acceptance_criterion", text: "灯塔项目完成一次真实调用并核对账单" }] }] },
          records: { lifecycle: { status: "draft", display_name: "草稿" } },
        };
      },
    } as unknown as PreflightWorld;
    const agent = recordingAgent(world);
    const t = await createTestApp({}, undefined, { preflightAgent: agent });
    try {
      await t.sql(`INSERT INTO capability_config (id, version, name, "group", six_month_outcome, code, owner_id)
        VALUES ('unit-th', 1, 'TokenHub', 'test', '春节前跑通调用、计量与账单', '98', $1)`, [TEST_MEMBER.personId]);
      await t.sql(`INSERT INTO missions (id, version, code, period, title, owner_id, capability_id, outcome, milestones, world_goal_id,
          source_ref, source_document_id, source_revision, source_title)
        VALUES ('m-th', 1, 'th-202701', '2027-01', 'TokenHub 计量上线', $1, 'unit-th', '一月上线按调用计费', $2::jsonb, $3, 'test://m', 'test', 1, '测试')`,
      [TEST_MEMBER.personId, JSON.stringify(["1 月 15 日账单对齐"]), PO_ID]);
      const meetingId = await scheduledMeeting(t);
      await t.sql("UPDATE meetings SET world_anchors = $2::jsonb WHERE id = $1", [meetingId, JSON.stringify([
        { kind: "po", id: PO_ID, title: "TokenHub 10 月目标" },
        { kind: "lto", id: "<long-term-goal-unreadable>", title: "TokenHub 六个月目标" },
        { kind: "mission", id: "m-th" },
        { kind: "mission", id: "m-gone" },
        { kind: "unit", id: "unit-th" },
      ])]);

      const card = await regenerate(t, meetingId);
      const { anchors, inputCoverage } = agent.calls.at(-1)!;
      const goal = { title: "TokenHub 10 月目标", status: "草稿", period: "2026-10", outcome: "月底完成 MVP 并进入内部真实使用", acceptance: "灯塔项目完成一次真实调用并核对账单" };
      expect(anchors).toEqual([
        { kind: "po", readState: "ok", ...goal },
        { kind: "lto", readState: "title_only", title: "TokenHub 六个月目标", status: null },
        { kind: "mission", readState: "ok", title: "TokenHub 计量上线", owner: "测试乙", status: null, outcome: "一月上线按调用计费",
          milestones: ["1 月 15 日账单对齐"], servesGoal: goal },
        { kind: "unit", readState: "ok", title: "TokenHub", owner: "测试乙", sixMonthOutcome: "春节前跑通调用、计量与账单",
          missions: [{ title: "TokenHub 计量上线", owner: "测试乙", outcome: "一月上线按调用计费" }] },
      ]);
      expect(reads).toEqual([PO_ID, "<long-term-goal-unreadable>", PO_ID]);
      expect(inputCoverage.background).toBe("available");
      expect(card.payload.preflight.status).toBe("ready");
      const labels = card.payload.preflight.progress.steps.map((step: { label: string }) => step.label);
      expect(labels).toEqual(expect.arrayContaining(["已读取挂点：本月目标「TokenHub 10 月目标」", "挂点长期目标「TokenHub 六个月目标」只读到名称",
        "已读取挂点：Mission「TokenHub 计量上线」", "已读取挂点：责任单元「TokenHub」"]));
    } finally {
      await t.close();
    }
  });
});

describe("会议材料变了自动重新预审", () => {
  it("连传两份只按最新材料跑一次；手动重新预审过、用到的版本没变不跑；会开完不跑", async () => {
    const storage = await mkdtemp(join(tmpdir(), "preflight-rerun-"));
    const agent = recordingAgent();
    const t = await createTestApp({ materialStorageDir: storage }, undefined, { preflightAgent: agent });
    try {
      const meetingId = await scheduledMeeting(t);
      const member = await t.memberCookie();
      const upload = async (name: string, body: string) => {
        const part = multipart(name, body);
        const res = await t.app.inject({ method: "POST", url: `/api/materials/meeting/${meetingId}`,
          headers: { cookie: member, origin: t.publicOrigin, ...part.headers }, payload: part.payload });
        expect(res.statusCode, res.body).toBe(201);
      };
      expect(agent.calls).toHaveLength(1);

      await upload("议程.md", "# 议程\n\n定首批上游");
      await upload("报价.md", "# 报价\n\n硅基流动报价待核");
      expect(agent.calls).toHaveLength(1);
      await flushPreflightReruns();
      expect(agent.calls).toHaveLength(2);
      expect(agent.calls[1].groupMaterials.map((material) => material.fileName).sort()).toEqual(["报价.md", "议程.md"].sort());

      await upload("纪要.md", "# 纪要\n\n上周定了先接两家");
      await regenerate(t, meetingId);
      expect(agent.calls).toHaveLength(3);
      await flushPreflightReruns();
      expect(agent.calls).toHaveLength(3);

      await upload("会后补充.md", "# 补充\n\n会后补的材料");
      await t.sql("UPDATE meetings SET ended_at = now() WHERE id = $1", [meetingId]);
      await flushPreflightReruns();
      expect(agent.calls).toHaveLength(3);
    } finally {
      await t.close();
      await rm(storage, { recursive: true, force: true });
    }
  });
});
