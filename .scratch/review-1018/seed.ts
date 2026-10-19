/** 审核演示库灌数：删库重建 tianshu_review_1018（54329）→ 迁移 → 账号 → 十月计划/任务/会议/采集 → ⑨ 请求 → 记忆与首页历史
 *  → 本周周复盘与十月个人复盘（真实模型生成，带出处）。
 * 用法（在 worktree 根目录）：node apps/api/node_modules/tsx/dist/cli.mjs .scratch/review-1018/seed.ts
 * 请求和首页历史用脚本化 Agent 写（模拟「已经发生过的事」）；两份复盘用主工作区 .env 里的真实模型网关生成。 */
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { DATA_DIR, DB_NAME, DEMO_PASSCODE, MAIN_ROOT, PEOPLE_FILE, PG_ADMIN_URL, WORKTREE, loadReviewEnv } from "./env.js";

loadReviewEnv();
const api = (path: string) => import(pathToFileURL(join(WORKTREE, "apps/api/src", path)).href);
const { Pool } = createRequire(join(WORKTREE, "apps/api/package.json"))("pg") as typeof import("pg");

const CEO = "liu-minghua", SUN = "sun-mingze", TANG = "tang-jujie", CHEN = "chen-xinan";
const PEOPLE = [CEO, SUN, TANG, CHEN];
const DAY = 86_400_000;
const shanghai = (offsetDays: number, hhmm: string) => {
  const today = new Date(Date.now() + 8 * 3_600_000).toISOString().slice(0, 10);
  return new Date(Date.parse(`${today}T${hhmm}:00+08:00`) + offsetDays * DAY);
};
const log = (...args: unknown[]) => console.log("[seed]", ...args);

// 1. 人员名单：主工作区真实名单里挑四个人，写到 .data（gitignore）。
const allPeople = JSON.parse(readFileSync(join(MAIN_ROOT, "seed/company-people.json"), "utf8"));
writeFileSync(PEOPLE_FILE, JSON.stringify({ ...allPeople, people: allPeople.people.filter((p: { personId: string }) => PEOPLE.includes(p.personId)) }, null, 2));

// 2. 删库重建 + 迁移。
const admin = new Pool({ connectionString: PG_ADMIN_URL, max: 1 });
await admin.query(`DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`);
await admin.query(`CREATE DATABASE ${DB_NAME}`);
await admin.end();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 8 });
const sql = async (text: string, params: unknown[] = []) => (await pool.query(text, params)).rows;
const { migrate } = await api("migrate.ts");
{ const c = await pool.connect(); try { await migrate(c); } finally { c.release(); } }
log("migrated", DB_NAME);
// 只在演示库里绕开一个已知问题：个人记忆提炼的游标在 JS 里只有毫秒，消息的 created_at 是微秒，
// 最后一条消息永远「在游标之后」，提炼每个 tick 都重跑一次真实模型。这里把对话消息的时间截到毫秒，避免审核期间空烧网关。
await sql(`CREATE FUNCTION review_ms_created_at() RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN NEW.created_at := date_trunc('milliseconds', NEW.created_at); RETURN NEW; END $$`);
await sql("CREATE TRIGGER review_ms_created_at BEFORE INSERT ON conversation_messages FOR EACH ROW EXECUTE FUNCTION review_ms_created_at()");

// 3. 账号：口令统一，跳过首次改码；陈溪南不标引导完成（演示采集器同意开关）。
const { setMemberAccess, loginIdFor } = await api("memberAccess.ts");
for (const personId of PEOPLE) await setMemberAccess(sql, { personId, loginId: loginIdFor(personId), passcode: DEMO_PASSCODE, mustChange: false });
for (const personId of [CEO, SUN, TANG]) await sql("INSERT INTO person_onboarding(person_id, completed_at) VALUES ($1, now())", [personId]);

// 4. 十月：增长战场计划已确认、Mission 卡已确认；孙铭泽两个 Mission，唐巨杰一个。
const plan = randomUUID(), round = randomUUID(), sunCard = randomUUID(), tangCard = randomUUID();
await sql("UPDATE battlefield_config SET owner_id=$1, six_month_outcome='天枢成为全员每天在用的工作台' WHERE id='growth'", [CEO]);
await sql("INSERT INTO capability_config(id,version,code,name,six_month_outcome) VALUES ('method',1,'01','方法','流程沉淀成可复用的方法') ON CONFLICT DO NOTHING");
await sql(`INSERT INTO monthly_plans(id,version,period,status,company_outcome,battlefields,todos,negotiation,generation,confirmed_at)
  VALUES($1,1,'2026-10','confirmed','十月底全员用天枢做周复盘和请求','[{"battlefieldId":"growth","outcome":"采集器装好、周复盘自动起草上线"}]','[]',
  '{"edits":[],"checkedItemIds":["company","battlefield:growth"],"feedback":[],"note":""}',
  '{"status":"ready","pendingSince":null,"runId":null,"previousRunIds":[],"error":null,"generatedAt":"2026-10-01T00:00:00.000Z"}','2026-10-01T02:00:00Z')`, [plan]);
await sql(`INSERT INTO mission_rounds(id,version,battlefield_id,period,monthly_plan_id,status,draft_origin,draft_source,window_seq,first_opened_at,opened_at,closes_at,confirmed_by,confirmed_at,created_at,updated_at)
  VALUES($1,1,'growth','2026-10',$2,'confirmed','placeholder','{}',1,'2026-10-01T02:00:00Z','2026-10-01T02:00:00Z','2026-10-03T02:00:00Z',$3,'2026-10-04T02:00:00Z','2026-10-01T02:00:00Z','2026-10-04T02:00:00Z')`, [round, plan, CEO]);
for (const [card, owner, order] of [[sunCard, SUN, 0], [tangCard, TANG, 1]] as const) {
  await sql("INSERT INTO personal_mission_cards(id,round_id,owner_id,sort_order,member_ids,created_at) VALUES($1,$2,$3,$4,$5::jsonb,'2026-10-01T02:00:00Z')",
    [card, round, owner, order, JSON.stringify([owner, CEO])]);
}
const missions = [
  ["m10-collector", "采集器一键安装上线", SUN, sunCard, "全员装好本机采集器，每天自动上报工作段", '["10/16 安装包可用","10/23 全员装好","10/30 复盘用上采集记录"]'],
  ["m10-weekly", "周复盘自动起草试运行", SUN, sunCard, "每周五 15:00 自动起草周复盘，本人确认后提交", '["10/16 第一次自动起草","10/30 全员确认过两次"]'],
  ["m10-filing", "产品备案材料齐套", TANG, tangCard, "备案信息表、产品截图和说明一次交齐", '["10/20 收齐各组材料","10/27 提交备案"]'],
] as const;
for (const [id, title, owner, card, outcome, milestones] of missions) {
  await sql(`INSERT INTO missions(id,version,code,period,title,owner_id,capability_id,battlefield_ids,outcome,why,success_evidence,milestones,boundaries,
    source_ref,source_document_id,source_revision,source_title,personal_mission_card_id)
    VALUES($1,1,$1,'2026-10',$2,$3,'method','["growth"]',$4,'十月要让大家不用再手写汇报','["上线截图与使用记录"]',$5::jsonb,'只做天枢内的流程',
    'review-1018://seed','review-1018',1,'审核演示',$6)`, [id, title, owner, outcome, milestones, card]);
}

// 5. 执行事项、进展、会议、采集记录：给周复盘和个人复盘当原料（本周 + 上周）。
const tasks: Record<string, string> = {};
for (const [key, title, owner, mission, status, order] of [
  ["installer", "做采集器安装包", SUN, "m10-collector", "in_progress", 1],
  ["rollout", "全员装机与回访", SUN, "m10-collector", "in_progress", 2],
  ["weeklyAgent", "周复盘起草 Agent 联调", SUN, "m10-weekly", "in_progress", 1],
  ["filingSheet", "收齐备案信息表", TANG, "m10-filing", "in_progress", 1],
] as const) {
  tasks[key] = randomUUID();
  await sql("INSERT INTO tasks(id,title,status,owner_id,created_by,mission_id,step_order) VALUES($1,$2,$3,$4,'plan',$5,$6)", [tasks[key], title, status, owner, mission, order]);
}
const progress = [
  ["installer", SUN, "安装包 v0.3 出来了，Windows 和 macOS 都能一键装", '[{"url":"https://github.com/TokenkingOS/collector/pull/12"}]', -5, "11:00"],
  ["installer", SUN, "上周把上报接口和心跳打通", "[]", -10, "15:00"],
  ["rollout", SUN, "给方法组 6 个人装好了，2 台 Mac 权限要手动开", "[]", -3, "17:30"],
  ["weeklyAgent", SUN, "起草 Agent 接上采集记录，五段都带出处", '[{"url":"https://github.com/TokenkingOS/Tianshu-MVP/pull/21"}]', -2, "20:00"],
  ["filingSheet", TANG, "备案信息表发出去了，产品组还差截图", "[]", -1, "16:30"],
] as const;
for (const [task, author, body, links, day, hhmm] of progress) {
  await sql("INSERT INTO task_progress(id,task_id,author_id,source,body,links,created_at) VALUES($1,$2,$3,'web',$4,$5::jsonb,$6)",
    [randomUUID(), tasks[task], author, body, links, shanghai(day, hhmm)]);
}
await sql(`INSERT INTO meetings(id,version,title,status,scheduled_at,lead_dri_id,ceo_participant_id,participants,issue_ids,preflight,draft,materials,origin_ref,ends_at,outcome)
  VALUES($1,1,'采集器上线评审','reviewed',$2,$3,$3,$4::jsonb,'[]','{}','{}','[]','{}',$5,$6::jsonb)`,
[randomUUID(), shanghai(-4, "14:00"), CEO, JSON.stringify([SUN, TANG].map((personId) => ({ personId, displayName: personId === SUN ? "孙铭泽" : "唐巨杰", roles: ["dri"], sourceRef: "review-1018", updatedAt: "2026-10-01" }))),
  shanghai(-4, "15:00"), JSON.stringify({ status: "ready", summary: "评审采集器上线节奏", items: [
    { id: "d1", kind: "decision", text: "采集原文只保留 14 天", review: { status: "confirmed" } },
    { id: "d2", kind: "decision", text: "10/23 前全员装好采集器", review: { status: "confirmed" } }] })]);
await sql("INSERT INTO collector_consents(person_id, granted, updated_at) VALUES ($1, true, now())", [SUN]);
for (const [text, task, day, from, to] of [
  ["写完采集器安装脚本的权限检查", "installer", -5, "09:30", "11:00"],
  ["排查两台 Mac 的辅助功能权限", "rollout", -3, "15:00", "16:10"],
  ["周复盘起草提示词联调，补上出处校验", "weeklyAgent", -2, "19:00", "20:30"],
] as const) {
  await sql(`INSERT INTO collector_progress(id,person_id,source,repo,started_at,ended_at,text,placement,confidence,task_id,item_ids,created_at)
    VALUES($1,$2,'codex','Tianshu-MVP',$3,$4,$5,'task',0.9,$6,ARRAY[$7::uuid],now())`, [randomUUID(), SUN, shanghai(day, from), shanghai(day, to), text, tasks[task], randomUUID()]);
}

// 6. 起一个进程内的 app：请求用脚本化 Agent，周复盘/个人复盘用真实模型。
const { buildApp } = await api("app.ts");
const { loadCompanyMemory } = await api("companyMemory.ts");
const { personDisplayNames } = await api("people.ts");
const { createWeeklyReviewService } = await api("weeklyReviewService.ts");
const { createWeeklyReviewDraftAgent } = await api("weeklyReviewAgent.ts");
const { createMonthlyReviewService } = await api("monthlyReviewService.ts");
const { createPersonalReviewDraftAgent } = await api("personalReviewAgent.ts");
const { createMonthlyReviewAssessAgent, createMonthlyReviewDraftAgent, createMonthlyReviewSummaryAgent } = await api("monthlyReviewAgents.ts");
const { weekStartOf, addDays } = await api("weeklyReviews.ts");
// 记忆提炼不调模型：用测试里那份只交 noop 候选的模型流。
const { noopDistillationStream } = await import(pathToFileURL(join(WORKTREE, "apps/api/test/helpers.ts")).href);

const env = {
  sessionSecret: process.env.SESSION_SECRET!, sessionMaxAgeSeconds: 3600, publicOrigin: process.env.PUBLIC_ORIGIN!,
  driServiceToken: process.env.DRI_SERVICE_TOKEN!, mcpServiceToken: process.env.COMPANY_MEMORY_MCP_TOKEN!,
  companyMemorySeedDir: process.env.COMPANY_MEMORY_SEED_DIR!, companyPeopleSeed: PEOPLE_FILE, companyName: process.env.COMPANY_NAME,
  piBaseUrl: process.env.PI_BASE_URL!, piApiKey: process.env.PI_API_KEY!, lightModel: process.env.LIGHT_MODEL!,
  heavyModel: process.env.HEAVY_MODEL!, compactionModel: process.env.COMPACTION_MODEL!, buildSha: "review-1018-seed",
  conversationAttachmentStorageDir: join(DATA_DIR, "attachments"), materialStorageDir: join(DATA_DIR, "materials"), recordingStorageDir: join(DATA_DIR, "recordings"),
};
let clock = new Date();
const now = () => clock;
const companyMemory = loadCompanyMemory(env);
const reviewAgentOptions = { query: pool.query.bind(pool), baseUrl: env.piBaseUrl, apiKey: env.piApiKey, modelId: env.heavyModel };
const weeklyReviewService = createWeeklyReviewService({ pool, agent: createWeeklyReviewDraftAgent(reviewAgentOptions), people: () => [SUN, TANG], now });
const monthlyReviewService = createMonthlyReviewService({ pool, companyMemory, now,
  personalDraft: { storageDir: env.conversationAttachmentStorageDir, agent: createPersonalReviewDraftAgent({ ...reviewAgentOptions, personName: (id: string) => personDisplayNames(companyMemory).get(id) }) },
  agents: { draft: createMonthlyReviewDraftAgent(reviewAgentOptions), assess: createMonthlyReviewAssessAgent(reviewAgentOptions), summarize: createMonthlyReviewSummaryAgent(reviewAgentOptions) } });

const SCREENSHOT_Q = "截图是直接贴进表格，还是存云盘、贴链接？";
const requestScripts: Record<string, { title: string; body: string; recipientIds: string[] }> = {
  filing: { title: "填备案信息表（产品部分）", recipientIds: [SUN, CHEN],
    body: "财务在准备产品备案。请在《备案信息表》的「产品介绍」「功能截图」两栏填上你负责的模块，周二 18:00 前填完。\n表格链接：飞书云文档《备案信息表》第 2 页。" },
  notes: { title: "整理十月客户访谈纪要", recipientIds: [SUN, TANG],
    body: "月底复盘要用十月的客户访谈结论。请把你参加过的访谈纪要整理进共享文件夹「10 月访谈」，每份写清客户、日期和三条结论，周三前交。" },
};
const requestAgent = {
  async draft(input: { prompt: string }) {
    const script = input.prompt.includes("备案") ? requestScripts.filing : requestScripts.notes;
    return { ...script, questions: [] };
  },
  async lookup(input: { question: string; answered: { questionId: string; question: string }[] }) {
    const hit = input.question.includes("截图") ? input.answered.find((item) => item.question.includes("截图")) : undefined;
    return { match: hit ? "question" : "none", quote: null, questionId: hit?.questionId ?? null, question: input.question };
  },
  async answer() { return { answer: "存云盘，贴链接" }; },
};
// 首页历史：脚本化回答，用到个人记忆时按约定写记忆标记。
const runtime = {
  async run(input: { message: string; personalMemory?: unknown; emit: (event: unknown) => void; runtimeEntries: unknown[] }) {
    const memory = (await input.personalMemory as { id: string; title: string; text: string }[] | undefined) ?? [];
    const used = memory[0];
    const text = used
      ? `按你之前定的：${used.text}[记忆](cite:pmem:${used.id})\n\n${used.title === "十月验收口径" ? "所以十月只盯采集器装机率和周复盘确认率，其余放到十一月。" : "这周的周复盘草稿按这条起草，每段都带出处。"}`
      : "收到。我先记下这件事，之后在任何页面问我都接得上。";
    input.emit({ type: "message", delta: text });
    return { assistantMessage: text, runtimeEntries: input.runtimeEntries };
  },
};
const app = await buildApp({ pool, env, conversationRuntime: runtime, requestAgent, weeklyReviewService, monthlyReviewService, now,
  personalMemoryRecall: null, personalDistillationStream: noopDistillationStream, backgroundPreflight: false });
const origin = env.publicOrigin;
const cookies: Record<string, string> = {};
for (const personId of PEOPLE) {
  const res = await app.inject({ method: "POST", url: "/api/auth/login", headers: { origin }, payload: { loginId: loginIdFor(personId), passcode: DEMO_PASSCODE } });
  if (res.statusCode !== 200) throw new Error(`login ${personId}: ${res.statusCode} ${res.body}`);
  cookies[personId] = (res.headers["set-cookie"] as string | string[]).toString().split(";")[0];
}
const call = async (who: string, method: "GET" | "POST", url: string, payload?: object) => {
  const res = await app.inject({ method, url, headers: { cookie: cookies[who], origin }, ...(payload ? { payload } : {}) });
  if (res.statusCode >= 300) throw new Error(`${method} ${url} as ${who}: ${res.statusCode} ${res.body.slice(0, 400)}`);
  return String(res.headers["content-type"] ?? "").includes("json") ? res.json() : res.body;
};
type View = { id: string; actions: { actionType: string; actionId: string; itemId?: string }[]; questions: { id: string }[] };
const view = async (who: string, id: string) => (await call(who, "GET", `/api/requests/${id}`)).request as View;
const act = (who: string, request: View, actionType: string, input?: object, itemId?: string) => {
  const action = request.actions.find((a) => a.actionType === actionType && (itemId === undefined || a.itemId === itemId));
  if (!action) throw new Error(`${who} 没有 ${actionType}`);
  return call(who, "POST", "/api/requests/actions/execute", { actionId: action.actionId, ...(input ? { input } : {}) });
};

// 7. ⑨ 请求：昨天唐巨杰请孙铭泽、陈溪南填备案表（陈溪南问过截图，唐巨杰答了）；今天上午刘明华请孙铭泽、唐巨杰整理访谈纪要（唐巨杰提问，待刘明华回答）。
clock = shanghai(-1, "16:20");
const filing = (await call(TANG, "POST", "/api/requests/draft", { prompt: "让铭泽和溪南把备案信息表里产品那部分填了" })).request as View;
await act(TANG, filing, "request.send", { recipientIds: [SUN, CHEN] });
clock = shanghai(-1, "17:05");
await act(CHEN, await view(CHEN, filing.id), "request.ask", { question: `备案信息表「功能截图」栏：${SCREENSHOT_Q}` });
clock = shanghai(-1, "17:40");
const filingAtTang = await view(TANG, filing.id);
await act(TANG, filingAtTang, "request.answer", { answer: "存云盘，贴链接，链接贴在表格最后一栏" }, filingAtTang.questions[0].id);
clock = shanghai(0, "09:30");
const notes = (await call(CEO, "POST", "/api/requests/draft", { prompt: "让铭泽和巨杰周三前把十月客户访谈纪要整理进共享文件夹" })).request as View;
await act(CEO, notes, "request.send", { recipientIds: [SUN, TANG] });
clock = shanghai(0, "10:15");
await act(TANG, await view(TANG, notes.id), "request.ask", { question: "整理十月客户访谈纪要：按客户一份一份放，还是合并成一份？" });
// 请求的时间由数据库 now() 写入，这里改回「昨天下午 / 今天上午」，界面和「昨天巨杰拜托我的」对得上。
for (const [id, sent, asked] of [[filing.id, shanghai(-1, "16:20"), shanghai(-1, "17:05")], [notes.id, shanghai(0, "09:30"), shanghai(0, "10:15")]] as const) {
  await sql("UPDATE requests SET created_at=$2, sent_at=$2, updated_at=$2 WHERE id=$1", [id, sent]);
  await sql("UPDATE request_questions SET created_at=$2, answered_at=CASE WHEN answered_at IS NULL THEN NULL ELSE $2::timestamptz + interval '35 minutes' END WHERE request_id=$1", [id, asked]);
  await sql("UPDATE notifications SET created_at=$2 WHERE object_type='request' AND object_id=$1::text", [id, sent]);
}
log("requests", filing.id, notes.id);

// 8. 个人记忆 + 首页历史（带记忆小标记）。
const memories = [
  [CEO, "stance", "十月验收口径", "十月验收只看两件事：采集器装机率、周复盘确认率；别的放到十一月。"],
  [CEO, "preference", "回答先给结论", "回答先给结论和数字，再讲原因；不要铺垫。"],
  [CEO, "open_question", "备案要不要找外部代理", "备案是自己做还是找外部代理，还没定，等唐巨杰把材料收齐再看。"],
  [SUN, "practice", "周复盘的出处", "周复盘每一段都要挂出处，没有记录就写「缺少记录」，不编。"],
  [SUN, "preference", "回复用短句", "回复用短句，先说要我做什么。"],
] as const;
for (const [person, kind, title, text] of memories) {
  await sql("INSERT INTO personal_memory_items(id,person_id,kind,title,text,refs,created_at,updated_at) VALUES($1,$2,$3,$4,$5,'[]',$6,$6)",
    [randomUUID(), person, kind, title, text, shanghai(-6, "10:00")]);
}
clock = shanghai(-2, "21:10");
await call(CEO, "POST", "/api/conversations/global/messages", { message: "十月验收口径我之前是怎么定的？" });
clock = shanghai(-1, "08:45");
await call(SUN, "POST", "/api/conversations/global/messages", { message: "周复盘的出处要怎么写，我之前说过的规矩是什么？" });

// 9. 周复盘：上周已提交（导入）；本周由真实模型起草（本周待确认）。
clock = new Date();
const week = weekStartOf(clock);
await sql(`INSERT INTO weekly_reviews(id,person_id,week_start,status,origin,body,submitted_at,created_at,updated_at) VALUES($1,$2,$3,'submitted','import',$4::jsonb,$5,$5,$5)`,
  [randomUUID(), SUN, addDays(week, -7), JSON.stringify({ overall: { text: "状态：黄｜采集器安装包还没出", sources: [] }, progress: { text: "上报接口和心跳打通", sources: [] },
    issues: { text: "Mac 权限要手动开", sources: [] }, implications: { text: "无", sources: [] }, actions: { text: "出安装包，先给方法组装", sources: [] } }), new Date(Date.parse(`${addDays(week, -3)}T10:00:00+08:00`))]);
for (const personId of [SUN, TANG]) {
  const started = await weeklyReviewService.generateFor(personId, { weekStart: week });
  await started.done;
}
await weeklyReviewService.idle();
log("weekly", week, await sql("SELECT person_id, status, draft_error->>'message' AS error FROM weekly_reviews WHERE week_start=$1", [week]));

// 10. 十月月末复盘提前开启：有 Mission 的人（孙铭泽、唐巨杰）各一份个人复盘，真实模型起草、带出处。
await monthlyReviewService.open("2026-10");
await monthlyReviewService.idle();
log("personal reviews", await sql("SELECT person_id, status, draft_error->>'message' AS error FROM personal_reviews"));

await app.close();
await pool.end();
log("done. 账号见 .scratch/review-1018/README.md");
