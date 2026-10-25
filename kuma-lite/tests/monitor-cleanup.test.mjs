import test, { afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { loadTs, sqliteEnv } from './helpers.mjs';

const DAY = 86_400_000;
const HOUR = 3_600_000;
const CUTOVER_DAY = Date.UTC(2026, 9, 1);
const CUTOVER = CUTOVER_DAY + 11 * HOUR;
const { cleanupOldChecks } = loadTs('monitor');
afterEach(() => mock.restoreAll());

function publicCutoverContext(since = CUTOVER) {
  const context = sqliteEnv();
  context.env.RETENTION_DAYS = '7';
  context.sqlite.prepare(`UPDATE monitors SET probe_transport='public_fetch', response_mode='strict_healthz',
    availability_since_ms=? WHERE id=1`).run(since);
  const insert = context.sqlite.prepare(`INSERT INTO checks(monitor_id,status,ts,monitor_role,probe_transport)
    VALUES(1,?,?,?,?)`);
  context.add = (ts, status = 'up', role = 'availability', transport = 'public_fetch') =>
    Number(insert.run(status, ts, role, transport).lastInsertRowid);
  context.ids = () => context.sqlite.prepare('SELECT id FROM checks ORDER BY id').all().map(row => row.id);
  return context;
}

test('cleanup retains only the public cutover-day slice beyond ordinary raw retention', async () => {
  mock.method(Date, 'now', () => CUTOVER_DAY + 10 * DAY + 12 * HOUR);
  const context = publicCutoverContext();
  try {
    const { add, ids } = context;
    add(CUTOVER_DAY - DAY); // old completed day: summarized and pruned
    add(CUTOVER - 1, 'down', 'availability', 'service_binding'); // old path on mixed day
    const publicStart = add(CUTOVER);
    const publicEnd = add(CUTOVER_DAY + DAY - 1, 'down');
    add(CUTOVER + 1, 'up', 'diagnostic', 'service_binding');
    add(CUTOVER + 2, 'up', 'shadow');
    add(CUTOVER + 3, 'up', 'availability', 'service_binding');
    add(CUTOVER_DAY + DAY); // first full public day: summary can represent it
    const recent = add(Date.now() - HOUR);
    await cleanupOldChecks(context.env);
    assert.deepEqual(ids(), [publicStart, publicEnd, recent]);
    // Cleanup still summarizes all completed history before deleting any raw rows.
    assert.equal(context.sqlite.prepare('SELECT COUNT(*) AS n FROM daily_summary').get().n, 3);
    assert.equal(context.sqlite.prepare('SELECT downs FROM daily_summary WHERE monitor_id=1 AND day_ms=?')
      .get(CUTOVER_DAY).downs, 2);
  } finally { context.close(); }
});

test('cutover slice remains for the last visible 30-day bucket and expires on the next UTC day', async () => {
  let now = CUTOVER_DAY + 29 * DAY + 23 * HOUR;
  mock.method(Date, 'now', () => now);
  const context = publicCutoverContext();
  try {
    const first = context.add(CUTOVER);
    const last = context.add(CUTOVER_DAY + DAY - 1);
    await cleanupOldChecks(context.env);
    assert.deepEqual(context.ids(), [first, last]);
    now = CUTOVER_DAY + 30 * DAY;
    await cleanupOldChecks(context.env);
    assert.deepEqual(context.ids(), []);
    assert.equal(context.sqlite.prepare('SELECT COUNT(*) AS n FROM daily_summary').get().n, 1);
  } finally { context.close(); }
});

test('midnight cutover needs no raw exception because the full day is represented by its summary', async () => {
  mock.method(Date, 'now', () => CUTOVER_DAY + 10 * DAY);
  const context = publicCutoverContext(CUTOVER_DAY);
  try {
    context.add(CUTOVER_DAY);
    context.add(CUTOVER_DAY + HOUR, 'down');
    await cleanupOldChecks(context.env);
    assert.deepEqual(context.ids(), []);
    const summary = context.sqlite.prepare('SELECT ups, downs FROM daily_summary WHERE monitor_id=1').get();
    assert.equal(summary.ups, 1);
    assert.equal(summary.downs, 1);
  } finally { context.close(); }
});

const streakCases = [
  { name: 'adjacent failed rows across a missing scheduled observation', rows: [[0, 1], [120000, 1]], expected: 1 },
  { name: 'adjacent scheduled failures across a config revision change', rows: [[0, 1], [60000, 2]], expected: 1 },
  { name: 'neighboring failed scheduled observations in the same revision', rows: [[0, 1], [60000, 1]], expected: 2 },
  { name: 'a healthy observation separating two failures', rows: [[0, 1, 'down'], [60000, 1, 'up'], [120000, 1, 'down']], expected: 1 },
  { name: 'legacy failures separated by a missing minute', rows: [[0, null], [120000, null]], expected: 1 },
  { name: 'neighboring legacy failures within neighboring minute slots', rows: [[5000, null], [65000, null]], expected: 2 },
  { name: 'neighboring scheduled failures at a configured five-minute interval', rows: [[0, 1], [300000, 1]], expected: 2, interval: 5 },
];
for (const { name, rows, expected, interval = 1 } of streakCases) test(`daily down-streak respects ${name}`, async () => {
  mock.method(Date, 'now', () => CUTOVER_DAY + 10 * DAY);
  const context = sqliteEnv();
  context.env.RETENTION_DAYS = '7';
  try {
    context.sqlite.prepare('UPDATE monitors SET interval_minutes=? WHERE id=1').run(interval);
    const insert = context.sqlite.prepare(`INSERT INTO checks(monitor_id,status,ts,scheduled_slot,config_revision,in_maintenance)
      VALUES(1,?,?,?,?,0)`);
    for (const [offset, revision, state = 'down'] of rows) {
      insert.run(state, CUTOVER_DAY + offset, revision === null ? null : CUTOVER_DAY + offset, revision);
    }
    await cleanupOldChecks(context.env);
    const summary = context.sqlite.prepare('SELECT down_streak FROM daily_summary WHERE monitor_id=1 AND day_ms=?').get(CUTOVER_DAY);
    assert.equal(summary.down_streak, expected);
  } finally { context.close(); }
});
