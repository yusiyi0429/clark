-- 材料的素材性质：real = 真实材料；ai_generated = 没有真实件、由 AI 按资料生成的演示素材（页面标注）。
-- 已有材料与现场上传的一律是 real；只有演示资料包导入时会写 ai_generated（收集表 14 会议材料「素材性质」）。
ALTER TABLE object_materials ADD COLUMN nature TEXT NOT NULL DEFAULT 'real'
  CHECK (nature IN ('real', 'ai_generated'));
