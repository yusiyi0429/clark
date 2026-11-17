-- 表情记是谁点的：person 是本人自己挂的，buddy 是伙伴派活成功后在本人那句话上点的。两边各一行，本人改自己的不动伙伴的。
ALTER TABLE conversation_reactions
  ADD COLUMN reactor text NOT NULL DEFAULT 'person' CHECK (reactor IN ('person','buddy'));
ALTER TABLE conversation_reactions DROP CONSTRAINT conversation_reactions_pkey;
ALTER TABLE conversation_reactions ADD PRIMARY KEY (person_id, scope, run_id, role, reactor);
