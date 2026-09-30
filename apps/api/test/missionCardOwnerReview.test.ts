import { randomUUID } from "node:crypto";
import { Value } from "@sinclair/typebox/value";
import { PersonalMissionCardPayload, type TPersonalMissionCardPayload } from "@warmap/contracts";
import { describe, expect, it, vi } from "vitest";
import { applyMissionCardRevision, createMissionCardAnnotation, resolveMissionCardAnnotation } from "../src/missionCardAnnotations.js";
import { createMissionCardAnnotationQueue } from "../src/missionCardAnnotationQueue.js";
import { closeDueRounds } from "../src/missionRounds.js";
import { loadCompanyMemory } from "../src/companyMemory.js";
import { createTestApp } from "./helpers.js";

const START = new Date("2026-10-01T02:00:00.000Z");
const OWNER = { personId: "person-fixture-002", role: "member" as const };
const CEO = { personId: "person-fixture-001", role: "ceo" as const };
async function setup() {
  let now = START;
  const t = await createTestApp({}, undefined, { monthlyNow: () => now, missionCardAnnotationAgent: {
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
  const member = await t.memberCookie(), ceo = await t.loginCookie(), people = loadCompanyMemory(t.env).searchPeople(undefined);
  const get = (url: string, cookie = ceo) => t.app.inject({ method: "GET", url, headers: { cookie } });
  const post = (url: string, payload: unknown, cookie = ceo) => t.app.inject({ method: "POST", url, payload, headers: { cookie, origin: t.publicOrigin } });
  const page = async (id = card, cookie = ceo) => {
    const result = await get(`/api/mission-cards/${id}`, cookie);
    expect(result.statusCode, result.body).toBe(200);
    const resultCard = result.json().cards[0];
    expect(Value.Check(PersonalMissionCardPayload, resultCard.payload)).toBe(true);
    return resultCard;
  };
  const act = async (type: string, input: unknown = {}, itemId?: string) => {
    const current = await page();
    const action = itemId ? current.payload.feedback.find((entry: { id: string }) => entry.id === itemId).actions[0]
      : current.actions.find((entry: { actionType: string }) => entry.actionType === `mission-round.${type}`);
    expect(action, `missing action ${type}`).toBeTruthy();
    return post("/api/mission-rounds/actions/execute", { actionId: action.actionId, input, viewCardId: card });
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
    await t.sql(`INSERT INTO mission_card_annotations (id,card_id,mission_id,field,source_version,source_text,quote,prefix,suffix,start_offset,body,author_id,client_id,status,question,options,created_at,updated_at)
      VALUES ($1,$2::uuid,$2::text,'outcome',1,'原始结果','原始结果','','',0,'请修改原始结果',$3,$4,$5,'要怎么改？','["甲","乙"]',$6,$6)`, [id, card, OWNER.personId, randomUUID(), status, now]);
    return id;
  };
  return { t, round, card, other, member, ceo, people, get, post, page, act, confirm, edit, send, pending,
    now: () => now, advance: () => { now = new Date(now.getTime() + 60_000); } };
}

describe("本人审核与共享改写边界", () => {
  it("本人完成和取消均幂等，冻结owner/CEO写入且不使已有开始汇总动作失效", async () => {
    const f = await setup(); try {
      expect((await f.act("open")).statusCode).toBe(200);
      const before = await f.page(), close = before.actions.find((a: { actionType: string }) => a.actionType === "mission-round.close");
      expect((await f.confirm()).statusCode).toBe(200);
      const stamp = () => f.t.sql("SELECT owner_confirmed_at,xmin::text FROM personal_mission_cards WHERE id=$1", [f.card]);
      const once = await stamp(); f.advance();
      expect((await f.confirm()).statusCode).toBe(200); expect(await stamp()).toEqual(once);
      const p = (await f.page(f.card, f.member)).payload as TPersonalMissionCardPayload;
      expect(p.card).toMatchObject({ status: "已完成审核", ownerConfirmedAt: START.toISOString() });
      expect(p.selfReview).toMatchObject({ canCancel: true, canEdit: false, canConfirm: false });
      expect(await f.edit("本人再修改")).toMatchObject({ error: { code: "OWNER_CONFIRMED" } });
      expect(await f.edit("拍板人再修改", 1, CEO)).toMatchObject({ error: { code: "OWNER_CONFIRMED" } });
      expect((await f.confirm(false)).statusCode).toBe(200); const cancelled = await stamp();
      expect((await f.confirm(false)).statusCode).toBe(200); expect(await stamp()).toEqual(cancelled);
      expect((await f.t.sql("SELECT version FROM mission_rounds WHERE id=$1", [f.round]))[0].version).toBe(before.version);
      expect((await f.post("/api/mission-rounds/actions/execute", { actionId: close.actionId, viewCardId: f.card })).statusCode).toBe(200);
      expect((await f.page()).payload.round.phase).toBe("reviewing");
    } finally { await f.t.close(); }
  });
  it("最后一人同事务自动汇总，固定时钟下此前同毫秒留言不丢失，重复确认不重建快照，重开清空确认", async () => {
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
      expect((await f.act("reopen")).statusCode).toBe(200);
      expect((await f.page()).payload.round.cards.every((c: { ownerConfirmedAt: string | null }) => c.ownerConfirmedAt === null)).toBe(true);
      expect((await f.confirm()).json().code).toBe("ROUND_CHANGED");
      expect(await f.edit("旧审核生成的正文", 1)).toMatchObject({ error: { code: "ROUND_CHANGED" } });
      const oldSelection = { clientId: randomUUID(), sourceRound: 1, missionId: f.card, field: "outcome", sourceVersion: 1,
        sourceText: "原始结果", quote: "原始结果", prefix: "", suffix: "", startOffset: 0, body: "旧选区的修改意图" };
      expect((await f.post(`/api/mission-cards/${f.card}/annotations`, oldSelection, f.member)).json().code).toBe("ROUND_CHANGED");
      const { sourceRound: _sourceRound, ...missingRound } = oldSelection;
      expect((await f.post(`/api/mission-cards/${f.card}/annotations`, missingRound, f.member)).statusCode).toBe(400);
      expect(await f.t.sql("SELECT id FROM mission_card_annotations")).toHaveLength(0);
      expect(await f.t.sql("SELECT id FROM mission_card_revisions")).toHaveLength(0);
      expect((await f.confirm(true, f.card, f.member, 2)).statusCode).toBe(200);
    } finally { await f.t.close(); }
  });
  it("并发最后确认只创建一个快照", async () => {
    const f = await setup(); try {
      await f.act("open");
      const responses = await Promise.all([f.confirm(), f.confirm(true, f.other, f.ceo)]);
      expect(responses.map((r) => r.statusCode)).toEqual([200, 200]);
      expect(await f.t.sql("SELECT id FROM mission_round_reviews WHERE round_id=$1", [f.round])).toHaveLength(1);
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
      expect((await f.confirm(true, f.card, f.ceo)).json().code).toBe("OWNER_CONFIRMATION_FORBIDDEN");
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
  it.each(["queued", "applying", "needs_clarification", "failed"] as const)("%s批注阻止本人完成与手动汇总，明确保留备注后可汇总且留原因和原文", async (status) => {
    const f = await setup(); try {
      await f.act("open"); const id = await f.pending(status);
      expect((await f.confirm()).json().code).toBe("ANNOTATIONS_PENDING");
      expect((await f.act("close")).json().code).toBe("ANNOTATIONS_PENDING");
      expect(await f.t.sql("SELECT id FROM mission_round_reviews")).toHaveLength(0);
      const note = await f.post(`/api/mission-cards/${f.card}/annotations/${id}/resolve`, { reason: "本月暂保留原定范围" }, f.member);
      expect(note.statusCode, note.body).toBe(200);
      expect(note.json().annotation).toMatchObject({ status: "no_change", body: "请修改原始结果", question: "要怎么改？", note: "保留备注，暂不修改：本月暂保留原定范围", canResolve: false });
      expect(note.json().annotation.clarifications).toEqual([expect.objectContaining({ answer: "保留备注，暂不修改：本月暂保留原定范围", authorId: OWNER.personId })]);
      expect(await f.edit("重新关联修改", 1, OWNER, id)).toMatchObject({ error: { code: "ANNOTATION_ALREADY_PROCESSED" } });
      expect((await f.confirm()).statusCode).toBe(200);
      expect((await f.confirm(true, f.other, f.ceo)).statusCode).toBe(200);
      expect((await f.page()).payload.round.phase).toBe("reviewing");
    } finally { await f.t.close(); }
  });
  it("纯备注不阻断审核，自然截止遇待澄清先保留，明确保留后才创建快照", async () => {
    const f = await setup(); try {
      await f.act("open"); await f.pending("saved"); expect((await f.confirm()).statusCode).toBe(200);
      await f.confirm(false); const id = await f.pending("needs_clarification");
      await f.t.sql("UPDATE mission_rounds SET closes_at=$2 WHERE id=$1", [f.round, START]);
      expect(await closeDueRounds(f.t.pool, START)).toBe(0);
      expect(await f.t.sql("SELECT id FROM mission_round_reviews")).toHaveLength(0);
      expect("error" in await resolveMissionCardAnnotation(f.t.pool, f.people, f.t.env.sessionSecret, OWNER, f.card, id, "先保留", () => START)).toBe(false);
      expect(await closeDueRounds(f.t.pool, START)).toBe(1);
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
      const made = await createMissionCardAnnotation(f.t.pool, f.people, f.t.env.sessionSecret, OWNER, f.card, { clientId: randomUUID(), sourceRound: 1,
        missionId: f.card, field: "outcome", sourceVersion: 1, sourceText: "原始结果", quote: "原始结果", prefix: "", suffix: "", startOffset: 0, body: "修改" }, f.now);
      if ("error" in made) throw new Error(made.error.message);
      const work = queue.enqueue(f.card); await vi.waitFor(() => expect(generate).toHaveBeenCalledTimes(1));
      await resolveMissionCardAnnotation(f.t.pool, f.people, f.t.env.sessionSecret, OWNER, f.card, made.annotation.id, "先保留", f.now);
      await f.act("close"); await f.act("reopen"); release(); await work;
      expect((await f.t.sql("SELECT status,note FROM mission_card_annotations WHERE id=$1", [made.annotation.id]))[0])
        .toEqual({ status: "no_change", note: "保留备注，暂不修改：先保留" });
      expect(await f.t.sql("SELECT id FROM mission_card_revisions")).toHaveLength(0);
      expect((await f.page()).payload.card.missions[0].outcome).toBe("原始结果");
    } finally { release(); await queue.close(); await f.t.close(); }
  });
  it("遗留截止遇 queued 先保留为failed，负责人可明确保留再手动汇总，不静默转成纯备注", async () => {
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
      expect(notes[0]).toMatchObject({ canResolve: true, canRetry: false });
      expect((await f.page()).actions.some((a: { actionType: string }) => a.actionType === "mission-round.close")).toBe(true);
      const resolved = await f.post(`/api/mission-cards/${f.card}/annotations/${id}/resolve`, { reason: "保留当前范围" }, f.member);
      expect(resolved.statusCode, resolved.body).toBe(200);
      expect((await f.act("close")).statusCode).toBe(200);
      expect((await f.page()).payload.round.phase).toBe("reviewing");
      expect(await f.t.sql("SELECT id FROM mission_round_reviews")).toHaveLength(1);
      expect((await f.get(`/api/mission-cards/${f.card}/annotations`, f.member)).json().annotations[0].note).toContain("保留当前范围");
    } finally { await queue.close(); await f.t.close(); }
  });
  it("过期建议在页面/群/采纳动作阻止，原文和修改记录均保留；重开后的已采纳旧建议还需排除再确认", async () => {
    const f = await setup(); try {
      await f.act("open"); const stale = await f.send("旧建议");
      await f.edit("本人新结果"); const fresh = await f.send("最新建议"); await f.act("close");
      expect((await f.act("decide", { decision: "accept" }, fresh.id)).statusCode).toBe(200);
      const p = (await f.page()).payload;
      expect(p.card.missions[0]).toMatchObject({ outcome: "最新建议", selfEditedFields: ["outcome"], changedFields: ["outcome"] });
      expect(p.feedback.find((e: { id: string }) => e.id === stale.id).acceptBlockedReason).toContain("正文已修改");
      const group = (await f.get(`/api/mission-cards/${f.card}/group`)).json();
      expect(group.entries.find((e: { type: string; feedback?: { id: string } }) => e.type === "message" && e.feedback?.id === stale.id).feedback.acceptBlockedReason).toContain("正文已修改");
      expect((await f.act("decide", { decision: "accept" }, stale.id)).json().code).toBe("SUGGESTION_STALE");
      await f.act("decide", { decision: "decline" }, stale.id); await f.act("reopen"); await f.edit("重开后新版", 2); await f.act("close");
      expect((await f.act("confirm", { note: "核对" })).json().code).toBe("SUGGESTION_STALE");
      expect((await f.t.sql("SELECT original,proposed,body FROM mission_card_feedback WHERE id=$1", [fresh.id]))[0])
        .toEqual({ original: fresh.original, proposed: fresh.proposed, body: fresh.body });
      await f.act("decide", { decision: "decline" }, fresh.id);
      expect((await f.act("confirm", { note: "保留新版" })).statusCode).toBe(200);
      expect((await f.page()).payload.card.missions[0]).toMatchObject({ outcome: "重开后新版", version: 3, selfEditedFields: ["outcome"] });
      expect((await f.get(`/api/mission-cards/${f.card}/annotations`)).json().revisions).toHaveLength(2);
    } finally { await f.t.close(); }
  });
  it("重开修改后再改回原文，沿用的采纳建议在候选与确认中正常落实", async () => {
    const f = await setup(); try {
      await f.act("open"); const suggestion = await f.send("采纳结果"); await f.act("close");
      await f.act("decide", { decision: "accept" }, suggestion.id); await f.act("reopen");
      await f.edit("中间修改", 2); await f.edit("原始结果", 2); await f.act("close");
      const candidate = (await f.page()).payload;
      expect(candidate.feedback[0].acceptBlockedReason).toBeNull();
      expect(candidate.card.missions[0]).toMatchObject({ outcome: "采纳结果", version: 3, changedFields: ["outcome"] });
      expect((await f.act("confirm", { note: "原文一致，保留既有采纳意见" })).statusCode).toBe(200);
      expect((await f.page()).payload.card.missions[0]).toMatchObject({ outcome: "采纳结果", version: 4, selfEditedFields: ["outcome"] });
      expect((await f.t.sql("SELECT original,proposed FROM mission_card_feedback WHERE id=$1", [suggestion.id]))[0])
        .toEqual({ original: "原始结果", proposed: "采纳结果" });
    } finally { await f.t.close(); }
  });
});
