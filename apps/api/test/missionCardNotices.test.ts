import { randomUUID } from "node:crypto";
import { mkdtemp, rm, rmdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
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
      expect(all.rounds[0].todo).toBe("个人卡草稿已就绪，可以统一开放讨论");
      await t.sql("UPDATE battlefield_config SET owner_id=$1 WHERE id='growth'", [TEST_MEMBER.personId]);
      notices = await read(t, member); expect(notices.rounds[0].cards).toHaveLength(2); expect(notices.rounds[0].approver).toBe(true);
      await t.sql("UPDATE battlefield_config SET owner_id=$1 WHERE id='growth'", [TEST_CEO.personId]);
      await t.sql("DELETE FROM personal_mission_cards WHERE id=$1", [ids.mine]);
      expect((await read(t, member)).rounds).toEqual([]);
      expect(await t.sql("SELECT * FROM notifications")).toEqual([]);
    } finally { await t.close(); }
  });

  it("keeps notices through exact cutoff and review, uses the same counts, and removes both notices only on confirmation", async () => {
    let now = START; const t = await createTestApp({}, undefined, { monthlyNow: () => now });
    try {
      const ids = await seed(t); const ceo = await t.loginCookie(), member = await t.memberCookie();
      await seedMissions(t, ids);
      expect((await execute(t, ceo, ids.round, 1, "open")).statusCode).toBe(200);
      const sent = await t.app.inject({ method: "POST", url: `/api/mission-cards/${ids.mine}/feedback`, headers: { cookie: member, origin: t.publicOrigin }, payload: { clientId: randomUUID(), kind: "comment", round: 1, body: "需要一起核对边界" } });
      expect(sent.statusCode).toBe(200);
      const feedback = sent.json().feedback.id;
      const active = (await read(t, member)).rounds[0];
      expect(active).toMatchObject({ phase: "open", closesAt: CLOSE.toISOString(), serverNow: START.toISOString() });
      expect(active.cards[0].line).toBe("1 条意见");
      now = CLOSE;
      expect((await read(t, member)).rounds[0]).toMatchObject({ phase: "closed", cards: [{ line: "汇总中" }] });
      expect(await t.sql("SELECT id FROM mission_round_reviews")).toHaveLength(0);
      const stale = await execute(t, ceo, ids.round, 2, "reopen"); expect(stale.statusCode).toBe(409);
      const review = (await read(t, ceo)).rounds[0];
      expect(review).toMatchObject({ phase: "reviewing", counts: { pending: 1 } });
      expect(review.cards[1]).toMatchObject({ line: "待处理 1", pending: 1, firstPendingFeedbackId: feedback });
      expect((await read(t, member)).rounds[0].cards[0].line).toBe("已处理 0/1");
      const home = (await read(t, ceo, "/api/cards/home")).cards.find((c: any) => c.kind === "mission-round");
      expect(home.payload).toEqual(review);
      expect(home.navigation[0].href).toBe(`/mission-cards/${ids.other}`);
      const next = (await read(t, ceo, "/api/me/onboarding")).next;
      expect(next).toEqual({ text: "10 月 Mission Card 有 1 条意见待你处理", action: "进入工作台", href: "/" });
      const decided = await execute(t, ceo, ids.round, review.version, "decide", { decision: "decline" }, feedback);
      expect(decided.statusCode).toBe(200);
      expect((await read(t, ceo, "/api/me/onboarding")).next.text).toBe("意见已全部处理，待你确认");
      const ready = (await read(t, ceo)).rounds[0]; expect(ready.todo).toBe("意见已全部处理，待你确认");
      expect((await execute(t, ceo, ids.round, ready.version, "confirm", { note: "已经核对团队边界" })).statusCode).toBe(200);
      expect((await read(t, member)).rounds).toEqual([]);
      expect((await read(t, ceo, "/api/cards/home")).cards.filter((c: any) => c.kind === "mission-round")).toEqual([]);
      const work = (await read(t, member, "/api/me/onboarding")).work;
      expect(work.missionCards[0]).toMatchObject({ cardId: ids.mine, phase: "confirmed", href: `/me/mission-cards/${ids.mine}` });
      expect(work.missionCards[0].status).toMatch(/^已确定 · 测试甲/);
    } finally { await t.close(); }
  });

  it("adds card Owners to participating battlefields without missions, shares page status, and prioritizes an open/cutoff card over tasks", async () => {
    let now = START; const t = await createTestApp({}, undefined, { monthlyNow: () => now });
    try {
      const ids = await seed(t); const ceo = await t.loginCookie(), member = await t.memberCookie();
      await t.sql("INSERT INTO tasks (id,title,status,owner_id,created_by) VALUES ($1,'执行事项','in_progress',$2,'meeting')", [randomUUID(), TEST_MEMBER.personId]);
      let onboarding = await read(t, member, "/api/me/onboarding");
      expect(onboarding.work.battlefields).toEqual([{ id: "growth", name: "增长战场", monthTarget: "本月目标" }]);
      expect(onboarding.work.missions).toEqual([]);
      expect(onboarding.work.missionCards).toHaveLength(1);
      expect(onboarding.work.missionCards[0]).toMatchObject({ cardId: ids.mine, roundId: ids.round, period: "2026-10", phase: "draft", closesAt: null, placeholder: true, missionCount: 0 });
      expect((await read(t, ceo, "/api/me/onboarding")).next).toEqual({ text: "10 月个人卡草稿已就绪，可以统一开放讨论", action: "进入工作台", href: "/" });
      await seedMissions(t, ids);
      await execute(t, ceo, ids.round, 1, "open");
      onboarding = await read(t, member, "/api/me/onboarding");
      expect(onboarding.next).toEqual({ text: "10 月 Mission Card 讨论开放到 10/3 00:30", action: "进入工作台", href: "/me" });
      const page = (await read(t, member, `/api/mission-cards/${ids.mine}`)).cards[0];
      expect(onboarding.work.missionCards[0].status).toBe(page.payload.card.status);
      now = CLOSE;
      expect((await read(t, member, "/api/me/onboarding")).next.text).toBe("10 月 Mission Card 已截止，等测试甲拍板");
      now = new Date("2026-11-01T02:00:00Z");
      onboarding = await read(t, member, "/api/me/onboarding");
      expect(onboarding.work.missionCards).toEqual([]); expect(onboarding.work.battlefields).toEqual([]);
      expect(onboarding.next.text).toBe("你有 1 件执行事项在推进");
      // 跨月不替代拍板；旧轮次仍在通知中，直到真正 confirmed。
      expect((await read(t, member)).rounds).toMatchObject([{ roundId: ids.round, period: "2026-10", phase: "closed" }]);
      expect((await read(t, ceo, "/api/cards/home")).cards.filter((card: any) => card.kind === "mission-round")).toMatchObject([
        { payload: { roundId: ids.round, period: "2026-10", phase: "closed" } },
      ]);
    } finally { await t.close(); }
  });

  it("签发后提供整理入口；没有人和占位文件时由动作返回具体提示", async () => {
    const directory = await mkdtemp(join(tmpdir(), "warmap-04d-drafts-"));
    const t = await createTestApp({ missionCardDraftsDir: directory }, undefined, { monthlyNow: () => START });
    try {
      const ids = await seed(t); const ceo = await t.loginCookie();
      await t.sql("DELETE FROM personal_mission_cards"); await t.sql("DELETE FROM mission_rounds");
      await t.sql("UPDATE battlefield_config SET code='01' WHERE id='growth'");
      expect((await read(t, ceo, "/api/me/onboarding")).next.href).toBe("/");
      await writeFile(join(directory, "2026-10-mission-cards.battlefield-01.json"), "{}", "utf8");
      expect((await read(t, ceo, "/api/me/onboarding")).next).toEqual({ text: "10 月目标已签发，可以整理个人卡草稿", action: "进入工作台", href: "/" });
      await t.sql("UPDATE monthly_plans SET status='negotiating',confirmed_at=NULL WHERE id=$1", [ids.plan]);
      expect((await read(t, ceo, "/api/me/onboarding")).next).toMatchObject({ text: "10 月的目标等你核对和签发", href: "/" });
    } finally {
      await t.close();
      await rm(join(directory, "2026-10-mission-cards.battlefield-01.json"), { force: true });
      await rmdir(directory);
    }
  });
});
