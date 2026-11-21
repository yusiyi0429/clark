-- 等你里本人忽略的（方案 A，POST /api/me/waiting/:id/ignore）：只从本人的等你里收起，事情本身不动。
-- version 是忽略时这一件的样子（homeWaiting.ts 的 waitingVersion），之后变了就回到等你。一次忽略一行、不改不删，原因留给伙伴以后学怎么筛。
CREATE TABLE waiting_ignores (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  person_id text NOT NULL,
  item_id text NOT NULL,
  version text NOT NULL,
  reason text NOT NULL,
  ignored_at timestamptz NOT NULL
);
CREATE INDEX waiting_ignores_person ON waiting_ignores (person_id);
