import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

// Exercise the actual Workers fetch implementation. Node fetch mocks do not
// enforce Workers' incompatibility between cache:no-store and cf.cacheTtl.
// All outbound requests terminate in a local Miniflare service; no remote API,
// production D1, Cloudflare credentials or new dependencies are used.
const require = createRequire(import.meta.url);
const wranglerRequire = createRequire(require.resolve('wrangler/package.json'));
const { Miniflare, convertV4MiniflareOptions } = wranglerRequire('miniflare');
const { buildSync } = wranglerRequire('esbuild');
const bundle = buildSync({
  stdin: {
    contents: `import { performCheck } from './src/monitor.ts';
      export default { async fetch(request, env) {
        return Response.json(await performCheck(env, await request.json()));
      } };`,
    resolveDir: fileURLToPath(new URL('../', import.meta.url)),
    sourcefile: 'local-route-probe-fixture.js',
  },
  bundle: true, format: 'esm', platform: 'browser', write: false,
}).outputFiles[0].text;
const healthy = { status: 'ok', version: 'synthetic', components: [{ name: 'Database', status: 'ok', latency_ms: 1 }] };
const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache, no-store, must-revalidate' };
const monitor = {
  id: 1, name: 'Synthetic readiness', url: 'https://synthetic.invalid/healthz',
  description: null, fallback_url: null, service_binding: 'CORE_OS',
  method: 'GET', expected_status: 200, keyword: null, timeout_ms: 1000,
  interval_minutes: 1, enabled: 1, retry_threshold: 2, latency_threshold_ms: 1000,
  db_latency_threshold_ms: 1000, http_latency_threshold_ms: null, created_at: 0,
  probe_transport: 'public_fetch', response_mode: 'strict_healthz', monitor_role: 'shadow',
};

test('real workerd accepts strict no-store public fetch and keeps service binding independent', async t => {
  const outbound = [];
  const mf = new Miniflare(convertV4MiniflareOptions({ workers: [
    {
      name: 'monitor', script: bundle, modules: true, compatibilityDate: '2025-01-01',
      serviceBindings: { CORE_OS: 'health' },
      outboundService: async request => {
        outbound.push({ url: request.url, method: request.method, id: request.headers.get('X-Monitor-Request-ID') });
        return new Response(JSON.stringify({ ...healthy, version: 'public' }), { headers });
      },
    },
    {
      name: 'health', modules: true, compatibilityDate: '2025-01-01',
      script: `export default { async fetch(request) {
        return Response.json(${JSON.stringify({ ...healthy, version: 'binding' })}, {
          headers: { ...${JSON.stringify(headers)}, 'X-Monitor-Request-ID': request.headers.get('X-Monitor-Request-ID') }
        });
      } };`,
    },
  ] }));
  t.after(() => mf.dispose());
  const worker = await mf.getWorker('monitor');
  async function probe(probe_transport) {
    const response = await worker.fetch('http://local-test.invalid/', {
      method: 'POST', body: JSON.stringify({ ...monitor, probe_transport }),
    });
    assert.equal(response.status, 200, await response.clone().text());
    return response.json();
  }

  await t.test('public fetch reaches the outbound service using the Workers runtime', async () => {
    const result = await probe('public_fetch');
    assert.equal(result.status, 'up', result.error);
    assert.equal(result.healthz_status, 'ok');
    assert.equal(result.healthz_version, 'public');
    assert.equal(outbound.length, 1);
    assert.equal(outbound[0].url, monitor.url);
    assert.equal(outbound[0].method, 'GET');
    const [trace] = JSON.parse(result.probe_trace_json);
    assert.equal(trace.transport, 'public_fetch');
    assert.equal(trace.failure_phase, null);
    assert.equal(trace.request_id, outbound[0].id);
    assert.equal(trace.request_id_matched, false);
  });

  await t.test('binding fetch succeeds without contacting the public outbound service', async () => {
    const result = await probe('service_binding');
    assert.equal(result.status, 'up', result.error);
    assert.equal(result.healthz_status, 'ok');
    assert.equal(result.healthz_version, 'binding');
    assert.equal(outbound.length, 1);
    const [trace] = JSON.parse(result.probe_trace_json);
    assert.equal(trace.transport, 'service_binding');
    assert.equal(trace.request_id_matched, true);
  });
});
