-- 飞书接入（apps/api/src/feishu/）：身份映射、用户令牌、长连接事件。只新增表与索引。
-- feishu_identities：天枢人员 ↔ 本应用下的飞书 open_id，一人一个、一个 open_id 只对应一人。
CREATE TABLE IF NOT EXISTS feishu_identities (
  person_id text PRIMARY KEY,
  open_id text NOT NULL UNIQUE,
  union_id text,
  name text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- feishu_user_tokens：access/refresh token 用 AES-256-GCM 加密成一段密文（FEISHU_TOKEN_KEY，key_version 标明用哪把钥匙），
-- 附加数据绑定 person_id，密文不能挪到别人名下。refresh token 只能用一次，续期时按人锁这一行。
-- status：active 可用；reauth_required 需要本人重新授权（20037 等）。reauth_reminder_at：授权满 330 天时打上，提醒提前重新授权。
CREATE TABLE IF NOT EXISTS feishu_user_tokens (
  person_id text PRIMARY KEY REFERENCES feishu_identities (person_id) ON DELETE CASCADE,
  key_version integer NOT NULL,
  ciphertext text NOT NULL,
  scope text NOT NULL DEFAULT '',
  access_expires_at timestamptz NOT NULL,
  refresh_expires_at timestamptz,
  authorized_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'reauth_required')),
  reauth_reminder_at timestamptz,
  last_refreshed_at timestamptz,
  last_error text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS feishu_user_tokens_due_idx ON feishu_user_tokens (access_expires_at) WHERE status = 'active';

-- feishu_events：长连接收到的事件原样落库就 ack；dedupe_key 是 message:<message_id> 或 event:<event_id>（至少投递一次，靠它去重）。
-- 后续处理交给 jobs（feishu.event），处理完写 processed_at。
CREATE TABLE IF NOT EXISTS feishu_events (
  id bigserial PRIMARY KEY,
  dedupe_key text NOT NULL UNIQUE,
  event_type text NOT NULL,
  event_id text,
  payload jsonb NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz
);

CREATE INDEX IF NOT EXISTS feishu_events_received_idx ON feishu_events (received_at DESC);
