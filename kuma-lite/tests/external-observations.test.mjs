import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadTs, sqliteEnv } from './helpers.mjs';

const { handleExternalObservation, readExternalWitnesses } = loadTs('external-observations');
const config = JSON.parse(readFileSync(new URL('../external-targets.json', import.meta.url), 'utf8'));
const now = Date.now();
const sha = 'a'.repeat(40);
const claims = { run_id: '12345', run_attempt: '1', sha };
function fixture() {
  const f = sqliteEnv();
  if (!f.sqlite.prepare("SELECT name FROM sqlite_master WHERE name='external_probe_runs'").get()) {
    f.sqlite.exec(readFileSync(new URL('../migrations/0013_external_observations.sql', import.meta.url), 'utf8'));
  }
  for (const target of config.targets) f.sqlite.prepare(
    'INSERT INTO monitors(id,name,url,db_latency_threshold_ms,created_at) VALUES(?,?,?,?,0)',
  ).run(target.monitor_id, target.name, target.url, target.db_threshold_ms);
  Object.assign(f.env, {
    EXTERNAL_PROBE_AUDIENCE: config.receiver,
    EXTERNAL_PROBE_REPOSITORY: config.repository,
    EXTERNAL_PROBE_REPOSITORY_ID: '1229702777',
    EXTERNAL_PROBE_OWNER_ID: '85591602',
    EXTERNAL_PROBE_WORKFLOW_REF: `${config.repository}/.github/workflows/external-health.yml@refs/heads/master`,
  });
  return f;
}
function body(overrides = {}) {
  return { version: 1, run_id: claims.run_id, run_attempt: claims.run_attempt, commit_sha: sha,
    observations: config.targets.map(target => ({ ...target, name: undefined,
      observed_at: now - 1500, finished_at: now - 1000, total_ms: 500,
      status: 'ok', http_status: 200, database_ms: 100, error: null,
      request_id: crypto.randomUUID(),
    })).map(({ name, ...value }) => value),
    readiness: { observed_at: now - 1500, finished_at: now - 1000, total_ms: 500,
      http_status: 200, status: 'fresh', error: null }, ...overrides };
}
function request(value, extra = {}) {
  return new Request(config.receiver, { method: 'POST', headers: { Authorization: 'Bearer test.token.signature',
    'Content-Type': 'application/json', ...extra.headers },
    body: typeof value === 'string' ? value : JSON.stringify(value), ...extra });
}
const options = { now, verifyToken: async () => claims };

test('verified external observations are supplemental and readable without advancing primary state', async () => {
  const f = fixture(); try {
    const result = await handleExternalObservation(request(body()), f.env, options);
    assert.equal(result.status, 200); assert.equal((await result.json()).duplicate, false);
    assert.equal(f.sqlite.prepare('SELECT count(*) n FROM external_observations').get().n, 2);
    for (const table of ['checks', 'monitor_state', 'monitor_execution']) assert.equal(f.sqlite.prepare(`SELECT count(*) n FROM ${table}`).get().n, 0);
    const witnesses = await readExternalWitnesses(f.env, now);
    assert.equal(witnesses.get(5).status, 'ok'); assert.equal(witnesses.get(6).status, 'ok');
    assert.equal(witnesses.get(5).runUrl, `https://github.com/${config.repository}/actions/runs/12345/attempts/1`);
    assert.equal(witnesses.get(5).ageMs, 1000);
  } finally { f.close(); }
});

test('fixed external1000 policy remains independent when primary1500 revision2 is current', async () => {
  const f = fixture(); try {
    f.sqlite.exec('UPDATE monitors SET db_latency_threshold_ms=1500,interval_minutes=2,config_revision=2 WHERE id IN (5,6)');
    const value=body();
    value.observations[0].status='degraded'; value.observations[0].database_ms=1200;
    assert.equal((await handleExternalObservation(request(value),f.env,options)).status,200);
    const saved=f.sqlite.prepare('SELECT monitor_config_revision,db_threshold_ms,database_ms,status FROM external_observations WHERE monitor_id=5').get();
    assert.equal(saved.monitor_config_revision,2); assert.equal(saved.db_threshold_ms,1000);
    assert.equal(saved.database_ms,1200); assert.equal(saved.status,'degraded');
    const witness=(await readExternalWitnesses(f.env,now)).get(5);
    assert.equal(witness.status,'degraded'); assert.equal(witness.dbThresholdMs,1000);
    for(const table of ['checks','monitor_state','monitor_execution']) assert.equal(f.sqlite.prepare(`SELECT count(*) n FROM ${table}`).get().n,0);
  } finally { f.close(); }
});

test('an external report cannot adopt the primary1500 policy', async () => {
  const f=fixture(); try {
    f.sqlite.exec('UPDATE monitors SET db_latency_threshold_ms=1500,config_revision=2 WHERE id IN (5,6)');
    const value=body(); value.observations[0].db_threshold_ms=1500;
    assert.equal((await handleExternalObservation(request(value),f.env,options)).status,400);
    assert.equal(f.sqlite.prepare('SELECT count(*) n FROM external_probe_runs').get().n,0);
    assert.equal(f.sqlite.prepare('SELECT count(*) n FROM external_observations').get().n,0);
  } finally { f.close(); }
});

test('same workflow payload is idempotent and conflicting replay cannot overwrite evidence', async () => {
  const f = fixture(); try {
    const value = body();
    assert.equal((await handleExternalObservation(request(value), f.env, options)).status, 200);
    const duplicate = await handleExternalObservation(request(value), f.env, options);
    assert.equal(duplicate.status, 200); assert.equal((await duplicate.json()).duplicate, true);
    const conflict = structuredClone(value); conflict.observations[0].total_ms++;
    assert.equal((await handleExternalObservation(request(conflict), f.env, options)).status, 409);
    assert.equal(f.sqlite.prepare('SELECT count(*) n FROM external_probe_runs').get().n, 1);
    assert.equal(f.sqlite.prepare('SELECT total_ms FROM external_observations WHERE monitor_id=5').get().total_ms, 500);
  } finally { f.close(); }
});

test('authentication and configuration failures occur before reading untrusted bodies or writing data', async () => {
  const f = fixture(); try {
    assert.equal((await handleExternalObservation(new Request(config.receiver), f.env, options)).status, 405);
    assert.equal((await handleExternalObservation(request('{}', { headers: { 'Content-Type': 'text/plain' } }), f.env, options)).status, 415);
    assert.equal((await handleExternalObservation(request('{}', { headers: { 'Content-Type': 'application/json' } }), f.env, options)).status, 401);
    assert.equal((await handleExternalObservation(request(body()), f.env, { now, verifyToken: async () => { throw new Error('private detail'); } })).status, 401);
    const unconfigured = { ...f.env, EXTERNAL_PROBE_AUDIENCE: undefined };
    assert.equal((await handleExternalObservation(request(body()), unconfigured, options)).status, 503);
    assert.equal(f.sqlite.prepare('SELECT count(*) n FROM external_probe_runs').get().n, 0);
  } finally { f.close(); }
});

for (const [label, mutate] of [
  ['unknown top-level property', value => { value.untrusted = 'body'; }],
  ['wrong run identity', value => { value.run_id = '99999'; }],
  ['wrong attempt identity', value => { value.run_attempt = '2'; }],
  ['wrong source SHA', value => { value.commit_sha = 'b'.repeat(40); }],
  ['arbitrary target URL', value => { value.observations[0].url = 'https://private.invalid/healthz'; }],
  ['duplicate target', value => { value.observations[1] = value.observations[0]; }],
  ['array status', value => { value.observations[0].status = ['down']; }],
  ['HTTP503 claimed healthy', value => { value.observations[0].http_status = 503; }],
  ['slow DB claimed healthy', value => { value.observations[0].database_ms = 1000; }],
  ['missing DB claimed healthy', value => { value.observations[0].database_ms = null; }],
  ['stale observation', value => { value.observations[0].observed_at = now - 600_001; }],
  ['future observation', value => { value.observations[0].finished_at = now + 30_001; }],
  ['negative elapsed', value => { value.observations[0].total_ms = -1; }],
  ['unexpected error', value => { value.observations[0].error = 'secret response'; }],
  ['invalid request ID', value => { value.observations[0].request_id = '-'.repeat(36); }],
  ['readiness HTTP error claimed fresh', value => { value.readiness.http_status = 503; }],
]) test(`external report rejects ${label}`, async () => {
  const f = fixture(); try {
    const value = body(); mutate(value);
    assert.equal((await handleExternalObservation(request(value), f.env, options)).status, 400);
    assert.equal(f.sqlite.prepare('SELECT count(*) n FROM external_observations').get().n, 0);
  } finally { f.close(); }
});

test('target configuration changes fail closed and revision changes invalidate old witness freshness', async () => {
  const f = fixture(); try {
    const value = body();
    assert.equal((await handleExternalObservation(request(value), f.env, options)).status, 200);
    f.sqlite.exec('UPDATE monitors SET config_revision=2 WHERE id=5');
    assert.equal((await readExternalWitnesses(f.env, now)).get(5).status, 'unknown');
    f.sqlite.exec("UPDATE monitors SET url='https://changed.invalid/healthz' WHERE id=5");
    assert.equal((await handleExternalObservation(request(body()), f.env, options)).status, 409);
  } finally { f.close(); }
});

test('a configuration race rejects the entire run without exposing one partially accepted service', async () => {
  const f = fixture(); try {
    f.hooks.beforeBatchStatement = index => {
      if (index === 0) f.sqlite.exec('UPDATE monitors SET config_revision=2 WHERE id=6');
    };
    assert.equal((await handleExternalObservation(request(body()), f.env, options)).status, 409);
    assert.equal(f.sqlite.prepare('SELECT count(*) n FROM external_probe_runs').get().n, 0);
    assert.equal(f.sqlite.prepare('SELECT count(*) n FROM external_observations').get().n, 0);
    const witnesses = await readExternalWitnesses(f.env, now);
    assert.equal(witnesses.get(5).status, 'unknown'); assert.equal(witnesses.get(6).status, 'unknown');
  } finally { f.close(); }
});

test('a primary threshold race is fenced independently of the external policy', async () => {
  const f=fixture(); try {
    f.sqlite.exec('UPDATE monitors SET db_latency_threshold_ms=1500,config_revision=2 WHERE id IN (5,6)');
    f.hooks.beforeBatchStatement=index=>{if(index===0)f.sqlite.exec('UPDATE monitors SET db_latency_threshold_ms=2000 WHERE id=6');};
    assert.equal((await handleExternalObservation(request(body()),f.env,options)).status,409);
    assert.equal(f.sqlite.prepare('SELECT count(*) n FROM external_probe_runs').get().n,0);
    assert.equal(f.sqlite.prepare('SELECT count(*) n FROM external_observations').get().n,0);
  } finally { f.close(); }
});

test('a stored wrong-policy observation cannot be displayed as current external confirmation', async () => {
  const f=fixture(); try {
    assert.equal((await handleExternalObservation(request(body()),f.env,options)).status,200);
    f.sqlite.exec('UPDATE external_observations SET db_threshold_ms=1500 WHERE monitor_id=5');
    const witnesses=await readExternalWitnesses(f.env,now);
    assert.equal(witnesses.get(5).status,'unknown'); assert.equal(witnesses.get(5).dbThresholdMs,null);
    assert.equal(witnesses.get(6).status,'ok'); assert.equal(witnesses.get(6).dbThresholdMs,1000);
  } finally { f.close(); }
});

test('older appended observations never replace newer evidence and all witnesses become unknown after15 minutes', async () => {
  const f = fixture(); try {
    const value = body();
    assert.equal((await handleExternalObservation(request(value), f.env, options)).status, 200);
    const older = body({ run_id: '12346' });
    for (const observation of older.observations) { observation.observed_at -= 300_000; observation.finished_at -= 300_000; observation.status = 'down'; observation.http_status = null; observation.database_ms = null; observation.error = 'timeout_headers'; }
    assert.equal((await handleExternalObservation(request(older), f.env, { now, verifyToken: async () => ({ ...claims, run_id: '12346' }) })).status, 200);
    assert.equal((await readExternalWitnesses(f.env, now)).get(5).status, 'ok');
    const stale = await readExternalWitnesses(f.env, now + 900_000);
    assert.equal(stale.get(5).status, 'unknown'); assert.equal(stale.get(5).totalMs, null);
  } finally { f.close(); }
});

test('oversized or stalled request bodies are bounded and do not await cancellation acknowledgement', async () => {
  const f = fixture(); try {
    assert.equal((await handleExternalObservation(request(' '.repeat(9000)), f.env, options)).status, 400);
    let cancelled = 0;
    const streamed = new Request(config.receiver, { method: 'POST', duplex: 'half',
      headers: { Authorization: 'Bearer test.token.signature', 'Content-Type': 'application/json' },
      body: new ReadableStream({ cancel() { cancelled++; return new Promise(() => {}); } }) });
    assert.equal((await handleExternalObservation(streamed, f.env, { ...options, bodyTimeoutMs: 5 })).status, 400);
    assert.equal(cancelled, 1);
  } finally { f.close(); }
});

test('storage errors return a generic unavailable response without leaking database details', async () => {
  const f = fixture(); try {
    f.env.DB.batch = async () => { throw new Error('private database secret'); };
    const result = await handleExternalObservation(request(body()), f.env, options);
    assert.equal(result.status, 503); assert.equal((await result.text()).includes('private'), false);
  } finally { f.close(); }
});
