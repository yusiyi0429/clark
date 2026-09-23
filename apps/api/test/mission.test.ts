import { describe, expect, it } from "vitest";
import { Value } from "@sinclair/typebox/value";
import { Card } from "@warmap/contracts";
import { createTestApp, type TestApp } from "./helpers.js";

/** 结构化战场/能力写入：Mission 关系只能命中已登记对象。 */
function battlefieldBody(name: string, code: string) {
  return { code, sortOrder: Number(code) * 10, name, ownerId: "person-fixture-002", sixMonthOutcome: `${name}六个月目标` };
}

function capabilityBody(name: string, code: string) {
  return { code, sortOrder: Number(code) * 10, name, group: "", sixMonthOutcome: `${name}六个月目标` };
}

function missionBody(code: string, overrides: Record<string, unknown> = {}) {
  return {
    code,
    period: "2026-09",
    title: `${code} 标题`,
    ownerId: "person-fixture-002",
    capabilityId: "交付能力",
    battlefieldIds: ["growth"],
    outcome: `${code} 结果承诺`,
    why: `${code} 背景`,
    successEvidence: [`${code} 证据一`],
    milestones: [`${code} 里程碑一`],
    dependencies: `${code} 依赖`,
    risk: `${code} 风险`,
    boundaries: `${code} 边界`,
    sourceRef: "feishu://docx/fixture",
    sourceDocumentId: "fixture-document",
    sourceRevision: 3,
    sourceTitle: `${code} 来源文档`,
    ...overrides,
  };
}

async function authed(t: TestApp): Promise<Record<string, string>> {
  const cookie = await t.loginCookie();
  return { cookie, origin: t.publicOrigin };
}

async function create(t: TestApp, headers: Record<string, string>, payload: Record<string, unknown>) {
  return t.app.inject({ method: "POST", url: "/api/config/missions", headers, payload });
}

async function card(t: TestApp, headers: Record<string, string>, id: string): Promise<Record<string, any>> {
  const response = await t.app.inject({ method: "GET", url: `/api/cards/missions/${id}`, headers: { cookie: headers.cookie! } });
  expect(response.statusCode).toBe(200);
  return response.json().cards[0];
}

async function execute(t: TestApp, headers: Record<string, string>, actionId: string, input: unknown) {
  return t.app.inject({ method: "POST", url: "/api/actions/execute", headers, payload: { actionId, input } });
}

/** 先落一条能力与两条战场，Mission 关系才有合法目标。 */
async function seedRelations(t: TestApp, headers: Record<string, string>): Promise<void> {
  expect((await t.app.inject({ method: "POST", url: "/api/config/capabilities", headers, payload: capabilityBody("交付能力", "03") })).statusCode).toBe(201);
  expect((await t.app.inject({ method: "POST", url: "/api/config/battlefields", headers, payload: battlefieldBody("渠道战场", "02") })).statusCode).toBe(201);
}

describe("Mission 实体", () => {
  it("rejects unauthenticated and cross-origin Mission writes", async () => {
    const t = await createTestApp();
    try {
      const anonymous = await t.app.inject({ method: "POST", url: "/api/config/missions", headers: { origin: t.publicOrigin }, payload: missionBody("M-1") });
      expect(anonymous.statusCode).toBe(401);
      const cookie = await t.loginCookie();
      const crossOrigin = await t.app.inject({ method: "POST", url: "/api/config/missions", headers: { cookie, origin: "https://evil.local" }, payload: missionBody("M-1") });
      expect(crossOrigin.statusCode).toBe(403);
      expect(crossOrigin.json().code).toBe("ORIGIN_MISMATCH");
    } finally {
      await t.close();
    }
  });

  it("registers a Mission, validates relations and rejects a duplicate code", async () => {
    const t = await createTestApp();
    try {
      const headers = await authed(t);
      await seedRelations(t, headers);
      const created = await create(t, headers, missionBody("LHR-A", { title: "CEO Agent Architecture & Quality" }));
      expect(created.statusCode).toBe(201);
      const mission = created.json().cards[0];
      expect(Value.Check(Card, mission)).toBe(true);
      expect(mission.kind).toBe("mission");
      expect(mission.badge).toBe("Mission");
      expect(mission.objectRef).toEqual({ type: "mission", id: "lhr-a-ceo-agent-architecture-quality", version: 1 });
      expect(mission.actions.map((action: { actionType: string }) => action.actionType)).toEqual(["mission.edit"]);
      // 关系显示名只在投影时现查注册表，不落库
      expect(mission.payload).toMatchObject({
        code: "LHR-A",
        ownerDisplayName: "测试乙",
        capabilityCode: "03",
        capabilityName: "交付能力",
        battlefieldIds: ["growth"],
        battlefieldNames: ["增长战场"],
      });
      expect(await t.sql("SELECT code, period, owner_id, capability_id, battlefield_ids FROM missions")).toEqual([
        { code: "LHR-A", period: "2026-09", owner_id: "person-fixture-002", capability_id: "交付能力", battlefield_ids: ["growth"] },
      ]);

      // 同一 code 两次都允许（Mission 与战略锚点是两套命名空间），Mission 表内重复才 409
      const duplicate = await create(t, headers, missionBody("LHR-A", { title: "另一个标题" }));
      expect(duplicate.statusCode).toBe(409);
      expect(duplicate.json().code).toBe("MISSION_CODE_CONFLICT");

      for (const [field, value, code] of [
        ["ownerId", "person-nobody", "INVALID_OWNER"],
        ["capabilityId", "不存在的能力", "INVALID_CAPABILITY"],
        ["battlefieldIds", ["不存在的战场"], "INVALID_BATTLEFIELD"],
      ] as const) {
        const invalid = await create(t, headers, missionBody("M-2", { [field]: value }));
        expect(invalid.statusCode).toBe(400);
        expect(invalid.json().code).toBe(code);
      }
      // 非法 period 由契约拦截，不落库
      const badPeriod = await create(t, headers, missionBody("M-3", { period: "2026/09" }));
      expect(badPeriod.statusCode).toBe(400);
      expect(await t.sql("SELECT count(*)::int AS count FROM missions")).toEqual([{ count: 1 }]);
    } finally {
      await t.close();
    }
  });

  it("sorts the management projection by period desc, capability sortOrder then code", async () => {
    const t = await createTestApp();
    try {
      const headers = await authed(t);
      await seedRelations(t, headers);
      await t.app.inject({ method: "POST", url: "/api/config/capabilities", headers, payload: capabilityBody("Agent 能力", "04") });
      for (const [code, overrides] of [
        ["03-2", { period: "2026-09", capabilityId: "交付能力" }],
        ["03-1", { period: "2026-09", capabilityId: "交付能力" }],
        ["04-1", { period: "2026-09", capabilityId: "agent-能力" }],
        ["10-1", { period: "2026-10", capabilityId: "agent-能力" }],
      ] as const) {
        expect((await create(t, headers, missionBody(code, overrides))).statusCode).toBe(201);
      }
      const projection = await t.app.inject({ method: "GET", url: "/api/config/missions", headers: { cookie: headers.cookie! } });
      expect(projection.statusCode).toBe(200);
      expect(projection.json().missions.map((mission: { code: string }) => mission.code)).toEqual(["10-1", "03-1", "03-2", "04-1"]);
      // 配置页与 Card 列表是同一份投影
      const cards = await t.app.inject({ method: "GET", url: "/api/cards/missions", headers: { cookie: headers.cookie! } });
      expect(cards.json().cards.map((c: { payload: { code: string } }) => c.payload.code)).toEqual(["10-1", "03-1", "03-2", "04-1"]);
    } finally {
      await t.close();
    }
  });

  it("edits through mission.edit with version anchoring, idempotent replay and immutable source", async () => {
    const t = await createTestApp();
    try {
      const headers = await authed(t);
      await seedRelations(t, headers);
      const created = await create(t, headers, missionBody("LHR-A"));
      expect(created.statusCode).toBe(201);
      const id = created.json().cards[0].objectRef.id as string;
      const actionId = created.json().cards[0].actions[0].actionId as string;

      const edited = await execute(t, headers, actionId, { title: "改写后的标题", battlefieldIds: ["growth", "渠道战场"] });
      expect(edited.statusCode).toBe(200);
      expect(edited.json().cards[0].version).toBe(2);
      expect(edited.json().cards[0].payload).toMatchObject({
        title: "改写后的标题",
        battlefieldIds: ["growth", "渠道战场"],
        battlefieldNames: ["增长战场", "渠道战场"],
        sourceRevision: 3,
      });

      // 同一 actionId + 同一 input 幂等重放：不再 version+1
      const replayed = await execute(t, headers, actionId, { title: "改写后的标题", battlefieldIds: ["growth", "渠道战场"] });
      expect(replayed.statusCode).toBe(200);
      expect(replayed.json().cards[0].version).toBe(2);
      expect(await t.sql("SELECT version FROM missions")).toEqual([{ version: 2 }]);

      // 旧 actionId（v1 锚）带新 input → 冲突并返回最新 Card
      const stale = await execute(t, headers, actionId, { title: "第二次改写" });
      expect(stale.statusCode).toBe(409);
      expect(stale.json().code).toBe("VERSION_CONFLICT");
      expect(stale.json().latestCard.version).toBe(2);

      // source metadata 不可从 Web 编辑；空 diff 也不接受
      const latest = await card(t, headers, id);
      const freshActionId = latest.actions[0].actionId as string;
      for (const input of [{ sourceRevision: 99 }, { sourceRef: "feishu://other" }, {}]) {
        const rejected = await execute(t, headers, freshActionId, input);
        expect(rejected.statusCode).toBe(400);
        expect(rejected.json().code).toBe("INVALID_INPUT");
      }
      const unknownCapability = await execute(t, headers, freshActionId, { capabilityId: "不存在的能力" });
      expect(unknownCapability.statusCode).toBe(400);
      expect(unknownCapability.json().code).toBe("INVALID_CAPABILITY");
      // 非法 code 重复仍 409；未改动的 Mission 版本不动
      expect((await create(t, headers, missionBody("LHR-B"))).statusCode).toBe(201);
      const conflictCode = await execute(t, headers, freshActionId, { code: "LHR-B" });
      expect(conflictCode.statusCode).toBe(409);
      expect(conflictCode.json().code).toBe("MISSION_CODE_CONFLICT");
      expect(await t.sql("SELECT code, version FROM missions ORDER BY code")).toEqual([
        { code: "LHR-A", version: 2 },
        { code: "LHR-B", version: 1 },
      ]);
    } finally {
      await t.close();
    }
  });

  it("deletes a battlefield, pruning Mission battlefieldIds and versioning only affected Missions", async () => {
    const t = await createTestApp();
    try {
      const headers = await authed(t);
      await seedRelations(t, headers);
      await create(t, headers, missionBody("03-1", { battlefieldIds: ["growth", "渠道战场"] }));
      await create(t, headers, missionBody("03-2", { battlefieldIds: ["growth"] }));

      const deleted = await t.app.inject({ method: "DELETE", url: "/api/config/battlefields/渠道战场", headers });
      expect(deleted.statusCode).toBe(204);
      expect(await t.sql("SELECT code, version, battlefield_ids FROM missions ORDER BY code")).toEqual([
        { code: "03-1", version: 2, battlefield_ids: ["growth"] },
        { code: "03-2", version: 1, battlefield_ids: ["growth"] },
      ]);
    } finally {
      await t.close();
    }
  });

  it("projects Mission cards on home and rejects an unknown id", async () => {
    const t = await createTestApp();
    try {
      const headers = await authed(t);
      await seedRelations(t, headers);
      await create(t, headers, missionBody("LHR-A"));
      const home = await t.app.inject({ method: "GET", url: "/api/cards/home", headers: { cookie: headers.cookie! } });
      expect(home.statusCode).toBe(200);
      expect(home.json().cards.filter((c: { kind: string }) => c.kind === "mission")).toHaveLength(1);

      const missing = await t.app.inject({ method: "GET", url: "/api/cards/missions/no-such-mission", headers: { cookie: headers.cookie! } });
      expect(missing.statusCode).toBe(404);
      expect(missing.json().code).toBe("CARD_NOT_FOUND");
    } finally {
      await t.close();
    }
  });
});
