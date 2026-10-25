import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const columns = (db, table) => db.prepare(`PRAGMA table_info(${table})`).all()
  .map(({ name, type, notnull, dflt_value, pk }) => ({ name, type, notnull, dflt_value, pk }))
  .sort((left, right) => left.name.localeCompare(right.name));

test('route migration preserves preexisting history, state, thresholds and fresh-install parity', () => {
  const upgraded = new DatabaseSync(':memory:');
  const fresh = new DatabaseSync(':memory:');
  try {
    upgraded.exec('PRAGMA foreign_keys=ON');
    upgraded.exec(read('./fixtures/pre-0009.sql'));
    upgraded.exec('ALTER TABLE monitors ADD COLUMN latency_threshold_ms INTEGER DEFAULT NULL');
    upgraded.exec(`INSERT INTO monitors(id,name,url,service_binding,latency_threshold_ms,created_at)
      VALUES(5,'Portal','https://example.invalid/healthz','PORTAL',1000,10);
      INSERT INTO checks(monitor_id,status,ts) VALUES(5,'down',120001);
      INSERT INTO monitor_state(monitor_id,current_status,consecutive_failures,slack_alert_ts)
      VALUES(5,'down',2,'existing-thread');`);
    upgraded.exec(read('../migrations/0009_monitor_execution.sql'));
    const original = { ...upgraded.prepare('SELECT * FROM checks').get() };
    const previousState = { ...upgraded.prepare('SELECT * FROM monitor_state').get() };
    upgraded.exec(read('../migrations/0010_monitor_routes.sql'));
    fresh.exec(read('../schema.sql'));
    for (const table of ['monitors', 'checks', 'monitor_state', 'monitor_execution', 'daily_summary']) {
      assert.deepEqual(columns(upgraded, table), columns(fresh, table), table);
    }
    const { config_revision, monitor_role, probe_transport, ...preserved } = upgraded.prepare('SELECT * FROM checks').get();
    assert.deepEqual(preserved, original);
    assert.equal(config_revision, null);
    assert.equal(monitor_role, null);
    assert.equal(probe_transport, null);
    const { config_revision: stateRevision, ...preservedState } = upgraded.prepare('SELECT * FROM monitor_state').get();
    assert.deepEqual(preservedState, previousState);
    assert.equal(stateRevision, 1);
    const monitor = upgraded.prepare('SELECT * FROM monitors').get();
    assert.equal(monitor.db_latency_threshold_ms, 1000);
    assert.equal(monitor.http_latency_threshold_ms, null);
    assert.equal(monitor.monitor_role, 'availability');
    assert.equal(monitor.probe_transport, 'legacy');
    assert.equal(monitor.response_mode, 'legacy_http');
    assert.equal(monitor.availability_since_ms, null);
    assert.equal(monitor.parent_monitor_id, null);
    assert.equal(monitor.config_revision, 1);
    assert.equal(upgraded.prepare('PRAGMA foreign_key_check').all().length, 0);
    assert.throws(() => upgraded.exec("UPDATE monitors SET monitor_role='invalid'"), /CHECK constraint/);
    assert.throws(() => upgraded.exec(read('../migrations/0010_monitor_routes.sql')), /duplicate column/);
  } finally { upgraded.close(); fresh.close(); }
});
