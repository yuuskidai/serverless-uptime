import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import {
  CONFIG_FIELDS, SAFE_STATE_FIELDS, DELIVERY_FIELDS, configurationFingerprint,
  buildPublicRouteCutover, buildPublicRouteRollback, createHandoffReceipt,
} from '../ops/public-route-cutover.mjs';

const INTERVAL = 120000;
const plainRows = rows => rows.map(row => ({ ...row }));

function snapshot(f) {
  return {
    monitors: plainRows(f.db.prepare(`SELECT ${CONFIG_FIELDS.join(',')} FROM monitors ORDER BY id`).all()),
    states: plainRows(f.db.prepare(`SELECT ${SAFE_STATE_FIELDS.join(',')} FROM monitor_state ORDER BY monitor_id`).all()),
    delivery: plainRows(f.db.prepare(`SELECT ${DELIVERY_FIELDS.join(',')} FROM notification_delivery_state ORDER BY monitor_id`).all()),
    sourceSha: '1'.repeat(40), workerVersion: 'reviewed-worker-version',
  };
}

function reviewFor(settings, nowMs) {
  return {
    eligible: true, routeEvidenceReviewed: true, strictPublicResponseReviewed: true,
    missingAsUnknown: true, immediateRollbackReviewed: true, rollbackReviewed: true, reviewedAtMs: nowMs - 1000,
    sourceSha: settings.sourceSha, workerVersion: settings.workerVersion,
    configFingerprint: configurationFingerprint(settings.monitors), healthVersion: 'c9819a4',
    targets: [9, 10].map(monitorId => ({ monitorId,
      configRevision: settings.monitors.find(row => row.id === monitorId).config_revision,
      duplicates: 0, invalidSnapshots: 0, contractErrors: 0,
      requestIdsUnique: true, latestTwoHealthy: true,
    })),
  };
}

function addCheck(f, monitorId, { slot, status = 'up', health = 'ok', revision, transport, role } = {}) {
  const row = f.db.prepare('SELECT * FROM monitors WHERE id=?').get(monitorId);
  const path = transport ?? (row.probe_transport === 'legacy' ? 'service_binding' : row.probe_transport);
  f.db.prepare(`INSERT INTO checks (monitor_id,status,status_code,ts,scheduled_slot,healthz_status,healthz_version,
    config_revision,monitor_role,probe_transport,probe_trace_json)
    VALUES (?,?,?,?,?,?,'c9819a4',?,?,?,?)`).run(monitorId, status, status === 'down' ? 503 : 200,
    slot + 100, slot, health, revision ?? row.config_revision, role ?? row.monitor_role, path,
    JSON.stringify([{ transport: path, interval_minutes: 2, request_id: `synthetic-${monitorId}-${slot}` }]));
}

function fixture() {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  const nowMs = Math.floor(Date.now() / 1000) * 1000;
  const slot = Math.floor((nowMs - 1000) / INTERVAL) * INTERVAL;
  const rows = [5, 6, 9, 10].map(id => {
    const primary = id < 9, portal = id === 5 || id === 9;
    return {
      id, name: `${portal ? 'Partner Portal' : 'Core OS'}${primary ? '' : ' public shadow'}`,
      url: `https://${portal ? 'partner-portal' : 'core-os'}.opus-system.jp/healthz`,
      description: null, fallback_url: null, service_binding: portal ? 'PARTNER_PORTAL' : 'CORE_OS',
      probe_transport: primary ? 'legacy' : 'public_fetch',
      monitor_role: primary ? 'availability' : 'shadow', parent_monitor_id: primary ? null : portal ? 5 : 6,
      response_mode: primary ? 'legacy_http' : 'strict_healthz', config_revision: primary ? 2 : 4,
      availability_since_ms: null, method: 'GET', expected_status: 200, keyword: null,
      timeout_ms: 10000, interval_minutes: 2, enabled: 1, retry_threshold: 2,
      latency_threshold_ms: 1500, db_latency_threshold_ms: 1500, http_latency_threshold_ms: null, created_at: 0,
    };
  });
  const insert = db.prepare(`INSERT INTO monitors (${CONFIG_FIELDS.join(',')}) VALUES (${CONFIG_FIELDS.map(() => '?').join(',')})`);
  const f = { db, nowMs, clockMs: nowMs, slot, close() { db.close(); } };
  // Advance the local database and operator clocks together in handoff tests.
  db.function('strftime', { varargs: true }, (format, when) => {
    assert.equal(format, '%s'); assert.equal(when, 'now');
    return String(Math.floor(f.clockMs / 1000));
  });
  for (const row of rows) {
    insert.run(...CONFIG_FIELDS.map(key => row[key]));
    db.prepare(`INSERT INTO monitor_state (monitor_id,current_status,config_revision,last_check_slot,consecutive_successes,last_notified_at)
      VALUES (?,'up',?,?,7,?)`).run(row.id, row.config_revision, slot, nowMs - 86400000);
    db.prepare('INSERT INTO notification_delivery_state (monitor_id,last_processed_slot) VALUES (?,?)').run(row.id, slot - INTERVAL);
    for (const checkSlot of [slot - INTERVAL, slot]) addCheck(f, row.id, { slot: checkSlot });
  }
  f.snapshot = snapshot(f);
  f.review = reviewFor(f.snapshot, nowMs);
  return f;
}

const readMonitors = f => plainRows(f.db.prepare('SELECT * FROM monitors ORDER BY id').all());
const protectedRows = f => Object.fromEntries([
  'checks', 'monitor_state', 'notification_delivery_state', 'notification_outbox', 'monitor_runs', 'monitor_attempts',
].map(table => [table, plainRows(f.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all())]));
const execute = (f, plan = buildPublicRouteCutover(f)) => f.db.prepare(plan.sql).all(...plan.params);

function handoff(f) {
  const beforeSnapshot = structuredClone(f.snapshot);
  const plan = buildPublicRouteCutover(f);
  assert.equal(execute(f, plan).length, 4);
  const afterSnapshot = snapshot(f);
  f.receipt = createHandoffReceipt({ beforeSnapshot, afterSnapshot,
    reviewedAtMs: f.review.reviewedAtMs, nowMs: f.clockMs });
  f.snapshot = afterSnapshot;
  f.nowMs = f.clockMs;
  f.review = reviewFor(afterSnapshot, f.nowMs);
  return f.receipt;
}

function refresh(f) {
  f.snapshot = snapshot(f);
  f.nowMs = f.clockMs;
  f.review = reviewFor(f.snapshot, f.nowMs);
}

test('four-row public handoff preserves observations, counters, notifications and approved probe policy', () => {
  const f = fixture();
  try {
    const before = protectedRows(f), plan = buildPublicRouteCutover(f);
    assert.equal(execute(f, plan).length, 4);
    const rows = readMonitors(f);
    assert.deepEqual(rows.map(row => row.config_revision), [3, 3, 5, 5]);
    assert.deepEqual(rows.map(row => row.probe_transport), ['public_fetch', 'public_fetch', 'service_binding', 'service_binding']);
    assert.deepEqual(rows.map(row => row.monitor_role), ['availability', 'availability', 'diagnostic', 'diagnostic']);
    assert.deepEqual(rows.map(row => row.parent_monitor_id), [null, null, 5, 6]);
    assert.ok(rows.every(row => row.response_mode === 'strict_healthz' && row.interval_minutes === 2 && row.timeout_ms === 10000 &&
      row.retry_threshold === 2 && row.db_latency_threshold_ms === 1500));
    assert.ok(rows.slice(0, 2).every(row => row.availability_since_ms >= f.review.reviewedAtMs));
    assert.deepEqual(protectedRows(f), before);
    assert.equal(execute(f, plan).length, 0, 'a duplicate acknowledged handoff is refused');
  } finally { f.close(); }
});

test('review uses route correctness rather than shared-wait, duration or availability-rate admission gates', () => {
  const f = fixture();
  try {
    Object.assign(f.review, { commonWaitResolved: false, windowStartMs: f.nowMs - 3600000, windowEndMs: f.nowMs - 120000 });
    f.review.targets.forEach(target => Object.assign(target, { coverage: .98, failureRate: .1 }));
    assert.equal(execute(f).length, 4);
  } finally { f.close(); }
});

test('a lone internal warning without an open incident does not veto healthy public availability', () => {
  const f = fixture();
  try {
    f.db.exec("UPDATE checks SET healthz_status='degraded' WHERE monitor_id=6 AND scheduled_slot=(SELECT MAX(scheduled_slot) FROM checks)");
    const before = protectedRows(f);
    assert.equal(execute(f).length, 4);
    assert.deepEqual(protectedRows(f), before);
  } finally { f.close(); }
});

test('a confirmed handoff can be reversed before any new-generation observations, without modifying old state', () => {
  const f = fixture();
  try {
    const original = readMonitors(f), evidence = protectedRows(f);
    handoff(f);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM checks c JOIN monitors m ON m.id=c.monitor_id AND m.config_revision=c.config_revision').get().n, 0);
    const plan = buildPublicRouteRollback(f);
    assert.equal(execute(f, plan).length, 4);
    const after = readMonitors(f);
    assert.deepEqual(after.map(row => row.config_revision), [4, 4, 6, 6]);
    assert.deepEqual(after.map(row => row.probe_transport), original.map(row => row.probe_transport));
    assert.deepEqual(after.map(row => row.monitor_role), original.map(row => row.monitor_role));
    assert.deepEqual(after.map(row => row.response_mode), original.map(row => row.response_mode));
    assert.ok(after.every(row => row.availability_since_ms === null));
    assert.deepEqual(protectedRows(f), evidence);
    assert.equal(execute(f, plan).length, 0, 'rollback cannot be acknowledged twice');
  } finally { f.close(); }
});

for (const result of ['up', 'down', 'degraded']) test(`one accepted ${result} observation can be backed out while state is UP and no incident is open`, () => {
  const f = fixture();
  try {
    handoff(f);
    const slot = f.slot + INTERVAL;
    f.clockMs = slot + 1000;
    addCheck(f, 5, { slot, status: result === 'down' ? 'down' : 'up', health: result === 'up' ? 'ok' : result });
    f.db.prepare(`UPDATE monitor_state SET config_revision=3,last_check_slot=?,consecutive_failures=?,consecutive_degraded=?,consecutive_successes=0 WHERE monitor_id=5`)
      .run(slot, result === 'down' ? 1 : 0, result === 'degraded' ? 1 : 0);
    refresh(f);
    const before = protectedRows(f), plan = buildPublicRouteRollback(f);
    assert.equal(execute(f, plan).length, 4);
    assert.deepEqual(protectedRows(f), before, 'the new observation and failure counter survive backout');
    assert.deepEqual(readMonitors(f).map(row => row.config_revision), [4, 4, 6, 6]);
  } finally { f.close(); }
});

test('confirmed readback may include a natural observation without overwriting the guarded pre-state receipt', () => {
  const f = fixture();
  try {
    const beforeSnapshot = structuredClone(f.snapshot), reviewedAtMs = f.review.reviewedAtMs;
    assert.equal(execute(f).length, 4);
    const slot = f.slot + INTERVAL;
    f.clockMs = slot + 1000;
    addCheck(f, 5, { slot, status: 'down', health: 'down' });
    f.db.prepare('UPDATE monitor_state SET config_revision=3,last_check_slot=?,consecutive_failures=1 WHERE monitor_id=5').run(slot);
    const afterSnapshot = snapshot(f);
    f.receipt = createHandoffReceipt({ beforeSnapshot, afterSnapshot, reviewedAtMs, nowMs: f.clockMs });
    assert.deepEqual(f.receipt.beforeStates, beforeSnapshot.states);
    refresh(f);
    const before = protectedRows(f);
    assert.equal(execute(f, buildPublicRouteRollback(f)).length, 4);
    assert.deepEqual(protectedRows(f), before);
  } finally { f.close(); }
});

const reviewFailures = {
  'missing eligibility decision': f => { delete f.review.eligible; },
  'unreviewed route evidence': f => { f.review.routeEvidenceReviewed = false; },
  'unreviewed strict response contract': f => { f.review.strictPublicResponseReviewed = false; },
  'missing UNKNOWN policy': f => { f.review.missingAsUnknown = false; },
  'unreviewed immediate rollback': f => { f.review.immediateRollbackReviewed = false; },
  'stale review': f => { f.review.reviewedAtMs = f.nowMs - 300001; },
  'future review': f => { f.review.reviewedAtMs = f.nowMs + 1000; },
  'source drift': f => { f.review.sourceSha = '2'.repeat(40); },
  'deployment drift': f => { f.review.workerVersion = 'another-version'; },
  'settings fingerprint drift': f => { f.review.configFingerprint = '0'.repeat(64); },
  'duplicate checks': f => { f.review.targets[0].duplicates = 1; },
  'invalid route snapshot': f => { f.review.targets[0].invalidSnapshots = 1; },
  'contract errors': f => { f.review.targets[1].contractErrors = 1; },
  'reused request IDs': f => { f.review.targets[1].requestIdsUnique = false; },
  'latest public health not confirmed': f => { f.review.targets[1].latestTwoHealthy = false; },
  'wrong comparison generation': f => { f.review.targets[1].configRevision = 99; },
  'missing state snapshot': f => { f.snapshot.states.pop(); },
  'missing delivery snapshot': f => { f.snapshot.delivery.pop(); },
};
for (const [name, alter] of Object.entries(reviewFailures)) test(`forward generator refuses ${name}`, () => {
  const f = fixture();
  try { alter(f); assert.throws(() => buildPublicRouteCutover(f), /refused/i); }
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
  'maintenance': f => f.db.prepare('UPDATE monitor_state SET maintenance_to=? WHERE monitor_id=9').run(f.nowMs + 60000),
  'probe lease': f => f.db.prepare('INSERT INTO monitor_execution VALUES (5,0,?,?)').run('synthetic-owner', f.nowMs + 60000),
  'delivery lease': f => f.db.prepare('UPDATE notification_delivery_state SET lease_until=? WHERE monitor_id=9').run(f.nowMs + 60000),
  'active delivery': f => f.db.exec('UPDATE notification_delivery_state SET active_outbox_id=42 WHERE monitor_id=9'),
  'open delivery thread': f => f.db.exec("UPDATE notification_delivery_state SET slack_alert_ts='synthetic-thread' WHERE monitor_id=6"),
  'latest public failure': f => f.db.exec("UPDATE checks SET status='down',status_code=503 WHERE monitor_id=10 AND scheduled_slot=(SELECT MAX(scheduled_slot) FROM checks)"),
  'degraded public latest': f => f.db.exec("UPDATE checks SET healthz_status='degraded' WHERE monitor_id=9"),
  'old application': f => f.db.exec("UPDATE checks SET healthz_version='oldbuild' WHERE monitor_id=9"),
  'wrong route': f => f.db.exec("UPDATE checks SET probe_transport='service_binding' WHERE monitor_id=9"),
  'wrong trace route': f => f.db.exec("UPDATE checks SET probe_trace_json='[{\"transport\":\"service_binding\",\"interval_minutes\":2}]' WHERE monitor_id=9"),
  'wrong interval snapshot': f => f.db.exec("UPDATE checks SET probe_trace_json='[{\"transport\":\"public_fetch\",\"interval_minutes\":1}]' WHERE monitor_id=9"),
  'missing request ID': f => f.db.exec("UPDATE checks SET probe_trace_json=json_remove(probe_trace_json,'$[0].request_id') WHERE monitor_id=9"),
  'reused request ID': f => f.db.exec("UPDATE checks SET probe_trace_json=json_set(probe_trace_json,'$[0].request_id','same-synthetic-id') WHERE monitor_id=9"),
  'malformed trace': f => f.db.exec("UPDATE checks SET probe_trace_json='not JSON' WHERE monitor_id=9"),
  'fallback result': f => f.db.exec('UPDATE checks SET used_fallback=1 WHERE monitor_id=9'),
  'missing sample': f => f.db.exec('DELETE FROM checks WHERE monitor_id=9 AND scheduled_slot=(SELECT MIN(scheduled_slot) FROM checks)'),
  'nonconsecutive samples': f => f.db.prepare('UPDATE checks SET scheduled_slot=scheduled_slot-120000 WHERE monitor_id=9 AND scheduled_slot=?').run(f.slot - INTERVAL),
  'recent probe from stale slot': f => f.db.exec('UPDATE checks SET scheduled_slot=scheduled_slot-86400000 WHERE monitor_id=9'),
  'future sample': f => f.db.prepare('UPDATE checks SET ts=? WHERE monitor_id=9').run(f.nowMs + 60000),
};
for (const status of ['pending', 'processing', 'uncertain', 'failed']) databaseFailures[`${status} outbox`] = f => {
  f.db.prepare(`INSERT INTO notification_outbox (monitor_id,scheduled_slot,config_revision,kind,observed_at,result_json,transition_json,status,created_at)
    VALUES (5,0,2,'down',0,'{}','{}',?,0)`).run(status);
};
for (const [name, alter] of Object.entries(databaseFailures)) test(`forward atomic SQL refuses ${name} without changing another monitor`, () => {
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

test('database time rejects a review that expired after forward generation', () => {
  const f = fixture();
  try {
    f.nowMs = f.clockMs - 300001;
    f.review.reviewedAtMs = f.nowMs - 1000;
    const plan = buildPublicRouteCutover(f);
    assert.equal(execute(f, plan).length, 0);
  } finally { f.close(); }
});

const rollbackDatabaseFailures = {
  'new setting revision': f => f.db.exec('UPDATE monitors SET config_revision=config_revision+1 WHERE id=6'),
  'public boundary changed': f => f.db.exec('UPDATE monitors SET availability_since_ms=availability_since_ms+1 WHERE id=5'),
  'old state counter changed without a new check': f => f.db.exec('UPDATE monitor_state SET consecutive_failures=1 WHERE monitor_id=6'),
  'old state generation changed': f => f.db.exec('UPDATE monitor_state SET config_revision=99 WHERE monitor_id=9'),
  'new DOWN incident': f => f.db.exec("UPDATE monitor_state SET current_status='down',down_since=1 WHERE monitor_id=5"),
  'new DEGRADED incident': f => f.db.exec("UPDATE monitor_state SET current_status='degraded' WHERE monitor_id=9"),
  'state thread': f => f.db.exec("UPDATE monitor_state SET slack_alert_ts='new-thread' WHERE monitor_id=6"),
  'maintenance': f => f.db.prepare('UPDATE monitor_state SET maintenance_to=? WHERE monitor_id=10').run(f.nowMs + 60000),
  'delivery thread': f => f.db.exec("UPDATE notification_delivery_state SET slack_alert_ts='new-thread' WHERE monitor_id=5"),
  'probe lease': f => f.db.prepare('INSERT INTO monitor_execution VALUES (5,0,?,?)').run('synthetic-owner', f.nowMs + 60000),
  'delivery lease': f => f.db.prepare('UPDATE notification_delivery_state SET lease_until=? WHERE monitor_id=6').run(f.nowMs + 60000),
  'active delivery pointer': f => f.db.exec('UPDATE notification_delivery_state SET active_outbox_id=55 WHERE monitor_id=10'),
};
for (const status of ['pending', 'processing', 'uncertain', 'failed']) rollbackDatabaseFailures[`${status} outbox`] = databaseFailures[`${status} outbox`];
for (const [name, alter] of Object.entries(rollbackDatabaseFailures)) test(`immediate rollback refuses concurrent ${name} atomically`, () => {
  const f = fixture();
  try {
    handoff(f);
    const plan = buildPublicRouteRollback(f);
    alter(f);
    const before = readMonitors(f), evidence = protectedRows(f);
    assert.equal(execute(f, plan).length, 0);
    assert.deepEqual(readMonitors(f), before);
    assert.deepEqual(protectedRows(f), evidence);
  } finally { f.close(); }
});

test('an unexplained changed old state is refused even when the operator refreshes the snapshot', () => {
  const f = fixture();
  try {
    handoff(f);
    f.db.exec('UPDATE monitor_state SET consecutive_failures=1 WHERE monitor_id=6');
    refresh(f);
    const before = readMonitors(f), evidence = protectedRows(f);
    try {
      const plan = buildPublicRouteRollback(f);
      assert.equal(execute(f, plan).length, 0);
    } catch (error) { assert.match(error.message, /refused/i); }
    assert.deepEqual(readMonitors(f), before);
    assert.deepEqual(protectedRows(f), evidence);
  } finally { f.close(); }
});

for (const [name, alter] of Object.entries({
  'source': receipt => { receipt.sourceSha = '2'.repeat(40); },
  'worker': receipt => { receipt.workerVersion = 'another-version'; },
  'saved pre-state tampering': receipt => { receipt.beforeStates[0].consecutive_failures = 1; },
  'saved before config tampering': receipt => { receipt.beforeMonitors[0].timeout_ms = 30000; },
  'saved public boundary tampering': receipt => { receipt.afterMonitors[0].availability_since_ms += 1; },
  'saved after generation tampering': receipt => { receipt.afterMonitors[0].config_revision += 1; },
  'missing receipt': (_receipt, f) => { f.receipt = null; },
})) test(`rollback rejects ${name} receipt without state changes`, () => {
  const f = fixture();
  try {
    handoff(f); alter(f.receipt, f);
    const before = protectedRows(f);
    assert.throws(() => buildPublicRouteRollback(f), /refused/i);
    assert.deepEqual(protectedRows(f), before);
  } finally { f.close(); }
});

for (const [name, alter] of Object.entries({
  'expired rollback decision': f => { f.review.reviewedAtMs = f.nowMs - 300001; },
  'future rollback decision': f => { f.review.reviewedAtMs = f.nowMs + 1; },
  'changed reviewed source': f => { f.review.sourceSha = '2'.repeat(40); },
  'changed reviewed Worker': f => { f.review.workerVersion = 'another-version'; },
  'missing rollback review': f => { f.review.rollbackReviewed = false; },
})) test(`rollback generator refuses ${name}`, () => {
  const f = fixture();
  try {
    handoff(f); alter(f);
    assert.throws(() => buildPublicRouteRollback(f), /refused/i);
  } finally { f.close(); }
});

test('rollback does not demand healthy public-route evidence for the route being rejected', () => {
  const f = fixture();
  try {
    handoff(f);
    for (const key of ['routeEvidenceReviewed', 'strictPublicResponseReviewed', 'immediateRollbackReviewed', 'healthVersion', 'targets']) delete f.review[key];
    const before = protectedRows(f);
    assert.equal(execute(f, buildPublicRouteRollback(f)).length, 4);
    assert.deepEqual(protectedRows(f), before);
  } finally { f.close(); }
});

test('database time rejects a rollback decision that expires after statement generation', () => {
  const f = fixture();
  try {
    handoff(f);
    const plan = buildPublicRouteRollback(f);
    f.clockMs += 300001;
    const before = readMonitors(f), evidence = protectedRows(f);
    assert.equal(execute(f, plan).length, 0);
    assert.deepEqual(readMonitors(f), before);
    assert.deepEqual(protectedRows(f), evidence);
  } finally { f.close(); }
});

test('one untracked current-generation check cannot back out against an unchanged old state', () => {
  const f = fixture();
  try {
    handoff(f);
    f.clockMs = f.slot + INTERVAL + 1000;
    addCheck(f, 5, { slot: f.slot + INTERVAL });
    refresh(f);
    const before = protectedRows(f), settings = readMonitors(f);
    assert.equal(execute(f, buildPublicRouteRollback(f)).length, 0);
    assert.deepEqual(protectedRows(f), before);
    assert.deepEqual(readMonitors(f), settings);
  } finally { f.close(); }
});

test('a refreshed current-generation state must still point to its exact latest accepted check', () => {
  const f = fixture();
  try {
    handoff(f);
    const slot = f.slot + INTERVAL;
    f.clockMs = slot + 1000;
    addCheck(f, 5, { slot });
    f.db.prepare('UPDATE monitor_state SET config_revision=3,last_check_slot=? WHERE monitor_id=5').run(slot + INTERVAL);
    refresh(f);
    const before = protectedRows(f), settings = readMonitors(f);
    assert.equal(execute(f, buildPublicRouteRollback(f)).length, 0);
    assert.deepEqual(protectedRows(f), before);
    assert.deepEqual(readMonitors(f), settings);
  } finally { f.close(); }
});

test('receipt creation rejects a partial four-row application instead of treating it as confirmed', () => {
  const f = fixture();
  try {
    const beforeSnapshot = structuredClone(f.snapshot);
    f.db.exec("UPDATE monitors SET config_revision=3,probe_transport='public_fetch',response_mode='strict_healthz',availability_since_ms=CAST(strftime('%s','now') AS INTEGER)*1000 WHERE id=5");
    assert.throws(() => createHandoffReceipt({ beforeSnapshot, afterSnapshot: snapshot(f),
      reviewedAtMs: f.review.reviewedAtMs, nowMs: f.clockMs }), /refused/i);
  } finally { f.close(); }
});
