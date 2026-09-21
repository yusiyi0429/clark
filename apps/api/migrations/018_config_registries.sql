-- Ticket 21 W5: CEO 配置页写入的 Organization Fact 注册表。表单是确定性输入，但仍由 CEO 显式产生。
-- 战场负责人；goal 复用既有的 positioning 列（战场在该方向的定位/目标）。
ALTER TABLE battlefield_config ADD COLUMN owner TEXT NOT NULL DEFAULT '';

-- 公司能力注册表：注册分组 ∪ Issue 派生分组共同构成首页能力面板。
CREATE TABLE capability_config (
  id TEXT PRIMARY KEY,
  version INTEGER NOT NULL CHECK (version > 0),
  name TEXT NOT NULL,
  "group" TEXT NOT NULL,
  description TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Issue 现在有三种确定性来源：雷达升级、DRI 导入、CEO 直建。
ALTER TABLE issues DROP CONSTRAINT issues_origin_check;
ALTER TABLE issues ADD CONSTRAINT issues_origin_check CHECK (origin IN ('radar', 'dri', 'ceo'));
