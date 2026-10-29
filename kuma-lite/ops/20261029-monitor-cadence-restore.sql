-- Restore proposal only; keep interval-snapshot/history-aware code deployed.
-- Revisions increase again (5/6:2->3, 9/10:4->5); never restore old revisions.
-- Proposal only. Run against the monitoring DB only after new code is live.
-- Root must independently confirm expected revisions/old values and SQLite
-- MATERIALIZED support from safe metadata. This file does not execute itself.
-- Materialized eligibility and clock are fixed before any target row changes.
WITH
expected(id, revision, old_interval, old_db_threshold, old_legacy_threshold) AS (
  VALUES (5, 2, 2, 1500, 1500), (6, 2, 2, 1500, 1500),
         (9, 4, 2, 1500, 1500), (10, 4, 2, 1500, 1500)
),
clock(now_ms) AS MATERIALIZED (
  SELECT CAST(strftime('%s','now') AS INTEGER) * 1000
),
eligible(ready) AS MATERIALIZED (
  SELECT CASE WHEN
    (SELECT COUNT(*)
       FROM monitors m JOIN expected e ON m.id = e.id
      WHERE m.config_revision = e.revision
        AND m.interval_minutes = e.old_interval
        AND m.db_latency_threshold_ms = e.old_db_threshold
        AND m.latency_threshold_ms IS e.old_legacy_threshold
        AND m.enabled = 1
        AND m.retry_threshold = 2
        AND m.timeout_ms = 10000) = 4
    AND NOT EXISTS (
      SELECT 1 FROM monitor_execution p
       WHERE p.monitor_id IN (SELECT id FROM expected)
         AND p.lease_until > (SELECT now_ms FROM clock)
    )
    AND NOT EXISTS (
      SELECT 1 FROM notification_delivery_state d
       WHERE d.monitor_id IN (SELECT id FROM expected)
         AND (d.lease_until > (SELECT now_ms FROM clock)
              OR d.active_outbox_id IS NOT NULL)
    )
    AND NOT EXISTS (
      SELECT 1 FROM notification_outbox o
       WHERE o.monitor_id IN (SELECT id FROM expected)
         AND (o.status IN ('pending', 'processing', 'uncertain')
              OR o.lease_until > (SELECT now_ms FROM clock))
    )
    THEN 1 ELSE 0 END
)
UPDATE monitors
   SET interval_minutes = 1,
       db_latency_threshold_ms = 1000,
       latency_threshold_ms = 1000,
       config_revision = config_revision + 1
 WHERE id IN (SELECT id FROM expected)
   AND (SELECT ready FROM eligible) = 1
RETURNING id, interval_minutes, db_latency_threshold_ms, latency_threshold_ms,
          config_revision, retry_threshold, timeout_ms;
