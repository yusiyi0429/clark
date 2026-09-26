import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { signActionId } from "../src/actionToken.js";
import { createTestApp, type TestApp } from "./helpers.js";

const START = new Date("2026-10-01T02:00:00.000Z");
const CLOSE = new Date("2026-10-03T02:00:00.000Z");
const NOTE = "已逐项核对跨人员依赖、冲突与协作，交付与验收边界一致。";
const get = (t: TestApp, cookie: string, card: string) => t.app.inject({ method: "GET", url: `/api/mission-cards/${card}`, headers: { cookie } });
const post = (t: TestApp, cookie: string, path: string, payload: unknown) => t.app.inject({ method: "POST", url: path, headers: { cookie, origin: t.publicOrigin }, payload });

async function setup() {
  let now = START;
  const t = await createTestApp({}, undefined, { monthlyNow: () => now });
  const plan = randomUUID(), round = randomUUID(), card = randomUUID(), other = randomUUID();
  await t.sql("UPDATE battlefield_config SET owner_id='person-fixture-001',six_month_outcome='六个月目标' WHERE id='growth'");
  await t.sql(`INSERT INTO monthly_plans (id,version,period,status,company_outcome,battlefields,todos,negotiation,generation,confirmed_at)
    VALUES ($1,1,'2026-10','confirmed','公司目标','[{"battlefieldId":"growth","outcome":"本月目标"}]','[]','{}','{}',$2)`, [plan, START]);
  await t.sql(`INSERT INTO mission_rounds (id,version,battlefield_id,period,monthly_plan_id,status,draft_origin,draft_source,created_at,updated_at)
    VALUES ($1,1,'growth','2026-10',$2,'draft','placeholder','{}',$3,$3)`, [round, plan, START]);
  for (const [id, owner, order] of [[card, "person-fixture-002", 0], [other, "another-owner", 1]] as const) {
    await t.sql(`INSERT INTO personal_mission_cards (id,round_id,owner_id,sort_order,member_ids,created_at)
      VALUES ($1,$2,$3,$4,$5::jsonb,$6)`, [id, round, owner, order, JSON.stringify([owner, "person-fixture-001"]), START]);
    await t.sql(`INSERT INTO missions (id,version,code,period,title,owner_id,capability_id,battlefield_ids,outcome,why,dependencies,success_evidence,
      source_ref,source_document_id,source_revision,source_title,placeholder,personal_mission_card_id)
      VALUES ($1,1,$1,'2026-10','草稿任务',$2,'method','["growth"]','原始结果','保留背景',E'甲\n乙','["原证据"]',
      'https://example.test/source','fixture',9,'占位',true,$3)`, [id, owner, id]);
  }
  const ceo = await t.loginCookie(), member = await t.memberCookie();
  const page = async (cookie = ceo, id = card) => (await get(t, cookie, id)).json().cards[0];
  const token = (action: string, version: number, itemId?: string) => signActionId(t.env.sessionSecret, {
    actionType: `mission-round.${action}`, objectType: "mission-round", objectId: round, objectVersion: version, ...(itemId ? { itemId } : {}),
  });
  const execute = (actionId: string, input: unknown = {}, cookie = ceo, viewCardId = card) => post(t, cookie, "/api/mission-rounds/actions/execute", { actionId, input, viewCardId });
  const act = async (action: string, input: unknown = {}, itemId?: string, cookie = ceo) => execute(token(action, (await page(cookie)).version, itemId), input, cookie);
  const send = async (kind: "comment" | "quote" | "suggestion", field = "outcome", proposed = "候选结果", id = card, window = 1) => {
    const res = await post(t, ceo, `/api/mission-cards/${id}/feedback`, { clientId: randomUUID(), kind, round: window, body: "公开意见",
      ...(kind === "comment" ? {} : { missionId: id, field, sourceVersion: 1, ...(kind === "suggestion" ? { proposed } : { quote: "原始结果" }) }) });
    expect(res.statusCode).toBe(200); return res.json().feedback;
  };
  const close = async (at = CLOSE) => {
    now = at;
    // Every action closes a due window under the round lock, even when its old token then conflicts.
    const due = await page(); await execute(token("open", due.version));
  };
  return { t, round, card, other, ceo, member, page, token, execute, act, send, close, setNow: (at: Date) => { now = at; } };
}

describe("Mission round review and confirmation", () => {
  it("projects reviewer-only decisions, snapshot counts, conflict reasons and the same verdict in page/group", async () => {
    const f = await setup(); const { t } = f;
    try {
      await f.act("open"); const a = await f.send("suggestion"), b = await f.send("suggestion", "outcome", "另一个建议");
      await f.send("comment", undefined, undefined, f.other); await f.close();
      let p = await f.page();
      expect(p.payload.round.counts).toMatchObject({ cards: 2, feedback: 3, pending: 3, conflicts: 1, dependencies: 4 });
      expect(p.payload.round.cards[0].firstPendingFeedbackId).toBe(a.id);
      expect(p.payload.feedback[0].actions).toEqual([expect.objectContaining({ actionType: "mission-round.decide", itemId: a.id })]);
      expect((await f.page(f.member)).payload.feedback.every((x: any) => x.actions.length === 0)).toBe(true);
      const beforeGroup = (await t.app.inject({ method: "GET", url: `/api/mission-cards/${f.card}/group`, headers: { cookie: f.member } })).json();
      const accepted = await f.act("decide", { decision: "accept" }, a.id); expect(accepted.statusCode).toBe(200);
      p = accepted.json().cards[0];
      expect(p.payload.card.missions[0]).toMatchObject({ outcome: "候选结果", changedFields: ["outcome"], version: 1 });
      expect(p.payload.feedback.find((x: any) => x.id === b.id).acceptBlockedReason).toBe("同一字段已采纳另一条");
      const member = await f.page(f.member);
      expect(member.payload.round.cards).toHaveLength(1); expect(member.payload.round.counts.cards).toBe(2);
      const group = (await t.app.inject({ method: "GET", url: `/api/mission-cards/${f.card}/group`, headers: { cookie: f.member } })).json();
      expect(group.roundVersion).toBe(beforeGroup.roundVersion + 1);
      expect(group.lastReadSeq).toBe(beforeGroup.lastReadSeq); expect(group.unread).toBe(beforeGroup.unread);
      expect(member.payload.feedback[0].verdict).toEqual(p.payload.feedback[0].verdict);
      expect(group.entries.find((x: any) => x.type === "message" && x.feedback.id === a.id).feedback.verdict).toEqual(p.payload.feedback[0].verdict);
      expect((await t.sql("SELECT outcome,version FROM missions WHERE id=$1", [f.card]))[0]).toEqual({ outcome: "原始结果", version: 1 });
    } finally { await t.close(); }
  });

  it("rejects early, missing, out-of-snapshot, malformed and unauthorized decisions", async () => {
    const f = await setup(); const { t } = f;
    try {
      expect((await f.act("confirm", { note: NOTE })).statusCode).toBe(409);
      await f.act("open"); const item = await f.send("comment");
      expect((await f.act("decide", { decision: "accept" }, item.id)).statusCode).toBe(409);
      await f.close(); const late = await f.send("comment");
      expect((await f.act("decide", { decision: "accept" }, late.id)).json().code).toBe("FEEDBACK_NOT_IN_REVIEW");
      expect((await f.act("decide", { decision: "accept" }, randomUUID())).statusCode).toBe(409);
      expect((await f.act("decide", { decision: "accept" })).statusCode).toBe(400);
      expect((await f.act("decide", { decision: "ignore" }, item.id)).statusCode).toBe(400);
      expect((await f.act("decide", { decision: "accept" }, item.id, f.member)).statusCode).toBe(403);
      expect((await t.sql("SELECT * FROM mission_review_decisions"))).toHaveLength(0);
    } finally { await t.close(); }
  });

  it("serializes decisions, rejects a competing acceptance, permits rejudgment and makes retries immutable", async () => {
    const f = await setup(); const { t } = f;
    try {
      await f.act("open"); const a = await f.send("suggestion"), b = await f.send("suggestion", "outcome", "另一个建议"); await f.close();
      const initial = await f.page(), token = f.token("decide", initial.version, a.id);
      const [one, two] = await Promise.all([f.execute(token, { decision: "accept" }), f.execute(token, { decision: "accept" })]);
      expect([one.statusCode, two.statusCode]).toEqual([200, 200]);
      expect(one.json().cards[0].version).toBe(two.json().cards[0].version);
      expect((await f.page()).version).toBe(initial.version + 1);
      const stale = await f.execute(f.token("decide", initial.version, b.id), { decision: "accept" });
      expect(stale.statusCode).toBe(409); expect(stale.json().latestCard.kind).toBe("personal-mission-card");
      expect((await f.act("decide", { decision: "accept" }, b.id)).json().code).toBe("CONFLICTING_SUGGESTION");
      expect((await f.act("decide", { decision: "decline" }, a.id)).statusCode).toBe(200);
      expect((await f.act("decide", { decision: "accept" }, b.id)).statusCode).toBe(200);
      expect((await f.page()).payload.card.missions[0].outcome).toBe("另一个建议");
      expect(await t.sql("SELECT * FROM mission_review_decisions")).toHaveLength(2);
    } finally { await t.close(); }
  });

  it("refuses pending feedback, empty checks and stale confirmation tokens without any mission write", async () => {
    const f = await setup(); const { t } = f;
    try {
      await f.act("open"); const a = await f.send("quote"); await f.close(); const before = await f.page();
      expect((await f.act("confirm", { note: NOTE })).json().code).toBe("REVIEW_INCOMPLETE");
      await f.act("decide", { decision: "accept" }, a.id);
      for (const note of ["", " \n ", "字".repeat(2001)]) expect((await f.act("confirm", { note })).statusCode).toBe(400);
      const stale = await f.execute(f.token("confirm", before.version), { note: NOTE });
      expect(stale.statusCode).toBe(409); expect(stale.json().code).toBe("VERSION_CONFLICT");
      expect((await t.sql("SELECT version FROM missions WHERE id=$1", [f.card]))[0].version).toBe(1);
      expect((await t.sql("SELECT status FROM mission_rounds WHERE id=$1", [f.round]))[0].status).toBe("reviewing");
    } finally { await t.close(); }
  });

  it("confirms once, writes only accepted fields, converts lists and preserves the same readonly card/history", async () => {
    const f = await setup(); const { t } = f;
    try {
      await f.act("open"); const a = await f.send("suggestion"), b = await f.send("suggestion", "successEvidence", " 证据一\n\n证据二 ");
      const ignored = await f.send("suggestion", "why", "不要写入"); await f.close();
      for (const [id, decision] of [[a.id, "accept"], [b.id, "accept"], [ignored.id, "decline"]]) expect((await f.act("decide", { decision }, id)).statusCode).toBe(200);
      await f.send("comment"); // A current-window late note is retained but cannot block confirmation.
      const ready = await f.page(); expect(ready.actions.some((a: any) => a.actionType === "mission-round.confirm")).toBe(true);
      const token = f.token("confirm", ready.version);
      const [one, two] = await Promise.all([f.execute(token, { note: ` ${NOTE} ` }), f.execute(token, { note: ` ${NOTE} ` })]);
      expect([one.statusCode, two.statusCode]).toEqual([200, 200]);
      expect(one.json().cards[0].version).toBe(ready.version + 1); expect(two.json().cards[0].version).toBe(ready.version + 1);
      const mission = (await t.sql("SELECT version,outcome,why,success_evidence,placeholder,source_revision,owner_id FROM missions WHERE id=$1", [f.card]))[0];
      expect(mission).toEqual({ version: 2, outcome: "候选结果", why: "保留背景", success_evidence: ["证据一", "证据二"], placeholder: true, source_revision: 9, owner_id: "person-fixture-002" });
      expect((await t.sql("SELECT version FROM missions WHERE id=$1", [f.other]))[0].version).toBe(1);
      expect((await t.sql("SELECT note,applied_versions FROM mission_round_reviews WHERE round_id=$1", [f.round]))[0]).toEqual({ note: NOTE, applied_versions: { [f.card]: 2 } });
      const final = await f.page(); expect(final.id).toBe(ready.id); expect(final.actions).toEqual([]);
      expect(final.payload.card.shown).toBe("confirmed"); expect(final.payload.confirmation.note).toBe(NOTE);
      expect(final.payload.feedback.find((x: any) => x.id === a.id).verdict.text).toBe("已采纳");
      expect(final.payload.feedback.every((x: any) => x.actions.length === 0)).toBe(true);
      expect((await f.act("reopen")).json().code).toBe("ROUND_CONFIRMED");
      expect((await f.act("confirm", { note: "另一核对" })).json().code).toBe("ROUND_CONFIRMED");
      expect((await post(t, f.ceo, `/api/mission-cards/${f.card}/feedback`, { clientId: randomUUID(), kind: "comment", round: 1, body: "已关闭" })).statusCode).toBe(409);
      const detail = (await t.app.inject({ method: "GET", url: `/api/cards/missions/${f.card}`, headers: { cookie: f.ceo } })).json().cards[0];
      expect(detail.payload.personalCard.status).toBe("confirmed"); expect(detail.actions).toEqual([]);
    } finally { await t.close(); }
  });

  it("checks every snapshot mission version before applying any accepted field", async () => {
    const f = await setup(); const { t } = f;
    try {
      await f.act("open"); const a = await f.send("suggestion"); await f.close(); await f.act("decide", { decision: "accept" }, a.id);
      await t.sql("UPDATE missions SET version=version+1 WHERE id=$1", [f.other]);
      const res = await f.act("confirm", { note: NOTE }); expect(res.statusCode).toBe(409); expect(res.json().code).toBe("MISSION_CHANGED");
      expect((await t.sql("SELECT version,outcome FROM missions WHERE id=$1", [f.card]))[0]).toEqual({ version: 1, outcome: "原始结果" });
      expect((await t.sql("SELECT note,applied_versions FROM mission_round_reviews WHERE round_id=$1", [f.round]))[0]).toEqual({ note: null, applied_versions: null });
    } finally { await t.close(); }
  });

  it("records confirmation without changing any Mission when no field modification was accepted", async () => {
    const f = await setup(); const { t } = f;
    try {
      await f.act("open"); const comment = await f.send("comment"); await f.close();
      expect((await f.act("decide", { decision: "accept" }, comment.id)).statusCode).toBe(200);
      expect((await f.act("confirm", { note: NOTE })).statusCode).toBe(200);
      expect((await t.sql("SELECT applied_versions FROM mission_round_reviews WHERE round_id=$1", [f.round]))[0].applied_versions).toEqual({});
      expect((await t.sql("SELECT version FROM missions WHERE personal_mission_card_id=ANY($1::uuid[])", [[f.card, f.other]])).map((m) => m.version)).toEqual([1, 1]);
    } finally { await t.close(); }
  });

  it("rechecks conflicting accepted suggestions at final confirmation", async () => {
    const f = await setup(); const { t } = f;
    try {
      await f.act("open"); const a = await f.send("suggestion"), b = await f.send("suggestion", "outcome", "另一结果"); await f.close();
      await f.act("decide", { decision: "accept" }, a.id);
      await t.sql(`INSERT INTO mission_review_decisions (review_id,feedback_id,decision,decided_by,decided_at)
        SELECT id,$2,'accept','person-fixture-001',$3 FROM mission_round_reviews WHERE round_id=$1`, [f.round, b.id, CLOSE]);
      expect((await f.act("confirm", { note: NOTE })).json().code).toBe("CONFLICTING_SUGGESTION");
      expect((await t.sql("SELECT version FROM missions WHERE id=$1", [f.card]))[0].version).toBe(1);
    } finally { await t.close(); }
  });

  it("carries accepted changes into the next candidate, includes earlier late notes, and clears collaboration checks", async () => {
    const f = await setup(); const { t } = f;
    try {
      await f.act("open"); const a = await f.send("suggestion", "dependencies", "甲\n乙\n丙"); await f.close();
      await f.act("decide", { decision: "accept" }, a.id); const late = await f.send("comment");
      await t.sql("UPDATE mission_round_reviews SET note='不应结转的旧核对' WHERE round_id=$1", [f.round]);
      expect((await f.act("reopen")).statusCode).toBe(200);
      expect((await f.page()).payload.feedback.find((x: any) => x.id === a.id).verdict.text).toBe("上一轮已采纳 · 下次截止沿用");
      expect((await f.page()).payload.feedback.find((x: any) => x.id === late.id).verdict.text).toBe("截止后留言 · 已并入这一轮");
      await f.close(new Date(CLOSE.getTime() + 48 * 3600000)); const second = await f.page();
      expect(second.payload.card.missions[0].dependencies).toBe("甲\n乙\n丙");
      expect(second.payload.round.counts).toMatchObject({ feedback: 2, pending: 1, dependencies: 5, late: 0 });
      expect(second.payload.feedback.find((x: any) => x.id === late.id).verdict.text).toBe("截止后留言 · 已并入这一轮");
      const review = (await t.sql("SELECT note FROM mission_round_reviews WHERE round_id=$1 AND window_seq=2", [f.round]))[0]; expect(review.note).toBeNull();
      expect((await t.sql("SELECT carried FROM mission_review_decisions d JOIN mission_round_reviews r ON r.id=d.review_id WHERE r.round_id=$1 AND r.window_seq=2", [f.round]))[0].carried).toBe(true);
      expect((await f.act("decide", { decision: "accept" }, late.id)).statusCode).toBe(200);
      expect((await f.act("confirm", { note: NOTE })).statusCode).toBe(200);
      expect(await t.sql("SELECT * FROM mission_round_reviews WHERE round_id=$1", [f.round])).toHaveLength(2);
      expect(await t.sql("SELECT * FROM mission_card_feedback WHERE round_id=$1", [f.round])).toHaveLength(2);
    } finally { await t.close(); }
  });

  it("rechecks current DRI authority before decide/confirm replay or latest-card disclosure", async () => {
    const f = await setup(); const { t } = f;
    try {
      await f.act("open"); const a = await f.send("comment"); await f.close();
      await t.sql("UPDATE battlefield_config SET owner_id='person-fixture-002' WHERE id='growth'");
      const token = f.token("decide", (await f.page(f.member)).version, a.id);
      expect((await f.execute(token, { decision: "accept" }, f.member)).statusCode).toBe(200);
      const confirm = f.token("confirm", (await f.page(f.member)).version);
      expect((await f.execute(confirm, { note: NOTE }, f.member)).statusCode).toBe(200);
      await t.sql("UPDATE battlefield_config SET owner_id='person-fixture-001' WHERE id='growth'");
      for (const [actionId, input] of [[token, { decision: "accept" }], [confirm, { note: NOTE }]] as const) {
        const replay = await f.execute(actionId, input, f.member); expect(replay.statusCode).toBe(403); expect(replay.json().latestCard).toBeUndefined();
      }
    } finally { await t.close(); }
  });
});
