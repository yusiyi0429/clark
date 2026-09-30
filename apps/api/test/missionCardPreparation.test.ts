import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createTestApp, type TestApp, TEST_CEO, TEST_MEMBER } from "./helpers.js";
import { loadCompanyMemory } from "../src/companyMemory.js";
import { readMissionCardForAgent } from "../src/mcpMissionCards.js";
import { getPersonalMissionCard, setMissionCardOwnerConfirmation } from "../src/personalMissionCards.js";
import { createMissionCardReviewQueue } from "../src/missionCardReviewQueue.js";
import { validateMissionCardReviewReport, type MissionCardReviewAgent } from "../src/missionCardReview.js";
import { getScopeObject } from "../src/conversations.js";
import { getTaskView } from "../src/tasks.js";
import { signActionId } from "../src/actionToken.js";

const START = new Date("2026-10-01T02:00:00Z"), SOURCE = "完成首轮用户权限验收。";
const get = (t: TestApp, cookie: string, url: string) => t.app.inject({ method: "GET", url, headers: { cookie } });
const post = (t: TestApp, cookie: string, url: string, payload: unknown) => t.app.inject({ method: "POST", url, headers: { cookie, origin: t.publicOrigin }, payload });
const defaultReview: MissionCardReviewAgent = { async generate(input) { return { candidate: { summary: "任务组合与本月目标一致，备注供 DRI 判断", findings: [{
  kind: "question", title: "确认验收范围", body: "本月权限验收需由 DRI 明确覆盖范围", sources: [{ cardId: input.cards[0].cardId,
    missionId: String(input.cards[0].missions[0].missionId), field: "outcome", version: Number(input.cards[0].missions[0].version), quote: SOURCE }],
}] } }; } };
async function fixture(reviewAgent: MissionCardReviewAgent = defaultReview, annotationAgent?: Parameters<typeof createTestApp>[2]["missionCardAnnotationAgent"]) {
  let now = START;
  const t = await createTestApp({}, undefined, { monthlyNow: () => now, missionCardReviewAgent: reviewAgent, missionCardAnnotationAgent: annotationAgent });
  const plan = randomUUID(), round = randomUUID(), a = randomUUID(), b = randomUUID();
  await t.sql("UPDATE battlefield_config SET owner_id=$1,six_month_outcome='完整权限闭环' WHERE id='growth'", [TEST_MEMBER.personId]);
  await t.sql(`INSERT INTO monthly_plans (id,version,period,status,company_outcome,battlefields,todos,negotiation,generation,confirmed_at)
    VALUES ($1,1,'2026-10','confirmed','本月完成权限闭环','[{"battlefieldId":"growth","outcome":"完成用户权限验收"}]','[]','{}','{}',$2)`, [plan, START]);
  await t.sql(`INSERT INTO mission_rounds (id,version,battlefield_id,period,monthly_plan_id,status,draft_origin,draft_source,created_at,updated_at)
    VALUES ($1,1,'growth','2026-10',$2,'draft','agent','{}',$3,$3)`, [round, plan, START]);
  for (const [id, owner] of [[a, TEST_CEO.personId], [b, TEST_MEMBER.personId]]) {
    await t.sql("INSERT INTO personal_mission_cards (id,round_id,owner_id,sort_order,member_ids,created_at) VALUES ($1,$2,$3,0,$4::jsonb,$5)", [id, round, owner, JSON.stringify([TEST_CEO.personId, TEST_MEMBER.personId]), START]);
    await t.sql(`INSERT INTO missions (id,version,code,period,title,owner_id,capability_id,battlefield_ids,outcome,success_evidence,source_ref,source_document_id,source_revision,source_title,personal_mission_card_id)
      VALUES ($1,1,$1,'2026-10','权限验收',$2,'method','["growth"]',$3,'["权限日志"]','fixture://task','test',1,'隔离测试',$4)`, [id, owner, SOURCE, id]);
  }
  const ceo = await t.loginCookie(), dri = await t.memberCookie();
  const summary = async (cookie = dri) => (await get(t, cookie, `/api/mission-rounds/${round}`)).json().cards[0];
  const execute = (actionId: string, cookie = dri, input = {}) => post(t, cookie, "/api/mission-rounds/actions/execute", { actionId, input });
  const open = (await summary()).actions.find((action: any) => action.actionType === "mission-round.open");
  expect((await execute(open.actionId)).statusCode).toBe(200);
  const confirm = async (card: string, cookie: string) => {
    const page = (await get(t, cookie, `/api/mission-cards/${card}`)).json().cards[0];
    return post(t, cookie, `/api/mission-cards/${card}/owner-confirmation`, { confirmed: true, round: page.payload.round.round,
      missionVersions: Object.fromEntries(page.payload.card.missions.map((mission: any) => [mission.missionId, mission.version])) });
  };
  const noteInput = (id: string, more: Record<string, unknown> = {}) => ({ clientId: randomUUID(), sourceRound: 1, missionId: id, field: "outcome", sourceVersion: 1,
    sourceText: SOURCE, quote: "权限", prefix: "完成首轮用户", suffix: "验收。", startOffset: 6, body: "请明确权限验收边界", ...more });
  const people = loadCompanyMemory(t.env).searchPeople(undefined);
  return { t, a, b, round, ceo, dri, summary, execute, confirm, noteInput, people, setNow(at: Date) { now = at; } };
}

describe("本人准备、组合 Review 与职责边界", () => {
  it("准备正文与批注只给本人；上级可读真实准备进度，所有旁路拒绝", async () => {
    const f = await fixture(); const { t } = f;
    try {
      expect((await get(t, f.ceo, `/api/mission-cards/${f.b}`)).statusCode).toBe(404);
      expect((await get(t, f.dri, `/api/mission-cards/${f.a}`)).statusCode).toBe(404);
      const progress = (await f.summary(f.ceo)).payload;
      expect(progress.approver).toBe(false);
      expect(progress.counts.unreviewed).toBe(2);
      expect(progress.cards.find((card: any) => card.cardId === f.b)).toMatchObject({ contentVisible: false, line: "待本人确认" });
      expect((await post(t, f.ceo, `/api/mission-cards/${f.b}/annotations`, f.noteInput(f.b))).statusCode).toBe(404);
      for (const endpoint of ["annotations", "revisions", "group", "items"]) expect((await get(t, f.ceo, `/api/mission-cards/${f.b}/${endpoint}`)).statusCode).toBe(404);
      expect((await get(t, f.ceo, `/api/cards/missions/${f.b}`)).statusCode).toBe(404);
      expect((await get(t, f.ceo, "/api/cards/missions")).json().cards.some((card: any) => card.objectRef.id === f.b)).toBe(false);
      expect((await get(t, f.ceo, "/api/config/missions")).json().missions.some((mission: any) => mission.missionId === f.b)).toBe(false);
      expect(await readMissionCardForAgent(t.pool.query.bind(t.pool), f.people, t.env.sessionSecret, { personId: TEST_CEO.personId, role: "ceo" }, f.b, START)).toBeNull();
      const chat = await post(t, f.ceo, `/api/conversations/mission:${f.b}/messages`, { message: "请读正文", references: [] });
      expect(chat.statusCode).toBe(404);
      expect(chat.json().code).toBe("CONVERSATION_SCOPE_NOT_FOUND");
      const reference = await post(t, f.ceo, "/api/conversations/global/messages", { message: "读取引用", references: [{ cardId: `mission:${f.b}`, version: 1 }] });
      expect(reference.statusCode).toBe(404); expect(reference.json().code).toBe("REFERENCE_NOT_FOUND");
    } finally { await t.close(); }
  });
  it("保存备注不触发模型，也不阻断本人确认；确认后上级只读且保留备注", async () => {
    const generate = vi.fn(async () => ({ candidate: { action: "no_change" as const, proposed: null, reason: "备注", question: null, options: [] } }));
    const f = await fixture(defaultReview, { generate }); const { t } = f;
    try {
      const saved = await post(t, f.dri, `/api/mission-cards/${f.b}/annotations`, f.noteInput(f.b));
      expect(saved.statusCode, saved.body).toBe(200); expect(saved.json().annotation).toMatchObject({ intent: "note", status: "saved" });
      expect(generate).not.toHaveBeenCalled();
      expect((await f.confirm(f.b, f.dri)).statusCode).toBe(200);
      const visible = (await get(t, f.ceo, `/api/mission-cards/${f.b}`)).json().cards[0].payload;
      expect(visible.card.status).toBe("本人已确认"); expect(visible.selfReview.canEdit).toBe(false); expect(visible.annotationAccess.canCreate).toBe(false);
      expect((await get(t, f.ceo, `/api/mission-cards/${f.b}/annotations`)).json().annotations).toHaveLength(1);
      expect((await post(t, f.ceo, `/api/mission-cards/${f.b}/annotations`, f.noteInput(f.b))).statusCode).toBe(403);
      expect((await post(t, f.ceo, `/api/mission-cards/${f.b}/feedback`, { clientId: randomUUID(), kind: "comment", round: 1, body: "我想改卡" })).statusCode).toBe(403);
    } finally { await t.close(); }
  });
  it("明确 edit 才即时修改，保存后的 note 也可由本人选择交给 Agent", async () => {
    const generate = vi.fn(async () => ({ candidate: { action: "apply" as const, proposed: "完成 CEO 与 DRI 用户权限验收。", reason: "明确验收范围", question: null, options: [] } }));
    const f = await fixture(defaultReview, { generate }); const { t } = f;
    try {
      const saved = (await post(t, f.dri, `/api/mission-cards/${f.b}/annotations`, f.noteInput(f.b, { intent: "note" }))).json().annotation;
      expect(generate).not.toHaveBeenCalled();
      expect((await post(t, f.dri, `/api/mission-cards/${f.b}/annotations/${saved.id}/retry`, {})).statusCode).toBe(200);
      await vi.waitFor(async () => expect((await get(t, f.dri, `/api/mission-cards/${f.b}/annotations`)).json().annotations[0].status).toBe("applied"));
      const data = (await get(t, f.dri, `/api/mission-cards/${f.b}/annotations`)).json();
      expect(data.revisions[0]).toMatchObject({ before: SOURCE, after: "完成 CEO 与 DRI 用户权限验收。", annotationId: saved.id });
      expect(data.annotations[0].body).toBe("请明确权限验收边界");
      expect(generate).toHaveBeenCalledTimes(1);
    } finally { await t.close(); }
  });
  it("最后一人确认形成唯一稳定快照，自动生成有来源的 Review；CEO不能代 DRI 拍板", async () => {
    const generate = vi.fn(defaultReview.generate), f = await fixture({ generate }); const { t } = f;
    try {
      await post(t, f.dri, `/api/mission-cards/${f.b}/annotations`, f.noteInput(f.b, { intent: "note" }));
      expect((await f.confirm(f.b, f.dri)).statusCode).toBe(200);
      expect((await t.sql("SELECT count(*)::int AS n FROM mission_round_reviews"))[0].n).toBe(0);
      const [one, retry] = await Promise.all([f.confirm(f.a, f.ceo), f.confirm(f.a, f.ceo)]);
      expect([one.statusCode, retry.statusCode]).toEqual([200, 200]);
      await vi.waitFor(async () => expect((await f.summary()).payload.coAgentReview.status).toBe("completed"));
      expect(generate).toHaveBeenCalledTimes(1);
      expect(generate.mock.calls[0][0]).toMatchObject({ goals: { monthOutcome: "完成用户权限验收" }, cards: expect.arrayContaining([expect.objectContaining({ cardId: f.b, annotations: [expect.objectContaining({ intent: "note", status: "saved" })] })]) });
      expect((await t.sql("SELECT count(*)::int AS n FROM mission_round_reviews"))[0].n).toBe(1);
      const ceoSummary = await f.summary(f.ceo);
      expect(ceoSummary.actions).toEqual([]); expect(ceoSummary.payload.coAgentReview.findings).toHaveLength(1);
      const driSummary = await f.summary(), action = driSummary.actions.find((action: any) => action.actionType === "mission-round.confirm");
      expect((await f.execute(action.actionId, f.ceo, { note: "CEO试图代签" })).statusCode).toBe(403);
      expect((await f.execute(action.actionId, f.dri, { note: "组合责任与验收一致" })).statusCode).toBe(200);
      expect((await t.sql("SELECT version,outcome FROM missions ORDER BY id")).every((mission: any) => mission.version === 1 && mission.outcome === SOURCE)).toBe(true);
    } finally { await t.close(); }
  });
  it("仅受影响者失效，其他确认保留；旧 Review 不能写回，重新确认产生新快照", async () => {
    let finish: ((value: Awaited<ReturnType<MissionCardReviewAgent["generate"]>>) => void) | undefined;
    const f = await fixture({ generate: () => new Promise((resolve) => { finish = resolve; }) }); const { t } = f;
    try {
      await f.confirm(f.b, f.dri); await f.confirm(f.a, f.ceo);
      await vi.waitFor(() => expect(finish).toBeDefined());
      const before = await f.summary();
      const returned = await post(t, f.dri, `/api/mission-rounds/${f.round}/return-cards`, { cardIds: [f.a], reason: "请明确验收证据", version: before.version });
      expect(returned.statusCode, returned.body).toBe(200);
      expect(returned.json().cards[0].payload).toMatchObject({ phase: "open", round: 2, counts: { unreviewed: 1 } });
      expect((await get(t, f.ceo, `/api/mission-cards/${f.a}`)).json().cards[0].payload.selfReview.returnReason).toBe("请明确验收证据");
      expect((await t.sql("SELECT owner_confirmed_at FROM personal_mission_cards WHERE id=$1", [f.b]))[0].owner_confirmed_at).not.toBeNull();
      finish!({ candidate: { summary: "旧结果不得成为当前报告", findings: [] } });
      await vi.waitFor(async () => expect((await t.sql("SELECT agent_report FROM mission_round_reviews WHERE round_id=$1", [f.round]))[0].agent_report).toBeNull());
      expect((await f.summary()).payload.coAgentReview).toBeNull();
      await f.confirm(f.a, f.ceo);
      await vi.waitFor(async () => expect((await t.sql("SELECT count(*)::int AS n FROM mission_round_reviews WHERE round_id=$1", [f.round]))[0].n).toBe(2));
      finish!({ candidate: { summary: "新快照", findings: [] } });
    } finally { finish?.({ candidate: { summary: "关闭", findings: [] } }); await t.close(); }
  });
  it("生成失败可重试；无效来源不当作成功，不影响本人确认与原正文", async () => {
    let calls = 0;
    const f = await fixture({ async generate() { calls++; return { candidate: calls === 1 ? { summary: "伪造", findings: [{ kind: "risk", title: "伪造来源", body: "无依据", sources: [{ cardId: randomUUID() }] }] } : { summary: "根据完整快照完成复核", findings: [] } }; } }); const { t } = f;
    try {
      await f.confirm(f.b, f.dri); await f.confirm(f.a, f.ceo);
      await vi.waitFor(async () => expect((await f.summary()).payload.coAgentReview.status).toBe("failed"));
      const failed = await f.summary(); expect(failed.actions.some((action: any) => action.actionType === "mission-round.confirm")).toBe(false);
      expect((await f.execute(failed.payload.coAgentReview.retryAction.actionId)).statusCode).toBe(200);
      await vi.waitFor(async () => expect((await f.summary()).payload.coAgentReview.status).toBe("completed"));
      expect(calls).toBe(2); expect((await t.sql("SELECT outcome FROM missions")).every((mission: any) => mission.outcome === SOURCE)).toBe(true);
    } finally { await t.close(); }
  });
  it("截止未确认不会默认为同意或自动Review，DRI延长后保留已确认者", async () => {
    const generate = vi.fn(defaultReview.generate), f = await fixture({ generate }); const { t } = f;
    try {
      await f.confirm(f.b, f.dri);
      await t.sql("UPDATE mission_rounds SET closes_at=$2 WHERE id=$1", [f.round, new Date(START.getTime() + 1000)]);
      f.setNow(new Date(START.getTime() + 2000));
      const due = await f.summary(); expect(due.payload.phase).toBe("closed"); expect(due.payload.counts.unreviewed).toBe(1);
      expect(due.payload.cards.find((card: any) => card.cardId === f.a).line).toBe("待本人确认");
      expect((await f.confirm(f.a, f.ceo)).statusCode).toBe(409);
      expect(generate).not.toHaveBeenCalled(); expect((await t.sql("SELECT count(*)::int AS n FROM mission_round_reviews"))[0].n).toBe(0);
      const action = due.actions.find((action: any) => action.actionType === "mission-round.reopen");
      expect((await f.execute(action.actionId)).statusCode).toBe(200);
      expect((await f.summary()).payload.counts.unreviewed).toBe(1);
      expect((await f.confirm(f.a, f.ceo)).statusCode).toBe(200);
    } finally { await t.close(); }
  });
  it("未完成的修改必须处理；明确保留备注后能确认，原问题与改写意图仍在快照", async () => {
    const generate = vi.fn(async () => ({ candidate: { action: "clarify" as const, proposed: null, reason: "范围未知", question: "覆盖哪个角色？", options: ["CEO", "DRI"] } }));
    const f = await fixture(defaultReview, { generate }); const { t } = f;
    try {
      const made = (await post(t, f.dri, `/api/mission-cards/${f.b}/annotations`, f.noteInput(f.b, { intent: "edit" }))).json().annotation;
      await vi.waitFor(async () => expect((await get(t, f.dri, `/api/mission-cards/${f.b}/annotations`)).json().annotations[0].status).toBe("needs_clarification"));
      expect((await f.confirm(f.b,f.dri)).json().code).toBe("ANNOTATIONS_PENDING");
      expect((await post(t,f.dri,`/api/mission-cards/${f.b}/annotations/${made.id}/resolve`,{reason:"本月先按现有权限验收，范围留给组合核对"})).statusCode).toBe(200);
      expect((await f.confirm(f.b,f.dri)).statusCode).toBe(200);
      await f.confirm(f.a,f.ceo);
      await vi.waitFor(async () => expect((await f.summary()).payload.coAgentReview.status).toBe("completed"));
      const snapshot = (await t.sql("SELECT agent_input FROM mission_round_reviews WHERE round_id=$1",[f.round]))[0].agent_input;
      expect(snapshot.cards.find((c:any)=>c.cardId===f.b).annotations[0]).toMatchObject({body:"请明确权限验收边界",intent:"edit",status:"no_change",question:"覆盖哪个角色？",note:expect.stringContaining("保留备注")});
      expect((await t.sql("SELECT outcome FROM missions WHERE id=$1",[f.b]))[0].outcome).toBe(SOURCE);
    } finally { await t.close(); }
  });
  it("取消本人确认会同步新版本和上级进度，并立即撤回准备正文可见性", async () => {
    const f = await fixture(); const { t } = f;
    try {
      await f.confirm(f.b,f.dri); const before = await f.summary(f.ceo);
      expect(before.payload.cards.find((c:any)=>c.cardId===f.b).contentVisible).toBe(true);
      expect((await post(t,f.dri,`/api/mission-cards/${f.b}/owner-confirmation`,{confirmed:false,round:1,missionVersions:{[f.b]:1}})).statusCode).toBe(200);
      const after = await f.summary(f.ceo);
      expect(after.version).toBeGreaterThan(before.version);
      expect(after.payload.cards.find((c:any)=>c.cardId===f.b)).toMatchObject({ownerConfirmedAt:null,contentVisible:false,line:"待本人确认"});
      expect(after.payload.counts.unreviewed).toBe(2);
      expect((await get(t,f.ceo,`/api/mission-cards/${f.b}`)).statusCode).toBe(404);
    } finally { await t.close(); }
  });
  it("普通本人只读自己正文与审阅状态，不能通过完整报告或历史成员名单读他人内容", async () => {
    const f = await fixture(); const { t } = f;
    try {
      // 后续换任上级，原 DRI 仍只是自己卡的本人，旧 member_ids 不提供旁路。
      await t.sql("UPDATE battlefield_config SET owner_id='other-dri' WHERE id='growth'");
      expect((await get(t,f.dri,`/api/mission-cards/${f.a}`)).statusCode).toBe(404);
      await f.confirm(f.b,f.dri); await f.confirm(f.a,f.ceo);
      await vi.waitFor(async () => expect((await f.summary(f.dri)).payload.coAgentReview.status).toBe("completed"));
      const own = (await f.summary(f.dri)).payload;
      expect(own.cards.map((c:any)=>c.cardId)).toEqual([f.b]);
      expect(own.counts.cards).toBe(2); expect(own.counts.unreviewed).toBe(0);
      expect(own.coAgentReview).toMatchObject({status:"completed",summary:"",findings:[]});
      expect((await get(t,f.dri,`/api/cards/missions/${f.a}`)).statusCode).toBe(403);
      expect((await get(t,f.dri,`/api/mission-cards/${f.a}`)).statusCode).toBe(404);
      expect((await get(t,f.ceo,`/api/mission-cards/${f.b}`)).statusCode).toBe(200);
    } finally { await t.close(); }
  });
  it("后台进程并发不重复审阅；正常关停重排队，重启使用同一冻结快照完成", async () => {
    let release: ((v:Awaited<ReturnType<MissionCardReviewAgent["generate"]>>)=>void)|undefined;
    let calls=0;
    const generate = vi.fn(async (input:Parameters<MissionCardReviewAgent["generate"]>[0]) => {
      calls++; if(calls===1) return await new Promise<Awaited<ReturnType<MissionCardReviewAgent["generate"]>>>((resolve)=>{release=resolve;});
      return {candidate:{summary:"重启读取原确认快照",findings:[]}};
    });
    const f = await fixture({generate}); const {t}=f;
    const other=createMissionCardReviewQueue({pool:t.pool,agent:{generate},now:()=>START,onError:(error)=>{throw error;}});
    try {
      await f.confirm(f.b,f.dri); await f.confirm(f.a,f.ceo);
      await vi.waitFor(()=>expect(release).toBeDefined());
      await Promise.all([other.recover(),other.recover()]);
      expect(generate).toHaveBeenCalledTimes(1);
      const original=(await t.sql("SELECT id,agent_input FROM mission_round_reviews WHERE round_id=$1",[f.round]))[0];
      await t.app.close();
      expect((await t.sql("SELECT agent_status FROM mission_round_reviews WHERE id=$1",[original.id]))[0].agent_status).toBe("queued");
      t.app=await t.restart();
      await vi.waitFor(async()=>expect((await f.summary()).payload.coAgentReview.status).toBe("completed"));
      expect(generate).toHaveBeenCalledTimes(2);
      expect(generate.mock.calls[1][0]).toEqual(original.agent_input);
      release!({candidate:{summary:"旧进程晚到不得覆盖",findings:[]}});
      expect((await f.summary()).payload.coAgentReview.summary).toBe("重启读取原确认快照");
      expect(await t.sql("SELECT id FROM mission_round_reviews WHERE round_id=$1",[f.round])).toEqual([{id:original.id}]);
    } finally { release?.({candidate:{summary:"关闭",findings:[]}}); await other.close(); await t.close(); }
  });

  it("退回正式卡时保留原最终确认审计；执行事项及其私聊不能绕读正在准备的 Mission", async () => {
    const f=await fixture(),{t}=f;
    try {
      await f.confirm(f.b,f.dri); await f.confirm(f.a,f.ceo);
      await vi.waitFor(async()=>expect((await f.summary()).payload.coAgentReview.status).toBe("completed"));
      const ready=await f.summary();
      const action=ready.actions.find((a:any)=>a.actionType==="mission-round.confirm");
      expect((await f.execute(action.actionId,f.dri,{note:"确认责任边界和验收"})).statusCode).toBe(200);
      const task=randomUUID();
      await t.sql("INSERT INTO tasks (id,title,status,owner_id,created_by,mission_id,step_order) VALUES ($1,'执行已有验收','not_started',$2,'self',$3,1)",[task,TEST_CEO.personId,f.b]);
      const q=t.pool.query.bind(t.pool),context={person:{personId:TEST_CEO.personId,role:"ceo" as const},people:f.people,now:START};
      expect((await getTaskView(q,task,new Map()))!.mission).toMatchObject({missionId:f.b,title:"权限验收"});
      expect(JSON.stringify((await getScopeObject(q,`task:${task}`,t.env.sessionSecret,context)).snapshot)).toContain(SOURCE);
      const formal=await f.summary();
      expect((await post(t,f.dri,`/api/mission-rounds/${f.round}/return-cards`,{cardIds:[f.b],reason:"重新明确验收范围",version:formal.version})).statusCode).toBe(200);
      const history=(await t.sql("SELECT reopens FROM mission_rounds WHERE id=$1",[f.round]))[0].reopens;
      expect(history[0].priorConfirmation).toMatchObject({by:TEST_MEMBER.personId,at:START.toISOString(),note:"确认责任边界和验收",reviewId:expect.any(String)});
      expect((await getTaskView(q,task,new Map()))!.mission).toBeNull();
      const chat=(await getScopeObject(q,`task:${task}`,t.env.sessionSecret,context)).snapshot;
      expect(chat!.payload).toMatchObject({mission:null,task:{mission:null,title:"执行已有验收"}});
      expect(JSON.stringify(chat)).not.toContain(SOURCE);
      const group=(await get(t,f.dri,`/api/mission-cards/${f.b}/group`)).json();
      expect(group.entries.some((e:any)=>e.type==="divider"&&e.text.includes("确认责任边界和验收"))).toBe(true);
      expect((await f.confirm(f.b,f.dri)).statusCode).toBe(200);
      await vi.waitFor(async()=>expect((await f.summary()).payload.coAgentReview.status).toBe("completed"));
      const snapshot=(await t.sql("SELECT agent_input FROM mission_round_reviews WHERE round_id=$1 AND window_seq=2",[f.round]))[0].agent_input;
      expect(snapshot.roundHistory[0].priorConfirmation).toEqual(history[0].priorConfirmation);
    } finally {await t.close();}
  });

});
