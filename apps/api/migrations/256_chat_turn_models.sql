-- 回话带上这一轮实际用的来源和模型（项目对话、伙伴台走 Chat 的那一路）：Chat 每次调完模型在 usage 事件里报 provider、model，
-- 天枢转流时记下这一轮最后一次的（Chat 的历史不带），读历史时接到那一轮的回答上。只记来源和模型名，不记钥匙、地址。
CREATE TABLE chat_turn_models (
  run_id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX chat_turn_models_owner ON chat_turn_models (owner_id, run_id);
