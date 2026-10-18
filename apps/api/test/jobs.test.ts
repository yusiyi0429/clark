import { describe, expect, it } from "vitest";
import { migrate } from "../src/migrate.js";
import { createJobWorker, enqueueJob, exampleJobHandlers, JOB_BACKOFF_MS } from "../src/jobs.js";
import { createTestDb } from "./helpers.js";

const T0 = new Date("2026-10-18T02:00:00Z");

describe("jobs", () => {
  it("同一 dedupe_key 只入队一次；示例 kind 跑完标 done", async () => {
    await createTestDb(async ({ db, pool }) => {
      await migrate(db);
      const q = pool.query.bind(pool);
      expect(await enqueueJob(q, { kind: "example.noop", dedupeKey: "example.noop:1", runAt: T0 })).toBe(true);
      expect(await enqueueJob(q, { kind: "example.noop", dedupeKey: "example.noop:1", runAt: T0 })).toBe(false);
      const worker = createJobWorker({ pool, handlers: exampleJobHandlers, now: () => T0 });
      expect(await worker.tick()).toBe(1);
      expect((await db.query("SELECT status, attempts, lease_until FROM jobs")).rows).toEqual([{ status: "done", attempts: 1, lease_until: null }]);
      expect(await worker.tick()).toBe(0);
    });
  });

  it("失败按 1m/5m/30m/2h 退避，第 5 次仍失败标 dead", async () => {
    await createTestDb(async ({ db, pool }) => {
      await migrate(db);
      let clock = T0;
      const worker = createJobWorker({ pool, handlers: { "test.fail": async () => { throw new Error("boom"); } }, now: () => clock });
      await enqueueJob(pool.query.bind(pool), { kind: "test.fail", dedupeKey: "test.fail:1", runAt: T0 });
      const row = async () => (await db.query("SELECT status, attempts, run_at, last_error FROM jobs")).rows[0];
      for (const [index, delay] of JOB_BACKOFF_MS.entries()) {
        expect(await worker.tick()).toBe(1);
        const after = await row();
        expect(after).toMatchObject({ status: "pending", attempts: index + 1, last_error: "boom" });
        expect((after.run_at as Date).getTime()).toBe(clock.getTime() + delay);
        // 还没到重试时间不领
        clock = new Date(clock.getTime() + delay - 1);
        expect(await worker.tick()).toBe(0);
        clock = new Date(clock.getTime() + 1);
      }
      expect(await worker.tick()).toBe(1);
      expect(await row()).toMatchObject({ status: "dead", attempts: 5, last_error: "boom" });
      clock = new Date(clock.getTime() + 24 * 60 * 60_000);
      expect(await worker.tick()).toBe(0);
    });
  });

  it("两个 worker 同时领取不会拿到同一条（SKIP LOCKED）", async () => {
    await createTestDb(async ({ db, pool }) => {
      await migrate(db);
      const q = pool.query.bind(pool);
      for (let i = 0; i < 6; i += 1) await enqueueJob(q, { kind: "test.slow", dedupeKey: `test.slow:${i}`, runAt: T0 });
      const ran: string[] = [];
      const handlers = { "test.slow": async (_payload: unknown, job: { dedupe_key: string }) => {
        ran.push(job.dedupe_key);
        await new Promise((resolve) => setTimeout(resolve, 30));
      } };
      const a = createJobWorker({ pool, handlers, now: () => T0, batchSize: 3 });
      const b = createJobWorker({ pool, handlers, now: () => T0, batchSize: 3 });
      const [ranA, ranB] = await Promise.all([a.tick(), b.tick()]);
      expect(ranA + ranB).toBe(6);
      expect(new Set(ran).size).toBe(6);
      expect((await db.query("SELECT count(*)::int AS n FROM jobs WHERE status = 'done' AND attempts = 1")).rows[0].n).toBe(6);
    });
  });

  it("租约过期的 running 任务会被重新领取；周期任务每个时间窗只入队一次", async () => {
    await createTestDb(async ({ db, pool }) => {
      await migrate(db);
      await db.query("INSERT INTO jobs (kind, dedupe_key, status, attempts, lease_until, run_at) VALUES ('example.noop', 'stale', 'running', 1, $1, $1)", [new Date(T0.getTime() - 1000)]);
      let clock = T0;
      const worker = createJobWorker({ pool, handlers: exampleJobHandlers, recurring: [{ kind: "example.noop", everyMs: 10 * 60_000 }], now: () => clock });
      expect(await worker.tick()).toBe(2);
      clock = new Date(T0.getTime() + 60_000);
      expect(await worker.tick()).toBe(0);
      clock = new Date(T0.getTime() + 10 * 60_000);
      expect(await worker.tick()).toBe(1);
      expect((await db.query("SELECT dedupe_key, status, attempts FROM jobs ORDER BY id")).rows).toEqual([
        { dedupe_key: "stale", status: "done", attempts: 2 },
        { dedupe_key: `example.noop:${Math.floor(T0.getTime() / 600_000)}`, status: "done", attempts: 1 },
        { dedupe_key: `example.noop:${Math.floor(T0.getTime() / 600_000) + 1}`, status: "done", attempts: 1 },
      ]);
    });
  });
});
