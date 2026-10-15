-- Replace only derived Pi state on the first Anchor-aware turn. Raw conversation history is retained.
ALTER TABLE conversations ADD COLUMN context_schema_version integer NOT NULL DEFAULT 0;
