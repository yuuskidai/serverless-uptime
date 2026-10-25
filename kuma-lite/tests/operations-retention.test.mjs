import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTs, sqliteEnv } from './helpers.mjs';

const { cleanupOldChecks } = loadTs('monitor');
const DAY = 86_400_000;

test('cleanup preserves pending delivery and thread identity while expiring bounded audit history', async t => {
  const now = Date.UTC(2026, 9, 25, 12);
  t.mock.method(Date, 'now', () => now);
  const f = sqliteEnv(); t.after(() => f.close()); f.env.RETENTION_DAYS = '7';
  const queue = f.sqlite.prepare(`INSERT INTO notification_outbox(monitor_id,scheduled_slot,config_revision,kind,
    observed_at,result_json,transition_json,status,created_at,completed_at)
    VALUES(1,?,1,'down',?,'{}','{}',?,?,?)`);
  const records = [
    ['pending', 40, false], ['processing', 40, false], ['sent', 8, true],
    ['cancelled', 8, true], ['failed', 8, true], ['uncertain', 31, true],
    ['uncertain', 10, true], ['sent', 1, true],
  ];
  records.forEach(([status, age, completed], i) => {
    const stamp = now - age * DAY;
    queue.run(i * 60000, stamp, status, stamp, completed ? stamp : null);
  });
  f.sqlite.prepare("INSERT INTO notification_delivery_state(monitor_id,slack_alert_ts) VALUES(1,'existing-thread')").run();
  const attempt = f.sqlite.prepare(`INSERT INTO monitor_attempts(attempt_id,monitor_id,scheduled_time,scheduled_slot,
    received_at,config_revision,monitor_role,probe_transport,decision,reason,observed_at)
    VALUES(?,99,?,?,?,1,'availability','public_fetch','denied','monitor_missing',?)`);
  for (const [id, age] of [['old', 8], ['recent', 1]]) {
    const stamp = now - age * DAY; attempt.run(id, stamp, stamp, stamp, stamp);
    f.sqlite.prepare(`INSERT INTO monitor_runs(run_id,scheduled_time,scheduled_slot,received_at,cron,stage,updated_at)
      VALUES(?,?,?,?, '* * * * *','completed',?)`).run(id, stamp, stamp, stamp, stamp);
  }
  await cleanupOldChecks(f.env);
  assert.deepEqual(f.sqlite.prepare('SELECT status FROM notification_outbox ORDER BY id').all().map(r => r.status),
    ['pending', 'processing', 'uncertain', 'sent']);
  assert.equal(f.sqlite.prepare('SELECT slack_alert_ts FROM notification_delivery_state').get().slack_alert_ts, 'existing-thread');
  assert.deepEqual(f.sqlite.prepare('SELECT attempt_id FROM monitor_attempts').all().map(r => r.attempt_id), ['recent']);
  assert.deepEqual(f.sqlite.prepare('SELECT run_id FROM monitor_runs').all().map(r => r.run_id), ['recent']);
});

test('cleanup expires external runs and their observations together without affecting current witness data', async t => {
  const now = Date.UTC(2026, 9, 25, 12);
  t.mock.method(Date, 'now', () => now);
  const f = sqliteEnv(); t.after(() => f.close()); f.env.RETENTION_DAYS = '7';
  for (const [id, age] of [['1', 8], ['2', 1]]) {
    const stamp = now - age * DAY;
    f.sqlite.prepare(`INSERT INTO external_probe_runs(run_id,run_attempt,payload_hash,commit_sha,recorded_at,observed_at,
      readiness_status,readiness_http_status,readiness_total_ms) VALUES(?,'1','digest','sha',?,?,'fresh',200,20)`)
      .run(id, stamp, stamp);
    f.sqlite.prepare(`INSERT INTO external_observations(run_id,run_attempt,monitor_id,monitor_config_revision,
      observed_at,finished_at,total_ms,status,http_status,database_ms,db_threshold_ms,request_id)
      VALUES(?,'1',1,1,?,?,100,'ok',200,1,1000,'00000000-0000-4000-8000-000000000001')`).run(id, stamp, stamp);
  }
  await cleanupOldChecks(f.env);
  assert.deepEqual(f.sqlite.prepare('SELECT run_id FROM external_probe_runs').all().map(r => r.run_id), ['2']);
  assert.deepEqual(f.sqlite.prepare('SELECT run_id FROM external_observations').all().map(r => r.run_id), ['2']);
  assert.equal(f.sqlite.prepare('PRAGMA foreign_key_check').all().length, 0);
});
