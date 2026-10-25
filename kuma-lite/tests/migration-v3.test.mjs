import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';

test('v3 upgrades preserve existing observations and open notification threads without creating synthetic results', () => {
  const root = new URL('../', import.meta.url);
  const schema = readFileSync(new URL('schema.sql', root), 'utf8');
  const v2 = schema.split('\n-- Fresh-install structures from 0011_notification_outbox.sql')[0];
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('PRAGMA foreign_keys=ON');
    db.exec(v2);
    db.exec(`INSERT INTO monitors(id,name,url,created_at) VALUES(5,'Existing','https://example.invalid/healthz',0);
      INSERT INTO checks(monitor_id,status,ts,scheduled_slot) VALUES(5,'down',120001,120000);
      INSERT INTO monitor_state(monitor_id,current_status,last_check_slot,slack_alert_ts)
        VALUES(5,'down',120000,'existing-open-thread');`);
    const previousChecks = db.prepare('SELECT * FROM checks').all();
    const previousState = db.prepare('SELECT * FROM monitor_state').all();
    for (const file of ['0011_notification_outbox.sql','0012_monitor_attempts.sql','0013_external_observations.sql']) {
      db.exec(readFileSync(new URL(`migrations/${file}`, root), 'utf8'));
    }
    assert.deepEqual(db.prepare('SELECT * FROM checks').all(), previousChecks);
    assert.deepEqual(db.prepare('SELECT * FROM monitor_state').all(), previousState);
    assert.equal(db.prepare('SELECT slack_alert_ts FROM notification_delivery_state WHERE monitor_id=5').get().slack_alert_ts,
      'existing-open-thread');
    for (const table of ['notification_outbox','monitor_runs','monitor_attempts','external_probe_runs','external_observations']) {
      assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n, 0);
    }
    assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
  } finally { db.close(); }
});
