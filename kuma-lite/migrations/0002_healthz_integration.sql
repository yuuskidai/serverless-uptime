-- 0002_healthz_integration.sql
--
-- Migrate an existing kuma-lite-db to support structured /healthz polling
-- (see docs/integration-spec.md). Run once against the remote DB:
--
--   wrangler d1 execute kuma-lite-db --file=./migrations/0002_healthz_integration.sql --remote
--
-- Idempotent: each ALTER is wrapped so re-running is safe (D1 will error
-- on duplicate columns; check `wrangler d1 migrations` if you need to
-- re-apply piecewise).

-- Optional fallback URL probed when the primary /healthz request fails
-- to return parseable JSON. Used as a "did the site itself respond?"
-- liveness check so an app-layer healthz outage doesn't blind the rest
-- of the monitoring loop.
ALTER TABLE monitors ADD COLUMN fallback_url TEXT;

-- Raw structured fields captured from each /healthz JSON response. Kept
-- alongside the existing `status` column so the binary up/down history
-- (used by bar aggregation and uptime %) is unchanged, while the
-- structured fields drive the badge, tooltip, and incident detail.
ALTER TABLE checks ADD COLUMN healthz_status TEXT;       -- 'ok' | 'degraded' | 'down' | NULL
ALTER TABLE checks ADD COLUMN healthz_reason TEXT;       -- business-language reason
ALTER TABLE checks ADD COLUMN healthz_components TEXT;   -- JSON array of components (string)
ALTER TABLE checks ADD COLUMN healthz_version TEXT;      -- short build SHA reported by the site
ALTER TABLE checks ADD COLUMN used_fallback INTEGER DEFAULT 0; -- 1 if check fell back to fallback_url
ALTER TABLE checks ADD COLUMN in_maintenance INTEGER DEFAULT 0; -- 1 if check happened inside a declared maintenance window

-- Latest declared maintenance window per monitor. Refreshed every cron
-- tick from the /healthz `maintenance` field. Used by the renderer (to
-- show the "ongoing / upcoming maintenance" banner) and by the notifier
-- (to suppress DOWN alerts inside the window).
ALTER TABLE monitor_state ADD COLUMN maintenance_from INTEGER;
ALTER TABLE monitor_state ADD COLUMN maintenance_to INTEGER;
ALTER TABLE monitor_state ADD COLUMN maintenance_reason TEXT;

CREATE INDEX IF NOT EXISTS idx_checks_healthz_status ON checks(monitor_id, healthz_status);
