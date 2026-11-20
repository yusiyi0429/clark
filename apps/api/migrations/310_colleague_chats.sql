CREATE TABLE colleague_chats (id UUID PRIMARY KEY, asker_id TEXT NOT NULL, owner_id TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL,
  last_message_at TIMESTAMPTZ NOT NULL, UNIQUE (asker_id, owner_id), CHECK (asker_id <> owner_id));
CREATE TABLE colleague_chat_messages (id UUID PRIMARY KEY, chat_id UUID NOT NULL REFERENCES colleague_chats(id) ON DELETE CASCADE,
  seq BIGINT GENERATED ALWAYS AS IDENTITY, author TEXT NOT NULL CHECK (author IN ('asker','asker_buddy','buddy','owner')),
  body TEXT NOT NULL CHECK (char_length(body) BETWEEN 1 AND 4000), client_id UUID NOT NULL, created_at TIMESTAMPTZ NOT NULL,
  via TEXT NOT NULL DEFAULT 'chat' CHECK (via IN ('chat','main')), run_id TEXT, reply_to UUID, corrects UUID,
  sources JSONB NOT NULL DEFAULT '[]', category TEXT, seen_at TIMESTAMPTZ, retracted_at TIMESTAMPTZ, -- sources：[{itemId,label}]
  answer_state TEXT CHECK (answer_state IN ('answering','answered','failed','limited','asked_owner')), answer_started_at TIMESTAMPTZ,
  wait_reason TEXT CHECK (wait_reason IN ('commit','approve','money_external','asked_owner','no_basis','unsure')),
  wait_at TIMESTAMPTZ, wait_closed_at TIMESTAMPTZ,
  UNIQUE (chat_id, author, client_id), CHECK ((answer_state IS NOT NULL) = (author IN ('asker','asker_buddy'))),
  CHECK ((wait_reason IS NULL) = (wait_at IS NULL)), CHECK (corrects IS NULL OR author = 'owner'));
CREATE INDEX colleague_chat_messages_chat ON colleague_chat_messages (chat_id, seq);
CREATE UNIQUE INDEX colleague_chat_messages_corrects ON colleague_chat_messages (corrects) WHERE corrects IS NOT NULL;
CREATE TABLE colleague_chat_reads (chat_id UUID NOT NULL REFERENCES colleague_chats(id) ON DELETE CASCADE, person_id TEXT NOT NULL,
  last_seq BIGINT NOT NULL, read_at TIMESTAMPTZ NOT NULL, PRIMARY KEY (chat_id, person_id));
CREATE TABLE colleague_friend_settings (person_id TEXT PRIMARY KEY, admission TEXT NOT NULL CHECK (admission IN ('auto','approve')),
  default_agent_ask BOOLEAN NOT NULL, updated_at TIMESTAMPTZ NOT NULL);
CREATE TABLE colleague_friendships (low_id TEXT NOT NULL, high_id TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN ('pending','friends','removed')),
  requested_by TEXT NOT NULL, requested_at TIMESTAMPTZ NOT NULL, decided_at TIMESTAMPTZ, PRIMARY KEY (low_id, high_id), CHECK (low_id < high_id));
CREATE TABLE colleague_friend_grants (grantor_id TEXT NOT NULL, grantee_id TEXT NOT NULL, agent_ask BOOLEAN NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL, PRIMARY KEY (grantor_id, grantee_id));
