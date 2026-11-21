-- 本人的伙伴（本人的 Agent 统称伙伴）：本人起的名字和选的外形，跟着人走。外形清单只在契约里校验，加外形不用改表。
CREATE TABLE person_buddies (
  person_id TEXT PRIMARY KEY,
  name TEXT NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 12),
  form TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
