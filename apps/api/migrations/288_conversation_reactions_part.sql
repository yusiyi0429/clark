-- 上线注意：新旧两版 api 不能同时跑过这个迁移（旧版写表情用 ON CONFLICT (person_id, scope, run_id, role, reactor)，跑过以后这个主键没了，旧版点表情会报错）。
-- 回退 api 时库也要一起回退，回退 SQL（一条消息上本人按块点的只留块号最大的那一个）：
--   DELETE FROM conversation_reactions c USING conversation_reactions d
--     WHERE (c.person_id, c.scope, c.run_id, c.role, c.reactor) = (d.person_id, d.scope, d.run_id, d.role, d.reactor) AND c.part < d.part;
--   ALTER TABLE conversation_reactions DROP CONSTRAINT conversation_reactions_pkey;
--   ALTER TABLE conversation_reactions ADD PRIMARY KEY (person_id, scope, run_id, role, reactor);
--   ALTER TABLE conversation_reactions DROP COLUMN part;
-- 表情按块记：part 是这条消息的第几块（伙伴回答拆成的气泡或卡片，从 0 数）；-1 是「这条消息的最后一块」，只给这之前的老数据。
-- 本人每块一个（emojis 只有一个）；伙伴的 👍 点在本人的话上，本人的话只有一块，记在第 0 块。
ALTER TABLE conversation_reactions ADD COLUMN part integer NOT NULL DEFAULT -1;
UPDATE conversation_reactions SET part = 0 WHERE reactor = 'buddy';
-- 老数据里本人的一组多个只留第一个（本地测试数据，未上线）。
UPDATE conversation_reactions SET emojis = emojis[1:1] WHERE reactor = 'person' AND cardinality(emojis) > 1;
ALTER TABLE conversation_reactions DROP CONSTRAINT conversation_reactions_pkey;
ALTER TABLE conversation_reactions ADD PRIMARY KEY (person_id, scope, run_id, role, reactor, part);
