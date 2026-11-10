-- 17.2 第 25 条：左栏蓝点只是提醒，点进去就消失。本人看过子会话（sub，卡或专题的 id）、项目对话（project）的时间，按人记，手机和电脑一致。
CREATE TABLE work_seen (
  person_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('sub', 'project')),
  object_id UUID NOT NULL,
  seen_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (person_id, kind, object_id)
);
-- 项目对话（接了 Chat 的）最近一次回完一轮的时间：Chat 的消息不在天枢库里，回完时记一下；天枢自己的对话直接读消息。
ALTER TABLE projects ADD COLUMN pipeline_reply_at TIMESTAMPTZ;
