import { describe,expect,it } from "vitest";
import { loadWorldMissions,type WorldMissionReader } from "../src/worldMissionLoad.js";
import { call,executionFixture,type Fixture } from "./executionFixture.js";
import { TEST_CEO,TEST_MEMBER } from "./helpers.js";

const SCOPE="scope-tk",AGENTS="domain-agents",EO="domain-eo",LIGHTHOUSE="domain-lighthouse";
const MEMBER_P="principal-member",CEO_P="principal-ceo",THIRD_P="principal-third",THIRD="person-fixture-003";
const OCT_25=new Date("2026-10-25T04:40:00.000Z");

type Comp={type:string;text:string};
/** 本体里的一条 Mission：列表头 + 取对象（负责人在 identity，块在 business.blocks）。 */
function mission(id:string,title:string,options:{domain:string;owner:string|null;version?:number;ref?:string;status?:[string,string];
  definition?:Comp[];plan?:Comp[];tasks?:Comp[];goal?:string}) {
  const head={object_id:id,object_type:"Mission",title,version:options.version??1,revision_id:`rev-${id}`,object_version:options.version??1,domain_id:options.domain,
    external_refs:options.ref?[{system:"tianshu",id:`mission:${options.ref}`}]:[],lifecycle:{status:options.status?.[0]??"draft",display_name:options.status?.[1]??"草稿"},
    contract_version:"tkos.world/0.3"};
  const block=(blockId:string,items:Comp[]|undefined)=>({id:blockId,value:items?.length?{components:items.map((item,index)=>({id:`${blockId}-${index}`,...item}))}:null});
  const object={business:{...head,attributes:{responsible:options.owner??undefined},
    relations:options.goal?[{field:"goal_ref",relation:"serves",value:{object_id:options.goal}}]:[],
    blocks:[block("definition",options.definition),block("mission_plan",options.plan),block("execution_plan",options.tasks)]},
    identity:{responsible:{principals:options.owner?[{principal_id:options.owner}]:[]}},records:{lifecycle:head.lifecycle},protocol:{contract_version:head.contract_version}};
  return {head,object};
}
function world(missions:ReturnType<typeof mission>[]):WorldMissionReader {
  const byId=new Map(missions.map((item)=>[item.head.object_id,item.object]));
  return {
    config:{scope_id:SCOPE,domains:{company:"c",eo:EO},people:{[TEST_MEMBER.personId]:MEMBER_P,[TEST_CEO.personId]:CEO_P,[THIRD]:THIRD_P},capabilities:{[AGENTS]:"04",[EO]:"05"}},
    listObjects:async(filters:Record<string,unknown>)=>filters.type==="Mission"&&filters.period==="2026-10"?missions.map((item)=>item.head):[],
    getObject:async(id:string)=>byId.get(id),
  } as unknown as WorldMissionReader;
}
const full=mission("obj-m1","CEO / DRI Agent 从能用到在用",{domain:AGENTS,owner:MEMBER_P,version:5,ref:"sun-202610-1",goal:"po-agents",
  definition:[{type:"outcome",text:"会议写进本体，对话问得到"},{type:"acceptance_criterion",text:"多人真实会写入并读回"},{type:"acceptance_criterion",text:"新 Chat 打分一次"},
    {type:"time_boundary",text:"2026-10-31"},{type:"scope_boundary",text:"不含回答质量"},{type:"contribution",text:"让 Agent 真正被用起来"}],
  plan:[{type:"core_path",text:"先做会议回流"},{type:"milestone",text:"10/28 天枢 V1 上线"},{type:"key_trade_off",text:"先内部版"}],
  tasks:[{type:"plan_item",text:"T-A 会议内容写进本体"}]});
const thin=mission("obj-eo","Ontology & Data Grounding",{domain:EO,owner:CEO_P,definition:[{type:"outcome",text:"跑通真实数据读取"}]});
const noOwner=mission("obj-x","没人负责的",{domain:AGENTS,owner:null});
const stranger=mission("obj-y","负责人不在天枢",{domain:AGENTS,owner:"principal-unknown"});
const lighthouse=mission("obj-z","灯塔域的",{domain:LIGHTHOUSE,owner:MEMBER_P});

const setup=async(f:Fixture)=>{
  await f.t.sql("INSERT INTO capability_config (id,version,code,name,six_month_outcome) VALUES ('agents',1,'04','智能体',''),('e-o',1,'05','企业本体与数据','')");
};
const rows=async(f:Fixture)=>await f.t.sql(`SELECT code,title,owner_id,capability_id,version,outcome,success_evidence,milestones,time_boundary,boundaries,why,key_path,tradeoffs,
  source_revision,world_object_id,world_status,world_status_label,world_gaps FROM missions WHERE world_object_id IS NOT NULL ORDER BY code`);

describe("从本体只读载入 Mission",()=>{
  it("首次载入：按 id 对负责人和能力域，写本体状态、版本、缺项；对不上的不载入、列进报告；--dry-run 不写",async()=>{
    const f=await executionFixture();
    try {
      await setup(f);
      const q=f.t.pool.query.bind(f.t.pool);
      const dry=await loadWorldMissions(q,world([full,thin,noOwner,stranger,lighthouse]),{period:"2026-10",dryRun:true,now:()=>OCT_25});
      expect(dry.loaded.map((item)=>item.action)).toEqual(["insert","insert"]);
      expect(await rows(f)).toEqual([]);

      const report=await loadWorldMissions(q,world([full,thin,noOwner,stranger,lighthouse]),{period:"2026-10",now:()=>OCT_25});
      expect(report).toMatchObject({scopeId:SCOPE,period:"2026-10",readAt:"2026-10-25T04:40:00.000Z",missing:[]});
      expect(report.loaded).toEqual([
        {code:"sun-202610-1",title:"CEO / DRI Agent 从能用到在用",ownerId:TEST_MEMBER.personId,status:"草稿",version:5,gaps:[],action:"insert"},
        {code:"w-obj-eo",title:"Ontology & Data Grounding",ownerId:TEST_CEO.personId,status:"草稿",version:1,gaps:["成功标准","时间边界","Mission 计划","Task 全景"],action:"insert"},
      ]);
      expect(report.skipped).toEqual([
        {objectId:"obj-x",title:"没人负责的",reason:"待指派"},
        {objectId:"obj-y",title:"负责人不在天枢",reason:"负责人对不上"},
        {objectId:"obj-z",title:"灯塔域的",reason:"能力域对不上"},
      ]);
      // 服务的周期目标（goal_ref）记下来，约会议挑挂点时按它列 PO 下的 Mission；没有的为 null。
      expect(await f.t.sql("SELECT code,world_goal_id FROM missions WHERE world_object_id IS NOT NULL ORDER BY code"))
        .toEqual([{code:"sun-202610-1",world_goal_id:"po-agents"},{code:"w-obj-eo",world_goal_id:null}]);
      const [m1,eo]=await rows(f);
      expect(m1).toMatchObject({owner_id:TEST_MEMBER.personId,capability_id:"agents",version:1,outcome:"会议写进本体，对话问得到",
        success_evidence:["多人真实会写入并读回","新 Chat 打分一次"],milestones:["10/28 天枢 V1 上线"],time_boundary:"2026-10-31",boundaries:"不含回答质量",
        why:"让 Agent 真正被用起来",key_path:"先做会议回流",tradeoffs:"先内部版",source_revision:5,world_object_id:"obj-m1",world_status:"draft",world_status_label:"草稿",world_gaps:[]});
      expect(eo).toMatchObject({capability_id:"e-o",world_gaps:["成功标准","时间边界","Mission 计划","Task 全景"]});
    } finally { await f.t.close(); }
  });

  it("重跑：没变不加版本；本体改了按新版本覆盖、版本加一；手工建过的同一对象认领不重复；本体里没了的列出来不删",async()=>{
    const f=await executionFixture();
    try {
      await setup(f);
      const q=f.t.pool.query.bind(f.t.pool);
      // 10/22 预发上手工写的那种行：来源记了本体对象 id，没有 world_* 列。
      await f.t.sql(`INSERT INTO missions(id,version,code,period,title,owner_id,capability_id,outcome,source_ref,source_document_id,source_revision,source_title)
        VALUES('manual-eo',1,'renhao-202610-b','2026-10','旧标题',$1,'e-o','旧','world:mission:renhao-202610-b','obj-eo',3,'旧标题')`,[TEST_CEO.personId]);
      await loadWorldMissions(q,world([full,thin]),{period:"2026-10",now:()=>OCT_25});
      expect((await rows(f)).map((row)=>[row.code,row.title,row.version])).toEqual([["renhao-202610-b","Ontology & Data Grounding",2],["sun-202610-1","CEO / DRI Agent 从能用到在用",1]]);

      const again=await loadWorldMissions(q,world([full,thin]),{period:"2026-10",now:()=>OCT_25});
      expect(again.loaded.map((item)=>[item.code,item.action])).toEqual([["sun-202610-1","same"],["renhao-202610-b","same"]]);
      const revised=mission("obj-m1","CEO / DRI Agent 从能用到在用",{domain:AGENTS,owner:MEMBER_P,version:6,ref:"sun-202610-1",status:["committed","已承诺"],
        definition:[{type:"outcome",text:"改过的成果"}]});
      const after=await loadWorldMissions(q,world([revised]),{period:"2026-10",now:()=>OCT_25});
      expect(after.loaded.map((item)=>[item.code,item.action,item.status])).toEqual([["sun-202610-1","update","已承诺"]]);
      expect(after.missing).toEqual([{code:"renhao-202610-b",title:"Ontology & Data Grounding"}]);
      expect((await rows(f)).map((row)=>[row.code,row.version,row.outcome,row.world_status])).toEqual([
        ["renhao-202610-b",2,"跑通真实数据读取","draft"],["sun-202610-1",2,"改过的成果","committed"]]);
    } finally { await f.t.close(); }
  });

  it("首页：本体载入的 Mission 带状态、版本、读取时间和缺项；本月载入过时，本人没有本月 Mission 不再退回上个月",async()=>{
    const f=await executionFixture("confirmed","2026-09");
    try {
      await setup(f);
      f.setNow(new Date("2026-10-22T02:00:00.000Z"));
      const before=(await call(f,f.member,"GET","/api/me/home-plan")).json();
      expect(before).toMatchObject({period:"2026-09",fallbackFrom:"2026-09"});
      const third=mission("obj-third","第三人的",{domain:EO,owner:THIRD_P,definition:[{type:"outcome",text:"跑通真实数据读取"}]});
      await loadWorldMissions(f.t.pool.query.bind(f.t.pool),world([third]),{period:"2026-10",now:()=>OCT_25});
      const member=(await call(f,f.member,"GET","/api/me/home-plan")).json();
      expect(member).toMatchObject({period:"2026-10",fallbackFrom:null,missions:[]});
      const other=(await call(f,f.third,"GET","/api/me/home-plan")).json();
      expect(other.missions).toEqual([{missionId:expect.any(String),code:"w-obj-thir",title:"第三人的",cardId:null,color:"#2f63b0",
        world:{status:"draft",label:"草稿",version:1,readAt:"2026-10-25T04:40:00.000Z",gaps:["成功标准","时间边界","Mission 计划","Task 全景"]}}]);
    } finally { await f.t.close(); }
  });
});
