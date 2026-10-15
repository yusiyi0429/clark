import { randomUUID } from "node:crypto";
import { Value } from "@sinclair/typebox/value";
import { MissionCardAnnotationsResponse, type TCreateMissionCardAnnotationRequest } from "@warmap/contracts";
import { describe, expect, it, vi } from "vitest";
import { createTestApp, type TestApp } from "./helpers.js";
import type { MissionCardAnnotationAgent } from "../src/missionCardAnnotationAgent.js";
import { applyMissionCardRevision, createMissionCardAnnotation } from "../src/missionCardAnnotations.js";
import { createMissionCardAnnotationQueue } from "../src/missionCardAnnotationQueue.js";
import { createCompanyContext } from "../src/companyContext.js";
import { testEnv } from "./helpers.js";
import { readMissionCardForAgent } from "../src/mcpMissionCards.js";

const START = "2026-10-01T02:00:00.000Z";
const SOURCE = "先做 **核对**，再完成走查。";
const noChange: MissionCardAnnotationAgent = { async generate() { return { candidate: {
  action: "no_change", proposed: null, reason: "原文已经满足批注", question: null, options: [],
} }; } };

async function fixture(t: TestApp) {
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
  const ceo = await t.loginCookie();
  const draft = (await get(t, ceo, `/api/mission-rounds/${round}`)).json().cards[0];
  expect((await post(t, ceo, "/api/mission-rounds/actions/execute", { actionId: draft.actions[0].actionId })).statusCode).toBe(200);
  return { round, card, other };
}

function input(card: string, extra: Partial<TCreateMissionCardAnnotationRequest> = {}): TCreateMissionCardAnnotationRequest {
  return { intent: "edit", clientId: randomUUID(), sourceRound: 1, missionId: card, field: "outcome", sourceVersion: 1, sourceText: SOURCE,
    quote: "核对", prefix: "先做 ", suffix: "，再完成走查。", startOffset: 3, body: "请说明核对对象。", ...extra };
}
const get = (t: TestApp, cookie: string, path: string) => t.app.inject({ method: "GET", url: path, headers: { cookie } });
const post = (t: TestApp, cookie: string, path: string, payload: unknown) => t.app.inject({
  method: "POST", url: path, headers: { cookie, origin: t.publicOrigin }, payload,
});
const annotations = (card: string) => `/api/mission-cards/${card}/annotations`;
const pageResponse = (t: TestApp, cookie: string, card: string) => get(t, cookie, `/api/mission-cards/${card}`);
async function page(t: TestApp, cookie: string, card: string) {
  return (await get(t, cookie, `/api/mission-cards/${card}`)).json().cards[0];
}

describe("任务卡正文批注", () => {
  it("本人只能保留自己的待改批注，到期延长与汇总退回提示匹配实际阶段", async () => {
    const t = await createTestApp({}, undefined, { monthlyNow: () => new Date(START), missionCardAnnotationAgent: noChange });
    try {
      const f = await fixture(t), member = await t.memberCookie();
      const own = (await post(t, member, annotations(f.card), input(f.card, { intent: "note" }))).json().annotation;
      const legacy = (await post(t, member, annotations(f.card), input(f.card, { intent: "note", body: "历史外人意见" }))).json().annotation;
      await t.sql("UPDATE mission_card_annotations SET intent='edit',status='failed' WHERE id=ANY($1::uuid[])", [[own.id, legacy.id]]);
      await t.sql("UPDATE mission_card_annotations SET author_id='person-fixture-001' WHERE id=$1", [legacy.id]);
      const before = (await t.sql("SELECT author_id,status,note,clarification_history FROM mission_card_annotations WHERE id=$1", [legacy.id]))[0];
      const read = (await get(t, member, annotations(f.card))).json().annotations;
      expect(read.find((entry: { id: string }) => entry.id === own.id)).toMatchObject({ canResolve: true });
      expect(read.find((entry: { id: string }) => entry.id === legacy.id)).toMatchObject({ canResolve: false, canRetry: false, canAnswer: false });
      const forbidden = await post(t, member, `${annotations(f.card)}/${legacy.id}/resolve`, { reason: "不应改动历史外人意见" });
      expect(forbidden.statusCode).toBe(403);
      expect(forbidden.json().code).toBe("ANNOTATION_RESPONSE_FORBIDDEN");
      expect((await t.sql("SELECT author_id,status,note,clarification_history FROM mission_card_annotations WHERE id=$1", [legacy.id]))[0]).toEqual(before);
      for (const [status, deadline, expected] of [
        ["open", START, "延长本人确认"],
        ["draft", null, "交给本人确认"], ["reviewing", null, "退回受影响的本人"], ["confirmed", null, "退回受影响的本人"],
      ] as const) {
        await t.sql(`UPDATE mission_rounds SET status=$2,closes_at=$3,
          opened_at=CASE WHEN $2='draft' THEN NULL ELSE $4::timestamptz END,
          confirmed_at=CASE WHEN $2='confirmed' THEN $4::timestamptz ELSE NULL END,
          confirmed_by=CASE WHEN $2='confirmed' THEN 'person-fixture-001' ELSE NULL END WHERE id=$1`, [f.round, status, deadline, START]);
        expect((await get(t, member, annotations(f.card))).json().annotations.find((entry: { id: string }) => entry.id === own.id).canResolve).toBe(false);
        const retained = await post(t, member, `${annotations(f.card)}/${own.id}/resolve`, { reason: "暂时保留原文" });
        expect(retained.statusCode, retained.body).toBe(409);
        expect(retained.json()).toMatchObject({ code: "ROUND_NOT_OPEN" });
        expect(retained.json().message).toContain(expected);
        const confirmed = await post(t, member, `/api/mission-cards/${f.card}/owner-confirmation`, { confirmed: true, round: 1, missionVersions: { [f.card]: 1 } });
        expect(confirmed.statusCode, confirmed.body).toBe(409);
        expect(confirmed.json().message).toContain(expected);
      }
      await t.sql("UPDATE mission_rounds SET status='open',closes_at=NULL,confirmed_at=NULL,confirmed_by=NULL WHERE id=$1", [f.round]);
      await t.sql("UPDATE personal_mission_cards SET owner_confirmed_at=$2 WHERE id=$1", [f.card, START]);
      expect((await get(t, member, annotations(f.card))).json().annotations.find((entry: { id: string }) => entry.id === own.id).canResolve).toBe(false);
      expect((await post(t, member, `${annotations(f.card)}/${own.id}/resolve`, { reason: "暂时保留原文" })).json().code).toBe("OWNER_CONFIRMED");
    } finally { await t.close(); }
  });
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
      const people = createCompanyContext(t.env).searchPeople(undefined);
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
      expect((await get(t, ceo, annotations(f.card))).statusCode).toBe(404);
      const read = await get(t, member, annotations(f.card));
      expect(read.statusCode).toBe(200);
      expect(Value.Check(MissionCardAnnotationsResponse, read.json())).toBe(true);
      expect(read.json().annotations).toHaveLength(1);
      expect(read.json().annotations[0]).toMatchObject({ id: saved.json().annotation.id, quote: "核对", body: "请说明核对对象。" });
      expect((await page(t, member, f.card)).payload.card.missions).toEqual(before.payload.card.missions);
      expect((await get(t, member, `/api/mission-cards/${f.card}/group`)).json().entries.filter((entry: { type: string }) => entry.type === "message")).toEqual([]);
      expect((await t.sql("SELECT count(*)::int AS n FROM mission_card_feedback"))[0].n).toBe(0);
      expect((await t.sql("SELECT count(*)::int AS n FROM conversation_messages"))[0].n).toBe(0);
      expect(agent).not.toHaveBeenCalled();
      // 确定后原批注可读，新增批注和正文均冻结；更正仍走原 corrections。
      await t.sql("UPDATE mission_rounds SET status='confirmed',confirmed_at=$2,confirmed_by='person-fixture-001' WHERE id=$1", [f.round, START]);
      expect((await post(t, member, annotations(f.card), input(f.card))).json().code).toBe("ROUND_NOT_OPEN");
      expect((await get(t, member, annotations(f.card))).json().annotations).toHaveLength(1);
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
      await vi.waitFor(async () => expect((await get(t, member, annotations(f.card))).json().annotations[0].status).toBe("applied"));
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
      // 历史 member_ids 不赋予正文/批注权限，真实负责人变化立即撤销访问。
      await t.sql("UPDATE personal_mission_cards SET owner_id='new-owner' WHERE id=$1", [f.card]);
      expect((await pageResponse(t, member, f.card)).statusCode).toBe(404);
      expect((await post(t, member, annotations(f.card), input(f.card))).statusCode).toBe(404);
      expect(generate).toHaveBeenCalledTimes(3);
    } finally { await t.close(); }
  });

  it("同卡两条批注串行，第二条读取第一条改后的版本，多队列也只改一次", async () => {
    const t = await createTestApp({}, undefined, { monthlyNow: () => new Date(START), missionCardAnnotationAgent: noChange });
    const people = createCompanyContext(testEnv).searchPeople(undefined), seen: number[] = [];
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
    const people = createCompanyContext(testEnv).searchPeople(undefined), person = { personId: "person-fixture-002", role: "member" as const };
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
        missionId: f.card, field: "outcome", sourceRound: 1, sourceVersion: 1, sourceText: SOURCE, proposed: "私聊已达成的版本。", reason: "按私聊明确的意见",
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
      await t.sql("UPDATE personal_mission_cards SET owner_id='new-owner',member_ids='[\"person-fixture-001\"]' WHERE id=$1", [f.card]);
      expect((await get(t, member, annotations(f.card))).statusCode).toBe(404);
      expect((await post(t, member, annotations(f.card), input(f.card))).statusCode).toBe(404);
      expect((await get(t, ceo, annotations(f.card))).statusCode).toBe(404);
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
      await t.sql("UPDATE personal_mission_cards SET owner_id='new-owner' WHERE id=$1", [f.card]);
      await t.sql("UPDATE personal_mission_cards SET owner_id='person-fixture-002' WHERE id=$1", [f.other]);
      expect((await post(t, member, annotations(f.other), { ...request, missionId: f.other })).json().code).toBe("CLIENT_ID_CONFLICT");
      await t.sql("UPDATE personal_mission_cards SET owner_id='outsider' WHERE id=$1", [f.other]);
      await t.sql("UPDATE personal_mission_cards SET owner_id='person-fixture-002' WHERE id=$1", [f.card]);
      await t.sql("UPDATE missions SET outcome='新的正文',version=version+1 WHERE id=$1", [f.card]);
      const retry = await post(t, member, annotations(f.card), request);
      expect(retry.json().annotation).toMatchObject({ id: first.json().annotation.id, sourceText: SOURCE, stale: true });
      expect((await get(t, member, annotations(f.card))).json().annotations).toHaveLength(1);
      await t.sql("UPDATE personal_mission_cards SET owner_id='new-owner',member_ids='[\"person-fixture-001\"]' WHERE id=$1", [f.card]);
      expect((await post(t, member, annotations(f.card), request)).statusCode).toBe(404);
    } finally { await t.close(); }
  });

  it("同版本正文变化拒绝旧快照；本人确认冻结原锚点与 Markdown 历史", async () => {
    const t = await createTestApp({}, undefined, { monthlyNow: () => new Date(START), missionCardAnnotationAgent: noChange });
    try {
      const f = await fixture(t), member = await t.memberCookie();
      await t.sql("UPDATE missions SET outcome='同版本的新正文' WHERE id=$1", [f.card]);
      expect((await post(t, member, annotations(f.card), input(f.card))).json().code).toBe("SOURCE_TEXT_CONFLICT");
      await t.sql("UPDATE missions SET outcome=$2 WHERE id=$1", [f.card, SOURCE]);
      const original = input(f.card, { intent: "note" });
      expect((await post(t, member, annotations(f.card), original)).statusCode).toBe(200);
      expect((await post(t, member, `/api/mission-cards/${f.card}/owner-confirmation`, { confirmed: true, round: 1, missionVersions: { [f.card]: 1 } })).statusCode).toBe(200);
      expect((await post(t, member, annotations(f.card), input(f.card))).json().code).toBe("OWNER_CONFIRMED");
      expect((await get(t, member, annotations(f.card))).json().annotations[0]).toMatchObject({ sourceText: SOURCE, quote: "核对", stale: false, status: "saved" });
      expect((await t.sql("SELECT outcome,version FROM missions WHERE id=$1", [f.card]))[0]).toEqual({ outcome: SOURCE, version: 1 });
    } finally { await t.close(); }
  });
});
