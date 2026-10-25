import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTs, result, sqliteEnv } from './helpers.mjs';

const execution = loadTs('monitor-execution');
const { deriveTransition } = loadTs('state-transition');
const SLOT = Math.floor(Date.now() / 60000) * 60000;

function runner(probe, notifications, executionOverride = execution) {
  return loadTs('monitor-runner', {
    './monitor': { performCheck: probe },
    './monitor-execution': executionOverride,
    './state-notifications': {
      async notifyTransition(_env, _monitor, _result, transition) {
        notifications.push(transition.kind);
        return { slackAlertTs: 'synthetic-thread' };
      },
    },
  }).runChecks;
}

test('duplicate minute delivery does not double-count failure thresholds or dispatch alerts', async () => {
  const f = sqliteEnv(), notifications = [];
  try {
    let probes = 0;
    const run = runner(async () => { probes++; return result('down'); }, notifications);
    await run(f.env, SLOT);
    assert.equal(probes, 1);
    assert.deepEqual(notifications, []);
    await Promise.all(Array.from({ length: 4 }, () => run(f.env, SLOT + 60000)));
    assert.equal(probes, 2);
    assert.deepEqual(notifications, ['down']);
    assert.equal((await execution.readMonitorState(f.env, 1)).consecutive_failures, 2);
    assert.equal((await execution.readMonitorState(f.env, 1)).slack_alert_ts, 'synthetic-thread');
    assert.equal(f.sqlite.prepare('SELECT count(*) AS n FROM checks').get().n, 2);
  } finally { f.close(); }
});

test('slow old recovery cannot overwrite a newer failure and a missing slot breaks its failure streak', async () => {
  const f = sqliteEnv(), notifications = [];
  try {
    await runner(async () => result('down'), notifications)(f.env, SLOT);
    let finish, began;
    const started = new Promise(resolve => { began = resolve; });
    const slow = runner(() => { began(); return new Promise(resolve => { finish = resolve; }); }, notifications)(f.env, SLOT + 60000);
    await started;
    f.sqlite.exec('UPDATE monitor_execution SET lease_until = 0');
    await runner(async () => result('down'), notifications)(f.env, SLOT + 120000);
    finish(result('up'));
    await slow;
    assert.deepEqual(notifications, []);
    assert.equal((await execution.readMonitorState(f.env, 1)).current_status, 'up');
    assert.equal((await execution.readMonitorState(f.env, 1)).consecutive_failures, 1);
    assert.equal((await execution.readMonitorState(f.env, 1)).last_check_slot, SLOT + 120000);
    assert.equal(f.sqlite.prepare('SELECT count(*) AS n FROM checks').get().n, 2);
    await runner(async () => result('down'), notifications)(f.env, SLOT + 180000);
    assert.deepEqual(notifications, ['down']);
  } finally { f.close(); }
});

test('a shadow route records independent state without dispatching public notifications', async () => {
  const f = sqliteEnv(), notifications = [];
  try {
    f.sqlite.exec("UPDATE monitors SET monitor_role='shadow',probe_transport='public_fetch'");
    const run = runner(async () => result('down'), notifications);
    await run(f.env, SLOT);
    await run(f.env, SLOT + 60000);
    assert.deepEqual(notifications, []);
    assert.equal((await execution.readMonitorState(f.env, 1)).current_status, 'down');
    const row = f.sqlite.prepare('SELECT monitor_role,probe_transport FROM checks LIMIT 1').get();
    assert.equal(row.monitor_role, 'shadow');
    assert.equal(row.probe_transport, 'public_fetch');
  } finally { f.close(); }
});

test('a stalled internal diagnostic does not hold public check persistence', { timeout: 2000 }, async () => {
  const f = sqliteEnv(), notifications = [];
  try {
    f.sqlite.exec("INSERT INTO monitors(id,name,url,created_at,monitor_role) VALUES (2,'Internal','https://example.invalid/healthz',0,'diagnostic')");
    let finishDiagnostic, publicCommitted;
    const committed = new Promise(resolve => { publicCommitted = resolve; });
    const actualBatch = f.env.DB.batch;
    f.env.DB.batch = async statements => {
      const records = await actualBatch(statements);
      if (statements[0].args[0] === 1) publicCommitted();
      return records;
    };
    const pending = runner(async (_env, monitor) => monitor.id === 2
      ? new Promise(resolve => { finishDiagnostic = resolve; }) : result('up'), notifications)(f.env, SLOT);
    await committed;
    assert.equal(f.sqlite.prepare('SELECT count(*) AS n FROM checks WHERE monitor_id=1').get().n, 1);
    assert.equal(f.sqlite.prepare('SELECT count(*) AS n FROM checks WHERE monitor_id=2').get().n, 0);
    finishDiagnostic(result('down'));
    await pending;
  } finally { f.close(); }
});

test('a diagnostic execution error does not reject or cancel the availability run', async () => {
  const f = sqliteEnv(), notifications = [];
  try {
    f.sqlite.exec("INSERT INTO monitors(id,name,url,created_at,monitor_role) VALUES (2,'Internal','https://example.invalid/healthz',0,'diagnostic')");
    await runner(async (_env, monitor) => {
      if (monitor.id === 2) throw new Error('diagnostic unavailable');
      return result('up');
    }, notifications)(f.env, SLOT);
    assert.equal(f.sqlite.prepare('SELECT count(*) AS n FROM checks WHERE monitor_id=1').get().n, 1);
    assert.equal(f.sqlite.prepare('SELECT lease_until FROM monitor_execution WHERE monitor_id=2').get().lease_until, 0);
  } finally { f.close(); }
});

test('latest-owner fence immediately before notification rejects a replaced committed transition', async () => {
  const f = sqliteEnv(), notifications = [];
  try {
    await runner(async () => result('down'), notifications)(f.env, SLOT);
    const wrappedExecution = { ...execution,
      async reserveTransitionNotification(env, stale) {
        f.sqlite.exec('UPDATE monitor_execution SET lease_until = 0');
        const current = await execution.claimMonitorSlot(env, 1, stale.slotMs + 60000);
        const previous = await execution.readMonitorState(env, 1);
        const r = result('up');
        const next = deriveTransition(f.monitor, r, previous, Date.now(), current.slotMs, false);
        assert.equal(await execution.commitMonitorResult(env, f.monitor, current, r, previous, next, Date.now(), false), true);
        return execution.reserveTransitionNotification(env, stale);
      },
    };
    await runner(async () => result('down'), notifications, wrappedExecution)(f.env, SLOT + 60000);
    assert.deepEqual(notifications, []);
    assert.equal((await execution.readMonitorState(f.env, 1)).last_check_slot, SLOT + 120000);
  } finally { f.close(); }
});

test('unknown commit response is not retried and cannot emit a duplicate notification', async () => {
  const f = sqliteEnv(), notifications = [];
  try {
    const actualBatch = f.env.DB.batch;
    let probes = 0;
    f.env.DB.batch = async statements => {
      await actualBatch(statements);
      throw new Error('synthetic response loss after commit');
    };
    const run = runner(async () => { probes++; return result('down'); }, notifications);
    await assert.rejects(() => run(f.env, SLOT), /response loss/);
    f.env.DB.batch = actualBatch;
    await run(f.env, SLOT);
    assert.equal(probes, 1);
    assert.deepEqual(notifications, []);
    assert.equal(f.sqlite.prepare('SELECT count(*) AS n FROM checks').get().n, 1);
    await run(f.env, SLOT + 60000);
    assert.deepEqual(notifications, ['down']);
  } finally { f.close(); }
});
