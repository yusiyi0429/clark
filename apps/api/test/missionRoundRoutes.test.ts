import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { signActionId } from "../src/actionToken.js";
import { createTestApp, type TestApp } from "./helpers.js";

const start = "2026-10-01T02:00:00.000Z";
async function seed(t: TestApp) {
  const planId = randomUUID(), roundId = randomUUID(), cardId = randomUUID();
  await t.sql("UPDATE battlefield_config SET owner_id='person-fixture-001', six_month_outcome='六个月目标' WHERE id='growth'");
  await t.sql(`INSERT INTO monthly_plans (id,version,period,status,company_outcome,battlefields,todos,negotiation,generation,confirmed_at)
    VALUES ($1,1,'2026-10','confirmed','公司目标','[{"battlefieldId":"growth","outcome":"本月目标"}]','[]','{}','{}',$2)`, [planId, start]);
  await t.sql(`INSERT INTO mission_rounds (id,version,battlefield_id,period,monthly_plan_id,status,draft_origin,draft_source,created_at,updated_at)
    VALUES ($1,1,'growth','2026-10',$2,'draft','placeholder','{}',$3,$3)`, [roundId, planId, start]);
  await t.sql(`INSERT INTO personal_mission_cards (id,round_id,owner_id,sort_order,member_ids,created_at)
    VALUES ($1,$2,'person-fixture-002',0,'["person-fixture-002","person-fixture-001"]',$3)`, [cardId, roundId, start]);
  await t.sql(`INSERT INTO missions (id,version,code,period,title,owner_id,capability_id,battlefield_ids,outcome,source_ref,source_document_id,source_revision,source_title,personal_mission_card_id)
    VALUES ('route-mission',1,'route-mission','2026-10','候选','person-fixture-002','method','["growth"]','预期结果','fixture://mission','fixture',1,'讨论候选（占位）',$1)`, [cardId]);
  return { roundId, cardId };
}
const action = (t: TestApp, roundId: string, actionType: string, version = 1, objectType = "mission-round") => signActionId(t.env.sessionSecret, {
  actionType, objectType, objectId: roundId, objectVersion: version,
});
const execute = (t: TestApp, cookie: string, actionId: string, more: Record<string, unknown> = {}) => t.app.inject({
  method: "POST", url: "/api/mission-rounds/actions/execute", headers: { cookie, origin: t.publicOrigin },
  payload: { actionId, input: {}, ...more },
});

describe("Mission round HTTP boundary", () => {
  it("requires a person, checks Origin and object visibility, and preserves the old CEO-only endpoint", async () => {
    const t = await createTestApp({}, undefined, { monthlyNow: () => new Date(start) });
    try {
      const { roundId } = await seed(t);
      expect((await t.app.inject({ method: "GET", url: `/api/mission-rounds/${roundId}` })).statusCode).toBe(401);
      const ceo = await t.loginCookie(), member = await t.memberCookie();
      const get = (cookie: string, id = roundId) => t.app.inject({ method: "GET", url: `/api/mission-rounds/${id}`, headers: { cookie } });
      const visible = await get(member);
      expect(visible.statusCode).toBe(200);
      expect(visible.json().cards[0]).toMatchObject({ kind: "mission-round", actions: [], payload: { approver: false, phase: "draft" } });
      const token = action(t, roundId, "mission-round.open");
      expect((await execute(t, member, token)).statusCode).toBe(403);
      expect((await t.app.inject({ method: "POST", url: "/api/mission-rounds/actions/execute", headers: { cookie: ceo, origin: "https://elsewhere.invalid" }, payload: { actionId: token } })).statusCode).toBe(403);
      expect((await t.app.inject({ method: "POST", url: "/api/actions/execute", headers: { cookie: member, origin: t.publicOrigin }, payload: { actionId: token } })).statusCode).toBe(403);
      expect((await execute(t, ceo, "invalid")).statusCode).toBe(404);
      expect((await execute(t, ceo, action(t, roundId, "mission-round.open", 1, "issue"))).statusCode).toBe(404);
      expect((await execute(t, ceo, token, { input: { unexpected: true } })).statusCode).toBe(400);
      expect((await get(ceo, "not-a-uuid")).statusCode).toBe(404);
      await t.sql("UPDATE personal_mission_cards SET owner_id='person-fixture-001', member_ids='[\"person-fixture-001\"]' WHERE round_id=$1", [roundId]);
      expect((await get(member)).statusCode).toBe(404);
      const hidden = await execute(t, member, token);
      expect(hidden.statusCode).toBe(404);
      expect(hidden.json().latestCard).toBeUndefined();
    } finally { await t.close(); }
  });

  it("allows the battlefield DRI to open, returns the current Card on replay and rejects an unrelated view before writing", async () => {
    const t = await createTestApp({}, undefined, { monthlyNow: () => new Date(start) });
    try {
      const { roundId, cardId } = await seed(t);
      await t.sql("UPDATE battlefield_config SET owner_id='person-fixture-002' WHERE id='growth'");
      const cookie = await t.memberCookie();
      const view = await t.app.inject({ method: "GET", url: `/api/mission-rounds/${roundId}`, headers: { cookie } });
      const token = view.json().cards[0].actions.find((a: {actionType: string}) => a.actionType === "mission-round.open").actionId;
      const unavailable = await execute(t, cookie, token, { viewCardId: randomUUID() });
      expect(unavailable.statusCode).toBe(404);
      expect(unavailable.json().code).toBe("PERSONAL_MISSION_CARD_NOT_FOUND");
      expect((await t.sql("SELECT status FROM mission_rounds WHERE id=$1", [roundId]))[0].status).toBe("draft");
      const opened = await execute(t, cookie, token);
      expect(opened.statusCode).toBe(200);
      expect(opened.json().cards[0]).toMatchObject({ version: 2, payload: { phase: "open", openedAt: start, closesAt: null, serverNow: start, approver: true } });
      expect((await execute(t, cookie, token)).json().cards[0].version).toBe(2);
      expect((await execute(t, cookie, token, { viewCardId: cardId })).json().cards[0]).toMatchObject({ kind: "personal-mission-card", version: 2, payload: { card: { cardId } } });
      const duplicate = await execute(t, cookie, action(t, roundId, "mission-round.open", 2));
      expect(duplicate.statusCode).toBe(409);
      expect(duplicate.json().code).toBe("ROUND_ALREADY_OPEN");
      const stale = await execute(t, cookie, action(t, roundId, "mission-round.reopen", 1));
      expect(stale.statusCode).toBe(409);
      expect(stale.json()).toMatchObject({ code: "VERSION_CONFLICT", latestCard: { version: 2 } });
    } finally { await t.close(); }
  });

  it("keeps discussion open past 48 hours, closes immediately on request and rejects stale tokens", async () => {
    let current = new Date(start);
    const t = await createTestApp({}, undefined, { monthlyNow: () => current });
    try {
      const { roundId } = await seed(t);
      const cookie = await t.loginCookie();
      expect((await execute(t, cookie, action(t, roundId, "mission-round.open"))).statusCode).toBe(200);
      current = new Date("2026-10-03T02:00:00.000Z");
      const closed = await t.app.inject({ method: "GET", url: `/api/mission-rounds/${roundId}`, headers: { cookie } });
      expect(closed.json().cards[0]).toMatchObject({ version: 2, payload: { phase: "open", closesAt: null } });
      expect(await t.sql("SELECT id FROM mission_round_reviews")).toHaveLength(0);
      const finished = await execute(t, cookie, action(t, roundId, "mission-round.close", 2));
      expect(finished.statusCode).toBe(200);
      expect(finished.json().cards[0]).toMatchObject({ version: 3, payload: { phase: "reviewing", closesAt: current.toISOString() } });
      expect((await execute(t, cookie, action(t, roundId, "mission-round.close", 2))).statusCode).toBe(200);
      const stale = await execute(t, cookie, action(t, roundId, "mission-round.reopen", 2));
      expect(stale.statusCode).toBe(409);
      expect(stale.json().latestCard).toMatchObject({ version: 3, payload: { phase: "reviewing" } });
      expect(await t.sql("SELECT id FROM mission_round_reviews")).toHaveLength(1);
      const reopenToken = stale.json().latestCard.actions.find((a: {actionType: string}) => a.actionType === "mission-round.reopen").actionId;
      const reopened = await execute(t, cookie, reopenToken);
      expect(reopened.statusCode).toBe(200);
      expect(reopened.json().cards[0]).toMatchObject({ version: 4, payload: { phase: "open", round: 2, closesAt: null } });
    } finally { await t.close(); }
  });
});
