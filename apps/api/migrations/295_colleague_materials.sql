-- 对外资料（同事的伙伴能读的）：每人一份说明、若干文件（只存抽出的文字）；技能上一个「同事可用」。
CREATE TABLE colleague_notes (
  owner_id TEXT PRIMARY KEY,
  body TEXT NOT NULL CHECK (char_length(body) BETWEEN 1 AND 20000),
  updated_at TIMESTAMPTZ NOT NULL
);
CREATE TABLE colleague_files (
  id UUID PRIMARY KEY,
  owner_id TEXT NOT NULL,
  file_name TEXT NOT NULL CHECK (char_length(file_name) BETWEEN 1 AND 255),
  size INTEGER NOT NULL CHECK (size BETWEEN 1 AND 20971520),
  sha256 TEXT NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  extracted_text TEXT NOT NULL CHECK (char_length(extracted_text) BETWEEN 1 AND 100000),
  created_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX colleague_files_owner ON colleague_files (owner_id, created_at);
ALTER TABLE roles ADD COLUMN shared_with_colleagues BOOLEAN NOT NULL DEFAULT false;
