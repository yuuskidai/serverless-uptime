import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTs, result, sqliteEnv } from './helpers.mjs';

const { monitorFreshness, monitoringReadiness } = loadTs('monitor-readiness');
const execution = loadTs('monitor-execution');
const { deriveTransition } = loadTs('state-transition');
const NOW = Math.floor(Date.now() / 60000) * 60000 + 20000;
const SLOT = NOW - 20000;

test('freshness distinguishes missing data, old scheduled slots, and stale configuration', () => {
  const monitor = { interval_minutes: 1, config_revision: 2 };
  assert.equal(monitorFreshness(monitor, null, NOW), 'missing');
  assert.equal(monitorFreshness(monitor, { ts: NOW, config_revision: 1 }, NOW), 'missing');
  assert.equal(monitorFreshness(monitor, { ts: NOW - 180000, config_revision: 2 }, NOW), 'stale');
  assert.equal(monitorFreshness(monitor, { ts: NOW, scheduled_slot: SLOT - 180000, config_revision: 2 }, NOW), 'stale');
  assert.equal(monitorFreshness(monitor, { ts: NOW, scheduled_slot: SLOT, config_revision: 2 }, NOW), 'fresh');
  assert.equal(monitorFreshness(monitor, { ts: NOW + 60001, config_revision: 2 }, NOW), 'stale');
  assert.equal(monitorFreshness({ interval_minutes: 5 }, { ts: NOW - 200000, scheduled_slot: SLOT - 200000 }, NOW), 'fresh');
});

test('readiness reports monitoring freshness, not target availability, and excludes diagnostic/shadow routes', async () => {
  const f = sqliteEnv();
  try {
    assert.equal((await monitoringReadiness(f.env, NOW)).status, 503);
    f.sqlite.exec("INSERT INTO monitors(id,name,url,created_at,monitor_role) VALUES (2,'Diagnostic','https://example.invalid/healthz',0,'diagnostic'),(3,'Shadow','https://example.invalid/healthz',0,'shadow')");
    const lease = await execution.claimMonitorSlot(f.env, 1, SLOT, 1);
    const probe = result('down');
    const transition = deriveTransition(f.monitor, probe, null, NOW, SLOT, false);
    assert.equal(await execution.commitMonitorResult(f.env, f.monitor, lease, probe, null, transition, NOW, false), true);
    const response = await monitoringReadiness(f.env, NOW);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await response.json(), { status: 'ok', monitoring_data: 'fresh' });
    assert.equal((await monitoringReadiness(f.env, NOW + 180000)).status, 503);
    f.sqlite.exec('UPDATE monitors SET config_revision=2 WHERE id=1');
    assert.equal((await monitoringReadiness(f.env, NOW)).status, 503);
  } finally { f.close(); }
});

test('readiness fails closed without leaking database error details', async () => {
  const response = await monitoringReadiness({ DB: { prepare() { throw new Error('secret internal binding detail'); } } }, NOW);
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { status: 'unknown', monitoring_data: 'unavailable' });
});
