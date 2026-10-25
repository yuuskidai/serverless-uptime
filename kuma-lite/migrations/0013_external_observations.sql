-- Supplemental observations from the fixed GitHub Actions witness. This never
-- advances the primary monitor state or replaces a missing scheduled check.
CREATE TABLE external_probe_runs (
  run_id TEXT NOT NULL,
  run_attempt TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  commit_sha TEXT NOT NULL,
  recorded_at INTEGER NOT NULL,
  observed_at INTEGER NOT NULL,
  readiness_status TEXT NOT NULL CHECK (readiness_status IN ('fresh', 'unknown')),
  readiness_http_status INTEGER,
  readiness_total_ms REAL NOT NULL,
  PRIMARY KEY (run_id, run_attempt)
) WITHOUT ROWID;
CREATE INDEX idx_external_probe_runs_recorded ON external_probe_runs(recorded_at);

CREATE TABLE external_observations (
  run_id TEXT NOT NULL,
  run_attempt TEXT NOT NULL,
  monitor_id INTEGER NOT NULL,
  monitor_config_revision INTEGER NOT NULL,
  observed_at INTEGER NOT NULL,
  finished_at INTEGER NOT NULL,
  total_ms REAL NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('ok', 'degraded', 'down')),
  http_status INTEGER,
  database_ms REAL,
  db_threshold_ms INTEGER NOT NULL,
  error TEXT,
  request_id TEXT NOT NULL,
  PRIMARY KEY (run_id, run_attempt, monitor_id),
  FOREIGN KEY (run_id, run_attempt) REFERENCES external_probe_runs(run_id, run_attempt) ON DELETE CASCADE
) WITHOUT ROWID;
CREATE INDEX idx_external_observations_latest ON external_observations(monitor_id, finished_at DESC);
