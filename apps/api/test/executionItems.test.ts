import { randomUUID } from "node:crypto";
import { describe,expect,it } from "vitest";
import { Value } from "@sinclair/typebox/value";
import { TaskView } from "@warmap/contracts";
import { call,executionFixture,newTask } from "./executionFixture.js";
import { TEST_CEO,TEST_MEMBER } from "./helpers.js";
import { getScopeObject } from "../src/conversations.js";
import { loadPeopleDirectory } from "../src/peopleDirectory.js";

describe("执行事项",()=>{
  it("自建幂等、归属校验、步骤与版本冲突",async()=>{
    const f=await executionFixture();
    try {
      const input=newTask();
      const first=await call(f,f.member,"POST","/api/me/tasks",input);
      expect(first.statusCode).toBe(200);
      expect(Value.Check(TaskView,first.json())).toBe(true);
      expect(first.json()).toMatchObject({source:"self",mission:{missionId:"execution-one",step:1,steps:1}});
      const again=await call(f,f.member,"POST","/api/me/tasks",input);
      expect(again.json().id).toBe(first.json().id);
      expect((await call(f,f.member,"POST","/api/me/tasks",{...input,title:"不同标题"})).json().code).toBe("CLIENT_ID_CONFLICT");
      expect((await call(f,f.member,"POST","/api/me/tasks",newTask("unowned"))).json().code).toBe("MISSION_NOT_AVAILABLE");
      const second=(await call(f,f.member,"POST","/api/me/tasks",newTask())).json();
      expect(second.mission).toMatchObject({step:2,steps:2});
      expect(second.waitingOn).toMatchObject({taskId:first.json().id});
      const moved=await call(f,f.member,"PATCH",`/api/me/tasks/${first.json().id}`,{version:1,missionId:"execution-two",judgment:"先验证"});
      expect(moved.json().mission).toMatchObject({missionId:"execution-two",step:1});
      const judged=(await call(f,f.member,"GET",`/api/me/tasks/${first.json().id}`)).json();
      expect(judged.judgment).toBe("先验证"); expect(judged.judgmentAt).toEqual(expect.any(String));
      expect((await call(f,f.member,"GET",`/api/me/tasks/${second.id}`)).json().task.mission).toMatchObject({step:1,steps:1});
      const stale=await call(f,f.member,"PATCH",`/api/me/tasks/${first.json().id}`,{version:1,status:"in_progress"});
      expect(stale.statusCode).toBe(409); expect(stale.json().latestTask.version).toBe(2);
      const context=await getScopeObject(async(sql,params)=>{ const rows=await f.t.sql(sql,params); return {rows,rowCount:rows.length} as never; },
        `task:${first.json().id}`,f.t.env.sessionSecret,{person:{personId:"person-fixture-002",role:"member"},
          people:loadPeopleDirectory(f.t.env).searchPeople(undefined),now:new Date("2026-10-10T02:00:00Z")});
      expect(context.snapshot?.payload).toMatchObject({task:{id:first.json().id},mission:{title:"验证",battlefield_name:"增长战场"},monthOutcome:"本月目标"});
      expect((await call(f,f.ceo,"PATCH",`/api/me/tasks/${second.id}`,{version:1,status:"in_progress"})).statusCode).toBe(403);
    } finally { await f.t.close(); }
  });

  it("能挂的 Mission 和首页同一口径：没有任务卡的本人 Mission 能挂，占位、别人的、过去月份的不能挂",async()=>{
    const f=await executionFixture("open");
    try {
      const insert=(id:string,owner:string,period:string,placeholder:boolean)=>f.t.sql(`INSERT INTO missions(id,version,code,period,title,owner_id,
        capability_id,battlefield_ids,outcome,source_ref,source_document_id,source_revision,source_title,placeholder)
        VALUES($1,1,$1,$2,$3,$4,'method','["growth"]','目标','world:mission','world',1,'world',$5)`,[id,period,`本体 ${id}`,owner,placeholder]);
      await insert("imported",TEST_MEMBER.personId,"2026-10",false);
      await insert("held",TEST_MEMBER.personId,"2026-10",true);
      await insert("others",TEST_CEO.personId,"2026-10",false);
      await insert("september",TEST_MEMBER.personId,"2026-09",false);
      const created=await call(f,f.member,"POST","/api/me/tasks",newTask("imported",{planTaskId:"t1"}));
      expect(created.statusCode).toBe(200);
      expect(created.json()).toMatchObject({mission:{missionId:"imported",title:"本体 imported",cardId:null,battlefieldName:"增长战场"},planTaskId:"t1"});
      for (const missionId of ["held","others","september"])
        expect((await call(f,f.member,"POST","/api/me/tasks",newTask(missionId))).json().code).toBe("MISSION_NOT_AVAILABLE");
      // 任务卡还在讨论的 Mission 也能挂，和首页一样。
      const onOpenCard=await call(f,f.member,"PATCH",`/api/me/tasks/${created.json().id}`,{version:1,missionId:"execution-one"});
      expect(onOpenCard.json()).toMatchObject({mission:{missionId:"execution-one",cardId:f.card},planTaskId:null});
      const options=(await call(f,f.member,"GET",`/api/me/tasks/${created.json().id}`)).json().missionOptions;
      expect(options.map((m:{missionId:string})=>m.missionId)).toEqual(["execution-one","execution-two","imported"]);
    } finally { await f.t.close(); }
  });

  it("协作进展通知：别人写进展，推进人和其他协作者各一条（不含作者）；同一件事没看过的只留一条、顶到最前、文案取最新一条",async()=>{
    const f=await executionFixture();
    try {
      const task=(await call(f,f.member,"POST","/api/me/tasks",newTask(null,{title:"路线图"}))).json();
      await call(f,f.member,"POST",`/api/me/tasks/${task.id}/collaborators`,{personIds:["person-fixture-003"]});
      const progress=(cookie:string,body:string)=>call(f,cookie,"POST",`/api/me/tasks/${task.id}/progress`,{clientEventId:randomUUID(),body});
      const mine=async(cookie:string)=>((await call(f,cookie,"GET","/api/me/notifications")).json().notifications as {id:string;kind:string;text:string;objectId:string;readAt:string|null}[])
        .filter((n)=>n.kind==="task_progress_added");
      // 推进人写的：自己不收，协作者收。
      expect((await progress(f.member,"自己写的")).statusCode).toBe(200);
      expect(await mine(f.member)).toEqual([]);
      expect((await mine(f.third)).map((n)=>n.text)).toEqual([expect.stringMatching(/写了进展：自己写的$/)]);
      // 协作者写：推进人收到，作者本人不收。
      expect((await progress(f.third,"补了竞品\n第二行不进文案")).statusCode).toBe(200);
      const first=await mine(f.member);
      expect(first).toHaveLength(1);
      expect(first[0]).toMatchObject({objectId:task.id,readAt:null});
      expect(first[0].text).toMatch(/在「路线图」写了进展：补了竞品$/);
      // 协作者自己写的不顶掉他那条：文案仍是推进人写的那条。
      expect((await mine(f.third)).map((n)=>n.text)).toEqual([expect.stringMatching(/写了进展：自己写的$/)]);
      // 再写一条：还是一条，文案换成最新的；推进人再写一条，协作者收到。
      expect((await progress(f.third,"竞品表定稿")).statusCode).toBe(200);
      const second=await mine(f.member);
      expect(second).toHaveLength(1);
      expect(second[0].text).toMatch(/写了进展：竞品表定稿$/);
      expect((await progress(f.member,"和明华过了一遍")).statusCode).toBe(200);
      expect((await mine(f.third))[0].text).toMatch(/写了进展：和明华过了一遍$/);
      // 看过之后再有新进展，另起一条。
      expect((await call(f,f.member,"POST","/api/me/seen",{notificationIds:[second[0].id]})).statusCode).toBeLessThan(300);
      expect((await progress(f.third,"补了一张图")).statusCode).toBe(200);
      const third=await mine(f.member);
      expect(third.filter((n)=>n.readAt===null)).toHaveLength(1);
      expect(third).toHaveLength(2);
    } finally { await f.t.close(); }
  });

  it("挂 Task：新建带上、改成不挂、独立事项不能挂、换 Mission 时清掉",async()=>{
    const f=await executionFixture();
    try {
      const input=newTask("execution-one",{planTaskId:"t1"});
      const created=await call(f,f.member,"POST","/api/me/tasks",input);
      expect(created.statusCode).toBe(200);
      expect(created.json().planTaskId).toBe("t1");
      expect((await call(f,f.member,"POST","/api/me/tasks",input)).json().id).toBe(created.json().id);
      expect((await call(f,f.member,"POST","/api/me/tasks",{...input,planTaskId:"t2"})).json().code).toBe("CLIENT_ID_CONFLICT");
      const id=created.json().id;
      expect((await call(f,f.member,"GET",`/api/me/tasks/${id}`)).json().task.planTaskId).toBe("t1");
      const cleared=await call(f,f.member,"PATCH",`/api/me/tasks/${id}`,{version:1,planTaskId:null});
      expect(cleared.statusCode).toBe(200); expect(cleared.json().planTaskId).toBeNull();
      const relinked=await call(f,f.member,"PATCH",`/api/me/tasks/${id}`,{version:2,planTaskId:"t2"});
      expect(relinked.json().planTaskId).toBe("t2");
      // 换 Mission：同一请求没带 Task 就清掉，带了就用带的。
      const moved=await call(f,f.member,"PATCH",`/api/me/tasks/${id}`,{version:3,missionId:"execution-two"});
      expect(moved.json()).toMatchObject({mission:{missionId:"execution-two"},planTaskId:null});
      const movedBack=await call(f,f.member,"PATCH",`/api/me/tasks/${id}`,{version:4,missionId:"execution-one",planTaskId:"t1"});
      expect(movedBack.json()).toMatchObject({mission:{missionId:"execution-one"},planTaskId:"t1"});
      // 改别的字段不动 Task。
      expect((await call(f,f.member,"PATCH",`/api/me/tasks/${id}`,{version:5,title:"改个标题"})).json().planTaskId).toBe("t1");
      const independent=await call(f,f.member,"POST","/api/me/tasks",newTask(null,{planTaskId:"t1"}));
      expect(independent.statusCode).toBe(400); expect(independent.json()).toMatchObject({code:"INVALID_INPUT",message:"独立事项不能挂 Task"});
      const toIndependent=await call(f,f.member,"PATCH",`/api/me/tasks/${id}`,{version:6,missionId:null,planTaskId:"t1"});
      expect(toIndependent.statusCode).toBe(400); expect(toIndependent.json().code).toBe("INVALID_INPUT");
      const detached=await call(f,f.member,"PATCH",`/api/me/tasks/${id}`,{version:6,missionId:null});
      expect(detached.json()).toMatchObject({mission:null,planTaskId:null});
      const lone=(await call(f,f.member,"POST","/api/me/tasks",newTask(null))).json();
      expect((await call(f,f.member,"PATCH",`/api/me/tasks/${lone.id}`,{version:1,planTaskId:"t1"})).json().code).toBe("INVALID_INPUT");
    } finally { await f.t.close(); }
  });

  it("邀请同步群组、通知、私有批注与 task 对话权限；只有 CEO 身份的人不在邀请名单里",async()=>{
    const f=await executionFixture();
    try {
      const task=(await call(f,f.member,"POST","/api/me/tasks",newTask(null))).json();
      const id=task.id as string;
      expect((await call(f,f.third,"GET",`/api/me/tasks/${id}`)).statusCode).toBe(404);
      expect((await call(f,f.third,"GET",`/api/conversations/task:${id}/messages`)).statusCode).toBe(404);
      expect((await call(f,f.member,"GET",`/api/threads/task/${id}`)).json().unread).toBe(0);
      // 只有 CEO 身份的人不能使用 DRI 工作台，不在可邀请名单里。
      expect((await call(f,f.member,"GET",`/api/me/tasks/${id}`)).json().collaboratorOptions.map((person:{personId:string})=>person.personId)).toEqual(["person-fixture-003"]);
      expect((await call(f,f.member,"POST",`/api/me/tasks/${id}/collaborators`,{personIds:["person-fixture-001"]})).json().code).toBe("COLLABORATOR_NOT_AVAILABLE");
      const invited=await call(f,f.member,"POST",`/api/me/tasks/${id}/collaborators`,{personIds:["person-fixture-003"]});
      expect(invited.json().collaborators).toHaveLength(1);
      expect((await call(f,f.third,"GET",`/api/threads/task/${id}`)).json().members).toHaveLength(2);
      expect((await call(f,f.third,"GET","/api/me/notifications")).json().notifications[0].text).toContain("邀请你协作");
      expect((await call(f,f.third,"GET",`/api/me/tasks/${id}`)).json().role).toBe("collaborator");
      expect((await call(f,f.third,"PUT",`/api/me/tasks/${id}/note`,{note:"我的提醒"})).json().myNote).toBe("我的提醒");
      expect((await call(f,f.member,"GET",`/api/me/tasks/${id}`)).json().myNote).toBeNull();
      expect((await call(f,f.third,"GET",`/api/me/tasks/${id}`)).json()).toMatchObject({myNote:"我的提醒",myNoteAt:expect.any(String)});
      expect((await call(f,f.member,"PUT",`/api/me/tasks/${id}/note`,{note:"不应成功"})).statusCode).toBe(404);
      expect((await call(f,f.third,"GET",`/api/conversations/task:${id}/messages`)).statusCode).toBe(200);
      expect((await call(f,f.member,"GET",`/api/conversations/task:${id}/messages`)).statusCode).toBe(200);
      const outsider=randomUUID();
      expect((await call(f,f.third,"GET",`/api/conversations/task:${outsider}/messages`)).statusCode).toBe(404);
    } finally { await f.t.close(); }
  });

  it("未启动自建可删，会后来源不能删或以自建方式退回",async()=>{
    const f=await executionFixture();
    try {
      const one=(await call(f,f.member,"POST","/api/me/tasks",newTask())).json();
      const two=(await call(f,f.member,"POST","/api/me/tasks",newTask())).json();
      expect((await call(f,f.member,"POST",`/api/me/tasks/${two.id}/return`,{version:1,reason:"无关"})).json().code).toBe("TASK_NOT_RETURNABLE");
      expect((await call(f,f.member,"DELETE",`/api/me/tasks/${one.id}?version=2`)).json().code).toBe("VERSION_CONFLICT");
      expect((await call(f,f.member,"DELETE",`/api/me/tasks/${one.id}?version=1`)).statusCode).toBe(204);
      expect((await call(f,f.member,"GET",`/api/me/tasks/${two.id}`)).json().task.mission).toMatchObject({step:1,steps:1});
      expect((await call(f,f.member,"GET",`/api/threads/task/${one.id}`)).statusCode).toBe(404);
      await call(f,f.member,"PATCH",`/api/me/tasks/${two.id}`,{version:1,status:"in_progress"});
      expect((await call(f,f.member,"DELETE",`/api/me/tasks/${two.id}?version=2`)).json().code).toBe("TASK_NOT_DELETABLE");
    } finally { await f.t.close(); }
  });
});
