import { describe, expect, it } from "vitest";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { migrate } from "../src/migrate.js";
import { createTestDb, type TestDb } from "./helpers.js";

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");

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
      expect(names).not.toContain("fixture_home");
      expect(names).not.toContain("fixture_objects");
      expect(names).toContain("radar_config");
      expect(names).toContain("signals");
      expect(names).toContain("issues");
      expect(names).toContain("meetings");
      expect(names).toContain("monthly_plans");
      expect(names).toContain("battlefield_config");
      expect(names).toContain("capability_config");
      expect(names).toContain("missions");

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
        "010_meeting_transcript_outcome.sql",
        "011_battlefield_config.sql",
        "012_drop_fixture_tables.sql",
        "013_signal_outlet_source.sql",
        "014_meeting_materials.sql",
        "015_issue_restore.sql",
        "016_conversation_sessions.sql",
        "017_signal_images.sql",
        "018_config_registries.sql",
        "019_strategy_map_config.sql",
        "020_meeting_transcript_candidate.sql",
        "021_mission_entity.sql",
        "022_mission_period_check.sql",
        "023_member_access.sql",
      ]);

      // 幂等：重复执行不再变更
      await migrate(db);
      const again = await db.query<{ count: string }>(
        "SELECT count(*) FROM schema_migrations",
      );
      expect(Number(again.rows[0].count)).toBe(23);

      // 时间列为 timestamptz（UTC 存储）
      const cols = await db.query<{ column_name: string; data_type: string }>(
        `SELECT column_name, data_type FROM information_schema.columns
         WHERE table_name = 'issues'`,
      );
      const tsCols = cols.rows.filter((r) => r.column_name.endsWith("_at"));
      expect(tsCols.length).toBeGreaterThanOrEqual(2);
      for (const c of tsCols) expect(c.data_type).toBe("timestamp with time zone");

      // Mission period 与 MonthlyPlan 同口径：月份只接受 01–12（021 建表即严格，022 修正已建库环境）
      await expect(
        db.query(
          `INSERT INTO missions (id, version, code, period, title, owner_id, capability_id, outcome, source_ref, source_document_id, source_revision, source_title)
           VALUES ('bad-period', 1, 'BAD-PERIOD', '2026-99', '标题', 'owner', 'capability', 'outcome', 'ref', 'doc', 1, '来源')`,
        ),
      ).rejects.toThrow(/missions_period_check/);

      await admin.query("SELECT 1"); // admin 连接可用
    });
  });

  /** 021 是唯一带数据改写的迁移：先用 001–020 建库并写入旧形状，再跑 migrate 验证改写结果。 */
  it("rewrites capability support refs and renames battlefield mission anchors", async () => {
    await createTestDb(async ({ db }: TestDb) => {
      const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql") && Number(f.split("_")[0]) <= 20).sort();
      await db.query("CREATE TABLE schema_migrations (id INTEGER PRIMARY KEY, filename TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())");
      for (const file of files) {
        await db.query(await readFile(join(MIGRATIONS_DIR, file), "utf8"));
        await db.query("INSERT INTO schema_migrations (id, filename) VALUES ($1, $2)", [Number(file.split("_")[0]), file]);
      }
      await db.query(
        `INSERT INTO battlefield_config (id, version, name, six_month_outcome, missions) VALUES ('legacy-battlefield', 1, '增长战场', '六个月目标', $1::jsonb)`,
        [JSON.stringify([{ code: "01-1", title: "未来组织范式设计与确认" }])],
      );
      await db.query(
        `INSERT INTO capability_config (id, version, code, name, six_month_outcome, support_refs) VALUES ('legacy-capability', 1, '07', 'Talent', '六个月结果', $1::jsonb)`,
        [JSON.stringify([{ type: "mission", missionCode: "07-1" }, { type: "all-battlefields" }])],
      );

      await migrate(db);

      const battlefield = await db.query<{ mission_anchors: unknown }>("SELECT mission_anchors FROM battlefield_config WHERE id = 'legacy-battlefield'");
      expect(battlefield.rows[0].mission_anchors).toEqual([{ code: "01-1", title: "未来组织范式设计与确认" }]);
      const capability = await db.query<{ support_refs: unknown }>("SELECT support_refs FROM capability_config WHERE id = 'legacy-capability'");
      // 顺序保持，未受影响的 ref 原样留下
      expect(capability.rows[0].support_refs).toEqual([{ type: "mission-anchor", missionCode: "07-1" }, { type: "all-battlefields" }]);
    });
  });
});
