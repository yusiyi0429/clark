-- 同事来问，被问的人的伙伴先答（计划 T4，补充条款 A6–A8）。buddy_state 为空 = 这位收件人没经过伙伴（分享、多人、带附件或截止的征集、老数据）。
-- answering 伙伴在答；answered 伙伴答了；handoff 转本人（模型判要本人定，或问的人点了「问本人」），进被问的人的等你；
-- failed 没答上来（出错、超时、没有可读的资料），limited 超上限：这两种不进被问的人的等你，buddy_note 是给问的人看的原因。
ALTER TABLE request_recipients
  ADD COLUMN buddy_state TEXT CHECK (buddy_state IN ('answering', 'answered', 'handoff', 'failed', 'limited')),
  ADD COLUMN buddy_note TEXT CHECK (char_length(buddy_note) <= 200),
  ADD COLUMN buddy_asked_at TIMESTAMPTZ,
  ADD CONSTRAINT request_recipients_buddy CHECK ((buddy_state IS NULL) = (buddy_asked_at IS NULL));
-- 回复是谁答的：本人，还是他的伙伴（author_id 仍是被问的人）。伙伴答的不改收件人行的 status、done_by（A8）。
ALTER TABLE team_delivery_replies ADD COLUMN origin TEXT NOT NULL DEFAULT 'person' CHECK (origin IN ('person', 'buddy'));
-- 代答的名额：发出时占（首问一行，追问各一行），重试不另占。按公司时区数当天的：被问的人每天 20 次，同一个问的人对他每天 10 次。
CREATE TABLE team_buddy_asks (
  request_id UUID NOT NULL,
  recipient_id TEXT NOT NULL,
  -- 首问是 q，追问是触发它的那条回复的 id。
  trigger_key TEXT NOT NULL,
  asker_id TEXT NOT NULL,
  asked_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (request_id, recipient_id, trigger_key),
  FOREIGN KEY (request_id, recipient_id) REFERENCES request_recipients(request_id, person_id) ON DELETE CASCADE
);
CREATE INDEX team_buddy_asks_day ON team_buddy_asks (recipient_id, asked_at);
