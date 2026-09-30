import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createTestApp, TEST_CEO, TEST_MEMBER, type TestApp } from "./helpers.js";

const START = new Date("2026-09-30T16:30:00.000Z");
const CLOSE = new Date("2026-10-02T16:30:00.000Z");
const read = async (t: TestApp, cookie: string, path = "/api/me/home") => {
  const response = await t.app.inject({ method: "GET", url: path, headers: { cookie } });
  expect(response.statusCode).toBe(200);
  return response.json();
};
async function seed(t: TestApp) {
  const plan = randomUUID(), round = randomUUID(), mine = randomUUID(), other = randomUUID();
  await t.sql("UPDATE battlefield_config SET owner_id=$1,six_month_outcome='半年原文' WHERE id='growth'", [TEST_CEO.personId]);
  await t.sql(`INSERT INTO battlefield_config (id,version,code,name,owner_id,six_month_outcome,sort_order) VALUES
    ('owned',1,'02','我负责的战场',$1,'负责战场半年目标',2),
    ('mission-only',1,'03','只有 Mission 的战场',$2,'Mission 战场半年目标',3),
    ('private',1,'04','看不到的战场',$2,'私有半年目标',4)`, [TEST_MEMBER.personId, TEST_CEO.personId]);
  await t.sql(`INSERT INTO monthly_plans (id,version,period,status,company_outcome,battlefields,todos,negotiation,generation,confirmed_at)
    VALUES ($1,1,'2026-10','confirmed','CEO 公司决策内容',$2::jsonb,'[]',
    '{"edits":[],"checkedItemIds":[],"feedback":[],"note":""}',
    '{"status":"ready","pendingSince":null,"runId":null,"previousRunIds":[],"error":null,"generatedAt":null}',$3)`,
  [plan, JSON.stringify(["growth", "owned", "mission-only", "private"].map((battlefieldId) => ({ battlefieldId, outcome: `${battlefieldId} 本月原文` }))), START]);
  await t.sql(`INSERT INTO mission_rounds (id,version,battlefield_id,period,monthly_plan_id,status,draft_origin,draft_source,created_at,updated_at)
    VALUES ($1,1,'growth','2026-10',$2,'draft','placeholder','{}',$3,$3)`, [round, plan, START]);
  for (const [card, owner, order] of [[mine, TEST_MEMBER.personId, 2], [other, TEST_CEO.personId, 1]] as const) {
    await t.sql(`INSERT INTO personal_mission_cards (id,round_id,owner_id,sort_order,role_label,member_ids,created_at)
      VALUES ($1,$2,$3,$4,'战役 DRI',$5::jsonb,$6)`, [card, round, owner, order, JSON.stringify([TEST_CEO.personId, owner]), START]);
  }
  await t.sql(`INSERT INTO missions (id,version,code,period,title,owner_id,capability_id,battlefield_ids,outcome,
    source_ref,source_document_id,source_revision,source_title) VALUES
    ('mission-mine',1,'mission-mine','2026-10','我的个人任务',$1,'method','["mission-only"]','我的结果','fixture','fixture',1,'测试'),
    ('mission-past',1,'mission-past','2026-09','过去月份的任务',$1,'method','["private"]','过去结果','fixture','fixture',1,'测试'),
    ('mission-other',1,'mission-other','2026-10','别人的个人任务',$2,'method','["growth"]','别人的结果','fixture','fixture',1,'测试')`, [TEST_MEMBER.personId, TEST_CEO.personId]);
  return { plan, round, mine, other };
}

describe("DRI home widgets and battlefield detail", () => {
  it("uses current DRI, current card Owner without missions, and current mission participation, sharing onboarding work", async () => {
    const t = await createTestApp({}, undefined, { monthlyNow: () => START });
    try {
      const ids = await seed(t); const cookie = await t.memberCookie();
      const home = await read(t, cookie), onboarding = await read(t, cookie, "/api/me/onboarding");
      expect(home.work.period).toBe("2026-10");
      expect(home.work.battlefields.map((b: any) => b.id)).toEqual(["growth", "owned", "mission-only"]);
      expect(home.work.battlefields.map(({ id, name, monthTarget }: any) => ({ id, name, monthTarget }))).toEqual(onboarding.work.battlefields);
      expect(home.work.battlefields.map((b: any) => b.isDri)).toEqual([false, true, false]);
      expect(home.work.missionCards).toEqual(onboarding.work.missionCards);
      expect(home.work.missionCards[0]).toMatchObject({ cardId: ids.mine, phase: "draft", missionCount: 0, placeholder: true });
      expect(home.work.missions).toEqual(onboarding.work.missions);
      expect(JSON.stringify(home)).not.toContain("半年原文");
      expect(home.myTasks).toEqual([]);
    } finally { await t.close(); }
  });

  it("projects absent, negotiating and issued monthly targets without disclosing a draft or inventing missing registration", async () => {
    const t = await createTestApp({}, undefined, { monthlyNow: () => START });
    try {
      const ids = await seed(t); const cookie = await t.memberCookie();
      const target = async () => (await read(t, cookie)).work.battlefields.find((b: any) => b.id === "owned");
      expect(await target()).toMatchObject({ monthTargetState: "confirmed", monthTarget: "owned 本月原文", monthTargetText: "owned 本月原文" });
      await t.sql("UPDATE monthly_plans SET status='negotiating',confirmed_at=NULL WHERE id=$1", [ids.plan]);
      expect(await target()).toMatchObject({ monthTargetState: "negotiating", monthTarget: null, monthTargetText: "本月目标还在协商" });
      await t.sql("UPDATE monthly_plans SET status='draft' WHERE id=$1", [ids.plan]);
      expect(await target()).toMatchObject({ monthTargetState: "negotiating", monthTarget: null, monthTargetText: "本月目标还在协商" });
      await t.sql("UPDATE monthly_plans SET period='2026-09' WHERE id=$1", [ids.plan]);
      expect(await target()).toMatchObject({ monthTargetState: "none", monthTarget: null, monthTargetText: "本月目标还没出来" });
      await t.sql("UPDATE monthly_plans SET period='2026-10',status='confirmed',battlefields='[]' WHERE id=$1", [ids.plan]);
      expect(await target()).toMatchObject({ monthTargetState: "confirmed", monthTarget: null, monthTargetText: "这个战场的本月目标还没有登记" });
    } finally { await t.close(); }
  });

  it("requires a session and returns 404 for unknown, unrelated, historical-only or withdrawn DRI battlefields", async () => {
    const t = await createTestApp({}, undefined, { monthlyNow: () => START });
    try {
      await seed(t); const cookie = await t.memberCookie();
      for (const path of ["/api/me/home", "/api/me/battlefields/growth"]) expect((await t.app.inject({ method: "GET", url: path })).statusCode).toBe(401);
      for (const id of ["private", "unknown"]) expect((await t.app.inject({ method: "GET", url: `/api/me/battlefields/${id}`, headers: { cookie } })).statusCode).toBe(404);
      expect((await read(t, cookie, "/api/me/battlefields/owned")).isDri).toBe(true);
      await t.sql("UPDATE battlefield_config SET owner_id=$1 WHERE id='owned'", [TEST_CEO.personId]);
      expect((await t.app.inject({ method: "GET", url: "/api/me/battlefields/owned", headers: { cookie } })).statusCode).toBe(404);
      // Stored card membership alone does not make someone a participant in this battlefield.
      await t.sql("DELETE FROM personal_mission_cards WHERE owner_id=$1", [TEST_MEMBER.personId]);
      await t.sql("UPDATE personal_mission_cards SET member_ids=$1::jsonb", [JSON.stringify([TEST_CEO.personId, TEST_MEMBER.personId])]);
      expect((await t.app.inject({ method: "GET", url: "/api/me/battlefields/growth", headers: { cookie } })).statusCode).toBe(404);
    } finally { await t.close(); }
  });

  it("shows the monthly roster but opens only own cards for members and every card for the current DRI", async () => {
    const t = await createTestApp({}, undefined, { monthlyNow: () => START });
    try {
      const ids = await seed(t); const cookie = await t.memberCookie();
      let detail = await read(t, cookie, "/api/me/battlefields/growth");
      expect(detail).toMatchObject({ id: "growth", sixMonthOutcome: "半年原文", monthTargetText: "growth 本月原文", ownerName: "测试甲", isDri: false });
      expect(detail.missionCards.map((c: any) => ({ cardId: c.cardId, canOpen: c.canOpen, href: c.href }))).toEqual([
        { cardId: ids.other, canOpen: false, href: null }, { cardId: ids.mine, canOpen: true, href: `/me/mission-cards/${ids.mine}` },
      ]);
      expect(detail.round).toMatchObject({ phase: "draft", approver: false });
      expect(detail.round.cards.map((c: any) => c.cardId)).toEqual([ids.mine]);
      expect(detail.myMissions).toEqual([]);
      expect(detail).not.toHaveProperty("issues"); expect(JSON.stringify(detail)).not.toContain("CEO 公司决策内容");
      await t.sql("UPDATE battlefield_config SET owner_id=$1 WHERE id='growth'", [TEST_MEMBER.personId]);
      detail = await read(t, cookie, "/api/me/battlefields/growth");
      expect(detail.isDri).toBe(true); expect(detail.round.approver).toBe(true);
      expect(detail.missionCards.every((c: any) => c.canOpen && c.href)).toBe(true);
      expect(detail.round.cards).toHaveLength(2);
      const missionOnly = await read(t, cookie, "/api/me/battlefields/mission-only");
      expect(missionOnly.myMissions).toMatchObject([{ missionId: "mission-mine", personalCard: null, placeholder: false }]);
    } finally { await t.close(); }
  });

  it("retains confirmed cards and confirmation, and falls back to prior missions when the next month is empty", async () => {
    let now = START; const t = await createTestApp({}, undefined, { monthlyNow: () => now });
    try {
      const ids = await seed(t); const cookie = await t.memberCookie();
      await t.sql("UPDATE mission_rounds SET status='open',window_seq=1,first_opened_at=$2,opened_at=$2,closes_at=$3 WHERE id=$1", [ids.round, START, CLOSE]);
      expect((await read(t, cookie)).work.missionCards[0]).toMatchObject({ phase: "open", closesAt: CLOSE.toISOString(), serverNow: START.toISOString() });
      now = CLOSE;
      expect((await read(t, cookie, "/api/me/battlefields/growth")).round.phase).toBe("closed");
      expect(await t.sql("SELECT id FROM mission_round_reviews")).toEqual([]);
      await t.sql("UPDATE mission_rounds SET status='confirmed',confirmed_by=$2,confirmed_at=$3 WHERE id=$1", [ids.round, TEST_CEO.personId, CLOSE]);
      expect((await read(t, cookie, "/api/me/mission-cards")).rounds).toEqual([]);
      const home = await read(t, cookie); expect(home.work.missionCards[0]).toMatchObject({ cardId: ids.mine, phase: "confirmed" });
      const detail = await read(t, cookie, "/api/me/battlefields/growth");
      expect(detail.confirmation).toEqual({ byName: "测试甲", at: CLOSE.toISOString() });
      expect(detail.round.phase).toBe("confirmed");
      expect(detail.missionCards.find((c: any) => c.cardId === ids.mine).canOpen).toBe(true);
      now = new Date("2026-11-01T01:00:00Z");
      expect((await read(t, cookie)).work.missionCards).toEqual([]);
      expect((await t.app.inject({ method: "GET", url: "/api/me/battlefields/growth", headers: { cookie } })).statusCode).toBe(404);
      expect((await read(t, cookie)).work).toMatchObject({ period: "2026-10", missions: [{ id: "mission-mine" }] });
      expect((await read(t, cookie)).work.battlefields.map((b: any) => b.id)).toEqual(["owned", "mission-only"]);
    } finally { await t.close(); }
  });
});
