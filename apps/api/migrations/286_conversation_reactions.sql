-- 本人挂在伙伴台、项目对话里一条消息上的表情：只是本人自己的标记。消息按 runId + role 认（Chat 那边的序号读历史时会重排）。
CREATE TABLE conversation_reactions (
  person_id text NOT NULL,
  scope text NOT NULL,
  run_id text NOT NULL,
  role text NOT NULL CHECK (role IN ('user','assistant')),
  emojis text[] NOT NULL CHECK (cardinality(emojis) BETWEEN 1 AND 3),
  PRIMARY KEY (person_id, scope, run_id, role)
);
