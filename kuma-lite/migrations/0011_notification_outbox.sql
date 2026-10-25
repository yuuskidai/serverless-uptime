-- Apply once to the monitoring database. Probe execution leases are unchanged.
CREATE TABLE notification_outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  monitor_id INTEGER NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
  scheduled_slot INTEGER NOT NULL,
  config_revision INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('down', 'degraded', 'partial', 'up')),
  observed_at INTEGER NOT NULL,
  result_json TEXT NOT NULL CHECK (length(result_json) <= 32768),
  transition_json TEXT NOT NULL CHECK (length(transition_json) <= 16384),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'sent', 'cancelled', 'uncertain', 'failed')),
  created_at INTEGER NOT NULL,
  lease_token TEXT,
  lease_until INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  completed_at INTEGER,
  slack_alert_ts TEXT,
  last_error TEXT,
  UNIQUE (monitor_id, scheduled_slot, config_revision, kind)
);
CREATE INDEX idx_notification_outbox_pending ON notification_outbox(monitor_id, status, scheduled_slot, id);

-- Owns delivery order and thread identity independently of the latest probe state.
CREATE TABLE notification_delivery_state (
  monitor_id INTEGER PRIMARY KEY REFERENCES monitors(id) ON DELETE CASCADE,
  lease_token TEXT,
  lease_until INTEGER NOT NULL DEFAULT 0,
  active_outbox_id INTEGER,
  last_processed_slot INTEGER NOT NULL DEFAULT -1,
  slack_alert_ts TEXT
);
INSERT INTO notification_delivery_state (monitor_id, slack_alert_ts)
  SELECT monitor_id, slack_alert_ts FROM monitor_state;
