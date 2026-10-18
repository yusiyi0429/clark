import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { migrate } from "../src/migrate.js";
import { createJobWorker } from "../src/jobs.js";
import { FeishuApiError } from "../src/feishu/client.js";
import { feishuTokenJobs, refreshPersonToken, scanDueTokens } from "../src/feishu/refresh.js";
import { decryptTokenSecret } from "../src/feishu/crypto.js";
import { saveAuthorizedToken } from "../src/feishu/tokens.js";
import { createTestDb } from "./helpers.js";

const env = { tokenKey: randomBytes(32), tokenKeyVersion: 1 };
const T0 = new Date("2026-10-18T02:00:00Z");
const hours = (n: number) => n * 60 * 60_000;

async function authorize(pool: Pool, personId: string, at: Date, refreshToken = `ur-${personId}`) {
  await pool.query("INSERT INTO feishu_identities (person_id, open_id) VALUES ($1, $2) ON CONFLICT DO NOTHING", [personId, `ou_${personId}`]);
  await saveAuthorizedToken(pool.query.bind(pool), env, personId,
    { accessToken: `u-${personId}`, refreshToken, expiresIn: 7200, refreshExpiresIn: 604800, scope: "offline_access" }, at);
}

describe("飞书 token 续期", () => {
  it("并发续期同一个人只交一次 refresh token（按人加锁）", async () => {
    await createTestDb(async ({ db, pool }) => {
      await migrate(db);
      await authorize(pool, "p1", T0);
      const used: string[] = [];
      const client = {
        async refreshUserToken(refreshToken: string) {
          used.push(refreshToken);
          await new Promise((resolve) => setTimeout(resolve, 50));
          return { accessToken: "u-new", refreshToken: "ur-new", expiresIn: 7200, refreshExpiresIn: 604800, scope: "offline_access" };
        },
      };
      const at = new Date(T0.getTime() + hours(1.9));
      const outcomes = await Promise.all([
        refreshPersonToken({ pool, env, client, personId: "p1", now: at }),
        refreshPersonToken({ pool, env, client, personId: "p1", now: at }),
      ]);
      expect(outcomes.sort()).toEqual(["refreshed", "skipped"]);
      expect(used).toEqual(["ur-p1"]);
      const stored = (await db.query("SELECT ciphertext, status, access_expires_at, authorized_at FROM feishu_user_tokens")).rows[0];
      expect(decryptTokenSecret(env.tokenKey, "p1", stored.ciphertext)).toEqual({ accessToken: "u-new", refreshToken: "ur-new" });
      expect(stored.status).toBe("active");
      expect(stored.access_expires_at).toEqual(new Date(at.getTime() + hours(2)));
      // authorized_at 不因续期重新计时
      expect(stored.authorized_at).toEqual(T0);
    });
  });

  it("20037 标为需重新授权，不再重试；其他错误交给 jobs 退避", async () => {
    await createTestDb(async ({ db, pool }) => {
      await migrate(db);
      await authorize(pool, "expired", T0);
      await authorize(pool, "flaky", T0);
      const client = {
        async refreshUserToken(refreshToken: string): Promise<never> {
          if (refreshToken === "ur-expired") throw new FeishuApiError(20037, "refresh token expired");
          throw new FeishuApiError(20050, "internal error");
        },
      };
      const at = new Date(T0.getTime() + hours(2));
      await expect(refreshPersonToken({ pool, env, client, personId: "expired", now: at })).resolves.toBe("reauth_required");
      await expect(refreshPersonToken({ pool, env, client, personId: "flaky", now: at })).rejects.toThrow("internal error");
      expect((await db.query("SELECT person_id, status, last_error FROM feishu_user_tokens ORDER BY person_id")).rows).toEqual([
        { person_id: "expired", status: "reauth_required", last_error: "飞书 20037：refresh token expired" },
        { person_id: "flaky", status: "active", last_error: "飞书 20050：internal error" },
      ]);

      // 走 jobs：扫描只排 active 的 flaky；失败后进入 1 分钟退避
      const jobs = feishuTokenJobs({ pool, env, client, now: () => at });
      const worker = createJobWorker({ pool, handlers: jobs.handlers, recurring: jobs.recurring, now: () => at });
      await worker.tick(); // 本轮：周期扫描入队续期任务
      await worker.tick(); // 下一轮：执行续期
      expect((await db.query("SELECT kind, status, attempts, payload FROM jobs ORDER BY id")).rows).toEqual([
        { kind: "feishu.token_refresh_scan", status: "done", attempts: 1, payload: {} },
        { kind: "feishu.token_refresh", status: "pending", attempts: 1, payload: { personId: "flaky" } },
      ]);
    });
  });

  it("扫描：只排 15 分钟内到期的 token；授权满 330 天打提醒", async () => {
    await createTestDb(async ({ db, pool }) => {
      await migrate(db);
      const now = new Date("2027-10-01T00:00:00Z");
      await authorize(pool, "fresh", now);
      await authorize(pool, "due", new Date(now.getTime() - hours(1.8)));
      await authorize(pool, "old", new Date(now.getTime() - 331 * hours(24)));
      expect(await scanDueTokens(pool, now)).toBe(2);
      expect(await scanDueTokens(pool, now)).toBe(0);
      expect((await db.query("SELECT payload->>'personId' AS person FROM jobs ORDER BY payload->>'personId'")).rows).toEqual([{ person: "due" }, { person: "old" }]);
      expect((await db.query("SELECT person_id FROM feishu_user_tokens WHERE reauth_reminder_at IS NOT NULL")).rows).toEqual([{ person_id: "old" }]);
    });
  });
});
