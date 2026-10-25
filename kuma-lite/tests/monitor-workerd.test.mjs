import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { result, root } from './helpers.mjs';

// Use the frozen Wrangler toolchain already installed by npm ci. No npx,
// on-demand download, Cloudflare account, production D1, or remote deploy.
const require = createRequire(import.meta.url);
const wranglerRequire = createRequire(require.resolve('wrangler/package.json'));
const { Miniflare, convertV4MiniflareOptions } = wranglerRequire('miniflare');
const { buildSync } = wranglerRequire('esbuild');
const bundle = buildSync({
  entryPoints: [fileURLToPath(new URL('tests/workerd-fixture.js', root))],
  bundle: true, format: 'esm', platform: 'browser', write: false,
}).outputFiles[0].text;

test('real workerd isolates share D1 atomic claims, expiry fences, CAS, and transaction rollback', async t => {
  const mf = new Miniflare(convertV4MiniflareOptions({
    workers: ['left', 'right'].map(name => ({
      name, script: bundle, modules: true, compatibilityDate: '2025-01-01',
      d1Databases: { DB: 'synthetic-monitor-execution' },
    })),
  }));
  t.after(() => mf.dispose());
  const db = await mf.getD1Database('DB', 'left');
  const schema = readFileSync(new URL('schema.sql', root), 'utf8');
  await db.batch(schema.replace(/^\s*--.*$/gm, '').split(';').map(x => x.trim()).filter(Boolean).map(sql => db.prepare(sql)));
  const workers = await Promise.all(['left', 'right'].map(name => mf.getWorker(name)));
  const call = async (side, payload) => {
    const response = await workers[side].fetch('http://local-test.invalid/', { method: 'POST', body: JSON.stringify(payload) });
    assert.equal(response.status, 200, await response.clone().text());
    return response.json();
  };
  const slotMs = Math.floor(Date.now() / 60000) * 60000;
  async function seed(id) {
    await db.prepare("INSERT INTO monitors(id,name,url,created_at) VALUES (?,'Synthetic monitor','https://example.invalid/healthz',0)").bind(id).run();
  }

  await t.test('simultaneous isolate claims yield one winner and same-slot release is not a retry', async () => {
    await seed(1);
    const claims = await Promise.all(Array.from({ length: 8 }, (_, i) => call(i % 2, { action: 'claim', monitorId: 1, slotMs })));
    assert.equal(claims.filter(Boolean).length, 1);
    assert.equal((await db.prepare('SELECT count(*) AS n FROM monitor_attempts WHERE monitor_id=1').first()).n, 8);
    assert.equal((await db.prepare("SELECT count(*) AS n FROM monitor_attempts WHERE monitor_id=1 AND decision='denied' AND reason='superseded_slot'").first()).n, 7);
    const lease = claims.find(Boolean);
    assert.equal(await call(0, { action: 'commit', lease, result: result() }), true);
    await call(1, { action: 'release', lease });
    assert.equal(await call(1, { action: 'claim', monitorId: 1, slotMs }), null);
    assert.equal((await db.prepare('SELECT count(*) AS n FROM checks WHERE monitor_id=1').first()).n, 1);
    assert.equal((await db.prepare("SELECT count(*) AS n FROM monitor_attempts WHERE monitor_id=1 AND decision='committed'").first()).n, 1);
    const older=await call(0,{action:'claimDecision',monitorId:1,slotMs:slotMs-60000});
    assert.equal(older.lease,null);
    assert.equal(older.attempt.reason,'superseded_slot');
    assert.equal(older.attempt.observed_last_check_slot,slotMs);
  });

  await t.test('expiry allows a newer isolate; stale commit/release/notification metadata cannot affect it', async () => {
    await seed(2);
    const old = await call(0, { action: 'claim', monitorId: 2, slotMs });
    assert.equal(await call(1, { action: 'claim', monitorId: 2, slotMs: slotMs + 60000 }), null);
    await db.prepare('UPDATE monitor_execution SET lease_until = 0 WHERE monitor_id=2').run();
    const current = await call(1, { action: 'claim', monitorId: 2, slotMs: slotMs + 60000 });
    assert.ok(current);
    assert.equal(await call(1, { action: 'commit', lease: current, result: result() }), true);
    await call(1, { action: 'thread', lease: current, thread: 'current-thread' });
    assert.equal(await call(0, { action: 'commit', lease: old, result: result('down') }), false);
    assert.equal(await call(0, { action: 'reserve', lease: old }), false);
    await call(0, { action: 'release', lease: old });
    await call(0, { action: 'thread', lease: old, thread: 'stale-thread' });
    const state = await db.prepare('SELECT * FROM monitor_state WHERE monitor_id=2').first();
    assert.equal(state.last_check_slot, current.slotMs);
    assert.equal(state.slack_alert_ts, 'current-thread');
    assert.equal((await db.prepare('SELECT lease_token FROM monitor_execution WHERE monitor_id=2').first()).lease_token, current.token);
    assert.equal((await db.prepare('SELECT count(*) AS n FROM checks WHERE monitor_id=2').first()).n, 1);
  });

  await t.test('actual D1 batch rolls back an accepted check when the state statement fails', async () => {
    await seed(3);
    const lease = await call(0, { action: 'claim', monitorId: 3, slotMs });
    await db.prepare("CREATE TRIGGER synthetic_failure BEFORE INSERT ON monitor_state WHEN NEW.monitor_id=3 BEGIN SELECT RAISE(ABORT,'synthetic rollback'); END").run();
    await assert.rejects(() => workers[0].fetch('http://local-test.invalid/', {
      method: 'POST', body: JSON.stringify({ action: 'commit', lease, result: result() }),
    }), /synthetic rollback/);
    assert.equal((await db.prepare('SELECT count(*) AS n FROM checks WHERE monitor_id=3').first()).n, 0);
    assert.equal(await db.prepare('SELECT * FROM monitor_state WHERE monitor_id=3').first(), null);
  });

  await t.test('actual D1 CAS loser leaves history unchanged', async () => {
    await seed(4);
    const first = await call(0, { action: 'claim', monitorId: 4, slotMs });
    assert.equal(await call(0, { action: 'commit', lease: first, result: result() }), true);
    await call(0, { action: 'release', lease: first });
    const previous = await db.prepare('SELECT * FROM monitor_state WHERE monitor_id=4').first();
    const lease = await call(1, { action: 'claim', monitorId: 4, slotMs: slotMs + 60000 });
    await db.prepare('UPDATE monitor_state SET last_check_slot = ? WHERE monitor_id=4').bind(slotMs + 120000).run();
    assert.equal(await call(1, { action: 'commit', lease, previous, result: result('down') }), false);
    assert.equal((await db.prepare('SELECT count(*) AS n FROM checks WHERE monitor_id=4').first()).n, 1);
    assert.equal((await db.prepare('SELECT last_check_slot FROM monitor_state WHERE monitor_id=4').first()).last_check_slot, slotMs + 120000);
  });

  await t.test('actual D1 cascades a leased monitor deletion and fences its delayed result', async () => {
    await seed(5);
    const lease = await call(0, { action: 'claim', monitorId: 5, slotMs });
    const monitor = await db.prepare('SELECT * FROM monitors WHERE id=5').first();
    await db.batch([
      db.prepare('DELETE FROM checks WHERE monitor_id=5'),
      db.prepare('DELETE FROM monitor_state WHERE monitor_id=5'),
      db.prepare('DELETE FROM monitors WHERE id=5'),
    ]);
    assert.equal(await db.prepare('SELECT * FROM monitor_execution WHERE monitor_id=5').first(), null);
    assert.equal(await call(0, { action: 'commit', lease, monitor, result: result('down') }), false);
    assert.equal((await db.prepare('SELECT count(*) AS n FROM checks WHERE monitor_id=5').first()).n, 0);
  });

  await t.test('actual D1 revision guards reject a late old-route commit and notification reservation', async () => {
    await seed(6);
    const lease = await call(0, { action: 'claim', monitorId: 6, slotMs, configRevision: 1 });
    const oldMonitor = await db.prepare('SELECT * FROM monitors WHERE id=6').first();
    await db.prepare("UPDATE monitors SET config_revision=2,probe_transport='public_fetch' WHERE id=6").run();
    assert.equal(await call(0, { action: 'commit', lease, monitor: oldMonitor, result: result('down') }), false);
    assert.equal(await call(0, { action: 'reserve', lease }), false);
    assert.equal((await db.prepare('SELECT count(*) AS n FROM checks WHERE monitor_id=6').first()).n, 0);
    await call(0, { action: 'release', lease });
    assert.equal(await call(1, { action: 'claim', monitorId: 6, slotMs: slotMs + 60000, configRevision: 1 }), null);
    const current = await call(1, { action: 'claim', monitorId: 6, slotMs: slotMs + 60000, configRevision: 2 });
    assert.ok(current);
    assert.equal(await call(1, { action: 'commit', lease: current, result: result('up') }), true);
    const check = await db.prepare('SELECT config_revision,probe_transport,monitor_role FROM checks WHERE monitor_id=6').first();
    assert.equal(check.config_revision, 2);
    assert.equal(check.probe_transport, 'public_fetch');
    assert.equal(check.monitor_role, 'availability');
    await db.prepare('UPDATE monitors SET config_revision=3 WHERE id=6').run();
    assert.equal(await call(1, { action: 'reserve', lease: current }), false);
    await call(1, { action: 'thread', lease: current, thread: 'late-route-thread' });
    assert.equal((await db.prepare('SELECT slack_alert_ts FROM monitor_state WHERE monitor_id=6').first()).slack_alert_ts, null);
  });

  await t.test('actual D1 permits the next probe while an independent notification lease is live', async () => {
    await seed(7);
    const first = await call(0, { action:'claim', monitorId:7, slotMs });
    assert.equal(await call(0,{action:'commit',lease:first,result:result('down')}),true);
    await call(0,{action:'release',lease:first});
    const second = await call(0,{action:'claim',monitorId:7,slotMs:slotMs+60000});
    assert.equal(await call(0,{action:'commit',lease:second,result:result('down')}),true);
    assert.equal((await db.prepare("SELECT count(*) AS n FROM notification_outbox WHERE monitor_id=7 AND status='pending'").first()).n,1);
    await call(0,{action:'release',lease:second});
    await db.prepare(`INSERT INTO notification_delivery_state(monitor_id,lease_token,lease_until)
      VALUES(7,'notification-owner',CAST(strftime('%s','now') AS INTEGER)*1000+30000)`).run();
    const third = await call(1,{action:'claim',monitorId:7,slotMs:slotMs+120000});
    assert.ok(third);
    assert.equal(await call(1,{action:'commit',lease:third,result:result('up')}),true);
    assert.equal((await db.prepare("SELECT count(*) AS n FROM notification_outbox WHERE monitor_id=7 AND status='pending'").first()).n,2);
    assert.equal((await db.prepare('SELECT current_status FROM monitor_state WHERE monitor_id=7').first()).current_status,'up');
    assert.equal((await db.prepare('SELECT lease_token FROM notification_delivery_state WHERE monitor_id=7').first()).lease_token,'notification-owner');
  });

  await t.test('actual D1 records a missing target decision and preserves the unrounded delivery times',async()=>{
    const decision=await call(0,{action:'claimDecision',monitorId:999,slotMs,
      timing:{scheduledTime:slotMs+52009,receivedAt:slotMs+80000,runId:'local-synthetic-run'}});
    assert.equal(decision.lease,null);assert.equal(decision.attempt.reason,'monitor_missing');
    const audit=await db.prepare('SELECT * FROM monitor_attempts WHERE attempt_id=?').bind(decision.attempt.attempt_id).first();
    assert.equal(audit.scheduled_time,slotMs+52009);assert.equal(audit.received_at,slotMs+80000);
    assert.equal(audit.run_id,'local-synthetic-run');
    assert.equal((await db.prepare('SELECT count(*) AS n FROM checks WHERE monitor_id=999').first()).n,0);
  });

  await t.test('actual D1 outbox failure cannot commit an unnotifiable state transition',async()=>{
    await seed(8);
    const first=await call(0,{action:'claim',monitorId:8,slotMs});
    assert.equal(await call(0,{action:'commit',lease:first,result:result('down')}),true);
    await call(0,{action:'release',lease:first});
    const next=await call(1,{action:'claim',monitorId:8,slotMs:slotMs+60000});
    await db.prepare("CREATE TRIGGER refuse_outbox BEFORE INSERT ON notification_outbox WHEN NEW.monitor_id=8 BEGIN SELECT RAISE(ABORT,'outbox rollback'); END").run();
    await assert.rejects(()=>workers[1].fetch('http://local-test.invalid/',{method:'POST',body:JSON.stringify({action:'commit',lease:next,result:result('down')})}),/outbox rollback/);
    assert.equal((await db.prepare('SELECT count(*) AS n FROM checks WHERE monitor_id=8').first()).n,1);
    assert.equal((await db.prepare('SELECT last_check_slot FROM monitor_state WHERE monitor_id=8').first()).last_check_slot,slotMs);
    assert.equal((await db.prepare('SELECT count(*) AS n FROM notification_outbox WHERE monitor_id=8').first()).n,0);
    assert.equal((await db.prepare('SELECT decision FROM monitor_attempts WHERE attempt_id=?').bind(next.attemptId).first()).decision,'claimed');
  });

  await t.test('actual D1 audit failure cannot roll back the probe unlock',async()=>{
    await seed(9);
    const lease=await call(0,{action:'claim',monitorId:9,slotMs});
    await db.prepare("CREATE TRIGGER reject_release_audit BEFORE UPDATE ON monitor_attempts WHEN NEW.monitor_id=9 AND NEW.released_at IS NOT NULL BEGIN SELECT RAISE(ABORT,'audit failure'); END").run();
    assert.equal(await call(0,{action:'release',lease}),true);
    assert.equal((await db.prepare('SELECT lease_until FROM monitor_execution WHERE monitor_id=9').first()).lease_until,0);
    assert.ok(await call(1,{action:'claim',monitorId:9,slotMs:slotMs+60000}));
  });
});
