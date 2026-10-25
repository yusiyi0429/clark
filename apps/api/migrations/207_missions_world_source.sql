-- 从本体只读载入的 Mission（missions:load-world）：记下对象身份（scope + 对象 id + 所在域）、本体状态、读取时间和缺项。
-- 同一个本体对象在表里只对应一行；不是从本体载入的行这几列都为空。
ALTER TABLE missions
  ADD COLUMN world_scope_id TEXT,
  ADD COLUMN world_object_id TEXT,
  ADD COLUMN world_domain_id TEXT,
  ADD COLUMN world_status TEXT,
  ADD COLUMN world_status_label TEXT,
  ADD COLUMN world_read_at TIMESTAMPTZ,
  ADD COLUMN world_gaps JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(world_gaps) = 'array'),
  ADD CONSTRAINT missions_world_source_complete CHECK (
    (world_object_id IS NULL AND world_scope_id IS NULL AND world_domain_id IS NULL AND world_status IS NULL AND world_read_at IS NULL)
    OR (world_object_id IS NOT NULL AND world_scope_id IS NOT NULL AND world_domain_id IS NOT NULL AND world_status IS NOT NULL AND world_read_at IS NOT NULL));

CREATE UNIQUE INDEX missions_world_object_idx ON missions (world_scope_id, world_object_id) WHERE world_object_id IS NOT NULL;
