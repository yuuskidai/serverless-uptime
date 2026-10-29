import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(new URL('../../kuma-lite/package.json', import.meta.url));
const wranglerRequire = createRequire(require.resolve('wrangler/package.json'));
const { Miniflare, convertV4MiniflareOptions } = wranglerRequire('miniflare');
const { buildSync } = wranglerRequire('esbuild');
const singleton = 'fixed-public-health-v1';
const secret = 'a'.repeat(64); // Synthetic local test credential.
const interval = 60_000;
const bundle = buildSync({ stdin: {
  contents: `import handler from './src/index.ts';
    import { ProbeScheduler } from './src/scheduler.ts';
    export default handler;
    const acceptedAudits = [];
    // Keep ownership-bearing fixture events inside the Worker; never send them to test stdout.
    console.info = (...args) => {
      if (args[0]?.event === 'witness_slot_result') acceptedAudits.push(args[0]);
    };
    // Test-only RPC surface: never part of the deployed entry point or its bundle.
    export class TestScheduler extends ProbeScheduler {
      async testAudits() { return acceptedAudits; }
      async testClearAudits() { acceptedAudits.length = 0; }
      async testState() {
        return { control: await this.ctx.storage.get('control'),
          history: await this.ctx.storage.get('history'), alarm: await this.ctx.storage.getAlarm() };
      }
      async testSeed(control, history = []) {
        await this.ctx.storage.transaction(async tx => {
          await tx.deleteAlarm(); await tx.put('control', control); await tx.put('history', history);
        });
      }
      async testPrepare(slot, automatic = false) {
        const previous = await this.ctx.storage.get('control');
        await this.ctx.storage.transaction(async tx => {
          await tx.put('control', { enabled: true, generation: (previous?.generation ?? 0) + 1,
            next_slot: slot, last_claimed_slot: -1, active: null });
          await tx.put('history', []);
          await tx.setAlarm(Date.now() + (automatic ? 10 : 60000));
        });
      }
      async testInvokeAlarm() { await this.alarm({isRetry:true,retryCount:1,scheduledTime:Date.now()}); }
    }`, resolveDir: fileURLToPath(new URL('../', import.meta.url)), sourcefile: 'local-witness-fixture.js',
}, bundle: true, format: 'esm', platform: 'browser', external: ['cloudflare:workers'], write: false }).outputFiles[0].text;

async function poll(check, description) {
  const deadline = Date.now() + 5000;
  do {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  } while (Date.now() < deadline);
  assert.fail(description);
}
const slotNow = () => Math.floor(Date.now() / interval) * interval;
const emptyControl = () => ({ enabled: false, generation: 0, next_slot: null, last_claimed_slot: -1, active: null });
const healthy = (request, databaseMs = 100, extra = {}) => Response.json({
  status: 'ok', version: 'local-build', components: [{ name: 'Database', status: 'ok', latency_ms: databaseMs }], ...extra,
}, { headers: { 'Cache-Control': 'no-store', 'X-Monitor-Request-ID': request.headers.get('X-Monitor-Request-ID') ?? '' } });

test('SQLite Durable Object witness remains independent, bounded and fenced', async t => {
  let outbound;
  const requests = [];
  const options = { workers: [{
    name: 'witness-test', script: bundle, modules: true, compatibilityDate: '2025-01-01',
    durableObjects: { SCHEDULER: { className: 'TestScheduler', useSQLite: true } },
    bindings: { ADMIN_SECRET: secret, VERSION_METADATA: { id: 'local-version', tag: 'test', timestamp: '2026-10-25T00:00:00.000Z' } },
    outboundService: async request => {
      requests.push({ url: request.url, method: request.method, headers: Object.fromEntries(request.headers) });
      return outbound ? outbound(request) : healthy(request);
    },
  }] };
  const mf = new Miniflare(convertV4MiniflareOptions(options));
  t.after(() => mf.dispose());
  let worker = await mf.getWorker('witness-test');
  let ns = await mf.getDurableObjectNamespace('SCHEDULER', 'witness-test');
  async function reload() {
    options.workers[0].bindings.TEST_RESTART = `${Date.now()}`;
    await mf.setOptions(convertV4MiniflareOptions(options));
    worker = await mf.getWorker('witness-test');
    ns = await mf.getDurableObjectNamespace('SCHEDULER', 'witness-test');
  }
  const stub = () => ns.get(ns.idFromName(singleton));
  const call = (path, options) => worker.fetch(`https://witness.invalid${path}`, options);
  const admin = path => call(`/admin/${path}`, { method: 'POST', headers: { Authorization: `Bearer ${secret}` } });
  const status = async () => (await call('/status')).json();
  async function reset() {
    outbound = undefined; requests.length = 0;
    await stub().testSeed(emptyControl()); await stub().testClearAudits();
  }

  await t.test('public reads and recreated constructors cannot start an uninitialised or stopped scheduler', async () => {
    await reset();
    assert.equal((await (await call('/healthz')).json()).scope, 'worker_liveness');
    assert.equal((await stub().testState()).control.enabled, false);
    const initial = await status();
    assert.equal(initial.status, 'unknown'); assert.equal(initial.fresh, false);
    assert.deepEqual(initial.history, []); assert.equal(initial.next_alarm, null);
    assert.equal((await stub().testState()).alarm, null); assert.equal(requests.length, 0);
    await reload();
    assert.equal((await status()).status, 'unknown');
    assert.equal((await stub().testState()).alarm, null);
  });

  await t.test('only exact authenticated bodyless controls can change the fixed singleton', async () => {
    await reset();
    for (const [path, options, code] of [
      ['/admin/start', { method: 'POST' }, 401],
      ['/admin/start', { method: 'POST', headers: { Authorization: 'Bearer wrong' } }, 401],
      ['/admin/start', { method: 'GET', headers: { Authorization: `Bearer ${secret}` } }, 404],
      ['/admin/start?url=https://attacker.invalid', { method: 'POST', headers: { Authorization: `Bearer ${secret}` } }, 404],
      ['/admin/start', { method: 'POST', headers: { Authorization: `Bearer ${secret}` }, body: '{}' }, 400],
      ['/status?object=attacker', {}, 404],
      ['/admin/object/attacker', { method: 'POST', headers: { Authorization: `Bearer ${secret}` } }, 404],
    ]) assert.equal((await call(path, options)).status, code, path);
    assert.equal((await stub().testState()).alarm, null);
    const start = await admin('start'); assert.equal(start.status, 200);
    const started = await start.json(); assert.equal(started.enabled, true);
    assert.ok(started.next_alarm > Date.now());
    assert.deepEqual(await (await admin('start')).json(), started);
    assert.equal((await call('/admin/start', { method: 'POST', headers: { Authorization: `Bearer ${secret}`, 'Content-Length': '0' } })).status, 200);
    assert.equal((await status()).status, 'unknown');
    assert.equal((await admin('stop')).status, 200);
    assert.equal((await stub().testState()).alarm, null);
    assert.equal(requests.length, 0);
    assert.deepEqual(await stub().testAudits(), []); // Administrative HTTP never logs accepted results.
  });

  await t.test('real runtime alarm schedules its successor before public HTTPS probes and deduplicates retry', async () => {
    await reset();
    const slot = slotNow();
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    outbound = async request => { await gate; return healthy(request); };
    await stub().testPrepare(slot, true);
    await poll(() => requests.length === 2, 'real DO alarm should launch the two fixed probes');
    const processing = await stub().testState();
    assert.equal(processing.history.length, 1); assert.equal(processing.history[0].phase, 'checking');
    assert.ok(processing.alarm > Date.now()); assert.equal(processing.alarm, processing.control.next_slot);
    await Promise.all([stub().testInvokeAlarm(), stub().testInvokeAlarm()]);
    assert.equal(requests.length, 2);
    assert.deepEqual(await stub().testAudits(), []); // No result audit before storage acceptance.
    release();
    await poll(async () => (await status()).status === 'ok', 'alarm should persist the actual responses');
    const view = await status();
    assert.equal(view.latest.slot, slot); assert.equal(view.latest.phase, 'completed');
    assert.equal(view.targets[0].database_ms, 100);
    assert.ok(view.targets.every(target => target.request_id_matched && /^[0-9a-f-]{36}$/.test(target.request_id)));
    assert.deepEqual(requests.map(row => row.url).sort(), [
      'https://core-os.opus-system.jp/healthz', 'https://partner-portal.opus-system.jp/healthz',
    ]);
    assert.ok(requests.every(row => row.method === 'GET' && !row.headers.authorization));
    assert.equal(JSON.stringify(view).includes(secret), false);
    await poll(async () => (await stub().testAudits()).length === 1, 'accepted result should produce one audit');
    const audits = await stub().testAudits();
    assert.equal(audits[0].event, 'witness_slot_result');
    assert.equal(audits[0].attempt_id, view.latest.attempt_id);
    assert.equal(audits[0].slot, slot); assert.equal(audits[0].targets.length, 2);
    await stub().testInvokeAlarm();
    assert.equal((await stub().testAudits()).length, 1); // Duplicate delivery is not an accepted observation.
    const compactResponse = await call('/latest');
    const compactText = await compactResponse.text(); assert.ok(Buffer.byteLength(compactText) < 8192);
    const compact = JSON.parse(compactText);
    assert.equal(compact.source, 'cloudflare_alarm'); assert.equal(compact.readiness.status, 'fresh');
    assert.deepEqual(compact.results.map(result => result.monitor_id), [5, 6]);
    assert.equal(compact.observed_at, view.latest.probe_started_at);
    assert.equal(compact.finished_at, view.latest.probe_finished_at);
    await admin('stop');
    await admin('start');
    const restarted = await status();
    assert.equal(restarted.status, 'unknown'); assert.equal(restarted.fresh, false);
    assert.equal((await (await call('/latest')).json()).readiness.status, 'unknown');
    await admin('stop');
  });

  await t.test('stop/start generation fences old network completions and does not restore their alarm', async () => {
    await reset();
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    outbound = async request => { await gate; return healthy(request); };
    await stub().testPrepare(slotNow());
    const running = stub().testInvokeAlarm();
    await poll(() => requests.length === 2, 'old generation should begin both probes');
    const old = await stub().testState();
    await admin('stop');
    assert.equal((await stub().testState()).alarm, null);
    const next = await (await admin('start')).json();
    release(); await running;
    const after = await stub().testState();
    assert.ok(next.generation > old.control.generation);
    assert.equal(after.control.generation, next.generation);
    assert.equal(after.alarm, next.next_alarm);
    assert.equal(after.history[0].phase, 'cancelled');
    assert.deepEqual(after.history[0].targets, []);
    assert.equal((await status()).status, 'unknown');
    assert.deepEqual(await stub().testAudits(), []); // The stopped generation's completion was rejected.
    await admin('stop');
  });

  await t.test('late delivery preserves scheduled slot/lateness, skips catch-up and expires old busy owner', async () => {
    await reset();
    const now = Date.now(), due = slotNow() - 20 * interval;
    const old = { slot: due - interval, generation: 2, token: 'old-owner', lease_until: now - 1 };
    const history = [{ slot: old.slot, generation: 2, attempt_id: old.token, alarm_received_at: old.slot,
      alarm_lateness_ms: 0, alarm_retry_count: 0, phase: 'checking', completed_at: null,
      version: { id: null, tag: null, timestamp: null }, targets: [] }];
    await stub().testSeed({ enabled: true, generation: 2, next_slot: due, last_claimed_slot: old.slot, active: old }, history);
    await stub().testInvokeAlarm();
    const state = await stub().testState();
    assert.equal(state.history[0].phase, 'abandoned');
    assert.equal(state.history[1].slot, due);
    assert.ok(state.history[1].alarm_lateness_ms >= 20 * interval);
    assert.equal(state.history[1].alarm_retry_count, 1);
    assert.ok(state.alarm > now); assert.ok(state.alarm <= Date.now() + interval);
    assert.equal(requests.length, 2); assert.equal((await status()).status, 'ok');
    await admin('stop');
  });

  await t.test('live busy owner produces an explicit skipped slot without another probe', async () => {
    await reset();
    const due = slotNow(), active = { slot: due - interval, generation: 3, token: 'live-owner', lease_until: Date.now() + 30_000 };
    await stub().testSeed({ enabled: true, generation: 3, next_slot: due, last_claimed_slot: active.slot, active });
    await stub().testInvokeAlarm();
    const state = await stub().testState();
    assert.equal(state.history[0].phase, 'skipped_busy');
    assert.equal(state.control.active.token, 'live-owner'); assert.equal(requests.length, 0);
    assert.ok(state.alarm > Date.now()); assert.equal((await status()).status, 'unknown');
    await admin('stop');
  });

  await t.test('same-generation expired owner cannot overwrite a newer completed probe', async () => {
    await reset();
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    let count = 0;
    outbound = async request => { const sequence = ++count; if (sequence <= 2) await gate; return healthy(request, sequence <= 2 ? 1500 : 100); };
    await stub().testPrepare(slotNow() - interval);
    const oldRun = stub().testInvokeAlarm();
    await poll(() => requests.length === 2, 'first owner should start network requests');
    const old = await stub().testState();
    await stub().testSeed({ ...old.control, next_slot: slotNow(),
      active: { ...old.control.active, lease_until: Date.now() - 1 } }, old.history);
    await stub().testInvokeAlarm();
    const newer = await stub().testState();
    assert.equal(newer.history.at(-1).phase, 'completed');
    const newToken = newer.history.at(-1).attempt_id;
    assert.equal((await stub().testAudits()).length, 1);
    release(); await oldRun;
    const final = await stub().testState();
    assert.equal(final.history.at(-1).attempt_id, newToken);
    assert.equal(final.history[0].phase, 'abandoned');
    assert.deepEqual(final.history[0].targets, []);
    assert.equal(final.control.active, null); assert.equal((await status()).status, 'ok');
    const audits = await stub().testAudits();
    assert.equal(audits.length, 1); assert.equal(audits[0].attempt_id, newToken);
    await admin('stop');
  });

  await t.test('strict shared health semantics keep DB threshold, redirects, cached data and body bound honest', async () => {
    await reset();
    for (const [respond, expected] of [
      [request => healthy(request, 1000), 'degraded'],
      [() => new Response(null, { status: 302, headers: { Location: 'https://attacker.invalid/' } }), 'down'],
      [() => Response.json({ status: 'ok', components: [{ name: 'Database', status: 'ok' }] }), 'down'],
      [request => healthy(request, 100, { padding: 'x'.repeat(9000) }), 'down'],
      [request => healthy(request, 100, { status: 'down', reason: secret }), 'down'],
    ]) {
      outbound = respond;
      await stub().testPrepare(slotNow()); await stub().testInvokeAlarm();
      const view = await status();
      assert.equal(view.status, expected);
      assert.equal(JSON.stringify(view).includes(secret), false);
    }
    assert.equal(requests.length, 10); // A redirect must never launch a third-party fetch.
    const audits = await stub().testAudits(); assert.equal(audits.length, 5);
    assert.equal(JSON.stringify(audits).includes(secret), false);
    const allowedTop = new Set(['event', 'slot', 'generation', 'attempt_id', 'alarm_received_at',
      'alarm_lateness_ms', 'alarm_retry_count', 'phase', 'completed_at', 'probe_started_at', 'probe_finished_at', 'version', 'targets']);
    const allowedTarget = new Set(['target', 'status', 'observed_at', 'finished_at', 'http_status',
      'total_ms', 'database_ms', 'failure', 'request_id', 'response_request_id', 'request_id_matched',
      'headers_ms', 'body_ms', 'timeout_callback_elapsed_ms', 'deadline_overrun_ms', 'healthz_version']);
    assert.ok(audits.every(audit => Object.keys(audit).every(key => allowedTop.has(key))));
    assert.ok(audits.every(audit => audit.targets.every(target => Object.keys(target).every(key => allowedTarget.has(key)))));
    await admin('stop');
  });

  await t.test('a stalled response body reaches the fixed ten-second deadline without holding the next alarm', async () => {
    await reset();
    outbound = () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode('{"status":"ok",')); },
    }), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
    await stub().testPrepare(slotNow());
    const started = Date.now();
    await stub().testInvokeAlarm();
    const elapsed = Date.now() - started;
    assert.ok(elapsed >= 9500 && elapsed < 20_000, `elapsed ${elapsed}ms`);
    const view = await status();
    assert.equal(view.status, 'down');
    assert.ok(view.targets.every(target => target.failure === 'timeout'));
    assert.ok(view.targets.every(target => target.total_ms >= 9500));
    const state = await stub().testState(); assert.equal(state.control.active, null);
    assert.ok(state.alarm > Date.now());
    await admin('stop');
  });

  await t.test('history stays at 15 slots and stale/stopped data never reports healthy', async () => {
    await reset();
    const now = Date.now();
    const history = Array.from({ length: 15 }, (_, i) => ({
      slot: slotNow() - (16 - i) * interval, generation: 4, attempt_id: `past-${i}`,
      alarm_received_at: now - (16 - i) * interval, alarm_lateness_ms: 0, alarm_retry_count: 0,
      phase: 'completed', completed_at: now - (16 - i) * interval,
      version: { id: null, tag: null, timestamp: null },
      targets: [{ target: 'portal', status: 'ok' }, { target: 'core', status: 'ok' }],
    }));
    const control = { enabled: true, generation: 4, next_slot: slotNow(), last_claimed_slot: history.at(-1).slot, active: null };
    await stub().testSeed(control, history);
    await stub().testInvokeAlarm();
    const bounded = await stub().testState(); assert.equal(bounded.history.length, 15);
    assert.equal(bounded.history[0].attempt_id, 'past-1'); assert.equal((await status()).status, 'ok');
    const stale = bounded.history.at(-1);
    stale.probe_started_at = now - 150_001; stale.probe_finished_at = now - 150_001;
    // A late durable write must never turn an old observation into a fresh one.
    stale.completed_at = Date.now();
    await stub().testSeed({ ...bounded.control, next_slot: slotNow() + interval }, [stale]);
    const view = await status(); assert.equal(view.status, 'unknown'); assert.equal(view.fresh, false);
    assert.ok(view.targets.every(target => target.status === 'unknown'));
    await admin('stop'); assert.equal((await status()).status, 'unknown');
    await reload();
    await status(); assert.equal((await stub().testState()).alarm, null);
  });
});
