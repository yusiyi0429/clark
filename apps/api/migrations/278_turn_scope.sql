-- 使用计数（设计第 70 条）：走 Chat 的每一轮记下是伙伴对话还是项目对话，好分开数轮数。只记哪一种，不记内容。老的为 NULL。
ALTER TABLE chat_turn_models ADD COLUMN scope_kind TEXT CHECK (scope_kind IN ('buddy', 'project'));
CREATE INDEX chat_turn_models_recorded ON chat_turn_models (recorded_at);
