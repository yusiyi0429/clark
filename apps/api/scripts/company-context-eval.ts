/**
 * 本体上下文取用的小评测（真实本体，只读）：`pnpm --filter @warmap/api exec tsx --env-file=<env 文件> scripts/company-context-eval.ts [--out 结果.json]`
 *
 * - 读 TKOS_WORLD_API_URL、TKOS_WORLD_AGENT_TOKEN（或 _FILE）、TKOS_WORLD_INSTANCE（缺省 mvp），**不打印任何凭据**。
 * - 授权文件临时生成：ceo 能读实例配置里的全部域，member 只读 company + agents 两个域（模拟一位 Agents 单元成员）。
 * - 对每条问题跑一次 query_company 同一条读取（createCompanyMemory().read），记：读到哪些对象（ref、标题）、给模型的 JSON 字节数、耗时、
 *   列对象和读对象各发了几次请求。再跑一次 CEO 目标快照（loadWorldSnapshot + read_ontology 的结果）。
 * - 全程只允许 GET；碰到 POST、/context 或 /v1/actions 立刻退出（退出码 2）。
 * - 改前改后各跑一次（改前在旧提交上跑），对比写进 docs/technical/本体上下文取用.md。
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createCompanyMemory, type CompanyEntry } from "../src/company.js";
import { companyProse } from "../src/companyContext.js";
import { companyPeriod } from "../src/monthlyPlans.js";
import { loadWorldInstance, resolveWorldEnv, WorldClient } from "../src/worldClient.js";
import { loadWorldSnapshot, ontologyToolResult } from "../src/worldReader.js";

type Count = { list: number; get: number; other: number };
const counts: Count = { list: 0, get: 0, other: 0 };
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
  const method = (init?.method ?? "GET").toUpperCase();
  if (method !== "GET" || url.pathname.endsWith("/context") || url.pathname.startsWith("/v1/actions")) {
    console.error(`拒绝非只读请求：${method} ${url.pathname}`);
    process.exit(2);
  }
  if (url.pathname === "/v1/world/objects") counts.list++;
  else if (url.pathname.startsWith("/v1/world/objects/")) counts.get++;
  else counts.other++;
  return realFetch(input, init);
}) as typeof fetch;

const env = resolveWorldEnv();
if (!env.worldApiUrl || !env.worldAgentToken) {
  console.error(`缺本体配置（TKOS_WORLD_API_URL / TKOS_WORLD_AGENT_TOKEN）${env.worldTokenError ? `：${env.worldTokenError}` : ""}`);
  process.exit(1);
}
const instance = loadWorldInstance(env.worldInstance);
const dir = mkdtempSync(join(tmpdir(), "company-context-eval-"));
const accessFile = join(dir, "access.json");
const domains = instance.domains as Record<string, string>;
writeFileSync(accessFile, JSON.stringify({
  ceo: Object.values(domains),
  member: [domains.company, domains.agents].filter(Boolean),
}));
const company = createCompanyMemory({ ...env, companyWorldAccessFile: accessFile, companyStorageDir: join(dir, "stored") });

/** --before：不开定位（等同改前的全量读）；改后代码上也能跑出对照。 */
const before = process.argv.includes("--before");
const CASES: { id: string; viewer: "ceo" | "member"; query: string }[] = [
  { id: "lighthouse", viewer: "ceo", query: "灯塔这件事到底怎么样了" },
  { id: "mission-progress", viewer: "ceo", query: "企业经营 Context 建模与数据供给这个 Mission 进展如何" },
  { id: "strategy", viewer: "ceo", query: "我们公司的战略是什么" },
  { id: "tokenhub-month", viewer: "ceo", query: "TokenHub 本月目标是什么" },
  { id: "member-task", viewer: "member", query: "会议内容写进本体这个 Task 现在怎么样" },
  { id: "member-mission", viewer: "member", query: "CEO / DRI Agent 从能用到在用 进展到哪了" },
  { id: "no-match", viewer: "ceo", query: "最近有什么需要我拍板的风险" },
];

const objectIdOf = (entry: CompanyEntry) => (entry as CompanyEntry & { ref?: string }).ref ?? decodeURIComponent(entry.handle.split(":")[1] ?? "");
const results: Record<string, unknown>[] = [];
for (const item of CASES) {
  counts.list = 0; counts.get = 0; counts.other = 0;
  const started = Date.now();
  const view = await company.read({ personId: item.viewer, role: item.viewer }, { query: item.query, locate: !before }, AbortSignal.timeout(120_000));
  const ms = Date.now() - started;
  const prose = companyProse(view);
  const objects = [...new Map(view.entries.map((entry) => [objectIdOf(entry), entry.title])).entries()].map(([ref, title]) => ({ ref, title }));
  const row = { id: item.id, viewer: item.viewer, query: item.query, status: view.status, ms, requests: { ...counts },
    entries: view.entries.length, objects, contextBytes: Buffer.byteLength(JSON.stringify(prose)), more: Boolean(view.nextCursor),
    refsInContext: view.entries.filter((entry) => typeof (entry as CompanyEntry & { ref?: string }).ref === "string").length,
    ...(view.message ? { message: view.message } : {}) };
  results.push(row);
  console.log(`${item.id} [${item.viewer}] ${view.status} ${ms}ms list=${counts.list} get=${counts.get} bytes=${row.contextBytes} refs=${row.refsInContext}/${view.entries.length}`);
  for (const object of objects) console.log(`   ${object.ref.slice(0, 12)}… ${object.title}`);
}

// CEO 目标快照：和 worldReader.refresh 读同一份（不含健康检查和版本号），再按 read_ontology 不带参数的结果量大小。
counts.list = 0; counts.get = 0; counts.other = 0;
const client = new WorldClient((async () => { throw new Error("评测不写台账"); }) as never, env, instance, { timeoutMs: 15_000 });
const started = Date.now();
const loaded = await loadWorldSnapshot(client, new Date());
const snapshotMs = Date.now() - started;
const tool = ontologyToolResult(loaded.snapshot, companyPeriod(new Date()));
const units = loaded.snapshot.units.map((unit) => {
  const extra = unit as typeof unit & { missions?: unknown[]; tasks?: unknown[] };
  return { unit: unit.unit.title, periodGoals: unit.periodGoals.length, missions: extra.missions?.length ?? null, tasks: extra.tasks?.length ?? null };
});
const snapshot = { ms: snapshotMs, requests: { ...counts }, toolBytes: Buffer.byteLength(JSON.stringify(tool)), truncated: Boolean(tool.truncated), units };
console.log(`snapshot ${snapshotMs}ms list=${counts.list} get=${counts.get} toolBytes=${snapshot.toolBytes}${snapshot.truncated ? " truncated" : ""}`);
for (const unit of units) console.log(`   ${unit.unit}: PO ${unit.periodGoals} Mission ${unit.missions ?? "-"} Task ${unit.tasks ?? "-"}`);

const outArg = process.argv.indexOf("--out");
const out = outArg > 0 ? resolve(process.argv[outArg + 1]) : join(dir, "result.json");
writeFileSync(out, JSON.stringify({ at: new Date().toISOString(), instance: env.worldInstance, cases: results, snapshot }, null, 2));
console.log(`结果：${out}`);
