-- 0004_runs: the execution plane's system-of-record. A run targets exactly one
-- (project, environment, engine, flow-selection, profile). Shards are matrix
-- jobs; shard_results hold per-shard structured output; reports are the final
-- aggregated view the dashboard and Slack render.

CREATE TABLE runs (
  id              TEXT PRIMARY KEY,
  org_id          TEXT NOT NULL REFERENCES organization(id),
  project_id      TEXT NOT NULL REFERENCES projects(id),
  environment_id  TEXT NOT NULL REFERENCES environments(id),
  flow_selection  TEXT NOT NULL DEFAULT '[]',   -- JSON: resolved [{flowId, versionId, name}]
  engine          TEXT NOT NULL CHECK (engine IN ('playwright', 'k6')),
  profile         TEXT NOT NULL DEFAULT 'smoke',
  status          TEXT NOT NULL CHECK (status IN ('queued','running','passed','failed','cancelled')),
  trigger         TEXT NOT NULL CHECK (trigger IN ('manual','slack','cron','merge','ci')),
  triggered_by    TEXT REFERENCES users(id),     -- nullable for machine triggers
  expected_shards INTEGER NOT NULL DEFAULT 1,
  gha_run_id      TEXT,                           -- dispatched GitHub workflow run id
  commit_sha      TEXT,
  error           TEXT,                           -- terminal error detail (dispatch/timeout)
  summary         TEXT,                           -- JSON denormalized top-line metrics
  queued_at       TEXT NOT NULL,
  started_at      TEXT,
  finished_at     TEXT
);

CREATE INDEX idx_runs_project_status ON runs(project_id, status, queued_at DESC);
CREATE INDEX idx_runs_org_queued ON runs(org_id, queued_at DESC);
CREATE INDEX idx_runs_status ON runs(status);

CREATE TABLE run_shards (
  id           TEXT PRIMARY KEY,
  run_id       TEXT NOT NULL REFERENCES runs(id),
  shard_index  INTEGER NOT NULL,
  status       TEXT NOT NULL CHECK (status IN ('pending','running','passed','failed','errored')),
  runner       TEXT,
  public_ip    TEXT,
  started_at   TEXT,
  finished_at  TEXT
);

CREATE UNIQUE INDEX idx_run_shards_run_index ON run_shards(run_id, shard_index);

CREATE TABLE shard_results (
  id             TEXT PRIMARY KEY,
  run_id         TEXT NOT NULL REFERENCES runs(id),
  shard_id       TEXT NOT NULL REFERENCES run_shards(id),
  flow_results   TEXT,   -- JSON: per-flow pass/fail, duration, failed step, error
  metrics        TEXT,   -- JSON: k6 http metrics or Playwright timings/web vitals
  runtime_issues TEXT,   -- JSON: console errors, failed requests, unhandled rejections
  events         TEXT,   -- JSON: ordered step events (bounded)
  artifact_keys  TEXT,   -- JSON: R2 object keys (screenshots, video, trace, HAR)
  created_at     TEXT NOT NULL
);

CREATE INDEX idx_shard_results_run ON shard_results(run_id);

CREATE TABLE reports (
  id              TEXT PRIMARY KEY,
  run_id          TEXT NOT NULL UNIQUE REFERENCES runs(id),
  status          TEXT NOT NULL,
  totals          TEXT,   -- JSON: shards passed/failed, total duration
  load_summary    TEXT,   -- JSON: k6 p50/p95/p99, RPS, error rate, thresholds pass/fail
  e2e_summary     TEXT,   -- JSON: flows passed/failed, first failing step
  html_report_key TEXT,   -- R2 key of rendered HTML report (nullable)
  created_at      TEXT NOT NULL
);
