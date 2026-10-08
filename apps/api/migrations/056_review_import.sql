-- 导入飞书月度复盘（10 月首轮上线 · 工单 01）。导入标记只影响这一轮复盘：
-- 战场项和有当月 Mission 的能力域项在个人复盘交齐后由 Co-Agent 起草，起草成功直接确认，不走负责人提交和 CEO 逐项确认。
ALTER TABLE monthly_reviews ADD COLUMN origin TEXT CHECK (origin IN ('import'));

-- 确认来源：ceo 为 CEO 逐项确认；import 为导入的复盘直接确认，没有确认人。已确认的旧项都是 CEO 确认的。
ALTER TABLE monthly_review_items ADD COLUMN confirmation_source TEXT CHECK (confirmation_source IN ('ceo', 'import'));
UPDATE monthly_review_items SET confirmation_source = 'ceo' WHERE status = 'confirmed';

-- 个人复盘：飞书原文导入为已提交（draft_source = import）；没有月度复盘的人，导入周复盘与任务卡原文给 Co-Agent 起草。
ALTER TABLE personal_reviews DROP CONSTRAINT personal_reviews_draft_source_check;
ALTER TABLE personal_reviews ADD CONSTRAINT personal_reviews_draft_source_check
  CHECK (draft_source IN ('agent_tool', 'co_agent', 'manual', 'import'));
-- [{title, sourceRef, markdown}]
ALTER TABLE personal_reviews ADD COLUMN imported_materials JSONB NOT NULL DEFAULT '[]'::jsonb
  CHECK (jsonb_typeof(imported_materials) = 'array');
