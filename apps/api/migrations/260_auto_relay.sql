-- 18 节第 12 条：自动接力的空转保护。auto_relay_limit 是上限（NULL 不限，缺省 20）；auto_relay_count 是本人上次说话以后自动接力了几次
-- （系统触发的项目主管线轮次，加主管线代本人给子会话的转话、重开）；到上限记 auto_relay_paused_at，停止自动触发；
-- auto_relay_asked：「等你」里那条还在（本人点「停下」收起，自动触发照旧停着，等本人说话）。
ALTER TABLE projects ADD COLUMN auto_relay_limit INTEGER DEFAULT 20 CHECK (auto_relay_limit IS NULL OR auto_relay_limit BETWEEN 1 AND 1000);
ALTER TABLE projects ADD COLUMN auto_relay_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE projects ADD COLUMN auto_relay_paused_at TIMESTAMPTZ;
ALTER TABLE projects ADD COLUMN auto_relay_asked BOOLEAN NOT NULL DEFAULT false;
