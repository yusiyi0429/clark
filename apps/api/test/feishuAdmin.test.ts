import { describe, expect, it } from "vitest";
import { migrate } from "../src/migrate.js";
import { feishuAdminSummary } from "../src/feishu/admin.js";
import { createTestDb } from "./helpers.js";

describe("管理员视图的飞书汇总", () => {
  it("空库全为 0；按状态计数 jobs 失败与 dead、令牌分布、最近事件时间", async () => {
    await createTestDb(async ({ db, pool }) => {
      await migrate(db);
      const q = pool.query.bind(pool);
      expect(await feishuAdminSummary(q)).toEqual({
        jobs: { failing: 0, dead: 0 }, tokens: { active: 0, reauthRequired: 0, reauthReminders: 0 }, lastEventAt: null,
      });

      await db.query(`INSERT INTO jobs (kind, dedupe_key, status, attempts, last_error) VALUES
        ('k', 'ok', 'done', 1, NULL), ('k', 'new', 'pending', 0, NULL), ('k', 'retry', 'pending', 2, 'boom'), ('k', 'dead', 'dead', 5, 'boom')`);
      await db.query("INSERT INTO feishu_identities (person_id, open_id) VALUES ('a', 'ou_a'), ('b', 'ou_b'), ('c', 'ou_c')");
      await db.query(`INSERT INTO feishu_user_tokens (person_id, key_version, ciphertext, access_expires_at, authorized_at, status, reauth_reminder_at) VALUES
        ('a', 1, 'x', now(), now(), 'active', NULL), ('b', 1, 'x', now(), now(), 'active', now()), ('c', 1, 'x', now(), now(), 'reauth_required', NULL)`);
      const last = new Date("2026-10-18T03:00:00Z");
      await db.query("INSERT INTO feishu_events (dedupe_key, event_type, payload, received_at) VALUES ('event:1', 't', '{}', $1), ('event:2', 't', '{}', $2)",
        [new Date("2026-10-18T01:00:00Z"), last]);

      expect(await feishuAdminSummary(q)).toEqual({
        jobs: { failing: 1, dead: 1 }, tokens: { active: 2, reauthRequired: 1, reauthReminders: 1 }, lastEventAt: last,
      });
    });
  });
});
