-- 微信 ClawBot（apps/api/src/wechat/）：本人扫码绑定后，在微信里问天枢、收天枢通知。一人一个微信。只新增表。
-- bot token 用 FEISHU_TOKEN_KEY 加密成 ciphertext（key_version 标明钥匙），附加数据绑定 person_id。
-- wechat_user_id：扫码的那个微信用户，只认他发来的消息、只发给他。
-- updates_cursor：收消息的游标；context_token / last_inbound_at：本人最近一条消息带来的会话凭证与时间。
-- proactive_count：本人上次说话后主动推了几次（推送有条数上限，本人一开口清零）；notified_until：已推到哪条通知（按通知时间）。
-- status：active 在用；stale 绑定失效，要重新扫码。welcomed_at：自我介绍发出的时间（本人开口前 bot 的消息送不到，所以第一次开口时才发）。
CREATE TABLE IF NOT EXISTS wechat_bindings (
  person_id text PRIMARY KEY,
  bot_id text NOT NULL,
  wechat_user_id text NOT NULL,
  base_url text NOT NULL,
  key_version integer NOT NULL,
  ciphertext text NOT NULL,
  updates_cursor text NOT NULL DEFAULT '',
  context_token text,
  last_inbound_at timestamptz,
  proactive_count integer NOT NULL DEFAULT 0,
  notified_until timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'stale')),
  welcomed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
