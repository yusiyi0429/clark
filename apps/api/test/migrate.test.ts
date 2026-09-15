import { describe, expect, it } from "vitest";
import { migrate } from "../src/migrate.js";
import { createTestDb, type TestDb } from "./helpers.js";

describe("migration", () => {
  it("migrates an empty database in order and is idempotent", async () => {
    await createTestDb(async ({ db, admin }: TestDb) => {
      await migrate(db);
      const tables = await db.query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.tables
         WHERE table_schema = 'public' ORDER BY table_name`,
      );
      const names = tables.rows.map((r) => r.table_name);
      expect(names).toContain("schema_migrations");
      expect(names).toContain("fixture_home");
      expect(names).toContain("radar_config");
      expect(names).toContain("signals");
      expect(names).toContain("issues");
      expect(names).toContain("meetings");
      expect(names).toContain("monthly_plans");

      const applied = await db.query<{ id: number; filename: string }>(
        "SELECT id, filename FROM schema_migrations ORDER BY id",
      );
      expect(applied.rows.map((r) => r.filename)).toEqual([
        "001_init.sql",
        "002_fixture_comment.sql",
        "003_conversations.sql",
        "004_runtime_recovery.sql",
        "005_radar_signals.sql",
        "006_issues.sql",
        "007_issue_research_decisions.sql",
        "008_meetings.sql",
        "009_monthly_plans.sql",
      ]);

      // 幂等：重复执行不再变更
      await migrate(db);
      const again = await db.query<{ count: string }>(
        "SELECT count(*) FROM schema_migrations",
      );
      expect(Number(again.rows[0].count)).toBe(9);

      // fixture seed 行存在
      const seed = await db.query("SELECT * FROM fixture_home WHERE id = 'default'");
      expect(seed.rows).toHaveLength(1);

      // 时间列为 timestamptz（UTC 存储）
      const cols = await db.query<{ column_name: string; data_type: string }>(
        `SELECT column_name, data_type FROM information_schema.columns
         WHERE table_name = 'fixture_home'`,
      );
      const tsCols = cols.rows.filter((r) => r.column_name.endsWith("_at"));
      expect(tsCols.length).toBeGreaterThanOrEqual(2);
      for (const c of tsCols) expect(c.data_type).toBe("timestamp with time zone");

      await admin.query("SELECT 1"); // admin 连接可用
    });
  });
});
