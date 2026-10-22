-- 在飞书约上的会跟着飞书会议真实开始和结束（meetingMinutes.ts 接「会议开始 / 会议结束」事件）：
-- started_at：飞书会议真实开始的时刻，只记第一次；改期（开始时间变了）时和 ended_at 一起清掉。
-- 结束沿用 ended_at（025，与主持人点「结束会议」同一格），飞书会议 id 沿用 feishu_meeting_id（086），不另加列。
ALTER TABLE meetings ADD COLUMN started_at TIMESTAMPTZ;
