import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTs, result, sqliteEnv } from './helpers.mjs';

const diagnostic = loadTs('binding-diagnostic');
const execution = loadTs('monitor-execution');
const FROM = Date.parse('2026-10-29T10:00:00+09:00');
const window = { from: new Date(FROM).toISOString(), until: new Date(FROM + 20 * 60000).toISOString() };
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const flush = async () => { for (let n = 0; n < 60; n++) await Promise.resolve(); };
const completedResult = state => ({ ...result(state), probe_trace_json: JSON.stringify([{ failure_phase: null, headers_ms: 80, body_ms: 2, status_code: state === 'down' ? 503 : 200 }]) });

function clock(now = FROM + 61000) {
  let serial = 0;
  const timers = new Map();
  return { now: () => now, timers,
    setTimeout(callback, ms) { const id = ++serial; timers.set(id, { at: now + ms, callback }); return id; },
    clearTimeout(id) { timers.delete(id); },
    advance(ms, fire = true) { now += ms; if (fire) for (const [id, value] of timers) if (value.at <= now) { timers.delete(id); value.callback(); } },
  };
}

function cohort() {
  return [5, 6, 9, 10].map(id => {
    const main = id < 9, portal = id === 5 || id === 9;
    return { id, name: `Synthetic ${id}`, url: `https://${portal ? 'partner-portal' : 'core-os'}.opus-system.jp/healthz`,
      created_at: 0, description: null, enabled: 1, method: 'GET', expected_status: 200, keyword: null,
      service_binding: portal ? 'PARTNER_PORTAL' : 'CORE_OS', fallback_url: null,
      probe_transport: main ? 'legacy' : 'public_fetch', monitor_role: main ? 'availability' : 'shadow',
      parent_monitor_id: main ? null : id - 4, response_mode: main ? 'legacy_http' : 'strict_healthz',
      config_revision: main ? 1 : 3, interval_minutes: 1, timeout_ms: 10000, retry_threshold: 2,
      db_latency_threshold_ms: 1000, latency_threshold_ms: 1000, http_latency_threshold_ms: null };
  });
}
const bindings = () => ({ PARTNER_PORTAL: { fetch: async () => new Response('unused') }, CORE_OS: { fetch: async () => new Response('unused') } });
function makeLane(cycle = 1, options = {}) {
  const scheduled = FROM + cycle * 60000, time = options.time ?? clock(scheduled + 1000);
  return { time, lane: diagnostic.createBindingDiagnostic(bindings(), cohort(), scheduled, scheduled + 1000, options.window ?? window, time) };
}

test('diagnostic defaults OFF and accepts only an absolute window of at most twenty minutes', () => {
  assert.equal(diagnostic.BINDING_DIAGNOSTIC_FROM, null);
  assert.equal(diagnostic.BINDING_DIAGNOSTIC_UNTIL, null);
  assert.equal(diagnostic.createBindingDiagnostic(bindings(), cohort(), FROM, FROM), undefined);
  for (const bad of [{ from: null, until: window.until }, { from: '2026-10-29T10:00:00', until: window.until },
    { ...window, until: new Date(FROM + 20 * 60000 + 1).toISOString() }, { from: window.until, until: window.from }]) {
    assert.equal(diagnostic.createBindingDiagnostic(bindings(), cohort(), FROM, FROM, bad, clock(FROM)), undefined);
  }
  assert.ok(makeLane().lane);
});

test('four natural slots are parallel, Portal-first, parallel, Core-first', () => {
  assert.deepEqual([0, 1, 2, 3].map(n => makeLane(n).lane.timings(5).diagnostic_mode),
    ['parallel_control', 'portal_first', 'parallel_control', 'core_first']);
});

test('scope guard refuses changed routes, conditions, cohorts or missing live bindings', () => {
  const mutations = [m => m[0].probe_transport = 'service_binding', m => m[0].config_revision = 2,
    m => m[0].service_binding = 'CORE_OS', m => m[0].response_mode = 'strict_healthz',
    m => m[0].timeout_ms = 9000, m => m[0].retry_threshold = 3, m => m[0].interval_minutes = 2,
    m => m[0].db_latency_threshold_ms = 1500, m => m[0].http_latency_threshold_ms = 1000,
    m => m[0].url += '/', m => m[0].monitor_role = 'diagnostic', m => m[0].enabled = 0,
    m => m[2].probe_transport = 'legacy', m => m[2].config_revision = 1,
    m => m.push({ ...m[0], id: 99 }), m => m[1] = { ...m[0] }];
  for (const mutate of mutations) {
    const monitors = cohort(); mutate(monitors);
    assert.equal(diagnostic.createBindingDiagnostic(bindings(), monitors, FROM, FROM, window, clock(FROM)), undefined);
  }
  assert.equal(diagnostic.createBindingDiagnostic({}, cohort(), FROM, FROM, window, clock(FROM)), undefined);
});

test('reserved order is independent of which claim reaches the lane first; public targets never wait', async () => {
  for (const cycle of [1, 3]) {
    const { lane, time } = makeLane(cycle), first = cycle === 1 ? 5 : 6, second = first === 5 ? 6 : 5;
    let ready = false;
    const queued = lane.wait(second).then(() => { ready = true; });
    await lane.wait(9); await lane.wait(10); await flush(); assert.equal(ready, false);
    await lane.wait(first); lane.start(first); time.advance(82); lane.finish(first);
    await queued; lane.start(second); lane.finish(second);
    assert.equal(lane.timings(second).dispatch_wait_ms, 82);
    assert.equal(lane.timings(second).diagnostic_contaminated, false);
    assert.equal(time.timers.size, 0);
  }
});

test('parallel controls are concurrent and run-local lanes cannot block each other', async () => {
  const control = makeLane(0).lane;
  await Promise.all([control.wait(5), control.wait(6)]); control.start(5); control.start(6);
  assert.equal(control.timings(5).diagnostic_contaminated, false);
  const one = makeLane().lane, two = makeLane().lane;
  one.start(5); await two.wait(5); two.start(5); two.finish(5);
  let ready = false; const waiting = one.wait(6).then(() => { ready = true; });
  await flush(); assert.equal(ready, false); one.finish(5); await waiting;
});

test('soft cap resumes the existing probe rather than creating a missing observation', async () => {
  const { lane, time } = makeLane(); lane.start(5);
  const waiting = lane.wait(6); time.advance(25000); await waiting; lane.start(6);
  assert.equal(lane.timings(6).diagnostic_contaminated, true);
  lane.finish(5); lane.finish(5); lane.finish(6);
  assert.equal(time.timers.size, 0);
  assert.equal(lane.timings(6).dispatch_wait_ms, 25000);
});

test('expiry releases a queued target and disables new runs; late timer delivery cannot extend it', async () => {
  const until = FROM + 63000, short = { ...window, until: new Date(until).toISOString() };
  const { lane, time } = makeLane(1, { window: short }); lane.start(5);
  const waiting = lane.wait(6); time.advance(2000); await waiting; lane.start(6);
  assert.equal(lane.timings(6).diagnostic_contaminated, true);
  assert.equal(diagnostic.createBindingDiagnostic(bindings(), cohort(), until, until, short, time), undefined);
  lane.finish(5); lane.finish(6); assert.equal(time.timers.size, 0);
  const late = makeLane(); const blocked = late.lane.wait(6);
  late.time.advance(26000, false); late.lane.finish(5); await blocked;
  assert.equal(late.lane.timings(6).diagnostic_contaminated, true);
  assert.equal(late.time.timers.size, 0);
});

test('late raw schedule bypasses the lane and invalid/future schedules remain unchanged', async () => {
  const time = clock(FROM + 120000), lane = diagnostic.createBindingDiagnostic(bindings(), cohort(), FROM + 60000, FROM + 120000, window, time);
  await lane.wait(6); assert.equal(lane.timings(6).diagnostic_contaminated, true);
  for (const value of [NaN, Infinity, -1, FROM + 1]) assert.equal(diagnostic.createBindingDiagnostic(bindings(), cohort(), value, FROM, window, clock(FROM)), undefined);
});

function runnerFixture({ cycle = 1, probe, overrides = {}, deliver } = {}) {
  const fixture = sqliteEnv(), monitors = cohort(), slot = Math.floor(Date.now() / 60000) * 60000;
  fixture.sqlite.exec('DELETE FROM monitors');
  for (const monitor of monitors) {
    const keys = Object.keys(monitor);
    fixture.sqlite.prepare(`INSERT INTO monitors(${keys.join(',')}) VALUES(${keys.map(() => '?').join(',')})`).run(...keys.map(key => monitor[key]));
  }
  const time = clock(slot + 1000), localWindow = { from: new Date(slot - cycle * 60000).toISOString(), until: new Date(slot + (20 - cycle) * 60000).toISOString() };
  fixture.env = { ...fixture.env, ...bindings() };
  const claims = [], events = [];
  const run = loadTs('monitor-runner', {
    './binding-diagnostic': { bindingResponseCompleted: diagnostic.bindingResponseCompleted, createBindingDiagnostic: (env, due, raw, received) => diagnostic.createBindingDiagnostic(env, due, raw, received, localWindow, time) },
    './monitor': { performCheck: async (env, monitor) => { events.push(monitor.id); return probe ? probe(env, monitor) : completedResult('up'); } },
    './monitor-execution': { ...execution, ...overrides,
      claimMonitorSlotDecision: async (...args) => { claims.push(args[1]); return (overrides.claimMonitorSlotDecision ?? execution.claimMonitorSlotDecision)(...args); } },
    './notification-outbox': { drainNotificationOutbox: deliver ?? (async () => {}) },
  }).runChecks;
  return { ...fixture, slot, time, claims, events, run: () => run(fixture.env, slot, { receivedAt: slot + 1000 }) };
}

test('all claims precede dispatch waits; public probes run once while the second binding queues', async () => {
  const first = deferred(); const f = runnerFixture({ probe: async (_env, monitor) => { if (monitor.id === 5) await first.promise; return completedResult('up'); } });
  const pending = f.run();
  try {
    await flush(); assert.deepEqual(new Set(f.claims), new Set([5, 6, 9, 10]));
    assert.deepEqual(new Set(f.events), new Set([5, 9, 10]));
    assert.equal(f.sqlite.prepare('SELECT count(*) n FROM monitor_execution').get().n, 4);
    f.time.advance(82); first.resolve(); await pending;
    assert.equal(f.events.filter(id => id === 6).length, 1);
    const audit = JSON.parse(f.sqlite.prepare("SELECT timings_json FROM monitor_attempts WHERE monitor_id=6").get().timings_json);
    assert.equal(audit.dispatch_wait_ms, 82); assert.equal(audit.diagnostic_mode, 'portal_first');
    assert.equal(audit.diagnostic_contaminated, false);
    assert.equal(f.sqlite.prepare('SELECT count(*) n FROM checks').get().n, 4);
  } finally { first.resolve(); await pending; f.close(); }
});

test('commit and notification acknowledgements cannot hold the next binding ticket', async () => {
  for (const stage of ['commit', 'notification']) {
    const hold = deferred(); let blocked = false;
    const f = runnerFixture({
      overrides: stage === 'commit' ? { commitMonitorResult: async (...args) => { if (args[1].id === 5) { blocked = true; await hold.promise; } return execution.commitMonitorResult(...args); } } : {},
      deliver: stage === 'notification' ? async (_env, id) => { if (id === 5) { blocked = true; await hold.promise; } } : undefined,
    });
    const pending = f.run();
    try { await flush(); assert.equal(blocked, true); assert.ok(f.events.includes(6)); }
    finally { hold.resolve(); await pending; f.close(); }
  }
});

test('claim denial, claim exception, state failure and probe failure all release the reserved successor', async () => {
  for (const stage of ['denied', 'claim', 'state', 'probe']) {
    const overrides = {};
    if (stage === 'denied' || stage === 'claim') overrides.claimMonitorSlotDecision = async (...args) => {
      if (args[1] === 5) { if (stage === 'claim') throw Error('synthetic claim failure'); return { lease: null, attempt: { attempt_id: 'synthetic', reason: 'superseded_slot' } }; }
      return execution.claimMonitorSlotDecision(...args);
    };
    if (stage === 'state') overrides.readMonitorState = async (env, id) => { if (id === 5) throw Error('synthetic state failure'); return execution.readMonitorState(env, id); };
    const f = runnerFixture({ overrides, probe: async (_env, monitor) => { if (stage === 'probe' && monitor.id === 5) throw Error('synthetic probe failure'); return completedResult('up'); } });
    try {
      if (stage === 'denied') await f.run(); else await assert.rejects(f.run(), /synthetic/);
      assert.equal(f.events.filter(id => id === 6).length, 1);
      assert.equal(f.time.timers.size, 0);
    } finally { f.close(); }
  }
});

test('fallback remains inside the binding ticket and keeps each existing ten-second attempt budget', async () => {
  const primary = deferred(), fallback = deferred(), values = new Map(); let requests = 0;
  const performCheck = loadTs('monitor').performCheck;
  const f = runnerFixture({ probe: async (env, monitor) => {
    const value = monitor.id === 5 ? await performCheck(env, monitor) : completedResult('up'); values.set(monitor.id, value); return value;
  } });
  f.sqlite.prepare("UPDATE monitors SET fallback_url='https://partner-portal.opus-system.jp/' WHERE id=5").run();
  f.env.PARTNER_PORTAL.fetch = () => ++requests === 1 ? primary.promise : fallback.promise;
  const pending = f.run();
  try {
    await flush(); assert.equal(requests, 1); assert.ok(!f.events.includes(6));
    f.time.advance(9000); primary.reject(Error('synthetic primary network error')); await flush();
    assert.equal(requests, 2); assert.ok(!f.events.includes(6));
    fallback.resolve(new Response('synthetic healthy root')); await pending;
    const value = values.get(5), traces = JSON.parse(value.probe_trace_json);
    assert.equal(value.used_fallback, true);
    assert.equal(JSON.parse(f.sqlite.prepare('SELECT timings_json FROM monitor_attempts WHERE monitor_id=5').get().timings_json).diagnostic_contaminated, true); assert.deepEqual(traces.map(trace => trace.timeout_ms), [10000, 10000]);
    assert.deepEqual(traces.map(trace => trace.transport), ['service_binding', 'service_binding']);
    assert.equal(f.events.filter(id => id === 6).length, 1);
  } finally { primary.resolve(new Response('done')); fallback.resolve(new Response('done')); await pending; f.close(); }
});

test('diagnostic metadata is an allowlist, while state thresholds, leases and duplicate protection stay unchanged', async () => {
  const f = runnerFixture({ cycle: 0, probe: async () => completedResult('degraded') });
  try {
    await f.run(); await f.run();
    assert.equal(f.sqlite.prepare('SELECT count(*) n FROM checks').get().n, 4);
    assert.equal(f.sqlite.prepare('SELECT max(consecutive_degraded) n FROM monitor_state').get().n, 1);
    assert.equal(f.sqlite.prepare('SELECT count(*) n FROM notification_outbox').get().n, 0);
    assert.equal(execution.LEASE_MS, 120000);
    const timing = JSON.parse(f.sqlite.prepare('SELECT timings_json FROM monitor_attempts LIMIT 1').get().timings_json);
    assert.equal(timing.diagnostic_mode, 'parallel_control');
    assert.ok(Object.keys(timing).every(key => !/token|body|header|attempt_id/.test(key)));
    const rows = f.sqlite.prepare('SELECT interval_minutes,timeout_ms,retry_threshold,db_latency_threshold_ms,config_revision,probe_transport FROM monitors ORDER BY id').all();
    assert.deepEqual(rows.map(row => [row.interval_minutes, row.timeout_ms, row.retry_threshold, row.db_latency_threshold_ms, row.config_revision, row.probe_transport]),
      [[1, 10000, 2, 1000, 1, 'legacy'], [1, 10000, 2, 1000, 1, 'legacy'], [1, 10000, 2, 1000, 3, 'public_fetch'], [1, 10000, 2, 1000, 3, 'public_fetch']]);
  } finally { f.close(); }
});

test('local mechanism control: sibling CPU can delay readiness, while serial order cannot fix own CPU', async () => {
  // This is an orchestration model, not the app or a claim of production causality.
  // The actual c981 application reproduction is retained separately in incident evidence.
  async function model(cycle, ownCpu = false) {
    const { lane, time } = makeLane(cycle), outcomes = [];
    const run = async (id) => {
      await lane.wait(id); lane.start(id);
      if (id === 5) {
        const start = time.now();
        const io = deferred();
        time.setTimeout(io.resolve, 82);
        if (ownCpu) time.advance(3700, false);
        await io.promise; outcomes.push(time.now() - start >= 2500 ? 503 : 200);
      } else time.advance(3700, false);
      lane.finish(id);
    };
    const pending = Promise.all([run(5), run(6)]);
    await flush(); time.advance(82); await flush(); time.advance(82); await pending;
    return outcomes[0];
  }
  assert.equal(await model(0), 503);
  assert.equal(await model(1), 200);
  assert.equal(await model(3), 200);
  assert.equal(await model(1, true), 503);
});


test('caller cancellation is contaminated, while a fully returned HTTP503 stays eligible', async () => {
  assert.equal(diagnostic.bindingResponseCompleted(completedResult('down').probe_trace_json), true);
  for (const value of ['[]', 'null', 'bad-json', JSON.stringify([{ failure_phase: 'headers', headers_ms: null, body_ms: null, status_code: null }]), JSON.stringify([{ failure_phase: 'body', headers_ms: 20, body_ms: 10000, status_code: 200 }])]) {
    assert.equal(diagnostic.bindingResponseCompleted(value), false);
  }
  const { lane } = makeLane(); lane.start(5); lane.finish(5, false); await lane.wait(6);
  assert.equal(lane.timings(6).diagnostic_contaminated, true);
});
