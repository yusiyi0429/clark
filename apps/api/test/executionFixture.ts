import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { hashSecret } from "../src/session.js";
import { createTestApp, TEST_CEO, TEST_MEMBER, type TestApp } from "./helpers.js";

/** 三人名单：测试甲是 CEO，乙是卡的主人，丙是可以被邀请协作的同事。 */
const PEOPLE_SEED = fileURLToPath(new URL("./fixtures/company-people-candidate.json", import.meta.url));
const THIRD = { personId: "person-fixture-003", loginId: "ceshib", passcode: "3579" } as const;

export async function executionFixture(status:"confirmed"|"open"="confirmed",period="2026-10",runtime:Parameters<typeof createTestApp>[2]={},
  env:Parameters<typeof createTestApp>[0]={}) {
  let now=new Date("2026-10-10T02:00:00.000Z");
  const t=await createTestApp({companyPeopleSeed:PEOPLE_SEED,...env},undefined,{monthlyNow:()=>now,...runtime});
  const plan=randomUUID(),round=randomUUID(),card=randomUUID();
  await t.sql("UPDATE battlefield_config SET owner_id=$1,six_month_outcome='半年目标' WHERE id='growth'",[TEST_CEO.personId]);
  await t.sql(`INSERT INTO monthly_plans(id,version,period,status,company_outcome,battlefields,todos,negotiation,generation,confirmed_at)
    VALUES($1,1,$2,'confirmed','公司目标','[{"battlefieldId":"growth","outcome":"本月目标"}]','[]','{}','{}',$3)`,[plan,period,"2026-10-01T02:00:00Z"]);
  await t.sql(`INSERT INTO mission_rounds(id,version,battlefield_id,period,monthly_plan_id,status,draft_origin,draft_source,
    window_seq,first_opened_at,opened_at,closes_at,confirmed_by,confirmed_at,created_at,updated_at)
    VALUES($1,1,'growth',$2,$3,$4,'placeholder','{}',1,$5,$5,$6,$7,$8,$5,$9)`,
  [round,period,plan,status,"2026-10-01T02:00:00Z","2026-10-03T02:00:00Z",status==="confirmed"?TEST_CEO.personId:null,
    status==="confirmed"?"2026-10-04T02:00:00Z":null,"2026-10-04T02:00:00Z"]);
  await t.sql(`INSERT INTO personal_mission_cards(id,round_id,owner_id,sort_order,member_ids,created_at)
    VALUES($1,$2,$3,0,$4::jsonb,$5)`,[card,round,TEST_MEMBER.personId,JSON.stringify([TEST_MEMBER.personId,TEST_CEO.personId]),"2026-10-01T02:00:00Z"]);
  for (const [id,title,code] of [["execution-one","上线","execution-one"],["execution-two","验证","execution-two"]])
    await t.sql(`INSERT INTO missions(id,version,code,period,title,owner_id,capability_id,battlefield_ids,outcome,milestones,
      source_ref,source_document_id,source_revision,source_title,personal_mission_card_id)
      VALUES($1,1,$2,$3,$4,$5,'method','["growth"]','目标','["10/12 交付","2026-10-20 复盘","待定"]',
      'fixture://execution','fixture',1,'fixture',$6)`,[id,code,period,title,TEST_MEMBER.personId,card]);
  const member=await t.memberCookie(),ceo=await t.loginCookie();
  await t.sql("INSERT INTO member_access (person_id, login_id, passcode_hash, must_change) VALUES ($1, $2, $3, FALSE)",
    [THIRD.personId,THIRD.loginId,hashSecret(THIRD.passcode)]);
  const login=await t.app.inject({method:"POST",url:"/api/auth/login",headers:{origin:t.publicOrigin},payload:{loginId:THIRD.loginId,passcode:THIRD.passcode}});
  const third=(login.headers["set-cookie"] as string).split(";")[0];
  return {t,card,round,member,ceo,third,setNow:(value:Date)=>{now=value;}};
}
export type Fixture=Awaited<ReturnType<typeof executionFixture>>;
export function call(f:Fixture,cookie:string,method:"GET"|"POST"|"PATCH"|"PUT"|"DELETE",url:string,payload?:unknown) {
  return f.t.app.inject({method,url,headers:{cookie,origin:f.t.publicOrigin},...(payload===undefined?{}:{payload})});
}
export const newTask=(missionId:string|null="execution-one",extra:Record<string,unknown>={})=>
  ({clientId:randomUUID(),title:"第一步",missionId,startDate:"2026-10-10",dueDate:"2026-10-12",...extra});
