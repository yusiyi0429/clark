-- 天枢约会时自动在飞书约上（meetingFeishuEvent.ts）：用建会的人（没记按主持人）本人的飞书授权，在他的主日历建日程（带飞书视频会议、自动录制、邀请参会人），
-- 会后妙记自然归他，按「主持人→建会的人」的授权就找得到。改时间更新日程，取消删除日程。没配飞书的实例这几格一直为空。
-- feishu_event_status：pending 排上了还没约 / booked 约上了 / waiting_auth 建会的人还没连飞书（或授权里没有日历权限），连上后补约 /
--   failed 飞书报错（feishu_event_error 记原因，队列照常退避重试，主持人也能点重试）/ cancelled 会取消了、日程已删；NULL 是不约（旧会、外部导入、没配飞书）。
-- feishu_event_organizer_id：约的时候用的是谁（天枢 person_id）；改时间、取消都用他的授权。feishu_event_join_url：进入飞书会议的链接。
ALTER TABLE meetings
  ADD COLUMN feishu_event_status TEXT CHECK (feishu_event_status IS NULL OR feishu_event_status IN ('pending', 'booked', 'waiting_auth', 'failed', 'cancelled')),
  ADD COLUMN feishu_calendar_id TEXT,
  ADD COLUMN feishu_event_id TEXT,
  ADD COLUMN feishu_event_join_url TEXT,
  ADD COLUMN feishu_event_organizer_id TEXT,
  ADD COLUMN feishu_event_error TEXT;
