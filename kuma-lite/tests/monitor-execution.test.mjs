import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { loadTs, result, root, sqliteEnv } from './helpers.mjs';

const execution = loadTs('monitor-execution');
const { deriveTransition } = loadTs('state-transition');
const SLOT = Math.floor(Date.now() / 60000) * 60000;

async function commit(f, lease, state = 'up', previous) {
  previous ??= await execution.readMonitorState(f.env, 1);
  const r = result(state);
  const transition = deriveTransition(f.monitor, r, previous, Date.now(), lease.slotMs, false);
  const committed = await execution.commitMonitorResult(f.env, f.monitor, lease, r, previous, transition, Date.now(), false);
  return { committed, transition };
}

test('same scheduled slot is claimed once across independent module instances and after release', async () => {
  const f = sqliteEnv();
  try {
    const secondIsolate = loadTs('monitor-execution');
    const claims = await Promise.all([execution.claimMonitorSlot(f.env, 1, SLOT), secondIsolate.claimMonitorSlot(f.env, 1, SLOT)]);
    assert.equal(claims.filter(Boolean).length, 1);
    await execution.releaseMonitorSlot(f.env, claims.find(Boolean));
    assert.equal(await execution.claimMonitorSlot(f.env, 1, SLOT), null);
    assert.equal(await execution.claimMonitorSlot(f.env, 1, SLOT - 60000), null);
    assert.ok(await execution.claimMonitorSlot(f.env, 1, SLOT + 60000));
  } finally { f.close(); }
});

test('a live lease blocks newer slots; a crash expires into a newer slot, never the same slot', async () => {
  const f = sqliteEnv();
  try {
    const old = await execution.claimMonitorSlot(f.env, 1, SLOT);
    assert.equal(await execution.claimMonitorSlot(f.env, 1, SLOT + 60000), null);
    f.sqlite.exec('UPDATE monitor_execution SET lease_until = 0');
    assert.equal(await execution.claimMonitorSlot(f.env, 1, SLOT), null);
    const replacement = await execution.claimMonitorSlot(f.env, 1, SLOT + 60000);
    assert.ok(replacement);
    await execution.releaseMonitorSlot(f.env, old);
    assert.equal(f.sqlite.prepare('SELECT lease_token FROM monitor_execution').get().lease_token, replacement.token);
    assert.ok(f.sqlite.prepare('SELECT lease_until FROM monitor_execution').get().lease_until > Date.now());
  } finally { f.close(); }
});

test('an expired runner cannot append a check, advance state, renew, or replace the newer alert thread', async () => {
  const f = sqliteEnv();
  try {
    const old = await execution.claimMonitorSlot(f.env, 1, SLOT);
    f.sqlite.exec('UPDATE monitor_execution SET lease_until = 0');
    const replacement = await execution.claimMonitorSlot(f.env, 1, SLOT + 60000);
    assert.equal((await commit(f, replacement)).committed, true);
    await execution.saveAlertThread(f.env, replacement, 'new-thread');
    assert.equal((await commit(f, old, 'down')).committed, false);
    assert.equal(await execution.reserveTransitionNotification(f.env, old), false);
    await execution.saveAlertThread(f.env, old, 'stale-thread');
    const current = await execution.readMonitorState(f.env, 1);
    assert.equal(current.last_check_slot, replacement.slotMs);
    assert.equal(current.current_status, 'up');
    assert.equal(current.slack_alert_ts, 'new-thread');
    assert.equal(f.sqlite.prepare('SELECT count(*) AS n FROM checks').get().n, 1);
  } finally { f.close(); }
});

test('an expired owner is rejected even if nobody has replaced it', async () => {
  const f = sqliteEnv();
  try {
    const lease = await execution.claimMonitorSlot(f.env, 1, SLOT);
    f.sqlite.exec('UPDATE monitor_execution SET lease_until = 0');
    assert.equal((await commit(f, lease)).committed, false);
    assert.equal(f.sqlite.prepare('SELECT count(*) AS n FROM checks').get().n, 0);
    assert.equal(await execution.readMonitorState(f.env, 1), null);
  } finally { f.close(); }
});

test('state CAS loser writes neither check history nor state', async () => {
  const f = sqliteEnv();
  try {
    const first = await execution.claimMonitorSlot(f.env, 1, SLOT);
    assert.equal((await commit(f, first)).committed, true);
    await execution.releaseMonitorSlot(f.env, first);
    const previous = await execution.readMonitorState(f.env, 1);
    const next = await execution.claimMonitorSlot(f.env, 1, SLOT + 60000);
    f.sqlite.prepare('UPDATE monitor_state SET last_check_slot = ?').run(SLOT + 120000);
    assert.equal((await commit(f, next, 'down', previous)).committed, false);
    assert.equal(f.sqlite.prepare('SELECT count(*) AS n FROM checks').get().n, 1);
    assert.equal((await execution.readMonitorState(f.env, 1)).last_check_slot, SLOT + 120000);
  } finally { f.close(); }
});

test('state write error rolls the check INSERT back in the same transaction', async () => {
  const f = sqliteEnv();
  try {
    const lease = await execution.claimMonitorSlot(f.env, 1, SLOT);
    f.sqlite.exec("CREATE TRIGGER fail_state BEFORE INSERT ON monitor_state BEGIN SELECT RAISE(ABORT, 'synthetic state failure'); END");
    await assert.rejects(() => commit(f, lease), /synthetic state failure/);
    assert.equal(f.sqlite.prepare('SELECT count(*) AS n FROM checks').get().n, 0);
    assert.equal(await execution.readMonitorState(f.env, 1), null);
  } finally { f.close(); }
});

test('lease expiry between the two batch statements never leaves an accepted check without state', async () => {
  const f = sqliteEnv();
  try {
    const lease = await execution.claimMonitorSlot(f.env, 1, SLOT);
    const until = f.sqlite.prepare('SELECT lease_until FROM monitor_execution').get().lease_until;
    let databaseSeconds = (until - 1000) / 1000;
    f.sqlite.function('strftime', { varargs: true }, () => String(databaseSeconds));
    f.hooks.beforeBatchStatement = i => { if (i === 1) databaseSeconds = (until + 1000) / 1000; };
    assert.equal((await commit(f, lease)).committed, true);
    assert.equal(f.sqlite.prepare('SELECT count(*) AS n FROM checks').get().n, 1);
    assert.equal((await execution.readMonitorState(f.env, 1)).last_check_slot, SLOT);
    assert.equal(await execution.reserveTransitionNotification(f.env, lease), false);
  } finally { f.close(); }
});

test('deleting a monitor with a live lease preserves the existing atomic delete API and rejects its late result', async () => {
  const f = sqliteEnv();
  try {
    const lease = await execution.claimMonitorSlot(f.env, 1, SLOT);
    await f.env.DB.batch([
      f.env.DB.prepare('DELETE FROM checks WHERE monitor_id = ?').bind(1),
      f.env.DB.prepare('DELETE FROM monitor_state WHERE monitor_id = ?').bind(1),
      f.env.DB.prepare('DELETE FROM monitors WHERE id = ?').bind(1),
    ]);
    assert.equal(f.sqlite.prepare('SELECT count(*) AS n FROM monitor_execution').get().n, 0);
    assert.equal((await commit(f, lease, 'down')).committed, false);
    assert.equal(await execution.claimMonitorSlot(f.env, 1, SLOT + 60000), null);
    assert.equal(f.sqlite.prepare('SELECT count(*) AS n FROM checks').get().n, 0);
  } finally { f.close(); }
});

test('notification reservation extends a live owner budget but cannot resurrect an expired one', async () => {
  const f = sqliteEnv();
  try {
    const lease = await execution.claimMonitorSlot(f.env, 1, SLOT);
    assert.equal((await commit(f, lease)).committed, true);
    f.sqlite.exec("UPDATE monitor_execution SET lease_until = CAST(strftime('%s','now') AS INTEGER)*1000 + 2000");
    assert.equal(await execution.reserveTransitionNotification(f.env, lease), true);
    assert.ok(f.sqlite.prepare('SELECT lease_until FROM monitor_execution').get().lease_until - Date.now() > 28000);
    f.sqlite.exec('UPDATE monitor_execution SET lease_until = 0');
    assert.equal(await execution.reserveTransitionNotification(f.env, lease), false);
  } finally { f.close(); }
});

test('two failed samples still trigger DOWN, partial recovery stays degraded, and full recovery needs two stable OKs', () => {
  const f = sqliteEnv();
  try {
    let previous = null, i = 0;
    function observe(state, maintenance = false) {
      const transition = deriveTransition(f.monitor, result(state), previous, Date.now() + i, SLOT + 60000 * i++, maintenance);
      previous = transition.next;
      return transition;
    }
    assert.equal(observe('down').kind, null);
    assert.equal(observe('down').kind, 'down');
    previous.slack_alert_ts = 'open-down-thread';
    assert.equal(observe('degraded').kind, 'partial');
    assert.equal(previous.current_status, 'degraded');
    assert.equal(previous.slack_alert_ts, 'open-down-thread');
    assert.equal(observe('up').kind, null);
    assert.equal(previous.current_status, 'degraded');
    assert.equal(observe('degraded').kind, null); // resets the success streak
    assert.equal(observe('up').kind, null);
    const recovered = observe('up');
    assert.equal(recovered.kind, 'up');
    assert.equal(recovered.previousStatus, 'degraded');
    assert.equal(recovered.previousSlackAlertTs, 'open-down-thread');
    assert.equal(previous.current_status, 'up');
    assert.equal(previous.slack_alert_ts, null);
    assert.equal(observe('up').kind, null);
    assert.equal(observe('down').kind, null);
    assert.equal(observe('down').kind, 'down');
  } finally { f.close(); }
});

for (const bad of ['down', 'degraded']) test(`${bad} persists after maintenance: notify once when suppression ends`, () => {
  const f = sqliteEnv();
  try {
    const ts = Date.now();
    const r = result(bad);
    r.maintenance = { from_ms: ts - 1000, to_ms: ts + 1000, reason: 'synthetic' };
    let next = deriveTransition(f.monitor, r, null, ts, SLOT, true).next;
    next.last_notified_at = ts - 5000;
    const suppressed = deriveTransition(f.monitor, r, next, ts + 1, SLOT + 60000, true);
    assert.equal(suppressed.kind, null);
    assert.equal(suppressed.next.last_notified_at, ts - 5000);
    assert.equal(suppressed.next.current_status, bad);
    const ended = deriveTransition(f.monitor, result(bad), suppressed.next, ts + 2000, SLOT + 120000, false);
    assert.equal(ended.kind, bad);
    assert.equal(ended.next.last_notified_at, ts + 2000);
    assert.equal(ended.next.maintenance_from, null);
    assert.equal(deriveTransition(f.monitor, result(bad), ended.next, ts + 3000, SLOT + 180000, false).kind, null);
  } finally { f.close(); }
});

test('slot calculation uses the scheduled timestamp and rejects unsafe values', () => {
  assert.equal(execution.scheduledSlot(1792846883771), 1792846860000);
  for (const value of [NaN, Infinity, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => execution.scheduledSlot(value), /Invalid/);
  }
});

test('daily cleanup does not probe; delayed minute invocation retains its original scheduled slot', async () => {
  const calls = [], pending = [];
  const { default: worker } = loadTs('index', {
    './api': {}, './edge-cache': {}, './incident-page': {}, './rca': {}, './rss-feed': {},
    './status-page': {}, './slack-bot': {},
    './monitor': { cleanupOldChecks: async () => calls.push('cleanup') },
    './monitor-runner': { runChecks: async (_env, scheduledTime) => calls.push(scheduledTime) },
    './notification-outbox': { drainNotificationOutbox: async () => {} },
    './scheduled-runs': {
      beginScheduledRun: async (_env, _cron, scheduledTime, receivedAt) => ({ runId:'synthetic-run',scheduledTime,receivedAt }),
      advanceScheduledRun: async () => {}, finishScheduledRun: async () => {},
    },
    './schema-gate': { ensureSchema: async () => ({ ok: true }), logSchemaProblem() {} },
  });
  const ctx = { waitUntil(p) { pending.push(p); } };
  await worker.scheduled({ cron: '0 3 * * *', scheduledTime: SLOT }, {}, ctx);
  await Promise.all(pending.splice(0));
  assert.deepEqual(calls, ['cleanup']);
  await worker.scheduled({ cron: '* * * * *', scheduledTime: SLOT - 120000 }, {}, ctx);
  await Promise.all(pending.splice(0));
  assert.deepEqual(calls, ['cleanup', SLOT - 120000]);
});

test('a planned future maintenance does not force a duplicate alert before it starts', () => {
  const f = sqliteEnv();
  try {
    const ts = Date.now();
    const r = result('down');
    let next = deriveTransition(f.monitor, r, null, ts, SLOT, false).next;
    next = deriveTransition(f.monitor, r, next, ts + 1, SLOT + 60000, false).next;
    next.maintenance_from = ts + 60000; next.maintenance_to = ts + 120000;
    assert.equal(deriveTransition(f.monitor, r, next, ts + 2, SLOT + 120000, false).kind, null);
  } finally { f.close(); }
});

test('migration retains old history, migrates DB intent, leaves HTTP ceiling opt-in, and seeds ordering', () => {
  const sqlite = new DatabaseSync(':memory:');
  try {
    sqlite.exec(`CREATE TABLE monitors(id INTEGER PRIMARY KEY,latency_threshold_ms INTEGER);
      CREATE TABLE checks(id INTEGER PRIMARY KEY,monitor_id INTEGER,ts INTEGER);
      CREATE TABLE monitor_state(monitor_id INTEGER PRIMARY KEY);
      INSERT INTO monitors VALUES(1,1000),(2,-1),(3,1.5),(4,NULL),(5,1e100);
      INSERT INTO checks VALUES(1,1,123456); INSERT INTO monitor_state VALUES(1);`);
    sqlite.exec(readFileSync(new URL('migrations/0009_monitor_execution.sql', root), 'utf8'));
    const rows = sqlite.prepare('SELECT * FROM monitors ORDER BY id').all();
    assert.equal(rows[0].db_latency_threshold_ms, 1000);
    assert.ok(rows.every(row => row.http_latency_threshold_ms === null));
    assert.ok(rows.slice(1).every(row => row.db_latency_threshold_ms === null));
    assert.equal(sqlite.prepare('SELECT count(*) AS n FROM checks').get().n, 1);
    assert.equal(sqlite.prepare('SELECT last_check_slot FROM monitor_state').get().last_check_slot, 120000);
  } finally { sqlite.close(); }
});

test('schema gate rejects a missing lease migration and self-heals after the table returns', async () => {
  const f = sqliteEnv();
  try {
    const { ensureSchema } = loadTs('schema-gate');
    f.sqlite.exec('ALTER TABLE monitor_execution RENAME TO missing_execution');
    const missing = await ensureSchema(f.env);
    assert.equal(missing.ok, false);
    assert.ok(missing.missing.includes('monitor_execution.lease_token'));
    f.sqlite.exec('ALTER TABLE missing_execution RENAME TO monitor_execution');
    assert.equal((await ensureSchema(f.env)).ok, true);
  } finally { f.close(); }
});

test('full historical schema upgraded through current monitoring migrations matches a fresh canonical install', () => {
  const fresh = new DatabaseSync(':memory:'), upgraded = new DatabaseSync(':memory:');
  try {
    fresh.exec(readFileSync(new URL('schema.sql', root), 'utf8'));
    // Fixture is the canonical schema at d3eccdbd95d83e2311eaa119bfb48c3b9ab337c4.
    // That historical canonical file omitted 0007, which deployed DBs have.
    upgraded.exec(readFileSync(new URL('tests/fixtures/pre-0009.sql', root), 'utf8'));
    upgraded.exec(readFileSync(new URL('migrations/0007_latency_threshold.sql', root), 'utf8'));
    upgraded.exec(readFileSync(new URL('migrations/0009_monitor_execution.sql', root), 'utf8'));
    upgraded.exec(readFileSync(new URL('migrations/0010_monitor_routes.sql', root), 'utf8'));
    for (const file of readdirSync(new URL('migrations/', root)).filter(file => /^\d{4}_.*\.sql$/.test(file) && Number(file.slice(0,4)) > 10).sort()) {
      upgraded.exec(readFileSync(new URL(`migrations/${file}`, root), 'utf8'));
    }
    function shape(db) {
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
      return tables.map(({ name }) => ({
        name,
        columns: db.prepare(`PRAGMA table_info(${name})`).all().map(({ cid, ...column }) => column).sort((a, b) => a.name.localeCompare(b.name)),
        indexes: db.prepare(`PRAGMA index_list(${name})`).all().map(({ seq, ...index }) => index).sort((a, b) => a.name.localeCompare(b.name)),
        foreignKeys: db.prepare(`PRAGMA foreign_key_list(${name})`).all(),
      }));
    }
    assert.deepEqual(shape(upgraded), shape(fresh));
  } finally { fresh.close(); upgraded.close(); }
});

test('configuration revision fences late checks, notification ownership, and thread metadata', async () => {
  const f = sqliteEnv();
  try {
    const lease = await execution.claimMonitorSlot(f.env, 1, SLOT, 1);
    assert.equal((await commit(f, lease)).committed, true);
    f.sqlite.exec('UPDATE monitors SET config_revision = 2');
    assert.equal(await execution.reserveTransitionNotification(f.env, lease), false);
    await execution.saveAlertThread(f.env, lease, 'old-route-thread');
    assert.equal((await execution.readMonitorState(f.env, 1)).slack_alert_ts, null);
    await execution.releaseMonitorSlot(f.env, lease);
    assert.equal(await execution.claimMonitorSlot(f.env, 1, SLOT + 60000, 1), null);
    const next = await execution.claimMonitorSlot(f.env, 1, SLOT + 60000, 2);
    assert.ok(next);
    // A stale monitor snapshot cannot commit under a fresh revision lease.
    assert.equal((await commit(f, next, 'down')).committed, false);
    f.monitor.config_revision = 2;
    assert.equal((await commit(f, next, 'down')).committed, true);
    const row = f.sqlite.prepare('SELECT config_revision,monitor_role,probe_transport FROM checks ORDER BY id DESC LIMIT 1').get();
    assert.equal(row.config_revision, 2);
    assert.equal(row.monitor_role, 'availability');
    assert.equal(row.probe_transport, 'public_fetch');
    assert.equal((await execution.readMonitorState(f.env, 1)).config_revision, 2);
  } finally { f.close(); }
});

test('a changed configuration rejects an in-flight result before its first commit', async () => {
  const f = sqliteEnv();
  try {
    const lease = await execution.claimMonitorSlot(f.env, 1, SLOT, 1);
    f.sqlite.exec('UPDATE monitors SET config_revision = 2');
    assert.equal((await commit(f, lease, 'down')).committed, false);
    assert.equal(f.sqlite.prepare('SELECT count(*) AS n FROM checks').get().n, 0);
    assert.equal(await execution.readMonitorState(f.env, 1), null);
  } finally { f.close(); }
});

test('missing slots and changed routes break streaks without closing an existing incident', () => {
  const f = sqliteEnv();
  try {
    const first = deriveTransition(f.monitor, result('down'), null, Date.now(), SLOT, false).next;
    const gap = deriveTransition(f.monitor, result('down'), first, Date.now(), SLOT + 120000, false);
    assert.equal(gap.kind, null);
    assert.equal(gap.next.consecutive_failures, 1);
    const changed = deriveTransition({ ...f.monitor, config_revision: 2 }, result('down'), first,
      Date.now(), SLOT + 60000, false);
    assert.equal(changed.kind, null);
    assert.equal(changed.next.consecutive_failures, 1);
    const open = { ...first, current_status: 'degraded', consecutive_successes: 1,
      slack_alert_ts: 'open-incident', down_since: null };
    const healthy = deriveTransition({ ...f.monitor, config_revision: 2 }, result('up'), open,
      Date.now(), SLOT + 60000, false);
    assert.equal(healthy.kind, null);
    assert.equal(healthy.next.current_status, 'degraded');
    assert.equal(healthy.next.slack_alert_ts, 'open-incident');
    assert.equal(healthy.next.consecutive_successes, 1);
  } finally { f.close(); }
});
