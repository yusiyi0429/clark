-- 本人上传的头像照片（网页先裁成 256×256 再传）。没有这一行的人显示名字里的一个字；删照片就删这一行。
CREATE TABLE person_avatars (
  person_id TEXT PRIMARY KEY,
  image BYTEA NOT NULL,
  image_type TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
