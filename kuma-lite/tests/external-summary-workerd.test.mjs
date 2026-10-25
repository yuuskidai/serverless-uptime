import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const wranglerRequire = createRequire(require.resolve('wrangler/package.json'));
const { Miniflare, convertV4MiniflareOptions } = wranglerRequire('miniflare');
const { buildSync } = wranglerRequire('esbuild');
const config = JSON.parse(readFileSync(new URL('../external-targets.json', import.meta.url), 'utf8'));
const origin = 'https://helth-witness.opus-system.workers.dev';
const bundle = buildSync({ stdin: {
  contents: `import { getExternalSummaries } from './src/external-observations.ts';
    export default { async fetch(request, env) {
      return Response.json(Object.fromEntries(await getExternalSummaries(env, Number(env.FIXTURE_NOW))));
    } };`,
  resolveDir: fileURLToPath(new URL('../', import.meta.url)), sourcefile: 'external-summary-fixture.js',
}, bundle: true, platform: 'browser', format: 'esm', write: false }).outputFiles[0].text;

test('real workerd uses bounded HTTPS manual/no-store fetch for Cloudflare summaries and rejects a redirect', async t => {
  const now = Date.now(); const calls = []; let mode = 'ok';
  const payload = { version: 1, source: 'cloudflare_alarm', enabled: true, observed_at: now - 2000, finished_at: now - 1000,
    readiness: { status: 'fresh' }, results: config.targets.map(target => ({ monitor_id: target.monitor_id,
      url: target.url, db_threshold_ms: target.db_threshold_ms, observed_at: now - 2000, finished_at: now - 1000,
      total_ms: 1000, status: 'ok', http_status: 200, database_ms: 100, failure: null })) };
  const mf = new Miniflare(convertV4MiniflareOptions({ workers: [{
    name: 'summary', script: bundle, modules: true, compatibilityDate: '2025-01-01',
    d1Databases: { DB: 'synthetic-summary-db' },
    bindings: { CLOUDFLARE_WITNESS_URL: origin, FIXTURE_NOW: String(now) },
    outboundService: async request => {
      calls.push({ url: request.url, method: request.method, cacheControl: request.headers.get('Cache-Control') });
      if (mode === 'redirect') return new Response(null, { status: 302, headers: { Location: 'https://private.invalid/' } });
      if (mode === 'oversized') return new Response(' '.repeat(8193), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
      return Response.json(payload, { headers: { 'Cache-Control': 'no-store' } });
    },
  }] }));
  t.after(() => mf.dispose());
  const db = await mf.getD1Database('DB', 'summary');
  const schema = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8');
  await db.batch(schema.replace(/^\s*--.*$/gm, '').split(';').map(sql => sql.trim()).filter(Boolean).map(sql => db.prepare(sql)));
  for (const target of config.targets) await db.prepare(
    'INSERT INTO monitors(id,name,url,db_latency_threshold_ms,created_at) VALUES(?,?,?,?,0)',
  ).bind(target.monitor_id, target.name, target.url, target.db_threshold_ms).run();
  const worker = await mf.getWorker('summary');
  let result = await (await worker.fetch('https://summary.invalid/')).json();
  assert.equal(result[5].status, 'ok'); assert.equal(result[6].status, 'ok');
  assert.equal(result[5].source, 'cloudflare_alarm'); assert.equal(result[5].runUrl, null);
  assert.equal(result[5].statusUrl, origin + '/status');
  mode = 'redirect'; result = await (await worker.fetch('https://summary.invalid/')).json();
  assert.equal(result[5].status, 'unknown');
  mode = 'oversized'; result = await (await worker.fetch('https://summary.invalid/')).json();
  assert.equal(result[5].status, 'unknown');
  assert.deepEqual(calls, Array.from({ length: 3 }, () => ({ url: origin + '/latest', method: 'GET', cacheControl: 'no-store' })));
  assert.equal((await db.prepare('SELECT count(*) AS n FROM checks').first()).n, 0);
  assert.equal((await db.prepare('SELECT count(*) AS n FROM external_probe_runs').first()).n, 0);
});
