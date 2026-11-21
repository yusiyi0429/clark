-- 会议写本体：任务最后一次仍连不上本体，可能已经写进去了（回包丢了），台账记 unverified（待核验），之后按同一幂等键重放核验。
ALTER TABLE world_sync_ledger DROP CONSTRAINT world_sync_ledger_status_check;
ALTER TABLE world_sync_ledger ADD CONSTRAINT world_sync_ledger_status_check
  CHECK (status IN ('pending', 'committed', 'failed', 'network_error', 'unverified'));
