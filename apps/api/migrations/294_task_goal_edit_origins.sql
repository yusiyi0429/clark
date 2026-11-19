-- 本人改过的完成标准每条是从本体第几条来的（0 起，新加的为 null；和 criteria 一样长）：本月页「原 〈原文〉」按它对、删掉的本体标准按它留在原位置，
-- 不按序号对（删一条再加一条、删第 1 条再改原第 2 条都对得上）。旧的改动没有这一列时按原文、长度一样时按位置推。
ALTER TABLE task_goal_edits ADD COLUMN criteria_from JSONB;
