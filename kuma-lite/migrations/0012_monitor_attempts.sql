-- Additive monitoring-only audit. Apply once after 0011. Audit IDs and phase
-- decisions contain no URLs, request headers, response bodies or credentials.
-- No monitor FK: a missing/deleted monitor must remain diagnosable until audit
-- retention expires; deleting a target must not erase the rejection evidence.
CREATE TABLE monitor_runs (
  run_id TEXT PRIMARY KEY,
  scheduled_time INTEGER NOT NULL,
  scheduled_slot INTEGER NOT NULL,
  received_at INTEGER NOT NULL,
  cron TEXT NOT NULL,
  stage TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  finished_at INTEGER,
  error_phase TEXT,
  timings_json TEXT CHECK (timings_json IS NULL OR length(timings_json) <= 8192)
);
CREATE INDEX idx_monitor_runs_received ON monitor_runs(received_at);
CREATE TABLE monitor_attempts (
  attempt_id TEXT PRIMARY KEY,
  run_id TEXT,
  monitor_id INTEGER NOT NULL,
  scheduled_time INTEGER NOT NULL,
  scheduled_slot INTEGER NOT NULL,
  received_at INTEGER NOT NULL,
  config_revision INTEGER NOT NULL,
  monitor_role TEXT NOT NULL,
  probe_transport TEXT NOT NULL,
  decision TEXT NOT NULL,
  reason TEXT NOT NULL,
  observed_claimed_slot INTEGER,
  observed_lease_until INTEGER,
  observed_last_check_slot INTEGER,
  observed_revision INTEGER,
  observed_enabled INTEGER,
  observed_at INTEGER NOT NULL,
  claimed_at INTEGER,
  probe_started_at INTEGER,
  committed_at INTEGER,
  released_at INTEGER,
  finished_at INTEGER,
  release_outcome TEXT,
  error_phase TEXT,
  timings_json TEXT CHECK (timings_json IS NULL OR length(timings_json) <= 8192)
);
CREATE INDEX idx_monitor_attempts_slot ON monitor_attempts(monitor_id, scheduled_slot DESC);
CREATE INDEX idx_monitor_attempts_observed ON monitor_attempts(observed_at);
