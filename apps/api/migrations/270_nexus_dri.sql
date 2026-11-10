-- Nexus → DRI 确认（nexus-dri-confirmation/0.1）：Nexus 推来的待确认项、本人的确认记录、回调 Nexus 的发送状态。
-- 编号从 270 起：新首页分支已经用到 265，这条链要能不带新首页单独上线。只新增表，不改已有表。

-- 一行是一个 requestId 的一个 revision；id 就是接收回执的 receiptId。
-- body 是收到的请求（json 类型：键的顺序照原样留着，本人确认时看到的内容从这里取）。
-- confirmer_world_id 是 proposedConfirmers 的第一位（本体人员 ID）；confirmer_person_id 是对到的天枢人员，NULL 表示找不到人、没有人能确认。
-- superseded_at：同一个 requestId 来了更大的 revision 时记下，旧的不能再确认。到期只看 expires_at，不另记状态。
CREATE TABLE nexus_dri_requests (
  id uuid PRIMARY KEY,
  request_id text NOT NULL,
  revision integer NOT NULL CHECK (revision >= 1),
  item_id text NOT NULL,
  meeting_id text NOT NULL,
  fingerprint text NOT NULL,
  body json NOT NULL,
  confirmer_world_id text,
  confirmer_person_id text,
  expires_at timestamptz NOT NULL,
  superseded_at timestamptz,
  received_at timestamptz NOT NULL,
  UNIQUE (request_id, revision)
);
CREATE INDEX nexus_dri_requests_confirmer_idx ON nexus_dri_requests (confirmer_person_id) WHERE superseded_at IS NULL;

-- 本人的确认记录：id 就是 confirmationRef，一个 revision 只有一条。原请求指纹在 nexus_dri_requests 上，不会被改；
-- 修改后的内容和它自己的指纹另存。callback_body 是发给 Nexus 的正文原文（重试发同一份）；
-- callback_status：pending 待发（没配地址或还在重试）、delivered Nexus 回了 200、failed Nexus 明确拒绝（不重试）。
CREATE TABLE nexus_dri_confirmations (
  id uuid PRIMARY KEY,
  request_row_id uuid NOT NULL UNIQUE REFERENCES nexus_dri_requests(id),
  decision text NOT NULL CHECK (decision IN ('confirmed', 'amended', 'rejected')),
  confirmed_by_person_id text NOT NULL,
  confirmed_by_world_id text NOT NULL,
  confirmed_at timestamptz NOT NULL,
  amended_content json,
  amended_fingerprint text,
  callback_id text NOT NULL UNIQUE,
  callback_body text NOT NULL,
  callback_status text NOT NULL DEFAULT 'pending' CHECK (callback_status IN ('pending', 'delivered', 'failed')),
  callback_http_status integer,
  callback_error text,
  callback_attempts integer NOT NULL DEFAULT 0,
  callback_delivered_at timestamptz
);
