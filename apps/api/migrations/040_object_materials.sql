CREATE TABLE object_materials (
  id UUID PRIMARY KEY,
  object_type TEXT NOT NULL CHECK (object_type IN ('issue', 'task')),
  object_id TEXT NOT NULL,
  file_name TEXT NOT NULL CHECK (char_length(file_name) BETWEEN 1 AND 240),
  format TEXT NOT NULL CHECK (format IN ('markdown', 'pdf', 'docx')),
  size_bytes INTEGER NOT NULL,
  page_count INTEGER,
  storage_key TEXT,
  sha256 TEXT,
  origin TEXT NOT NULL CHECK (origin IN ('upload', 'agent')),
  owner_id TEXT NOT NULL,
  current_version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  deleted_at TIMESTAMPTZ,
  CHECK ((origin = 'upload') = (storage_key IS NOT NULL)),
  CHECK (origin = 'upload' OR format = 'markdown')
);
CREATE INDEX object_materials_object ON object_materials (object_type, object_id, created_at) WHERE deleted_at IS NULL;

CREATE TABLE material_revisions (
  material_id UUID NOT NULL REFERENCES object_materials (id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  body TEXT NOT NULL,
  requested_by TEXT,
  summary TEXT CHECK (summary IS NULL OR char_length(summary) BETWEEN 1 AND 200),
  agent_run_id UUID,
  created_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (material_id, version)
);
