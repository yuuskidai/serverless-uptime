import test, { afterEach, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { loadTs } from './helpers.mjs';
const { performCheck } = loadTs('monitor');

const base = {
  id: 1, name: 'Synthetic readiness', url: 'https://synthetic.invalid/healthz',
  description: null, fallback_url: 'https://synthetic.invalid/', service_binding: 'CORE_OS',
  method: 'GET', expected_status: 200, keyword: null, timeout_ms: 1000, interval_minutes: 1,
  enabled: 1, retry_threshold: 2, latency_threshold_ms: 1000, db_latency_threshold_ms: 1000,
  http_latency_threshold_ms: null, created_at: 0, probe_transport: 'public_fetch',
  response_mode: 'strict_healthz', monitor_role: 'availability',
};
const healthy = () => ({ status: 'ok', components: [{ name: 'Database', status: 'ok', latency_ms: 100 }] });
const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache, no-store, must-revalidate' };
const response = (value = healthy(), options = {}) => new Response(JSON.stringify(value), {
  ...options, headers: { ...headers, ...options.headers },
});
beforeEach(() => mock.method(console, 'info', () => {}));
afterEach(() => mock.restoreAll());

test('explicit public transport ignores an available binding and requests fresh readiness without redirects', async () => {
  let publicCalls = 0, bindingCalls = 0;
  mock.method(globalThis, 'fetch', async (url, init) => {
    publicCalls++;
    assert.equal(url, base.url);
    assert.equal(init.redirect, 'manual');
    assert.equal(init.cache, 'no-store');
    assert.equal(init.cf, undefined);
    assert.match(init.headers['X-Monitor-Request-ID'], /^[a-f0-9-]{36}$/);
    return response();
  });
  const result = await performCheck({ CORE_OS: { fetch: async () => { bindingCalls++; return response(); } } }, base);
  assert.equal(result.status, 'up');
  assert.equal(result.healthz_status, 'ok');
  assert.equal(result.used_fallback, false);
  assert.equal(publicCalls, 1);
  assert.equal(bindingCalls, 0);
  const [trace] = JSON.parse(result.probe_trace_json);
  assert.equal(trace.transport, 'public_fetch');
  // Current application build has no echo. This does not make readiness fail.
  assert.equal(trace.request_id_matched, false);
});

test('explicit unavailable binding is a configuration failure and never changes to public transport', async () => {
  let publicCalls = 0;
  mock.method(globalThis, 'fetch', async () => { publicCalls++; return response(); });
  const result = await performCheck({}, { ...base, probe_transport: 'service_binding' });
  assert.equal(result.status, 'down');
  assert.match(result.error, /configuration error: Service binding is unavailable/);
  assert.equal(publicCalls, 0);
  assert.equal(result.used_fallback, false);
  const [trace] = JSON.parse(result.probe_trace_json);
  assert.equal(trace.transport, 'service_binding');
});

test('explicit service binding does not touch public fetch and keeps a distinct transport trace', async () => {
  mock.method(globalThis, 'fetch', async () => { throw new Error('Public fetch must not run'); });
  const result = await performCheck({ CORE_OS: { fetch: async () => response() } }, { ...base, probe_transport: 'service_binding' });
  assert.equal(result.status, 'up');
  assert.equal(JSON.parse(result.probe_trace_json)[0].transport, 'service_binding');
});

const cases = [
  ['login HTML', () => new Response('<html>Sign in</html>', { headers: { ...headers, 'Content-Type': 'text/html' } })],
  ['empty JSON body', () => new Response('', { headers })],
  ['malformed JSON', () => new Response('{"status":', { headers })],
  ['missing overall status', () => response({ components: healthy().components })],
  ['unknown overall status', () => response({ ...healthy(), status: 'healthy' })],
  ['array overall status', () => response({ ...healthy(), status: ['down'] })],
  ['object overall status', () => response({ ...healthy(), status: { value: 'down' } })],
  ['missing components', () => response({ status: 'ok' })],
  ['empty components', () => response({ status: 'ok', components: [] })],
  ['missing Database', () => response({ status: 'ok', components: [{ name: 'Search', status: 'ok', latency_ms: 10 }] })],
  ['unknown component status', () => response({ status: 'ok', components: [{ name: 'Database', status: 'mystery', latency_ms: 10 }] })],
  ['array component status', () => response({ status: 'ok', components: [{ name: 'Database', status: ['down'], latency_ms: 10 }] })],
  ['object component status', () => response({ status: 'ok', components: [{ name: 'Database', status: { value: 'down' }, latency_ms: 10 }] })],
  ['missing Database latency', () => response({ status: 'ok', components: [{ name: 'Database', status: 'ok' }] })],
  ['negative Database latency', () => response({ status: 'ok', components: [{ name: 'Database', status: 'ok', latency_ms: -1 }] })],
  ['string Database latency', () => response({ status: 'ok', components: [{ name: 'Database', status: 'ok', latency_ms: '1' }] })],
  ['null Database latency', () => response({ status: 'ok', components: [{ name: 'Database', status: 'ok', latency_ms: null }] })],
  ['duplicate Database aliases', () => response({ ...healthy(), components: [...healthy().components, { name: 'D1', status: 'ok', latency_ms: 1 }] })],
  ['HTTP503 with ok JSON', () => response(healthy(), { status: 503 })],
  ['redirect to a login page', () => response(healthy(), { status: 302, headers: { Location: 'https://login.invalid/' } })],
  ['JSON with wrong Content-Type', () => response(healthy(), { headers: { 'Content-Type': 'text/plain' } })],
  ['response without no-store', () => response(healthy(), { headers: { 'Cache-Control': 'max-age=600' } })],
  ['cached HIT', () => response(healthy(), { headers: { 'CF-Cache-Status': 'HIT' } })],
  ['cached STALE', () => response(healthy(), { headers: { 'CF-Cache-Status': 'STALE' } })],
  ['positive cached Age', () => response(healthy(), { headers: { Age: '1' } })],
];
for (const [label, makeResponse] of cases) test(`strict readiness rejects ${label} without trying a fallback`, async () => {
  let calls = 0;
  mock.method(globalThis, 'fetch', async () => { calls++; return calls === 1 ? makeResponse() : response(); });
  const result = await performCheck({}, base);
  assert.equal(result.status, 'down');
  assert.equal(result.healthz_status, 'down');
  assert.equal(result.used_fallback, false);
  assert.equal(calls, 1);
  assert.equal(JSON.parse(result.probe_trace_json).length, 1);
});

for (const change of [{ url: 'http://synthetic.invalid/healthz' }, { url: 'https://credential@synthetic.invalid/healthz' }, { method: 'POST' }]) {
  test(`strict readiness rejects invalid configured request ${Object.keys(change)[0]} before dispatch`, async () => {
    let calls = 0;
    mock.method(globalThis, 'fetch', async () => { calls++; return response(); });
    const result = await performCheck({}, { ...base, ...change });
    assert.equal(result.status, 'down');
    assert.match(result.error, /credential-free HTTPS GET/);
    assert.equal(calls, 0);
  });
}

test('HTTP503 with an explicit valid DB-down response preserves failure evidence', async () => {
  const down = { status: 'down', reason: 'DB unavailable', components: [{ name: 'Database', status: 'down', latency_ms: 2501, reason: 'DB unavailable' }] };
  mock.method(globalThis, 'fetch', async () => response(down, { status: 503 }));
  const result = await performCheck({}, base);
  assert.equal(result.status, 'down');
  assert.equal(result.status_code, 503);
  assert.equal(result.healthz_reason, 'DB unavailable');
  assert.equal(JSON.parse(result.healthz_components)[0].status, 'down');
});

test('strict readiness retains a non-DB failure even when overall status and Database are ok', async () => {
  mock.method(globalThis, 'fetch', async () => response({ ...healthy(), components: [...healthy().components, { name: 'Search', status: 'down', reason: 'Unavailable' }] }));
  const result = await performCheck({}, base);
  assert.equal(result.status, 'down');
  assert.equal(JSON.parse(result.healthz_components)[1].status, 'down');
});

for (const latency of [999, 1000, 1100]) test(`strict readiness uses the effective DB threshold at ${latency}ms and reports its value`, async () => {
  const reason = `応答が 800ms を超過 (${latency}ms)`;
  mock.method(globalThis, 'fetch', async () => response({ status: 'degraded', reason, components: [{ name: 'Database', status: 'degraded', latency_ms: latency, reason }] }));
  const result = await performCheck({}, base);
  assert.equal(result.healthz_status, latency < 1000 ? 'ok' : 'degraded');
  if (latency >= 1000) {
    assert.match(result.healthz_reason, /監視閾値 1000ms/);
    assert.equal(result.healthz_reason.includes('800ms'), false);
    assert.match(JSON.parse(result.healthz_components)[0].reason, /監視閾値 1000ms/);
  }
});

test('strict readiness accepts a fresh cache MISS and zero Age', async () => {
  mock.method(globalThis, 'fetch', async () => response(healthy(), { headers: { 'CF-Cache-Status': 'MISS', Age: '0' } }));
  assert.equal((await performCheck({}, base)).status, 'up');
});
