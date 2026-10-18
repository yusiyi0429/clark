-- ⑧ 文档变更（含 ④ 的文档触发，前端交互说明第 8 节）：作者在机器人所在的群里 @机器人 贴飞书文档链接即发布。
-- 一条消息里的一个文档链接是一次发布（doc_changes）。Agent 按工作依据清单与群里发过的文档、只凭标题和元数据（D-26，不读正文）
-- 找可能被它修订或取代的旧文档（doc_change_candidates），作者勾选；作者确认不了时改问旧文档负责人。作者一直不回应的只留在这里，不推送。
-- status：finding Agent 在找；awaiting_author 等作者；asking_owner 在问负责人；confirmed 有修订或取代；unrelated 都不是或没有候选。
-- request_id：作者收到的那条 kind = doc_change 的请求。取代的生效日期、过渡期、已有工作是否沿用旧版记在这一行。
CREATE TABLE doc_changes (
  id UUID PRIMARY KEY,
  author_id TEXT NOT NULL,
  -- 规范化的飞书文档地址：https://<域名>/<类型>/<token>
  doc_ref TEXT NOT NULL CHECK (char_length(doc_ref) BETWEEN 1 AND 500),
  title TEXT NOT NULL CHECK (char_length(title) BETWEEN 1 AND 240),
  revised_at TIMESTAMPTZ,
  revised_by TEXT,
  message_id TEXT NOT NULL,
  chat_id TEXT,
  status TEXT NOT NULL DEFAULT 'finding' CHECK (status IN ('finding', 'awaiting_author', 'asking_owner', 'confirmed', 'unrelated')),
  effective_on DATE,
  transition_until DATE,
  keep_existing BOOLEAN,
  request_id UUID REFERENCES requests (id) ON DELETE SET NULL,
  decided_by TEXT,
  decided_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (message_id, doc_ref)
);
CREATE INDEX doc_changes_author_idx ON doc_changes (author_id, created_at DESC);

-- 候选旧文档。key 是文档身份：飞书文档 feishu:<token>（同一份文档换了域名或参数也认得出），其他 <doc_kind>:<doc_ref>。
-- relation：确认下来的关系（作者勾的，或负责人答了「已被取代」）；owner_answer：问负责人时 asked → valid / superseded。
CREATE TABLE doc_change_candidates (
  doc_change_id UUID NOT NULL REFERENCES doc_changes (id) ON DELETE CASCADE,
  key TEXT NOT NULL CHECK (char_length(key) BETWEEN 1 AND 520),
  doc_kind TEXT NOT NULL CHECK (doc_kind IN ('material', 'feishu_doc', 'link')),
  doc_ref TEXT NOT NULL,
  title TEXT NOT NULL,
  url TEXT,
  owner_id TEXT,
  reason TEXT NOT NULL CHECK (char_length(reason) BETWEEN 1 AND 300),
  suggested TEXT NOT NULL CHECK (suggested IN ('revision', 'supersede')),
  same_doc BOOLEAN NOT NULL DEFAULT FALSE,
  position INTEGER NOT NULL,
  relation TEXT CHECK (relation IN ('revision', 'supersede')),
  owner_answer TEXT CHECK (owner_answer IN ('asked', 'valid', 'superseded')),
  owner_request_id UUID REFERENCES requests (id) ON DELETE SET NULL,
  PRIMARY KEY (doc_change_id, key)
);
CREATE INDEX doc_change_candidates_superseded_idx ON doc_change_candidates (key) WHERE relation = 'supersede';
CREATE INDEX doc_change_candidates_owner_request_idx ON doc_change_candidates (owner_request_id) WHERE owner_request_id IS NOT NULL;

ALTER TABLE requests DROP CONSTRAINT requests_kind_check;
ALTER TABLE requests ADD CONSTRAINT requests_kind_check CHECK (kind IN ('relay', 'collection', 'impact', 'supplement', 'doc_change'));

-- 影响卡加一种触发：文档变更（trigger_id 指向 doc_changes，meeting_id 为空）。
-- doc_basis：这个人依据的是哪份旧文档、确认依据时的版本 {key, relation, title, url, revision, revisedAt}；
-- basis_choice：本人在卡上的选择 {choice: switch | keep, until, reason, at}，选完同步更新他的工作依据清单。
ALTER TABLE impact_cards DROP CONSTRAINT impact_cards_trigger_kind_check;
ALTER TABLE impact_cards ADD CONSTRAINT impact_cards_trigger_kind_check CHECK (trigger_kind IN ('meeting_decision', 'doc_change'));
ALTER TABLE impact_cards ADD COLUMN doc_basis JSONB CHECK (doc_basis IS NULL OR jsonb_typeof(doc_basis) = 'object');
ALTER TABLE impact_cards ADD COLUMN basis_choice JSONB CHECK (basis_choice IS NULL OR jsonb_typeof(basis_choice) = 'object');
ALTER TABLE impact_cards ADD CONSTRAINT impact_cards_doc_trigger_check CHECK ((trigger_kind = 'doc_change') = (doc_basis IS NOT NULL));

-- 工作依据被取代后，本人选了继续用旧版到某天。
ALTER TABLE work_basis ADD COLUMN keep_until DATE;
ALTER TABLE work_basis ADD COLUMN keep_reason TEXT CHECK (keep_reason IS NULL OR char_length(keep_reason) BETWEEN 1 AND 200);
