-- 战场进展汇总（battlefieldSummary.ts）：每个战场每天一份 Agent 汇总，生成后不改。
-- 211 曾在 PR #46 的分支上用过（task_auto_done_notification，合入前删掉），本地和预发库可能已记过这个号，这里跳过它。
-- day 是北京时间的日期，period 是那天所在的公司月；goal 是汇总对照的本期目标（本体的本期目标，或月度计划里的战场结果；都没有为 NULL）。
-- progress_until 是输入里最新一条进展（执行事项进展、已提交的周复盘）的时间，没有进展记录为 NULL；summarized_at 是写完的时刻，model 是用的模型 id。
CREATE TABLE battlefield_summaries (
  battlefield_id TEXT NOT NULL REFERENCES battlefield_config(id) ON DELETE CASCADE,
  day DATE NOT NULL,
  period TEXT NOT NULL CHECK (period ~ '^\d{4}-\d{2}$'),
  goal TEXT CHECK (goal IS NULL OR char_length(goal) > 0),
  body TEXT NOT NULL CHECK (char_length(body) > 0),
  progress_until TIMESTAMPTZ,
  summarized_at TIMESTAMPTZ NOT NULL,
  model TEXT NOT NULL CHECK (char_length(model) > 0),
  PRIMARY KEY (battlefield_id, day)
);
