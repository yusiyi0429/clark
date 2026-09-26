import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createTestApp } from "./helpers.js";

const at = "2026-10-01T00:00:00.000Z";
const extraFields = { keyPath: "先核对再验证", resources: "测试权限", humanAgentSplit: "人确认，Agent 整理", retrospect: "记录验证结论" };

describe("Mission Card attachment boundaries", () => {
  it("persists and edits the four new fields for independent Missions", async () => {
    const t = await createTestApp();
    try {
      const headers = { cookie: await t.loginCookie(), origin: t.publicOrigin };
      await t.sql("INSERT INTO capability_config (id, version, code, name, six_month_outcome) VALUES ('method', 1, '03', 'Method', '方法沉淀')");
      const created = await t.app.inject({ method: "POST", url: "/api/config/missions", headers, payload: {
        code: "independent-202610", period: "2026-10", title: "独立承诺", ownerId: "person-fixture-002",
        capabilityId: "method", battlefieldIds: ["growth"], outcome: "形成核对结果",
        sourceRef: "fixture://mission", sourceDocumentId: "fixture", sourceRevision: 1, sourceTitle: "测试来源", ...extraFields,
      } });
      expect(created.statusCode).toBe(201);
      const card = created.json().cards[0];
      expect(card.payload).toMatchObject({ ...extraFields, placeholder: false, personalCard: null });
      const editedFields = Object.fromEntries(Object.entries(extraFields).map(([key, value]) => [key, `${value}（更新）`]));
      const edited = await t.app.inject({ method: "POST", url: "/api/actions/execute", headers, payload: {
        actionId: card.actions[0].actionId, input: editedFields,
      } });
      expect(edited.statusCode).toBe(200);
      expect(edited.json().cards[0]).toMatchObject({ version: 2, payload: editedFields });
      const management = await t.app.inject({ method: "GET", url: "/api/config/missions", headers });
      expect(management.json().missions[0]).toMatchObject({ ...editedFields, personalCard: null });
    } finally { await t.close(); }
  });

  it("locks attached Missions in every phase and rejects battlefield deletion before changing relationships", async () => {
    const t = await createTestApp();
    try {
      const headers = { cookie: await t.loginCookie(), origin: t.publicOrigin };
      await t.sql("INSERT INTO capability_config (id, version, code, name, six_month_outcome) VALUES ('method', 1, '03', 'Method', '方法沉淀')");
      const created = await t.app.inject({ method: "POST", url: "/api/config/missions", headers, payload: {
        code: "attached-202610", period: "2026-10", title: "讨论候选", ownerId: "person-fixture-002",
        capabilityId: "method", battlefieldIds: ["growth"], outcome: "候选结果",
        sourceRef: "fixture://mission", sourceDocumentId: "fixture", sourceRevision: 1, sourceTitle: "讨论候选（占位）",
      } });
      expect(created.statusCode).toBe(201);
      const original = created.json().cards[0];
      const planId = randomUUID(), roundId = randomUUID(), cardId = randomUUID();
      await t.sql(`INSERT INTO monthly_plans (id,version,period,status,company_outcome,battlefields,todos,negotiation,generation,confirmed_at)
        VALUES ($1,1,'2026-10','confirmed','目标','[]','[]','{}','{}',$2)`, [planId, at]);
      await t.sql(`INSERT INTO mission_rounds (id,version,battlefield_id,period,monthly_plan_id,status,draft_origin,draft_source,created_at,updated_at)
        VALUES ($1,1,'growth','2026-10',$2,'draft','placeholder','{}',$3,$3)`, [roundId, planId, at]);
      await t.sql(`INSERT INTO personal_mission_cards (id,round_id,owner_id,sort_order,member_ids,created_at)
        VALUES ($1,$2,'person-fixture-002',0,'["person-fixture-002","person-fixture-001"]',$3)`, [cardId, roundId, at]);
      await t.sql("UPDATE missions SET personal_mission_card_id = $2, placeholder = true WHERE id = $1", [original.objectRef.id, cardId]);
      for (const status of ["draft", "open", "reviewing", "confirmed"]) {
        if (status !== "draft") await t.sql(`UPDATE mission_rounds SET status=$2, window_seq=1,
          opened_at=$3::timestamptz, closes_at=$3::timestamptz+interval '48 hours',
          confirmed_at=CASE WHEN $2='confirmed' THEN $3::timestamptz+interval '49 hours' ELSE NULL END WHERE id=$1`, [roundId, status, at]);
        const projected = await t.app.inject({ method: "GET", url: `/api/cards/missions/${original.objectRef.id}`, headers });
        expect(projected.json().cards[0]).toMatchObject({ actions: [], payload: { placeholder: true, personalCard: { cardId, roundId, status } } });
        const rejected = await t.app.inject({ method: "POST", url: "/api/actions/execute", headers,
          payload: { actionId: original.actions[0].actionId, input: { title: "绕过个人卡编辑" } } });
        expect(rejected.statusCode).toBe(409);
        expect(rejected.json().code).toBe("MISSION_IN_MISSION_CARD");
      }
      const deleted = await t.app.inject({ method: "DELETE", url: "/api/config/battlefields/growth", headers });
      expect(deleted.statusCode).toBe(409);
      expect(deleted.json().code).toBe("BATTLEFIELD_HAS_MISSION_ROUNDS");
      expect(await t.sql("SELECT title, version, battlefield_ids FROM missions WHERE id=$1", [original.objectRef.id]))
        .toEqual([{ title: "讨论候选", version: 1, battlefield_ids: ["growth"] }]);
      expect(await t.sql("SELECT id FROM battlefield_config WHERE id='growth'")).toHaveLength(1);
    } finally { await t.close(); }
  });
});
