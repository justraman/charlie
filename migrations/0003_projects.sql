-- 0003_projects: the domain model — projects, their environments (targets),
-- and versioned flows. Flow bodies are immutable per version in flow_versions;
-- `flows.current_version_id` points at the live one.

CREATE TABLE projects (
  id                     TEXT PRIMARY KEY,
  org_id                 TEXT NOT NULL REFERENCES organization(id),
  name                   TEXT NOT NULL,
  slug                   TEXT NOT NULL,             -- used in Slack commands and URLs
  description            TEXT,
  source_repo            TEXT,                      -- owner/repo for AI flow-gen / on-merge (nullable)
  default_environment_id TEXT,                      -- FK → environments (set after env creation)
  created_by             TEXT NOT NULL REFERENCES users(id),
  created_at             TEXT NOT NULL,
  updated_at             TEXT NOT NULL,
  deleted_at             TEXT
);

-- Slug is unique among live projects (soft-deleted rows may free the slug).
CREATE UNIQUE INDEX idx_projects_slug ON projects(org_id, slug) WHERE deleted_at IS NULL;
CREATE INDEX idx_projects_org ON projects(org_id);

CREATE TABLE environments (
  id                 TEXT PRIMARY KEY,
  project_id         TEXT NOT NULL REFERENCES projects(id),
  name               TEXT NOT NULL,                 -- dev/qa/staging/prod/... (unique per project)
  base_url           TEXT NOT NULL,
  headers            TEXT NOT NULL DEFAULT '{}',    -- JSON default headers injected into runs
  secrets_ciphertext TEXT,                          -- AES-GCM of JSON {name:value}; never returned
  auth_config        TEXT,                          -- JSON optional pre-auth
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  deleted_at         TEXT
);

CREATE UNIQUE INDEX idx_environments_name ON environments(project_id, name) WHERE deleted_at IS NULL;
CREATE INDEX idx_environments_project ON environments(project_id);

CREATE TABLE flows (
  id                 TEXT PRIMARY KEY,
  project_id         TEXT NOT NULL REFERENCES projects(id),
  name               TEXT NOT NULL,                 -- unique per project
  description        TEXT,
  current_version_id TEXT,                          -- FK → flow_versions
  engines            TEXT NOT NULL DEFAULT '[]',    -- JSON array: ["playwright","k6"]
  origin             TEXT NOT NULL DEFAULT 'manual' CHECK (origin IN ('manual', 'recorder', 'ai')),
  created_by         TEXT NOT NULL REFERENCES users(id),
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  deleted_at         TEXT
);

CREATE UNIQUE INDEX idx_flows_name ON flows(project_id, name) WHERE deleted_at IS NULL;
CREATE INDEX idx_flows_project ON flows(project_id);

-- Immutable snapshots. `version` increments per flow; never updated after insert.
CREATE TABLE flow_versions (
  id           TEXT PRIMARY KEY,
  flow_id      TEXT NOT NULL REFERENCES flows(id),
  version      INTEGER NOT NULL,
  steps        TEXT NOT NULL,                        -- JSON FlowStep[]
  load_profile TEXT,                                 -- JSON k6 stages/thresholds (nullable)
  author_id    TEXT NOT NULL REFERENCES users(id),
  diff_summary TEXT,                                 -- human-readable change vs previous
  created_at   TEXT NOT NULL
);

CREATE UNIQUE INDEX idx_flow_versions_version ON flow_versions(flow_id, version);
CREATE INDEX idx_flow_versions_flow ON flow_versions(flow_id, version DESC);
