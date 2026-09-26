-- 成员登录凭据：登录 ID + 4 位口令（scrypt 散列）。person_id 对应 company-people seed，不建外键（seed 在文件里）。
-- session_version：改口令或管理员重置时加一，签在会话里的旧版本随即失效。
CREATE TABLE member_access (
  person_id TEXT PRIMARY KEY,
  login_id TEXT NOT NULL UNIQUE CHECK (login_id ~ '^[a-z]{2,20}$'),
  passcode_hash TEXT NOT NULL,
  must_change BOOLEAN NOT NULL DEFAULT TRUE,
  failed_count INTEGER NOT NULL DEFAULT 0 CHECK (failed_count >= 0),
  locked_until TIMESTAMPTZ,
  session_version INTEGER NOT NULL DEFAULT 1 CHECK (session_version > 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
