import { randomUUID } from "node:crypto";
import { Value } from "@sinclair/typebox/value";
import { PersonalMissionCardPayload, type TPersonalMissionCardPayload } from "@warmap/contracts";
import { describe, expect, it, vi } from "vitest";
import { applyMissionCardRevision, createMissionCardAnnotation, resolveMissionCardAnnotation } from "../src/missionCardAnnotations.js";
import { createMissionCardAnnotationQueue } from "../src/missionCardAnnotationQueue.js";
import { closeDueRounds } from "../src/missionRounds.js";
import { createCompanyContext } from "../src/companyContext.js";
import { signActionId } from "../src/actionToken.js";
import type { MissionCardReviewAgent } from "../src/missionCardReview.js";
import { createTestApp } from "./helpers.js";

const START = new Date("2026-10-01T02:00:00.000Z");
const OWNER = { personId: "person-fixture-002", role: "member" as const };
const CEO = { personId: "person-fixture-001", role: "ceo" as const };
async function setup() {
  let now = START;
  const review = vi.fn<MissionCardReviewAgent["generate"]>(async () => ({ candidate: { summary: "按本人已确认的任务、备注和修订核对组合", findings: [] } }));
  const t = await createTestApp({}, undefined, { monthlyNow: () => now, missionCardReviewAgent: { generate: review }, missionCardAnnotationAgent: {
    async generate() { return { candidate: { action: "no_change", proposed: null, reason: "保留现状", question: null, options: [] } }; },
  } });
  const plan = randomUUID(), round = randomUUID(), card = randomUUID(), other = randomUUID();
  await t.sql("UPDATE battlefield_config SET owner_id=$1,six_month_outcome='长期目标' WHERE id='growth'", [CEO.personId]);
  await t.sql(`INSERT INTO monthly_plans (id,version,period,status,company_outcome,battlefields,todos,negotiation,generation,confirmed_at)
    VALUES ($1,1,'2026-10','confirmed','公司目标','[{"battlefieldId":"growth","outcome":"本月目标"}]','[]','{}','{}',$2)`, [plan, now]);
  await t.sql(`INSERT INTO mission_rounds (id,version,battlefield_id,period,monthly_plan_id,status,draft_origin,draft_source,created_at,updated_at)
    VALUES ($1,1,'growth','2026-10',$2,'draft','agent','{}',$3,$3)`, [round, plan, now]);
  for (const [id, owner] of [[card, OWNER.personId], [other, CEO.personId]]) {
    await t.sql(`INSERT INTO personal_mission_cards (id,round_id,owner_id,sort_order,member_ids,created_at)
      VALUES ($1,$2,$3,0,$4::jsonb,$5)`, [id, round, owner, JSON.stringify([OWNER.personId, CEO.personId]), now]);
    await t.sql(`INSERT INTO missions (id,version,code,period,title,owner_id,capability_id,battlefield_ids,outcome,success_evidence,personal_mission_card_id,source_ref,source_document_id,source_revision,source_title)
      VALUES ($1::text,1,$1::text,'2026-10','任务',$2,'method','["growth"]','原始结果','["证据"]',$1::uuid,'fixture://source','fixture',1,'真实起草测试来源')`, [id, owner]);
  }
  const member = await t.memberCookie(), ceo = await t.loginCookie(), people = createCompanyContext(t.env).searchPeople(undefined);
  const get = (url: string, cookie = ceo) => t.app.inject({ method: "GET", url, headers: { cookie } });
  const post = (url: string, payload: unknown, cookie = ceo) => t.app.inject({ method: "POST", url, payload, headers: { cookie, origin: t.publicOrigin } });
  const page = async (id = card, cookie = member) => {
    const result = await get(`/api/mission-cards/${id}`, cookie);
    expect(result.statusCode, result.body).toBe(200);
    const resultCard = result.json().cards[0];
    expect(Value.Check(PersonalMissionCardPayload, resultCard.payload)).toBe(true);
    return resultCard;
  };
  const summary = async () => (await get(`/api/mission-rounds/${round}`)).json().cards[0];
  const act = async (type: string, input: unknown = {}, itemId?: string) => {
    const current = await summary();
    // These legacy signed requests must still fail safely even though the current UI does not issue them.
    const action = current.actions.find((entry: { actionType: string }) => entry.actionType === `mission-round.${type}`);
    const actionId = action?.actionId ?? signActionId(t.env.sessionSecret, { actionType: `mission-round.${type}`, objectType: "mission-round", objectId: round, objectVersion: current.version, ...(itemId ? { itemId } : {}) });
    return post("/api/mission-rounds/actions/execute", { actionId, input });
  };
  const confirm = async (confirmed = true, id = card, cookie = member, window = 1, versions?: Record<string, number>) => {
    const current = await page(id, cookie);
    const missionVersions = versions ?? Object.fromEntries(current.payload.card.missions.map((m: { missionId: string; version: number }) => [m.missionId, m.version]));
    return post(`/api/mission-cards/${id}/owner-confirmation`, { confirmed, round: window, missionVersions }, cookie);
  };
  const edit = async (proposed: string, sourceRound = 1, author = OWNER, annotationId?: string) => {
    const mission = (await page()).payload.card.missions[0];
    return applyMissionCardRevision(t.pool, people, t.env.sessionSecret, author, card, {
      missionId: card, field: "outcome", sourceRound, sourceVersion: mission.version, sourceText: mission.outcome,
      proposed, reason: "明确修改", clientId: randomUUID(), ...(annotationId ? { annotationId } : {}),
    }, () => now, "agent");
  };
  const send = async (proposed?: string) => {
    const mission = (await page()).payload.card.missions[0];
    const result = await post(`/api/mission-cards/${card}/feedback`, { clientId: randomUUID(), round: (await page()).payload.round.round,
      body: "公开意见", kind: proposed ? "suggestion" : "comment", ...(proposed ? { missionId: card, field: "outcome", sourceVersion: mission.version, proposed } : {}) }, member);
    expect(result.statusCode, result.body).toBe(200); return result.json().feedback;
  };
  const pending = async (status: "queued" | "applying" | "needs_clarification" | "failed" | "saved") => {
    const id = randomUUID();
    await t.sql(`INSERT INTO mission_card_annotations (id,card_id,mission_id,field,source_version,source_text,quote,prefix,suffix,start_offset,body,author_id,client_id,status,question,options,created_at,updated_at,intent,initial_intent)
      VALUES ($1,$2::uuid,$2::text,'outcome',1,'原始结果','原始结果','','',0,'请修改原始结果',$3,$4,$5,'要怎么改？','["甲","乙"]',$6,$6,$7,$7)`, [id, card, OWNER.personId, randomUUID(), status, now, status === "saved" ? "note" : "edit"]);
    return id;
  };
  const finish = async () => {
    const window = (await summary()).payload.round;
    expect((await confirm(true, card, member, window)).statusCode).toBe(200);
    expect((await confirm(true, other, ceo, window)).statusCode).toBe(200);
    await vi.waitFor(async () => expect((await summary()).payload.coAgentReview.status).toBe("completed"));
  };
  const returnCard = async () => post(`/api/mission-rounds/${round}/return-cards`, { cardIds: [card], reason: "请本人继续核对结果", version: (await summary()).version });
  return { t, round, card, other, member, ceo, people, get, post, page, summary, act, confirm, edit, send, pending, review, finish, returnCard,
    now: () => now, advance: () => { now = new Date(now.getTime() + 60_000); } };
}

describe("本人确认与共享改写边界", () => {
  it("本人确认与取消均幂等，冻结本人写入，上级仅读，未全员确认不能提前汇总", async () => {
    const f = await setup(); try {
      expect((await f.act("open")).statusCode).toBe(200);
      const before = await f.page();
      expect(before.actions.some((a: { actionType: string }) => a.actionType === "mission-round.close")).toBe(false);
      expect((await f.confirm()).statusCode).toBe(200);
      const stamp = () => f.t.sql("SELECT owner_confirmed_at,xmin::text FROM personal_mission_cards WHERE id=$1", [f.card]);
      const once = await stamp(); f.advance();
      expect((await f.confirm()).statusCode).toBe(200); expect(await stamp()).toEqual(once);
      const p = (await f.page(f.card, f.member)).payload as TPersonalMissionCardPayload;
      expect(p.card).toMatchObject({ status: "本人已确认", ownerConfirmedAt: START.toISOString() });
      expect(p.selfReview).toMatchObject({ canCancel: true, canEdit: false, canConfirm: false });
      expect(await f.edit("本人再修改")).toMatchObject({ error: { code: "OWNER_CONFIRMED" } });
      expect(await f.edit("拍板人再修改", 1, CEO)).toMatchObject({ error: { code: "MISSION_CARD_READ_ONLY" } });
      expect((await f.confirm(true, f.card, f.ceo)).json().code).toBe("OWNER_CONFIRMATION_FORBIDDEN");
      expect((await f.confirm(false)).statusCode).toBe(200); const cancelled = await stamp();
      expect((await f.confirm(false)).statusCode).toBe(200); expect(await stamp()).toEqual(cancelled);
      expect((await f.t.sql("SELECT version FROM mission_rounds WHERE id=$1", [f.round]))[0].version).toBe(before.version + 2);
      expect((await f.act("close")).json().code).toBe("OWNERS_NOT_CONFIRMED");
      expect((await f.page()).payload.round.phase).toBe("open");
      expect(await f.t.sql("SELECT id FROM mission_round_reviews")).toHaveLength(0);
    } finally { await f.t.close(); }
  });
  it("最后一人同事务自动核对，同毫秒留言不丢失，重复确认不重建快照，退回仅清除受影响者", async () => {
    const f = await setup(); try {
      await f.act("open"); const feedback = await f.send();
      expect((await f.confirm()).json().cards[0].payload.round.phase).toBe("open");
      const result = await f.confirm(true, f.other, f.ceo);
      expect(result.statusCode, result.body).toBe(200);
      expect(result.json().cards[0].payload.round).toMatchObject({ phase: "reviewing", closesAt: START.toISOString(), reviewAt: START.toISOString() });
      expect((await f.t.sql("SELECT feedback_ids,mission_versions FROM mission_round_reviews WHERE round_id=$1", [f.round]))[0])
        .toEqual({ feedback_ids: [feedback.id], mission_versions: { [f.card]: 1, [f.other]: 1 } });
      expect((await f.confirm(true, f.other, f.ceo)).statusCode).toBe(200);
      expect(await f.t.sql("SELECT id FROM mission_round_reviews WHERE round_id=$1", [f.round])).toHaveLength(1);
      expect((await f.confirm(false)).json().code).toBe("ROUND_NOT_OPEN");
      await vi.waitFor(async () => expect((await f.summary()).payload.coAgentReview.status).toBe("completed"));
      expect(f.review).toHaveBeenCalledTimes(1);
      expect((await f.act("reopen")).json().code).toBe("SELECT_AFFECTED_CARDS");
      expect((await f.returnCard()).statusCode).toBe(200);
      expect((await f.t.sql("SELECT owner_confirmed_at FROM personal_mission_cards WHERE id=$1", [f.card]))[0].owner_confirmed_at).toBeNull();
      expect((await f.t.sql("SELECT owner_confirmed_at FROM personal_mission_cards WHERE id=$1", [f.other]))[0].owner_confirmed_at).toEqual(START);
      expect((await f.confirm()).json().code).toBe("ROUND_CHANGED");
      expect(await f.edit("旧审核生成的正文", 1)).toMatchObject({ error: { code: "ROUND_CHANGED" } });
      const oldSelection = { clientId: randomUUID(), intent: "edit", sourceRound: 1, missionId: f.card, field: "outcome", sourceVersion: 1,
        sourceText: "原始结果", quote: "原始结果", prefix: "", suffix: "", startOffset: 0, body: "旧选区的修改意图" };
      expect((await f.post(`/api/mission-cards/${f.card}/annotations`, oldSelection, f.member)).json().code).toBe("ROUND_CHANGED");
      const { sourceRound: _sourceRound, ...missingRound } = oldSelection;
      expect((await f.post(`/api/mission-cards/${f.card}/annotations`, missingRound, f.member)).statusCode).toBe(400);
      expect(await f.t.sql("SELECT id FROM mission_card_annotations")).toHaveLength(0);
      expect(await f.t.sql("SELECT id FROM mission_card_revisions")).toHaveLength(0);
      expect((await f.confirm(true, f.card, f.member, 2)).statusCode).toBe(200);
      await vi.waitFor(async () => expect((await f.summary()).payload.coAgentReview.status).toBe("completed"));
      expect(await f.t.sql("SELECT id FROM mission_round_reviews WHERE round_id=$1", [f.round])).toHaveLength(2);
    } finally { await f.t.close(); }
  });
  it("并发最后确认只创建一个快照", async () => {
    const f = await setup(); try {
      await f.act("open");
      const responses = await Promise.all([f.confirm(), f.confirm(true, f.other, f.ceo)]);
      expect(responses.map((r) => r.statusCode)).toEqual([200, 200]);
      expect(await f.t.sql("SELECT id FROM mission_round_reviews WHERE round_id=$1", [f.round])).toHaveLength(1);
      await vi.waitFor(async () => expect((await f.summary()).payload.coAgentReview.status).toBe("completed"));
      expect(f.review).toHaveBeenCalledTimes(1);
    } finally { await f.t.close(); }
  });
  it("确认核对全部 Mission 版本与ID，拒绝未读正文、空卡、起草失败、非本人及失效审核", async () => {
    const f = await setup(); try {
      const url = `/api/mission-cards/${f.card}/owner-confirmation`;
      expect((await f.post(url, { confirmed: true, round: 1, missionVersions: { [f.card]: 1 } }, "")).statusCode).toBe(401);
      expect((await f.post(`/api/mission-cards/${randomUUID()}/owner-confirmation`, { confirmed: true, round: 1, missionVersions: {} }, f.member)).statusCode).toBe(404);
      expect((await f.post(url, { confirmed: true, round: 1 }, f.member)).statusCode).toBe(400);
      expect((await f.confirm()).json().code).toBe("ROUND_CHANGED"); // 尚未下发的 window_seq=0。
      await f.act("open");
      expect((await f.post(url, { confirmed: true, round: 1, missionVersions: { [f.card]: 1 } }, f.ceo)).statusCode).toBe(404);
      expect((await f.confirm(true, f.card, f.member, 1, {})).json().code).toBe("SOURCE_VERSION_CONFLICT");
      expect((await f.confirm(true, f.card, f.member, 1, { [f.card]: 1, extra: 1 })).json().code).toBe("SOURCE_VERSION_CONFLICT");
      expect("error" in await f.edit("已经修改的正文")).toBe(false);
      expect((await f.confirm(true, f.card, f.member, 1, { [f.card]: 1 })).json().code).toBe("SOURCE_VERSION_CONFLICT");
      await f.t.sql("UPDATE mission_rounds SET draft_source=$2::jsonb WHERE id=$1", [f.round, JSON.stringify({ failedOwners: [{ ownerId: OWNER.personId, message: "生成失败" }] })]);
      expect((await f.confirm()).json().code).toBe("MISSION_CARD_NOT_READY");
      await f.t.sql("UPDATE mission_rounds SET draft_source='{}' WHERE id=$1", [f.round]);
      await f.t.sql("DELETE FROM missions WHERE id=$1", [f.other]);
      expect((await f.confirm(true, f.other, f.ceo)).json().code).toBe("MISSION_CARD_NOT_READY");
    } finally { await f.t.close(); }
  });
  it.each(["queued", "applying", "needs_clarification", "failed"] as const)("%s修改批注阻止本人确认，明确保留备注后允许自动核对，保留原因和原文", async (status) => {
    const f = await setup(); try {
      await f.act("open"); const id = await f.pending(status);
      expect((await f.confirm()).json().code).toBe("ANNOTATIONS_PENDING");
      expect((await f.act("close")).json().code).toBe("OWNERS_NOT_CONFIRMED");
      expect(await f.t.sql("SELECT id FROM mission_round_reviews")).toHaveLength(0);
      const note = await f.post(`/api/mission-cards/${f.card}/annotations/${id}/resolve`, { reason: "本月暂保留原定范围" }, f.member);
      expect(note.statusCode, note.body).toBe(200);
      expect(note.json().annotation).toMatchObject({ status: "no_change", body: "请修改原始结果", question: "要怎么改？", note: "保留备注，暂不修改：本月暂保留原定范围", canResolve: false });
      expect(note.json().annotation.clarifications).toEqual([expect.objectContaining({ answer: "保留备注，暂不修改：本月暂保留原定范围", authorId: OWNER.personId })]);
      expect(await f.edit("重新关联修改", 1, OWNER, id)).toMatchObject({ error: { code: "ANNOTATION_ALREADY_PROCESSED" } });
      expect((await f.confirm()).statusCode).toBe(200);
      expect((await f.confirm(true, f.other, f.ceo)).statusCode).toBe(200);
      expect((await f.page()).payload.round.phase).toBe("reviewing");
      await vi.waitFor(async () => expect((await f.summary()).payload.coAgentReview.status).toBe("completed"));
      const preserved = f.review.mock.calls[0][0].cards.find((card) => card.cardId === f.card)!.annotations[0];
      expect(preserved).toMatchObject({ intent: "edit", status: "no_change", source_text: "原始结果", body: "请修改原始结果", note: "保留备注，暂不修改：本月暂保留原定范围" });
    } finally { await f.t.close(); }
  });
  it("纯备注不阻断确认；截止不代替本人，DRI延长后保留既有确认并由本人处理澄清", async () => {
    const f = await setup(); try {
      await f.act("open"); await f.pending("saved"); expect((await f.confirm()).statusCode).toBe(200);
      await f.confirm(false); const id = await f.pending("needs_clarification");
      expect((await f.confirm(true, f.other, f.ceo)).statusCode).toBe(200);
      await f.t.sql("UPDATE mission_rounds SET closes_at=$2 WHERE id=$1", [f.round, START]);
      expect(await closeDueRounds(f.t.pool, START)).toBe(0);
      expect(await f.t.sql("SELECT id FROM mission_round_reviews")).toHaveLength(0);
      expect(f.review).not.toHaveBeenCalled();
      expect((await f.confirm()).json().code).toBe("ROUND_NOT_OPEN");
      expect(await resolveMissionCardAnnotation(f.t.pool, f.people, f.t.env.sessionSecret, OWNER, f.card, id, "先保留", () => START)).toMatchObject({ error: { code: "ROUND_NOT_OPEN" } });
      expect((await f.act("reopen")).statusCode).toBe(200);
      expect((await f.t.sql("SELECT owner_confirmed_at FROM personal_mission_cards WHERE id=$1", [f.other]))[0].owner_confirmed_at).toEqual(START);
      expect("error" in await resolveMissionCardAnnotation(f.t.pool, f.people, f.t.env.sessionSecret, OWNER, f.card, id, "先保留", f.now)).toBe(false);
      expect(await closeDueRounds(f.t.pool, START)).toBe(0);
      expect(await f.t.sql("SELECT id FROM mission_round_reviews")).toHaveLength(0);
      expect((await f.confirm(true, f.card, f.member, 2)).statusCode).toBe(200);
      await vi.waitFor(async () => expect((await f.summary()).payload.coAgentReview.status).toBe("completed"));
      expect(f.review).toHaveBeenCalledTimes(1);
      expect((await f.get(`/api/mission-cards/${f.card}/annotations`, f.member)).json().annotations).toHaveLength(2);
    } finally { await f.t.close(); }
  });
  it("生成期间明确保留备注后旧 worker 停止，既不覆盖原因也不写正文", async () => {
    const f = await setup(); let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const generate = vi.fn(async () => { await gate; return { candidate: { action: "apply" as const, proposed: "不应写回", reason: "旧意图", question: null, options: [] } }; });
    const queue = createMissionCardAnnotationQueue({ pool: f.t.pool, people: () => f.people, secret: f.t.env.sessionSecret,
      agent: { generate }, now: f.now, onError: (e) => { throw e; } });
    try {
      await f.act("open");
      const made = await createMissionCardAnnotation(f.t.pool, f.people, f.t.env.sessionSecret, OWNER, f.card, { clientId: randomUUID(), intent: "edit", sourceRound: 1,
        missionId: f.card, field: "outcome", sourceVersion: 1, sourceText: "原始结果", quote: "原始结果", prefix: "", suffix: "", startOffset: 0, body: "修改" }, f.now);
      if ("error" in made) throw new Error(made.error.message);
      const work = queue.enqueue(f.card); await vi.waitFor(() => expect(generate).toHaveBeenCalledTimes(1));
      await resolveMissionCardAnnotation(f.t.pool, f.people, f.t.env.sessionSecret, OWNER, f.card, made.annotation.id, "先保留", f.now);
      await f.finish(); expect((await f.returnCard()).statusCode).toBe(200); release(); await work;
      expect((await f.t.sql("SELECT status,note FROM mission_card_annotations WHERE id=$1", [made.annotation.id]))[0])
        .toEqual({ status: "no_change", note: "保留备注，暂不修改：先保留" });
      expect(await f.t.sql("SELECT id FROM mission_card_revisions")).toHaveLength(0);
      expect((await f.page()).payload.card.missions[0].outcome).toBe("原始结果");
    } finally { release(); await queue.close(); await f.t.close(); }
  });
  it("截止queued留作failed，延长后本人可明确保留；不静默当作已确认或纯备注", async () => {
    const f = await setup(); const generate = vi.fn();
    const queue = createMissionCardAnnotationQueue({ pool: f.t.pool, people: () => f.people, secret: f.t.env.sessionSecret,
      agent: { generate }, now: f.now, onError: (e) => { throw e; } });
    try {
      await f.act("open"); const id = await f.pending("queued");
      await f.t.sql("UPDATE mission_rounds SET closes_at=$2 WHERE id=$1", [f.round, START]);
      await queue.enqueue(f.card);
      expect(generate).not.toHaveBeenCalled();
      expect((await f.t.sql("SELECT status FROM mission_card_annotations WHERE id=$1", [id]))[0].status).toBe("failed");
      expect(await closeDueRounds(f.t.pool, START)).toBe(0);
      const notes = (await f.get(`/api/mission-cards/${f.card}/annotations`, f.member)).json().annotations;
      expect(notes[0]).toMatchObject({ intent: "edit", canResolve: false, canRetry: false });
      expect((await f.page()).actions.some((a: { actionType: string }) => a.actionType === "mission-round.close")).toBe(false);
      expect((await f.act("close")).json().code).toBe("OWNERS_NOT_CONFIRMED");
      expect((await f.act("reopen")).statusCode).toBe(200);
      const resolved = await f.post(`/api/mission-cards/${f.card}/annotations/${id}/resolve`, { reason: "保留当前范围" }, f.member);
      expect(resolved.statusCode, resolved.body).toBe(200);
      expect(await closeDueRounds(f.t.pool, START)).toBe(0);
      expect(await f.t.sql("SELECT id FROM mission_round_reviews")).toHaveLength(0);
      await f.finish();
      expect((await f.page()).payload.round.phase).toBe("reviewing");
      expect(await f.t.sql("SELECT id FROM mission_round_reviews")).toHaveLength(1);
      expect((await f.get(`/api/mission-cards/${f.card}/annotations`, f.member)).json().annotations[0].note).toContain("保留当前范围");
    } finally { await queue.close(); await f.t.close(); }
  });
  it("旧他人建议仅作历史，过期原文不采纳；退回后以本人最新正文确认，意见与修订始终保留", async () => {
    const f = await setup(); try {
      await f.act("open"); const stale = await f.send("旧建议");
      await f.edit("本人新结果"); const fresh = await f.send("最新建议");
      // Imported feedback may predate owner-only preparation. It remains audit evidence, never a writing grant.
      await f.t.sql("UPDATE mission_card_feedback SET author_id=$2 WHERE id=ANY($1::uuid[])", [[stale.id, fresh.id], CEO.personId]);
      await f.finish();
      expect((await f.act("decide", { decision: "accept" }, fresh.id)).json().code).toBe("OWNER_RECONFIRMATION_REQUIRED");
      const p = (await f.page()).payload;
      expect(p.card.missions[0]).toMatchObject({ outcome: "本人新结果", version: 2, selfEditedFields: ["outcome"], changedFields: [] });
      expect(p.feedback.every((e: { actions: unknown[] }) => !e.actions.length)).toBe(true);
      expect(p.feedback.find((e: { id: string }) => e.id === stale.id).acceptBlockedReason).toContain("正文已修改");
      const group = (await f.get(`/api/mission-cards/${f.card}/group`)).json();
      expect(group.entries.find((e: { type: string; feedback?: { id: string } }) => e.type === "message" && e.feedback?.id === stale.id).feedback.acceptBlockedReason).toContain("正文已修改");
      expect((await f.act("decide", { decision: "accept" }, stale.id)).json().code).toBe("OWNER_RECONFIRMATION_REQUIRED");
      expect((await f.returnCard()).statusCode).toBe(200);
      await f.edit("退回后本人新版", 2); await f.finish();
      expect((await f.t.sql("SELECT original,proposed,body FROM mission_card_feedback WHERE id=$1", [fresh.id]))[0])
        .toEqual({ original: fresh.original, proposed: fresh.proposed, body: fresh.body });
      expect((await f.act("confirm", { note: "保留新版" })).statusCode).toBe(200);
      expect((await f.page()).payload.card.missions[0]).toMatchObject({ outcome: "退回后本人新版", version: 3, selfEditedFields: ["outcome"], changedFields: [] });
      expect((await f.get(`/api/mission-cards/${f.card}/annotations`)).json().revisions).toHaveLength(2);
      expect(await f.t.sql("SELECT feedback_id FROM mission_review_decisions")).toHaveLength(0);
    } finally { await f.t.close(); }
  });
  it("退回后改回原文也不激活遗留采纳建议，最终确认不重写本人正文或增版本", async () => {
    const f = await setup(); try {
      await f.act("open"); const suggestion = await f.send("旧采纳结果");
      await f.t.sql("UPDATE mission_card_feedback SET author_id=$2 WHERE id=$1", [suggestion.id, CEO.personId]);
      await f.finish();
      await f.t.sql(`INSERT INTO mission_review_decisions (review_id,feedback_id,decision,decided_by,decided_at)
        SELECT id,$2,'accept',$3,$4 FROM mission_round_reviews WHERE round_id=$1`, [f.round, suggestion.id, CEO.personId, START]);
      expect((await f.page()).payload.card.missions[0]).toMatchObject({ outcome: "原始结果", version: 1, changedFields: [] });
      expect((await f.returnCard()).statusCode).toBe(200);
      await f.edit("中间修改", 2); await f.edit("原始结果", 2); await f.finish();
      const candidate = (await f.page()).payload;
      expect(candidate.feedback[0].acceptBlockedReason).toBeNull();
      expect(candidate.card.missions[0]).toMatchObject({ outcome: "原始结果", version: 3, changedFields: [] });
      expect((await f.act("confirm", { note: "本人确认结果一致，遗留意见仅供核对" })).statusCode).toBe(200);
      expect((await f.page()).payload.card.missions[0]).toMatchObject({ outcome: "原始结果", version: 3, selfEditedFields: ["outcome"], changedFields: [] });
      expect((await f.t.sql("SELECT original,proposed FROM mission_card_feedback WHERE id=$1", [suggestion.id]))[0])
        .toEqual({ original: "原始结果", proposed: "旧采纳结果" });
      expect((await f.t.sql("SELECT outcome,version FROM missions WHERE id=$1", [f.card]))[0]).toEqual({ outcome: "原始结果", version: 3 });
      expect((await f.get(`/api/mission-cards/${f.card}/annotations`, f.member)).json().revisions).toHaveLength(2);
    } finally { await f.t.close(); }
  });
});
