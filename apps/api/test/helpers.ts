import { randomUUID, scryptSync } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { migrate } from "../src/migrate.js";
import { buildApp, type AppEnv } from "../src/app.js";
import type { FastifyInstance } from "fastify";
import type { ConversationRuntime } from "../src/conversations.js";

const ADMIN_URL = process.env.TEST_PG_URL ?? "postgres://postgres:postgres@localhost:54329/postgres";

export type TestDb = { db: import("pg").PoolClient; admin: Pool; database: string };

/** 建一个一次性空库跑迁移/集成测试，结束后删除。 */
export async function createTestDb(fn: (t: TestDb) => Promise<void>): Promise<void> {
  const database = `warmap_test_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const admin = new Pool({ connectionString: ADMIN_URL, max: 2 });
  await admin.query(`CREATE DATABASE ${database}`);
  const db = new Pool({
    connectionString: ADMIN_URL.replace(/\/postgres$/, `/${database}`),
    max: 5,
  });
  const client = await db.connect();
  try {
    await fn({ db: client, admin, database });
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
  buildSha: "test-sha",
};

export const TEST_PASSWORD = "ceo-pass-2024";

export type TestApp = {
  app: FastifyInstance;
  publicOrigin: string;
  env: AppEnv;
  loginCookie: () => Promise<string>;
  fixtureRow: () => Promise<Record<string, unknown>>;
  conversationState: (scope: string) => Promise<{ runtimeEntries: unknown[]; messages: Record<string, unknown>[] }>;
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
): Promise<TestApp> {
  const database = `warmap_test_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const admin = new Pool({ connectionString: ADMIN_URL, max: 2 });
  await admin.query(`CREATE DATABASE ${database}`);
  const pool = new Pool({
    connectionString: ADMIN_URL.replace(/\/postgres$/, `/${database}`),
    max: 5,
  });
  const client = await pool.connect();
  await migrate(client);
  client.release();
  const env = { ...testEnv, ...seedOverrides };
  const app = await buildApp({ pool, env, conversationRuntime });
  const apps = [app];
  return {
    app,
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
    fixtureRow: async () => {
      const res = await pool.query("SELECT to_jsonb(t) AS row FROM fixture_home t WHERE id = 'default'");
      return res.rows[0].row as Record<string, unknown>;
    },
    conversationState: async (scope) => {
      const conversation = await pool.query(
        "SELECT id, runtime_entries FROM conversations WHERE scope = $1",
        [scope],
      );
      if (!conversation.rows[0]) return { runtimeEntries: [], messages: [] };
      const messages = await pool.query(
        "SELECT role, content, references_snapshot FROM conversation_messages WHERE conversation_id = $1 ORDER BY sequence",
        [conversation.rows[0].id],
      );
      return { runtimeEntries: conversation.rows[0].runtime_entries, messages: messages.rows };
    },
    restart: async (runtime) => {
      const restarted = await buildApp({ pool, env, conversationRuntime: runtime });
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
