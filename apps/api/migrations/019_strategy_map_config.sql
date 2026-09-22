-- Ticket 26 W1: 结构化战场图长期配置。迁移只改结构，不写图片业务数据（W5 通过应用/受控 SQL 导入）。
-- 六个核心实体不变：Issue、Signal、Meeting、MeetingOutcome、MonthlyPlan、Conversation。
-- Mission 只是 battlefield_config.missions 里的内嵌值对象 {code,title}，没有表、状态机或进度。

-- CompanyStrategyConfig：跨月稳定的公司长期目标（LTCO）。与当月 PCO 分开，MonthlyPlan 只保存当月结果。
CREATE TABLE company_strategy_config (
  id TEXT PRIMARY KEY,
  version INTEGER NOT NULL CHECK (version > 0),
  ltco TEXT NOT NULL DEFAULT '',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO company_strategy_config (id, version, ltco) VALUES ('default', 1, '');

-- BattlefieldConfig：战场是长期配置；六个月目标取代 positioning，负责人只存 personId（投影时现查 displayName）。
ALTER TABLE battlefield_config RENAME COLUMN positioning TO six_month_outcome;
ALTER TABLE battlefield_config RENAME COLUMN owner TO owner_id;
ALTER TABLE battlefield_config ADD COLUMN code TEXT NOT NULL DEFAULT '';
ALTER TABLE battlefield_config ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0 CHECK (sort_order BETWEEN 0 AND 9999);
ALTER TABLE battlefield_config ADD COLUMN missions JSONB NOT NULL DEFAULT '[]'::jsonb;

-- code 非空时同表唯一：空 code 是迁移期未编号的旧行，不参与唯一性。
CREATE UNIQUE INDEX battlefield_config_code_key ON battlefield_config (code) WHERE code <> '';

-- CapabilityConfig：description 改称六个月目标，新增显示编号/顺序与结构化主要支撑引用；group 保留但允许空。
ALTER TABLE capability_config RENAME COLUMN description TO six_month_outcome;
ALTER TABLE capability_config ADD COLUMN code TEXT NOT NULL DEFAULT '';
ALTER TABLE capability_config ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0 CHECK (sort_order BETWEEN 0 AND 9999);
ALTER TABLE capability_config ADD COLUMN support_refs JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE capability_config ALTER COLUMN "group" SET DEFAULT '';
CREATE UNIQUE INDEX capability_config_code_key ON capability_config (code) WHERE code <> '';

-- 当月能力 PCO：与 battlefields 同构的内嵌快照，只属于 MonthlyPlan，不写回能力注册表。
ALTER TABLE monthly_plans ADD COLUMN capabilities JSONB NOT NULL DEFAULT '[]'::jsonb;
