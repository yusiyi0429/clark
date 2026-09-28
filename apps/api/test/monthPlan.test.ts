import { randomUUID } from "node:crypto";
import { describe,expect,it } from "vitest";
import { call,executionFixture,newTask } from "./executionFixture.js";
import { TEST_MEMBER } from "./helpers.js";

describe("本月计划",()=>{
  it("按任务卡分组、解析开头里程碑日期并区分三种只读原因",async()=>{
    const f=await executionFixture();
    try {
      const plan=(await call(f,f.member,"GET","/api/me/plan?period=2026-10")).json();
      expect(plan).toMatchObject({period:"2026-10",firstDay:"2026-10-01",lastDay:"2026-10-31",editable:true,closedReason:null});
      expect(plan.groups.map((group:{missionId:string|null})=>group.missionId)).toEqual(["execution-one","execution-two",null]);
      expect(plan.groups[0].milestones).toEqual([
        {date:"2026-10-12",text:"10/12 交付"},{date:"2026-10-20",text:"2026-10-20 复盘"},{date:null,text:"待定"},
      ]);
      const independent=(await call(f,f.member,"POST","/api/me/tasks",newTask(null))).json();
      expect((await call(f,f.member,"GET","/api/me/plan?period=2026-10")).json().groups[2].items[0].id).toBe(independent.id);
      expect((await call(f,f.member,"GET","/api/me/plan?period=2026-11")).json().closedReason).toBe("这个月还没有你的任务卡");
      f.setNow(new Date("2026-11-01T02:00:00Z"));
      expect((await call(f,f.member,"GET","/api/me/plan?period=2026-10")).json().closedReason).toBe("月份已过，计划只读");
      expect((await call(f,f.member,"PUT","/api/me/plan",{period:"2026-10",groups:[]})).json().code).toBe("PLAN_NOT_EDITABLE");
    } finally { await f.t.close(); }
    const open=await executionFixture("open");
    try { expect((await call(open,open.member,"GET","/api/me/plan?period=2026-10")).json().closedReason).toBe("任务卡确定之后才能拆成执行事项"); }
    finally { await open.t.close(); }
  });

  it("同月另一个战场的卡还在讨论时，已确定的卡照常能拆，讨论中的卡不进计划",async()=>{
    const f=await executionFixture();
    try {
      const round=randomUUID(),card=randomUUID();
      await f.t.sql("INSERT INTO battlefield_config (id,version,code,name,six_month_outcome) VALUES ('product',1,'03','产品战场','产品半年目标')");
      await f.t.sql(`INSERT INTO mission_rounds(id,version,battlefield_id,period,monthly_plan_id,status,draft_origin,draft_source,window_seq,
        first_opened_at,opened_at,closes_at,created_at,updated_at)
        SELECT $1,1,'product','2026-10',monthly_plan_id,'open','placeholder','{}',1,$2,$2,$3,$2,$2 FROM mission_rounds WHERE id=$4`,
      [round,"2026-10-09T02:00:00Z","2026-10-11T02:00:00Z",f.round]);
      await f.t.sql(`INSERT INTO personal_mission_cards(id,round_id,owner_id,sort_order,member_ids,created_at)
        VALUES($1,$2,$3,1,'[]'::jsonb,$4)`,[card,round,TEST_MEMBER.personId,"2026-10-09T02:00:00Z"]);
      await f.t.sql(`INSERT INTO missions(id,version,code,period,title,owner_id,capability_id,battlefield_ids,outcome,milestones,
        source_ref,source_document_id,source_revision,source_title,personal_mission_card_id)
        SELECT 'product-one',1,'product-one','2026-10','讨论中',owner_id,'method','["product"]','目标','[]','fixture://p','fixture',1,'fixture',$1
        FROM personal_mission_cards WHERE id=$1`,[card]);
      const plan=(await call(f,f.member,"GET","/api/me/plan?period=2026-10")).json();
      expect(plan).toMatchObject({editable:true,closedReason:null});
      expect(plan.groups.map((group:{missionId:string|null})=>group.missionId)).toEqual(["execution-one","execution-two",null]);
      const blocked=await call(f,f.member,"PUT","/api/me/plan",{period:"2026-10",groups:[{missionId:"product-one",items:[{clientId:randomUUID(),title:"不该建"}]}]});
      expect(blocked.json().code).toBe("PLAN_GROUP_INVALID");
    } finally { await f.t.close(); }
  });

  it("只保存传来的组，允许无日期步骤，并保留其他组与后来新增的事项",async()=>{
    const f=await executionFixture();
    try {
      const other=(await call(f,f.member,"POST","/api/me/tasks",newTask("execution-two",{startDate:undefined,dueDate:undefined}))).json();
      const a=randomUUID();
      const payload={period:"2026-10",groups:[{missionId:"execution-one",items:[{clientId:a,title:"先调查"}]}]};
      const saved=await call(f,f.member,"PUT","/api/me/plan",payload);
      expect(saved.statusCode).toBe(200);
      expect(saved.json().groups[0].items[0]).toMatchObject({title:"先调查",startDate:null,dueDate:null,source:"plan"});
      expect(saved.json().groups[0].items[0].version).toBe(1);
      expect(saved.json().groups[1].items[0].id).toBe(other.id);
      const replay=await call(f,f.member,"PUT","/api/me/plan",payload);
      expect(replay.statusCode).toBe(200);
      expect(replay.json().groups[0].items).toHaveLength(1);
      const later=(await call(f,f.member,"POST","/api/me/tasks",newTask("execution-one",{title:"后来添加"}))).json();
      const result=await call(f,f.member,"PUT","/api/me/plan",payload);
      expect(result.statusCode).toBe(200);
      expect(result.json().groups[0].items.map((item:{id:string})=>item.id)).toEqual([saved.json().groups[0].items[0].id,later.id]);
      expect(result.json().groups[1].items[0].id).toBe(other.id);
    } finally { await f.t.close(); }
  });

  it("字段增量更新不覆盖别处改的标题；重排、日期清空和版本按实际变化",async()=>{
    const f=await executionFixture();
    try {
      const first=(await call(f,f.member,"POST","/api/me/tasks",newTask("execution-one"))).json();
      const second=(await call(f,f.member,"POST","/api/me/tasks",newTask("execution-one",{title:"第二步"}))).json();
      await f.t.sql("UPDATE tasks SET title='别处改的标题',version=version+1 WHERE id=$1",[first.id]);
      const body={period:"2026-10",groups:[{missionId:"execution-one",items:[
        {taskId:second.id},{taskId:first.id,dueDate:null,startDate:"2026-11-02"},
      ]}]};
      const changed=await call(f,f.member,"PUT","/api/me/plan",body);
      expect(changed.statusCode).toBe(200);
      expect(changed.json().groups[0].items.map((item:{title:string})=>item.title)).toEqual(["第二步","别处改的标题"]);
      expect(changed.json().groups[0].items[1]).toMatchObject({startDate:"2026-11-02",dueDate:null});
      expect(changed.json().groups[0].items.map((item:{version:number})=>item.version)).toEqual([2,3]);
      const same=await call(f,f.member,"PUT","/api/me/plan",body);
      expect(same.statusCode).toBe(200);
      expect(same.json().groups[0].items.map((item:{version:number})=>item.version)).toEqual(changed.json().groups[0].items.map((item:{version:number})=>item.version));
    } finally { await f.t.close(); }
  });

  it("无效日期与逆序日期拒绝，列出的事项被移走才报 PLAN_STALE",async()=>{
    const f=await executionFixture();
    try {
      const task=(await call(f,f.member,"POST","/api/me/tasks",newTask("execution-one"))).json();
      for (const dates of [{startDate:"2026-02-30"},{startDate:"2026-10-13",dueDate:"2026-10-12"}]) {
        const invalid=await call(f,f.member,"PUT","/api/me/plan",{period:"2026-10",groups:[{missionId:"execution-one",items:[{taskId:task.id,...dates}]}]});
        expect(invalid.statusCode).toBe(400);
      }
      await f.t.sql("UPDATE tasks SET mission_id='execution-two',step_order=1 WHERE id=$1",[task.id]);
      const stale=await call(f,f.member,"PUT","/api/me/plan",{period:"2026-10",groups:[{missionId:"execution-one",items:[{taskId:task.id}]}]});
      expect(stale.statusCode).toBe(409);
      expect(stale.json().code).toBe("PLAN_STALE");
    } finally { await f.t.close(); }
  });
});
