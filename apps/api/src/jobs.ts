import type { Pool } from "pg";
import type { Query } from "./meetingStore.js";

/**
 * 公共后台任务（079_jobs.sql）：入队按 dedupe_key 去重；worker 每 5 秒用 FOR UPDATE SKIP LOCKED 领一批，
 * 多个进程同时跑也不会领到同一条。领取时 attempts + 1 并写租约，进程中途退出的任务等租约过期后被重新领取。
 * 失败按 1m / 5m / 30m / 2h 退避，第 5 次仍失败标 dead（管理员视图计数，不再自动重跑）。
 */
export const JOB_BACKOFF_MS = [60_000, 5 * 60_000, 30 * 60_000, 2 * 60 * 60_000];
export const JOB_MAX_ATTEMPTS = JOB_BACKOFF_MS.length + 1;
const DEFAULT_LEASE_MS = 5 * 60_000;

export type JobRow = { id: string; kind: string; dedupe_key: string; attempts: number; payload: unknown };
export type JobHandler = (payload: unknown, job: JobRow) => Promise<void>;

/** 示例 kind：什么也不做，用来验证 worker 链路；真实任务各自注册自己的 kind。 */
export const exampleJobHandlers: Record<string, JobHandler> = {
  "example.noop": async () => {},
};

/** 入队；同一 dedupe_key 已存在（无论状态）时不新建，返回 false。 */
export async function enqueueJob(
  q: Query,
  job: { kind: string; dedupeKey: string; payload?: unknown; runAt?: Date },
): Promise<boolean> {
  const result = await q(
    `INSERT INTO jobs (kind, dedupe_key, payload, run_at) VALUES ($1, $2, $3::jsonb, COALESCE($4::timestamptz, now()))
     ON CONFLICT (dedupe_key) DO NOTHING`,
    [job.kind, job.dedupeKey, JSON.stringify(job.payload ?? {}), job.runAt ?? null],
  );
  return (result.rowCount ?? 0) > 0;
}

/** 周期任务：同一时间窗只入队一次（dedupe_key = kind:窗口序号）。 */
export type RecurringJob = { kind: string; everyMs: number };

export function createJobWorker({
  pool,
  handlers,
  recurring = [],
  now = () => new Date(),
  intervalMs = 5_000,
  batchSize = 10,
  leaseMs = DEFAULT_LEASE_MS,
}: {
  pool: Pool;
  handlers: Record<string, JobHandler>;
  recurring?: RecurringJob[];
  now?: () => Date;
  intervalMs?: number;
  batchSize?: number;
  leaseMs?: number;
}) {
  const q: Query = pool.query.bind(pool);
  const kinds = Object.keys(handlers);
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<void> | undefined;

  async function claim(at: Date): Promise<JobRow[]> {
    const result = await q(
      `UPDATE jobs SET status = 'running', attempts = attempts + 1, lease_until = $2::timestamptz + make_interval(secs => $4::double precision / 1000), updated_at = now()
       WHERE id IN (
         SELECT id FROM jobs
         WHERE kind = ANY($1::text[])
           AND ((status = 'pending' AND run_at <= $2) OR (status = 'running' AND lease_until < $2))
         ORDER BY run_at, id
         LIMIT $3
         FOR UPDATE SKIP LOCKED
       )
       RETURNING id::text, kind, dedupe_key, attempts, payload`,
      [kinds, at, batchSize, leaseMs],
    );
    return result.rows as JobRow[];
  }

  async function finish(job: JobRow, error: unknown): Promise<void> {
    if (error === undefined) {
      await q("UPDATE jobs SET status = 'done', lease_until = NULL, last_error = NULL, updated_at = now() WHERE id = $1", [job.id]);
      return;
    }
    const message = (error instanceof Error ? error.message : String(error)).slice(0, 2000);
    if (job.attempts >= JOB_MAX_ATTEMPTS) {
      await q("UPDATE jobs SET status = 'dead', lease_until = NULL, last_error = $2, updated_at = now() WHERE id = $1", [job.id, message]);
      return;
    }
    const retryAt = new Date(now().getTime() + JOB_BACKOFF_MS[job.attempts - 1]);
    await q("UPDATE jobs SET status = 'pending', run_at = $2, lease_until = NULL, last_error = $3, updated_at = now() WHERE id = $1", [job.id, retryAt, message]);
  }

  /** 入队到期的周期任务，领一批并逐条执行；返回本轮执行的条数。 */
  async function tick(): Promise<number> {
    const at = now();
    for (const job of recurring) {
      await enqueueJob(q, { kind: job.kind, dedupeKey: `${job.kind}:${Math.floor(at.getTime() / job.everyMs)}`, runAt: at });
    }
    const jobs = await claim(at);
    for (const job of jobs) {
      let error: unknown;
      try {
        await handlers[job.kind](job.payload, job);
      } catch (cause) {
        error = cause ?? new Error("job failed");
      }
      await finish(job, error);
    }
    return jobs.length;
  }

  const safeTick = () => {
    if (running) return;
    running = tick()
      .then(() => undefined)
      .catch((cause) => console.warn(`job worker tick failed: ${(cause as Error).message || String(cause)}`))
      .finally(() => { running = undefined; });
  };

  return {
    tick,
    start() {
      if (timer) return;
      safeTick();
      timer = setInterval(safeTick, intervalMs);
      timer.unref();
    },
    async close() {
      if (timer) clearInterval(timer);
      timer = undefined;
      await running;
    },
  };
}
