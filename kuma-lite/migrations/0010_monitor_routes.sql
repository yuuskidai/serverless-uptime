-- Apply once to the monitoring D1 database. Existing route, state, and history
-- remain unchanged until an operator explicitly starts shadow measurement.
ALTER TABLE monitors ADD COLUMN probe_transport TEXT NOT NULL DEFAULT 'legacy' CHECK (probe_transport IN ('legacy', 'public_fetch', 'service_binding'));
ALTER TABLE monitors ADD COLUMN monitor_role TEXT NOT NULL DEFAULT 'availability' CHECK (monitor_role IN ('availability', 'diagnostic', 'shadow'));
ALTER TABLE monitors ADD COLUMN parent_monitor_id INTEGER REFERENCES monitors(id);
ALTER TABLE monitors ADD COLUMN response_mode TEXT NOT NULL DEFAULT 'legacy_http' CHECK (response_mode IN ('legacy_http', 'strict_healthz'));
ALTER TABLE monitors ADD COLUMN config_revision INTEGER NOT NULL DEFAULT 1;
ALTER TABLE monitors ADD COLUMN availability_since_ms INTEGER;
ALTER TABLE checks ADD COLUMN config_revision INTEGER;
ALTER TABLE checks ADD COLUMN monitor_role TEXT;
ALTER TABLE checks ADD COLUMN probe_transport TEXT;
ALTER TABLE monitor_state ADD COLUMN config_revision INTEGER NOT NULL DEFAULT 1;
