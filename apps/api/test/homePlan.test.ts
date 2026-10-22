import { randomUUID } from "node:crypto";
import { describe,expect,it } from "vitest";
import type { THomePlanTask } from "@warmap/contracts";
import { call,executionFixture,newTask,type Fixture } from "./executionFixture.js";
import { TEST_MEMBER } from "./helpers.js";

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
      await f.t.sql("UPDATE tasks SET status='in_progress' WHERE id=$1",[running.id]);
      await f.t.sql("UPDATE tasks SET status='done' WHERE id=$1",[done.id]);
      const plan=await read(f,f.member);
      expect(plan).toMatchObject({period:"2026-10",fallbackFrom:null,today:"2026-10-22",weekStart:"2026-10-19",weekEnd:"2026-10-25"});
      expect(plan.activities).toHaveLength(6);
      expect(byTitle(plan.activities)).toEqual({
        "只有截止已过期":{missionId:"execution-one",column:"week",overdue:true},
        "下周开始":{missionId:"execution-one",column:"later",overdue:false},
        "没日期进行中":{missionId:"execution-two",column:"week",overdue:false},
        "没日期没开始":{missionId:null,column:"later",overdue:false},
        "已完成":{missionId:"execution-two",column:"done",overdue:false},
        "本周截止":{missionId:"execution-one",column:"week",overdue:false},
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
      expect(byTitle((await read(f,f.member)).activities)).toEqual({
        "跨月":{missionId:null,column:"week",overdue:false},
        "下月初到期":{missionId:null,column:"week",overdue:false},
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

  it("回退到上一个有 Mission 的月份",async()=>{
    const f=await executionFixture("confirmed","2026-09");
    try {
      f.setNow(OCT_22);
      await f.t.sql(`INSERT INTO missions(id,version,code,period,title,owner_id,capability_id,battlefield_ids,outcome,milestones,
        source_ref,source_document_id,source_revision,source_title)
        VALUES('august-one',1,'august-one','2026-08','八月',$1,'method','["growth"]','目标','[]','fixture://a','fixture',1,'fixture')`,[TEST_MEMBER.personId]);
      await create(f,f.member,null,{title:"本周到期的独立事项",dueDate:"2026-10-23"});
      const plan=await read(f,f.member);
      expect(plan).toMatchObject({period:"2026-09",fallbackFrom:"2026-09",today:"2026-10-22",weekStart:"2026-10-19",weekEnd:"2026-10-25"});
      expect(plan.missions.map((m:{missionId:string})=>m.missionId)).toEqual(["execution-one","execution-two"]);
      expect(plan.days).toHaveLength(30);
      expect(plan.days[0]).toEqual({date:"2026-09-01",workday:true});
      expect(byTitle(plan.activities)).toEqual({"本周到期的独立事项":{missionId:null,column:"week",overdue:false}});
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
      await f.t.sql(`UPDATE missions SET milestones='["10/28 上线","没有日期","11/03 下月"]' WHERE id='execution-one'`);
      await f.t.sql(`UPDATE missions SET milestones='[]' WHERE id='execution-two'`);
      await f.t.sql(`INSERT INTO missions(id,version,code,period,title,owner_id,capability_id,battlefield_ids,outcome,milestones,
        source_ref,source_document_id,source_revision,source_title,placeholder)
        VALUES('placeholder-one',1,'a-placeholder','2026-10','占位',$1,'method','["growth"]','目标','["10/15 占位关口"]','fixture://p','fixture',1,'fixture',true)`,
      [TEST_MEMBER.personId]);
      const plan=await read(f,f.member);
      expect(plan.gates).toEqual([{missionId:"execution-one",date:"2026-10-28",label:"上线"}]);
      expect(plan.missions).toEqual([
        {missionId:"execution-one",code:"execution-one",title:"上线",cardId:f.card,color:"#2f63b0"},
        {missionId:"execution-two",code:"execution-two",title:"验证",cardId:f.card,color:"#2f8a7a"},
      ]);
      expect(plan.marks).toEqual([]);
      expect(plan.tasks).toEqual([task]);
      expect(calls).toEqual([[{id:"execution-one",code:"execution-one"},{id:"execution-two",code:"execution-two"}]]);
    } finally { await f.t.close(); }
  });

  it("任务卡没确认时 Mission 和关口照常出，事项带上 missionId",async()=>{
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
