/**
 * Ticket 16 真实外部验收（成本上限、无自动重试、不换档、不重跑）。
 *
 * 只读真实凭据（来自 infra/.env，经 `set -a; . infra/.env` 注入），不打印/不写入任何 secret。
 * 每一步失败即停止，不重试；输出只保留 provider/model 名称、状态、耗时、usage 与公开 URL。
 *
 * 用法（仓库内）：
 *   set -a; . infra/.env; set +a
 *   cd apps/api && npx tsx scripts/real-acceptance.ts [--dry-run]
 */
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PostMeetingCandidate, WarmapTranscript, type TMeetingParticipant, type TTranscriptTurn } from "@warmap/contracts";
import { Value } from "@sinclair/typebox/value";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  InMemoryCredentialStore,
  InMemoryModelsStore,
  type Context,
  type Model,
} from "@earendil-works/pi-ai";
import { createBochaWebSearchAdapter, type WebSearchAdapter } from "../src/webSearch.js";
import { loadCompanyMemory } from "../src/companyMemory.js";
import { createPiConversationRuntime } from "../src/piConversationRuntime.js";
import { createPostMeetingAgent } from "../src/postMeetingAgent.js";
import { validateTranscript } from "../src/outcome.js";
import { migrate } from "../src/migrate.js";
import { createTestDb } from "../test/helpers.js";

const REPO = fileURLToPath(new URL("../../../", import.meta.url));
const DRY_RUN = process.argv.includes("--dry-run");
/** 只跑单步（修脚本后可单独复跑；不做 provider 自动重试）。 */
const ONLY = process.argv.find((arg) => arg.startsWith("--only="))?.slice("--only=".length);

/** 先按已知 secret 精确抹除，再用长度启发式兵底；控制字符不进入终端。 */
const KNOWN_SECRETS = Object.entries(process.env)
  .filter(([name, value]) => /(KEY|TOKEN|SECRET|PASSWORD|HASH)$/i.test(name) && (value ?? "").length >= 8)
  .map(([, value]) => value!)
  .sort((a, b) => b.length - a.length);

const redact = (value: string) => {
  let text = value;
  for (const secret of KNOWN_SECRETS) text = text.split(secret).join("***");
  return text.replace(/[A-Za-z0-9_-]{24,}/g, "***").replace(/[\u0000-\u001f\u007f]/g, " ");
};
const log = (line: string) => console.log(redact(line));

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missing env ${name}`);
  return value;
}

function resolveSeed(value: string): string {
  if (isAbsolute(value) && existsSync(value)) return value;
  const fromCwd = resolve(process.cwd(), value);
  if (existsSync(fromCwd)) return fromCwd;
  return resolve(REPO, value);
}

function normalizedBaseUrl(value: string): string {
  return value.replace(/\/+$/, "").replace(/\/responses$/, "");
}

type Usage = { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; totalTokens?: number };
const usageLine = (usage: Usage | undefined) =>
  usage ? `tokens in=${usage.input ?? "?"} out=${usage.output ?? "?"} total=${usage.totalTokens ?? "?"}` : "tokens n/a";

/** 与生产 runtime 相同的 OpenAI-compatible Responses 端点，只发一条极短 prompt。 */
async function minimalModelCall(baseUrl: string, apiKey: string, modelId: string) {
  const runtime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsStore: new InMemoryModelsStore(),
    modelsPath: null,
    refreshOnCreate: false,
  });
  runtime.registerProvider("warmap", {
    name: "WarMap acceptance",
    baseUrl: normalizedBaseUrl(baseUrl),
    api: "openai-responses",
    models: [{
      id: modelId,
      name: modelId,
      api: "openai-responses",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128_000,
      maxTokens: 1024,
    }],
  });
  await runtime.setRuntimeApiKey("warmap", apiKey);
  const model = runtime.getModel("warmap", modelId) as Model<"openai-responses"> | undefined;
  if (!model) throw new Error(`model not found: ${modelId}`);
  const context: Context = { messages: [{ role: "user", content: "只回复两个字：正常", timestamp: Date.now() }] };
  const startedAt = Date.now();
  const message = await runtime.streamSimple(model, context, {}).result();
  return {
    ms: Date.now() - startedAt,
    stopReason: message.stopReason,
    textLength: message.content.filter((part) => part.type === "text").map((part) => part.text).join("").length,
    usage: message.usage as Usage,
  };
}

const state = { searchOk: false, modelsOk: false, searchCalls: 0 };
const BOCHA_BUDGET = 3;

function budgetedBocha(adapter: WebSearchAdapter): WebSearchAdapter {
  return {
    async search(input, signal) {
      state.searchCalls += 1;
      if (state.searchCalls > BOCHA_BUDGET) throw new Error("ACCEPTANCE_SEARCH_BUDGET_EXCEEDED");
      return adapter.search(input, signal);
    },
  };
}

async function step1Bocha() {
  log("[1/4] Bocha 真实 query：1 次");
  const adapter = budgetedBocha(createBochaWebSearchAdapter({ apiKey: required("BOCHA_API_KEY") }));
  const startedAt = Date.now();
  const response = await adapter.search({ query: "开源大模型 最新发布" }, AbortSignal.timeout(60_000));
  const first = response.results[0];
  const ok = response.results.length > 0 && Boolean(first?.title && first?.url && first?.excerpt);
  log(`      provider=bocha status=${ok ? "ok" : "no-usable-result"} results=${response.results.length} ms=${Date.now() - startedAt}`);
  if (first) log(`      sample title=${first.title.slice(0, 60)} url=${first.url} publishedAt=${first.publishedAt ?? "-"}`);
  if (!ok) throw new Error("Bocha 真实查询未返回 title/URL/excerpt");
  state.searchOk = true;
}

async function step2Models() {
  log("[2/4] 模型槽位：light/heavy/compaction 各 1 次最小真实调用");
  const baseUrl = required("PI_BASE_URL");
  const apiKey = required("PI_API_KEY");
  for (const [slot, envName] of [["light", "LIGHT_MODEL"], ["heavy", "HEAVY_MODEL"], ["compaction", "COMPACTION_MODEL"]] as const) {
    const modelId = required(envName);
    const result = await minimalModelCall(baseUrl, apiKey, modelId);
    const ok = result.stopReason === "stop" && result.textLength > 0;
    log(`      slot=${slot} model=${modelId} status=${ok ? "ok" : `stopReason=${result.stopReason}`} ms=${result.ms} ${usageLine(result.usage)}`);
    if (!ok) throw new Error(`模型槽位 ${slot} 未成功完成`);
  }
  state.modelsOk = true;
}

async function step3PiLoop() {
  log("[3/4] Pi 自主 web_search Tool loop：最多 1 轮，搜索预算 ≤2（含第 1 步共 ≤3）");
  const companyMemory = loadCompanyMemory({
    companyMemorySeedDir: resolveSeed(required("COMPANY_MEMORY_SEED_DIR")),
    companyPeopleSeed: resolveSeed(required("COMPANY_PEOPLE_SEED")),
  });
  const bocha = budgetedBocha(createBochaWebSearchAdapter({ apiKey: required("BOCHA_API_KEY") }));
  const runtime = await createPiConversationRuntime({
    companyMemory,
    baseUrl: required("PI_BASE_URL"),
    apiKey: required("PI_API_KEY"),
    modelId: required("LIGHT_MODEL"),
    compactionModelId: required("COMPACTION_MODEL"),
    search: bocha,
  });
  const toolEvents: { name: string; phase: string; isError?: boolean }[] = [];
  let usage: Usage | undefined;
  const startedAt = Date.now();
  try {
    const before = state.searchCalls;
    const result = await runtime.run({
      scope: "global",
      message: "请用 web_search 只查一次「开源大模型 最新发布」，然后用一条带 URL 的外部事实回答，查完立即停止。",
      currentObject: null,
      referencesSnapshot: [],
      runtimeEntries: [],
      piSessionId: randomUUID(),
      signal: AbortSignal.timeout(180_000),
      emit: (event) => {
        if (event.type === "tool") toolEvents.push({ name: event.name, phase: event.phase, isError: event.isError });
        if (event.type === "usage") usage = event as unknown as Usage;
      },
      checkpoint: async () => undefined,
    });
    const searchCalls = state.searchCalls - before;
    const searched = toolEvents.some((event) => event.name === "web_search" && event.phase === "started");
    const completedOk = toolEvents.some((event) => event.name === "web_search" && event.phase === "completed" && event.isError !== true);
    log(`      status=${searched && completedOk ? "ok" : "no-search"} searchCalls=${searchCalls} ms=${Date.now() - startedAt} ${usageLine(usage)}`);
    log(`      tools=${JSON.stringify(toolEvents)} assistantChars=${result.assistantMessage.length}`);
    if (!searched || !completedOk) throw new Error("Pi 未自主完成一次 web_search Tool loop");
  } finally {
    await runtime.close?.();
  }
}

async function step4TranscriptOutcome() {
  log("[4/4] 合法 Transcript + Outcome 抽取：1 次（heavy）");
  const transcript = {
    schemaVersion: "warmap-transcript.v1" as const,
    meetingId: randomUUID(),
    turns: [
      { id: "turn-001", speakerId: "person-example-001", startedAt: "2026-09-18T10:00:05+08:00", text: "灯塔项目优先，TokenOps 保留最低验证力量。" },
      { id: "turn-002", speakerId: "person-example-002", startedAt: "2026-09-18T10:00:40+08:00", text: "我来整理最小验证包范围，本周给出三条验收标准。" },
    ] as TTranscriptTurn[],
  };
  const participants: TMeetingParticipant[] = [
    { personId: "person-example-001", displayName: "示例 CEO", role: "ceo" },
    { personId: "person-example-002", displayName: "示例 DRI", role: "dri" },
  ];
  if (!Value.Check(WarmapTranscript, transcript)) throw new Error("验收 Transcript 不合 warmap-transcript.v1");
  const validation = validateTranscript(transcript, { id: transcript.meetingId, participants });
  if (!validation.ok) throw new Error(`Transcript 整份校验失败: ${validation.code} ${validation.message}`);
  log(`      transcript schema=warmap-transcript.v1 turns=${transcript.turns.length} validation=ok`);

  await createTestDb(async ({ db }) => {
    await migrate(db);
    const agent = createPostMeetingAgent({
      query: db.query.bind(db),
      baseUrl: required("PI_BASE_URL"),
      apiKey: required("PI_API_KEY"),
      modelId: required("HEAVY_MODEL"),
    });
    const startedAt = Date.now();
    const { candidate, runId } = await agent.generate({
      meeting: {
        id: transcript.meetingId,
        title: "验收会议（临时库）",
        scheduledAt: "2026-09-18T10:00:00+08:00",
        ceoParticipantId: "person-example-001",
        participants,
      },
      transcript: { turns: transcript.turns },
      issues: [],
    }, AbortSignal.timeout(180_000));
    const ok = Value.Check(PostMeetingCandidate, candidate);
    const items = ok ? (candidate as { items: unknown[] }).items : [];
    const runs = await db.query<{ status: string; usage: Usage | null }>(
      "SELECT status, usage FROM agent_runs WHERE id = $1",
      [runId],
    );
    log(`      status=${ok ? "ok" : "invalid-candidate"} items=${items.length} ms=${Date.now() - startedAt} ${usageLine(runs.rows[0]?.usage ?? undefined)}`);
    if (!ok) throw new Error("Outcome 候选不合 PostMeetingCandidate");
  });
}

async function main() {
  if (DRY_RUN) {
    log("dry-run：1 Bocha query → 3×minimal model call → 1 Pi web_search loop（≤2 search）→ 1 transcript+outcome；未发任何请求");
    return;
  }
  const completed: string[] = [];
  const runOne = async (name: string, fn: () => Promise<void>, prereq: () => boolean) => {
    if (ONLY && ONLY !== name) return;
    if (!prereq()) throw new Error(`${name}: 前置未成功，按成本上限跳过`);
    await fn();
    completed.push(name);
  };
  try {
    await runOne("bocha", step1Bocha, () => true);
    await runOne("models", step2Models, () => true);
    await runOne("pi-loop", step3PiLoop, () => state.searchOk && state.modelsOk);
    // outcome 依赖 heavy 槽位；单独复跑时用 --only=transcript-outcome 跳过前置
    await runOne("transcript-outcome", step4TranscriptOutcome, () => ONLY === "transcript-outcome" || state.modelsOk);
    log(`ACCEPTANCE_RESULT ok steps=${completed.join(",")} bochaCalls=${state.searchCalls}`);
  } catch (cause) {
    log(`ACCEPTANCE_RESULT failed steps=${completed.join(",") || "none"} bochaCalls=${state.searchCalls}`);
    log(`      error=${(cause as Error).message || String(cause)}`);
    process.exitCode = 1;
  }
}

await main();
