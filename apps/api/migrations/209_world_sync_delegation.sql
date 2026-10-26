-- 代记写入实际用了哪条委托：本体在多条有效委托里自己挑（覆盖动作族与目标分区、最早登记的一条），天枢指定不了，
-- 回执的 on_behalf_of.delegation_event_id 照存，开代记后读回核对（斯一 10/21）。不是代记的写入为空。
ALTER TABLE world_sync_ledger ADD COLUMN delegation_event_id TEXT;
