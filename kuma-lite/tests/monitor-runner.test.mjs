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

test('slow old recovery cannot overwrite or notify after a newer DOWN result', async () => {
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
    assert.deepEqual(notifications, ['down']);
    assert.equal((await execution.readMonitorState(f.env, 1)).current_status, 'down');
    assert.equal((await execution.readMonitorState(f.env, 1)).last_check_slot, SLOT + 120000);
    assert.equal(f.sqlite.prepare('SELECT count(*) AS n FROM checks').get().n, 2);
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
