-- 0006_consecutive_degraded.sql
--
-- Add a counter so DEGRADED notifications can require N consecutive
-- ticks before firing, matching how `consecutive_failures` already
-- gates DOWN notifications via monitors.retry_threshold.
--
-- Motivation: the shared backend (D1) occasionally returns a
-- single-tick latency spike that crosses the monitored site's
-- /healthz `degradedThresholdMs` (e.g. 2257ms vs 800ms), which
-- under the previous logic would notify on the very first sample
-- and recover one minute later. Now both DOWN and DEGRADED require
-- `retry_threshold` consecutive ticks before alerting.
--
-- Run once against the remote DB:
--
--   wrangler d1 execute kuma-lite-db --file=./migrations/0006_consecutive_degraded.sql --remote

ALTER TABLE monitor_state ADD COLUMN consecutive_degraded INTEGER DEFAULT 0;
