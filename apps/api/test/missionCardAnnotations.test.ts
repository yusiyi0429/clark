import { randomUUID } from "node:crypto";
import { Value } from "@sinclair/typebox/value";
import { MissionCardAnnotationsResponse, type TCreateMissionCardAnnotationRequest } from "@warmap/contracts";
import { describe, expect, it, vi } from "vitest";
import { createTestApp, type TestApp } from "./helpers.js";
import type { MissionCardAnnotationAgent } from "../src/missionCardAnnotationAgent.js";
import { applyMissionCardRevision, createMissionCardAnnotation } from "../src/missionCardAnnotations.js";
import { createMissionCardAnnotationQueue } from "../src/missionCardAnnotationQueue.js";
import { loadCompanyMemory } from "../src/companyMemory.js";
import { testEnv } from "./helpers.js";
import { readMissionCardForAgent } from "../src/mcpMissionCards.js";

const START = "2026-10-01T02:00:00.000Z";
const SOURCE = "先做 **核对**，再完成走查。";
const noChange: MissionCardAnnotationAgent = { async generate() { return { candidate: {
  action: "no_change", proposed: null, reason: "原文已经满足批注", question: null, options: [],
} }; } };

async function fixture(t: Pick<TestApp, "sql">) {
  const plan = randomUUID(), round = randomUUID(), card = randomUUID(), other = randomUUID();
  await t.sql("UPDATE battlefield_config SET owner_id='person-fixture-001',six_month_outcome='长期目标' WHERE id='growth'");
  await t.sql(`INSERT INTO monthly_plans (id,version,period,status,company_outcome,battlefields,todos,negotiation,generation,confirmed_at)
    VALUES ($1,1,'2026-10','confirmed','公司目标','[{"battlefieldId":"growth","outcome":"本月目标"}]','[]','{}','{}',$2)`, [plan, START]);
  await t.sql(`INSERT INTO mission_rounds (id,version,battlefield_id,period,monthly_plan_id,status,draft_origin,draft_source,created_at,updated_at)
    VALUES ($1,1,'growth','2026-10',$2,'draft','placeholder','{}',$3,$3)`, [round, plan, START]);
  for (const [id, owner, members] of [[card, "person-fixture-002", ["person-fixture-002", "person-fixture-001"]], [other, "outsider", ["outsider", "person-fixture-001"]]] as const) {
    await t.sql(`INSERT INTO personal_mission_cards (id,round_id,owner_id,sort_order,member_ids,created_at)
      VALUES ($1,$2,$3,0,$4::jsonb,$5)`, [id, round, owner, JSON.stringify(members), START]);
    await t.sql(`INSERT INTO missions (id,version,code,period,title,owner_id,capability_id,battlefield_ids,outcome,success_evidence,source_ref,source_document_id,source_revision,source_title,placeholder,personal_mission_card_id)
      VALUES ($1,1,$1,'2026-10','任务',$2,'method','["growth"]',$4,'["证据一","证据二"]','https://example.test/source','fixture',1,'来源',true,$3)`, [id, owner, id, SOURCE]);
  }
  return { round, card, other };
}

function input(card: string, extra: Partial<TCreateMissionCardAnnotationRequest> = {}): TCreateMissionCardAnnotationRequest {
  return { clientId: randomUUID(), missionId: card, field: "outcome", sourceVersion: 1, sourceText: SOURCE,
    quote: "核对", prefix: "先做 ", suffix: "，再完成走查。", startOffset: 3, body: "请说明核对对象。", ...extra };
}
const get = (t: TestApp, cookie: string, path: string) => t.app.inject({ method: "GET", url: path, headers: { cookie } });
const post = (t: TestApp, cookie: string, path: string, payload: unknown) => t.app.inject({
  method: "POST", url: path, headers: { cookie, origin: t.publicOrigin }, payload,
});
const annotations = (card: string) => `/api/mission-cards/${card}/annotations`;
async function page(t: TestApp, cookie: string, card: string) {
  return (await get(t, cookie, `/api/mission-cards/${card}`)).json().cards[0];
}

describe("任务卡正文批注", () => {
  it("时间边界与取舍可由直接批注即时修改，私聊读取完整新字段与前后留痕", async () => {
    const generate: MissionCardAnnotationAgent["generate"] = async (request) => ({ candidate: {
      action: "apply", proposed: request.field === "timeBoundary" ? "10月31日前完成验收" : "优先完成权限闭环，延后视觉扩展",
      reason: "按批注明确时间与取舍", question: null, options: [],
    } });
    const t = await createTestApp({}, undefined, { monthlyNow: () => new Date(START), missionCardAnnotationAgent: { generate } });
    try {
      const f = await fixture(t), member = await t.memberCookie();
      await t.sql("UPDATE missions SET time_boundary='本月底完成',tradeoffs='优先闭环' WHERE id=$1", [f.card]);
      for (const [field, sourceText, sourceVersion] of [["timeBoundary", "本月底完成", 1], ["tradeoffs", "优先闭环", 2]] as const) {
        const saved = await post(t, member, annotations(f.card), input(f.card, { field, sourceText, sourceVersion, quote: sourceText, prefix: "", suffix: "", startOffset: 0, body: `请明确${field}` }));
        expect(saved.statusCode, saved.body).toBe(200);
        await vi.waitFor(async () => expect((await get(t, member, annotations(f.card))).json().annotations.find((entry: { id: string }) => entry.id === saved.json().annotation.id)?.status).toBe("applied"));
      }
      const current = (await page(t, member, f.card)).payload.card.missions[0];
      expect(current).toMatchObject({ timeBoundary: "10月31日前完成验收", tradeoffs: "优先完成权限闭环，延后视觉扩展", version: 3 });
      const history = (await get(t, member, annotations(f.card))).json().revisions;
      expect(history).toHaveLength(2);
      expect(history).toEqual(expect.arrayContaining([
        expect.objectContaining({ field: "timeBoundary", before: "本月底完成", after: current.timeBoundary }),
        expect.objectContaining({ field: "tradeoffs", before: "优先闭环", after: current.tradeoffs }),
      ]));
      const people = loadCompanyMemory(t.env).searchPeople(undefined);
      const agent = await readMissionCardForAgent(t.pool.query.bind(t.pool), people, t.env.sessionSecret,
        { personId: "person-fixture-002", role: "member" }, f.card, new Date(START));
      expect(agent!.missions[0]).toMatchObject({ timeBoundary: current.timeBoundary, tradeoffs: current.tradeoffs });
      expect(agent!.revisions).toHaveLength(2);
      expect((await t.sql("SELECT count(*)::int AS n FROM mission_card_feedback"))[0].n).toBe(0);
    } finally { await t.close(); }
  });
  it("成员共享持久批注，无需修改时正文不变、不进入群聊或私人对话", async () => {
    const agent = vi.fn(async () => ({ assistantMessage: "回复", runtimeEntries: [] }));
    const t = await createTestApp({}, { run: agent }, { monthlyNow: () => new Date(START), missionCardAnnotationAgent: noChange });
    try {
      const f = await fixture(t), member = await t.memberCookie(), ceo = await t.loginCookie();
      const before = await page(t, member, f.card);
      const saved = await post(t, member, annotations(f.card), input(f.card, { body: "  请说明核对对象。  " }));
      expect(saved.statusCode, saved.body).toBe(200);
      expect(saved.json().annotation).toMatchObject({ cardId: f.card, missionId: f.card, field: "outcome", sourceText: SOURCE,
        quote: "核对", body: "请说明核对对象。", authorId: "person-fixture-002", status: "queued", stale: false });
      const read = await get(t, ceo, annotations(f.card));
      expect(read.statusCode).toBe(200);
      expect(Value.Check(MissionCardAnnotationsResponse, read.json())).toBe(true);
      expect(read.json().annotations).toHaveLength(1);
      expect(read.json().annotations[0]).toMatchObject({ id: saved.json().annotation.id, quote: "核对", body: "请说明核对对象。" });
      expect((await page(t, member, f.card)).payload.card.missions).toEqual(before.payload.card.missions);
      expect((await get(t, member, `/api/mission-cards/${f.card}/group`)).json().entries).toEqual([]);
      expect((await t.sql("SELECT count(*)::int AS n FROM mission_card_feedback"))[0].n).toBe(0);
      expect((await t.sql("SELECT count(*)::int AS n FROM conversation_messages"))[0].n).toBe(0);
      expect(agent).not.toHaveBeenCalled();
      // 确定后的正文仍可批注；批注没有更正或自动写回语义。
      await post(t, ceo, "/api/mission-rounds/actions/execute", { actionId: before.actions[0]?.actionId ?? (await page(t, ceo, f.card)).actions[0].actionId, viewCardId: f.card });
      await t.sql("UPDATE mission_rounds SET status='confirmed',confirmed_at=$2,confirmed_by='person-fixture-001' WHERE id=$1", [f.round, START]);
      expect((await post(t, member, annotations(f.card), input(f.card))).statusCode).toBe(200);
    } finally { await t.close(); }
  });

  it("明确批注立即改正文并保留原批注和修改前后历史，重放不重复修改", async () => {
    const generate = vi.fn(async () => ({ candidate: {
      action: "apply" as const, proposed: "先做 **CEO 与 DRI 权限核对**，再完成走查。", reason: "补充核对对象", question: null, options: [],
    } }));
    const t = await createTestApp({}, undefined, { monthlyNow: () => new Date(START), missionCardAnnotationAgent: { generate } });
    try {
      const f = await fixture(t), member = await t.memberCookie(), request = input(f.card);
      const saved = await post(t, member, annotations(f.card), request);
      expect(saved.statusCode, saved.body).toBe(200);
      expect(saved.json().annotation.status).toBe("queued");
      await vi.waitFor(async () => expect((await get(t, member, annotations(f.card))).json().annotations[0].status).toBe("applied"));
      const read = (await get(t, member, annotations(f.card))).json();
      expect(read.annotations[0]).toMatchObject({ body: request.body, sourceText: SOURCE, quote: "核对", appliedVersion: 2 });
      expect(read.revisions).toHaveLength(1);
      expect(read.revisions[0]).toMatchObject({ before: SOURCE, after: "先做 **CEO 与 DRI 权限核对**，再完成走查。",
        source: "annotation", annotationId: saved.json().annotation.id, authorId: "person-fixture-002", beforeVersion: 1, afterVersion: 2 });
      expect((await page(t, member, f.card)).payload.card.missions[0]).toMatchObject({ version: 2, outcome: read.revisions[0].after });
      expect((await post(t, member, annotations(f.card), request)).json().annotation.id).toBe(saved.json().annotation.id);
      expect(generate).toHaveBeenCalledTimes(1);
      expect((await t.sql("SELECT count(*)::int AS n FROM mission_card_feedback"))[0].n).toBe(0);
      expect((await t.sql("SELECT count(*)::int AS n FROM conversation_messages"))[0].n).toBe(0);
    } finally { await t.close(); }
  });

  it("不明确时只提问题，选择或自己输入后立即修改，作者回答幂等", async () => {
    const generate = vi.fn(async (request: Parameters<MissionCardAnnotationAgent["generate"]>[0]) => ({ candidate: request.answer ? {
      action: "apply" as const, proposed: `先做 **${request.answer}核对**，再完成走查。`, reason: "按用户补充明确对象", question: null, options: [],
    } : { action: "clarify" as const, proposed: null, reason: "对象不明确", question: "需要核对哪个视角？", options: ["CEO", "DRI"] } }));
    const t = await createTestApp({}, undefined, { monthlyNow: () => new Date(START), missionCardAnnotationAgent: { generate } });
    try {
      const f = await fixture(t), member = await t.memberCookie(), ceo = await t.loginCookie();
      const saved = (await post(t, member, annotations(f.card), input(f.card, { body: "把对象补清楚" }))).json().annotation;
      await vi.waitFor(async () => expect((await get(t, member, annotations(f.card))).json().annotations[0].status).toBe("needs_clarification"));
      const question = (await get(t, member, annotations(f.card))).json().annotations[0];
      expect(question).toMatchObject({ question: "需要核对哪个视角？", options: ["CEO", "DRI"], canAnswer: true });
      expect((await t.sql("SELECT outcome,version FROM missions WHERE id=$1", [f.card]))[0]).toEqual({ outcome: SOURCE, version: 1 });
      const url = `${annotations(f.card)}/${saved.id}/answer`;
      expect((await post(t, member, url, { answer: "   " })).statusCode).toBe(400);
      expect((await post(t, member, `${annotations(f.other)}/${saved.id}/answer`, { answer: "DRI" })).statusCode).toBe(404);
      const answered = await post(t, member, url, { answer: "CEO 和 DRI 双视角" });
      expect(answered.statusCode, answered.body).toBe(200);
      await vi.waitFor(async () => expect((await get(t, ceo, annotations(f.card))).json().annotations[0].status).toBe("applied"));
      expect((await post(t, member, url, { answer: "CEO 和 DRI 双视角" })).statusCode).toBe(200);
      expect((await get(t, member, annotations(f.card))).json().revisions).toHaveLength(1);
      expect((await page(t, member, f.card)).payload.card.missions[0].outcome).toBe("先做 **CEO 和 DRI 双视角核对**，再完成走查。");
      expect(generate).toHaveBeenCalledTimes(2);
      expect(generate.mock.calls[1][0]).toMatchObject({ answer: "CEO 和 DRI 双视角", question: "需要核对哪个视角？", body: "把对象补清楚" });
    } finally { await t.close(); }
  });

  it("多次澄清保留每问每答，最终修改继续使用此前已明确的意图", async () => {
    const generate: MissionCardAnnotationAgent["generate"] = async (request) => {
      if (request.clarifications.length === 0) return { candidate: { action: "clarify", proposed: null, reason: "先明确视角",
        question: "核对哪个视角？", options: ["CEO", "DRI"] } };
      if (request.clarifications.length === 1) return { candidate: { action: "clarify", proposed: null, reason: "再明确证据",
        question: "最后保留什么证据？", options: ["界面截图", "权限日志"] } };
      expect(request.clarifications.map((item) => item.answer)).toEqual(["CEO 与 DRI", "界面截图和权限日志"]);
      return { candidate: { action: "apply", proposed: `核对 ${request.clarifications[0].answer} 双视角，保留${request.clarifications[1].answer}。`,
        reason: "结合两次补充意见", question: null, options: [] } };
    };
    const t = await createTestApp({}, undefined, { monthlyNow: () => new Date(START), missionCardAnnotationAgent: { generate } });
    try {
      const f = await fixture(t), member = await t.memberCookie();
      const made = (await post(t, member, annotations(f.card), input(f.card))).json().annotation;
      const url = `${annotations(f.card)}/${made.id}/answer`;
      await vi.waitFor(async () => expect((await get(t, member, annotations(f.card))).json().annotations[0].question).toBe("核对哪个视角？"));
      expect((await post(t, member, url, { answer: "CEO 与 DRI" })).statusCode).toBe(200);
      await vi.waitFor(async () => expect((await get(t, member, annotations(f.card))).json().annotations[0].question).toBe("最后保留什么证据？"));
      const midway = (await get(t, member, annotations(f.card))).json().annotations[0];
      expect(midway.clarifications).toHaveLength(1);
      expect(midway.clarifications[0]).toMatchObject({ question: "核对哪个视角？", answer: "CEO 与 DRI", authorId: "person-fixture-002" });
      expect((await post(t, member, url, { answer: "界面截图和权限日志" })).statusCode).toBe(200);
      await vi.waitFor(async () => expect((await get(t, member, annotations(f.card))).json().annotations[0].status).toBe("applied"));
      const final = (await get(t, member, annotations(f.card))).json();
      expect(final.annotations[0].clarifications).toHaveLength(2);
      expect(final.annotations[0]).toMatchObject({ body: "请说明核对对象。", sourceText: SOURCE });
      expect(final.revisions).toHaveLength(1);
      expect(final.revisions[0]).toMatchObject({ before: SOURCE, after: "核对 CEO 与 DRI 双视角，保留界面截图和权限日志。" });
    } finally { await t.close(); }
  });

  it("失败保留输入与正文，重试后只产生一次修订；已撤回写权限的成员只保存批注", async () => {
    let failing = true;
    const generate = vi.fn(async () => {
      if (failing) throw new Error("模型暂不可用");
      return { candidate: { action: "apply" as const, proposed: "完成权限核对并提交证据。", reason: "按批注修改", question: null, options: [] } };
    });
    const t = await createTestApp({}, undefined, { monthlyNow: () => new Date(START), missionCardAnnotationAgent: { generate } });
    try {
      const f = await fixture(t), member = await t.memberCookie();
      const saved = (await post(t, member, annotations(f.card), input(f.card))).json().annotation;
      await vi.waitFor(async () => expect((await get(t, member, annotations(f.card))).json().annotations[0].status).toBe("failed"));
      expect((await page(t, member, f.card)).payload.card.missions[0]).toMatchObject({ outcome: SOURCE, version: 1 });
      expect((await get(t, member, annotations(f.card))).json().annotations[0]).toMatchObject({ canRetry: true, note: "模型暂不可用" });
      failing = false;
      expect((await post(t, member, `${annotations(f.card)}/${saved.id}/retry`, {})).statusCode).toBe(200);
      await vi.waitFor(async () => expect((await get(t, member, annotations(f.card))).json().annotations[0].status).toBe("applied"));
      expect((await get(t, member, annotations(f.card))).json().revisions).toHaveLength(1);
      // 保留在成员名单但不是卡负责人或当前拍板人，只能留下批注。
      await t.sql("UPDATE personal_mission_cards SET owner_id='new-owner' WHERE id=$1", [f.card]);
      const current = (await page(t, member, f.card)).payload.card.missions[0];
      const note = await post(t, member, annotations(f.card), input(f.card, { sourceVersion: current.version, sourceText: current.outcome }));
      expect(note.statusCode).toBe(200);
      expect(note.json().annotation).toMatchObject({ status: "saved", canAnswer: false, canRetry: false });
      expect(note.json().annotation.note).toContain("只有任务负责人或拍板人");
      expect(generate).toHaveBeenCalledTimes(3);
    } finally { await t.close(); }
  });

  it("同卡两条批注串行，第二条读取第一条改后的版本，多队列也只改一次", async () => {
    const t = await createTestApp({}, undefined, { monthlyNow: () => new Date(START), missionCardAnnotationAgent: noChange });
    const people = loadCompanyMemory(testEnv).searchPeople(undefined), seen: number[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const agent: MissionCardAnnotationAgent = { async generate(request) {
      seen.push(request.version); if (seen.length === 1) await gate;
      return { candidate: { action: "apply", proposed: seen.length === 1 ? "第一条修改。" : "第二条修改。", reason: "依次修改", question: null, options: [] } };
    } };
    const queues = Array.from({ length: 2 }, () => createMissionCardAnnotationQueue({ pool: t.pool, agent, people: () => people,
      secret: testEnv.sessionSecret, now: () => new Date(START), onError: (cause) => { throw cause; } }));
    try {
      const f = await fixture(t), person = { personId: "person-fixture-002", role: "member" as const };
      const first = await createMissionCardAnnotation(t.pool, people, testEnv.sessionSecret, person, f.card, input(f.card), () => new Date(START));
      expect("error" in first).toBe(false);
      const work1 = queues[0].enqueue(f.card);
      await vi.waitFor(() => expect(seen).toHaveLength(1));
      await createMissionCardAnnotation(t.pool, people, testEnv.sessionSecret, person, f.card, input(f.card, { body: "第二条意见" }), () => new Date(START));
      const work2 = queues[1].enqueue(f.card);
      release(); await Promise.all([work1, work2]);
      expect(seen).toEqual([1, 2]);
      expect((await t.sql("SELECT outcome,version FROM missions WHERE id=$1", [f.card]))[0]).toEqual({ outcome: "第二条修改。", version: 3 });
      expect((await t.sql("SELECT count(*)::int AS n FROM mission_card_revisions"))[0].n).toBe(2);
    } finally { release(); await Promise.all(queues.map((queue) => queue.close())); await t.close(); }
  });

  it("恢复中断的批注，并在私聊已修改同批注时停止后台工作，不报失败或重复写回", async () => {
    const t = await createTestApp({}, undefined, { monthlyNow: () => new Date(START), missionCardAnnotationAgent: noChange });
    const people = loadCompanyMemory(testEnv).searchPeople(undefined), person = { personId: "person-fixture-002", role: "member" as const };
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const generate = vi.fn(async () => {
      await gate;
      return { candidate: { action: "apply" as const, proposed: "后台的另一版。", reason: "按批注修改", question: null, options: [] } };
    });
    const queue = createMissionCardAnnotationQueue({ pool: t.pool, agent: { generate }, people: () => people,
      secret: testEnv.sessionSecret, now: () => new Date(START), onError: (cause) => { throw cause; } });
    try {
      const f = await fixture(t), saved = await createMissionCardAnnotation(t.pool, people, testEnv.sessionSecret, person, f.card,
        input(f.card), () => new Date(START));
      if ("error" in saved) throw new Error(saved.error.message);
      await t.sql("UPDATE mission_card_annotations SET status='applying',attempts=1,updated_at=$2 WHERE id=$1", [saved.annotation.id, "2026-10-01T01:40:00.000Z"]);
      await queue.recover();
      await vi.waitFor(() => expect(generate).toHaveBeenCalledTimes(1));
      const edited = await applyMissionCardRevision(t.pool, people, testEnv.sessionSecret, person, f.card, {
        missionId: f.card, field: "outcome", sourceVersion: 1, sourceText: SOURCE, proposed: "私聊已达成的版本。", reason: "按私聊明确的意见",
        annotationId: saved.annotation.id, clientId: randomUUID(),
      }, () => new Date(START), "agent");
      expect("error" in edited).toBe(false);
      release(); await queue.enqueue(f.card);
      expect((await t.sql("SELECT status,note FROM mission_card_annotations WHERE id=$1", [saved.annotation.id]))[0]).toEqual({ status: "applied", note: null });
      expect((await t.sql("SELECT outcome,version FROM missions WHERE id=$1", [f.card]))[0]).toEqual({ outcome: "私聊已达成的版本。", version: 2 });
      expect((await t.sql("SELECT count(*)::int AS n FROM mission_card_revisions"))[0].n).toBe(1);
    } finally { release(); await queue.close(); await t.close(); }
  });

  it("每次读写复查身份与卡可见性，限制 Mission 绑定且拒绝来源版本/正文冲突", async () => {
    const t = await createTestApp({}, undefined, { monthlyNow: () => new Date(START), missionCardAnnotationAgent: noChange });
    try {
      const f = await fixture(t), member = await t.memberCookie(), ceo = await t.loginCookie();
      expect((await get(t, "", annotations(f.card))).statusCode).toBe(401);
      expect((await post(t, "", annotations(f.card), input(f.card))).statusCode).toBe(401);
      expect((await get(t, member, annotations(f.other))).statusCode).toBe(404);
      expect((await post(t, member, annotations(f.other), input(f.other))).statusCode).toBe(404);
      expect((await post(t, member, annotations(f.card), input(f.card, { missionId: f.other }))).statusCode).toBe(404);
      expect((await post(t, member, annotations(f.card), input(f.card, { sourceVersion: 2 }))).json().code).toBe("SOURCE_VERSION_CONFLICT");
      expect((await post(t, member, annotations(f.card), input(f.card, { sourceText: "旧正文" }))).json().code).toBe("SOURCE_TEXT_CONFLICT");
      const saved = await post(t, member, annotations(f.card), input(f.card));
      expect(saved.statusCode).toBe(200);
      await t.sql("UPDATE personal_mission_cards SET member_ids='[\"person-fixture-001\"]' WHERE id=$1", [f.card]);
      expect((await get(t, member, annotations(f.card))).statusCode).toBe(404);
      expect((await post(t, member, annotations(f.card), input(f.card))).statusCode).toBe(404);
      expect((await get(t, ceo, annotations(f.card))).json().annotations).toHaveLength(1);
      expect((await t.app.inject({ method: "POST", url: annotations(f.card), headers: { cookie: ceo, origin: "https://elsewhere.invalid" }, payload: input(f.card) })).statusCode).toBe(403);
    } finally { await t.close(); }
  });

  it("同作者/clientId 并发重放只有一条；更改内容或跨卡复用编号会冲突，旧批注保留", async () => {
    const t = await createTestApp({}, undefined, { monthlyNow: () => new Date(START), missionCardAnnotationAgent: noChange });
    try {
      const f = await fixture(t), member = await t.memberCookie(), ceo = await t.loginCookie(), request = input(f.card);
      const [first, again] = await Promise.all([post(t, member, annotations(f.card), request), post(t, member, annotations(f.card), request)]);
      expect(first.statusCode, first.body).toBe(200);
      expect(again.statusCode, again.body).toBe(200);
      expect(again.json().annotation.id).toBe(first.json().annotation.id);
      expect((await post(t, member, annotations(f.card), { ...request, body: "另一条意见" })).json().code).toBe("CLIENT_ID_CONFLICT");
      const ceoRequest = input(f.card);
      expect((await post(t, ceo, annotations(f.card), ceoRequest)).statusCode).toBe(200);
      expect((await post(t, ceo, annotations(f.other), { ...ceoRequest, missionId: f.other })).json().code).toBe("CLIENT_ID_CONFLICT");
      await t.sql("UPDATE missions SET outcome='新的正文',version=version+1 WHERE id=$1", [f.card]);
      const retry = await post(t, member, annotations(f.card), request);
      expect(retry.json().annotation).toMatchObject({ id: first.json().annotation.id, sourceText: SOURCE, stale: true });
      expect((await get(t, member, annotations(f.card))).json().annotations).toHaveLength(2);
      await t.sql("UPDATE personal_mission_cards SET member_ids='[\"person-fixture-001\"]' WHERE id=$1", [f.card]);
      expect((await post(t, member, annotations(f.card), request)).statusCode).toBe(404);
    } finally { await t.close(); }
  });

  it("同版本的候选正文变更也拒绝旧快照，Markdown 可视锚点独立于原始字段", async () => {
    const t = await createTestApp({}, undefined, { monthlyNow: () => new Date(START), missionCardAnnotationAgent: noChange });
    try {
      const f = await fixture(t), member = await t.memberCookie(), ceo = await t.loginCookie();
      const initial = await page(t, ceo, f.card);
      await post(t, ceo, "/api/mission-rounds/actions/execute", { actionId: initial.actions[0].actionId, viewCardId: f.card });
      expect((await post(t, member, annotations(f.card), input(f.card))).statusCode).toBe(200);
      const candidate = "先做 **权限核对**，再完成走查。";
      const suggested = await post(t, member, `/api/mission-cards/${f.card}/feedback`, { clientId: randomUUID(), kind: "suggestion", round: 1,
        missionId: f.card, field: "outcome", sourceVersion: 1, proposed: candidate, body: "补充权限" });
      expect(suggested.statusCode, suggested.body).toBe(200);
      const discussing = await page(t, ceo, f.card);
      const close = discussing.actions.find((action: { actionType: string }) => action.actionType === "mission-round.close");
      // 快照严格收取截止时间之前的意见，推动业务时钟后再结束讨论。
      await t.sql("UPDATE mission_card_feedback SET created_at=created_at-interval '1 second' WHERE card_id=$1", [f.card]);
      expect((await post(t, ceo, "/api/mission-rounds/actions/execute", { actionId: close.actionId, viewCardId: f.card })).statusCode).toBe(200);
      const reviewing = await page(t, ceo, f.card);
      expect((await post(t, ceo, "/api/mission-rounds/actions/execute", { actionId: reviewing.payload.feedback[0].actions[0].actionId,
        viewCardId: f.card, input: { decision: "accept" } })).statusCode).toBe(200);
      expect((await page(t, member, f.card)).payload.card.missions[0]).toMatchObject({ version: 1, outcome: candidate });
      expect((await post(t, member, annotations(f.card), input(f.card))).json().code).toBe("SOURCE_TEXT_CONFLICT");
      const current = await post(t, member, annotations(f.card), input(f.card, { sourceText: candidate, quote: "权限核对" }));
      expect(current.statusCode, current.body).toBe(200);
      expect(current.json().annotation.stale).toBe(false);
      const notes = (await get(t, member, annotations(f.card))).json().annotations;
      expect(notes).toHaveLength(2);
      expect(notes.find((note: { sourceText: string }) => note.sourceText === SOURCE).stale).toBe(true);
      expect(notes.find((note: { sourceText: string }) => note.sourceText === candidate).stale).toBe(false);
      // 数据库正文还没有被拍板写回；批注保留的是当前显示的候选原文。
      expect((await t.sql("SELECT outcome,version FROM missions WHERE id=$1", [f.card]))[0]).toEqual({ outcome: SOURCE, version: 1 });
    } finally { await t.close(); }
  });

  it("采纳建议后即时修改同字段，建议原文保持不变，确认后仍是即时新版", async () => {
    const proposed = "先做 **双视角权限核对**，再保存界面与权限证据。";
    const t = await createTestApp({}, undefined, { monthlyNow: () => new Date(START), missionCardAnnotationAgent: {
      async generate() { return { candidate: { action: "apply", proposed, reason: "补充证据留存", question: null, options: [] } }; },
    } });
    try {
      const f = await fixture(t), member = await t.memberCookie(), ceo = await t.loginCookie();
      const initial = await page(t, ceo, f.card);
      await post(t, ceo, "/api/mission-rounds/actions/execute", { actionId: initial.actions[0].actionId, viewCardId: f.card });
      const candidate = "先做 **双视角权限核对**，再完成走查。";
      const suggestion = (await post(t, member, `/api/mission-cards/${f.card}/feedback`, { clientId: randomUUID(), kind: "suggestion", round: 1,
        missionId: f.card, field: "outcome", sourceVersion: 1, proposed: candidate, body: "明确双视角" })).json().feedback;
      await t.sql("UPDATE mission_card_feedback SET created_at=created_at-interval '1 second' WHERE card_id=$1", [f.card]);
      const discussing = await page(t, ceo, f.card);
      await post(t, ceo, "/api/mission-rounds/actions/execute", {
        actionId: discussing.actions.find((action: { actionType: string }) => action.actionType === "mission-round.close").actionId, viewCardId: f.card,
      });
      const reviewing = await page(t, ceo, f.card);
      await post(t, ceo, "/api/mission-rounds/actions/execute", { actionId: reviewing.payload.feedback[0].actions[0].actionId, viewCardId: f.card, input: { decision: "accept" } });
      const saved = await post(t, member, annotations(f.card), input(f.card, { sourceText: candidate, body: "还要保留可复核证据" }));
      expect(saved.statusCode, saved.body).toBe(200);
      await vi.waitFor(async () => expect((await get(t, member, annotations(f.card))).json().annotations[0].status).toBe("applied"));
      const current = await page(t, ceo, f.card);
      expect(current.payload.card.missions[0]).toMatchObject({ outcome: proposed, version: 2 });
      expect(current.payload.feedback[0]).toMatchObject({ original: suggestion.original, proposed: suggestion.proposed, body: suggestion.body });
      const confirm = current.actions.find((action: { actionType: string }) => action.actionType === "mission-round.confirm");
      const done = await post(t, ceo, "/api/mission-rounds/actions/execute", { actionId: confirm.actionId, viewCardId: f.card, input: { note: "双视角及界面权限证据已核对。" } });
      expect(done.statusCode, done.body).toBe(200);
      expect(done.json().cards[0].payload.card.missions[0]).toMatchObject({ outcome: proposed, version: 2 });
      expect((await t.sql("SELECT original,proposed,body FROM mission_card_feedback WHERE id=$1", [suggestion.id]))[0])
        .toEqual({ original: suggestion.original, proposed: suggestion.proposed, body: suggestion.body });
    } finally { await t.close(); }
  });
});
