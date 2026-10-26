import { randomUUID } from "node:crypto";
import { describe,expect,it,vi } from "vitest";
import type { THomePlanTask } from "@warmap/contracts";
import { buildApp } from "../src/app.js";
import { clearWorldReadCache } from "../src/worldReader.js";
import { call,executionFixture,newTask,type Fixture } from "./executionFixture.js";
import { TEST_MEMBER } from "./helpers.js";
import { stubWorld } from "./worldFixture.js";

const OCT_22=new Date("2026-10-22T02:00:00.000Z");
const create=async(f:Fixture,cookie:string,missionId:string|null,extra:Record<string,unknown>)=>{
  const res=await call(f,cookie,"POST","/api/me/tasks",newTask(missionId,{startDate:undefined,dueDate:undefined,...extra}));
  expect(res.statusCode).toBe(200);
  return res.json() as { id:string };
};
const read=async(f:Fixture,cookie:string)=>{
  const res=await call(f,cookie,"GET","/api/me/home-plan");
  expect(res.statusCode).toBe(200);
  return res.json();
};
type Activity={ item:{ title:string; mission:unknown }; missionId:string|null; column:string; overdue:boolean };
const byTitle=(activities:Activity[])=>Object.fromEntries(activities.map((a)=>[a.item.title,{missionId:a.missionId,column:a.column,overdue:a.overdue}]));
const titles=(activities:Activity[])=>activities.map((a)=>a.item.title);

describe("首页计划",()=>{
  it("最近一次动静：取最新进展，没有进展用创建时间；进行中且过了 3 个工作日才算停滞，按自然日报天数",async()=>{
    const f=await executionFixture();
    try {
      f.setNow(OCT_22);
      const quiet=await create(f,f.member,"execution-one",{title:"上周五写过进展"});
      const fresh=await create(f,f.member,"execution-one",{title:"前天写过进展"});
      const idle=await create(f,f.member,"execution-one",{title:"没进展但很久前建的"});
      const waiting=await create(f,f.member,"execution-one",{title:"没开始"});
      const submitted=await create(f,f.member,"execution-one",{title:"等验收"});
      await f.t.sql("UPDATE tasks SET status='in_progress' WHERE id=ANY($1::uuid[])",[[quiet.id,fresh.id,idle.id,submitted.id]]);
      await f.t.sql(`UPDATE tasks SET created_at='2026-10-09T02:00:00Z',submission='{"at":"2026-10-12T02:00:00Z","by":"x","standards":[]}'::jsonb WHERE id=$1`,[submitted.id]);
      await f.t.sql("UPDATE tasks SET created_at=$2 WHERE id=ANY($1::uuid[])",[[idle.id,waiting.id],"2026-10-09T02:00:00Z"]);
      const progress=(id:string,at:string)=>f.t.sql(`INSERT INTO task_progress(id,task_id,author_id,source,body,created_at) VALUES($1,$2,$3,'web','进展',$4)`,[randomUUID(),id,TEST_MEMBER.personId,at]);
      // 10/16（周五）之后：10/19、10/20、10/21、10/22 四个工作日 → 停滞 6 天。
      await progress(quiet.id,"2026-10-16T03:00:00Z");
      // 10/20 之后：10/21、10/22 两个工作日 → 不算停滞。
      await progress(fresh.id,"2026-10-20T03:00:00Z");
      const plan=await read(f,f.member);
      const of=(id:string)=>plan.activities.find((a:{item:{id:string}})=>a.item.id===id);
      expect(of(quiet.id)).toMatchObject({lastActivityAt:"2026-10-16T03:00:00.000Z",idleDays:6});
      expect(of(fresh.id)).toMatchObject({lastActivityAt:"2026-10-20T03:00:00.000Z",idleDays:null});
      expect(of(idle.id)).toMatchObject({lastActivityAt:"2026-10-09T02:00:00.000Z",idleDays:13});
      expect(of(waiting.id)).toMatchObject({lastActivityAt:"2026-10-09T02:00:00.000Z",idleDays:null});
      expect(of(submitted.id)).toMatchObject({item:{awaitingAcceptance:true},idleDays:null});
    } finally { await f.t.close(); }
  });

  it("每种日期组合落到唯一一栏",async()=>{
    const f=await executionFixture();
    try {
      f.setNow(OCT_22);
      await create(f,f.member,"execution-one",{title:"只有截止已过期",dueDate:"2026-10-15"});
      await create(f,f.member,"execution-one",{title:"下周开始",startDate:"2026-10-27"});
      const running=await create(f,f.member,"execution-two",{title:"没日期进行中"});
      await create(f,f.member,null,{title:"没日期没开始"});
      const done=await create(f,f.member,"execution-two",{title:"已完成",dueDate:"2026-10-12"});
      await create(f,f.member,"execution-one",{title:"本周截止",dueDate:"2026-10-23"});
      await create(f,f.member,"execution-one",{title:"只有截止在下周没开始",dueDate:"2026-10-28"});
      const dueLater=await create(f,f.member,"execution-two",{title:"只有截止在下周进行中",dueDate:"2026-10-28"});
      await f.t.sql("UPDATE tasks SET status='in_progress' WHERE id=ANY($1::uuid[])",[[running.id,dueLater.id]]);
      await f.t.sql("UPDATE tasks SET status='done' WHERE id=$1",[done.id]);
      const plan=await read(f,f.member);
      expect(plan).toMatchObject({period:"2026-10",fallbackFrom:null,today:"2026-10-22",weekStart:"2026-10-19",weekEnd:"2026-10-25"});
      expect(plan.activities).toHaveLength(8);
      expect(byTitle(plan.activities)).toEqual({
        "只有截止已过期":{missionId:"execution-one",column:"week",overdue:true},
        "下周开始":{missionId:"execution-one",column:"later",overdue:false},
        "没日期进行中":{missionId:"execution-two",column:"week",overdue:false},
        "没日期没开始":{missionId:null,column:"later",overdue:false},
        "已完成":{missionId:"execution-two",column:"done",overdue:false},
        "本周截止":{missionId:"execution-one",column:"week",overdue:false},
        "只有截止在下周没开始":{missionId:"execution-one",column:"later",overdue:false},
        "只有截止在下周进行中":{missionId:"execution-two",column:"week",overdue:false},
      });
    } finally { await f.t.close(); }
  });

  it("独立事项和本月、本周有交集就列出；本月计划仍只收落在本月里的",async()=>{
    const f=await executionFixture();
    try {
      f.setNow(OCT_22);
      await create(f,f.member,null,{title:"跨月",startDate:"2026-10-20",dueDate:"2026-11-05"});
      await create(f,f.member,null,{title:"下月初到期",dueDate:"2026-11-01"});
      await create(f,f.member,null,{title:"下月一号当天",startDate:"2026-11-01",dueDate:"2026-11-01"});
      // 没开始、只写了截止：截止在本周以后的放「之后」。
      expect(byTitle((await read(f,f.member)).activities)).toEqual({
        "跨月":{missionId:null,column:"week",overdue:false},
        "下月初到期":{missionId:null,column:"later",overdue:false},
      });
      const month=(await call(f,f.member,"GET","/api/me/plan?period=2026-10")).json();
      expect(month.groups.at(-1).items).toEqual([]);
      f.setNow(new Date("2026-10-30T02:00:00.000Z"));
      const plan=await read(f,f.member);
      expect(plan).toMatchObject({today:"2026-10-30",weekStart:"2026-10-26",weekEnd:"2026-11-01"});
      expect(byTitle(plan.activities)).toEqual({
        "跨月":{missionId:null,column:"week",overdue:false},
        "下月初到期":{missionId:null,column:"week",overdue:false},
        "下月一号当天":{missionId:null,column:"week",overdue:false},
      });
    } finally { await f.t.close(); }
  });

  it("之前没做完的也列出，放本周算逾期：截止在 9 月的独立事项、挂在 9 月 Mission 下的；做完的不列，本月计划不变",async()=>{
    const f=await executionFixture();
    try {
      f.setNow(OCT_22);
      await f.t.sql(`INSERT INTO missions(id,version,code,period,title,owner_id,capability_id,battlefield_ids,outcome,milestones,
        source_ref,source_document_id,source_revision,source_title)
        VALUES('september-one',1,'september-one','2026-09','九月',$1,'method','["growth"]','目标','[]','fixture://s','fixture',1,'fixture')`,[TEST_MEMBER.personId]);
      await create(f,f.member,null,{title:"九月底到期没做完",dueDate:"2026-09-28"});
      const doneLate=await create(f,f.member,null,{title:"九月底到期做完了",dueDate:"2026-09-28"});
      // 九月里做完的（完成时间在九月）不列。
      await f.t.sql("UPDATE tasks SET status='done',updated_at='2026-09-28T02:00:00Z' WHERE id=$1",[doneLate.id]);
      for (const [title,status] of [["九月 Mission 没做完","not_started"],["九月 Mission 进行中","in_progress"],["九月 Mission 做完了","done"]])
        await f.t.sql(`INSERT INTO tasks(id,title,owner_id,created_by,status,mission_id,step_order,client_id,updated_at)
          VALUES($1,$2,$3,'self',$4,'september-one',1,$5,'2026-09-28T02:00:00Z')`,[randomUUID(),title,TEST_MEMBER.personId,status,randomUUID()]);
      const plan=await read(f,f.member);
      expect(plan.missions.map((m:{missionId:string})=>m.missionId)).toEqual(["execution-one","execution-two"]);
      expect(byTitle(plan.activities)).toEqual({
        "九月底到期没做完":{missionId:null,column:"week",overdue:true},
        "九月 Mission 没做完":{missionId:"september-one",column:"week",overdue:true},
        "九月 Mission 进行中":{missionId:"september-one",column:"week",overdue:true},
      });
      const month=(await call(f,f.member,"GET","/api/me/plan?period=2026-10")).json();
      expect(month.groups.flatMap((group:{items:{title:string}[]})=>group.items.map((item)=>item.title))).toEqual([]);
    } finally { await f.t.close(); }
  });

  it("已完成只列本月完成的（按验收时间，没有验收记录看更新时间，公司时区），不管日期和挂在哪",async()=>{
    const f=await executionFixture();
    try {
      f.setNow(OCT_22);
      const loose=await create(f,f.member,null,{title:"没日期本月完成"});
      const accepted=await create(f,f.member,"execution-one",{title:"九月截止十月验收",dueDate:"2026-09-20"});
      const lastMonth=await create(f,f.member,"execution-one",{title:"本月 Mission 九月就完成了"});
      const boundary=await create(f,f.member,null,{title:"九月三十号晚上完成",dueDate:"2026-10-01"});
      await f.t.sql("UPDATE tasks SET status='done' WHERE id=ANY($1::uuid[])",[[loose.id,accepted.id,lastMonth.id,boundary.id]]);
      await f.t.sql(`UPDATE tasks SET updated_at='2026-09-01T02:00:00Z',acceptance=jsonb_build_object('at','2026-10-05T02:00:00Z','by',$2::text,'verdict',null,'standards','[]'::jsonb,'deliverableMaterialIds','[]'::jsonb) WHERE id=$1`,[accepted.id,TEST_MEMBER.personId]);
      await f.t.sql("UPDATE tasks SET updated_at='2026-09-30T02:00:00Z' WHERE id=$1",[lastMonth.id]);
      // 上海时间 9/30 23:30 = UTC 15:30，算九月。
      await f.t.sql("UPDATE tasks SET updated_at='2026-09-30T15:30:00Z' WHERE id=$1",[boundary.id]);
      expect(byTitle((await read(f,f.member)).activities)).toEqual({
        "没日期本月完成":{missionId:null,column:"done",overdue:false},
        "九月截止十月验收":{missionId:"execution-one",column:"done",overdue:false},
      });
    } finally { await f.t.close(); }
  });

  it("回退到上一个有 Mission 的月份",async()=>{
    const f=await executionFixture("confirmed","2026-09");
    try {
      f.setNow(OCT_22);
      await f.t.sql(`INSERT INTO missions(id,version,code,period,title,owner_id,capability_id,battlefield_ids,outcome,milestones,
        source_ref,source_document_id,source_revision,source_title)
        VALUES('august-one',1,'august-one','2026-08','八月',$1,'method','["growth"]','目标','[]','fixture://a','fixture',1,'fixture')`,[TEST_MEMBER.personId]);
      await create(f,f.member,null,{title:"本周到期的独立事项",dueDate:"2026-10-23"});
      for (const [title,missionId] of [["八月 Mission 没做完","august-one"],["九月 Mission 没做完","execution-one"]])
        await f.t.sql(`INSERT INTO tasks(id,title,owner_id,created_by,status,mission_id,step_order,client_id)
          VALUES($1,$2,$3,'self','not_started',$4,1,$5)`,[randomUUID(),title,TEST_MEMBER.personId,missionId,randomUUID()]);
      const plan=await read(f,f.member);
      expect(plan).toMatchObject({period:"2026-09",fallbackFrom:"2026-09",today:"2026-10-22",weekStart:"2026-10-19",weekEnd:"2026-10-25"});
      expect(plan.missions.map((m:{missionId:string})=>m.missionId)).toEqual(["execution-one","execution-two"]);
      expect(plan.days).toHaveLength(30);
      expect(plan.days[0]).toEqual({date:"2026-09-01",workday:true});
      // 显示的是 9 月：9 月 Mission 下的照常分栏，更早（8 月）Mission 下没做完的放本周算逾期。
      expect(byTitle(plan.activities)).toEqual({
        "本周到期的独立事项":{missionId:null,column:"week",overdue:false},
        "八月 Mission 没做完":{missionId:"august-one",column:"week",overdue:true},
        "九月 Mission 没做完":{missionId:"execution-one",column:"later",overdue:false},
      });
      const nobody=await read(f,f.third);
      expect(nobody).toMatchObject({period:"2026-10",fallbackFrom:null,missions:[],gates:[],activities:[]});
      expect(nobody.days).toHaveLength(31);
    } finally { await f.t.close(); }
  });

  it("签定关口解析，Mission 按 code 排序并带颜色和任务卡；占位 Mission 和月外关口不出现",async()=>{
    const calls:{ id:string; code:string }[][]=[];
    const task:THomePlanTask={taskId:"task-1",missionId:"execution-one",name:"上线准备",doneDefinition:null,criteria:["能用"]};
    const f=await executionFixture("confirmed","2026-10",{planTasks:async(missions)=>{ calls.push(missions); return [task]; }});
    try {
      f.setNow(OCT_22);
      await f.t.sql(`UPDATE missions SET milestones='["10/28 上线","没有日期","11/03 下月","10/29：试用","10/30: 收尾","10/31、复盘","10/27 - 联调"]' WHERE id='execution-one'`);
      await f.t.sql(`UPDATE missions SET milestones='[]' WHERE id='execution-two'`);
      await f.t.sql(`INSERT INTO missions(id,version,code,period,title,owner_id,capability_id,battlefield_ids,outcome,milestones,
        source_ref,source_document_id,source_revision,source_title,placeholder)
        VALUES('placeholder-one',1,'a-placeholder','2026-10','占位',$1,'method','["growth"]','目标','["10/15 占位关口"]','fixture://p','fixture',1,'fixture',true)`,
      [TEST_MEMBER.personId]);
      const mark=(await call(f,f.member,"POST","/api/me/plan-marks",{missionId:"execution-one",date:"2026-10-26",label:"联调"})).json();
      await f.t.sql("INSERT INTO plan_marks(owner_id,mission_id,date,label) VALUES($1,'placeholder-one','2026-10-26','占位上的点')",[TEST_MEMBER.personId]);
      const plan=await read(f,f.member);
      // 日期后面的空白和分隔符（：: 、 -）一起去掉。
      expect(plan.gates).toEqual([["2026-10-28","上线"],["2026-10-29","试用"],["2026-10-30","收尾"],["2026-10-31","复盘"],["2026-10-27","联调"]]
        .map(([date,label])=>({missionId:"execution-one",date,label})));
      expect(plan.missions).toEqual([
        {missionId:"execution-one",code:"execution-one",title:"上线",cardId:f.card,color:"#2f63b0",world:null},
        {missionId:"execution-two",code:"execution-two",title:"验证",cardId:f.card,color:"#2f8a7a",world:null},
      ]);
      expect(plan.marks).toEqual([mark]);
      expect(plan.tasks).toEqual([task]);
      expect(calls).toEqual([[{id:"execution-one",code:"execution-one",world:null},{id:"execution-two",code:"execution-two",world:null}]]);
    } finally { await f.t.close(); }
  });

  it("任务卡没确认时 Mission 和关口照常出；事项上的 Mission 为空（卡在准备，不给读），仍按 missionId 归到这个 Mission",async()=>{
    const f=await executionFixture("open");
    try {
      f.setNow(OCT_22);
      await f.t.sql(`INSERT INTO tasks(id,title,owner_id,created_by,status,mission_id,step_order,client_id)
        VALUES($1,'未确认卡上的事项',$2,'self','not_started','execution-one',1,$3)`,[randomUUID(),TEST_MEMBER.personId,randomUUID()]);
      const plan=await read(f,f.member);
      expect(plan.missions.map((m:{missionId:string})=>m.missionId)).toEqual(["execution-one","execution-two"]);
      expect(plan.gates).toEqual(["execution-one","execution-two"].flatMap((missionId)=>[
        {missionId,date:"2026-10-12",label:"交付"},{missionId,date:"2026-10-20",label:"复盘"},
      ]));
      expect(plan.activities).toHaveLength(1);
      expect(plan.activities[0]).toMatchObject({item:{title:"未确认卡上的事项",mission:null},missionId:"execution-one",column:"later"});
    } finally { await f.t.close(); }
  });

  it("Task 来源抛错时降级",async()=>{
    const f=await executionFixture("confirmed","2026-10",{planTasks:async()=>{ throw new Error("本体读不到"); }});
    try {
      f.setNow(OCT_22);
      await create(f,f.member,"execution-one",{title:"照常列出"});
      const plan=await read(f,f.member);
      expect(plan.tasks).toEqual([]);
      expect(plan.missions).toHaveLength(2);
      expect(titles(plan.activities)).toEqual(["照常列出"]);
    } finally { await f.t.close(); }
  });

  it("Task 来源一直不回：首页按时出（约 2.5 秒），没有 Task 行，本地内容照常",async()=>{
    const f=await executionFixture("confirmed","2026-10",{planTasks:()=>new Promise<THomePlanTask[]>(()=>undefined)});
    try {
      f.setNow(OCT_22);
      await create(f,f.member,"execution-one",{title:"照常列出"});
      const started=Date.now();
      const plan=await read(f,f.member);
      const elapsed=Date.now()-started;
      expect(elapsed).toBeGreaterThanOrEqual(2_400);
      expect(elapsed).toBeLessThan(8_000);
      expect(plan.tasks).toEqual([]);
      expect(plan.missions).toHaveLength(2);
      expect(titles(plan.activities)).toEqual(["照常列出"]);
    } finally { await f.t.close(); }
  },20_000);

  it("配了本体：实例开了读才从本体读 Task；没开读（mvp 实例）不去读",async()=>{
    const f=await executionFixture();
    const calls=stubWorld(({url})=>{
      if (url.pathname==="/v1/world/objects") {
        if (url.searchParams.get("external_id")==="mission:execution-one") return {items:[{object_id:"mission-1",object_type:"Mission",domain_id:"domain-eo"}],next_cursor:null};
        if (url.searchParams.get("type")==="Task") return {items:[{object_id:"task-a",object_type:"Task"}],next_cursor:null};
        return {items:[],next_cursor:null};
      }
      if (url.pathname==="/v1/world/objects/task-a") return {business:{object_id:"task-a",object_type:"Task",title:"回流方案定稿",
        relations:[{field:"parent_ref",relation:"belongs_to",value:{object_id:"mission-1",ref:"mission-1@2"}}],
        blocks:[{id:"definition",value:{components:[{type:"outcome",text:"会议结论写进本体"},{type:"acceptance_criterion",text:"纪要能读回"}]}}]}};
      return {ok:true};
    });
    const runtime={ async run(){ return { assistantMessage:"test", runtimeEntries:[] }; } };
    const world={worldApiUrl:"https://world.test",worldAgentToken:"fake-world-token-for-tests"};
    try {
      for (const [worldInstance,expected] of [["demo",[{taskId:"task-a",missionId:"execution-one",name:"回流方案定稿",doneDefinition:"会议结论写进本体",criteria:["纪要能读回"]}]],["mvp",[]]] as const) {
        clearWorldReadCache();
        const app=await buildApp({pool:f.t.pool,env:{...f.t.env,...world,worldInstance},conversationRuntime:runtime,now:()=>OCT_22});
        try {
          const res=await app.inject({method:"GET",url:"/api/me/home-plan",headers:{cookie:f.member,origin:f.t.publicOrigin}});
          expect(res.statusCode).toBe(200);
          expect(res.json().tasks).toEqual(expected);
        } finally { await app.close(); }
      }
      expect(calls.filter(({url})=>url.searchParams.get("type")==="Task")).toHaveLength(1);
      expect(calls.every(({method})=>method==="GET")).toBe(true);
    } finally { vi.unstubAllGlobals(); clearWorldReadCache(); await f.t.close(); }
  },30_000);

  it("别人的 Mission 和事项不出现",async()=>{
    const f=await executionFixture();
    try {
      f.setNow(OCT_22);
      await f.t.sql(`INSERT INTO missions(id,version,code,period,title,owner_id,capability_id,battlefield_ids,outcome,milestones,
        source_ref,source_document_id,source_revision,source_title)
        VALUES('other-one',1,'a-other-one','2026-10','别人的',$1,'method','["growth"]','目标','["10/15 别人的关口"]','fixture://o','fixture',1,'fixture')`,
      ["person-fixture-003"]);
      await create(f,f.third,null,{title:"别人的事项",dueDate:"2026-10-23"});
      await create(f,f.member,null,{title:"我的事项",dueDate:"2026-10-23"});
      const plan=await read(f,f.member);
      expect(plan.missions.map((m:{missionId:string})=>m.missionId)).toEqual(["execution-one","execution-two"]);
      expect(plan.gates.map((g:{missionId:string})=>g.missionId)).not.toContain("other-one");
      expect(titles(plan.activities)).toEqual(["我的事项"]);
      expect((await call(f,f.ceo,"GET","/api/me/home-plan")).statusCode).toBe(403);
    } finally { await f.t.close(); }
  });
});
