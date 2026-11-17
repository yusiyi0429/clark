-- 上线注意：新旧两版 api 不能同时跑过这个迁移（旧版写表情用 ON CONFLICT (person_id, scope, run_id, role)，跑过以后这个主键没了，旧版点表情会报错）。
-- 回退 api 时库也要一起回退，回退 SQL（伙伴点的表情会删掉）：
--   DELETE FROM conversation_reactions WHERE reactor = 'buddy';
--   ALTER TABLE conversation_reactions DROP CONSTRAINT conversation_reactions_pkey;
--   ALTER TABLE conversation_reactions ADD PRIMARY KEY (person_id, scope, run_id, role);
--   ALTER TABLE conversation_reactions DROP COLUMN reactor;
-- 表情记是谁点的：person 是本人自己挂的，buddy 是伙伴派活成功后在本人那句话上点的。两边各一行，本人改自己的不动伙伴的。
ALTER TABLE conversation_reactions
  ADD COLUMN reactor text NOT NULL DEFAULT 'person' CHECK (reactor IN ('person','buddy'));
ALTER TABLE conversation_reactions DROP CONSTRAINT conversation_reactions_pkey;
ALTER TABLE conversation_reactions ADD PRIMARY KEY (person_id, scope, run_id, role, reactor);
