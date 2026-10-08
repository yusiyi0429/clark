import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { signActionId } from "../src/actionToken.js";
import { createTestApp, TEST_CEO, TEST_MEMBER, type TestApp } from "./helpers.js";

const START = new Date("2026-09-30T16:30:00.000Z"); // 公司月份为 10 月。
const CLOSE = new Date("2026-10-02T16:30:00.000Z");
const read = async (t: TestApp, cookie: string, path = "/api/me/mission-cards") => {
  const res = await t.app.inject({ method: "GET", url: path, headers: { cookie } });
  expect(res.statusCode).toBe(200); return res.json();
};
async function seed(t: TestApp) {
  const plan = randomUUID(), round = randomUUID(), mine = randomUUID(), other = randomUUID();
  await t.sql("UPDATE battlefield_config SET owner_id=$1,six_month_outcome='半年目标' WHERE id='growth'", [TEST_CEO.personId]);
  await t.sql(`INSERT INTO monthly_plans (id,version,period,status,company_outcome,battlefields,todos,negotiation,generation,confirmed_at)
    VALUES ($1,1,'2026-10','confirmed','公司目标','[{"battlefieldId":"growth","outcome":"本月目标"}]','[]',
    '{"edits":[],"checkedItemIds":[],"feedback":[],"note":""}',
    '{"status":"ready","pendingSince":null,"runId":null,"previousRunIds":[],"error":null,"generatedAt":null}',$2)`, [plan, START]);
  await t.sql(`INSERT INTO mission_rounds (id,version,battlefield_id,period,monthly_plan_id,status,draft_origin,draft_source,created_at,updated_at)
    VALUES ($1,1,'growth','2026-10',$2,'draft','placeholder','{}',$3,$3)`, [round, plan, START]);
  // 反序插入，证明通知跟 sort_order 走；另一张卡保留此人的旧成员关系，但通知只给 Owner。
  for (const [card, owner, order] of [[mine, TEST_MEMBER.personId, 2], [other, TEST_CEO.personId, 1]] as const) {
    await t.sql(`INSERT INTO personal_mission_cards (id,round_id,owner_id,sort_order,role_label,member_ids,created_at)
      VALUES ($1,$2,$3,$4,'01-3 战役',$5::jsonb,$6)`, [card, round, owner, order, JSON.stringify([TEST_CEO.personId, TEST_MEMBER.personId]), START]);
  }
  return { plan, round, mine, other };
}
async function seedMissions(t: TestApp, ids: { mine: string; other: string }) {
  for (const [id, owner] of [[ids.mine, TEST_MEMBER.personId], [ids.other, TEST_CEO.personId]]) await t.sql(`INSERT INTO missions
    (id,version,code,period,title,owner_id,capability_id,battlefield_ids,outcome,source_ref,source_document_id,source_revision,source_title,placeholder,personal_mission_card_id)
    VALUES ($1,1,$1,'2026-10','讨论候选',$2,'method','["growth"]','预期结果','fixture://source','fixture',1,'占位',true,$3)`, [id, owner, id]);
}
const execute = (t: TestApp, cookie: string, round: string, version: number, action: string, input = {}, itemId?: string) => t.app.inject({
  method: "POST", url: "/api/mission-rounds/actions/execute", headers: { cookie, origin: t.publicOrigin }, payload: {
    actionId: signActionId(t.env.sessionSecret, { actionType: `mission-round.${action}`, objectType: "mission-round", objectId: round, objectVersion: version, ...(itemId ? { itemId } : {}) }), input,
  },
});

describe("Mission Card notices and onboarding", () => {
  it("requires a person and gives Owner only their row, current approvers all sorted rows, and outsiders nothing", async () => {
    const t = await createTestApp({}, undefined, { monthlyNow: () => START });
    try {
      const ids = await seed(t); const ceo = await t.loginCookie(), member = await t.memberCookie();
      expect((await t.app.inject({ method: "GET", url: "/api/me/mission-cards" })).statusCode).toBe(401);
      let notices = await read(t, member);
      expect(notices.rounds).toHaveLength(1);
      expect(notices.rounds[0]).toMatchObject({ phase: "draft", serverNow: START.toISOString(), todo: null, approver: false });
      expect(notices.rounds[0].cards.map((c: any) => c.cardId)).toEqual([ids.mine]);
      expect(notices.rounds[0].cards[0]).toMatchObject({ line: "未开放", mine: true });
      const all = await read(t, ceo);
      expect(all.rounds[0].cards.map((c: any) => c.cardId)).toEqual([ids.other, ids.mine]);
      expect(all.rounds[0].todo).toBe("任务卡草稿已就绪，可以交给本人确认");
      await t.sql("UPDATE battlefield_config SET owner_id=$1 WHERE id='growth'", [TEST_MEMBER.personId]);
      notices = await read(t, member); expect(notices.rounds[0].cards).toHaveLength(2); expect(notices.rounds[0].approver).toBe(true);
      await t.sql("UPDATE battlefield_config SET owner_id=$1 WHERE id='growth'", [TEST_CEO.personId]);
      await t.sql("DELETE FROM personal_mission_cards WHERE id=$1", [ids.mine]);
      expect((await read(t, member)).rounds).toEqual([]);
      expect(await t.sql("SELECT * FROM notifications")).toEqual([]);
    } finally { await t.close(); }
  });

  it("进度通知随本人确认与自动核对更新，DRI确认组合后退出通知，保留正式任务入口", async () => {
    const t = await createTestApp({}, undefined, { monthlyNow: () => START, missionCardReviewAgent: { async generate() { return { candidate: {summary:"本月任务与责任已核对",findings:[]}}; } } });
    try {
      const ids=await seed(t),ceo=await t.loginCookie(),member=await t.memberCookie();
      await seedMissions(t,ids);
      expect((await execute(t,ceo,ids.round,1,"open")).statusCode).toBe(200);
      const active=(await read(t,member)).rounds[0];
      expect(active).toMatchObject({phase:"open",closesAt:null,counts:{unreviewed:2},cards:[{line:"待本人确认",contentVisible:true}]});
      expect((await read(t,ceo)).rounds[0].cards[1].contentVisible).toBe(false);
      const confirm=(id:string,cookie:string)=>t.app.inject({method:"POST",url:`/api/mission-cards/${id}/owner-confirmation`,headers:{cookie,origin:t.publicOrigin},payload:{confirmed:true,round:1,missionVersions:{[id]:1}}});
      expect((await confirm(ids.mine,member)).statusCode).toBe(200);
      const partly=(await read(t,ceo)).rounds[0];
      expect(partly.version).toBeGreaterThan(active.version);
      expect(partly.cards[1]).toMatchObject({line:"本人已确认",contentVisible:true});
      expect(partly.counts.unreviewed).toBe(1); expect(partly.todo).toContain("1/2 人已确认");
      expect((await confirm(ids.other,ceo)).statusCode).toBe(200);
      await vi.waitFor(async()=>expect((await read(t,ceo)).rounds[0].coAgentReview.status).toBe("completed"));
      const reviewed=(await read(t,ceo)).rounds[0];
      expect(reviewed).toMatchObject({phase:"reviewing",counts:{unreviewed:0,pending:0},coAgentReview:{summary:"本月任务与责任已核对"}});
      expect((await read(t,member)).rounds[0].cards[0].line).toBe("本人已确认");
      const home=(await read(t,ceo,"/api/cards/home")).cards.find((c:any)=>c.kind==="mission-round");
      expect(home.payload).toEqual(reviewed); expect(home.navigation[0].href).toBe(`/mission-cards/${ids.other}`);
      expect((await read(t,ceo,"/api/me/onboarding")).next.text).toContain("待战场 DRI 确认组合");
      expect((await execute(t,ceo,ids.round,reviewed.version,"confirm",{note:"责任组合符合目标"})).statusCode).toBe(200);
      expect((await read(t,member)).rounds).toEqual([]);
      expect((await read(t,ceo,"/api/cards/home")).cards.filter((c:any)=>c.kind==="mission-round")).toEqual([]);
      expect((await read(t,member,"/api/me/onboarding")).work.missionCards[0]).toMatchObject({cardId:ids.mine,phase:"confirmed",href:`/me/mission-cards/${ids.mine}`});
    } finally { await t.close(); }
  });

  it("adds card Owners to participating battlefields without missions, shares page status, and prioritizes an open/manually closed card over tasks", async () => {
    let now = START; const t = await createTestApp({}, undefined, { monthlyNow: () => now });
    try {
      const ids = await seed(t); const ceo = await t.loginCookie(), member = await t.memberCookie();
      await t.sql("INSERT INTO tasks (id,title,status,owner_id,created_by) VALUES ($1,'执行事项','in_progress',$2,'meeting')", [randomUUID(), TEST_MEMBER.personId]);
      let onboarding = await read(t, member, "/api/me/onboarding");
      expect(onboarding.work.battlefields).toMatchObject([{ id: "growth", name: "增长战场", monthTarget: "本月目标" }]);
      expect(onboarding.work.missions).toEqual([]);
      expect(onboarding.work.missionCards).toHaveLength(1);
      expect(onboarding.work.missionCards[0]).toMatchObject({ cardId: ids.mine, roundId: ids.round, period: "2026-10", phase: "draft", closesAt: null, placeholder: true, missionCount: 0 });
      expect((await read(t, ceo, "/api/me/onboarding")).next).toEqual({ text: "10 月任务 · 任务卡草稿已就绪，可以交给本人确认", action: "进入工作台", href: "/" });
      await seedMissions(t, ids);
      await execute(t, ceo, ids.round, 1, "open");
      onboarding = await read(t, member, "/api/me/onboarding");
      expect(onboarding.next).toEqual({ text: "10 月任务待你确认", action: "进入工作台", href: "/me" });
      const page = (await read(t, member, `/api/mission-cards/${ids.mine}`)).cards[0];
      expect(onboarding.work.missionCards[0].status).toBe(page.payload.card.status);
      now = CLOSE;
      expect((await read(t, member, "/api/me/onboarding")).next.text).toBe("10 月任务待你确认");
      expect((await execute(t, ceo, ids.round, 2, "close")).json().code).toBe("OWNERS_NOT_CONFIRMED");
      expect((await read(t, member, "/api/me/onboarding")).next.text).toBe("10 月任务待你确认");
      now = new Date("2026-11-01T02:00:00Z");
      onboarding = await read(t, member, "/api/me/onboarding");
      expect(onboarding.work.missionCards).toEqual([]);
      expect(onboarding.work).toMatchObject({ period: "2026-10", missions: [{ id: ids.mine }],
        battlefields: [{ id: "growth", monthTarget: "本月目标" }] });
      expect(onboarding.next.text).toBe("你有 1 件执行事项在推进");
      // 跨月不替代拍板；旧轮次仍在通知中，直到真正 confirmed。
      expect((await read(t, member)).rounds).toMatchObject([{ roundId: ids.round, period: "2026-10", phase: "open" }]);
      expect((await read(t, ceo, "/api/cards/home")).cards.filter((card: any) => card.kind === "mission-round")).toMatchObject([
        { payload: { roundId: ids.round, period: "2026-10", phase: "open" } },
      ]);
    } finally { await t.close(); }
  });

  it("签发后没有整理任务卡的入口：首页与引导都不提供", async () => {
    const t = await createTestApp({}, undefined, { monthlyNow: () => START });
    try {
      const ids = await seed(t); const ceo = await t.loginCookie();
      await t.sql("DELETE FROM personal_mission_cards"); await t.sql("DELETE FROM mission_rounds");
      expect((await read(t, ceo, "/api/cards/home")).cards.filter((card: any) => card.kind === "mission-round")).toEqual([]);
      expect((await read(t, ceo, "/api/me/onboarding")).next).toEqual({ text: "首页上暂时没有要你马上处理的事", action: "进入工作台", href: "/" });
      await t.sql("UPDATE monthly_plans SET status='negotiating',confirmed_at=NULL WHERE id=$1", [ids.plan]);
      expect((await read(t, ceo, "/api/me/onboarding")).next).toMatchObject({ text: "10 月的目标等你核对和签发", href: "/" });
    } finally { await t.close(); }
  });
});
