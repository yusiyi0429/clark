-- 去掉会话：每个人在每个页面只有一条连续对话（owner_id × scope 一条）。
-- 同组里最早（created_at, id）的未删除会话为主对话；其余会话的消息并入主对话，
-- 按（created_at, conversation_id, sequence）与主对话原有消息交错排序、序号重排为 1..N；其余会话软删除。
-- 主对话的 Pi 运行态（runtime_entries / pi_session_id）不动。附件文件不搬：历史消息只保留附件元数据用于展示。
-- owner_id 此时可能为空（启动时迁移之后才归到 CEO）：空 owner 自成一组，这些都是 CEO 的旧对话，合在一起正确。
-- 每组只有一条会话时本迁移什么都不做。
CREATE TEMP TABLE conversation_merge AS
SELECT id, main_id
  FROM (
    SELECT id,
           first_value(id) OVER (PARTITION BY owner_id, scope ORDER BY created_at, id) AS main_id,
           count(*) OVER (PARTITION BY owner_id, scope) AS group_size
      FROM conversations
     WHERE deleted_at IS NULL
  ) grouped
 WHERE group_size > 1;

-- 主键是 (conversation_id, sequence)：先算好新行，再删旧行、插新行。
CREATE TEMP TABLE conversation_merge_messages AS
SELECT g.main_id AS conversation_id,
       row_number() OVER (PARTITION BY g.main_id ORDER BY m.created_at, m.conversation_id, m.sequence)::int AS sequence,
       m.role, m.content, m.references_snapshot, m.attachments, m.run_id, m.created_at
  FROM conversation_messages m
  JOIN conversation_merge g ON g.id = m.conversation_id;

DELETE FROM conversation_messages WHERE conversation_id IN (SELECT id FROM conversation_merge);

INSERT INTO conversation_messages (conversation_id, sequence, role, content, references_snapshot, attachments, run_id, created_at)
SELECT conversation_id, sequence, role, content, references_snapshot, attachments, run_id, created_at
  FROM conversation_merge_messages;

UPDATE conversations SET deleted_at = now()
 WHERE id IN (SELECT id FROM conversation_merge WHERE id <> main_id);

DROP TABLE conversation_merge_messages;
DROP TABLE conversation_merge;
