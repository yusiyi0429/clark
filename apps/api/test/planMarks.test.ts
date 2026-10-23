import { describe,expect,it } from "vitest";
import { call,executionFixture,type Fixture } from "./executionFixture.js";
import { TEST_MEMBER } from "./helpers.js";

const errorOf=(res:{ json:()=>{ code?:string } })=>res.json().code;
const add=(f:Fixture,cookie:string,body:Record<string,unknown>)=>call(f,cookie,"POST","/api/me/plan-marks",body);
const addOk=async(f:Fixture,body:Record<string,unknown>)=>{
  const res=await add(f,f.member,body);
  expect(res.statusCode).toBe(200);
  return res.json() as { id:string; missionId:string; date:string; label:string };
};
const stored=(f:Fixture)=>f.t.sql("SELECT mission_id,date::text AS date,label FROM plan_marks ORDER BY created_at,id");

describe("计划点",()=>{
  it("创建后能读到，改日期和名字，删除后没有",async()=>{
    const f=await executionFixture();
    try {
      const mark=await addOk(f,{missionId:"execution-one",date:"2026-10-28",label:" 联调 "});
      expect(mark).toEqual({id:expect.stringMatching(/^[0-9a-f-]{36}$/),missionId:"execution-one",date:"2026-10-28",label:"联调"});
      const moved=await call(f,f.member,"PATCH",`/api/me/plan-marks/${mark.id}`,{date:"2026-10-30"});
      expect(moved.statusCode).toBe(200);
      expect(moved.json()).toEqual({...mark,date:"2026-10-30"});
      const renamed=await call(f,f.member,"PATCH",`/api/me/plan-marks/${mark.id}`,{label:"上线",date:"2026-10-31"});
      expect(renamed.json()).toEqual({...mark,date:"2026-10-31",label:"上线"});
      expect((await call(f,f.member,"PATCH",`/api/me/plan-marks/${mark.id}`,{})).statusCode).toBe(400);
      expect(await stored(f)).toEqual([{mission_id:"execution-one",date:"2026-10-31",label:"上线"}]);
      const removed=await call(f,f.member,"DELETE",`/api/me/plan-marks/${mark.id}`);
      expect(removed.statusCode).toBe(204);
      expect(await stored(f)).toEqual([]);
      expect(errorOf(await call(f,f.member,"DELETE",`/api/me/plan-marks/${mark.id}`))).toBe("MARK_NOT_FOUND");
    } finally { await f.t.close(); }
  });

  it("首页计划的 marks 里读到刚建的点，按日期排",async()=>{
    const f=await executionFixture();
    try {
      f.setNow(new Date("2026-10-22T02:00:00.000Z"));
      const later=await addOk(f,{missionId:"execution-two",date:"2026-10-29",label:"后一天"});
      const earlier=await addOk(f,{missionId:"execution-one",date:"2026-10-23",label:"先一天"});
      const plan=(await call(f,f.member,"GET","/api/me/home-plan")).json();
      expect(plan.marks).toEqual([earlier,later]);
      const nobody=(await call(f,f.third,"GET","/api/me/home-plan")).json();
      expect(nobody.marks).toEqual([]);
    } finally { await f.t.close(); }
  });

  it("日期必须是 Mission 那个月里真实存在的一天",async()=>{
    const f=await executionFixture();
    try {
      for (const date of ["2026-09-30","2026-11-01","2026-10-32","2026-10-00"]) {
        const res=await add(f,f.member,{missionId:"execution-one",date,label:"出界"});
        expect([res.statusCode,errorOf(res)]).toEqual([400,"MARK_OUT_OF_PERIOD"]);
      }
      const mark=await addOk(f,{missionId:"execution-one",date:"2026-10-31",label:"月末"});
      const moved=await call(f,f.member,"PATCH",`/api/me/plan-marks/${mark.id}`,{date:"2026-11-01"});
      expect([moved.statusCode,errorOf(moved)]).toEqual([400,"MARK_OUT_OF_PERIOD"]);
      expect(await stored(f)).toEqual([{mission_id:"execution-one",date:"2026-10-31",label:"月末"}]);
    } finally { await f.t.close(); }
  });

  it("不是本人的 Mission、占位 Mission、不存在的 Mission 都是 404",async()=>{
    const f=await executionFixture();
    try {
      await f.t.sql(`INSERT INTO missions(id,version,code,period,title,owner_id,capability_id,battlefield_ids,outcome,milestones,
        source_ref,source_document_id,source_revision,source_title,placeholder)
        VALUES('placeholder-one',1,'a-placeholder','2026-10','占位',$1,'method','["growth"]','目标','[]','fixture://p','fixture',1,'fixture',true)`,
      [TEST_MEMBER.personId]);
      const date="2026-10-20";
      for (const [cookie,missionId] of [[f.third,"execution-one"],[f.member,"placeholder-one"],[f.member,"no-such-mission"]]) {
        const res=await add(f,cookie,{missionId,date,label:"不行"});
        expect([res.statusCode,errorOf(res)]).toEqual([404,"MISSION_NOT_FOUND"]);
      }
      expect((await add(f,f.ceo,{missionId:"execution-one",date,label:"不行"})).statusCode).toBe(403);
      expect(await stored(f)).toEqual([]);
    } finally { await f.t.close(); }
  });

  it("别人的点既不能改也不能删，也不知道它存在",async()=>{
    const f=await executionFixture();
    try {
      const mark=await addOk(f,{missionId:"execution-one",date:"2026-10-20",label:"我的"});
      for (const [method,payload] of [["PATCH",{label:"抢"}],["DELETE",undefined]] as const) {
        const res=await call(f,f.third,method,`/api/me/plan-marks/${mark.id}`,payload);
        expect([res.statusCode,errorOf(res)]).toEqual([404,"MARK_NOT_FOUND"]);
      }
      const missing=await call(f,f.member,"PATCH","/api/me/plan-marks/not-a-uuid",{label:"没有"});
      expect([missing.statusCode,errorOf(missing)]).toEqual([404,"MARK_NOT_FOUND"]);
      expect(await stored(f)).toEqual([{mission_id:"execution-one",date:"2026-10-20",label:"我的"}]);
    } finally { await f.t.close(); }
  });

  it("名字最多 10 个字、不能全是空白",async()=>{
    const f=await executionFixture();
    try {
      const base={missionId:"execution-one",date:"2026-10-20"};
      expect((await add(f,f.member,{...base,label:"一二三四五六七八九十"})).statusCode).toBe(200);
      expect((await add(f,f.member,{...base,label:"一二三四五六七八九十一"})).statusCode).toBe(400);
      const blank=await add(f,f.member,{...base,label:"   "});
      expect([blank.statusCode,errorOf(blank)]).toEqual([400,"INVALID_INPUT"]);
      const mark=await addOk(f,{...base,label:"正常"});
      const blankPatch=await call(f,f.member,"PATCH",`/api/me/plan-marks/${mark.id}`,{label:" "});
      expect([blankPatch.statusCode,errorOf(blankPatch)]).toEqual([400,"INVALID_INPUT"]);
    } finally { await f.t.close(); }
  });

  it("一个 Mission 下最多 20 个点，别的 Mission 不受影响",async()=>{
    const f=await executionFixture();
    try {
      await f.t.sql(`INSERT INTO plan_marks(owner_id,mission_id,date,label)
        SELECT $1,'execution-one','2026-10-20','点'||n FROM generate_series(1,19) n`,[TEST_MEMBER.personId]);
      const twentieth=await addOk(f,{missionId:"execution-one",date:"2026-10-21",label:"第二十个"});
      const over=await add(f,f.member,{missionId:"execution-one",date:"2026-10-21",label:"第二十一"});
      expect([over.statusCode,errorOf(over)]).toEqual([409,"MARK_LIMIT"]);
      expect((await add(f,f.member,{missionId:"execution-two",date:"2026-10-21",label:"另一个"})).statusCode).toBe(200);
      await call(f,f.member,"DELETE",`/api/me/plan-marks/${twentieth.id}`);
      expect((await add(f,f.member,{missionId:"execution-one",date:"2026-10-21",label:"删后再加"})).statusCode).toBe(200);
    } finally { await f.t.close(); }
  });
});
