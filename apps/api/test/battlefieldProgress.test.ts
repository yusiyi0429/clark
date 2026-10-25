import { randomUUID } from "node:crypto";
import { describe,expect,it } from "vitest";
import { Value } from "@sinclair/typebox/value";
import { BattlefieldProgressResponse } from "@warmap/contracts";
import { call,executionFixture,newTask,type Fixture } from "./executionFixture.js";
import { TEST_CEO,TEST_MEMBER } from "./helpers.js";

const THIRD="person-fixture-003";
const OCT_22=new Date("2026-10-22T02:00:00.000Z");
const read=async(f:Fixture,cookie:string)=>{
  const res=await call(f,cookie,"GET","/api/me/battlefield-progress");
  expect(res.statusCode).toBe(200);
  expect(Value.Check(BattlefieldProgressResponse,res.json())).toBe(true);
  return res.json();
};
const mission=(f:Fixture,id:string,owner:string,capability:string,battlefields:string[])=>f.t.sql(`INSERT INTO missions(id,version,code,period,title,owner_id,
  capability_id,battlefield_ids,outcome,source_ref,source_document_id,source_revision,source_title) VALUES($1,1,$1,'2026-10',$2,$3,$4,$5::jsonb,'目标','world:m','world',1,'world')`,
[id,`Mission ${id}`,owner,capability,JSON.stringify(battlefields)]);
const task=async(f:Fixture,owner:string,missionId:string,title:string,extra:{status?:string;start?:string;due?:string;blocked?:string;waiting?:string;blockedAt?:string}={})=>{
  const id=randomUUID();
  await f.t.sql(`INSERT INTO tasks(id,title,owner_id,created_by,status,mission_id,step_order,client_id,start_date,due_date,blocked_reason,waiting_on,blocked_at)
    VALUES($1,$2,$3,'self',$4,$5,(SELECT COALESCE(max(step_order),0)+1 FROM tasks WHERE mission_id=$5),$6,$7,$8,$9,$10,$11)`,
  [id,title,owner,extra.status??"in_progress",missionId,randomUUID(),extra.start??null,extra.due??null,extra.blocked??null,extra.waiting??null,
    extra.blocked?(extra.blockedAt??"2026-10-20T02:00:00Z"):null]);
  return id;
};

describe("战场进展（成员）",()=>{
  it("按我所在的战场分组：月度目标、需要搭把手（卡住 > 过了截止）、每人一张卡（我排第一）；别的战场、CEO 不出卡",async()=>{
    const f=await executionFixture();
    try {
      f.setNow(OCT_22);
      // 两个 Mission 的截止挪到 10/30，免得「按截止做不完」盖住这里要看的几种。
      await f.t.sql(`UPDATE missions SET milestones='["10/30 复盘"]'::jsonb WHERE id IN ('execution-one','execution-two')`);
      await mission(f,"third-growth",THIRD,"method",["growth"]);
      const blocked=await task(f,THIRD,"third-growth","接口联调",{blocked:"等对方给测试账号",waiting:TEST_MEMBER.personId});
      await task(f,THIRD,"third-growth","已完成的",{status:"done"});
      const late=await task(f,TEST_MEMBER.personId,"execution-one","过了截止",{start:"2026-10-12",due:"2026-10-16"});
      await task(f,TEST_MEMBER.personId,"execution-two","按计划",{start:"2026-10-21",due:"2026-10-30"});
      await f.t.sql("INSERT INTO task_progress(id,task_id,author_id,source,body,created_at) VALUES($1,$2,$3,'web',$4,'2026-10-21T03:00:00Z')",
        [randomUUID(),blocked,THIRD,"对方还没回\n第二行"]);
      await f.t.sql("INSERT INTO battlefield_config (id,version,code,name,six_month_outcome) VALUES ('product',1,'03','产品战场','产品半年目标')");
      await mission(f,"other-bf",TEST_CEO.personId,"method",["product"]);
      const { groups }=await read(f,f.member);
      expect(groups.map((g:{name:string;kind:string;goal:string|null})=>[g.name,g.kind,g.goal])).toEqual([["增长战场","battlefield","本月目标"]]);
      const growth=groups[0];
      expect(growth.counts).toEqual({missions:3,onTrack:1,slow:1,blocked:1});
      expect(growth.help.map((h:{kind:string;task:{title:string}|null})=>[h.kind,h.task?.title])).toEqual([["blocked","接口联调"],["overdue","过了截止"]]);
      expect(growth.help[0]).toMatchObject({person:{personId:THIRD},reason:"等对方给测试账号",waitingOn:{personId:TEST_MEMBER.personId},waitingOnMe:true,days:2,canOpen:false});
      expect(growth.help[1]).toMatchObject({task:{taskId:late},dueDate:"2026-10-16",days:4,canOpen:true});
      expect(growth.people.map((p:{person:{personId:string};me:boolean})=>[p.person.personId,p.me])).toEqual([[TEST_MEMBER.personId,true],[THIRD,false]]);
      expect(growth.people[1]).toMatchObject({movedThisWeek:1,latest:{text:"对方还没回",at:"2026-10-21T03:00:00.000Z"},
        missions:[{missionId:"third-growth",done:1,total:2,flag:"blocked"}]});
      expect(JSON.stringify(groups)).not.toContain("other-bf");
    } finally { await f.t.close(); }
  });

  it("本月没有战场：按我本月 Mission 的业务域分组，只看到同一业务域的 Mission；同组的人看得到彼此",async()=>{
    const f=await executionFixture();
    try {
      f.setNow(OCT_22);
      await f.t.sql("INSERT INTO capability_config (id,version,code,name,six_month_outcome) VALUES ('agents',1,'07','Agents','')");
      await mission(f,"third-agents",THIRD,"agents",[]);
      await mission(f,"member-agents",TEST_MEMBER.personId,"agents",[]);
      await task(f,TEST_MEMBER.personId,"member-agents","写宿主接口");
      await task(f,TEST_MEMBER.personId,"execution-one","增长战场里的事");
      const third=await f.t.app.inject({method:"GET",url:"/api/me/battlefield-progress",headers:{cookie:f.third,origin:f.t.publicOrigin}});
      expect(third.statusCode).toBe(200);
      const { groups }=third.json();
      expect(groups.map((g:{name:string;kind:string;goal:string|null})=>[g.name,g.kind,g.goal])).toEqual([["Agents","capability",null]]);
      expect(groups[0].people.map((p:{person:{personId:string}})=>p.person.personId)).toEqual([THIRD,TEST_MEMBER.personId]);
      expect(groups[0].people[1].missions.map((m:{missionId:string;total:number})=>[m.missionId,m.total])).toEqual([["member-agents",1]]);
      expect(JSON.stringify(groups)).not.toContain("增长战场里的事");
      // 我有战场，就只按战场分，不再看业务域。
      expect((await read(f,f.member)).groups.map((g:{kind:string})=>g.kind)).toEqual(["battlefield"]);
    } finally { await f.t.close(); }
  });

  it("推进人写「卡在哪 / 在等谁」：在等的人要在名单里且不是自己；清掉卡在哪连同在等谁一起清；改写原因不重算起点",async()=>{
    const f=await executionFixture();
    try {
      const created=(await call(f,f.member,"POST","/api/me/tasks",newTask("execution-one"))).json();
      const bad=await call(f,f.member,"PATCH",`/api/me/tasks/${created.id}`,{version:1,blockedReason:"等账号",waitingOn:"nobody"});
      expect(bad.statusCode).toBe(400);
      expect((await call(f,f.member,"PATCH",`/api/me/tasks/${created.id}`,{version:1,blockedReason:"等账号",waitingOn:TEST_MEMBER.personId})).statusCode).toBe(400);
      const set=(await call(f,f.member,"PATCH",`/api/me/tasks/${created.id}`,{version:1,blockedReason:"等账号",waitingOn:THIRD})).json();
      expect(set.blocker).toMatchObject({reason:"等账号",waitingOn:{personId:THIRD}});
      const since=set.blocker.since;
      const reworded=(await call(f,f.member,"PATCH",`/api/me/tasks/${created.id}`,{version:2,blockedReason:"等测试账号"})).json();
      expect(reworded.blocker).toMatchObject({reason:"等测试账号",waitingOn:{personId:THIRD},since});
      const cleared=(await call(f,f.member,"PATCH",`/api/me/tasks/${created.id}`,{version:3,blockedReason:null})).json();
      expect(cleared.blocker).toBeNull();
      expect((await f.t.sql("SELECT waiting_on,blocked_at FROM tasks WHERE id=$1",[created.id]))[0]).toEqual({waiting_on:null,blocked_at:null});
    } finally { await f.t.close(); }
  });
});
