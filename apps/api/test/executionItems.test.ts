import { randomUUID } from "node:crypto";
import { describe,expect,it } from "vitest";
import { Value } from "@sinclair/typebox/value";
import { TaskView } from "@warmap/contracts";
import { call,executionFixture,newTask } from "./executionFixture.js";
import { getScopeObject } from "../src/conversations.js";
import { loadCompanyMemory } from "../src/companyMemory.js";

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
      const stale=await call(f,f.member,"PATCH",`/api/me/tasks/${first.json().id}`,{version:1,status:"done"});
      expect(stale.statusCode).toBe(409); expect(stale.json().latestTask.version).toBe(2);
      const context=await getScopeObject(async(sql,params)=>{ const rows=await f.t.sql(sql,params); return {rows,rowCount:rows.length} as never; },
        `task:${first.json().id}`,f.t.env.sessionSecret,{person:{personId:"person-fixture-002",role:"member"},
          people:loadCompanyMemory(f.t.env).searchPeople(undefined),now:new Date("2026-10-10T02:00:00Z")});
      expect(context.snapshot?.payload).toMatchObject({task:{id:first.json().id},mission:{title:"验证",battlefield_name:"增长战场"},monthOutcome:"本月目标"});
      expect((await call(f,f.ceo,"PATCH",`/api/me/tasks/${second.id}`,{version:1,status:"done"})).statusCode).toBe(404);
    } finally { await f.t.close(); }
  });

  it("邀请同步群组、通知、私有批注与 task 对话权限",async()=>{
    const f=await executionFixture();
    try {
      const task=(await call(f,f.member,"POST","/api/me/tasks",newTask(null))).json();
      const id=task.id as string;
      expect((await call(f,f.ceo,"GET",`/api/me/tasks/${id}`)).statusCode).toBe(404);
      expect((await call(f,f.ceo,"GET",`/api/conversations/task:${id}/messages`)).statusCode).toBe(404);
      expect((await call(f,f.member,"GET",`/api/threads/task/${id}`)).json().unread).toBe(0);
      const invited=await call(f,f.member,"POST",`/api/me/tasks/${id}/collaborators`,{personIds:["person-fixture-001"]});
      expect(invited.json().collaborators).toHaveLength(1);
      expect((await call(f,f.ceo,"GET",`/api/threads/task/${id}`)).json().members).toHaveLength(2);
      expect((await call(f,f.ceo,"GET","/api/me/notifications")).json().notifications[0].text).toContain("邀请你协作");
      expect((await call(f,f.ceo,"GET",`/api/me/tasks/${id}`)).json().role).toBe("collaborator");
      expect((await call(f,f.ceo,"PUT",`/api/me/tasks/${id}/note`,{note:"我的提醒"})).json().myNote).toBe("我的提醒");
      expect((await call(f,f.member,"GET",`/api/me/tasks/${id}`)).json().myNote).toBeNull();
      expect((await call(f,f.ceo,"GET",`/api/me/tasks/${id}`)).json()).toMatchObject({myNote:"我的提醒",myNoteAt:expect.any(String)});
      expect((await call(f,f.member,"PUT",`/api/me/tasks/${id}/note`,{note:"不应成功"})).statusCode).toBe(404);
      expect((await call(f,f.ceo,"GET",`/api/conversations/task:${id}/messages`)).statusCode).toBe(200);
      expect((await call(f,f.member,"GET",`/api/conversations/task:${id}/messages`)).statusCode).toBe(200);
      const outsider=randomUUID();
      expect((await call(f,f.ceo,"GET",`/api/conversations/task:${outsider}/messages`)).statusCode).toBe(404);
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
