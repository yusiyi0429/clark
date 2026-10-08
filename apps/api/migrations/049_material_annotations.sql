CREATE TABLE material_annotations (
  id UUID PRIMARY KEY,
  material_id UUID NOT NULL REFERENCES object_materials(id) ON DELETE CASCADE,
  object_type TEXT NOT NULL CHECK (object_type IN ('issue', 'task', 'meeting')),
  object_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  quote TEXT NOT NULL,
  prefix TEXT NOT NULL,
  suffix TEXT NOT NULL,
  body TEXT NOT NULL,
  author_id TEXT NOT NULL,
  client_id UUID NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'applying', 'applied', 'no_change', 'failed', 'kept')),
  applied_version INTEGER,
  note TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(author_id, client_id)
);
CREATE INDEX material_annotations_queue ON material_annotations(material_id, created_at, id);
ALTER TABLE material_revisions ADD COLUMN annotation_id UUID REFERENCES material_annotations(id);
CREATE UNIQUE INDEX material_revisions_annotation ON material_revisions(annotation_id) WHERE annotation_id IS NOT NULL;

CREATE TABLE material_edit_proposals (
  id UUID PRIMARY KEY,
  material_id UUID NOT NULL REFERENCES object_materials(id) ON DELETE CASCADE,
  object_type TEXT NOT NULL CHECK (object_type IN ('issue', 'task', 'meeting')),
  object_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  summary TEXT NOT NULL CHECK (char_length(summary) BETWEEN 1 AND 200),
  edits JSONB NOT NULL,
  proposed_for TEXT NOT NULL,
  conversation_id UUID,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'applied', 'dismissed', 'stale')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  decided_at TIMESTAMPTZ
);
CREATE INDEX material_edit_proposals_pending ON material_edit_proposals(material_id, proposed_for) WHERE status='pending';
