-- 只保存本人自填的可选资料；旧成员不回填，人员身份仍来自只读目录。
CREATE TABLE person_profiles (
  person_id TEXT PRIMARY KEY,
  gender TEXT CHECK (gender IS NULL OR char_length(gender) <= 40)
);
