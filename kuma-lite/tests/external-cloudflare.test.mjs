import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadTs, sqliteEnv } from './helpers.mjs';

const { getExternalSummaries, handleExternalObservation } = loadTs('external-observations');
const config = JSON.parse(readFileSync(new URL('../external-targets.json', import.meta.url), 'utf8'));
const origin = 'https://helth-witness.opus-system.workers.dev';
const now = Date.now();
function fixture(t) {
  const f = sqliteEnv(); t.after(() => f.close());
  for (const target of config.targets) f.sqlite.prepare(
    'INSERT INTO monitors(id,name,url,db_latency_threshold_ms,created_at) VALUES(?,?,?,?,0)',
  ).run(target.monitor_id, target.name, target.url, target.db_threshold_ms);
  f.env.CLOUDFLARE_WITNESS_URL = origin;
  Object.assign(f.env, { EXTERNAL_PROBE_AUDIENCE: config.receiver, EXTERNAL_PROBE_REPOSITORY: config.repository,
    EXTERNAL_PROBE_REPOSITORY_ID: '1229702777', EXTERNAL_PROBE_OWNER_ID: '85591602',
    EXTERNAL_PROBE_WORKFLOW_REF: `${config.repository}/.github/workflows/external-health.yml@refs/heads/master` });
  return f;
}
function payload() {
  return { version: 1, source: 'cloudflare_alarm', enabled: true, observed_at: now - 2000, finished_at: now - 1000,
    age_ms: 1000, readiness: { status: 'fresh' }, witness_version: { id: 'synthetic', tag: null, timestamp: null },
    results: config.targets.map(target => ({ monitor_id: target.monitor_id, url: target.url,
      db_threshold_ms: target.db_threshold_ms, observed_at: now - 2000, finished_at: now - 1000,
      total_ms: 1000, http_status: 200, status: 'ok', database_ms: 100, failure: null })) };
}
const response = value => Response.json(value, { headers: { 'Cache-Control': 'no-store' } });
const call = (f, value = payload(), extra = {}) => getExternalSummaries(f.env, now,
  { fetcher: async () => response(value), ...extra });

test('Cloudflare summary only fetches the fixed latest endpoint and leaves every database table unchanged', async t => {
  const f = fixture(t); const before = JSON.stringify(f.sqlite.prepare('SELECT name FROM sqlite_master WHERE type=\'table\'').all()
    .map(({ name }) => [name, f.sqlite.prepare(`SELECT count(*) AS n FROM "${name}"`).get().n]));
  const out = await call(f, payload(), { fetcher: async (url, init) => {
    assert.equal(url, origin + '/latest'); assert.equal(init.method, 'GET'); assert.equal(init.redirect, 'manual');
    assert.equal(init.cache, 'no-store'); assert.equal(init.headers['Cache-Control'], 'no-store');
    return response(payload());
  } });
  assert.equal(out.get(5).status, 'ok'); assert.equal(out.get(6).status, 'ok');
  assert.equal(out.get(5).source, 'cloudflare_alarm'); assert.equal(out.get(5).runUrl, null);
  assert.equal(out.get(5).statusUrl, origin + '/status'); assert.equal(out.get(5).ageMs, 2000);
  assert.equal(out.get(5).dbThresholdMs, 1000);
  const after = JSON.stringify(f.sqlite.prepare('SELECT name FROM sqlite_master WHERE type=\'table\'').all()
    .map(({ name }) => [name, f.sqlite.prepare(`SELECT count(*) AS n FROM "${name}"`).get().n]));
  assert.equal(before, after);
});

test('the read-only service binding keeps its receiver and global fetch is never used', async t => {
  const f = fixture(t); let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { assert.fail('global fetch must not be used'); });
  const binding = { fetch: async function(url, init) {
    assert.equal(this, binding); assert.equal(url, origin + '/latest'); assert.equal(init.method, 'GET');
    calls++; return response(payload());
  } };
  f.env.CLOUDFLARE_WITNESS = binding;
  const out = await getExternalSummaries(f.env, now);
  assert.equal(calls, 1); assert.equal(out.get(5).status, 'ok'); assert.equal(out.get(6).status, 'ok');
});

test('a missing service binding fails closed without global fetch, while an injected test fetcher takes priority', async t => {
  const f = fixture(t);
  t.mock.method(globalThis, 'fetch', async () => { assert.fail('global fetch must not be used'); });
  const missing = await getExternalSummaries(f.env, now);
  assert.equal(missing.get(5).source, 'cloudflare_alarm'); assert.equal(missing.get(5).status, 'unknown');
  f.env.CLOUDFLARE_WITNESS = { fetch() { assert.fail('injected fetcher must take priority'); } };
  assert.equal((await call(f)).get(5).status, 'ok');
});

for (const url of ['', 'http://helth-witness.opus-system.workers.dev', origin + '/latest', origin + '?x=1',
  origin + '#x', origin.replace('https://', 'https://user@'), origin + ':443', 'https://127.0.0.1', origin + '.invalid']) {
  test(`invalid configured origin fails closed without fetching: ${url}`, async t => {
    const f = fixture(t); f.env.CLOUDFLARE_WITNESS_URL = url;
    const out = await call(f, payload(), { fetcher: async () => { assert.fail('must not fetch'); } });
    assert.equal(out.get(5).source, 'cloudflare_alarm'); assert.equal(out.get(5).status, 'unknown');
  });
}

for (const [name, mutate] of [
  ['disabled', v => { v.enabled = false; }],
  ['restart without current-generation observation', v => { v.readiness.status = 'unknown'; }],
  ['stale actual probe despite recent finish', v => { v.observed_at = now - 150000; }],
  ['future timestamp', v => { v.finished_at = now + 30001; }],
  ['wrong source', v => { v.source = 'github_actions'; }],
  ['duplicate result', v => { v.results[1] = v.results[0]; }],
  ['wrong target', v => { v.results[1].monitor_id = 7; }],
]) test(`Cloudflare summary rejects ${name}`, async t => {
  const f = fixture(t), value = payload(); mutate(value);
  const out = await call(f, value); assert.equal(out.get(5).status, 'unknown'); assert.equal(out.get(6).status, 'unknown');
});

for (const [name, mutate] of [
  ['array status', v => { v.results[0].status = ['ok']; }],
  ['truthy unknown string', v => { v.results[0].status = 'healthy'; }],
  ['HTTP error claimed healthy', v => { v.results[0].http_status = 503; }],
  ['slow database claimed healthy', v => { v.results[0].database_ms = 1000; }],
  ['missing database claimed healthy', v => { v.results[0].database_ms = null; }],
  ['wrong target URL', v => { v.results[0].url = 'https://private.invalid'; }],
  ['wrong threshold', v => { v.results[0].db_threshold_ms = 800; }],
  ['probe before current cycle', v => { v.results[0].observed_at -= 1000; }],
  ['result in future', v => { v.results[0].finished_at = now + 30001; }],
]) test(`invalid Cloudflare target remains unknown: ${name}`, async t => {
  const f = fixture(t), value = payload(); mutate(value);
  const out = await call(f, value); assert.equal(out.get(5).status, 'unknown');
});

test('current monitor URL, enabled flag and availability role must still match the fixed probe', async t => {
  for (const sql of ["UPDATE monitors SET url='https://changed.invalid' WHERE id=5",
    "UPDATE monitors SET monitor_role='diagnostic' WHERE id=5", 'UPDATE monitors SET enabled=0 WHERE id=5']) {
    const f = fixture(t); f.sqlite.exec(sql); assert.equal((await call(f)).get(5).status, 'unknown');
  }
});

test('a fixed1000 supplement stays valid and exposes its own policy when the primary threshold is1500', async t => {
  const f = fixture(t);
  f.sqlite.exec('UPDATE monitors SET db_latency_threshold_ms=1500,config_revision=2 WHERE id IN(5,6)');
  const before = JSON.stringify(f.sqlite.prepare('SELECT * FROM monitors ORDER BY id').all());
  const out = await call(f);
  assert.equal(out.get(5).status, 'ok'); assert.equal(out.get(6).status, 'ok');
  assert.equal(out.get(5).dbThresholdMs, 1000); assert.equal(out.get(6).dbThresholdMs, 1000);
  const value = payload(); Object.assign(value.results[0], { status: 'degraded', database_ms: 1200 });
  assert.equal((await call(f, value)).get(5).status, 'degraded');
  assert.equal(JSON.stringify(f.sqlite.prepare('SELECT * FROM monitors ORDER BY id').all()), before);
});

test('a reported1500 threshold is invalid even when it equals the current primary threshold', async t => {
  const f = fixture(t), value = payload();
  f.sqlite.exec('UPDATE monitors SET db_latency_threshold_ms=1500 WHERE id=5');
  value.results[0].db_threshold_ms = 1500;
  const out = await call(f, value);
  assert.equal(out.get(5).status, 'unknown');
  assert.equal(out.get(5).dbThresholdMs, 1000);
});

test('a fresh down observation stays down and degraded stays degraded', async t => {
  const f = fixture(t), value = payload();
  Object.assign(value.results[0], { status: 'down', http_status: null, database_ms: null, failure: 'timeout' });
  Object.assign(value.results[1], { status: 'degraded', database_ms: 1200 });
  const out = await call(f, value); assert.equal(out.get(5).status, 'down'); assert.equal(out.get(6).status, 'degraded');
});

test('Cloudflare opt-in never falls back to a fresh healthy GitHub row', async t => {
  const f = fixture(t), sha = 'a'.repeat(40);
  const report = { version: 1, run_id: '12345', run_attempt: '1', commit_sha: sha,
    observations: config.targets.map(target => ({ monitor_id: target.monitor_id, url: target.url, db_threshold_ms: target.db_threshold_ms,
      observed_at: now - 2000, finished_at: now - 1000, total_ms: 1000, http_status: 200, status: 'ok', database_ms: 100, error: null,
      request_id: crypto.randomUUID() })), readiness: { observed_at: now - 2000, finished_at: now - 1000,
        total_ms: 1000, http_status: 200, status: 'fresh', error: null } };
  const req = new Request(config.receiver, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test.token.signature' }, body: JSON.stringify(report) });
  assert.equal((await handleExternalObservation(req, f.env, { now, verifyToken: async () => ({ run_id: '12345', run_attempt: '1', sha }) })).status, 200);
  const out = await call(f, payload(), { fetcher: async () => { throw new Error('unavailable'); } });
  assert.equal(out.get(5).source, 'cloudflare_alarm'); assert.equal(out.get(5).status, 'unknown');
  delete f.env.CLOUDFLARE_WITNESS_URL;
  const github = await call(f, payload(), { fetcher: async () => { assert.fail('not configured'); } });
  assert.equal(github.get(5).source, 'github_actions'); assert.equal(github.get(5).status, 'ok');
});

test('redirects, cached responses, wrong MIME and oversized bodies are unknown', async t => {
  const f = fixture(t);
  for (const make of [() => new Response(null, { status: 302, headers: { Location: 'https://private.invalid' } }),
    () => Response.json(payload()), () => Response.json(payload(), { headers: { 'Cache-Control': 'no-store', Age: '1' } }),
    () => new Response(JSON.stringify(payload()), { headers: { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' } }),
    () => new Response(' '.repeat(8193), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } })]) {
    const out = await call(f, payload(), { fetcher: async () => make() }); assert.equal(out.get(5).status, 'unknown');
  }
});

for (const status of ['HIT', 'STALE', 'UPDATING', 'REVALIDATED']) test(`explicit Cloudflare cache ${status} cannot establish health`, async t => {
  const f = fixture(t);
  const out = await call(f, payload(), { fetcher: async () => Response.json(payload(), {
    headers: { 'Cache-Control': 'no-store', 'CF-Cache-Status': status, Age: '0' },
  }) });
  assert.equal(out.get(5).status, 'unknown'); assert.equal(out.get(6).status, 'unknown');
});

test('one absolute deadline covers both headers and body, without waiting for cancellation acknowledgement', async t => {
  const f = fixture(t); let cancelled = 0;
  const start = performance.now();
  const out = await call(f, payload(), { timeoutMs: 15, fetcher: async () => {
    await new Promise(resolve => setTimeout(resolve, 10));
    return new Response(new ReadableStream({ cancel() { cancelled++; return new Promise(() => {}); } }),
      { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
  } });
  assert.equal(out.get(5).status, 'unknown'); assert.ok(performance.now() - start < 300); assert.equal(cancelled, 1);
  const never = await call(f, payload(), { timeoutMs: 5, fetcher: () => new Promise(() => {}) });
  assert.equal(never.get(5).status, 'unknown');
});

test('healthy I/O arriving after the absolute deadline cannot win an overdue timer race', async t => {
  const f = fixture(t);
  const late = await call(f, payload(), { timeoutMs: 5, fetcher: async () => {
    const until = performance.now() + 30;
    while (performance.now() < until) { /* Simulate a busy event loop before the timer callback can run. */ }
    return response(payload());
  } });
  assert.equal(late.get(5).status, 'unknown'); assert.equal(late.get(6).status, 'unknown');
});

test('a late header response still cancels its body after the caller already returned unknown', async t => {
  const f = fixture(t); let deliver; let cancelled = 0;
  const out = await call(f, payload(), { timeoutMs: 5, fetcher: () => new Promise(resolve => { deliver = resolve; }) });
  assert.equal(out.get(5).status, 'unknown');
  deliver(new Response(new ReadableStream({ cancel() { cancelled++; return new Promise(() => {}); } }),
    { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } }));
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(cancelled, 1);
});
