import { randomUUID, scryptSync } from "node:crypto";
import { Pool } from "pg";
import { migrate } from "../src/migrate.js";
import { buildApp, type AppEnv } from "../src/app.js";
import type { FastifyInstance } from "fastify";

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

export const testEnv: AppEnv = {
  sessionSecret: "test-session-secret",
  ceoPasswordHash: scryptHash("ceo-pass-2024"),
  sessionMaxAgeSeconds: 60 * 60 * 8,
  publicOrigin: "https://warmap.local",
  driServiceToken: "dri-token-test",
  mcpServiceToken: "mcp-token-test",
  buildSha: "test-sha",
};

export const TEST_PASSWORD = "ceo-pass-2024";

export type TestApp = {
  app: FastifyInstance;
  publicOrigin: string;
  env: AppEnv;
  loginCookie: () => Promise<string>;
  fixtureRow: () => Promise<Record<string, unknown>>;
  close: () => Promise<void>;
};

/** 每个用例一个独立数据库 + 已迁移 schema + 完整 app。 */
export async function createTestApp(): Promise<TestApp> {
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
  const app = await buildApp({ pool, env: testEnv });
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
    close: async () => {
      await app.close();
      await pool.end();
      await admin.query(`DROP DATABASE ${database} WITH (FORCE)`);
      await admin.end();
    },
  };
}
