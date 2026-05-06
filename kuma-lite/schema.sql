-- kuma-lite D1 schema (canonical, fresh-install).
-- For existing databases, see migrations/*.sql for the incremental
-- ALTER statements that brought us here.

CREATE TABLE IF NOT EXISTS monitors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  -- Optional human-readable note about what this URL serves (e.g.,
  -- "ログイン機能", "決済 API", "管理画面"). Surfaced as a subtitle on
  -- the status card and incident detail page so non-technical visitors
  -- see the business function instead of just the URL.
  description TEXT,
  -- Liveness fallback. When the primary `url` (typically /healthz) does
  -- not return parseable structured JSON or fails outright, monitor.ts
  -- retries against `fallback_url` to distinguish "app-layer healthz
  -- broken but site still serves" from "site fully down". Optional.
  fallback_url TEXT,
  method TEXT DEFAULT 'GET',
  expected_status INTEGER DEFAULT 200,
  keyword TEXT,
  timeout_ms INTEGER DEFAULT 10000,
  interval_minutes INTEGER DEFAULT 1,
  enabled INTEGER DEFAULT 1,
  retry_threshold INTEGER DEFAULT 2,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS checks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  monitor_id INTEGER NOT NULL,
  -- Binary up/down. Drives bar aggregation and uptime %. A check that
  -- got a parseable healthz response with status='degraded' is recorded
  -- as 'up' here so the bars stay green; the nuance lives in
  -- healthz_status below.
  status TEXT NOT NULL,
  status_code INTEGER,
  latency_ms INTEGER,
  error TEXT,
  ts INTEGER NOT NULL,
  -- Raw structured `status` from /healthz JSON: 'ok' | 'degraded' |
  -- 'down' | NULL (NULL when the site responded but didn't speak the
  -- spec, or when we used the fallback URL instead).
  healthz_status TEXT,
  -- Business-language reason copied from the JSON `reason` field.
  healthz_reason TEXT,
  -- The full `components` array from JSON, stored as a JSON string.
  -- Read back when rendering the incident detail page.
  healthz_components TEXT,
  -- Short build SHA reported by the monitored site.
  healthz_version TEXT,
  -- 1 when this check fell back to monitors.fallback_url because the
  -- primary URL did not parse / timed out.
  used_fallback INTEGER DEFAULT 0,
  -- 1 when this check happened inside a declared maintenance window;
  -- DOWN notifications are suppressed for these rows.
  in_maintenance INTEGER DEFAULT 0,
  FOREIGN KEY (monitor_id) REFERENCES monitors(id)
);

CREATE INDEX IF NOT EXISTS idx_checks_monitor_ts ON checks(monitor_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_checks_ts ON checks(ts);
CREATE INDEX IF NOT EXISTS idx_checks_healthz_status ON checks(monitor_id, healthz_status);

CREATE TABLE IF NOT EXISTS monitor_state (
  monitor_id INTEGER PRIMARY KEY,
  -- Three-valued: 'up' | 'degraded' | 'down'. 'degraded' was added when
  -- /healthz integration landed; older rows may carry only the two
  -- legacy values and are upgraded on the next cron tick.
  current_status TEXT NOT NULL,
  consecutive_failures INTEGER DEFAULT 0,
  last_notified_at INTEGER,
  down_since INTEGER,
  -- Slack message timestamp (chat.postMessage `ts`) for the open DOWN
  -- alert. Used to thread the recovery message and to add a checkmark
  -- reaction when the monitor recovers. Cleared on recovery.
  slack_alert_ts TEXT,
  -- Most recent declared maintenance window. Refreshed every cron tick
  -- from the /healthz `maintenance` field. Cleared (NULL) when the
  -- site stops declaring one or `to` is in the past.
  maintenance_from INTEGER,
  maintenance_to INTEGER,
  maintenance_reason TEXT,
  FOREIGN KEY (monitor_id) REFERENCES monitors(id)
);
