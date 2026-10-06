-- OAuth connections share the existing connection/revocation and progress audit identity.
ALTER TABLE personal_tokens ADD COLUMN auth_type TEXT NOT NULL DEFAULT 'personal'
  CHECK (auth_type IN ('personal', 'oauth'));

CREATE TABLE mcp_oauth_clients (
  id TEXT PRIMARY KEY,
  metadata JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);
CREATE TABLE mcp_oauth_requests (
  id UUID PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES mcp_oauth_clients(id),
  redirect_uri TEXT NOT NULL,
  resource TEXT NOT NULL,
  scopes TEXT[] NOT NULL,
  state TEXT,
  challenge TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  decided_at TIMESTAMPTZ,
  grant_id UUID REFERENCES personal_tokens(id),
  code_hash TEXT UNIQUE,
  code_expires_at TIMESTAMPTZ,
  consumed_at TIMESTAMPTZ
);
CREATE INDEX mcp_oauth_requests_expiry ON mcp_oauth_requests(expires_at);
CREATE TABLE mcp_oauth_grants (
  id UUID PRIMARY KEY REFERENCES personal_tokens(id),
  client_id TEXT NOT NULL REFERENCES mcp_oauth_clients(id),
  resource TEXT NOT NULL,
  scopes TEXT[] NOT NULL,
  session_version INTEGER NOT NULL
);
CREATE TABLE mcp_oauth_credentials (
  secret_hash TEXT PRIMARY KEY,
  grant_id UUID NOT NULL REFERENCES mcp_oauth_grants(id),
  kind TEXT NOT NULL CHECK (kind IN ('access', 'refresh')),
  scopes TEXT[] NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ
);
CREATE INDEX mcp_oauth_credentials_grant ON mcp_oauth_credentials(grant_id);
