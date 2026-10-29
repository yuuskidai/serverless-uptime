import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { CONFIG_FIELDS, configurationFingerprint, buildPublicRouteCutover, buildPublicRouteRollback }
  from '../ops/public-route-cutover.mjs';

const NOW = Math.floor(Date.now() / 1000) * 1000;
const SLOT = Math.floor((NOW - 1000) / 120000) * 120000;

function fixture(publicGeneration = false) {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  const rows = [5, 6, 9, 10].map(id => {
    const primary = id < 9, portal = id === 5 || id === 9;
    return {
      id, name: `${portal ? 'Partner Portal' : 'Core OS'}${primary ? '' : publicGeneration ? ' internal path' : ' public shadow'}`,
      url: `https://${portal ? 'partner-portal' : 'core-os'}.opus-system.jp/healthz`,
      description: null, fallback_url: null, service_binding: portal ? 'PARTNER_PORTAL' : 'CORE_OS',
      probe_transport: publicGeneration ? primary ? 'public_fetch' : 'service_binding' : primary ? 'legacy' : 'public_fetch',
      monitor_role: primary ? 'availability' : publicGeneration ? 'diagnostic' : 'shadow',
      parent_monitor_id: primary ? null : portal ? 5 : 6,
      response_mode: primary && !publicGeneration ? 'legacy_http' : 'strict_healthz',
      config_revision: (primary ? 2 : 4) + Number(publicGeneration),
      availability_since_ms: primary && publicGeneration ? NOW - 26 * 3600000 : null,
      method: 'GET', expected_status: 200, keyword: null, timeout_ms: 10000, interval_minutes: 2,
      enabled: 1, retry_threshold: 2, latency_threshold_ms: 1500, db_latency_threshold_ms: 1500,
      http_latency_threshold_ms: null, created_at: 0,
    };
  });
  const insert = db.prepare(`INSERT INTO monitors (${CONFIG_FIELDS.join(',')}) VALUES (${CONFIG_FIELDS.map(() => '?').join(',')})`);
  for (const row of rows) {
    insert.run(...CONFIG_FIELDS.map(key => row[key]));
    db.prepare(`INSERT INTO monitor_state (monitor_id,current_status,config_revision,last_check_slot,consecutive_successes)
      VALUES (?,'up',?,?,7)`).run(row.id, row.config_revision, SLOT);
    db.prepare('INSERT INTO notification_delivery_state (monitor_id,last_processed_slot) VALUES (?,?)').run(row.id, SLOT - 120000);
    for (const slot of [SLOT - 120000, SLOT]) {
      db.prepare(`INSERT INTO checks (monitor_id,status,status_code,ts,scheduled_slot,healthz_status,healthz_version,
        config_revision,monitor_role,probe_transport,probe_trace_json)
        VALUES (?,'up',200,?,?,'ok','c9819a4',?,?,?,?)`).run(row.id, slot + 100,
        slot, row.config_revision, row.monitor_role, row.probe_transport === 'legacy' ? 'service_binding' : row.probe_transport,
        JSON.stringify([{ transport: row.probe_transport === 'legacy' ? 'service_binding' : row.probe_transport,
          interval_minutes: 2, request_id: `synthetic-${row.id}-${slot}` }]));
    }
  }
  const snapshot = { monitors: rows, sourceSha: '1'.repeat(40), workerVersion: 'reviewed-worker-version' };
  const review = {
    eligible: true, commonWaitResolved: true, publicMisclassificationResolved: true, reviewedAtMs: NOW - 1000,
    policyEpochMs: NOW - 26 * 3600000, windowStartMs: NOW - 86400000 - 120000, windowEndMs: NOW - 120000,
    sourceSha: snapshot.sourceSha, workerVersion: snapshot.workerVersion,
    configFingerprint: configurationFingerprint(rows), healthVersion: 'c9819a4',
    targets: (publicGeneration ? [5, 6] : [9, 10]).map(monitorId => ({ monitorId,
      configRevision: rows.find(row => row.id === monitorId).config_revision, coverage: .999, failureRate: .001, duplicates: 0,
      invalidSnapshots: 0, contractErrors: 0, requestIdsUnique: true, latestTwoHealthy: true })),
  };
  return { db, snapshot, review, nowMs: NOW, close() { db.close(); } };
}

const readMonitors = f => f.db.prepare('SELECT * FROM monitors ORDER BY id').all();
const protectedRows = f => Object.fromEntries(['checks', 'monitor_state', 'notification_delivery_state', 'notification_outbox']
  .map(table => [table, f.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
const execute = (f, plan = buildPublicRouteCutover(f)) => f.db.prepare(plan.sql).all(...plan.params);

test('all four settings switch atomically while observed history, counters, delivery state and policy stay intact', () => {
  const f = fixture();
  try {
    const before = protectedRows(f), plan = buildPublicRouteCutover(f), output = execute(f, plan);
    assert.equal(output.length, 4);
    const rows = readMonitors(f);
    assert.deepEqual(rows.map(row => row.config_revision), [3, 3, 5, 5]);
    assert.deepEqual(rows.map(row => row.probe_transport), ['public_fetch', 'public_fetch', 'service_binding', 'service_binding']);
    assert.deepEqual(rows.map(row => row.monitor_role), ['availability', 'availability', 'diagnostic', 'diagnostic']);
    assert.ok(rows.every(row => row.response_mode === 'strict_healthz' && row.interval_minutes === 2 &&
      row.timeout_ms === 10000 && row.retry_threshold === 2 && row.db_latency_threshold_ms === 1500));
    assert.deepEqual(rows.map(row => row.parent_monitor_id), [null, null, 5, 6]);
    assert.ok(rows.slice(0, 2).every(row => row.availability_since_ms >= NOW));
    assert.deepEqual(protectedRows(f), before);
    assert.equal(execute(f, plan).length, 0, 'same statement cannot apply twice');
  } finally { f.close(); }
});

test('rollback starts new revisions, archives prior public boundaries and keeps evidence', () => {
  const f = fixture(true);
  try {
    const before = protectedRows(f), plan = buildPublicRouteRollback(f);
    assert.equal(plan.preservedPublicBoundaries.length, 2);
    assert.deepEqual(plan.preservedPublicBoundaries.map(row => row.availability_since_ms), [NOW - 26 * 3600000, NOW - 26 * 3600000]);
    assert.equal(execute(f, plan).length, 4);
    const rows = readMonitors(f);
    assert.deepEqual(rows.map(row => row.config_revision), [4, 4, 6, 6]);
    assert.deepEqual(rows.map(row => row.probe_transport), ['legacy', 'legacy', 'public_fetch', 'public_fetch']);
    assert.deepEqual(rows.map(row => row.monitor_role), ['availability', 'availability', 'shadow', 'shadow']);
    assert.ok(rows.every(row => row.availability_since_ms === null));
    assert.deepEqual(protectedRows(f), before);
    assert.equal(execute(f, plan).length, 0);
  } finally { f.close(); }
});

const reviewFailures = {
  'missing approval': f => { delete f.review.eligible; },
  'unresolved common wait': f => { f.review.commonWaitResolved = false; },
  'unresolved public misclassification': f => { f.review.publicMisclassificationResolved = false; },
  'stale review': f => { f.review.reviewedAtMs = NOW - 300001; },
  'future review': f => { f.review.reviewedAtMs = NOW + 1; },
  'short comparison': f => { f.review.windowStartMs = f.review.windowEndMs - 86400000 + 1; },
  'mixed policy window': f => { f.review.policyEpochMs = f.review.windowStartMs + 1; },
  'unobserved future': f => { f.review.windowEndMs = NOW; },
  'stale comparison with a fresh review': f => {
    f.review.windowEndMs = NOW - 3600000; f.review.windowStartMs = NOW - 25 * 3600000;
  },
  'source drift': f => { f.review.sourceSha = '2'.repeat(40); },
  'deployment drift': f => { f.review.workerVersion = 'another-version'; },
  'settings drift': f => { f.review.configFingerprint = '0'.repeat(64); },
  'coverage low': f => { f.review.targets[0].coverage = .9899; },
  'failure high': f => { f.review.targets[1].failureRate = .0101; },
  'duplicate checks': f => { f.review.targets[0].duplicates = 1; },
  'invalid path snapshot': f => { f.review.targets[0].invalidSnapshots = 1; },
  'contract errors': f => { f.review.targets[1].contractErrors = 1; },
  'reused request IDs': f => { f.review.targets[1].requestIdsUnique = false; },
  'latest health not confirmed': f => { f.review.targets[1].latestTwoHealthy = false; },
};
for (const [name, alter] of Object.entries(reviewFailures)) test(`generator refuses ${name}`, () => {
  const f = fixture();
  try { alter(f); assert.throws(() => buildPublicRouteCutover(f), /Cutover refused/); }
  finally { f.close(); }
});

const databaseFailures = {
  'changed revision': f => f.db.exec('UPDATE monitors SET config_revision=3 WHERE id=5'),
  'nullable setting change': f => f.db.exec("UPDATE monitors SET fallback_url='https://example.invalid/' WHERE id=10"),
  'disabled row': f => f.db.exec('UPDATE monitors SET enabled=0 WHERE id=9'),
  'missing row': f => f.db.exec('DELETE FROM checks WHERE monitor_id=10; DELETE FROM monitor_state WHERE monitor_id=10; DELETE FROM notification_delivery_state WHERE monitor_id=10; DELETE FROM monitors WHERE id=10'),
  'open outage': f => f.db.exec("UPDATE monitor_state SET current_status='down' WHERE monitor_id=5"),
  'open degraded incident': f => f.db.exec("UPDATE monitor_state SET current_status='degraded' WHERE monitor_id=6"),
  'old state revision': f => f.db.exec('UPDATE monitor_state SET config_revision=1 WHERE monitor_id=5'),
  'missing state': f => f.db.exec('DELETE FROM monitor_state WHERE monitor_id=10'),
  'open state thread': f => f.db.exec("UPDATE monitor_state SET slack_alert_ts='synthetic-thread' WHERE monitor_id=5"),
  'unfinished outage': f => f.db.exec('UPDATE monitor_state SET down_since=1 WHERE monitor_id=5'),
  'state not latest': f => f.db.exec('UPDATE monitor_state SET last_check_slot=0 WHERE monitor_id=5'),
  'maintenance': f => f.db.prepare('UPDATE monitor_state SET maintenance_to=? WHERE monitor_id=9').run(NOW + 60000),
  'probe lease': f => f.db.prepare('INSERT INTO monitor_execution VALUES (5,0,?,?)').run('synthetic-owner', NOW + 60000),
  'delivery lease': f => f.db.prepare('UPDATE notification_delivery_state SET lease_until=? WHERE monitor_id=9').run(NOW + 60000),
  'active delivery': f => f.db.exec('UPDATE notification_delivery_state SET active_outbox_id=42 WHERE monitor_id=9'),
  'open delivery thread': f => f.db.exec("UPDATE notification_delivery_state SET slack_alert_ts='synthetic-thread' WHERE monitor_id=6"),
  'latest actual failure': f => f.db.exec("UPDATE checks SET status='down',status_code=503 WHERE monitor_id=10 AND scheduled_slot=(SELECT MAX(scheduled_slot) FROM checks)"),
  'degraded latest': f => f.db.exec("UPDATE checks SET healthz_status='degraded' WHERE monitor_id=6"),
  'old application': f => f.db.exec("UPDATE checks SET healthz_version='oldbuild' WHERE monitor_id=9"),
  'wrong path': f => f.db.exec("UPDATE checks SET probe_transport='service_binding' WHERE monitor_id=9"),
  'wrong trace path': f => f.db.exec("UPDATE checks SET probe_trace_json='[{\"transport\":\"service_binding\",\"interval_minutes\":2}]' WHERE monitor_id=9"),
  'wrong interval snapshot': f => f.db.exec("UPDATE checks SET probe_trace_json='[{\"transport\":\"public_fetch\",\"interval_minutes\":1}]' WHERE monitor_id=9"),
  'missing request ID': f => f.db.exec("UPDATE checks SET probe_trace_json=json_remove(probe_trace_json,'$[0].request_id') WHERE monitor_id=9"),
  'reused request ID': f => f.db.exec("UPDATE checks SET probe_trace_json=json_set(probe_trace_json,'$[0].request_id','same-synthetic-id') WHERE monitor_id=9"),
  'malformed trace': f => f.db.exec("UPDATE checks SET probe_trace_json='not JSON' WHERE monitor_id=9"),
  'fallback result': f => f.db.exec('UPDATE checks SET used_fallback=1 WHERE monitor_id=9'),
  'missing latest sample': f => f.db.exec('DELETE FROM checks WHERE monitor_id=9 AND scheduled_slot=(SELECT MIN(scheduled_slot) FROM checks)'),
  'nonconsecutive samples': f => f.db.prepare('UPDATE checks SET scheduled_slot=scheduled_slot-120000 WHERE monitor_id=9 AND scheduled_slot=?').run(SLOT - 120000),
  'recent probe from stale slot': f => f.db.exec('UPDATE checks SET scheduled_slot=scheduled_slot-86400000 WHERE monitor_id=9'),
  'future sample': f => f.db.prepare('UPDATE checks SET ts=? WHERE monitor_id=9').run(NOW + 60000),
};
for (const status of ['pending', 'processing', 'uncertain', 'failed']) databaseFailures[`${status} outbox`] = f => {
  f.db.prepare(`INSERT INTO notification_outbox (monitor_id,scheduled_slot,config_revision,kind,observed_at,result_json,transition_json,status,created_at)
    VALUES (5,0,2,'down',0,'{}','{}',?,0)`).run(status);
};
for (const [name, alter] of Object.entries(databaseFailures)) test(`atomic SQL refuses ${name} without changing any other monitor`, () => {
  const f = fixture();
  try {
    const plan = buildPublicRouteCutover(f);
    alter(f);
    const before = readMonitors(f), protectedBefore = protectedRows(f);
    assert.equal(execute(f, plan).length, 0);
    assert.deepEqual(readMonitors(f), before);
    assert.deepEqual(protectedRows(f), protectedBefore);
  } finally { f.close(); }
});

test('database clock rejects a review that expired after generation', () => {
  const f = fixture();
  try {
    const plan = buildPublicRouteCutover(f);
    plan.params[2] = NOW - 300001; plan.params[3] = NOW - 300001;
    assert.equal(execute(f, plan).length, 0);
  } finally { f.close(); }
});

test('comparison bounds include exactly 24 hours, 99 percent coverage and one percent failures', () => {
  const f = fixture();
  try {
    f.review.windowStartMs = f.review.windowEndMs - 86400000;
    f.review.targets.forEach(target => { target.coverage = .99; target.failureRate = .01; });
    assert.equal(buildPublicRouteCutover(f).expectedChanges, 4);
  } finally { f.close(); }
});

test('rollback review must describe public availability, not the internal diagnostic series', () => {
  const f = fixture(true);
  try {
    f.review.targets.forEach((target, index) => {
      target.monitorId = index + 9; target.configRevision = 5;
    });
    assert.throws(() => buildPublicRouteRollback(f), /Cutover refused/);
  } finally { f.close(); }
});

test('rollback comparison cannot reuse observations before the public boundary', () => {
  const f = fixture(true);
  try {
    f.snapshot.monitors[0].availability_since_ms = NOW - 3600000;
    f.review.configFingerprint = configurationFingerprint(f.snapshot.monitors);
    assert.throws(() => buildPublicRouteRollback(f), /public-availability boundary/);
  } finally { f.close(); }
});
