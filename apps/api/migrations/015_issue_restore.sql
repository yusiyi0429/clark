-- dismissed Issue 的恢复是独立 Action：幂等重放需要持久 restore 指纹；
-- dismissed_at / dismiss_reason / dismiss_fingerprint 保留为移出审计，恢复时不删除。
ALTER TABLE issues ADD COLUMN restored_at timestamptz;
ALTER TABLE issues ADD COLUMN restore_fingerprint text;
