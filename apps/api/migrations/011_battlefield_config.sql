-- Ticket 13: BattlefieldConfig 注册表与普通待办的真实 DRI 外发状态。无 Mission/Todo 实体。
CREATE TABLE battlefield_config (
  id TEXT PRIMARY KEY,
  version INTEGER NOT NULL CHECK (version > 0),
  name TEXT NOT NULL,
  positioning TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- MVP 确定性注册表：fixture 公司当前唯一战场。新增/替换战场仍走 migration，不建配置编辑页面。
INSERT INTO battlefield_config (id, version, name, positioning)
VALUES ('growth', 1, '增长战场', '验证渠道结构与交付节奏，形成可复制的增长路径。');

-- 普通待办的外发快照：WarMap 不跟踪执行状态，只如实记录是否已按真实渠道发出。
ALTER TABLE monthly_plans ADD COLUMN exports JSONB NOT NULL DEFAULT '[]'::jsonb;
