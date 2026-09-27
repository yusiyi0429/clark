/** Disposable GAP-04 browser fixture (copied from 03, plus confirm-all / next-month): Web 3500 / API 4500, public 54329 test database only.
 * No .env, actual credentials, model calls, external notifications or voiceprint work.
 * browser-control.cjs inspect|advance|close talks through the fixed evidence command files.
 * advance moves this process's application clock to the deadline before making its snapshot.
 */
import { randomUUID } from "node:crypto";
import { lstat, mkdtemp, readFile, readdir, realpath, rename, rm, rmdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { TestApp } from "../../../../apps/api/test/helpers.js";

const testDatabaseUrl = "postgres://postgres:postgres@localhost:54329/postgres";
process.env.TEST_PG_URL = testDatabaseUrl;
const root = fileURLToPath(new URL("../../../../", import.meta.url));
const evidenceDir = fileURLToPath(new URL("./", import.meta.url));
const commandFile = join(evidenceDir, "browser-command.json");
const responseFile = join(evidenceDir, "browser-response.json");
const metadataFile = join(evidenceDir, "browser-fixture.json");
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
        if (!target.startsWith(join(resolve(tmpdir()), "warmap-gap04-browser-"))) throw new Error("Unexpected fixture directory");
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
  const { createTestApp, testEnv, TEST_CEO } = await import("../../../../apps/api/test/helpers.js");
  const { setMemberAccess } = await import("../../../../apps/api/src/memberAccess.js");
  const { closeDueRounds } = await import("../../../../apps/api/src/missionRounds.js");
  testEnv.publicOrigin = "http://localhost:3500";
  fixtureDir = await mkdtemp(join(tmpdir(), "warmap-gap04-browser-"));
  const people = JSON.parse(await readFile(join(root, "apps/api/test/fixtures/company-people.json"), "utf8"));
  people.people[0].displayName = "验收 CEO";
  for (const [personId, displayName] of [["bai-tiantian", "白田田"], ["liu-renhao", "刘人豪"], ["sun-mingze", "孙铭泽"], ["chen-xinan", "陈溪南"], ["yu-siyi", "于斯一"]]) {
    people.people.push({ personId, displayName, roles: ["dri"] });
  }
  for (const [personId, displayName] of [["browser-dri", "林知行"], ["browser-no-card", "何望舒"], ["browser-empty", "顾清和"]]) {
    people.people.push({ personId, displayName, roles: ["dri"] });
  }
  const peopleFile = join(fixtureDir, "people.json");
  await writeFile(peopleFile, JSON.stringify(people));
  let now = new Date("2026-10-01T02:00:00.000Z");
  let clockAnchor = Date.now();
  const appNow = () => new Date(now.getTime() + Date.now() - clockAnchor);
  applicationNow = appNow;
  const unavailable = () => { throw new Error("声纹不属于本次浏览器验收"); };
  app = await createTestApp({ companyPeopleSeed: peopleFile, companyName: "天枢（GAP-04 隔离验收）", missionCardDraftsDir: join(root, "seed/placeholders") }, {
    async run(input) {
      const answer = "这是隔离验收中的私人只读回复。公开意见请在事项群组发表；这段私聊不会进入集中 Review。";
      input.emit({ type: "message", delta: answer });
      return { assistantMessage: answer, runtimeEntries: input.runtimeEntries };
    },
  }, {
    monthlyNow: appNow,
    voiceprintDeps: { configured: () => false, requireConfig: unavailable, toPcm: async () => unavailable(), enroll: async () => unavailable(), update: async () => unavailable(), remove: async () => unavailable(), groupVerify: async () => unavailable() },
  });
  await app.sql("UPDATE battlefield_config SET code='01',name='灯塔项目',owner_id=$1,six_month_outcome='以真实战略工作验证可复用的交付方式，形成持续运行的 CEO 与 DRI 工作闭环。' WHERE id='growth'", ["browser-dri"]);
  for (const [id, code, name, order] of [["supporting", "02", "团队协作", 2], ["private-field", "09", "不可见的验收战场", 9]] as const) {
    await app.sql("INSERT INTO battlefield_config (id,version,code,name,owner_id,six_month_outcome,sort_order) VALUES ($1,1,$2,$3,$4,'建立可复用的协作方式，完成从讨论到交付的闭环。',$5)", [id, code, name, TEST_CEO.personId, order]);
  }
  for (const [code, name] of [["03", "Method"], ["04", "Agents"], ["05", "E&O"]]) {
    await app.sql("INSERT INTO capability_config (id,version,code,name,six_month_outcome) VALUES ($1,1,$2,$3,'形成可复用的能力成果')", [`cap-${code}`, code, name]);
  }
  const planId = randomUUID();
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
    const [{ count }] = await app!.sql("SELECT count(*)::int AS count FROM mission_rounds");
    if (count !== 0) throw new Error("Target-state fixtures may only change before drafting a round; start a fresh fixture for more target states");
    await app!.sql("DELETE FROM monthly_plans WHERE id=$1", [planId]);
    if (stage !== "none") {
      await app!.sql(`INSERT INTO monthly_plans (id,version,period,status,company_outcome,battlefields,todos,negotiation,generation)
        VALUES ($1,1,'2026-10','negotiating','验证从本月目标到个人承诺的完整路径',$2::jsonb,'[]',
        '{"edits":[],"checkedItemIds":["company","battlefield:growth","battlefield:supporting"],"feedback":[],"note":"隔离验收已核对目标"}',
        '{"status":"ready","pendingSince":null,"runId":null,"previousRunIds":[],"error":null,"generatedAt":"2026-10-01T00:00:00.000Z"}')`,
        [planId, JSON.stringify([{ battlefieldId: "growth", outcome: goalText }, { battlefieldId: "supporting", outcome: "把跨人员交接与成功证据整理成可共同核对的清单。" }])]);
    }
    if (stage === "issued") {
      const { value, headers } = await projectAs("browserceo", `/api/cards/monthly-plans/${planId}`);
      const sign = value.cards[0].actions.find((action: { actionType: string }) => action.actionType === "monthly-plan.sign");
      if (!sign) throw new Error("Fixture plan cannot be signed");
      const result = await app!.app.inject({ method: "POST", url: "/api/actions/execute", headers, payload: { actionId: sign.actionId, input: {} } });
      if (result.statusCode !== 200) throw new Error(`Fixture plan signing failed: ${result.statusCode}`);
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
  for (const [personId, title, status] of [["sun-mingze", "核对 DRI 首页的目标与个人卡入口", "in_progress"], ["sun-mingze", "补齐灯塔项目的端到端验收记录", "not_started"], ["sun-mingze", "同步个人卡阅读与反馈口径", "done"], ["browser-dri", "核对本月跨人员交接与承诺", "in_progress"], ["browser-no-card", "整理本周交接中的待确认点", "not_started"]]) {
    const id = randomUUID();
    await app.sql("INSERT INTO tasks (id,title,status,owner_id,created_by,due_date) VALUES ($1,$2,$3,$4,'meeting','2026-10-07')", [id, title, status, personId]);
    await app.sql("INSERT INTO task_members (task_id,person_id,role,added_by) VALUES ($1,$2,'owner','meeting')", [id, personId]);
  }
  await setPlanStage("issued");
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
  const { Pool } = createRequire(new URL("../../../../apps/api/package.json", import.meta.url))("pg");
  const commandPool = new Pool({ connectionString: testDatabaseUrl.replace(/\/postgres$/, `/${database}`), max: 2 });
  closeCommandPool = () => commandPool.end();
  closeTimer = setInterval(() => { void closeDueRounds(commandPool, appNow).catch(() => report({ closeFailed: true })); }, 60_000);
  const stopped = new Promise<void>((done) => { settled = done; });
  const stop = () => { void close().catch(() => { process.exitCode = 1; }).finally(() => settled?.()); };
  process.once("SIGINT", stop); process.once("SIGTERM", stop);
  await app.app.listen({ port: 4500, host: "127.0.0.1" });
  metadata = { fixtureId, ready: true, port: 4500, webPort: 3500, pid: process.pid, database, fixtureDirectory: fixtureDir,
    now: now.toISOString(), planStage: "issued", planSigned: true, rounds: 0, memberId: "sun-mingze", driId: "browser-dri", noCardId: "browser-no-card", emptyId: "browser-empty", planId };
  await writeJson(metadataFile, metadata);
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
        else if (request.command === "welcome-member" || request.command === "welcome-ceo") {
          await app!.sql("DELETE FROM person_onboarding WHERE person_id=$1", [request.command === "welcome-member" ? "sun-mingze" : TEST_CEO.personId]);
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


