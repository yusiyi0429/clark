-- Mission 周期收紧到与 MonthlyPlan 同口径：月份只接受 01–12。
-- 021 已建库的环境里 CHECK 是宽松的 ^[0-9]{4}-[0-9]{2}$，这里原地替换；021 本身也已改严格，fresh 建库两边一致。
ALTER TABLE missions DROP CONSTRAINT missions_period_check;
ALTER TABLE missions ADD CONSTRAINT missions_period_check CHECK (period ~ '^\d{4}-(0[1-9]|1[0-2])$');
