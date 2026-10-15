CREATE TABLE memory_documents(module text NOT NULL CHECK(module='personal'),scope_key text NOT NULL,directory_id uuid NOT NULL UNIQUE,revision integer NOT NULL DEFAULT 0,pending_revision integer,epoch integer NOT NULL DEFAULT 0,updated_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(module,scope_key));
CREATE TABLE personal_memory_exclusions(person_id text NOT NULL,attribute_key text NOT NULL,through_job_id bigint NOT NULL DEFAULT 0,conversation_cutoffs jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(person_id,attribute_key));
ALTER TABLE conversations ADD COLUMN memory_epoch integer NOT NULL DEFAULT 0;
ALTER TABLE conversations ADD COLUMN memory_history_cutoff integer NOT NULL DEFAULT 0;
