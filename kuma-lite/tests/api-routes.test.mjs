import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { handleApiRequest } from '../src/api.ts';

function fixture() {
  const sql = new DatabaseSync(':memory:');
  sql.exec('PRAGMA foreign_keys = ON');
  sql.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  let beforeRun;
  const prepare = (query, args = []) => ({
    bind(...values) { return prepare(query, values); },
    async run() {
      beforeRun?.(query);
      const info = sql.prepare(query).run(...args);
      return { meta: { last_row_id: Number(info.lastInsertRowid), changes: Number(info.changes) } };
    },
    async first() { return sql.prepare(query).get(...args) ?? null; },
    async all() { return { results: sql.prepare(query).all(...args) }; },
  });
  const env = { API_TOKEN: 'local-api-fixture', DB: { prepare, async batch(statements) {
    sql.exec('BEGIN');
    try { const out = []; for (const statement of statements) out.push(await statement.run()); sql.exec('COMMIT'); return out; }
    catch (error) { sql.exec('ROLLBACK'); throw error; }
  } } };
  return {
    sql, setBeforeRun(fn) { beforeRun = fn; },
    request(method, body, path = '/api/monitors') {
      return handleApiRequest(new Request('https://monitor.invalid' + path, {
        method, headers: { Authorization: 'Bearer local-api-fixture', 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }), env);
    },
    close() { sql.close(); },
  };
}
const target = { name: 'Service', url: 'https://target.invalid/healthz' };
const strict = { ...target, probe_transport: 'public_fetch', response_mode: 'strict_healthz' };

// These use real SQLite constraints and update guards; no production requests.
test('legacy creation is unchanged and explicit public availability starts its own boundary', async () => {
  const f = fixture(); try {
    assert.equal((await f.request('POST', target)).status, 201);
    let row = f.sql.prepare('SELECT * FROM monitors WHERE id = 1').get();
    assert.equal(row.probe_transport, 'legacy'); assert.equal(row.monitor_role, 'availability');
    assert.equal(row.response_mode, 'legacy_http'); assert.equal(row.availability_since_ms, null); assert.equal(row.config_revision, 1);
    assert.equal((await f.request('POST', strict)).status, 201);
    row = f.sql.prepare('SELECT * FROM monitors WHERE id = 2').get();
    assert.ok(row.availability_since_ms > 0); assert.equal(row.config_revision, 1);
  } finally { f.close(); }
});

test('shadow and diagnostic monitors require a real availability parent', async () => {
  const f = fixture(); try {
    await f.request('POST', target);
    for (const body of [
      { ...strict, monitor_role: 'shadow' },
      { ...strict, monitor_role: 'shadow', parent_monitor_id: 99 },
      { ...strict, parent_monitor_id: 1 },
      { ...strict, monitor_role: 'shadow', parent_monitor_id: 0.5 },
      { ...strict, monitor_role: 'shadow', parent_monitor_id: '1' },
    ]) assert.equal((await f.request('POST', body)).status, 400);
    assert.equal((await f.request('POST', { ...strict, monitor_role: 'shadow', parent_monitor_id: 1 })).status, 201);
    const shadow = f.sql.prepare('SELECT * FROM monitors WHERE id = 2').get();
    assert.equal(shadow.availability_since_ms, null);
    assert.equal((await f.request('POST', { ...strict, monitor_role: 'shadow', parent_monitor_id: 2 })).status, 400);
    assert.equal((await f.request('PATCH', { parent_monitor_id: 2 }, '/api/monitors/2')).status, 400);
  } finally { f.close(); }
});

test('route enums, managed fields, and unavailable explicit binding configuration fail before writing', async () => {
  const f = fixture(); try {
    const invalid = [
      { probe_transport: 'automatic' }, { monitor_role: null }, { response_mode: 'json' },
      { probe_transport: ['public_fetch'] }, { probe_transport: {} },
      { monitor_role: ['availability'] }, { monitor_role: {} },
      { response_mode: ['strict_healthz'] }, { response_mode: {} },
      { config_revision: 1 }, { availability_since_ms: 0 }, { probe_transport: 'service_binding' },
    ];
    for (const extra of invalid) assert.equal((await f.request('POST', { ...target, ...extra })).status, 400);
    assert.equal(f.sql.prepare('SELECT count(*) AS n FROM monitors').get().n, 0);
    await f.request('POST', target);
    for (const extra of invalid) assert.equal((await f.request('PATCH', extra, '/api/monitors/1')).status, 400);
    assert.equal(f.sql.prepare('SELECT config_revision FROM monitors').get().config_revision, 1);
  } finally { f.close(); }
});

test('explicit public health targets reject local/literal URLs, credentials and request variations', async () => {
  const f = fixture(); try {
    for (const url of [
      'http://target.invalid/healthz', 'https://127.0.0.1/healthz', 'https://2130706433/healthz',
      'https://[::1]/healthz', 'https://localhost/healthz', 'https://app.local/healthz',
      'https://app.internal./healthz', 'https://name:secret@target.invalid/healthz',
      'https://target.invalid:444/healthz', 'https://target.invalid/healthz?token=secret',
      'https://target.invalid/healthz#fragment', 'https://target.invalid/login',
    ]) assert.equal((await f.request('POST', { ...strict, url })).status, 400, url);
    assert.equal((await f.request('POST', { ...strict, method: 'POST' })).status, 400);
    assert.equal(f.sql.prepare('SELECT count(*) AS n FROM monitors').get().n, 0);
  } finally { f.close(); }
});

test('route cutover is guarded by live lease and current incident state in the write', async () => {
  const f = fixture(); try {
    await f.request('POST', { ...target, service_binding: 'CORE_OS' });
    f.sql.prepare("INSERT INTO monitor_state(monitor_id,current_status,last_check_slot) VALUES(1,'up',60000)").run();
    f.sql.prepare("INSERT INTO monitor_execution(monitor_id,claimed_slot,lease_token,lease_until) VALUES(1,60000,'running',?)").run(Date.now() + 120000);
    const patch = { probe_transport: 'public_fetch', response_mode: 'strict_healthz' };
    assert.equal((await f.request('PATCH', patch, '/api/monitors/1')).status, 409);
    f.sql.prepare('UPDATE monitor_execution SET lease_until = 0').run();
    f.sql.prepare("UPDATE monitor_state SET current_status = 'down', slack_alert_ts = 'existing-thread'").run();
    assert.equal((await f.request('PATCH', patch, '/api/monitors/1')).status, 409);
    f.sql.prepare("UPDATE monitor_state SET current_status = 'up'").run();
    assert.equal((await f.request('PATCH', patch, '/api/monitors/1')).status, 200);
    const row = f.sql.prepare('SELECT * FROM monitors WHERE id = 1').get();
    assert.equal(row.config_revision, 2); assert.ok(row.availability_since_ms > 0);
    const state = f.sql.prepare('SELECT * FROM monitor_state WHERE monitor_id = 1').get();
    assert.equal(state.last_check_slot, 60000); assert.equal(state.slack_alert_ts, 'existing-thread');
  } finally { f.close(); }
});

test('all patches advance config revision and stale concurrent writes cannot replace a newer revision', async () => {
  const f = fixture(); try {
    await f.request('POST', target);
    assert.equal((await f.request('PATCH', { db_latency_threshold_ms: 1000 }, '/api/monitors/1')).status, 200);
    assert.equal(f.sql.prepare('SELECT config_revision FROM monitors').get().config_revision, 2);
    let raced = false;
    f.setBeforeRun(query => {
      if (!raced && query.startsWith('UPDATE monitors SET')) {
        raced = true; f.sql.prepare("UPDATE monitors SET config_revision = 3, name = 'Concurrent winner'").run();
      }
    });
    assert.equal((await f.request('PATCH', { name: 'Stale loser' }, '/api/monitors/1')).status, 409);
    const row = f.sql.prepare('SELECT * FROM monitors').get();
    assert.equal(row.name, 'Concurrent winner'); assert.equal(row.config_revision, 3);
  } finally { f.close(); }
});

test('rolling public availability back to a legacy route clears its current boundary and retains evidence', async () => {
  const f = fixture(); try {
    assert.equal((await f.request('POST', strict)).status, 201);
    const original = f.sql.prepare('SELECT * FROM monitors WHERE id = 1').get();
    assert.ok(original.availability_since_ms > 0);
    f.sql.prepare("INSERT INTO checks(monitor_id,status,ts,config_revision,monitor_role,probe_transport) VALUES(1,'up',?,1,'availability','public_fetch')").run(original.availability_since_ms);
    assert.equal((await f.request('PATCH', { probe_transport: 'legacy' }, '/api/monitors/1')).status, 200);
    const row = f.sql.prepare('SELECT * FROM monitors WHERE id = 1').get();
    assert.equal(row.availability_since_ms, null); assert.equal(row.config_revision, 2);
    const history = f.sql.prepare('SELECT * FROM checks WHERE monitor_id = 1').all();
    assert.equal(history.length, 1); assert.equal(history[0].probe_transport, 'public_fetch');
    assert.equal(history[0].config_revision, 1); assert.equal(history[0].ts, original.availability_since_ms);
  } finally { f.close(); }
});

test('parent deletion or role reassignment cannot orphan independent diagnostic histories', async () => {
  const f = fixture(); try {
    await f.request('POST', target);
    await f.request('POST', { ...target, monitor_role: 'diagnostic', parent_monitor_id: 1, probe_transport: 'service_binding', service_binding: 'CORE_OS' });
    await f.request('POST', { ...target, name: 'Other parent' });
    assert.equal((await f.request('DELETE', undefined, '/api/monitors/1')).status, 409);
    assert.equal((await f.request('PATCH', { monitor_role: 'diagnostic', parent_monitor_id: 3 }, '/api/monitors/1')).status, 409);
    assert.equal(f.sql.prepare('SELECT count(*) AS n FROM monitors').get().n, 3);
  } finally { f.close(); }
});
