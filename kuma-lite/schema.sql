-- kuma-lite D1 schema

CREATE TABLE IF NOT EXISTS monitors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
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
  status TEXT NOT NULL,
  status_code INTEGER,
  latency_ms INTEGER,
  error TEXT,
  ts INTEGER NOT NULL,
  FOREIGN KEY (monitor_id) REFERENCES monitors(id)
);

CREATE INDEX IF NOT EXISTS idx_checks_monitor_ts ON checks(monitor_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_checks_ts ON checks(ts);

CREATE TABLE IF NOT EXISTS monitor_state (
  monitor_id INTEGER PRIMARY KEY,
  current_status TEXT NOT NULL,
  consecutive_failures INTEGER DEFAULT 0,
  last_notified_at INTEGER,
  down_since INTEGER,
  -- Slack message timestamp (chat.postMessage `ts`) for the open DOWN
  -- alert. Used to thread the recovery message and to add a checkmark
  -- reaction when the monitor recovers. Cleared on recovery.
  slack_alert_ts TEXT,
  FOREIGN KEY (monitor_id) REFERENCES monitors(id)
);
