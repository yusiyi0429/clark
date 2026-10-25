-- 卡住（战场进展「需要搭把手」）：推进人在执行事项上写「卡在哪」（≤200 字）和「在等谁」（一个人，可空）；
-- blocked_at 是这次卡住从哪天算起（填上那一刻，改写原因不重算）；清空原因或事项完成时三项一起清掉。
ALTER TABLE tasks
  ADD COLUMN blocked_reason TEXT CHECK (blocked_reason IS NULL OR char_length(blocked_reason) BETWEEN 1 AND 200),
  ADD COLUMN waiting_on TEXT,
  ADD COLUMN blocked_at TIMESTAMPTZ,
  ADD CONSTRAINT tasks_blocker_consistent CHECK ((blocked_reason IS NULL) = (blocked_at IS NULL) AND (waiting_on IS NULL OR blocked_reason IS NOT NULL));
