-- 0005_daily_summary.sql
--
-- Add a daily aggregation table that pre-computes per-monitor
-- per-day up/down/maintenance counts. Used by the 30-day bar on
-- status-page so the long-scale render reads ~30 rows per monitor
-- instead of scanning all checks in the window. Filled by the
-- daily cleanup cron (see monitor.ts:cleanupOldChecks); seeded at
-- migration time from existing checks so the first long-scale
-- render after deploy works without waiting for the cleanup cron.
--
-- Run once against the remote DB:
--
--   wrangler d1 execute kuma-lite-db --file=./migrations/0005_daily_summary.sql --remote
--
-- Optional but recommended: enable D1 read replication for this
-- database from the Cloudflare dashboard (D1 → kuma-lite-db →
-- Settings → Read Replication: enable). The status-page,
-- incident-page, and RSS render paths now use the D1 Sessions API
-- with `first-unconstrained` so they will automatically route reads
-- to nearby replicas once enabled, with no further code changes.
-- The setting can also be applied via the Cloudflare API at
--   PATCH /accounts/{account_id}/d1/database/{database_id}
--   { "read_replication": { "mode": "auto" } }

-- `day_ms` is the ms-epoch of UTC midnight for the day this row
-- summarises. (monitor_id, day_ms) is unique. WITHOUT ROWID keeps
-- lookups by the composite key fast and storage compact.
CREATE TABLE IF NOT EXISTS daily_summary (
  monitor_id INTEGER NOT NULL,
  day_ms INTEGER NOT NULL,
  ups INTEGER NOT NULL DEFAULT 0,
  downs INTEGER NOT NULL DEFAULT 0,
  maints INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (monitor_id, day_ms)
) WITHOUT ROWID;

-- Status-page 30d aggregate query filters by `day_ms` range across
-- many monitors. The PK already serves per-monitor lookups; this
-- index covers the cross-monitor day-range scan path.
CREATE INDEX IF NOT EXISTS idx_daily_summary_day ON daily_summary(day_ms);

-- Seed past full days from checks at migration time. INSERT OR IGNORE
-- so re-running the migration is harmless. Today's incomplete day is
-- intentionally skipped — it will keep being computed on-the-fly from
-- the raw `checks` rows until the next UTC-midnight boundary, when
-- the cleanup cron rolls it into a row here.
INSERT OR IGNORE INTO daily_summary (monitor_id, day_ms, ups, downs, maints)
SELECT
  monitor_id,
  (ts / 86400000) * 86400000 AS day_ms,
  SUM(CASE WHEN status = 'up' AND in_maintenance = 0 THEN 1 ELSE 0 END) AS ups,
  SUM(CASE WHEN status = 'down' AND in_maintenance = 0 THEN 1 ELSE 0 END) AS downs,
  SUM(CASE WHEN in_maintenance = 1 THEN 1 ELSE 0 END) AS maints
FROM checks
WHERE ts < (unixepoch() / 86400) * 86400 * 1000
GROUP BY monitor_id, day_ms;
