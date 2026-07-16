-- 0007_ai: AI-assisted flow generation. Providers are per-org (bring your own
-- key, encrypted at rest like other secrets). Analysis runs on GitHub Actions
-- (heavy, off the Worker) and POSTs back drafts; a draft is NOT a runnable flow
-- until a human approves it into a real flow + flow_version v1.

CREATE TABLE ai_providers (
  id                TEXT PRIMARY KEY,
  org_id            TEXT NOT NULL REFERENCES organization(id),
  name              TEXT NOT NULL CHECK (name IN ('anthropic', 'openai', 'workers_ai')),
  model             TEXT NOT NULL,
  api_key_ciphertext TEXT,                    -- encrypted; nullable for workers_ai
  created_by        TEXT REFERENCES users(id),
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);

CREATE INDEX idx_ai_providers_org ON ai_providers(org_id);

-- The org's default provider lives in organization.default_ai_provider_id,
-- reserved in migration 0001 (set via the provider config API).

-- An analysis job: dispatched like a run, tracked to completion.
CREATE TABLE ai_analyses (
  id           TEXT PRIMARY KEY,
  org_id       TEXT NOT NULL REFERENCES organization(id),
  project_id   TEXT NOT NULL REFERENCES projects(id),
  provider_id  TEXT REFERENCES ai_providers(id),
  ref          TEXT,                          -- git ref analyzed (default branch if null)
  status       TEXT NOT NULL CHECK (status IN ('queued','running','succeeded','failed')),
  error        TEXT,
  draft_count  INTEGER NOT NULL DEFAULT 0,
  gha_run_id   TEXT,
  created_by   TEXT REFERENCES users(id),
  created_at   TEXT NOT NULL,
  finished_at  TEXT
);

CREATE INDEX idx_ai_analyses_project ON ai_analyses(project_id, created_at DESC);

-- A drafted flow awaiting human review. Approving it creates a real flow whose
-- v1 is human-authored (origin credits the AI); rejecting discards it.
CREATE TABLE flow_drafts (
  id               TEXT PRIMARY KEY,
  org_id           TEXT NOT NULL REFERENCES organization(id),
  project_id       TEXT NOT NULL REFERENCES projects(id),
  analysis_id      TEXT REFERENCES ai_analyses(id),
  name             TEXT NOT NULL,
  description      TEXT,
  engines          TEXT NOT NULL DEFAULT '["playwright"]',  -- JSON array
  steps            TEXT NOT NULL,                            -- JSON FlowStep[]
  load_profile     TEXT,                                     -- JSON (nullable)
  reasoning        TEXT,                                     -- model's rationale
  source_refs      TEXT,                                     -- JSON: files/routes referenced
  status           TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved','rejected')),
  origin           TEXT NOT NULL DEFAULT 'ai',
  approved_flow_id TEXT REFERENCES flows(id),
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);

CREATE INDEX idx_flow_drafts_project ON flow_drafts(project_id, status, created_at DESC);
