import { randomUUID, scryptSync } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import type { TWebSearchInput, TWebSearchResponse, TWebSearchResult } from "@warmap/contracts";
import { migrate } from "../src/migrate.js";
import { buildApp, type AppEnv } from "../src/app.js";
import type { FastifyInstance } from "fastify";
import type { ConversationRuntime } from "../src/conversations.js";
import type { ResearchService } from "../src/research.js";
import type { DriExporter, PreflightAgent } from "../src/meetings.js";
import { createMonthlyPlanService, type MonthlyDraftAgent, type MonthlyPlanService } from "../src/monthlyDraft.js";
import { loadCompanyMemory } from "../src/companyMemory.js";
import type { PostMeetingAgent } from "../src/outcome.js";
import type { WebSearchAdapter } from "../src/webSearch.js";

const ADMIN_URL = process.env.TEST_PG_URL ?? "postgres://postgres:postgres@localhost:54329/postgres";

export type TestDb = { db: import("pg").PoolClient; pool: Pool; admin: Pool; database: string };

/** DROP DATABASE (FORCE) 终止测试库残留连接是预期行为；其他池错误必须保持可见。 */
function tolerateDroppedConnections(pool: Pool): Pool {
  pool.on("error", (error: Error & { code?: string }) => {
    if (error.code !== "57P01") console.error("test pool error", error);
  });
  return pool;
}

/** 建一个一次性空库跑迁移/集成测试，结束后删除。 */
export async function createTestDb(fn: (t: TestDb) => Promise<void>): Promise<void> {
  const database = `warmap_test_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const admin = new Pool({ connectionString: ADMIN_URL, max: 2 });
  await admin.query(`CREATE DATABASE ${database}`);
  const db = tolerateDroppedConnections(new Pool({
    connectionString: ADMIN_URL.replace(/\/postgres$/, `/${database}`),
    max: 5,
  }));
  const client = await db.connect();
  try {
    await fn({ db: client, pool: db, admin, database });
  } finally {
    client.release();
    await db.end();
    await admin.query(`DROP DATABASE ${database} WITH (FORCE)`);
    await admin.end();
  }
}

export const scryptHash = (password: string, salt = "testsalt") =>
  `scrypt:${salt}:${scryptSync(password, salt, 32).toString("hex")}`;

const FIXTURE_PEOPLE_SEED = fileURLToPath(new URL("./fixtures/company-people.json", import.meta.url));
const FIXTURE_MEMORY_DIR = fileURLToPath(new URL("./fixtures/company-memory", import.meta.url));

export const testEnv: AppEnv = {
  sessionSecret: "test-session-secret",
  ceoPasswordHash: scryptHash("ceo-pass-2024"),
  sessionMaxAgeSeconds: 60 * 60 * 8,
  publicOrigin: "https://warmap.local",
  driServiceToken: "dri-token-test",
  mcpServiceToken: "mcp-token-test",
  companyMemorySeedDir: FIXTURE_MEMORY_DIR,
  companyPeopleSeed: FIXTURE_PEOPLE_SEED,
  piBaseUrl: "https://provider.invalid/v1/responses",
  piApiKey: "test-key",
  lightModel: "test-light-model",
  heavyModel: "test-heavy-model",
  compactionModel: "test-compaction-model",
  buildSha: "test-sha",
};

export const TEST_PASSWORD = "ceo-pass-2024";

export function createFakeWebSearchAdapter(
  fixtures: Record<string, TWebSearchResponse | TWebSearchResult[]>,
): WebSearchAdapter & { calls: TWebSearchInput[] } {
  const calls: TWebSearchInput[] = [];
  return {
    calls,
    async search(input, signal) {
      if (signal.aborted) throw signal.reason;
      calls.push(structuredClone(input));
      const fixture = fixtures[input.query];
      if (!fixture) return { results: [], warnings: [`No fake fixture for: ${input.query}`] };
      return Array.isArray(fixture) ? { results: structuredClone(fixture), warnings: [] } : structuredClone(fixture);
    },
  };
}

export type TestApp = {
  app: FastifyInstance;
  publicOrigin: string;
  env: AppEnv;
  loginCookie: () => Promise<string>;
  fixtureRow: () => Promise<Record<string, unknown>>;
  conversationState: (scope: string) => Promise<{
    runtimeEntries: unknown[];
    piSessionId?: string;
    recreatedAt?: Date | null;
    runtimeWarning?: string | null;
    messages: Record<string, unknown>[];
  }>;
  setRuntimeEntries: (scope: string, entries: unknown) => Promise<void>;
  agentRuns: () => Promise<Record<string, unknown>[]>;
  sql: (text: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;
  /** 仅当注入 monthlyDraftAgent 时存在；测试用它触发 Company Day scheduler。 */
  monthlyPlans?: MonthlyPlanService;
  restart: (runtime: ConversationRuntime) => Promise<FastifyInstance>;
  close: () => Promise<void>;
};

/** 每个用例一个独立数据库 + 已迁移 schema + 完整 app。可覆盖 CompanyMemory seed 路径。 */
const defaultConversationRuntime: ConversationRuntime = {
  async run(input) {
    input.emit({ type: "message", delta: "test reply" });
    return { assistantMessage: "test reply", runtimeEntries: input.runtimeEntries };
  },
};

export async function createTestApp(
  seedOverrides: Partial<Pick<AppEnv, "companyMemorySeedDir" | "companyPeopleSeed">> = {},
  conversationRuntime: ConversationRuntime = defaultConversationRuntime,
  runtimeOptions: {
    conversationTurnTimeoutMs?: number;
    preflightAgent?: PreflightAgent;
    outcomeAgent?: PostMeetingAgent;
    driExporter?: DriExporter;
    monthlyDraftAgent?: MonthlyDraftAgent;
    monthlyNow?: () => Date;
  } = {},
  researchService?: ResearchService,
): Promise<TestApp> {
  const database = `warmap_test_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const admin = new Pool({ connectionString: ADMIN_URL, max: 2 });
  await admin.query(`CREATE DATABASE ${database}`);
  const pool = tolerateDroppedConnections(new Pool({
    connectionString: ADMIN_URL.replace(/\/postgres$/, `/${database}`),
    max: 5,
  }));
  const client = await pool.connect();
  await migrate(client);
  client.release();
  const env = { ...testEnv, ...seedOverrides };
  const { monthlyDraftAgent, monthlyNow, ...appRuntimeOptions } = runtimeOptions;
  const monthlyPlans = monthlyDraftAgent
    ? createMonthlyPlanService({ pool, companyMemory: loadCompanyMemory(env), agent: monthlyDraftAgent, now: monthlyNow })
    : undefined;
  const app = await buildApp({ pool, env, conversationRuntime, researchService, monthlyPlanService: monthlyPlans, now: monthlyNow, ...appRuntimeOptions });
  const apps = [app];
  return {
    app,
    monthlyPlans,
    publicOrigin: testEnv.publicOrigin,
    env: testEnv,
    loginCookie: async () => {
      const login = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        headers: { origin: testEnv.publicOrigin },
        payload: { password: TEST_PASSWORD },
      });
      if (login.statusCode !== 200) throw new Error(`login failed: ${login.body}`);
      return (login.headers["set-cookie"] as string).split(";")[0];
    },
    /** 真实 DRI 导入的 pending Issue：目标路由只消费持久对象，测试不再依赖 fixture 表。 */
    createIssue: async (overrides: Record<string, unknown> = {}) => {
      const payload = {
        externalId: `test-issue-${randomUUID()}`,
        submitterPersonId: "person-fixture-002",
        title: "测试议题：是否调整渠道投入",
        whyNow: "渠道窗口将在六月关闭",
        sourceRef: "dri://test/issue",
        location: { level: "battlefield", battlefieldId: "growth" },
        ...overrides,
      };
      const res = await app.inject({
        method: "POST",
        url: "/api/dri/issues",
        headers: { authorization: `Bearer ${testEnv.driServiceToken}` },
        payload,
      });
      if (res.statusCode !== 201) throw new Error(`createIssue failed: ${res.statusCode} ${res.body}`);
      return (res.json() as { cards: { objectRef: { id: string }; id: string; version: number }[] }).cards[0];
    },
    conversationState: async (scope) => {
      const conversation = await pool.query(
        "SELECT id, pi_session_id, runtime_entries, recreated_at, runtime_warning FROM conversations WHERE scope = $1",
        [scope],
      );
      if (!conversation.rows[0]) return { runtimeEntries: [], messages: [] };
      const messages = await pool.query(
        "SELECT role, content, references_snapshot FROM conversation_messages WHERE conversation_id = $1 ORDER BY sequence",
        [conversation.rows[0].id],
      );
      return {
        runtimeEntries: conversation.rows[0].runtime_entries,
        piSessionId: conversation.rows[0].pi_session_id,
        recreatedAt: conversation.rows[0].recreated_at,
        runtimeWarning: conversation.rows[0].runtime_warning,
        messages: messages.rows,
      };
    },
    setRuntimeEntries: async (scope, entries) => {
      await pool.query("UPDATE conversations SET runtime_entries = $2::jsonb WHERE scope = $1", [scope, JSON.stringify(entries)]);
    },
    agentRuns: async () => (await pool.query("SELECT * FROM agent_runs ORDER BY started_at, id")).rows,
    sql: async (text, params) => (await pool.query(text, params)).rows,
    restart: async (runtime) => {
      const restarted = await buildApp({ pool, env, conversationRuntime: runtime, researchService, monthlyPlanService: monthlyPlans, now: monthlyNow, ...appRuntimeOptions });
      apps.push(restarted);
      return restarted;
    },
    close: async () => {
      await Promise.all(apps.map((instance) => instance.close()));
      await pool.end();
      await admin.query(`DROP DATABASE ${database} WITH (FORCE)`);
      await admin.end();
    },
  };
}
