/** Disposable 04c browser fixture: Web 3500 / API 4500, public 54329 test database only.
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
let metadata: Record<string, unknown> = { fixtureId, pid: process.pid, ready: false };
async function writeJson(path: string, value: unknown) {
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`);
  await rename(temporary, path);
}
function close() {
  shutdown ??= (async () => {
    if (pollTimer) clearTimeout(pollTimer);
    try {
      await closeCommandPool?.();
      await app?.close();
    } finally {
      if (fixtureDir) {
        const target = resolve(fixtureDir);
        if (!target.startsWith(join(resolve(tmpdir()), "warmap-04c-browser-"))) throw new Error("Unexpected fixture directory");
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
  return { inspect: true, fixtureId, database: metadata.database, now: metadata.now, counts, rounds, cards, feedback, missions, reviews, decisions };
}

async function main() {
  const { createTestApp, testEnv, TEST_CEO } = await import("../../../../apps/api/test/helpers.js");
  const { setMemberAccess } = await import("../../../../apps/api/src/memberAccess.js");
  const { closeDueRounds } = await import("../../../../apps/api/src/missionRounds.js");
  testEnv.publicOrigin = "http://localhost:3500";
  fixtureDir = await mkdtemp(join(tmpdir(), "warmap-04c-browser-"));
  const people = JSON.parse(await readFile(join(root, "apps/api/test/fixtures/company-people.json"), "utf8"));
  people.people[0].displayName = "验收 CEO";
  for (const [personId, displayName] of [["bai-tiantian", "白田田"], ["liu-renhao", "刘人豪"], ["sun-mingze", "孙铭泽"], ["chen-xinan", "陈溪南"], ["yu-siyi", "于斯一"]]) {
    people.people.push({ personId, displayName, roles: ["dri"] });
  }
  const peopleFile = join(fixtureDir, "people.json");
  await writeFile(peopleFile, JSON.stringify(people));
  let now = new Date("2026-10-01T02:00:00.000Z");
  const unavailable = () => { throw new Error("声纹不属于本次浏览器验收"); };
  app = await createTestApp({ companyPeopleSeed: peopleFile, companyName: "天枢（04c 隔离验收）", missionCardDraftsDir: join(root, "seed/placeholders") }, {
    async run(input) {
      const answer = "这是隔离验收中的私人只读回复。公开意见请在事项群组发表；这段私聊不会进入集中 Review。";
      input.emit({ type: "message", delta: answer });
      return { assistantMessage: answer, runtimeEntries: input.runtimeEntries };
    },
  }, {
    monthlyNow: () => new Date(now),
    voiceprintDeps: { configured: () => false, requireConfig: unavailable, toPcm: async () => unavailable(), enroll: async () => unavailable(), update: async () => unavailable(), remove: async () => unavailable(), groupVerify: async () => unavailable() },
  });
  await app.sql("UPDATE battlefield_config SET code='01',name='灯塔项目',owner_id=$1,six_month_outcome='以灯塔项目验证可复用的交付方式' WHERE id='growth'", [TEST_CEO.personId]);
  for (const [code, name] of [["03", "Method"], ["04", "Agents"], ["05", "E&O"]]) {
    await app.sql("INSERT INTO capability_config (id,version,code,name,six_month_outcome) VALUES ($1,1,$2,$3,'形成可复用的能力成果')", [`cap-${code}`, code, name]);
  }
  const planId = randomUUID();
  await app.sql(`INSERT INTO monthly_plans (id,version,period,status,company_outcome,battlefields,todos,negotiation,generation)
    VALUES ($1,1,'2026-10','negotiating','验证从本月目标到个人承诺的完整路径',
    '[{"battlefieldId":"growth","outcome":"核对灯塔项目十月结果，形成每个人可讨论的个人卡草稿"}]','[]',
    '{"edits":[],"checkedItemIds":["company","battlefield:growth"],"feedback":[],"note":"隔离验收已核对目标"}',
    '{"status":"ready","pendingSince":null,"runId":null,"previousRunIds":[],"error":null,"generatedAt":"2026-10-01T00:00:00.000Z"}')`, [planId]);
  const cookie = await app.loginCookie();
  const headers = { cookie, origin: testEnv.publicOrigin };
  const planResponse = await app.app.inject({ method: "GET", url: `/api/cards/monthly-plans/${planId}`, headers });
  if (planResponse.statusCode !== 200) throw new Error("Fixture plan projection failed");
  const sign = planResponse.json().cards[0].actions.find((action: { actionType: string }) => action.actionType === "monthly-plan.sign");
  if (!sign) throw new Error("Fixture plan cannot be signed");
  const signed = await app.app.inject({ method: "POST", url: "/api/actions/execute", headers, payload: { actionId: sign.actionId, input: {} } });
  if (signed.statusCode !== 200) throw new Error("Fixture plan signing failed");

  // Synthetic browser accounts exist exclusively in this disposable database.
  for (const [personId, loginId] of [[TEST_CEO.personId, "browserceo"], ["sun-mingze", "browsermember"]]) {
    await setMemberAccess(async (sql, params) => ({ rows: await app!.sql(sql, params), rowCount: 1, command: "", oid: 0, fields: [] }), { personId, loginId, passcode: "8742", mustChange: false });
    await app.sql("INSERT INTO person_onboarding (person_id,completed_at) VALUES ($1,$2) ON CONFLICT (person_id) DO UPDATE SET completed_at=EXCLUDED.completed_at", [personId, now]);
  }
  const [{ database }] = await app.sql("SELECT current_database() AS database");
  if (typeof database !== "string" || !/^warmap_test_[a-f0-9]{12}$/.test(database)) throw new Error("Unexpected database");
  // Resolve the already-installed API dependency; no package installation or workspace changes.
  const { Pool } = createRequire(new URL("../../../../apps/api/package.json", import.meta.url))("pg");
  const commandPool = new Pool({ connectionString: testDatabaseUrl.replace(/\/postgres$/, `/${database}`), max: 2 });
  closeCommandPool = () => commandPool.end();
  const stopped = new Promise<void>((done) => { settled = done; });
  const stop = () => { void close().catch(() => { process.exitCode = 1; }).finally(() => settled?.()); };
  process.once("SIGINT", stop); process.once("SIGTERM", stop);
  await app.app.listen({ port: 4500, host: "127.0.0.1" });
  metadata = { fixtureId, ready: true, port: 4500, webPort: 3500, pid: process.pid, database, fixtureDirectory: fixtureDir,
    now: now.toISOString(), planSigned: true, rounds: 0, memberId: "sun-mingze" };
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
        else if (request.command === "advance") {
          const [{ deadline }] = await app!.sql("SELECT max(closes_at) AS deadline FROM mission_rounds WHERE status='open'");
          const previousNow = now.getTime();
          if (deadline) now = new Date(Math.max(now.getTime(), new Date(deadline as string | Date).getTime()));
          const closed = await closeDueRounds(commandPool, () => new Date(now));
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

