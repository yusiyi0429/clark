-- Ticket 12: 每月按 Asia/Shanghai 自动生成的唯一 MonthlyPlan。无 Mission/Todo 实体与执行状态。
CREATE TABLE monthly_plans (
  id UUID PRIMARY KEY,
  version INTEGER NOT NULL CHECK (version > 0),
  period TEXT NOT NULL CHECK (period ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  status TEXT NOT NULL CHECK (status IN ('draft', 'negotiating', 'confirmed')),
  company_outcome TEXT NOT NULL,
  battlefields JSONB NOT NULL,
  todos JSONB NOT NULL,
  negotiation JSONB NOT NULL,
  generation JSONB NOT NULL,
  action_fingerprints JSONB NOT NULL DEFAULT '[]'::jsonb,
  confirmed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 同一 period 只存在一个计划：重复触发与启动补跑都不产生副本。
CREATE UNIQUE INDEX monthly_plans_period ON monthly_plans (period);
