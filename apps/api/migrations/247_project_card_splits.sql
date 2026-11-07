-- 新首页 16.3：没挂 Task 的项目也能拆卡。登记、计划、草稿、规划员会话可以只挂项目（project_id），不挂 Task（plan_task_id、mission_id 为空）。
-- 挂 Task 的照旧；两样至少有一样。同一个人同一个项目同时只有一条没开工的项目登记。
ALTER TABLE card_split_requests
  ALTER COLUMN plan_task_id DROP NOT NULL,
  ALTER COLUMN mission_id DROP NOT NULL,
  ALTER COLUMN task_name DROP NOT NULL,
  ADD COLUMN project_id UUID REFERENCES projects (id) ON DELETE CASCADE,
  ADD CONSTRAINT card_split_requests_subject CHECK (plan_task_id IS NOT NULL OR project_id IS NOT NULL);
CREATE UNIQUE INDEX card_split_requests_open_project ON card_split_requests (owner_id, project_id) WHERE closed_at IS NULL AND plan_task_id IS NULL;

ALTER TABLE card_plans
  ALTER COLUMN plan_task_id DROP NOT NULL,
  ALTER COLUMN mission_id DROP NOT NULL,
  ADD COLUMN project_id UUID REFERENCES projects (id) ON DELETE CASCADE,
  ADD CONSTRAINT card_plans_subject CHECK (plan_task_id IS NOT NULL OR project_id IS NOT NULL);

ALTER TABLE card_drafts
  ALTER COLUMN plan_task_id DROP NOT NULL,
  ADD COLUMN project_id UUID REFERENCES projects (id) ON DELETE CASCADE,
  ADD CONSTRAINT card_drafts_subject CHECK (plan_task_id IS NOT NULL OR project_id IS NOT NULL);
CREATE INDEX card_drafts_open_project ON card_drafts (project_id, owner_id) WHERE status = 'open' AND plan_task_id IS NULL;

-- 规划员会话：拆 Task 的带 plan_task_id，拆项目的带 project_id。
ALTER TABLE local_runs ADD COLUMN project_id UUID;
ALTER TABLE local_runs DROP CONSTRAINT local_runs_subject_check;
ALTER TABLE local_runs ADD CONSTRAINT local_runs_subject_check
  CHECK ((kind IN ('card', 'verify')) = (task_id IS NOT NULL) AND (kind = 'topic') = (topic_id IS NOT NULL)
    AND (kind <> 'plan' OR plan_task_id IS NOT NULL OR project_id IS NOT NULL) AND (kind = 'plan' OR plan_task_id IS NULL));
