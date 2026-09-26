/** Disposable 04a browser fixture: 3500 Web / 4500 API, only the public 54329 test DB.
 * No .env, real credentials, model calls, external notifications or voiceprint work.
 * Send close on stdin to release the server, disposable database and people fixture.
 */
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { TestApp } from "../../../../apps/api/test/helpers.js";

process.env.TEST_PG_URL = "postgres://postgres:postgres@localhost:54329/postgres";
const root = fileURLToPath(new URL("../../../../", import.meta.url));
const output = process.stdout.write.bind(process.stdout);
process.stdout.write = ((_chunk: unknown, encoding?: unknown, callback?: () => void) => {
  if (typeof encoding === "function") encoding(); else callback?.();
  return true;
}) as typeof process.stdout.write;

let app: TestApp | undefined;
let fixtureDir: string | undefined;
let shutdown: Promise<void> | undefined;
let settled: (() => void) | undefined;
function close() {
  shutdown ??= (async () => {
    await app?.close();
    if (fixtureDir) {
      if (!resolve(fixtureDir).startsWith(join(resolve(tmpdir()), "warmap-04a-browser-"))) throw new Error("Unexpected fixture directory");
      await rm(fixtureDir, { recursive: true, force: true });
    }
    process.stdin.pause();
    settled?.();
  })();
  return shutdown;
}

async function main() {
  const { createTestApp, testEnv, TEST_CEO } = await import("../../../../apps/api/test/helpers.js");
  const { setMemberAccess } = await import("../../../../apps/api/src/memberAccess.js");
  testEnv.publicOrigin = "http://localhost:3500";
  fixtureDir = await mkdtemp(join(tmpdir(), "warmap-04a-browser-"));
  const people = JSON.parse(await readFile(join(root, "apps/api/test/fixtures/company-people.json"), "utf8"));
  people.people[0].displayName = "验收 CEO";
  for (const [personId, displayName] of [["bai-tiantian", "白田田"], ["liu-renhao", "刘人豪"], ["sun-mingze", "孙铭泽"], ["chen-xinan", "陈溪南"], ["yu-siyi", "于斯一"]]) {
    people.people.push({ personId, displayName, roles: ["dri"] });
  }
  const peopleFile = join(fixtureDir, "people.json");
  await writeFile(peopleFile, JSON.stringify(people));
  const now = new Date("2026-10-01T02:00:00.000Z");
  const unavailable = () => { throw new Error("声纹不属于本次浏览器验收"); };
  app = await createTestApp({ companyPeopleSeed: peopleFile, companyName: "天枢（04a 隔离验收）", missionCardDraftsDir: join(root, "seed/placeholders") }, undefined, {
    monthlyNow: () => new Date(now),
    voiceprintDeps: { configured: () => false, requireConfig: unavailable, toPcm: async () => unavailable(), enroll: async () => unavailable(), update: async () => unavailable(), remove: async () => unavailable(), groupVerify: async () => unavailable() },
  });
  // Public synthetic browser-only fixture; never reset a real person's access.
  await setMemberAccess(async (sql, params) => ({ rows: await app!.sql(sql, params), rowCount: 1, command: "", oid: 0, fields: [] }), {
    personId: TEST_CEO.personId, loginId: "browserceo", passcode: "8742", mustChange: false,
  });
  await app.sql("INSERT INTO person_onboarding (person_id,completed_at) VALUES ($1,$2)", [TEST_CEO.personId, now]);
  await app.sql("UPDATE battlefield_config SET code='01',name='灯塔项目',owner_id=$1,six_month_outcome='以灯塔项目验证可复用的交付方式' WHERE id='growth'", [TEST_CEO.personId]);
  for (const [code, name] of [["03", "Method"], ["04", "Agents"], ["05", "E&O"]]) {
    await app.sql("INSERT INTO capability_config (id,version,code,name,six_month_outcome) VALUES ($1,1,$2,$3,'形成可复用的能力成果')", [`cap-${code}`, code, name]);
  }
  await app.sql(`INSERT INTO monthly_plans (id,version,period,status,company_outcome,battlefields,todos,negotiation,generation)
    VALUES ($1,1,'2026-10','negotiating','验证从本月目标到个人承诺的完整路径',
    '[{"battlefieldId":"growth","outcome":"核对灯塔项目十月结果，形成每个人可讨论的个人卡草稿"}]','[]',
    '{"edits":[],"checkedItemIds":[],"feedback":[],"note":"浏览器验收计划，请逐项核对后签发"}',
    '{"status":"ready","pendingSince":null,"runId":null,"previousRunIds":[],"error":null,"generatedAt":"2026-10-01T00:00:00.000Z"}')`, [randomUUID()]);
  const [{ database }] = await app.sql("SELECT current_database() AS database");
  if (typeof database !== "string" || !/^warmap_test_[a-f0-9]{12}$/.test(database)) throw new Error("Unexpected database");
  const stopped = new Promise<void>((done) => { settled = done; });
  const stop = () => { void close().catch(() => { process.exitCode = 1; settled?.(); }); };
  process.once("SIGINT", stop); process.once("SIGTERM", stop);
  process.stdin.setEncoding("utf8");
  let pending = "";
  process.stdin.on("data", (chunk: string) => {
    pending += chunk;
    const lines = pending.split(/\r?\n/); pending = lines.pop() ?? "";
    if (lines.some((line) => line.trim() === "close")) stop();
  });
  await app.app.listen({ port: 4500, host: "127.0.0.1" });
  output(`${JSON.stringify({ ready: true, port: 4500, database })}\n`);
  await stopped;
}
void main().catch(async (error) => { output(`${JSON.stringify({ error: error instanceof Error ? error.message : "fixture failure" })}\n`); process.exitCode = 1; await close(); });
