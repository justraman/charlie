-- 0006_integrations: connected apps (Slack, GitHub) and Slack report targets.
-- A single-org self-host has at most one integration per kind; credentials
-- (bot token, signing secret) are AES-GCM encrypted at rest in config_ciphertext
-- with the same CHARLIE_KEK used for environment secrets — never returned to a
-- client.

CREATE TABLE integrations (
  id                TEXT PRIMARY KEY,
  org_id            TEXT NOT NULL REFERENCES organization(id),
  kind              TEXT NOT NULL CHECK (kind IN ('slack', 'github')),
  external_id       TEXT,                      -- Slack team id / GitHub installation id
  config_ciphertext TEXT NOT NULL,             -- encrypted JSON of tokens/secrets
  created_by        TEXT REFERENCES users(id),
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);

-- One integration per kind per org.
CREATE UNIQUE INDEX idx_integrations_org_kind ON integrations(org_id, kind);

-- Where a run reports back on completion: the channel a slash command came from,
-- captured at trigger time (nullable — scheduled/merge runs fall back to the
-- project's default channel).
ALTER TABLE runs ADD COLUMN slack_channel TEXT;

-- A project's default Slack channel for scheduled/merge run reports.
ALTER TABLE projects ADD COLUMN slack_channel TEXT;
