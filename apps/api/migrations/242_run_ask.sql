-- 新首页 9.6：本机最近一次状态里在问本人的提问（idle 带 question），或在等批准的那一步（waiting_permission 带 permission）。
-- 只有这两种进「等你」；一轮做完停下（idle 不带 question）不进。{ kind: "question" | "permission", request }，没有为 null。
ALTER TABLE local_runs ADD COLUMN ask JSONB;
