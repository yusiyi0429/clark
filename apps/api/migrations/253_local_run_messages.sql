-- 新首页 17.4：子会话里本人在网页上说的话和回执（本机同步条目 user_message、receipt，契约 localRunner.ts）。手机端和网页从卡、专题详情的 runs[].messages 读。
-- 一句话一行：text 是原话（回执比话先到时先为空，话到了补上），attachments 只有文件名；receipt 以本机序号最新的为准（delivered → read，或 delivered → failed）。
CREATE TABLE local_run_messages (
  run_id UUID NOT NULL REFERENCES local_runs (id) ON DELETE CASCADE,
  message_id UUID NOT NULL,
  owner_id TEXT NOT NULL,
  text TEXT,
  attachments TEXT[] NOT NULL DEFAULT '{}',
  sent_at TIMESTAMPTZ,
  receipt TEXT CHECK (receipt IN ('delivered', 'read', 'failed')),
  receipt_seq BIGINT,
  receipt_at TIMESTAMPTZ,
  PRIMARY KEY (run_id, message_id)
);
