-- 雷达自动升级的议题是 AI 识别的候选议题：补上 origin_ref.nature = ai_suggested（界面标「AI 建议」，见 dataOrigin.ts）。
-- 新升级的议题由 radar.ts 写入时就带；这里只回填已有的雷达议题，其他来源不动。
UPDATE issues
SET origin_ref = origin_ref || '{"nature":"ai_suggested"}'::jsonb
WHERE origin = 'radar'
  AND jsonb_typeof(origin_ref) = 'object'
  AND (origin_ref->>'nature') IS DISTINCT FROM 'ai_suggested';
