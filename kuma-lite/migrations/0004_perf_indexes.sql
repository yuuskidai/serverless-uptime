-- 0004_perf_indexes.sql
--
-- Performance-only migration: trims a never-used index and adds a
-- partial index that targets the down-check filter pattern used by
-- both the status-page error-sample query and the RSS feed's
-- incident derivation. No schema-shape changes — safe to apply at
-- any time, no code deploy required.
--
-- Run once against the remote DB:
--
--   wrangler d1 execute kuma-lite-db --file=./migrations/0004_perf_indexes.sql --remote
--
-- Idempotent: every statement uses IF [NOT] EXISTS so re-running is
-- safe.

-- Drop a holdover from migration 0002 that no query ever consults.
-- Both `monitor_id` and `healthz_status` are filterable individually
-- but no read combines them — `idx_checks_monitor_ts` already covers
-- all per-monitor lookups, and the status filter (when used) is
-- always paired with the binary `status` column, not `healthz_status`.
DROP INDEX IF EXISTS idx_checks_healthz_status;

-- Status-page error-sample query and RSS feed both filter on
-- (monitor_id, status='down', in_maintenance=0) ordered by ts DESC.
-- A partial index trimmed to just down + non-maintenance rows lets
-- the planner walk only true incidents (a small fraction of the
-- table) instead of scanning candidates and filtering in JS.
CREATE INDEX IF NOT EXISTS idx_checks_down_recent
  ON checks(monitor_id, ts DESC)
  WHERE status = 'down' AND in_maintenance = 0;
