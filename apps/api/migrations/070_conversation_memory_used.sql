-- 本轮回答实际装进上下文的个人记忆 id（每轮选进上下文包的、search_personal_memory 返回的），存在助手那条消息上。
-- 回答里 cite:pmem:<id> 的小标记以它为准；为空表示本轮没用到个人记忆。只加可空列，可在已有库上执行。
ALTER TABLE conversation_messages ADD COLUMN IF NOT EXISTS memory_used jsonb;
