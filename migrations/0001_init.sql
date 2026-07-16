-- 0001_init: organization, users, sessions.
-- Charlie is self-host / single-org for v1; `org_id` is carried on org-owned
-- rows so a future multi-org split is a data migration, not a schema rewrite.
-- Timestamps are ISO-8601 UTC TEXT. Primary keys are UUIDv7 TEXT.

CREATE TABLE organization (
  id                    TEXT PRIMARY KEY,
  name                  TEXT NOT NULL,
  allowed_email_domains TEXT NOT NULL DEFAULT '[]', -- JSON array, e.g. ["example.com"]
  default_ai_provider_id TEXT,
  settings              TEXT NOT NULL DEFAULT '{}',  -- JSON
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL
);

CREATE TABLE users (
  id            TEXT PRIMARY KEY,
  org_id        TEXT NOT NULL REFERENCES organization(id),
  email         TEXT NOT NULL,
  name          TEXT,
  avatar_url    TEXT,
  role          TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'editor', 'viewer')),
  google_sub    TEXT NOT NULL,
  last_login_at TEXT,
  deleted_at    TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE UNIQUE INDEX idx_users_email ON users(email);
CREATE UNIQUE INDEX idx_users_google_sub ON users(google_sub);
CREATE INDEX idx_users_org ON users(org_id);

CREATE TABLE sessions (
  id         TEXT PRIMARY KEY,          -- SHA-256 of the cookie token; raw token never stored
  user_id    TEXT NOT NULL REFERENCES users(id),
  user_agent TEXT,
  ip         TEXT,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_sessions_user ON sessions(user_id);
CREATE INDEX idx_sessions_expires ON sessions(expires_at);
