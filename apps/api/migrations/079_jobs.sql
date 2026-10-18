-- 公共后台任务（jobs.ts）：飞书续期、事件处理等共用一张表，worker 每 5 秒用 FOR UPDATE SKIP LOCKED 领一批。
-- 状态：pending（等到 run_at）→ running（带租约 lease_until，过期视为中断、可被重新领取）→ done；
-- 失败按 1m / 5m / 30m / 2h 退避回到 pending，第 5 次仍失败标 dead。dedupe_key 全局唯一，重复入队不新建。
-- 只新增表与索引，不改已有表。
CREATE TABLE IF NOT EXISTS jobs (
  id bigserial PRIMARY KEY,
  kind text NOT NULL,
  dedupe_key text NOT NULL UNIQUE,
  run_at timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'done', 'dead')),
  attempts integer NOT NULL DEFAULT 0,
  lease_until timestamptz,
  last_error text,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS jobs_due_idx ON jobs (run_at) WHERE status IN ('pending', 'running');
