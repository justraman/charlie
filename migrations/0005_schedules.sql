-- 0005_schedules: automatic triggers. A schedule fires runs either on a cron
-- interval (`cron_expr` + `next_due_at`) or when a merge lands on a watched
-- branch of the project's source repo (`watch_branch`). It captures the same
-- (project, environment, engine, profile, flow-selection) a manual run does, so
-- firing one is just resolving the selection and creating a run.

CREATE TABLE schedules (
  id              TEXT PRIMARY KEY,
  org_id          TEXT NOT NULL REFERENCES organization(id),
  project_id      TEXT NOT NULL REFERENCES projects(id),
  environment_id  TEXT NOT NULL REFERENCES environments(id),
  flow_selection  TEXT NOT NULL DEFAULT '["all"]',  -- JSON: flow names or ["all"]
  engine          TEXT NOT NULL CHECK (engine IN ('playwright', 'k6')),
  profile         TEXT NOT NULL DEFAULT 'smoke',
  trigger_type    TEXT NOT NULL CHECK (trigger_type IN ('cron', 'on_merge')),
  cron_expr       TEXT,                             -- for `cron` (nullable)
  watch_branch    TEXT,                             -- for `on_merge`, e.g. "main"
  enabled         INTEGER NOT NULL DEFAULT 1,       -- 0/1
  created_by      TEXT REFERENCES users(id),
  last_fired_at   TEXT,
  next_due_at     TEXT,                             -- for `cron`; computed from cron_expr
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

-- The cron sweep selects `enabled AND next_due_at <= now`.
CREATE INDEX idx_schedules_due ON schedules(enabled, next_due_at);
CREATE INDEX idx_schedules_project ON schedules(project_id);
-- The webhook matcher selects on_merge schedules for a repo+branch.
CREATE INDEX idx_schedules_merge ON schedules(trigger_type, enabled);

-- Attribute a run to the schedule that produced it (nullable for manual/ci runs),
-- so a schedule's run history is a simple lookup.
ALTER TABLE runs ADD COLUMN schedule_id TEXT REFERENCES schedules(id);
CREATE INDEX idx_runs_schedule ON runs(schedule_id, queued_at DESC);
