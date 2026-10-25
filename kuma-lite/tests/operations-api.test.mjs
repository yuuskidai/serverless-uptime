import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTs, sqliteEnv } from './helpers.mjs';

const { handleApiRequest } = loadTs('api');
function fixture(t) {
  const f = sqliteEnv();
  t.after(() => f.close());
  f.env.API_TOKEN = 'local-operations-key';
  f.request = (path, { method = 'GET', body, authenticated = true } = {}) => handleApiRequest(
    new Request('https://monitor.invalid' + path, { method, headers: {
      ...(authenticated ? { Authorization: 'Bearer local-operations-key' } : {}),
      'Content-Type': 'application/json',
    }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), f.env);
  return f;
}
function queue(f, status = 'pending', created = Date.now() - 1000) {
  const slot = Math.floor(created / 60000) * 60000;
  f.sqlite.prepare(`INSERT INTO notification_outbox(monitor_id,scheduled_slot,config_revision,kind,observed_at,
    result_json,transition_json,status,created_at,last_error)
    VALUES(1,?,1,'down',?,'{"private":"hidden-result"}','{"private":"hidden-transition"}',?,?,'provider_uncertain')`)
    .run(slot, created, status, created);
}

test('inspection endpoints require management authentication and reject writes', async t => {
  const f = fixture(t);
  for (const name of ['runs', 'attempts', 'notifications', 'external-observations']) {
    assert.equal((await f.request('/api/' + name, { authenticated: false })).status, 401);
    assert.equal((await f.request('/api/' + name, { method: 'POST', body: {} })).status, 405);
    const response = await f.request('/api/' + name);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
  }
});

test('inspection filters are bounded, typed, and cannot introduce SQL or hidden fields', async t => {
  const f = fixture(t);
  const now = Date.now();
  for (const suffix of [
    '?limit=201', '?limit=0', '?limit=1.5', '?monitor_id=0', '?monitor_id=1%20OR%201=1',
    '?from=0&to=86400001', '?from=2&to=1', '?from=-1', '?limit=1&limit=2',
    '?sort=created_at', '?status=pending', '?to=' + (now + 120000),
  ]) assert.equal((await f.request('/api/attempts' + suffix)).status, 400, suffix);
  assert.equal((await f.request('/api/notifications?status=unknown')).status, 400);
  assert.equal((await f.request('/api/external-observations?status=ok')).status, 400);
  assert.equal((await f.request('/api/runs?monitor_id=1')).status, 400);
  queue(f, 'uncertain', now - 5000);
  queue(f, 'sent', now - 65000);
  const response = await f.request(`/api/notifications?from=${now-3600000}&to=${now}&status=uncertain&limit=1&monitor_id=1`);
  const data = await response.json();
  assert.equal(data.notifications.length, 1);
  assert.equal(data.notifications[0].status, 'uncertain');
  assert.equal(data.notifications[0].last_error, 'provider_uncertain');
  assert.doesNotMatch(JSON.stringify(data), /hidden-result|hidden-transition|result_json|transition_json|lease_token/);
});

test('attempt inspection preserves explicit reasons and time window ordering for missing monitors', async t => {
  const f = fixture(t), now = Date.now();
  const insert = f.sqlite.prepare(`INSERT INTO monitor_attempts(attempt_id,monitor_id,scheduled_time,scheduled_slot,
    received_at,config_revision,monitor_role,probe_transport,decision,reason,observed_at)
    VALUES(?,99,?,?,?,1,'availability','public_fetch','denied','monitor_missing',?)`);
  for (const [id, stamp] of [['older', now - 100000], ['newer', now - 1000]]) insert.run(id, stamp, stamp, stamp, stamp);
  const data = await (await f.request(`/api/attempts?from=${now-3600000}&to=${now}&monitor_id=99&limit=1`)).json();
  assert.equal(data.attempts.length, 1);
  assert.equal(data.attempts[0].attempt_id, 'newer');
  assert.equal(data.attempts[0].reason, 'monitor_missing');
});

test('route changes and deletion wait for notification ownership independently of probe leases', async t => {
  const f = fixture(t), now = Date.now();
  f.sqlite.prepare("INSERT INTO monitor_state(monitor_id,current_status,last_check_slot) VALUES(1,'up',60000)").run();
  f.sqlite.prepare('INSERT INTO notification_delivery_state(monitor_id,lease_until) VALUES(1,?)').run(now + 30000);
  f.sqlite.prepare("INSERT INTO checks(monitor_id,status,ts) VALUES(1,'up',?)").run(now - 1000);
  const body = { probe_transport: 'public_fetch', response_mode: 'strict_healthz' };
  assert.equal((await f.request('/api/monitors/1', { method: 'PATCH', body })).status, 409);
  assert.equal((await f.request('/api/monitors/1', { method: 'DELETE' })).status, 409);
  f.sqlite.prepare('UPDATE notification_delivery_state SET lease_until=0').run();
  queue(f);
  assert.equal((await f.request('/api/monitors/1', { method: 'PATCH', body })).status, 409);
  assert.equal((await f.request('/api/monitors/1', { method: 'DELETE' })).status, 409);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM checks').get().n, 1);
  f.sqlite.prepare("UPDATE notification_outbox SET status='sent',completed_at=?").run(now);
  assert.equal((await f.request('/api/monitors/1', { method: 'PATCH', body })).status, 200);
  assert.equal((await f.request('/api/monitors/1', { method: 'DELETE' })).status, 200);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM notification_outbox').get().n, 0);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM notification_delivery_state').get().n, 0);
});

test('atomic route guard rejects a notification lease acquired after the API pre-read', async t => {
  const f = fixture(t);
  const prepare = f.env.DB.prepare;
  let raced = false;
  f.env.DB.prepare = query => {
    const statement = prepare(query);
    const bind = statement.bind;
    statement.bind = (...values) => {
      const bound = bind(...values);
      const run = bound.run;
      bound.run = async () => {
        if (!raced && query.startsWith('UPDATE monitors SET')) {
          raced = true;
          f.sqlite.prepare('INSERT INTO notification_delivery_state(monitor_id,lease_until) VALUES(1,?)').run(Date.now() + 30000);
        }
        return run.call(bound);
      };
      return bound;
    };
    return statement;
  };
  assert.equal((await f.request('/api/monitors/1', { method: 'PATCH', body: { probe_transport: 'public_fetch' } })).status, 409);
  assert.equal(f.sqlite.prepare('SELECT config_revision FROM monitors').get().config_revision, 1);
});

test('deletion races preserve history when new delivery or a child appears before the transaction', async t => {
  for (const kind of ['notification', 'child']) await t.test(kind, async t => {
    const f = fixture(t), now = Date.now();
    f.sqlite.prepare("INSERT INTO monitor_state(monitor_id,current_status) VALUES(1,'up')").run();
    f.sqlite.prepare("INSERT INTO checks(monitor_id,status,ts) VALUES(1,'up',?)").run(now);
    const batch = f.env.DB.batch;
    f.env.DB.batch = statements => {
      if (kind === 'notification') queue(f);
      else f.sqlite.prepare(`INSERT INTO monitors(id,name,url,created_at,monitor_role,parent_monitor_id)
        VALUES(2,'New child','https://example.invalid/healthz',0,'shadow',1)`).run();
      return batch(statements);
    };
    assert.equal((await f.request('/api/monitors/1', { method: 'DELETE' })).status, 409);
    assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM checks WHERE monitor_id=1').get().n, 1);
    assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM monitor_state WHERE monitor_id=1').get().n, 1);
    assert.ok(f.sqlite.prepare('SELECT id FROM monitors WHERE id=1').get());
  });
});
