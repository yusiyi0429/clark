/**
 * LangSmith 轨迹本地冒烟：在一次性测试库（测试 PG，测试夹具公司，不碰任何演示场次）里发一条真实对话，
 * 打印生成的 Trace（root run）名称、id 与 URL。只发一条测试轨迹；不打印、不写入任何密钥。
 *
 * 开关只在命令行临时打开，.data/runtime.env 里的 LANGSMITH_TRACING 保持 false：
 *   bash:        cd apps/api && LANGSMITH_TRACING=true npx tsx scripts/langsmith-smoke.ts
 *   PowerShell:  cd apps/api; $env:LANGSMITH_TRACING='true'; npx tsx scripts/langsmith-smoke.ts; Remove-Item Env:LANGSMITH_TRACING
 *
 * 读取 .data/runtime.env 里的 PI_BASE_URL / PI_API_KEY / LIGHT_MODEL / LANGSMITH_*（命令行已有的值优先）；
 * 测试库默认 postgres://postgres:postgres@localhost:54329/postgres（TEST_PG_URL 可改），用完即删。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "langsmith";
import { loadCompanyMemory } from "../src/companyMemory.js";
import { createPiConversationRuntime } from "../src/piConversationRuntime.js";
import { configureTracing, flushTracing } from "../src/tracing.js";
import { createTestApp, testEnv } from "../test/helpers.js";

const KEYS = ["PI_BASE_URL", "PI_API_KEY", "LIGHT_MODEL", "LANGSMITH_API_KEY", "LANGSMITH_PROJECT", "LANGSMITH_ENDPOINT", "LANGSMITH_TRACING", "TRACE_ANON_SALT"];
const envFile = join(import.meta.dirname, "..", "..", "..", ".data", "runtime.env");
try {
  for (const line of readFileSync(envFile, "utf8").split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Z_0-9]+)\s*=\s*(.*)\s*$/.exec(line);
    if (!match || !KEYS.includes(match[1]) || process.env[match[1]]) continue;
    process.env[match[1]] = match[2].trim().replace(/^(["'])(.*)\1$/, "$2");
  }
} catch {
  console.error("缺少 .data/runtime.env");
  process.exit(1);
}
if (process.env.LANGSMITH_TRACING?.trim().toLowerCase() !== "true") {
  console.error("未发送：请只在命令行临时设置 LANGSMITH_TRACING=true 再运行（不要改 .data/runtime.env）。");
  process.exit(1);
}
for (const key of ["PI_BASE_URL", "PI_API_KEY", "LIGHT_MODEL", "LANGSMITH_API_KEY"]) {
  if (!process.env[key]?.trim()) {
    console.error(`缺少 ${key}`);
    process.exit(1);
  }
}

const project = process.env.LANGSMITH_PROJECT?.trim() || "default";
const sdk = new Client({
  apiKey: process.env.LANGSMITH_API_KEY!.trim(),
  apiUrl: process.env.LANGSMITH_ENDPOINT?.trim() || undefined,
  timeout_ms: 10_000,
  autoBatchTracing: true,
  omitTracedRuntimeInfo: true,
});
const roots: { id: string; name: string }[] = [];
const runs: string[] = [];
configureTracing({
  enabled: true,
  project,
  client: {
    createRun: async (run, options) => {
      runs.push(String(run.name));
      if (!run.parent_run_id) roots.push({ id: String(run.id), name: String(run.name) });
      return sdk.createRun(run as never, options as never);
    },
    updateRun: (id, run, options) => sdk.updateRun(id, run as never, options as never),
    awaitPendingTraceBatches: () => sdk.awaitPendingTraceBatches(),
  } as never,
});

const runtime = await createPiConversationRuntime({
  companyMemory: loadCompanyMemory(testEnv),
  baseUrl: process.env.PI_BASE_URL!,
  apiKey: process.env.PI_API_KEY!,
  modelId: process.env.LIGHT_MODEL!,
});
const t = await createTestApp({}, runtime);
let exitCode = 0;
try {
  const cookie = await t.loginCookie();
  const res = await t.app.inject({
    method: "POST",
    url: "/api/conversations/global/messages",
    headers: { cookie, origin: t.publicOrigin, accept: "text/event-stream" },
    payload: { message: "这是一条 LangSmith 轨迹冒烟测试。不用检索，直接只回复两个字：收到。" },
  });
  const completed = res.body.includes('"status":"completed"');
  console.log(`对话：HTTP ${res.statusCode}，${completed ? "已完成" : "未完成"}`);
  if (!completed) exitCode = 1;
  await flushTracing();
  await new Promise((resolve) => setTimeout(resolve, 1500));
  await flushTracing();
  console.log(`项目：${project}`);
  console.log(`本次发送的节点：${runs.join("，")}`);
  for (const root of roots) {
    // 刚发送的 run 要等 LangSmith 入库后才能查到 URL：最多等 20 秒。
    let url = "（URL 暂未查到，可在项目里按 trace id 搜索）";
    for (let i = 0; i < 10; i++) {
      try { url = await sdk.getRunUrl({ runId: root.id, projectOpts: { projectName: project } }); break; } catch { await new Promise((resolve) => setTimeout(resolve, 2000)); }
    }
    console.log(`Trace：${root.name}  id=${root.id}  ${url}`);
  }
  if (!roots.length) {
    console.log("没有生成 Trace。");
    exitCode = 1;
  }
} finally {
  await t.close();
  await runtime.close();
}
process.exit(exitCode);
