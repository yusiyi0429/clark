/** 仅供时间机器使用的杜撰员工；所有行都写进 createTestApp 的一次性测试库。 */
import { randomUUID } from "node:crypto";
import type { TestApp } from "../../apps/api/test/helpers.js";
import { setMemberAccess } from "../../apps/api/src/memberAccess.js";
import { directionId } from "../../apps/api/src/radarSettings.js";

export const LUYAO = { personId: "wang-luyao", loginId: "wangluyao" } as const;

/** 切换本月目标状态前移走这套演示事实，保证 growth 的阶段命令仍可从头演练。 */
export async function clearWangLuyao(app: TestApp, taskIds: Record<string,string>) {
  const sql = app.sql;
  const ids = [
    ...(await sql("SELECT id::text FROM tasks WHERE owner_id=$1",[LUYAO.personId])).map((row)=>row.id as string),
    taskIds.invited,
  ];
  await sql("DELETE FROM notifications WHERE person_id=$1 OR (object_type='task' AND object_id=ANY($2::text[]))",[LUYAO.personId,ids]);
  for (const table of ["thread_reads","thread_messages","thread_members"])
    await sql(`DELETE FROM ${table} WHERE object_type='task' AND object_id=ANY($1::text[])`,[ids]);
  await sql("DELETE FROM tasks WHERE id::text=ANY($1::text[])",[ids]);
  await sql("DELETE FROM meetings WHERE title='团队协作交接对齐会' AND lead_dri_id='sun-mingze'");
  await sql(`DELETE FROM mission_review_decisions WHERE review_id IN
    (SELECT id FROM mission_round_reviews WHERE round_id IN
      (SELECT id FROM mission_rounds WHERE battlefield_id='supporting' AND period='2026-10'))`);
  await sql("DELETE FROM mission_round_reviews WHERE round_id IN (SELECT id FROM mission_rounds WHERE battlefield_id='supporting' AND period='2026-10')");
  await sql("DELETE FROM mission_card_corrections WHERE card_id IN (SELECT id FROM personal_mission_cards WHERE owner_id=$1)",[LUYAO.personId]);
  await sql("DELETE FROM mission_card_feedback WHERE card_id IN (SELECT id FROM personal_mission_cards WHERE owner_id=$1)",[LUYAO.personId]);
  await sql("DELETE FROM mission_card_reads WHERE card_id IN (SELECT id FROM personal_mission_cards WHERE owner_id=$1)",[LUYAO.personId]);
  await sql("DELETE FROM missions WHERE source_document_id='demo-luyao'");
  await sql("DELETE FROM personal_mission_cards WHERE owner_id=$1",[LUYAO.personId]);
  await sql("DELETE FROM mission_rounds WHERE battlefield_id='supporting' AND period='2026-10'");
  await sql("DELETE FROM person_radar_signals WHERE person_id=$1",[LUYAO.personId]);
  await sql("DELETE FROM person_radar WHERE person_id=$1",[LUYAO.personId]);
}

export async function seedWangLuyao(app: TestApp, planId: string, now: Date, passcode: string, ceoId: string) {
  const sql = app.sql;
  if (!(await sql("SELECT 1 FROM member_access WHERE person_id=$1",[LUYAO.personId])).length)
    await setMemberAccess(async (query, params) => ({ rows: await sql(query, params), rowCount: 1, command: "", oid: 0, fields: [] }),
      { ...LUYAO, passcode, mustChange: false });
  // 故意不写 person_onboarding：这个账号第一次登录从引导第一页开始。
  const roundId = randomUUID(), cardId = randomUUID();
  const at = "2026-10-01T02:00:00.000Z";
  const [{ six_month_outcome }] = await sql("SELECT six_month_outcome FROM battlefield_config WHERE id='supporting'");
  const [{ battlefields }] = await sql("SELECT battlefields FROM monthly_plans WHERE id=$1",[planId]);
  const monthOutcome = (battlefields as { battlefieldId: string; outcome: string }[]).find((item) => item.battlefieldId === "supporting")?.outcome;
  await sql(`INSERT INTO mission_rounds (id,version,battlefield_id,period,monthly_plan_id,status,draft_origin,draft_source,
    goal_snapshot,window_seq,first_opened_at,opened_at,closes_at,confirmed_by,confirmed_at,created_at,updated_at)
    VALUES ($1,1,'supporting','2026-10',$2,'confirmed','placeholder','{}',$3::jsonb,1,$4,$4,$5,$6,$7,$4,$7)`,
  [roundId,planId,JSON.stringify({sixMonthOutcome:six_month_outcome,monthOutcome,signedAt:at}),at,
    "2026-10-03T02:00:00.000Z",ceoId,"2026-10-04T02:00:00.000Z"]);
  await sql(`INSERT INTO personal_mission_cards (id,round_id,owner_id,sort_order,role_label,member_ids,created_at)
    VALUES ($1,$2,$3,0,'协作交付与验收', $4::jsonb,$5)`,
  [cardId,roundId,LUYAO.personId,JSON.stringify([LUYAO.personId,ceoId,"sun-mingze"]),at]);
  const missions = [
    {
      id: "demo-luyao-handoff", code: "DEMO-LY-01", title: "让跨人员交接有可核对的完成标准",
      outcome: "在团队协作战场落地一套由交接双方都能复述、能照做的交接清单，先覆盖灯塔项目的三种真实移交场景。",
      why: "当前交接常停在口头确认，接手人找不到判断依据，问题在月底才暴露。",
      success: ["三种交接场景都有责任人、接手人和完成证据", "两名接手人按清单独立完成复核并留下记录"],
      boundaries: "本月只改交接约定和验证方式，不承诺改造正式审批流程。",
      keyPath: "先访谈交接双方，抽出共性字段；用两次真实交接演练清单；按遗漏项修订并发布。",
      milestones: ["10/12 完成三种场景与交接清单初稿", "2026-10-20 完成双方演练与遗漏复盘", "10/28 发布验收版和使用说明"],
      resources: "孙铭泽提供灯塔项目验收记录；林知行安排两次交接演练。",
      dependencies: "依赖灯塔项目确认本月交付范围和两名接手人的可用时间。",
      humanAgent: "王路遥访谈、裁定完成标准；Co-Agent 汇总记录、比对遗漏和生成草稿，发布前由人核对。",
      risk: "若接手人只签字未实操，清单看似完整但无法复用；每次演练必须附可打开的证据链接。",
      retrospect: "月底按遗漏项、回问次数和接手耗时复盘，决定 11 月是否扩到其他战场。",
    },
    {
      id: "demo-luyao-evidence", code: "DEMO-LY-02", title: "建立协作事项的证据归档与回看节奏",
      outcome: "把团队协作战场的决定、执行和结果连起来，月底能从一条事项追溯到原始讨论和验收证据。",
      why: "讨论、执行事项和结论分散在不同页面，月末复盘只能靠当事人回忆。",
      success: ["至少五条协作事项留有来源原话、负责人和结果链接", "抽查两条事项，非当事人能在五分钟内还原决定依据"],
      boundaries: "只整理本月演示范围的协作事项，不迁移历史文档，也不代替负责人作业务判断。",
      keyPath: "定义证据命名与链接规则，试归档五条事项，组织非当事人回看，修订模板。",
      milestones: ["10/15 完成证据模板和示例", "2026-10-24 完成五条事项抽查", "10/30 提交月末回看结论"],
      resources: "使用本月事项群组消息、会议原话和灯塔项目验收记录。",
      dependencies: "依赖事项推进人在完成时补上结果链接；缺失项由王路遥逐条追问。",
      humanAgent: "王路遥核对语义和证据真实性；Co-Agent 整理索引、提示缺失字段。",
      risk: "来源原话可能包含未经确认的结论；归档时保留上下文并注明待核对状态。",
      retrospect: "月底记录可追溯率和回看耗时，为下月模板简化提供依据。",
    },
  ];
  for (const m of missions) await sql(`INSERT INTO missions (id,version,code,period,title,owner_id,capability_id,battlefield_ids,
    outcome,why,success_evidence,boundaries,key_path,milestones,resources,dependencies,human_agent_split,risk,retrospect,
    source_ref,source_document_id,source_revision,source_title,personal_mission_card_id)
    VALUES ($1,1,$2,'2026-10',$3,$4,'cap-03','["supporting"]',$5,$6,$7::jsonb,$8,$9,$10::jsonb,$11,$12,$13,$14,$15,
    'fixture://demo-luyao','demo-luyao',1,'王路遥演示个人卡',$16)`,
  [m.id,m.code,m.title,LUYAO.personId,m.outcome,m.why,JSON.stringify(m.success),m.boundaries,m.keyPath,
    JSON.stringify(m.milestones),m.resources,m.dependencies,m.humanAgent,m.risk,m.retrospect,cardId]);
  await sql(`INSERT INTO missions (id,version,code,period,title,owner_id,capability_id,battlefield_ids,outcome,
    source_ref,source_document_id,source_revision,source_title)
    VALUES ('demo-luyao-growth',1,'DEMO-LY-03','2026-10','参与灯塔项目的交接验收',$1,'cap-03','["growth"]',
      '把灯塔项目交付物交给另一位同事独立核验','fixture://demo-luyao','demo-luyao',1,'演示参与登记')`,[LUYAO.personId]);

  const ids: Record<string,string> = {};
  const addTask = async (key: string, title: string, status: string, source: string, missionId: string | null,
    step: number | null, start: string | null, due: string | null, owner = LUYAO.personId, extra: Record<string,unknown> = {}) => {
    const id = randomUUID(); ids[key] = id;
    await sql(`INSERT INTO tasks (id,title,status,owner_id,created_by,mission_id,step_order,start_date,due_date,
      done_definition,judgment,judgment_at,origin_meeting_id,origin_item_id,source_quote)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
    [id,title,status,owner,source,missionId,step,start,due,extra.done ?? null,extra.judgment ?? null,
      extra.judgmentAt ?? null,extra.meetingId ?? null,extra.itemId ?? null,extra.quote ?? null]);
    await sql("INSERT INTO task_members (task_id,person_id,role,added_by) VALUES ($1,$2,'owner',$3)", [id,owner,source]);
    await sql("INSERT INTO thread_members (object_type,object_id,person_id,added_by) VALUES ('task',$1,$2,$3)", [id,owner,source]);
    await sql("INSERT INTO thread_messages (object_type,object_id,kind,content) VALUES ('task',$1,'co-agent',$2)",
      [id,`这个群讨论${owner === LUYAO.personId ? "王路遥" : "孙铭泽"}推进的执行事项「${title}」，截止 ${due ?? "待定"}。`]);
    return id;
  };
  await addTask("a1","访谈交接双方并写出三种场景", "in_progress","plan",missions[0].id,1,"2026-10-05","2026-10-12",LUYAO.personId,
    {done:"三种场景各有交接人、接手人、交付物、确认方式；孙铭泽核对原话并在群内确认。",
      judgment:"先固定接手人实际会问的三个问题，再决定清单字段；避免把模板做成形式检查。",judgmentAt:"2026-10-06T03:20:00Z"});
  await addTask("a2","和接手人演练交接清单", "not_started","plan",missions[0].id,2,"2026-10-13","2026-10-20");
  await addTask("a3","发布清单并复盘遗漏项", "not_started","plan",missions[0].id,3,"2026-10-21","2026-10-28");
  await addTask("b1","整理五条协作事项的证据索引", "not_started","plan",missions[1].id,1,"2026-10-10","2026-10-15");
  await addTask("b2","邀请非当事人回看归档结果", "not_started","plan",missions[1].id,2,null,null);
  await addTask("self","约两位接手人确认演练时间", "not_started","self",null,null,null,"2026-10-09");
  const meetingId = randomUUID();
  await sql(`INSERT INTO meetings (id,version,title,status,scheduled_at,ends_at,lead_dri_id,ceo_participant_id,participants,
    issue_ids,preflight,draft,origin_ref) VALUES ($1,1,'团队协作交接对齐会','reviewed','2026-10-06T02:00:00Z',
    '2026-10-06T03:00:00Z',$2,$3,$4::jsonb,'[]','{}','{}','{}')`,[meetingId,"sun-mingze",ceoId,JSON.stringify(["sun-mingze",LUYAO.personId])]);
  await addTask("meeting","整理会后确认的交接责任与证据", "not_started","meeting",null,null,null,"2026-10-14",LUYAO.personId,
    {meetingId,itemId:"demo-action-1",quote:"王路遥在 10 月 14 日前列出三种交接场景的负责人、接手人及完成证据。"});
  await addTask("done","完成演示资料的访问权限核对", "done","self",null,null,"2026-10-02","2026-10-04");
  await addTask("invited","核对灯塔项目验收记录的交接字段", "in_progress","self",null,null,"2026-10-07","2026-10-18","sun-mingze");
  for (const [taskId,personId,adder] of [[ids.a1,"sun-mingze",LUYAO.personId],[ids.invited,LUYAO.personId,"sun-mingze"]]) {
    await sql("INSERT INTO task_members (task_id,person_id,role,added_by) VALUES ($1,$2,'collaborator',$3)",[taskId,personId,adder]);
    await sql("INSERT INTO thread_members (object_type,object_id,person_id,added_by) VALUES ('task',$1,$2,$3)",[taskId,personId,adder]);
  }
  for (const [author,body] of [[LUYAO.personId,"我先把实际交接中反复被问到的问题列出来，请孙铭泽核对有没有遗漏。"],
    ["sun-mingze","灯塔项目里接手人最常问的是完成证据在哪里，以及异常由谁接回。"],
    [LUYAO.personId,"收到，我把证据链接和异常回接人写成必填项，周五用第一例验证。"]])
    await sql("INSERT INTO thread_messages (object_type,object_id,author_id,kind,content) VALUES ('task',$1,$2,'member',$3)",[ids.a1,author,body]);
  await sql("INSERT INTO task_notes (task_id,person_id,note,updated_at) VALUES ($1,'sun-mingze',$2,$3)",
    [ids.a1,"私人批注：第一例演练请先检查异常回接路径，不在群里替负责人下结论。", "2026-10-07T03:00:00Z"]);
  await sql("INSERT INTO task_notes (task_id,person_id,note,updated_at) VALUES ($1,$2,$3,$4)",
    [ids.invited,LUYAO.personId,"私人批注：对照自己那张交接清单检查证据字段。","2026-10-07T04:00:00Z"]);
  await sql(`INSERT INTO task_progress (id,task_id,author_id,source,body,links,created_at) VALUES
    ($1,$2,$3,'web','已整理三种交接场景，待接手人核对证据链接。',$4::jsonb,'2026-10-07T02:00:00Z'),
    ($5,$2,$3,'claude','演示记录：已比对访谈纪要，发现异常回接人字段缺失，王路遥待人工确认。','[]','2026-10-07T03:00:00Z')`,
    [randomUUID(),ids.a1,LUYAO.personId,JSON.stringify([{url:"https://example.com/demo-luyao-handoff",title:"演示交接清单"}]),randomUUID()]);
  for (const [kind,taskId,actorId] of [["meeting_action_assigned",ids.meeting,null],["task_collaborator_added",ids.invited,"sun-mingze"]])
    await sql("INSERT INTO notifications (id,person_id,kind,object_type,object_id,actor_id) VALUES ($1,$2,$3,'task',$4,$5)",
      [randomUUID(),LUYAO.personId,kind,taskId,actorId]);

  const directions = ["企业协作中的交接责任与完成证据", "AI 助手参与项目管理的人工核对边界", "知识归档与跨团队复盘方法"];
  await sql(`INSERT INTO person_radar (person_id,enabled,directions,sources,updated_at,last_run)
    VALUES ($1,true,$2::jsonb,'["ft.com","36kr.com"]',$3,$4::jsonb)`,
    [LUYAO.personId,JSON.stringify(directions),now,JSON.stringify({trigger:"manual",status:"completed",startedAt:"2026-10-01T01:00:00Z",completedAt:"2026-10-01T01:01:00Z",createdSignals:5,warnings:[]})]);
  const signals = [
    ["演示资讯：跨团队交接清单开始强调可追溯证据",directions[0],5,false,"交接责任和证据链接的要求与本月个人任务直接相关。"],
    ["演示资讯：企业项目复盘采用接手人独立回看",directions[2],4,false,"可用非当事人回看验证归档是否真正可用。"],
    ["演示资讯：AI 协作记录建议标明人工确认点",directions[1],4,true,"提醒在交接模板中标出必须由人判断的字段。"],
    ["演示资讯：知识库归档模板加入来源原话",directions[2],3,true,"会议原话与执行结果可以用同一索引串联。"],
    ["演示资讯：项目移交试点把异常回接人列为必填",directions[0],3,false,"异常处理归属是当前访谈要验证的字段。"],
  ] as const;
  for (const [index,[title,direction,relevance,read,reason]] of signals.entries()) {
    const url = `https://www.ft.com/content/demo-luyao-${index + 1}`;
    await sql(`INSERT INTO person_radar_signals (id,person_id,source_type,source_fingerprint,source_title,source_url,published_at,
      excerpt,source_ref,direction_id,direction_text,summary,reason,evidence_quote,relevance,read_at,collected_at)
      VALUES ($1,$2,'outlet',$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12,$13,$14,$15,$16)`,
      [randomUUID(),LUYAO.personId,`demo-luyao-${index}`,title,url,"2026-09-30T08:00:00Z",
        `${title}。这是一条时间机器演示资讯，不对应真实报道。`,JSON.stringify({type:"outlet",provider:"publisher-feed",outletId:"ft",outletName:"演示资讯 · FT"}),
        directionId(direction,"person"),direction,title,reason,title,relevance,read ? "2026-10-01T01:30:00Z" : null,
        `2026-10-01T01:0${index}:00Z`]);
  }
  return { roundId, cardId, tasks: ids };
}
