import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { signActionId } from "../src/actionToken.js";
import type { MissionCardReviewAgent } from "../src/missionCardReview.js";
import { createTestApp, type TestApp, TEST_CEO, TEST_MEMBER } from "./helpers.js";

const START = new Date("2026-10-01T02:00:00.000Z");
const CLOSE = new Date("2026-10-03T02:00:00.000Z");
const NOTE = "已逐项核对跨人员依赖、冲突与协作，交付与验收边界一致。";
const get = (t: TestApp, cookie: string, card: string) => t.app.inject({ method: "GET", url: `/api/mission-cards/${card}`, headers: { cookie } });
const post = (t: TestApp, cookie: string, path: string, payload: unknown) => t.app.inject({ method: "POST", url: path, headers: { cookie, origin: t.publicOrigin }, payload });
const report: MissionCardReviewAgent["generate"] = async (input) => ({ candidate: {
  summary: "按真实任务、依赖与记录核对任务组合", findings: [{ kind: "suggestion", title: "核对跨人交接", body: "两位责任人的依赖甲、乙需明确交接", sources: input.cards.map((card) => ({
    cardId: card.cardId, missionId: String(card.missions[0].missionId), field: "outcome", version: Number(card.missions[0].version), quote: "原始结果",
  })) }],
} });

async function setup(reviewAgent: MissionCardReviewAgent = { generate: report }) {
  let now = START;
  const generate = vi.fn(reviewAgent.generate);
  const t = await createTestApp({}, undefined, { monthlyNow: () => now, missionCardReviewAgent: { generate }, missionCardAnnotationAgent: {
    async generate() { return { candidate: { action: "apply", proposed: "甲\n乙\n丙", reason: "本人补齐交接依赖", question: null, options: [] } }; },
  } });
  const plan = randomUUID(), round = randomUUID(), card = randomUUID(), other = randomUUID();
  // This fixture's CEO also owns this battlefield. The CEO role alone confers no combination approval authority.
  await t.sql("UPDATE battlefield_config SET owner_id=$1,six_month_outcome='六个月目标' WHERE id='growth'", [TEST_CEO.personId]);
  await t.sql(`INSERT INTO monthly_plans (id,version,period,status,company_outcome,battlefields,todos,negotiation,generation,confirmed_at)
    VALUES ($1,1,'2026-10','confirmed','公司目标','[{"battlefieldId":"growth","outcome":"本月目标"}]','[]','{}','{}',$2)`, [plan, START]);
  await t.sql(`INSERT INTO mission_rounds (id,version,battlefield_id,period,monthly_plan_id,status,draft_origin,draft_source,created_at,updated_at)
    VALUES ($1,1,'growth','2026-10',$2,'draft','agent','{}',$3,$3)`, [round, plan, START]);
  for (const [id, owner, order] of [[card, TEST_MEMBER.personId, 0], [other, TEST_CEO.personId, 1]] as const) {
    await t.sql(`INSERT INTO personal_mission_cards (id,round_id,owner_id,sort_order,member_ids,created_at)
      VALUES ($1,$2,$3,$4,$5::jsonb,$6)`, [id, round, owner, order, JSON.stringify([...new Set([owner, TEST_CEO.personId])]), START]);
    await t.sql(`INSERT INTO missions (id,version,code,period,title,owner_id,capability_id,battlefield_ids,outcome,why,dependencies,success_evidence,
      source_ref,source_document_id,source_revision,source_title,placeholder,personal_mission_card_id)
      VALUES ($1,1,$1,'2026-10','草稿任务',$2,'method','["growth"]','原始结果','保留背景',E'甲\n乙','["原证据"]',
      'https://example.test/source','fixture',9,'隔离测试',false,$3)`, [id, owner, id]);
  }
  const ceo = await t.loginCookie(), member = await t.memberCookie();
  const page = async (cookie = ceo, id = card) => (await get(t, cookie, id)).json().cards[0];
  const summary = async (cookie = ceo) => (await t.app.inject({ method: "GET", url: `/api/mission-rounds/${round}`, headers: { cookie } })).json().cards[0];
  const token = (action: string, version: number, itemId?: string) => signActionId(t.env.sessionSecret, {
    actionType: `mission-round.${action}`, objectType: "mission-round", objectId: round, objectVersion: version, ...(itemId ? { itemId } : {}),
  });
  const execute = (actionId: string, input: unknown = {}, cookie = ceo) => post(t, cookie, "/api/mission-rounds/actions/execute", { actionId, input });
  const act = async (action: string, input: unknown = {}, itemId?: string, cookie = ceo) => execute(token(action, (await summary(cookie)).version, itemId), input, cookie);
  const send = async (kind: "comment" | "quote" | "suggestion", field = "outcome", proposed = "候选结果", id = card) => {
    const cookie = id === card ? member : ceo;
    const res = await post(t, cookie, `/api/mission-cards/${id}/feedback`, { clientId: randomUUID(), kind, round: 1, body: "本人保留的意见",
      ...(kind === "comment" ? {} : { missionId: id, field, sourceVersion: 1, ...(kind === "suggestion" ? { proposed } : { quote: "原始结果" }) }) });
    expect(res.statusCode, res.body).toBe(200); return res.json().feedback;
  };
  const confirmOwner = async (id = card, cookie = member) => {
    const current = await page(cookie, id);
    return post(t, cookie, `/api/mission-cards/${id}/owner-confirmation`, { confirmed: true, round: current.payload.round.round,
      missionVersions: Object.fromEntries(current.payload.card.missions.map((mission: any) => [mission.missionId, mission.version])) });
  };
  const close = async (at = CLOSE) => {
    now = at;
    expect((await confirmOwner(other, ceo)).statusCode).toBe(200);
    const last = await confirmOwner(); expect(last.statusCode, last.body).toBe(200);
    await vi.waitFor(async () => expect((await summary()).payload.coAgentReview.status).toBe("completed"));
  };
  return { t, round, card, other, ceo, member, page, summary, token, execute, act, send, close, confirmOwner, generate, setNow: (at: Date) => { now = at; } };
}

describe("Mission combination Review and DRI confirmation", () => {
  it("hides preparation from superiors, freezes sources and retains the same historical verdict in page/group", async () => {
    const f = await setup(); const { t } = f;
    try {
      expect((await f.act("open")).statusCode).toBe(200);
      expect((await get(t, f.ceo, f.card)).statusCode).toBe(404);
      expect((await f.summary()).payload.cards.find((card: any) => card.cardId === f.card)).toMatchObject({ contentVisible: false, ownerConfirmedAt: null });
      const a = await f.send("suggestion"), b = await f.send("suggestion", "outcome", "另一个建议");
      await f.send("comment", undefined, undefined, f.other);
      const beforeGroup = (await t.app.inject({ method: "GET", url: `/api/mission-cards/${f.card}/group`, headers: { cookie: f.member } })).json();
      await f.close(); const p = await f.page();
      expect((await f.summary()).payload.coAgentReview).toMatchObject({ status: "completed", findings: [expect.objectContaining({ sources: expect.arrayContaining([
        expect.objectContaining({ cardId: f.card, missionId: f.card, field: "outcome", version: 1, quote: "原始结果" }),
        expect.objectContaining({ cardId: f.other, missionId: f.other, field: "outcome", version: 1 }),
      ]) })] });
      expect(p.payload.card.missions[0]).toMatchObject({ outcome: "原始结果", dependencies: "甲\n乙", successEvidence: ["原证据"], version: 1 });
      expect(p.payload.feedback.map((item: any) => item.id)).toEqual(expect.arrayContaining([a.id, b.id]));
      expect(p.payload.feedback.every((item: any) => item.actions.length === 0)).toBe(true);
      const member = await f.page(f.member), group = (await t.app.inject({ method: "GET", url: `/api/mission-cards/${f.card}/group`, headers: { cookie: f.member } })).json();
      expect(member.payload.round.cards).toHaveLength(1); expect(member.payload.round.counts.cards).toBe(2);
      expect(group.roundVersion).toBeGreaterThan(beforeGroup.roundVersion);
      expect(group.lastReadSeq).toBe(beforeGroup.lastReadSeq); expect(group.unread).toBe(beforeGroup.unread);
      expect(member.payload.feedback[0].verdict).toEqual(p.payload.feedback[0].verdict);
      expect(group.entries.find((item: any) => item.type === "message" && item.feedback.id === a.id).feedback.verdict).toEqual(p.payload.feedback.find((item: any) => item.id === a.id).verdict);
      const snapshot = (await t.sql("SELECT mission_versions,feedback_ids FROM mission_round_reviews WHERE round_id=$1", [f.round]))[0];
      expect(snapshot.mission_versions).toEqual({ [f.card]: 1, [f.other]: 1 }); expect(snapshot.feedback_ids).toEqual(expect.arrayContaining([a.id, b.id]));
      expect(f.generate.mock.calls[0][0].cards).toHaveLength(2);
    } finally { await t.close(); }
  });

  it("rejects legacy decision writes, malformed requests and callers without current DRI authority", async () => {
    const f = await setup(); const { t } = f;
    try {
      expect((await f.act("confirm", { note: NOTE })).statusCode).toBe(409);
      await f.act("open"); const item = await f.send("comment");
      expect((await f.act("decide", { decision: "accept" }, item.id)).json().code).toBe("OWNER_RECONFIRMATION_REQUIRED");
      await f.close();
      for (const id of [item.id, randomUUID()]) for (const decision of ["accept", "decline"]) {
        expect((await f.act("decide", { decision }, id)).json().code).toBe("OWNER_RECONFIRMATION_REQUIRED");
      }
      expect((await f.act("decide", { decision: "accept" })).json().code).toBe("OWNER_RECONFIRMATION_REQUIRED");
      expect((await f.act("decide", { decision: "ignore" }, item.id)).statusCode).toBe(400);
      expect((await f.execute("invalid-signed-action", { decision: "accept" })).statusCode).toBe(404);
      expect((await f.act("decide", { decision: "accept" }, item.id, f.member)).statusCode).toBe(403);
      expect((await f.act("confirm", { note: NOTE }, undefined, f.member)).statusCode).toBe(403);
      expect(await t.sql("SELECT * FROM mission_review_decisions")).toHaveLength(0);
      expect((await t.sql("SELECT outcome,version FROM missions WHERE id=$1", [f.card]))[0]).toEqual({ outcome: "原始结果", version: 1 });
    } finally { await t.close(); }
  });

  it("serializes last-owner confirmations, runs one Review and makes DRI confirmation retries immutable", async () => {
    const f = await setup(); const { t } = f;
    try {
      await f.act("open"); await f.confirmOwner(f.other, f.ceo);
      const [owner, ownerRetry] = await Promise.all([f.confirmOwner(), f.confirmOwner()]);
      expect([owner.statusCode, ownerRetry.statusCode]).toEqual([200, 200]);
      await vi.waitFor(async () => expect((await f.summary()).payload.coAgentReview.status).toBe("completed"));
      expect(f.generate).toHaveBeenCalledTimes(1); expect(await t.sql("SELECT * FROM mission_round_reviews WHERE round_id=$1", [f.round])).toHaveLength(1);
      const ready = await f.summary(), token = f.token("confirm", ready.version);
      const [one, two] = await Promise.all([f.execute(token, { note: ` ${NOTE} ` }), f.execute(token, { note: ` ${NOTE} ` })]);
      expect([one.statusCode, two.statusCode]).toEqual([200, 200]);
      expect(one.json().cards[0].version).toBe(ready.version + 1); expect(two.json().cards[0].version).toBe(ready.version + 1);
      expect((await t.sql("SELECT version,outcome,why,success_evidence,placeholder,source_revision,owner_id FROM missions WHERE id=$1", [f.card]))[0]).toEqual({
        version: 1, outcome: "原始结果", why: "保留背景", success_evidence: ["原证据"], placeholder: false, source_revision: 9, owner_id: TEST_MEMBER.personId,
      });
      expect((await t.sql("SELECT note,applied_versions FROM mission_round_reviews WHERE round_id=$1", [f.round]))[0]).toEqual({ note: NOTE, applied_versions: null });
      const final = await f.page(); expect(final.payload.card.shown).toBe("confirmed"); expect(final.payload.confirmation.note).toBe(NOTE);
      expect((await f.summary()).actions).toEqual([]);
      expect((await f.act("confirm", { note: "另一核对" })).json().code).toBe("ROUND_CONFIRMED");
    } finally { await t.close(); }
  });

  it("refuses incomplete Agent review, empty checks and stale confirmation tokens without mission writes", async () => {
    let release: ((value: Awaited<ReturnType<MissionCardReviewAgent["generate"]>>) => void) | undefined;
    const f = await setup({ generate: () => new Promise((resolve) => { release = resolve; }) }); const { t } = f;
    try {
      await f.act("open"); const before = await f.summary();
      await f.confirmOwner(f.other, f.ceo); await f.confirmOwner(); await vi.waitFor(() => expect(release).toBeDefined());
      expect((await f.act("confirm", { note: NOTE })).json().code).toBe("CO_AGENT_REVIEW_INCOMPLETE");
      const args = f.generate.mock.calls[0]; release!(await report(...args));
      await vi.waitFor(async () => expect((await f.summary()).payload.coAgentReview.status).toBe("completed"));
      for (const note of ["", " \n ", "字".repeat(2001)]) expect((await f.act("confirm", { note })).statusCode).toBe(400);
      const stale = await f.execute(f.token("confirm", before.version), { note: NOTE });
      expect(stale.statusCode).toBe(409); expect(stale.json().code).toBe("VERSION_CONFLICT");
      expect((await t.sql("SELECT version FROM missions WHERE id=$1", [f.card]))[0].version).toBe(1);
      expect((await t.sql("SELECT status FROM mission_rounds WHERE id=$1", [f.round]))[0].status).toBe("reviewing");
      expect((await t.sql("SELECT note FROM mission_round_reviews WHERE round_id=$1", [f.round]))[0].note).toBeNull();
    } finally { release?.({ candidate: { summary: "关闭测试", findings: [] } }); await t.close(); }
  });

  it("rechecks all snapshot versions and owner stamps before recording combination approval", async () => {
    const f = await setup(); const { t } = f;
    try {
      await f.act("open"); await f.close();
      await t.sql("UPDATE missions SET version=version+1 WHERE id=$1", [f.other]);
      const changed = await f.act("confirm", { note: NOTE }); expect(changed.statusCode).toBe(409); expect(changed.json().code).toBe("MISSION_CHANGED");
      expect((await t.sql("SELECT version,outcome FROM missions WHERE id=$1", [f.card]))[0]).toEqual({ version: 1, outcome: "原始结果" });
      await t.sql("UPDATE missions SET version=1 WHERE id=$1", [f.other]);
      await t.sql("UPDATE personal_mission_cards SET owner_confirmed_at=NULL WHERE id=$1", [f.other]);
      expect((await f.act("confirm", { note: NOTE })).json().code).toBe("OWNERS_NOT_CONFIRMED");
      expect((await t.sql("SELECT note,applied_versions FROM mission_round_reviews WHERE round_id=$1", [f.round]))[0]).toEqual({ note: null, applied_versions: null });
    } finally { await t.close(); }
  });

  it("retains historical suggestions as evidence and never substitutes them for owner-confirmed text", async () => {
    const f = await setup(); const { t } = f;
    try {
      await f.act("open"); const a = await f.send("suggestion"), b = await f.send("suggestion", "successEvidence", "证据一\n证据二");
      await f.close();
      for (const id of [a.id, b.id]) expect((await f.act("decide", { decision: "accept" }, id)).json().code).toBe("OWNER_RECONFIRMATION_REQUIRED");
      expect((await f.act("confirm", { note: NOTE })).statusCode).toBe(200);
      expect((await t.sql("SELECT outcome,success_evidence,version FROM missions WHERE id=$1", [f.card]))[0]).toEqual({ outcome: "原始结果", success_evidence: ["原证据"], version: 1 });
      expect((await f.page(f.member)).payload.feedback.map((item: any) => item.id)).toEqual(expect.arrayContaining([a.id, b.id]));
      expect((await post(t, f.member, `/api/mission-cards/${f.card}/feedback`, { clientId: randomUUID(), kind: "comment", round: 1, body: "已冻结" })).statusCode).toBe(409);
    } finally { await t.close(); }
  });

  it("returns only affected owners, keeps previous snapshots immutable and reviews real edits with original comments", async () => {
    const f = await setup(); const { t } = f;
    try {
      await f.act("open"); const note = await f.send("comment"); await f.close();
      const initial = (await t.sql("SELECT * FROM mission_round_reviews WHERE round_id=$1", [f.round]))[0];
      expect((await f.act("reopen")).json().code).toBe("SELECT_AFFECTED_CARDS");
      const returned = await post(t, f.ceo, `/api/mission-rounds/${f.round}/return-cards`, { cardIds: [f.card], reason: "请补齐交接依赖", version: (await f.summary()).version });
      expect(returned.statusCode, returned.body).toBe(200);
      expect((await t.sql("SELECT owner_confirmed_at FROM personal_mission_cards WHERE id=$1", [f.other]))[0].owner_confirmed_at).not.toBeNull();
      expect((await get(t, f.ceo, f.card)).statusCode).toBe(404);
      expect((await f.page(f.member)).payload.selfReview.returnReason).toBe("请补齐交接依赖");
      const edit = await post(t, f.member, `/api/mission-cards/${f.card}/annotations`, { clientId: randomUUID(), intent: "edit", missionId: f.card, field: "dependencies", sourceVersion: 1,
        sourceRound: 2, sourceText: "甲\n乙", quote: "甲", prefix: "", suffix: " 乙", startOffset: 0, body: "补上依赖丙" });
      expect(edit.statusCode, edit.body).toBe(200);
      await vi.waitFor(async () => expect((await t.app.inject({ method: "GET", url: `/api/mission-cards/${f.card}/annotations`, headers: { cookie: f.member } })).json().annotations[0].status).toBe("applied"));
      expect((await f.confirmOwner()).statusCode).toBe(200);
      await vi.waitFor(async () => expect((await f.summary()).payload.coAgentReview.status).toBe("completed"));
      const reviews = await t.sql("SELECT * FROM mission_round_reviews WHERE round_id=$1 ORDER BY window_seq", [f.round]);
      expect(reviews).toHaveLength(2); expect(reviews[0].agent_report).toEqual(initial.agent_report); expect(reviews[0].mission_versions).toEqual(initial.mission_versions);
      expect(reviews[0].superseded_at).not.toBeNull(); expect(reviews[1].note).toBeNull(); expect(reviews[1].mission_versions).toEqual({ [f.card]: 2, [f.other]: 1 });
      expect(reviews[1].feedback_ids).toContain(note.id);
      const input = f.generate.mock.calls.at(-1)![0].cards.find((card) => card.cardId === f.card)!;
      expect(input.missions[0]).toMatchObject({ version: 2, dependencies: "甲\n乙\n丙" });
      expect(input.annotations[0]).toMatchObject({ status: "applied", body: "补上依赖丙", source_text: "甲\n乙" });
      expect(input.revisions[0]).toMatchObject({ before_text: "甲\n乙", after_text: "甲\n乙\n丙" });
      expect((await f.act("confirm", { note: NOTE })).statusCode).toBe(200);
      expect((await t.sql("SELECT dependencies,version FROM missions WHERE id=$1", [f.card]))[0]).toEqual({ dependencies: "甲\n乙\n丙", version: 2 });
    } finally { await t.close(); }
  });

  it("rechecks current battlefield DRI authority before confirmation replay or stale-card disclosure", async () => {
    const f = await setup(); const { t } = f;
    try {
      await f.act("open"); await f.close();
      await t.sql("UPDATE battlefield_config SET owner_id=$1 WHERE id='growth'", [TEST_MEMBER.personId]);
      const before = await f.summary(f.member), confirm = f.token("confirm", before.version);
      expect((await f.execute(confirm, { note: NOTE })).statusCode).toBe(403);
      expect((await f.execute(confirm, { note: NOTE }, f.member)).statusCode).toBe(200);
      await t.sql("UPDATE battlefield_config SET owner_id=$1 WHERE id='growth'", [TEST_CEO.personId]);
      for (const actionId of [confirm, f.token("confirm", before.version - 1)]) {
        const replay = await f.execute(actionId, { note: NOTE }, f.member); expect(replay.statusCode).toBe(403); expect(replay.json().latestCard).toBeUndefined();
      }
    } finally { await t.close(); }
  });
});
