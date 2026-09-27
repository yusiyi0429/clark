/** 02 个人雷达的一次性联调夹具：API 4500 / Web 3500，只用 54329 的一次性测试库。
 * 真实外部调用只发生在成员触发扫描时（博查 + 轻模型）；其余命令不碰外部服务。
 * 只从 apps/api/.env 读 BOCHA_API_KEY、PI_BASE_URL、PI_API_KEY、LIGHT_MODEL 四个键进本进程，不打印、不落盘；
 * 不读 LangSmith 等其他配置，因此判定过程不会上报 trace。
 * 控制：node radar-control.cjs inspect|seed-signals|run-state <queued|failed|completed-empty>|welcome <member|ceo>|close
 */
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rename, rm, rmdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { TestApp } from "../../../../apps/api/test/helpers.js";
import type { PersonalRadarService } from "../../../../apps/api/src/personalRadar.js";

const testDatabaseUrl = "postgres://postgres:postgres@localhost:54329/postgres";
process.env.TEST_PG_URL = testDatabaseUrl;
const root = fileURLToPath(new URL("../../../../", import.meta.url));
const evidenceDir = fileURLToPath(new URL("./", import.meta.url));
const commandFile = join(evidenceDir, "radar-command.json");
const responseFile = join(evidenceDir, "radar-response.json");
const metadataFile = join(evidenceDir, "radar-fixture.json");
const fixtureId = randomUUID();

async function writeJson(path: string, value: unknown) {
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`);
  await rename(temporary, path);
}

/** 只取扫描要用的四个键；值不出这个进程。 */
async function loadScanKeys(): Promise<boolean> {
  const wanted = new Set(["BOCHA_API_KEY", "PI_BASE_URL", "PI_API_KEY", "LIGHT_MODEL"]);
  const text = await readFile(join(root, "apps/api/.env"), "utf8").catch(() => "");
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (!match || !wanted.has(match[1])) continue;
    process.env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, "$2");
  }
  return [...wanted].every((key) => Boolean(process.env[key]));
}

let app: TestApp | undefined;
let fixtureDir: string | undefined;
let closePool: (() => Promise<void>) | undefined;
let pollTimer: ReturnType<typeof setTimeout> | undefined;
let shutdown: Promise<void> | undefined;
let metadata: Record<string, unknown> = { fixtureId, pid: process.pid, ready: false };
let inner: PersonalRadarService | undefined;

function close() {
  shutdown ??= (async () => {
    if (pollTimer) clearTimeout(pollTimer);
    try {
      await inner?.idle();
      await closePool?.();
      await app?.close();
    } finally {
      if (fixtureDir) {
        await rm(join(fixtureDir, "people.json"), { force: true });
        await rmdir(fixtureDir).catch(() => undefined);
      }
    }
    metadata = { ...metadata, ready: false, closed: true };
    await writeJson(metadataFile, metadata);
  })();
  return shutdown;
}

async function main() {
  const scanKeys = await loadScanKeys();
  const { createTestApp, testEnv, TEST_CEO } = await import("../../../../apps/api/test/helpers.js");
  const { setMemberAccess } = await import("../../../../apps/api/src/memberAccess.js");
  const { createPersonalRadarService } = await import("../../../../apps/api/src/personalRadar.js");
  const { createPersonalRadarJudge } = await import("../../../../apps/api/src/personalRadarAgent.js");
  const { createBochaWebSearchAdapter } = await import("../../../../apps/api/src/webSearch.js");
  const { createBochaRadarWebAdapter } = await import("../../../../apps/api/src/radarSources.js");
  const { createOutletFeedAdapter } = await import("../../../../apps/api/src/outletSources.js");
  testEnv.publicOrigin = "http://localhost:3500";
  fixtureDir = await mkdtemp(join(tmpdir(), "warmap-02-radar-"));
  const people = JSON.parse(await readFile(join(root, "apps/api/test/fixtures/company-people.json"), "utf8"));
  people.people[0].displayName = "验收 CEO";
  for (const [personId, displayName] of [["sun-mingze", "孙铭泽"], ["browser-new", "林知行"]]) people.people.push({ personId, displayName, roles: ["dri"] });
  const peopleFile = join(fixtureDir, "people.json");
  await writeFile(peopleFile, JSON.stringify(people));

  // 先注入转发壳，app 建好、拿到库名后再接真实扫描服务
  const personalRadarService: PersonalRadarService = {
    providerStatus: { webSearch: scanKeys },
    enqueue: (personId, trigger) => inner?.enqueue(personId, trigger),
    runScheduled: async () => { await inner?.runScheduled(); },
    recoverStaleRuns: async () => { await inner?.recoverStaleRuns(); },
    idle: async () => { await inner?.idle(); },
  };
  app = await createTestApp({ companyPeopleSeed: peopleFile, companyName: "天枢（02 隔离验收）" }, undefined, { personalRadarService });
  const [{ database }] = await app.sql("SELECT current_database() AS database");
  if (typeof database !== "string" || !/^warmap_test_[a-f0-9]{12}$/.test(database)) throw new Error("Unexpected database");
  const { Pool } = createRequire(new URL("../../../../apps/api/package.json", import.meta.url))("pg");
  const pool = new Pool({ connectionString: testDatabaseUrl.replace(/\/postgres$/, `/${database}`), max: 3 });
  closePool = () => pool.end();
  inner = createPersonalRadarService({
    pool,
    companyMemory: { searchPeople: () => people.people },
    web: createBochaRadarWebAdapter(createBochaWebSearchAdapter({ apiKey: scanKeys ? process.env.BOCHA_API_KEY : undefined })),
    outlets: createOutletFeedAdapter({}),
    judge: createPersonalRadarJudge({
      query: pool.query.bind(pool),
      baseUrl: process.env.PI_BASE_URL ?? "http://127.0.0.1:9/unconfigured",
      apiKey: process.env.PI_API_KEY ?? "unconfigured",
      modelId: process.env.LIGHT_MODEL ?? "unconfigured",
    }),
  });

  // 组织资料：两个战场、三个能力、已签发的本月计划、孙铭泽的两条 Mission 与三件执行事项
  const period = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit" }).format(new Date()).slice(0, 7);
  await app.sql("UPDATE battlefield_config SET code='01',name='灯塔项目',six_month_outcome='以真实战略工作验证可复用的交付方式，形成持续运行的 CEO 与 DRI 工作闭环。' WHERE id='growth'");
  await app.sql("INSERT INTO battlefield_config (id,version,code,name,owner_id,six_month_outcome,sort_order) VALUES ('supporting',1,'02','团队协作',$1,'建立可复用的协作方式，完成从讨论到交付的闭环。',2)", [TEST_CEO.personId]);
  for (const [code, name] of [["03", "Method"], ["04", "Agents"], ["05", "E&O"]]) {
    await app.sql("INSERT INTO capability_config (id,version,code,name,six_month_outcome) VALUES ($1,1,$2,$3,'形成可复用的能力成果') ON CONFLICT DO NOTHING", [`cap-${code}`, code, name]);
  }
  await app.sql(`INSERT INTO monthly_plans (id,version,period,status,company_outcome,battlefields,todos,negotiation,generation,confirmed_at)
    VALUES ($1,1,$2,'confirmed','验证从本月目标到个人承诺的完整路径',$3::jsonb,'[]','{"edits":[],"checkedItemIds":[],"feedback":[],"note":""}',
    '{"status":"ready","pendingSince":null,"runId":null,"previousRunIds":[],"error":null,"generatedAt":null}',now())`,
    [randomUUID(), period, JSON.stringify([{ battlefieldId: "growth", outcome: "让 AI Agent 产品在真实 CEO 与 DRI 的日常工作中持续运行。" }, { battlefieldId: "supporting", outcome: "把跨人员交接与成功证据整理成可共同核对的清单。" }])]);
  for (const [id, title, fields, capability] of [
    ["radar02-agent-ux", "AI Agent 产品的交互设计，形成可复用的设计规范", ["growth"], "cap-04"],
    ["radar02-handoff", "把 DRI 的交接场景落到一致的界面反馈", ["supporting"], "cap-03"],
  ] as const) {
    await app.sql(`INSERT INTO missions (id,version,code,period,title,owner_id,capability_id,battlefield_ids,outcome,source_ref,source_document_id,source_revision,source_title)
      VALUES ($1,1,$1,$2,$3,'sun-mingze',$4,$5::jsonb,'形成可核对的成果','fixture://02','radar02',1,'隔离验收的登记资料')`, [id, period, title, capability, JSON.stringify(fields)]);
  }
  for (const [title, status] of [["核对雷达设置的读法说明", "in_progress"], ["补齐个人信号阅读页的验收记录", "not_started"]]) {
    const id = randomUUID();
    await app.sql("INSERT INTO tasks (id,title,status,owner_id,created_by,due_date) VALUES ($1,$2,$3,'sun-mingze','meeting',current_date + 7)", [id, title, status]);
    await app.sql("INSERT INTO task_members (task_id,person_id,role,added_by) VALUES ($1,'sun-mingze','owner','meeting')", [id]);
  }
  // 合成身份只存在于这个一次性库；browsernew 没看过引导，用来走引导第 3 步
  const query = async (sql: string, params?: unknown[]) => ({ rows: await app!.sql(sql, params), rowCount: 1, command: "", oid: 0, fields: [] });
  for (const [personId, loginId, onboarded] of [[TEST_CEO.personId, "browserceo", true], ["sun-mingze", "browsermember", true], ["browser-new", "browsernew", false]] as const) {
    await setMemberAccess(query, { personId, loginId, passcode: "8742", mustChange: false });
    if (onboarded) await app.sql("INSERT INTO person_onboarding (person_id,completed_at) VALUES ($1,now()) ON CONFLICT DO NOTHING", [personId]);
  }

  async function inspect() {
    const radar = await app!.sql("SELECT person_id, enabled, directions, sources, updated_at, last_scan_day::text, last_run FROM person_radar ORDER BY person_id");
    const signals = await app!.sql(`SELECT person_id, source_type, source_title, source_url, direction_text, summary, reason, relevance,
      read_at IS NOT NULL AS read, saved_at IS NOT NULL AS saved, dismissed_at IS NOT NULL AS dismissed, collected_at FROM person_radar_signals ORDER BY collected_at DESC`);
    const [company] = await app!.sql(`SELECT (SELECT count(*)::int FROM signals) AS signals, (SELECT count(*)::int FROM issues) AS issues,
      (SELECT count(*)::int FROM agent_runs WHERE kind='personal-radar-assess') AS judge_runs, anchors, sources FROM radar_config WHERE id='default'`);
    return { inspect: true, fixtureId, database, radar, signals, company };
  }

  async function seedSignals() {
    const now = Date.now();
    const rows = [
      { type: "outlet", ref: { type: "outlet", provider: "publisher-feed", outletId: "qbitai", outletName: "量子位" }, title: "Agent 产品开始把「可打断」做成默认交互", url: "https://www.qbitai.com/2026/09/radar02-agent-interrupt.html", relevance: 5, hours: 3, summary: "Agent 产品把可打断做成默认交互", reason: "直接回应你关注的 AI Agent 产品交互：讲清了让人随时接管的界面做法。" },
      { type: "web", ref: { type: "web-search", provider: "bocha", query: "AI Agent 产品的交互设计" }, title: "三家团队如何为 Agent 设计进度与确认", url: "https://example-design-notes.cn/agent-progress", relevance: 4, hours: 9, summary: "三家团队的 Agent 进度与确认设计", reason: "给出了进度提示和确认节点的对比，可用于你的设计规范。" },
      { type: "outlet", ref: { type: "outlet", provider: "publisher-feed", outletId: "theinformation", outletName: "The Information" }, title: "Why AI agent startups are rethinking onboarding", url: "https://www.theinformation.com/articles/radar02-agent-onboarding", relevance: 4, hours: 20, summary: "Agent 创业公司重做首次引导", reason: "讲首次引导如何建立信任，和你的交接场景设计相关。" },
      { type: "web", ref: { type: "web-search", provider: "bocha", query: "DRI 交接" }, title: "跨团队交接清单的五个常见缺口", url: "https://example-ops-weekly.cn/handoff-gaps", relevance: 3, hours: 30, summary: "跨团队交接清单的常见缺口", reason: "对照你在做的交接场景，列出了容易漏掉的核对项。" },
      { type: "outlet", ref: { type: "outlet", provider: "publisher-feed", outletId: "ft", outletName: "金融时报" }, title: "Companies test AI agents for internal operations", url: "https://www.ft.com/content/radar02-agents-operations", relevance: 3, hours: 40, summary: "企业在内部运营中试用 AI Agent", reason: "提供了企业内部落地 Agent 的现状，可作为设计取舍的背景。" },
    ];
    for (const row of rows) {
      const excerpt = `${row.title}。隔离验收用的合成原文：${row.reason}（这不是真实报道。）`;
      await app!.sql(`INSERT INTO person_radar_signals (id,person_id,source_type,source_fingerprint,source_title,source_url,published_at,excerpt,source_ref,
        direction_id,direction_text,summary,reason,evidence_quote,relevance,collected_at)
        VALUES ($1,'sun-mingze',$2,$3,$4,$5,$6,$7,$8::jsonb,'d_seeded000000',$9,$10,$11,$12,$13,$14) ON CONFLICT DO NOTHING`,
        [randomUUID(), row.type, randomUUID().replace(/-/g, "").padEnd(64, "0").slice(0, 64), row.title, row.url, new Date(now - (row.hours + 1) * 3_600_000),
          excerpt, JSON.stringify(row.ref), row.ref.type === "outlet" ? "AI Agent 产品的交互设计" : row.ref.query, row.summary, row.reason, row.title, row.relevance, new Date(now - row.hours * 3_600_000)]);
    }
    return inspect();
  }

  async function runState(state: string) {
    const at = new Date().toISOString();
    const run = state === "queued" ? { trigger: "manual", status: "queued", queuedAt: at, createdSignals: 0, warnings: [] }
      : state === "failed" ? { trigger: "scheduled", status: "failed", queuedAt: at, startedAt: at, completedAt: at, createdSignals: 0, warnings: ["全网检索「AI Agent 产品的交互设计」失败：博查返回 HTTP 503"] }
      : { trigger: "scheduled", status: "completed", queuedAt: at, startedAt: at, completedAt: at, createdSignals: 0, warnings: ["48 小时内没有新条目"] };
    await app!.sql("UPDATE person_radar SET last_run=$1::jsonb WHERE person_id='sun-mingze'", [JSON.stringify(run)]);
    return inspect();
  }

  async function welcome(who: string) {
    const personId = who === "ceo" ? TEST_CEO.personId : who === "member" ? "sun-mingze" : "browser-new";
    await app!.sql("DELETE FROM person_onboarding WHERE person_id=$1", [personId]);
    return { welcome: personId };
  }

  await app.app.listen({ port: 4500, host: "127.0.0.1" });
  metadata = { fixtureId, ready: true, port: 4500, webPort: 3500, pid: process.pid, database, fixtureDirectory: fixtureDir, period, realScan: scanKeys };
  await writeJson(metadataFile, metadata);

  let lastCommandId: string | undefined;
  async function poll() {
    let request: { id?: string; fixtureId?: string; command?: string; arg?: string } | undefined;
    try { request = JSON.parse(await readFile(commandFile, "utf8")); } catch { request = undefined; }
    if (request?.id && request.id !== lastCommandId && request.fixtureId === fixtureId) {
      lastCommandId = request.id;
      let response: Record<string, unknown>;
      try {
        const result = request.command === "inspect" ? await inspect()
          : request.command === "seed-signals" ? await seedSignals()
          : request.command === "run-state" ? await runState(request.arg ?? "")
          : request.command === "welcome" ? await welcome(request.arg ?? "")
          : request.command === "close" ? (await close(), { closed: true, database })
          : (() => { throw new Error(`Unknown command ${request!.command}`); })();
        response = { id: request.id, fixtureId, command: request.command, ok: true, result };
      } catch (error) {
        response = { id: request.id, fixtureId, command: request.command, ok: false, error: (error as Error).message };
      }
      await writeJson(responseFile, response);
      if (request.command === "close") process.exit(0);
    }
    pollTimer = setTimeout(() => void poll(), 200);
  }
  void poll();
}

main().catch(async (error) => {
  await writeJson(metadataFile, { ...metadata, ready: false, error: (error as Error).message }).catch(() => undefined);
  await close().catch(() => undefined);
  process.exit(1);
});
