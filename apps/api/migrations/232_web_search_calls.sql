-- V2 第 18 节「联网搜索」：/mcp/me 的只读工具 web_search（本机程序和外部 AI 工具都能调），后台用服务器上的博查钥匙。
-- 每真搜一次记一行：按人限流、按次算钱。只记谁、哪种客户端、什么时候、成没成、几条结果，不记搜了什么。
-- ok 为空是正在搜；client 照个人令牌的 client（local、codex、claude、other）。
CREATE TABLE web_search_calls (
  id UUID PRIMARY KEY,
  person_id TEXT NOT NULL,
  client TEXT NOT NULL,
  at TIMESTAMPTZ NOT NULL,
  ok BOOLEAN,
  result_count INTEGER
);
CREATE INDEX web_search_calls_person_at ON web_search_calls (person_id, at DESC);
