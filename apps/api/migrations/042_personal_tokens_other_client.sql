-- 「连接到外部工具」：除 Codex、Claude Code 外，其他支持远程 MCP 的工具（OpenCode、Cursor 等）也能连；它们写的进展来源记为 other。
ALTER TABLE personal_tokens DROP CONSTRAINT personal_tokens_client_check;
ALTER TABLE personal_tokens ADD CONSTRAINT personal_tokens_client_check CHECK (client IN ('codex', 'claude', 'other'));
ALTER TABLE task_progress DROP CONSTRAINT task_progress_source_check;
ALTER TABLE task_progress ADD CONSTRAINT task_progress_source_check CHECK (source IN ('web', 'codex', 'claude', 'github', 'other'));
