-- 0002_auth: machine credentials (api_keys) and the immutable audit_log.
-- These complete the Phase 1 security spine: authenticate, authorize, audit.

CREATE TABLE api_keys (
  id            TEXT PRIMARY KEY,           -- keyId embedded in the token
  org_id        TEXT NOT NULL REFERENCES organization(id),
  name          TEXT NOT NULL,
  secret_hash   TEXT NOT NULL,              -- SHA-256 of the secret half only
  scopes        TEXT NOT NULL DEFAULT '[]', -- JSON array, e.g. ["runs:write","runs:read"]
  project_scope TEXT,                       -- JSON array of project ids, or NULL for all
  expires_at    TEXT,                       -- nullable
  created_by    TEXT NOT NULL REFERENCES users(id),
  last_used_at  TEXT,
  revoked_at    TEXT,                       -- nullable; set on revoke (soft, keeps audit trail)
  created_at    TEXT NOT NULL
);

CREATE INDEX idx_api_keys_org ON api_keys(org_id);

-- Append-only. No UPDATE or DELETE path exists in the API. Every mutating
-- request writes one row inside the same D1 batch as the mutation itself.
CREATE TABLE audit_log (
  id          TEXT PRIMARY KEY,
  org_id      TEXT NOT NULL,
  actor_id    TEXT,                          -- user id or api_key id; NULL for system
  actor_kind  TEXT NOT NULL CHECK (actor_kind IN ('user', 'api_key', 'system')),
  action      TEXT NOT NULL,                 -- dotted verb, e.g. 'member.role_change'
  entity_type TEXT NOT NULL,
  entity_id   TEXT,
  before      TEXT,                          -- JSON snapshot (secrets redacted), nullable
  after       TEXT,                          -- JSON snapshot (secrets redacted), nullable
  ip          TEXT,
  user_agent  TEXT,
  created_at  TEXT NOT NULL
);

CREATE INDEX idx_audit_org_created ON audit_log(org_id, created_at DESC);
CREATE INDEX idx_audit_entity ON audit_log(entity_type, entity_id);
CREATE INDEX idx_audit_actor ON audit_log(actor_id);
