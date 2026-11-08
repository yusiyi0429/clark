-- 伙伴性格换成 11/08 定的四种（新首页设计稿 17.3）：理性冷静并进沉稳靠谱，较真犀利改叫直言不讳，乐观开朗改叫温和体贴；启发追问是新加的。
UPDATE person_buddies
SET personality = CASE personality WHEN 'calm' THEN 'steady' WHEN 'critical' THEN 'direct' WHEN 'cheerful' THEN 'warm' END
WHERE personality IN ('calm', 'critical', 'cheerful');
