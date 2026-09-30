-- 多次澄清保留每一问、每一答，模型和最终审核都能沿用完整语境。
ALTER TABLE mission_card_annotations ADD COLUMN clarification_history JSONB NOT NULL DEFAULT '[]'::jsonb
  CHECK (jsonb_typeof(clarification_history) = 'array');
