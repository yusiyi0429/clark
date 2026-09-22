import { describe, expect, it } from "vitest";
import { Value } from "@sinclair/typebox/value";
import { Card, MeetingCardPayload, type TPreflightCandidate } from "@warmap/contracts";
import { createTestApp, preflightCandidate, type TestApp } from "./helpers.js";
import type { PreflightAgent, PreflightAgentInput } from "../src/meetings.js";

/** 预审只引用 Meeting 自身来源：独立新建的 Meeting 可以没有任何关联 Issue。 */
function fakeAgent(): PreflightAgent {
  return {
    async generate(input: PreflightAgentInput) {
      const candidate: TPreflightCandidate = preflightCandidate([`meeting:${input.meeting.id}`]);
      return { candidate, runId: "preflight-run-config" };
    },
  };
}

async function authed(t: TestApp): Promise<{ cookie: string; headers: Record<string, string> }> {
  const cookie = await t.loginCookie();
  return { cookie, headers: { cookie, origin: t.publicOrigin } };
}

describe("CEO 配置页 create 路由", () => {
  it("rejects unauthenticated writes on all four routes", async () => {
    const t = await createTestApp({}, undefined, { preflightAgent: fakeAgent() });
    try {
      for (const [url, payload] of [
        ["/api/config/battlefields", { name: "供应战场", owner: "张三", goal: "锁定供应" }],
        ["/api/config/capabilities", { name: "供应链能力", group: "组织", description: "端到端交付" }],
        ["/api/config/issues", { title: "标题", battlefieldId: "growth" }],
        ["/api/config/meetings", { title: "会议", scheduledAt: "2026-06-01T10:00:00.000+08:00", leadDriId: "person-fixture-002" }],
      ] as const) {
        const res = await t.app.inject({ method: "POST", url, headers: { origin: t.publicOrigin }, payload });
        expect(res.statusCode).toBe(401);
      }
    } finally {
      await t.close();
    }
  });

  it("registers a battlefield and rejects a duplicate slug", async () => {
    const t = await createTestApp({}, undefined, { preflightAgent: fakeAgent() });
    try {
      const { headers } = await authed(t);
      const created = await t.app.inject({
        method: "POST",
        url: "/api/config/battlefields",
        headers,
        payload: { name: "供应战场", owner: "张三", goal: "锁定关键器件的供应与价格" },
      });
      expect(created.statusCode).toBe(201);
      const card = created.json().cards[0];
      expect(Value.Check(Card, card)).toBe(true);
      expect(card.kind).toBe("battlefield");
      expect(card.objectRef.id).toBe("供应战场");

      const row = await t.sql("SELECT name, positioning, owner FROM battlefield_config WHERE id = $1", ["供应战场"]);
      expect(row).toEqual([{ name: "供应战场", positioning: "锁定关键器件的供应与价格", owner: "张三" }]);

      const duplicate = await t.app.inject({
        method: "POST",
        url: "/api/config/battlefields",
        headers,
        payload: { name: "供应战场", owner: "李四", goal: "另一套目标" },
      });
      expect(duplicate.statusCode).toBe(409);

      const missingField = await t.app.inject({
        method: "POST",
        url: "/api/config/battlefields",
        headers,
        payload: { name: "空白战场", owner: "张三" },
      });
      expect(missingField.statusCode).toBe(400);
    } finally {
      await t.close();
    }
  });

  it("registers a capability that reaches the home capability panel without any Issue", async () => {
    const t = await createTestApp({}, undefined, { preflightAgent: fakeAgent() });
    try {
      const { headers } = await authed(t);
      const created = await t.app.inject({
        method: "POST",
        url: "/api/config/capabilities",
        headers,
        payload: { name: "供应链能力", group: "交付组织", description: "把关键器件从寻源到交付串成一条线" },
      });
      expect(created.statusCode).toBe(201);
      const card = created.json().cards[0];
      expect(Value.Check(Card, card)).toBe(true);
      expect(card.kind).toBe("capability");
      expect(card.payload).toEqual({
        capabilityId: "供应链能力",
        name: "供应链能力",
        group: "交付组织",
        description: "把关键器件从寻源到交付串成一条线",
      });

      const home = await t.app.inject({ method: "GET", url: "/api/cards/home", headers: { cookie: headers.cookie! } });
      expect(home.json().cards.some((candidate: { id: string }) => candidate.id === "capability:供应链能力")).toBe(true);
    } finally {
      await t.close();
    }
  });

  it("creates a pending CEO Issue that triggers research", async () => {
    const started: string[] = [];
    const t = await createTestApp({}, undefined, { preflightAgent: fakeAgent() }, {
      async start(issueId: string) { started.push(issueId); },
      async executeRun() {},
      async idle() {},
    });
    try {
      const { headers } = await authed(t);
      const created = await t.app.inject({
        method: "POST",
        url: "/api/config/issues",
        headers,
        payload: { title: "是否自建渠道", battlefieldId: "growth", decisionBy: "2026-06-30" },
      });
      expect(created.statusCode).toBe(201);
      const card = created.json().cards[0];
      expect(Value.Check(Card, card)).toBe(true);
      expect(card.badge).toBe("CEO");
      expect(card.title).toBe("是否自建渠道");
      expect(card.payload.origin).toBe("ceo");
      expect(card.payload.status).toBe("pending");
      expect(card.payload.location).toEqual({ level: "battlefield", battlefieldId: "growth" });
      expect(card.payload.urgency).toEqual({ level: "yellow", decisionBy: "2026-06-30" });
      expect(card.payload.research.status).toBe("pending");
      expect(started).toEqual([card.objectRef.id]);

      const unknownBattlefield = await t.app.inject({
        method: "POST",
        url: "/api/config/issues",
        headers,
        payload: { title: "未注册战场议题", battlefieldId: "unknown-zone" },
      });
      expect(unknownBattlefield.statusCode).toBe(400);

      const tooLongTitle = await t.app.inject({
        method: "POST",
        url: "/api/config/issues",
        headers,
        payload: { title: "这是一个明显超过二十五个字的议题标题用于验证长度校验", battlefieldId: "growth" },
      });
      expect(tooLongTitle.statusCode).toBe(400);
    } finally {
      await t.close();
    }
  });

  it("creates a scheduled Meeting with no linked Issue and with an existing Issue", async () => {
    const t = await createTestApp({}, undefined, { preflightAgent: fakeAgent() });
    try {
      const { headers } = await authed(t);
      const empty = await t.app.inject({
        method: "POST",
        url: "/api/config/meetings",
        headers,
        payload: { title: "季度经营复盘", scheduledAt: "2026-06-01T10:00:00.000+08:00", leadDriId: "person-fixture-002" },
      });
      expect(empty.statusCode).toBe(201);
      const emptyCard = empty.json().cards[0];
      expect(Value.Check(Card, emptyCard)).toBe(true);
      expect(Value.Check(MeetingCardPayload, emptyCard.payload)).toBe(true);
      expect(emptyCard.payload.issueIds).toEqual([]);
      expect(emptyCard.payload.status).toBe("scheduled");
      expect(emptyCard.payload.leadDriId).toBe("person-fixture-002");

      const issue = await t.createIssue();
      const linked = await t.app.inject({
        method: "POST",
        url: "/api/config/meetings",
        headers,
        payload: {
          title: "渠道投入决策会",
          scheduledAt: "2026-06-02T10:00:00.000+08:00",
          leadDriId: "person-fixture-002",
          issueIds: [issue.objectRef.id],
        },
      });
      expect(linked.statusCode).toBe(201);
      expect(linked.json().cards[0].payload.issueIds).toEqual([issue.objectRef.id]);

      const badDri = await t.app.inject({
        method: "POST",
        url: "/api/config/meetings",
        headers,
        payload: { title: "非法负责人", scheduledAt: "2026-06-03T10:00:00.000+08:00", leadDriId: "person-fixture-001" },
      });
      expect(badDri.statusCode).toBe(400);

      const badTime = await t.app.inject({
        method: "POST",
        url: "/api/config/meetings",
        headers,
        payload: { title: "非法时间", scheduledAt: "不是时间", leadDriId: "person-fixture-002" },
      });
      expect(badTime.statusCode).toBe(400);
    } finally {
      await t.close();
    }
  });

  it("assigns and unassigns pending Issues with deterministic set normalization", async () => {
    const t = await createTestApp({}, undefined, { preflightAgent: fakeAgent() });
    try {
      const { cookie, headers } = await authed(t);
      const issue = await t.createIssue();
      const issueId = issue.objectRef.id;
      const battlefield = await t.app.inject({
        method: "POST",
        url: "/api/config/battlefields",
        headers,
        payload: { name: "渠道战场", owner: "张三", goal: "拿下东南亚渠道" },
      });
      expect(battlefield.statusCode).toBe(201);
      const extra = battlefield.json().cards[0].objectRef.id as string;

      // 未注册战场：404
      const unknown = await t.app.inject({
        method: "POST",
        url: "/api/config/battlefields/unknown-zone/issues",
        headers,
        payload: { issueId },
      });
      expect(unknown.statusCode).toBe(404);

      const assigned = await t.app.inject({ method: "POST", url: `/api/config/battlefields/${extra}/issues`, headers, payload: { issueId } });
      expect(assigned.statusCode).toBe(200);
      const assignedCard = assigned.json().cards[0];
      expect(Value.Check(Card, assignedCard)).toBe(true);
      // 2 个战场：归一化为排序后的 company 集合
      expect(assignedCard.payload.location).toEqual({ level: "company", relatedBattlefieldIds: ["growth", extra].sort() });
      expect(assignedCard.objectRef.version).toBe(issue.version + 1);

      // 重复加入同一战场：集合不变，不升 version
      const again = await t.app.inject({ method: "POST", url: `/api/config/battlefields/${extra}/issues`, headers, payload: { issueId } });
      expect(again.statusCode).toBe(200);
      expect(again.json().cards[0].objectRef.version).toBe(assignedCard.objectRef.version);

      // 2 → 1：自动降级回 battlefield 级
      const downgraded = await t.app.inject({ method: "DELETE", url: `/api/config/battlefields/${extra}/issues/${issueId}`, headers });
      expect(downgraded.statusCode).toBe(200);
      expect(downgraded.json().cards[0].payload.location).toEqual({ level: "battlefield", battlefieldId: "growth" });

      // 1 → 0：未归属（company + 空集合）
      const orphaned = await t.app.inject({ method: "DELETE", url: `/api/config/battlefields/growth/issues/${issueId}`, headers });
      expect(orphaned.statusCode).toBe(200);
      expect(orphaned.json().cards[0].payload.location).toEqual({ level: "company", relatedBattlefieldIds: [] });
      const rows = await t.sql("SELECT location, version FROM issues WHERE id = $1", [issueId]);
      expect(rows[0].location).toEqual({ level: "company", relatedBattlefieldIds: [] });
      expect(rows[0].version).toBe(assignedCard.objectRef.version + 2);
      expect(cookie).toBeTruthy();
    } finally {
      await t.close();
    }
  });

  it("rejects battlefield membership changes on capability Issues and on non-pending Issues", async () => {
    const t = await createTestApp({}, undefined, { preflightAgent: fakeAgent() });
    try {
      const { headers } = await authed(t);
      const capability = await t.createIssue({ location: { level: "capability", capabilityId: "cap-delivery" } });
      const capabilityAssign = await t.app.inject({
        method: "POST",
        url: "/api/config/battlefields/growth/issues",
        headers,
        payload: { issueId: capability.objectRef.id },
      });
      expect(capabilityAssign.statusCode).toBe(400);
      expect(capabilityAssign.json().code).toBe("INVALID_LOCATION");

      const decided = await t.createIssue();
      await t.sql("UPDATE issues SET status = 'decided' WHERE id = $1", [decided.objectRef.id]);
      const decidedAssign = await t.app.inject({
        method: "POST",
        url: "/api/config/battlefields/growth/issues",
        headers,
        payload: { issueId: decided.objectRef.id },
      });
      expect(decidedAssign.statusCode).toBe(409);
      expect(decidedAssign.json().code).toBe("ISSUE_NOT_PENDING");
      const decidedUnassign = await t.app.inject({
        method: "DELETE",
        url: `/api/config/battlefields/growth/issues/${decided.objectRef.id}`,
        headers,
      });
      expect(decidedUnassign.statusCode).toBe(409);

      const missing = await t.app.inject({ method: "POST", url: "/api/config/battlefields/growth/issues", headers, payload: { issueId: "no-such-issue" } });
      expect(missing.statusCode).toBe(404);

      const anonymous = await t.app.inject({ method: "POST", url: "/api/config/battlefields/growth/issues", headers: { origin: t.publicOrigin }, payload: { issueId: capability.objectRef.id } });
      expect(anonymous.statusCode).toBe(401);
    } finally {
      await t.close();
    }
  });

  // Receipt schema 仍然只由 Meeting Outcome 写入；配置页不产生 Receipt。
});
