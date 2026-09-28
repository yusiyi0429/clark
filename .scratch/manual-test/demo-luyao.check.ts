/** 独立验收：不监听端口，createTestApp.close() 删除本脚本的一次性库。 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { TestApp } from "../../apps/api/test/helpers.js";
import { setMemberAccess } from "../../apps/api/src/memberAccess.js";
import { LUYAO, clearWangLuyao, seedWangLuyao } from "./demo-luyao.js";
import { closeDueRounds, getMissionRoundCard } from "../../apps/api/src/missionRounds.js";

process.env.TEST_PG_URL = "postgres://postgres:postgres@localhost:54329/postgres";
async function main() {
const { createTestApp, TEST_CEO, testEnv } = await import("../../apps/api/test/helpers.js");
const root = fileURLToPath(new URL("../../",import.meta.url));
const now = new Date("2026-10-01T02:00:00.000Z");
const fixtureDir = await mkdtemp(join(tmpdir(),"warmap-luyao-check-"));
let app: TestApp | undefined;
try {
  const people = JSON.parse(await readFile(join(root,"apps/api/test/fixtures/company-people.json"),"utf8"));
  people.people[0].displayName = "验收 CEO";
  for (const [personId,displayName] of [["bai-tiantian","白田田"],["liu-renhao","刘人豪"],["sun-mingze","孙铭泽"],
    ["chen-xinan","陈溪南"],["yu-siyi","于斯一"],["browser-dri","林知行"],["browser-no-card","何望舒"],
    ["browser-empty","顾清和"],[LUYAO.personId,"王路遥"],["demo-zhou-tinglan","周听澜"],["demo-xu-zhiwei","许知微"]])
    people.people.push({personId,displayName,roles:personId===LUYAO.personId?["ceo","dri"]:["dri"]});
  const peopleFile = join(fixtureDir,"people.json");
  await writeFile(peopleFile,JSON.stringify(people));
  testEnv.publicOrigin = "http://localhost:3500";
  app = await createTestApp({companyPeopleSeed:peopleFile,companyName:"天枢（手动测试）",
    missionCardDraftsDir:join(root,"seed/placeholders")},undefined,{monthlyNow:()=>now,
      voiceprintDeps:{configured:()=>false,requireConfig:()=>{throw new Error("voiceprint unavailable")},
        toPcm:async()=>{throw new Error("voiceprint unavailable")},enroll:async()=>{throw new Error("voiceprint unavailable")},
        update:async()=>{throw new Error("voiceprint unavailable")},remove:async()=>{throw new Error("voiceprint unavailable")},
        groupVerify:async()=>{throw new Error("voiceprint unavailable")}}});
  await app.sql("UPDATE battlefield_config SET code='01',name='灯塔项目',owner_id=$1,six_month_outcome='以真实战略工作验证可复用的交付方式。' WHERE id='growth'",["browser-dri"]);
  await app.sql(`INSERT INTO battlefield_config (id,version,code,name,owner_id,six_month_outcome,sort_order)
    VALUES ('supporting',1,'02','团队协作',$1,'建立可复用的协作方式，完成从讨论到交付的闭环。',2)`,[TEST_CEO.personId]);
  await app.sql("INSERT INTO battlefield_config (id,version,code,name,owner_id,six_month_outcome,sort_order) VALUES ('product',1,'03','产品战场',$1,'验证双视角产品工作闭环。',3)",[LUYAO.personId]);
  await app.sql("INSERT INTO capability_config (id,version,code,name,six_month_outcome) VALUES ('cap-03',1,'03','Method','形成可复用的能力成果')");
  const planId = randomUUID();
  await app.sql(`INSERT INTO monthly_plans (id,version,period,status,company_outcome,battlefields,todos,negotiation,generation,confirmed_at)
    VALUES ($1,1,'2026-10','confirmed','验证从本月目标到个人承诺的完整路径',$2::jsonb,'[]',
      '{"edits":[],"checkedItemIds":[],"feedback":[],"note":""}',
      '{"status":"ready","pendingSince":null,"runId":null,"previousRunIds":[],"error":null,"generatedAt":null}',$3)`,
    [planId,JSON.stringify([{battlefieldId:"growth",outcome:"让灯塔项目完成从目标到执行与复盘的闭环。"},
      {battlefieldId:"supporting",outcome:"把跨人员交接与成功证据整理成可共同核对的清单。"},
      {battlefieldId:"product",outcome:"完成双视角走查并按人核对四张任务卡。"}]),now]);
  await app.sql(`INSERT INTO missions (id,version,code,period,title,owner_id,capability_id,battlefield_ids,outcome,
    source_ref,source_document_id,source_revision,source_title)
    VALUES ('browser03-sun-mingze',1,'browser03-sun-mingze','2026-10','把 DRI 的交接场景落到一致的界面反馈',
      'sun-mingze','method','["growth","supporting"]','形成可核对的协作清单','fixture://03','browser03',1,'隔离演练的登记资料')`);
  await setMemberAccess(async (query,params)=>({rows:await app!.sql(query,params),rowCount:1,command:"",oid:0,fields:[]}),
    {personId:"sun-mingze",loginId:"browsermember",passcode:"8742",mustChange:false});
  const seeded = await seedWangLuyao(app,planId,now,"8742",TEST_CEO.personId);
  const login = await app.app.inject({method:"POST",url:"/api/auth/login",headers:{origin:testEnv.publicOrigin},
    payload:{loginId:LUYAO.loginId,passcode:"8742"}});
  assert.equal(login.statusCode,200,login.body);
  assert.equal(login.json().onboarded,false);
  let cookie = String(login.headers["set-cookie"]).split(";")[0];
  const get = async (url:string) => {
    const response = await app!.app.inject({method:"GET",url,headers:{cookie,origin:testEnv.publicOrigin}});
    assert.equal(response.statusCode,200,`${url}: ${response.body}`);
    return response.json();
  };
  assert.deepEqual((await get("/api/auth/session")).role,"ceo");
  const ceoOnboarding = await get("/api/me/onboarding");
  assert.equal(ceoOnboarding.role,"ceo");
  const productProjection = await getMissionRoundCard(
    (query,params)=>app!.sql(query,params).then((rows)=>({rows,rowCount:rows.length}) as never),
    people.people,"test-session-secret",{personId:LUYAO.personId,role:"ceo"},seeded.productRoundId,now);
  assert.equal(productProjection?.payload && (productProjection.payload as {cards:unknown[]}).cards.length,4);
  const ceoHome = await get("/api/cards/home");
  const product = ceoHome.cards.find((c:{kind:string;payload?:{battlefieldId:string}})=>c.kind==="mission-round"&&c.payload?.battlefieldId==="product");
  assert.ok(product,"CEO 首页缺少产品战场轮次");
  assert.equal(product.payload.phase,"open");
  assert.equal(product.payload.cards.length,4);
  assert.equal(product.payload.counts.feedback,5);
  assert.ok(new Date(product.payload.closesAt).getTime()-now.getTime()>24*60*60_000);
  for (const entry of product.payload.cards) assert.equal(entry.missionCount,2);
  assert.equal((await app.app.inject({method:"GET",url:"/api/me/home",headers:{cookie}})).statusCode,403);
  const switched = await app.app.inject({method:"POST",url:"/api/auth/view",headers:{cookie,origin:testEnv.publicOrigin},payload:{view:"member"}});
  assert.equal(switched.statusCode,200,switched.body);
  cookie = String(switched.headers["set-cookie"]).split(";")[0];
  assert.equal((await get("/api/auth/session")).role,"member");
  assert.equal((await app.app.inject({method:"GET",url:"/api/cards/home",headers:{cookie}})).statusCode,403);
  const onboarding = await get("/api/me/onboarding");
  assert.equal(onboarding.role,"member");
  assert.equal(onboarding.displayName,"王路遥");
  assert.deepEqual(onboarding.work.battlefields.map((b:{id:string})=>b.id).sort(),["growth","product","supporting"]);
  assert.ok(onboarding.work.battlefields.every((b:{monthTarget:string|null})=>b.monthTarget));
  assert.equal(onboarding.work.missionCards.length,2);
  assert.ok(onboarding.work.missionCards.some((c:{phase:string})=>c.phase==="confirmed"));
  assert.ok(onboarding.work.missionCards.some((c:{phase:string})=>c.phase==="open"));
  for (const entry of seeded.productCards) {
    const detail = (await get(`/api/mission-cards/${entry.cardId}`)).cards[0].payload;
    assert.equal(detail.card.missions.length,2);
    for (const mission of detail.card.missions) {
      for (const field of ["title","why","outcome","successEvidence","boundaries","keyPath","milestones","resources","dependencies","humanAgentSplit","risk","retrospect"])
        assert.ok(mission[field]?.length,`${entry.ownerId}: ${field} empty`);
    }
  }
  console.log("PASS views: CEO product round with 4 cards and 5 opinions; DRI keeps original work and adds product card");

  const home = await get("/api/me/home");
  assert.equal(home.myTasks.length,8);
  assert.ok(home.myTasks.some((t:{status:string})=>t.status==="done"));
  assert.ok(home.myTasks.some((t:{source:string})=>t.source==="meeting"));
  assert.ok(home.myTasks.some((t:{source:string})=>t.source==="self"));
  assert.ok(home.myTasks.some((t:{waitingOn:unknown})=>t.waitingOn));
  assert.ok(home.myTasks.some((t:{mission:{step:number;steps:number}|null})=>t.mission?.step===1&&t.mission.steps===3));
  assert.ok(home.myTasks.some((t:{collaborators:unknown[]})=>t.collaborators.length>0));
  assert.ok(home.myTasks.some((t:{latestProgress:unknown})=>t.latestProgress));
  assert.ok(home.radar?.highlights?.length>0);
  assert.ok(home.radar.unreadCount>=1);
  assert.equal(home.radar.highlights[0].relevance,5);
  assert.equal(home.radar.highlights[0].state.read,false);
  console.log(`PASS home: ${home.myTasks.length} owned tasks, waiting/steps/collaborators, ${home.radar.highlights.length} radar highlights`);

  const radar = await get("/api/me/radar");
  assert.equal(radar.enabled,true);
  assert.equal(radar.directions.length,3);
  assert.equal(radar.sources.length,2);
  const signals = (await get("/api/me/radar/signals")).signals;
  assert.equal(signals.length,5);
  assert.ok(signals.some((s:{state:{read:boolean}})=>s.state.read));
  assert.ok(signals.some((s:{state:{read:boolean}})=>!s.state.read));
  console.log("PASS radar: 3 directions, 2 sources, 5 mixed read/unread demo signals");

  const notices = (await get("/api/me/notifications")).notifications;
  assert.equal(notices.filter((n:{readAt:string|null})=>n.readAt===null).length,2);
  assert.ok(notices.some((n:{text:string})=>n.text.includes("邀请你协作")));
  assert.ok(notices.some((n:{text:string})=>n.text.includes("团队协作交接对齐会")));
  const owned = await get(`/api/me/tasks/${seeded.tasks.a1}`);
  assert.equal(owned.role,"owner");
  assert.ok(owned.judgmentAt);
  assert.equal(owned.progress.length,2);
  assert.equal(owned.task.collaborators[0].name,"孙铭泽");
  const meetingTask = await get(`/api/me/tasks/${seeded.tasks.meeting}`);
  assert.equal(meetingTask.task.origin.meetingTitle,"团队协作交接对齐会");
  assert.ok(meetingTask.task.origin.quote);
  const invited = await get(`/api/me/tasks/${seeded.tasks.invited}`);
  assert.equal(invited.role,"collaborator");
  assert.ok(invited.myNoteAt);
  const plan = await get("/api/me/plan?period=2026-10");
  // 产品战场的卡还在讨论：已确定的团队协作卡照常能拆，讨论中的卡不进计划。
  assert.equal(plan.editable,true);
  assert.equal(plan.closedReason,null);
  assert.equal(plan.groups.length,3);
  assert.deepEqual(plan.groups.map((g:{items:unknown[]})=>g.items.length),[3,2,3]);
  const schedule = await get("/api/me/meetings");
  assert.deepEqual(schedule.meetings.map((m:{title:string})=>m.title),["产品战场双视角走查会"]);
  const unread = await get("/api/me/threads/unread");
  assert.deepEqual(unread.threads.map((t:{objectId:string})=>t.objectId).sort(),[seeded.tasks.a1,seeded.tasks.invited].sort());
  assert.ok(plan.groups.slice(0,2).every((g:{milestones:{date:string|null}[]})=>g.milestones.some(m=>m.date)));
  const thread = await get(`/api/threads/task/${seeded.tasks.a1}`);
  assert.ok(thread.messages.length>=4);
  const card = await get(`/api/mission-cards/${seeded.cardId}`);
  assert.equal(card.cards[0].payload.card.missions.length,2);
  for (const mission of card.cards[0].payload.card.missions) {
    for (const key of ["title","why","outcome","boundaries","keyPath","resources","dependencies","humanAgentSplit","risk","retrospect"])
      assert.ok(mission[key],`empty ${key}`);
    assert.ok(mission.successEvidence.length>0 && mission.milestones.length>0);
    assert.ok(mission.capabilityName && mission.battlefieldNames.length>0);
  }
  console.log("PASS notices, owner/collaborator details, 3 plan groups (discussed card stays out), meeting schedule, owner-read openings, dated milestones, task thread, personal card");
  const afterDeadline = new Date(new Date(product.payload.closesAt).getTime() + 1);
  await closeDueRounds(app.pool, () => afterDeadline);
  const reviewing = await getMissionRoundCard(
    (query,params)=>app!.sql(query,params).then((rows)=>({rows,rowCount:rows.length}) as never),
    people.people,"test-session-secret",{personId:LUYAO.personId,role:"ceo"},seeded.productRoundId,afterDeadline);
  assert.equal((reviewing?.payload as {phase:string;counts:{pending:number}}).phase,"reviewing");
  assert.equal((reviewing?.payload as {phase:string;counts:{pending:number}}).counts.pending,5);
  console.log("PASS product discussion deadline: 5 opinions await decider review");
  await clearWangLuyao(app,seeded.tasks);
  assert.equal((await app.sql("SELECT count(*)::int AS count FROM mission_rounds WHERE battlefield_id='supporting'"))[0].count,0);
  assert.equal((await app.sql("SELECT count(*)::int AS count FROM mission_rounds WHERE battlefield_id='product'"))[0].count,0);
  await app.sql("DELETE FROM monthly_plans WHERE id=$1",[planId]);
  await app.sql(`INSERT INTO monthly_plans (id,version,period,status,company_outcome,battlefields,todos,negotiation,generation,confirmed_at)
    VALUES ($1,1,'2026-10','confirmed','重新签发的演示目标',$2::jsonb,'[]',
      '{"edits":[],"checkedItemIds":[],"feedback":[],"note":""}',
      '{"status":"ready","pendingSince":null,"runId":null,"previousRunIds":[],"error":null,"generatedAt":null}',$3)`,
    [planId,JSON.stringify([{battlefieldId:"growth",outcome:"灯塔项目继续验证交接闭环。"},
      {battlefieldId:"supporting",outcome:"重新签发后恢复团队协作验收清单。"},
      {battlefieldId:"product",outcome:"重新签发后恢复双视角产品走查。"}]),now]);
  await seedWangLuyao(app,planId,now,"8742",TEST_CEO.personId);
  assert.equal((await get("/api/me/home")).myTasks.length,8);
  console.log("PASS target-stage cleanup and reseed: plan can be replaced; login remains valid");
} finally {
  await app?.close();
  await rm(fixtureDir,{recursive:true,force:true});
}
}
void main().catch((error)=>{ console.error(error); process.exitCode=1; });
