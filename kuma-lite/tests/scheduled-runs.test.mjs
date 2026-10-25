import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTs, sqliteEnv } from './helpers.mjs';

const audit = loadTs('scheduled-runs');

test('scheduled audit retains raw timing and finishes an ordered lifecycle without inventing target checks', async () => {
  const f = sqliteEnv();
  try {
    const scheduled = 1792913452009;
    const run = await audit.beginScheduledRun(f.env, '* * * * *', scheduled, scheduled + 45087);
    await audit.advanceScheduledRun(f.env, run, 'offset', { schema_ms: 48 });
    await audit.advanceScheduledRun(f.env, run, 'checks', { schema_ms: 48, offset_ms: 5000 });
    await audit.finishScheduledRun(f.env, run, 'completed', null, { schema_ms: 48, offset_ms: 5000 });
    const row = f.sqlite.prepare('SELECT * FROM monitor_runs').get();
    assert.equal(row.run_id, run.runId);
    assert.equal(row.scheduled_time, scheduled);
    assert.equal(row.scheduled_slot, Math.floor(scheduled / 60000) * 60000);
    assert.equal(row.received_at, scheduled + 45087);
    assert.equal(row.stage, 'completed');
    assert.ok(row.finished_at > 0);
    assert.equal(JSON.parse(row.timings_json).offset_ms, 5000);
    assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM checks').get().n, 0);
    await audit.advanceScheduledRun(f.env, run, 'offset', {});
    await run.audit;
    assert.equal(f.sqlite.prepare('SELECT stage FROM monitor_runs').get().stage, 'completed');
  } finally { f.close(); }
});

test('a slow audit acknowledgement never gates receipt or probe-stage recording, and writes remain ordered', async () => {
  const calls = [];
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const env = { DB: { prepare(sql) { return {
    bind(...args) { this.args = args; return this; },
    run() {
      calls.push(sql.startsWith('INSERT') ? 'received' : this.args[0]);
      return calls.length === 1 ? pending : Promise.resolve({ success: true });
    },
  }; } } };
  const run = await Promise.race([
    audit.beginScheduledRun(env, '* * * * *', 60000, 62000),
    new Promise((_, reject) => setTimeout(() => reject(Error('audit blocked probe entry')), 100)),
  ]);
  await audit.advanceScheduledRun(env, run, 'offset', { schema_ms: 1 });
  await audit.advanceScheduledRun(env, run, 'checks', { offset_ms: 5000 });
  assert.deepEqual(calls, ['received']);
  const finishing = audit.finishScheduledRun(env, run, 'failed', 'checks', {});
  release({ success: true });
  await finishing;
  assert.deepEqual(calls, ['received', 'offset', 'checks', 'failed']);
});

test('an audit storage failure does not retry or prevent later phase attempts', async () => {
  let writes = 0;
  const env = { DB: { prepare() { return {
    bind() { return this; },
    async run() { writes++; throw Error('synthetic unavailable storage'); },
  }; } } };
  const run = await audit.beginScheduledRun(env, '* * * * *', 60000, 62000);
  await audit.advanceScheduledRun(env, run, 'checks', {});
  await audit.finishScheduledRun(env, run, 'failed', 'schema', {});
  assert.equal(writes, 3);
});
