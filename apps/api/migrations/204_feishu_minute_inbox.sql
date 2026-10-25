-- 飞书里直接开的会待整理（feishuMinuteInbox.ts）：上线后飞书视频会议生成、还没对上天枢会议的妙记，只给所有者本人。
-- status：pending 待整理（列在所有者的通知栏）；organized 已整理成新会（meeting_id 是新建的那场）；
--         attached 已记到天枢里约好的会（用户记到或轮询自动挂上，meeting_id 是那场会）；ignored 所有者点了忽略，不再提示。
-- feishu_minute_inbox_launch.launched_at：上线时刻（本迁移执行的时刻）；只登记生成时刻不早于它的妙记，不回溯上线前的会。
CREATE TABLE feishu_minute_inbox (
  minute_token TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  title TEXT NOT NULL,
  starts_at TIMESTAMPTZ NOT NULL,
  ends_at TIMESTAMPTZ NOT NULL CHECK (ends_at >= starts_at),
  feishu_meeting_id TEXT NOT NULL,
  attendee_open_ids JSONB NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(attendee_open_ids) = 'array'),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'organized', 'attached', 'ignored')),
  meeting_id UUID REFERENCES meetings(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((status IN ('organized', 'attached')) = (meeting_id IS NOT NULL))
);
CREATE INDEX feishu_minute_inbox_owner_pending ON feishu_minute_inbox (owner_id, starts_at DESC) WHERE status = 'pending';
CREATE TABLE feishu_minute_inbox_launch (id BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id), launched_at TIMESTAMPTZ NOT NULL DEFAULT now());
INSERT INTO feishu_minute_inbox_launch DEFAULT VALUES;
