-- Apply once to the existing kuma-lite monitoring DB before deploying the
-- new Worker. Additive only: old check history and monitor IDs are retained.
ALTER TABLE monitors ADD COLUMN db_latency_threshold_ms INTEGER DEFAULT NULL;
ALTER TABLE monitors ADD COLUMN http_latency_threshold_ms INTEGER DEFAULT NULL;

-- Preserve the old operator's DB-threshold intent, without silently enabling
-- a new end-to-end HTTP ceiling. New code does not fall back to the old field.
UPDATE monitors SET db_latency_threshold_ms = CAST(latency_threshold_ms AS INTEGER)
 WHERE typeof(latency_threshold_ms) IN ('integer', 'real')
   AND latency_threshold_ms >= 1 AND latency_threshold_ms <= 9007199254740991
   AND latency_threshold_ms = CAST(latency_threshold_ms AS INTEGER);

ALTER TABLE checks ADD COLUMN scheduled_slot INTEGER;
ALTER TABLE checks ADD COLUMN probe_trace_json TEXT;
CREATE UNIQUE INDEX idx_checks_monitor_slot ON checks(monitor_id, scheduled_slot)
 WHERE scheduled_slot IS NOT NULL;

ALTER TABLE monitor_state ADD COLUMN last_check_slot INTEGER NOT NULL DEFAULT -1;
ALTER TABLE monitor_state ADD COLUMN consecutive_successes INTEGER NOT NULL DEFAULT 0;
UPDATE monitor_state SET last_check_slot = COALESCE(
  (SELECT (MAX(ts) / 60000) * 60000 FROM checks WHERE checks.monitor_id = monitor_state.monitor_id), -1
);

-- Retain claimed_slot on release/expiry: retries of one scheduled slot must
-- not double-count observations. Only a strictly newer slot can replace it.
CREATE TABLE monitor_execution (
  monitor_id INTEGER PRIMARY KEY,
  claimed_slot INTEGER NOT NULL,
  lease_token TEXT NOT NULL,
  lease_until INTEGER NOT NULL,
  FOREIGN KEY (monitor_id) REFERENCES monitors(id) ON DELETE CASCADE
);
