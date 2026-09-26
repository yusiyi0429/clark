-- 02d B：声纹预填说话人（腾讯云说话人注册 + 1:N）。一个人一条声纹，本人录、本人删。
-- 声纹是敏感个人信息（生物识别）：consented_at 记本人明确同意的时刻，必填；每次重录重新记。
-- 库里只存腾讯返回的 VoicePrintId 与所在分组，不存任何音频。person_id 对应 company-people seed，不建外键（seed 在文件里）。
CREATE TABLE person_voiceprints (
  person_id TEXT PRIMARY KEY,
  provider_voiceprint_id TEXT NOT NULL,
  group_id TEXT NOT NULL,
  consented_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
