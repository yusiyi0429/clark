/** 手动测试用的「时间机器」环境：Web 3500（电脑和同一 Wi-Fi 的手机都能开）/ API 4500，只用 54329 的一次性测试库。
 * 每次启动都是一套全新的库和合成身份；应用时钟可以拨（见 README.md）。
 * No .env, actual credentials, model calls or external notifications — except speech: the Volc ASR key (VOLC_ASR_*)
 * and Tencent voiceprint credentials are read from apps/api/.env, so dictation and voiceprint behave as in production.
 * control.cjs 通过 run/ 里的命令文件与它通信；advance/near/next-month 只拨本进程的应用时钟。
 * advance moves this process's application clock to the deadline before making its snapshot.
 */
import { randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, rmdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { networkInterfaces, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import type { TestApp } from "../../apps/api/test/helpers.js";
import { LUYAO, clearWangLuyao, seedWangLuyao } from "./demo-luyao.js";

// Windows 偶尔会把 54329 划进系统保留端口段（重启 winnat 前绑不上）：那时用 TEST_PG_URL 指到别的端口。
const testDatabaseUrl = process.env.TEST_PG_URL ?? "postgres://postgres:postgres@localhost:54329/postgres";
process.env.TEST_PG_URL = testDatabaseUrl;
const root = fileURLToPath(new URL("../../", import.meta.url));
// 听写与声纹走真实服务：只从 apps/api/.env 取火山识别（VOLC_ASR_*）和腾讯云声纹的凭据，其余凭据一概不读。
const SPEECH_KEYS = /^(VOLC_ASR_|TENCENTCLOUD_SECRET_(ID|KEY)$|TENCENT_ASR_REGION$)/;
try {
  const apiEnv = parseEnv(await readFile(join(root, "apps/api/.env"), "utf8"));
  for (const [key, value] of Object.entries(apiEnv)) if (SPEECH_KEYS.test(key) && value) process.env[key] = value;
} catch {
  /* 没有 .env：听写与声纹如实提示未配置 */
}
// 测试身份的声纹进单独的分组，不混进正式分组（混进去会让正式会议的 1:N 先匹配到库里认不出的测试声纹）。
process.env.TENCENT_VOICEPRINT_GROUP = "tianshu_manual_test";
// 端口和运行目录可以换：验收时另起一套，不碰正在用的 3500 / 4500。
const API_PORT = Number(process.env.TM_API_PORT ?? 4500);
const WEB_PORT = Number(process.env.TM_WEB_PORT ?? 3500);
const runDir = process.env.TM_RUN_DIR ?? fileURLToPath(new URL("./run/", import.meta.url));
const commandFile = join(runDir, "command.json");
const responseFile = join(runDir, "response.json");
const metadataFile = join(runDir, "fixture.json");
const fixtureId = randomUUID();
const output = process.stdout.write.bind(process.stdout);
process.stdout.write = ((_chunk: unknown, encoding?: unknown, callback?: () => void) => {
  if (typeof encoding === "function") encoding(); else callback?.();
  return true;
}) as typeof process.stdout.write;
const report = (value: unknown) => output(`${JSON.stringify(value)}\n`);

let app: TestApp | undefined;
let fixtureDir: string | undefined;
let shutdown: Promise<void> | undefined;
let settled: (() => void) | undefined;
let closeCommandPool: (() => Promise<void>) | undefined;
let pollTimer: ReturnType<typeof setTimeout> | undefined;
let closeTimer: ReturnType<typeof setInterval> | undefined;
let applicationNow = () => new Date();
let metadata: Record<string, unknown> = { fixtureId, pid: process.pid, ready: false };
async function writeJson(path: string, value: unknown) {
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`);
  await rename(temporary, path);
}
function close() {
  shutdown ??= (async () => {
    if (pollTimer) clearTimeout(pollTimer);
    if (closeTimer) clearInterval(closeTimer);
    try {
      await closeCommandPool?.();
      await app?.close();
    } finally {
      if (fixtureDir) {
        const target = resolve(fixtureDir);
        if (!target.startsWith(join(resolve(tmpdir()), "warmap-manual-test-"))) throw new Error("Unexpected fixture directory");
        const info = await lstat(target);
        if (!info.isDirectory() || info.isSymbolicLink() || (await realpath(target)).toLowerCase() !== target.toLowerCase()) throw new Error("Fixture directory is not the expected physical directory");
        if ((await readdir(target)).some((entry) => entry !== "people.json")) throw new Error("Unexpected file in fixture directory");
        await rm(join(target, "people.json"), { force: true });
        await rmdir(target);
      }
    }
    metadata = { ...metadata, ready: false, closed: true };
    await writeJson(metadataFile, metadata);
    report({ closed: true, fixtureId, database: metadata.database, fixtureDirectory: fixtureDir });
  })();
  return shutdown;
}

async function inspect() {
  if (!app) throw new Error("Fixture not ready");
  const [counts] = await app.sql(`SELECT
    (SELECT count(*)::int FROM mission_rounds) AS rounds,
    (SELECT count(*)::int FROM personal_mission_cards) AS cards,
    (SELECT count(*)::int FROM missions WHERE personal_mission_card_id IS NOT NULL) AS missions,
    (SELECT count(*)::int FROM mission_card_feedback) AS feedback,
    (SELECT count(*)::int FROM mission_round_reviews) AS reviews,
    (SELECT bool_and(placeholder) FROM missions WHERE personal_mission_card_id IS NOT NULL) AS all_placeholder`);
  const rounds = await app.sql("SELECT id,version,status,window_seq,opened_at,closes_at,confirmed_by,confirmed_at,reopens FROM mission_rounds ORDER BY created_at");
  const cards = await app.sql("SELECT id AS card_id,owner_id FROM personal_mission_cards ORDER BY sort_order,id");
  const feedback = await app.sql(`SELECT id,seq,kind,author_id,mission_id,field,basis,source_version,late,created_at,
    left(body,120) AS body_preview,quote IS NOT NULL AS has_quote,original IS NOT NULL AS has_original,
    proposed IS NOT NULL AS has_proposed FROM mission_card_feedback ORDER BY seq`);
  const missions = await app.sql(`SELECT id,code,version,personal_mission_card_id,title,why,outcome,success_evidence,
    boundaries,key_path,milestones,resources,dependencies,human_agent_split,risk,retrospect,placeholder
    FROM missions WHERE personal_mission_card_id IS NOT NULL ORDER BY id`);
  const reviews = await app.sql(`SELECT id,window_seq,snapshot_at,taken_at,superseded_at,feedback_ids,mission_versions,note,applied_versions
    FROM mission_round_reviews ORDER BY window_seq,id`);
  const decisions = await app.sql(`SELECT review_id,feedback_id,decision,decided_by,decided_at,carried
    FROM mission_review_decisions ORDER BY review_id,feedback_id`);
  const tasks = await app.sql("SELECT id,title,status,owner_id,version FROM tasks ORDER BY owner_id,created_at");
  const corrections = await app.sql("SELECT id,card_id,mission_id,field,status,direct,author_id,decided_by,applied_version,left(reason,60) AS reason,created_at FROM mission_card_corrections ORDER BY created_at").catch(() => []);
  return { inspect: true, fixtureId, database: metadata.database, now: applicationNow().toISOString(), clockBase: metadata.now, counts, rounds, cards, feedback, missions, reviews, decisions, tasks, corrections };
}

async function main() {
  const { createTestApp, testEnv, TEST_CEO } = await import("../../apps/api/test/helpers.js");
  const { setMemberAccess } = await import("../../apps/api/src/memberAccess.js");
  const { closeDueRounds } = await import("../../apps/api/src/missionRounds.js");
  await mkdir(runDir, { recursive: true });
  testEnv.publicOrigin = `http://localhost:${WEB_PORT}`;
  // 同一 Wi-Fi 的手机经本机私有网段地址打开：http 3500 直连，或 https 8444 经本机反代（.scratch/lan-https）。只放行这些来源。
  const lanOrigins = Object.values(networkInterfaces()).flat().filter((net) => net && net.family === "IPv4" && !net.internal && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(net.address)).flatMap((net) => [`http://${net!.address}:${WEB_PORT}`, `https://${net!.address}:8444`]);
  testEnv.extraOrigins = [`http://127.0.0.1:${WEB_PORT}`, ...lanOrigins];
  // 演示入口：登录页右下角「天枢系统」免口令进入王路遥（杜撰的调试身份，只在一次性测试库里）。
  testEnv.demoLoginId = LUYAO.loginId;
  fixtureDir = await mkdtemp(join(tmpdir(), "warmap-manual-test-"));
  const people = JSON.parse(await readFile(join(root, "apps/api/test/fixtures/company-people.json"), "utf8"));
  people.people[0].displayName = "验收 CEO";
  for (const [personId, displayName] of [["bai-tiantian", "白田田"], ["liu-renhao", "刘人豪"], ["sun-mingze", "孙铭泽"], ["chen-xinan", "陈溪南"], ["yu-siyi", "于斯一"]]) {
    people.people.push({ personId, displayName, roles: ["dri"] });
  }
  for (const [personId, displayName] of [["browser-dri", "林知行"], ["browser-no-card", "何望舒"], ["browser-empty", "顾清和"]]) {
    people.people.push({ personId, displayName, roles: ["dri"] });
  }
  people.people.push({ personId: LUYAO.personId, displayName: "王路遥", roles: ["ceo", "dri"] });
  people.people.push({ personId: "demo-zhou-tinglan", displayName: "周听澜", roles: ["dri"] });
  people.people.push({ personId: "demo-xu-zhiwei", displayName: "许知微", roles: ["dri"] });
  const peopleFile = join(fixtureDir, "people.json");
  await writeFile(peopleFile, JSON.stringify(people));
  let now = new Date("2026-10-01T02:00:00.000Z");
  let clockAnchor = Date.now();
  const appNow = () => new Date(now.getTime() + Date.now() - clockAnchor);
  applicationNow = appNow;
  app = await createTestApp({ companyPeopleSeed: peopleFile, companyName: "天枢（手动测试）", missionCardDraftsDir: join(root, "seed/placeholders") }, {
    async run(input) {
      const answer = "这是隔离验收中的私人只读回复。公开意见请在事项群组发表；这段私聊不会进入集中 Review。";
      input.emit({ type: "message", delta: answer });
      return { assistantMessage: answer, runtimeEntries: input.runtimeEntries };
    },
  }, {
    monthlyNow: appNow,
    // 材料批注：时间机器没有模型，演示规则——批注写「改成 X」就把选中的文字换成 X，写「删掉 / 删除」就删掉，其他说看不懂。
    materialAnnotationAgent: { async generate(input) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      const target = input.source.includes(input.quote) && input.source.split(input.quote).length === 2 ? input.quote : null;
      const replace = /^(?:请)?(?:改成|改为|换成)(.+)$/s.exec(input.body.trim())?.[1]?.trim();
      if (target && replace) return { candidate: { edits: [{ find: target, replace }], summary: `（演示）按批注改为「${replace.slice(0, 20)}」`, noChange: null } };
      if (target && /删掉|删除|去掉/.test(input.body)) return { candidate: { edits: [{ find: target, replace: "" }], summary: "（演示）按批注删除", noChange: null } };
      return { candidate: { edits: [], summary: "（演示）没有修改", noChange: target ? "（演示 Agent 只懂「改成…」和「删掉」）" : "（演示）在最新版里找不到选中的原文" } };
    } },
    // 时间机器不连模型：进群介绍走线上同样的兜底说明，不用测试里的假话术。
    threadIntroAgent: { async generate() { throw new Error("时间机器没有连接模型"); } },
    // 时间机器没有模型：「重新生成草案」用一份演示草案替换，好看到覆盖改动与核对的效果（失败路径由自动测试覆盖）。
    monthlyDraftAgent: { async generate() {
      await new Promise((resolve) => setTimeout(resolve, 3000));
      return { candidate: {
        companyOutcome: "（重新生成）验证从本月目标到个人承诺、执行事项的完整路径，月底能说清每个战场的进展依据。",
        battlefields: [
          { battlefieldId: "growth", outcome: goalText },
          { battlefieldId: "supporting", outcome: "把跨人员交接与成功证据整理成可共同核对的清单，并完成一次非当事人回看。" },
          { battlefieldId: "product", outcome: "完成 CEO 与 DRI 双视角走查，按人核对四张任务卡与讨论意见。" },
        ],
        capabilities: [],
        todos: [],
      } };
    } },
    // 月末复盘：时间机器没有模型，三个 Agent 都给演示内容（等两三秒，好看到「正在起草 / 评估 / 汇总」）。
    monthlyReviewAgents: {
      // 个人复盘：开启复盘时自动起草（演示内容按本人 Mission 标题拼出来）；上传材料后「按材料重新起草」也走这里。
      personal: { async generate(input) {
        await new Promise((resolve) => setTimeout(resolve, 2500));
        const titles = (input.missions as { title: string }[]).map((mission) => mission.title);
        const material = input.attachments.length + input.messages.length ? `参考了你上传的 ${input.attachments.length + input.messages.length} 份材料。` : "缺少材料：周复盘与验收记录，请补充。";
        return { candidate: {
          overall: { text: `（演示起草）本月 ${titles.length} 个 Mission：${titles.join("；") || "无"}。其中一项按期完成，其余部分达成。${material}`, sources: titles.length ? ["本月 Mission"] : [] },
          judgments: { text: "1. 结果：核心路径跑通，但真实使用证据不足。证据：执行事项进展两条。判断：瓶颈在真实用户接入，不在功能。", sources: [] },
          nextFocus: { text: "1. 下月把真实使用作为主要验收证据。", sources: [] },
          escalations: { text: "", sources: [] },
        } };
      } },
      draft: { async generate(input) {
        await new Promise((resolve) => setTimeout(resolve, 2500));
        const goal = input.target ? `本月目标是「${input.target.slice(0, 40)}…」` : "本月没有签发的目标";
        return { candidate: {
          overall: { text: `${goal}。（演示起草）已完成两个真实场景的走查，第三个场景没有按期完成。`, sources: input.target ? ["本月目标"] : [] },
          judgments: { text: "1. 两个场景完成走查，但第三个场景延期；成功证据缺少非当事人回看。缺少材料：延期原因记录，请负责人补充。", sources: [] },
          nextFocus: { text: "1. 补齐第三个场景与非当事人回看的证据。", sources: [] },
          escalations: { text: "", sources: [] },
        } };
      } },
      assess: { async generate(input) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        return { candidate: {
          overall: `${input.subject.name}的自评基本如实，达成情况略偏乐观。（演示评估）`,
          deviations: [{ point: "“已完成两个场景”缺少对应的验收记录", evidence: "本月反馈里只记录了一个场景的走查" }],
          questions: ["第三个场景延期的具体原因是什么？", "非当事人回看准备找谁？"],
        } };
      } },
      summarize: { async generate(input) {
        await new Promise((resolve) => setTimeout(resolve, 3000));
        const names = input.items.map((item) => item.subjectName).join("、");
        return { candidate: {
          overall: `（演示汇总）${names} 都完成了复盘，两个场景完成走查，交付证据仍需补齐。`,
          judgments: [
            { title: "整体进度", body: `（演示汇总）${names} 都完成了复盘，主线推进符合预期。` },
            { title: "灯塔项目", body: "两个场景跑通，第三个场景延期，下月补齐。" },
            { title: "交接与证据", body: "交接清单已有初版，但缺少非当事人回看，证据还不完整。" },
            { title: "能力建设", body: "方法和 Agent 能力在真实场景里用上了，还没有沉淀成可复用的模板。" },
            { title: "组织", body: "负责人自评普遍偏乐观，下月复盘要求附上验收记录。" },
          ],
          nextFocus: ["补齐交付证据与非当事人回看", "把方法沉淀为可复用模板"],
          ltcoSuggestion: { change: false, proposedLtco: input.ltco || "（未填写 LTCO）", rationale: "战略方向没有变化，本月的偏差是执行层面的，不需要修订 LTCO。", units: [] },
        } };
      } },
    },
  });
  await app.sql("UPDATE battlefield_config SET code='01',name='灯塔项目',owner_id=$1,six_month_outcome='以真实战略工作验证可复用的交付方式，形成持续运行的 CEO 与 DRI 工作闭环。' WHERE id='growth'", ["browser-dri"]);
  for (const [id, code, name, order] of [["supporting", "02", "团队协作", 2], ["private-field", "09", "不可见的验收战场", 9]] as const) {
    await app.sql("INSERT INTO battlefield_config (id,version,code,name,owner_id,six_month_outcome,sort_order) VALUES ($1,1,$2,$3,$4,'建立可复用的协作方式，完成从讨论到交付的闭环。',$5)", [id, code, name, TEST_CEO.personId, order]);
  }
  await app.sql("INSERT INTO battlefield_config (id,version,code,name,owner_id,six_month_outcome,sort_order) VALUES ('product',1,'03','产品战场',$1,'验证 CEO 与 DRI 共用身份时的产品工作闭环，形成可复核的界面与权限证据。',3)", [LUYAO.personId]);
  for (const [code, name] of [["03", "Method"], ["04", "Agents"], ["05", "E&O"]]) {
    await app.sql("INSERT INTO capability_config (id,version,code,name,six_month_outcome) VALUES ($1,1,$2,$3,'形成可复用的能力成果')", [`cap-${code}`, code, name]);
  }
  // 月末复盘：Method 能力域交给孙铭泽（browsermember），好测成员提交复盘；其余能力域待指派，由 CEO 代复盘。
  await app.sql("UPDATE capability_config SET owner_id='sun-mingze' WHERE id='cap-03'");
  const planId = randomUUID();
  let luyaoTasks: Record<string,string> | undefined;
  const goalText = "让灯塔项目在真实 CEO 与 DRI 的日常战略工作中持续运行，完成从每月目标、个人承诺、执行事项到复盘的完整闭环；形成可复用的验收标准、跨人员交接清单和问题归因记录，确保关键界面的信息层级与反馈一致，并以不少于三组真实场景核对用户能否找到正在推进的事、理解自己的贡献和继续下一步。保留需要人工判断的边界，月底形成可核对的部署就绪结论。";
  async function projectAs(loginId: string, url: string) {
    const login = await app!.app.inject({ method: "POST", url: "/api/auth/login", headers: { origin: testEnv.publicOrigin }, payload: { loginId, passcode: "8742" } });
    if (login.statusCode !== 200) throw new Error(`Synthetic login failed: ${login.statusCode}`);
    const cookie = String(login.headers["set-cookie"]).split(";")[0];
    const headers = { cookie, origin: testEnv.publicOrigin };
    const response = await app!.app.inject({ method: "GET", url, headers });
    if (response.statusCode !== 200) throw new Error(`Fixture projection failed: ${url} ${response.statusCode}`);
    return { value: response.json(), headers };
  }
  async function setPlanStage(stage: "none" | "negotiating" | "issued") {
    const [{ count }] = await app!.sql("SELECT count(*)::int AS count FROM mission_rounds WHERE battlefield_id='growth'");
    if (count !== 0) throw new Error("Target-state fixtures may only change before drafting a round; start a fresh fixture for more target states");
    if (luyaoTasks) { await clearWangLuyao(app!, luyaoTasks); luyaoTasks = undefined; }
    await app!.sql("DELETE FROM monthly_plans WHERE id=$1", [planId]);
    if (stage !== "none") {
      await app!.sql(`INSERT INTO monthly_plans (id,version,period,status,company_outcome,battlefields,todos,negotiation,generation)
        VALUES ($1,1,'2026-10','negotiating','验证从本月目标到个人承诺的完整路径',$2::jsonb,'[]',
        '{"edits":[],"checkedItemIds":["company","battlefield:growth","battlefield:supporting","battlefield:product"],"feedback":[],"note":"隔离验收已核对目标"}',
        '{"status":"ready","pendingSince":null,"runId":null,"previousRunIds":[],"error":null,"generatedAt":"2026-10-01T00:00:00.000Z"}')`,
        [planId, JSON.stringify([{ battlefieldId: "growth", outcome: goalText }, { battlefieldId: "supporting", outcome: "把跨人员交接与成功证据整理成可共同核对的清单。" },
          { battlefieldId: "product", outcome: "完成 CEO 与 DRI 双视角走查，按人核对四张任务卡与五条讨论意见。" }])]);
    }
    if (stage === "issued") {
      const { value, headers } = await projectAs("browserceo", `/api/cards/monthly-plans/${planId}`);
      const sign = value.cards[0].actions.find((action: { actionType: string }) => action.actionType === "monthly-plan.sign");
      if (!sign) throw new Error("Fixture plan cannot be signed");
      const result = await app!.app.inject({ method: "POST", url: "/api/actions/execute", headers, payload: { actionId: sign.actionId, input: {} } });
      if (result.statusCode !== 200) throw new Error(`Fixture plan signing failed: ${result.statusCode}`);
      luyaoTasks = (await seedWangLuyao(app!,planId,appNow(),"8742",TEST_CEO.personId)).tasks;
    }
    metadata = { ...metadata, planStage: stage, planSigned: stage === "issued" };
    await writeJson(metadataFile, metadata);
    return { planStage: stage, planId };
  }

  // Synthetic browser accounts exist exclusively in this disposable database.
  for (const [personId, loginId] of [[TEST_CEO.personId, "browserceo"], ["sun-mingze", "browsermember"], ["browser-dri", "browserdri"], ["browser-no-card", "browsernocard"], ["browser-empty", "browserempty"]]) {
    await setMemberAccess(async (sql, params) => ({ rows: await app!.sql(sql, params), rowCount: 1, command: "", oid: 0, fields: [] }), { personId, loginId, passcode: "8742", mustChange: false });
    await app.sql("INSERT INTO person_onboarding (person_id,completed_at) VALUES ($1,$2) ON CONFLICT DO NOTHING", [personId, appNow()]);
  }
  // Unattached Missions represent existing registration. They grant participation, never a card.
  for (const [personId, fieldId, title] of [["sun-mingze", "supporting", "把 DRI 的交接场景落到一致的界面反馈"], ["browser-no-card", "supporting", "核对协作交接的成功证据"]]) {
    const id = `browser03-${personId}`;
    await app.sql(`INSERT INTO missions (id,version,code,period,title,owner_id,capability_id,battlefield_ids,outcome,source_ref,source_document_id,source_revision,source_title)
      VALUES ($1,1,$1,'2026-10',$2,$3,'method',$4::jsonb,'形成可核对的协作清单','fixture://03','browser03',1,'隔离演练的登记资料')`, [id, title, personId, JSON.stringify(personId === "sun-mingze" ? ["growth", fieldId] : [fieldId])]);
  }
  for (const [personId, title, status] of [["sun-mingze", "核对 DRI 首页的目标与任务卡入口", "in_progress"], ["sun-mingze", "补齐灯塔项目的端到端验收记录", "not_started"], ["sun-mingze", "同步任务卡阅读与反馈口径", "done"], ["browser-dri", "核对本月跨人员交接与承诺", "in_progress"], ["browser-no-card", "整理本周交接中的待确认点", "not_started"]]) {
    const id = randomUUID();
    await app.sql("INSERT INTO tasks (id,title,status,owner_id,created_by,due_date) VALUES ($1,$2,$3,$4,'meeting','2026-10-07')", [id, title, status, personId]);
    await app.sql("INSERT INTO task_members (task_id,person_id,role,added_by) VALUES ($1,$2,'owner','meeting')", [id, personId]);
  }
  // TM_PLAN_STAGE=negotiating：停在未签发，好在界面上亲手签发（签发后系统自动起草，见 ADR-0026）。
  const initialStage = process.env.TM_PLAN_STAGE === "negotiating" ? "negotiating" : "issued";
  await setPlanStage(initialStage);
  async function roundAction(actionType: string, input: Record<string, unknown> = {}) {
    const { value, headers } = await projectAs("browserceo", "/api/cards/home");
    const round = value.cards.find((card: { kind: string; objectRef?: { type?: string }; payload?: { battlefieldId?: string } }) => card.kind === "mission-round" && card.objectRef?.type === (actionType === "draft" ? "mission-round-slot" : "mission-round") && card.payload?.battlefieldId === "growth");
    if (!round) throw new Error(`No round projection for ${actionType}`);
    const action = round.actions.find((entry: { actionType: string }) => entry.actionType === `mission-round.${actionType}`);
    if (!action) throw new Error(`No allowed ${actionType} action (pending review decisions must be handled in the UI)`);
    const result = await app!.app.inject({ method: "POST", url: "/api/mission-rounds/actions/execute", headers, payload: { actionId: action.actionId, input } });
    if (result.statusCode !== 200) throw new Error(`Round ${actionType} failed: ${result.statusCode} ${result.body.slice(0, 250)}`);
    return { action: actionType, ...await inspect() };
  }
  const [{ database }] = await app.sql("SELECT current_database() AS database");
  if (typeof database !== "string" || !/^warmap_test_[a-f0-9]{12}$/.test(database)) throw new Error("Unexpected database");
  // Resolve the already-installed API dependency; no package installation or workspace changes.
  const { Pool } = createRequire(new URL("../../apps/api/package.json", import.meta.url))("pg");
  const commandPool = new Pool({ connectionString: testDatabaseUrl.replace(/\/postgres$/, `/${database}`), max: 2 });
  closeCommandPool = () => commandPool.end();
  closeTimer = setInterval(() => { void closeDueRounds(commandPool, appNow).catch(() => report({ closeFailed: true })); }, 60_000);
  const stopped = new Promise<void>((done) => { settled = done; });
  const stop = () => { void close().catch(() => { process.exitCode = 1; }).finally(() => settled?.()); };
  process.once("SIGINT", stop); process.once("SIGTERM", stop);
  await app.app.listen({ port: API_PORT, host: "127.0.0.1" });
  metadata = { fixtureId, ready: true, port: API_PORT, webPort: WEB_PORT, pid: process.pid, database, fixtureDirectory: fixtureDir,
    now: now.toISOString(), planStage: initialStage, planSigned: initialStage === "issued", rounds: 0, memberId: "sun-mingze", driId: "browser-dri", noCardId: "browser-no-card", emptyId: "browser-empty", planId, lanOrigins };
  await writeJson(metadataFile, metadata);
  /** 时间机器没有模型：用 Agent 同一个修改函数，按上传者的要求改最近一份 Markdown，好看到修改标注和群里的说明。 */
  async function simulateMaterialEdit() {
    const { editObjectMaterial, readObjectMaterial } = await import("../../apps/api/src/objectMaterials.js");
    const [row] = await app!.sql("SELECT id::text, object_type, object_id, owner_id, format FROM object_materials WHERE format IN ('markdown','html') AND deleted_at IS NULL ORDER BY updated_at DESC LIMIT 1");
    if (!row) throw new Error("还没有 Markdown 或 HTML 材料：先在执行事项或议题里上传一份 .md 或 .html");
    const ref = { objectType: row.object_type as "issue" | "task", objectId: row.object_id as string };
    const viewer = { personId: row.owner_id as string, role: (row.owner_id === TEST_CEO.personId ? "ceo" : "member") as "ceo" | "member",
      displayName: (people.people as { personId: string; displayName: string }[]).find((person) => person.personId === row.owner_id)?.displayName ?? (row.owner_id as string) };
    const current = await readObjectMaterial(commandPool.query.bind(commandPool), ref, row.id as string, viewer);
    if (row.format === "html") {
      // HTML：改一段正文、文末（</body> 前）加一节补充。
      const para = current.body.split("\n").find((line) => /<p>[^<]+<\/p>/.test(line) && current.body.split(line).length === 2);
      const htmlEdits = [
        ...(para ? [{ find: para, replace: para.replace(/。?<\/p>/u, "，并写明负责人和完成证据。</p>") }] : []),
        { append: "<section><h2>补充</h2><p>按群里的讨论，每个场景都要写明异常由谁接回。</p></section>" },
      ];
      return editObjectMaterial(commandPool, ref, row.id as string, viewer, current.currentVersion, htmlEdits,
        "按群里的讨论补上负责人和完成证据，文末加一节补充", null);
    }
    const lines = current.body.split("\n");
    const paragraph = lines.find((line) => line.trim() && !/^\s*(#|[-*+]\s|\d+[.)]\s|>|\||```)/.test(line) && current.body.split(line).length === 2);
    const lastItem = [...lines].reverse().find((line) => /^\s*[-*+]\s/.test(line) && current.body.split(line).length === 2);
    const edits = [
      ...(paragraph ? [{ find: paragraph, replace: paragraph.replace(/。?$/u, "，并写明负责人和完成证据。") }] : []),
      ...(lastItem ? [{ find: `\n${lastItem}`, replace: "" }] : []),
      { append: "## 补充\n\n按群里的讨论，每个场景都要写明异常由谁接回。" },
    ];
    return editObjectMaterial(commandPool, ref, row.id as string, viewer, current.currentVersion, edits,
      "按群里的讨论补上负责人和完成证据，删掉一条已定的待确认项，文末加一段补充", null);
  }
  let lastCommandId: string | undefined;
  async function poll() {
    let request: { id?: string; fixtureId?: string; command?: string };
    try { request = JSON.parse(await readFile(commandFile, "utf8")); }
    catch (error) {
      if ((error as { code?: string }).code !== "ENOENT" && !(error instanceof SyntaxError)) report({ commandReadFailed: true });
      if (!shutdown) pollTimer = setTimeout(() => { void poll(); }, 100);
      return;
    }
    if (request.fixtureId === fixtureId && typeof request.id === "string" && request.id !== lastCommandId) {
      lastCommandId = request.id;
      try {
        let result: unknown;
        if (request.command === "close") {
          await close();
          result = { closed: true, database, fixtureDirectory: fixtureDir };
        } else if (request.command === "inspect") result = await inspect();
        else if (request.command === "material-edit") result = await simulateMaterialEdit();
        else if (request.command === "review-open") {
          // 月末复盘平时在月底倒数第 3 天自动开启；时间机器的时钟在月初，这里用 CEO 的「开始复盘」动作提前开启当月复盘。
          const period = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit" }).format(appNow()).slice(0, 7);
          const { value, headers } = await projectAs("browserceo", `/api/monthly-reviews/${period}`);
          const open = value.actions.find((entry: { actionType: string }) => entry.actionType === "monthly-review.open");
          if (!open) throw new Error(`${period} 的复盘已经开启`);
          const opened = await app!.app.inject({ method: "POST", url: "/api/monthly-reviews/actions/execute", headers, payload: { actionId: open.actionId } });
          if (opened.statusCode !== 200) throw new Error(`开启复盘失败：${opened.statusCode} ${opened.body.slice(0, 200)}`);
          result = { reviewOpened: period, href: `/reviews/${period}` };
        }
        else if (request.command === "target-none") result = await setPlanStage("none");
        else if (request.command === "target-negotiating") result = await setPlanStage("negotiating");
        else if (request.command === "target-issued") result = await setPlanStage("issued");
        else if (["draft", "open", "reopen"].includes(request.command ?? "")) result = await roundAction(request.command!);
        else if (request.command === "confirm") result = await roundAction("confirm", { note: "隔离浏览器演练：已核对跨人员的交接时间、依赖边界与成功证据。" });
        else if (request.command === "confirm-all") {
          // Draft → open → deadline snapshot → confirm through the formal actions; no feedback, so Review has nothing pending.
          await roundAction("draft"); await roundAction("open");
          const [{ deadline }] = await app!.sql("SELECT max(closes_at) AS deadline FROM mission_rounds WHERE status='open'");
          now = new Date(new Date(deadline as string | Date).getTime()); clockAnchor = Date.now();
          await closeDueRounds(commandPool, appNow);
          result = await roundAction("confirm", { note: "隔离浏览器演练：已核对跨人员的交接时间、依赖边界与成功证据。" });
          metadata = { ...metadata, now: now.toISOString() }; await writeJson(metadataFile, metadata);
        }
        else if (request.command === "next-month") {
          // 上海 11 月 1 日 10:00：10 月的卡月份已过，只读。
          now = new Date("2026-11-01T02:00:00.000Z"); clockAnchor = Date.now();
          metadata = { ...metadata, now: now.toISOString() }; await writeJson(metadataFile, metadata);
          result = await inspect();
        }
        else if (request.command === "welcome-member" || request.command === "welcome-dri" || request.command === "welcome-ceo" || request.command === "welcome-luyao") {
          const personId = request.command === "welcome-member" ? "sun-mingze" : request.command === "welcome-dri" ? "browser-dri" : request.command === "welcome-luyao" ? LUYAO.personId : TEST_CEO.personId;
          await app!.sql("DELETE FROM person_onboarding WHERE person_id=$1", [personId]);
          result = { onboardingReset: request.command };
        }
        else if (request.command === "advance" || request.command === "near") {
          const [{ deadline }] = await app!.sql("SELECT max(closes_at) AS deadline FROM mission_rounds WHERE status='open'");
          const previousNow = now.getTime();
          if (deadline) now = new Date(Math.max(appNow().getTime(), new Date(deadline as string | Date).getTime() - (request.command === "near" ? 65_000 : 0)));
          clockAnchor = Date.now();
          const closed = await closeDueRounds(commandPool, appNow);
          metadata = { ...metadata, now: now.toISOString() };
          await writeJson(metadataFile, metadata);
          result = { clockAdvanced: now.getTime() > previousNow, applicationClockChanged: now.getTime() !== previousNow, closed, ...await inspect() };
        } else throw new Error("Unknown fixture command");
        await writeJson(responseFile, { id: request.id, fixtureId, command: request.command, ok: true, result });
      } catch (error) {
        await writeJson(responseFile, { id: request.id, fixtureId, command: request.command, ok: false,
          reason: error instanceof Error ? error.message : "Fixture command failed" });
      }
      if (request.command === "close") { settled?.(); return; }
    }
    if (!shutdown) pollTimer = setTimeout(() => { void poll(); }, 100);
  }
  report(metadata);
  void poll();
  await stopped;
}
void main().catch(async (error) => { report({ fixtureFailed: true, reason: error instanceof Error ? error.message : "fixture failure" }); process.exitCode = 1; await close(); settled?.(); });


