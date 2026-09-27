import { describe, expect, it } from "vitest";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { migrate } from "../src/migrate.js";
import { createTestDb, type TestDb } from "./helpers.js";

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");

describe("migration", () => {
  it("adds task thread membership for existing 026 execution items", async () => {
    await createTestDb(async ({ db }) => {
      const files = (await readdir(MIGRATIONS_DIR)).filter((file) => file.endsWith(".sql") && Number(file.split("_")[0]) <= 35).sort();
      await db.query("CREATE TABLE schema_migrations (id INTEGER PRIMARY KEY, filename TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())");
      for (const file of files) {
        await db.query(await readFile(join(MIGRATIONS_DIR, file), "utf8"));
        await db.query("INSERT INTO schema_migrations (id,filename) VALUES($1,$2)",[Number(file.split("_")[0]),file]);
      }
      const id="00000000-0000-4000-8000-000000000036";
      await db.query("INSERT INTO tasks(id,title,status,owner_id,created_by) VALUES($1,'旧事项','not_started','old-owner','meeting')",[id]);
      await db.query("INSERT INTO task_members(task_id,person_id,role,added_by) VALUES($1,'old-owner','owner','meeting')",[id]);
      await migrate(db);
      const members=await db.query("SELECT person_id FROM thread_members WHERE object_type='task' AND object_id=$1",[id]);
      expect(members.rows).toEqual([{person_id:"old-owner"}]);
      expect((await db.query("SELECT mission_id,start_date,step_order FROM tasks WHERE id=$1",[id])).rows[0]).toEqual({mission_id:null,start_date:null,step_order:null});
    });
  });
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
      expect(names).toContain("meeting_recordings");
      expect(names).toContain("tasks");
      expect(names).toContain("task_members");
      expect(names).toContain("task_notes");
      expect(names).toContain("notifications");
      expect(names).toContain("ontology_update_requests");
      expect(names).toContain("person_voiceprints");
      expect(names).toContain("person_onboarding");
      expect(names).toContain("mission_rounds");
      expect(names).toContain("personal_mission_cards");
      expect(names).toContain("mission_card_feedback");
      expect(names).toContain("mission_round_reviews");
      expect(names).toContain("mission_review_decisions");
      expect(names).toContain("mission_card_reads");
      expect(names).toContain("mission_card_corrections");
      expect(names).toContain("person_radar");
      expect(names).toContain("person_radar_signals");

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
        "024_conversation_owner_and_threads.sql",
        "025_meeting_end_time.sql",
        "026_tasks_and_notifications.sql",
        "027_meeting_recordings.sql",
        "028_merge_conversation_sessions.sql",
        "029_voiceprints.sql",
        "030_person_onboarding.sql",
        "031_person_radar.sql",
        "032_mission_card_fields.sql",
        "033_mission_rounds.sql",
        "034_mission_card_discussion.sql",
        "035_mission_card_corrections.sql",
        "036_execution_items.sql",
        "037_personal_tokens_and_progress.sql",
      ]);

      // 幂等：重复执行不再变更
      await migrate(db);
      const again = await db.query<{ count: string }>(
        "SELECT count(*) FROM schema_migrations",
      );
      expect(Number(again.rows[0].count)).toBe(37);

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

      // 个人雷达：开启至少要有 1 条方向；关着可以什么都不写
      await expect(db.query("INSERT INTO person_radar (person_id, enabled) VALUES ('person-a', TRUE)")).rejects.toThrow(/person_radar_check/);
      await db.query("INSERT INTO person_radar (person_id) VALUES ('person-a')");
      await db.query(`UPDATE person_radar SET enabled = TRUE, directions = '["方向"]'::jsonb WHERE person_id = 'person-a'`);
      // 同一人同一网址只一行；不同的人各自一行
      const signal = (person: string) => db.query(
        `INSERT INTO person_radar_signals (id, person_id, source_type, source_fingerprint, source_title, source_url, published_at, excerpt,
           source_ref, direction_id, direction_text, summary, reason, evidence_quote, relevance)
         VALUES (gen_random_uuid(), $1, 'web', $2, '标题', 'https://example.com/a', now(), '原文', '{}'::jsonb, 'd_1', '方向', '结论', '理由', '原文', 3)`,
        [person, "f".repeat(64)],
      );
      await signal("person-a");
      await signal("person-b");
      await expect(signal("person-a")).rejects.toThrow(/person_radar_signals_person_id_source_fingerprint_key/);

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

  /** 025 给已有 Meeting 回填计划结束时间：开始后 60 分钟，未标记开完。 */
  it("backfills meeting ends_at as scheduled_at + 60 minutes and enforces ends_at > scheduled_at", async () => {
    await createTestDb(async ({ db }: TestDb) => {
      const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql") && Number(f.split("_")[0]) <= 24).sort();
      await db.query("CREATE TABLE schema_migrations (id INTEGER PRIMARY KEY, filename TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())");
      for (const file of files) {
        await db.query(await readFile(join(MIGRATIONS_DIR, file), "utf8"));
        await db.query("INSERT INTO schema_migrations (id, filename) VALUES ($1, $2)", [Number(file.split("_")[0]), file]);
      }
      await db.query(
        `INSERT INTO meetings (id, version, title, status, scheduled_at, lead_dri_id, ceo_participant_id, participants, issue_ids, preflight, draft, origin_ref)
         VALUES ('00000000-0000-4000-8000-000000000025', 1, '旧会议', 'held', '2026-06-01T02:00:00Z', 'dri', 'ceo', '[]', '[]', '{}', '{}', '{}')`,
      );

      await migrate(db);

      const row = await db.query<{ ends_at: Date; ended_at: Date | null }>("SELECT ends_at, ended_at FROM meetings");
      expect(row.rows[0].ends_at.toISOString()).toBe("2026-06-01T03:00:00.000Z");
      expect(row.rows[0].ended_at).toBeNull();
      await expect(db.query("UPDATE meetings SET ends_at = scheduled_at")).rejects.toThrow(/meetings_ends_after_start/);
    });
  });

  /** 028 去掉会话：同一个人 × 页面的其余会话并进最早那条，消息按时间交错、序号重排；主对话 Pi 运行态不动。 */
  it("merges extra conversation sessions per owner × scope into the earliest one", async () => {
    await createTestDb(async ({ db }: TestDb) => {
      const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql") && Number(f.split("_")[0]) <= 27).sort();
      await db.query("CREATE TABLE schema_migrations (id INTEGER PRIMARY KEY, filename TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())");
      for (const file of files) {
        await db.query(await readFile(join(MIGRATIONS_DIR, file), "utf8"));
        await db.query("INSERT INTO schema_migrations (id, filename) VALUES ($1, $2)", [Number(file.split("_")[0]), file]);
      }
      const id = (suffix: string) => `00000000-0000-4000-8000-0000000000${suffix}`;
      const conversation = (suffix: string, owner: string | null, scope: string, createdAt: string, deletedAt: string | null = null) => db.query(
        `INSERT INTO conversations (id, owner_id, scope, pi_session_id, runtime_entries, created_at, deleted_at)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)`,
        [id(suffix), owner, scope, `10000000-0000-4000-8000-0000000000${suffix}`, JSON.stringify([{ entry: suffix }]), createdAt, deletedAt],
      );
      const message = (suffix: string, sequence: number, role: "user" | "assistant", content: string, createdAt: string, attachments: unknown[] = []) => db.query(
        `INSERT INTO conversation_messages (conversation_id, sequence, role, content, attachments, run_id, created_at)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)`,
        [id(suffix), sequence, role, content, JSON.stringify(attachments), `20000000-0000-4000-8000-0000000000${suffix}`, createdAt],
      );
      // person-a 首页：更早的 f 已删除不参与；a 是主对话，b 的消息与 a 交错
      await conversation("0f", "person-a", "global", "2026-08-01T00:00:00Z", "2026-08-15T00:00:00Z");
      await conversation("0a", "person-a", "global", "2026-09-01T00:00:00Z");
      await conversation("0b", "person-a", "global", "2026-09-02T00:00:00Z");
      await message("0a", 1, "user", "A1", "2026-09-01T10:00:00Z");
      await message("0a", 2, "assistant", "A2", "2026-09-01T10:01:00Z");
      await message("0a", 3, "user", "A3", "2026-09-03T10:00:00Z");
      await message("0a", 4, "assistant", "A4", "2026-09-03T10:01:00Z");
      await message("0b", 1, "user", "B1", "2026-09-02T10:00:00Z", [{ id: "att-1", fileName: "brief.md" }]);
      await message("0b", 2, "assistant", "B2", "2026-09-02T10:01:00Z");
      await message("0b", 3, "user", "B3", "2026-09-04T10:00:00Z");
      // person-b 同一页面只有一条：不动
      await conversation("0c", "person-b", "global", "2026-09-01T00:00:00Z");
      await message("0c", 1, "user", "C1", "2026-09-01T10:30:00Z");
      // owner 还没回填的旧对话自成一组，一起合并
      await conversation("0d", null, "issue:legacy", "2026-09-01T00:00:00Z");
      await conversation("0e", null, "issue:legacy", "2026-09-05T00:00:00Z");
      await message("0d", 1, "user", "D1", "2026-09-05T09:00:00Z");
      await message("0e", 1, "user", "E1", "2026-09-05T08:00:00Z");
      await message("0e", 2, "assistant", "E2", "2026-09-05T08:01:00Z");

      await migrate(db);

      const messages = async (suffix: string) => (await db.query<{ sequence: number; role: string; content: string }>(
        "SELECT sequence, role, content FROM conversation_messages WHERE conversation_id = $1 ORDER BY sequence",
        [id(suffix)],
      )).rows.map((row) => [row.sequence, row.role, row.content]);
      expect(await messages("0a")).toEqual([
        [1, "user", "A1"],
        [2, "assistant", "A2"],
        [3, "user", "B1"],
        [4, "assistant", "B2"],
        [5, "user", "A3"],
        [6, "assistant", "A4"],
        [7, "user", "B3"],
      ]);
      expect(await messages("0b")).toEqual([]);
      expect(await messages("0c")).toEqual([[1, "user", "C1"]]);
      expect(await messages("0d")).toEqual([[1, "user", "E1"], [2, "assistant", "E2"], [3, "user", "D1"]]);
      expect(await messages("0e")).toEqual([]);
      // 并入的消息保留附件元数据与 run_id
      const moved = await db.query("SELECT attachments, run_id FROM conversation_messages WHERE conversation_id = $1 AND content = 'B1'", [id("0a")]);
      expect(moved.rows[0]).toEqual({ attachments: [{ id: "att-1", fileName: "brief.md" }], run_id: "20000000-0000-4000-8000-00000000000b" });

      const conversations = await db.query<{ id: string; pi_session_id: string; runtime_entries: unknown; deleted: boolean }>(
        "SELECT id, pi_session_id, runtime_entries, deleted_at IS NOT NULL AS deleted FROM conversations ORDER BY id",
      );
      expect(conversations.rows).toEqual([
        { id: id("0a"), pi_session_id: "10000000-0000-4000-8000-00000000000a", runtime_entries: [{ entry: "0a" }], deleted: false },
        { id: id("0b"), pi_session_id: "10000000-0000-4000-8000-00000000000b", runtime_entries: [{ entry: "0b" }], deleted: true },
        { id: id("0c"), pi_session_id: "10000000-0000-4000-8000-00000000000c", runtime_entries: [{ entry: "0c" }], deleted: false },
        { id: id("0d"), pi_session_id: "10000000-0000-4000-8000-00000000000d", runtime_entries: [{ entry: "0d" }], deleted: false },
        { id: id("0e"), pi_session_id: "10000000-0000-4000-8000-00000000000e", runtime_entries: [{ entry: "0e" }], deleted: true },
        { id: id("0f"), pi_session_id: "10000000-0000-4000-8000-00000000000f", runtime_entries: [{ entry: "0f" }], deleted: true },
      ]);
      const earlierDeleted = await db.query<{ deleted_at: Date }>("SELECT deleted_at FROM conversations WHERE id = $1", [id("0f")]);
      expect(earlierDeleted.rows[0].deleted_at.toISOString()).toBe("2026-08-15T00:00:00.000Z");

      // 每组已只剩一条：再跑一次什么都不变
      await db.query(await readFile(join(MIGRATIONS_DIR, "028_merge_conversation_sessions.sql"), "utf8"));
      expect(await messages("0a")).toHaveLength(7);
      expect(await messages("0d")).toHaveLength(3);
      const live = await db.query("SELECT id FROM conversations WHERE deleted_at IS NULL ORDER BY id");
      expect(live.rows.map((row) => row.id)).toEqual([id("0a"), id("0c"), id("0d")]);
    });
  });
});
