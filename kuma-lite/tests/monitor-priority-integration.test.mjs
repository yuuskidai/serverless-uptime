import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { webcrypto } from 'node:crypto';
import ts from 'typescript';
import { root, result } from './helpers.mjs';

// The handler, runner, transition logic and D1 transactions are real. A local
// clock and synthetic schema/probe/notification I/O make overlapping Cron
// deliveries deterministic; this does not reproduce Cloudflare dispatch.
const SLOT = Date.parse('2026-10-27T05:38:00Z');
const RAW = SLOT + 52_009;
const IDS = [5, 6, 9, 10];

class Clock {
  now = RAW;
  sequence = 0;
  timers = [];

  setTimeout = (callback, delay = 0) => {
    const id = ++this.sequence;
    this.timers.push({ id, at: this.now + Math.max(0, delay), callback });
    return id;
  };
  clearTimeout = id => { this.timers = this.timers.filter(timer => timer.id !== id); };
  sleep = delay => new Promise(resolve => this.setTimeout(resolve, delay));
  at(at, callback) { this.timers.push({ id: ++this.sequence, at, callback }); }

  async drive(done) {
    for (let step = 0; step < 15_000; step++) {
      // Drain complete promise chains before advancing to the next timer.
      for (let turn = 0; turn < 250; turn++) await Promise.resolve();
      if (done()) return;
      this.timers.sort((left, right) => left.at - right.at || left.id - right.id);
      const timer = this.timers.shift();
      assert.ok(timer, 'an invocation did not settle and has no pending timer');
      this.now = timer.at;
      timer.callback();
    }
    assert.fail('the bounded local scheduler did not settle');
  }
}

function harness() {
  const clock = new Clock();
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys=ON');
  sqlite.exec(readFileSync(new URL('schema.sql', root), 'utf8'));
  sqlite.function('strftime', { varargs: true }, () => String(Math.floor(clock.now / 1000)));
  const insert = sqlite.prepare(`INSERT INTO monitors
    (id,name,url,created_at,timeout_ms,retry_threshold,interval_minutes,db_latency_threshold_ms,
     monitor_role,probe_transport,response_mode,parent_monitor_id,config_revision)
    VALUES (?,?,?,0,10000,2,1,1000,?,?,?,?,?)`);
  for (const id of IDS) {
    const shadow = id >= 9;
    insert.run(id, `Local ${id}`, `https://example.invalid/${id}`, shadow ? 'shadow' : 'availability',
      shadow ? 'public_fetch' : 'legacy', shadow ? 'strict_healthz' : 'legacy_http',
      shadow ? id - 4 : null, shadow ? 3 : 1);
  }
  const events = [], notifications = [], logs = [], invocations = [];

  function database(config) {
    const wrap = (query, args = []) => ({
      query, args,
      bind(...next) { return wrap(query, next); },
      async first() {
        await clock.sleep(/^SELECT \* FROM monitor_state WHERE/.test(query) ? 313 : 0);
        return sqlite.prepare(query).get(...args) ?? null;
      },
      async all() {
        await clock.sleep(query.includes('SELECT * FROM monitors WHERE enabled') ? config.selectMs : 0);
        return { results: sqlite.prepare(query).all(...args), success: true };
      },
      async run() { await clock.sleep(0); return this.executeSync(); },
      executeSync() {
        const statement = sqlite.prepare(query);
        const rows = statement.columns().length ? statement.all(...args) : (statement.run(...args), []);
        const info = sqlite.prepare('SELECT changes() AS changes,last_insert_rowid() AS last_row_id').get();
        return { success: true, results: rows, meta: {
          changes: /^\s*(SELECT|PRAGMA|EXPLAIN)\b/i.test(query) ? 0 : Number(info.changes),
          last_row_id: Number(info.last_row_id),
        } };
      },
    });
    return { prepare: wrap, async batch(statements) {
      const claim = statements.some(statement => statement.query.includes('WITH requested AS'));
      const commit = statements.some(statement => statement.query.includes('INSERT INTO checks'));
      await clock.sleep(claim ? config.claimMs : 306);
      sqlite.exec('BEGIN IMMEDIATE');
      let writes;
      try {
        writes = statements.map(statement => statement.executeSync());
        sqlite.exec('COMMIT');
      } catch (error) { sqlite.exec('ROLLBACK'); throw error; }
      if (claim) {
        const decision = writes.at(-1).results[0];
        const id = statements[0].args[0];
        events.push({ kind: 'claim', invocation: config.name, id, at: clock.now,
          decision: decision.decision, reason: decision.reason });
        if (config.loseClaimAck && decision.decision === 'claimed') throw Error('claim acknowledgement lost');
      }
      if (commit && config.loseCommitAck) throw Error('commit acknowledgement lost');
      return writes;
    } };
  }

  function worker(config) {
    const cache = new Map();
    function load(name) {
      if (cache.has(name)) return cache.get(name).exports;
      const module = { exports: {} };
      cache.set(name, module);
      const source = readFileSync(new URL(`src/${name}.ts`, root), 'utf8');
      const output = ts.transpileModule(source, { compilerOptions: {
        module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
      } }).outputText;
      class LocalDate extends Date {
        constructor(...args) { super(...(args.length ? args : [clock.now])); }
        static now() { return clock.now; }
      }
      const unused = Object.fromEntries(['api', 'edge-cache', 'incident-page', 'rca', 'rss-feed',
        'status-page', 'slack-bot', 'monitor-readiness', 'external-observations',
        'security-notifications-entrypoint'].map(id => [`./${id}`, {}]));
      const overrides = {
        ...unused,
        './schema-gate': {
          async ensureSchema() { await clock.sleep(config.schemaMs); return { ok: true }; },
          logSchemaProblem() {},
        },
        './monitor': { async performCheck(_env, monitor) {
          events.push({ kind: 'probe', invocation: config.name, id: monitor.id, at: clock.now });
          await clock.sleep(config.probeMs);
          return result(config.outcome);
        } },
        './state-notifications': { async notifyTransition(_env, monitor, _result, transition) {
          const lease = sqlite.prepare('SELECT lease_until FROM monitor_execution WHERE monitor_id=?').get(monitor.id);
          assert.equal(lease.lease_until, 0, 'notification dispatch must follow probe-lease release');
          notifications.push({ id: monitor.id, kind: transition.kind });
          return { slackAlertTs: 'local-thread' };
        } },
      };
      runInNewContext(output, {
        module, exports: module.exports, crypto: webcrypto, Date: LocalDate, Error,
        Response, Request, URL, AbortController, TextEncoder, TextDecoder, Uint8Array, atob, btoa,
        performance: { now: () => clock.now },
        setTimeout(callback, delay) {
          if (name === 'monitor-runner' && config.failOffsetTimer && delay > 0 && delay <= 5000) {
            throw Error('offset timer unavailable');
          }
          return clock.setTimeout(callback, delay);
        },
        clearTimeout: clock.clearTimeout,
        console: { error: entry => logs.push(entry), log: entry => logs.push(entry), warn() {}, info() {} },
        require(id) {
          if (Object.hasOwn(overrides, id)) return overrides[id];
          assert.ok(id.startsWith('./'), `unexpected dependency ${id}`);
          return load(id.slice(2));
        },
      }, { filename: name, timeout: 5000 });
      return module.exports;
    }
    return load('index').default;
  }

  function launch(name, at, scheduledTime, options = {}) {
    const config = { name, schemaMs: 244, selectMs: 214, claimMs: 582,
      probeMs: 10_000, outcome: 'down', ...options };
    const invocation = { name, settled: false, error: null };
    invocations.push(invocation);
    clock.at(at, () => {
      const pending = [];
      worker(config).scheduled({ cron: '* * * * *', scheduledTime }, { DB: database(config) }, {
        waitUntil(task) { pending.push(task); },
      }).then(() => Promise.all(pending)).then(
        () => { invocation.settled = true; },
        error => { invocation.settled = true; invocation.error = error; },
      );
    });
    return invocation;
  }
  const read = sql => sqlite.prepare(sql).all().map(row => ({ ...row }));
  return { clock, sqlite, events, notifications, logs, launch, read,
    async finish() { await clock.drive(() => invocations.every(invocation => invocation.settled)); },
    successful() { assert.deepEqual(invocations.filter(invocation => invocation.error).map(x => x.error.message), []); },
    close() { sqlite.close(); },
  };
}

function released(h) {
  assert.ok(h.read('SELECT lease_until FROM monitor_execution').every(row => row.lease_until === 0));
  assert.ok(h.read('SELECT lease_until FROM notification_delivery_state').every(row => row.lease_until === 0));
}

test('four newer monitor slots reserve before waiting and reject a later obsolete delivery', async () => {
  const h = harness();
  try {
    h.launch('new', RAW + 637, RAW);
    h.launch('old', RAW + 2231, RAW - 60_000, { schemaMs: 223, selectMs: 475 });
    await h.finish(); h.successful();
    assert.deepEqual(h.read('SELECT monitor_id,scheduled_slot FROM checks ORDER BY monitor_id'),
      IDS.map(monitor_id => ({ monitor_id, scheduled_slot: SLOT })));
    assert.equal(h.read("SELECT * FROM monitor_attempts WHERE reason='superseded_slot'").length, 4);
    assert.ok(h.events.filter(event => event.kind === 'probe').every(event => event.invocation === 'new' && event.at >= RAW + 5000));
    assert.deepEqual(h.notifications, []);
    const timings = h.read("SELECT timings_json FROM monitor_attempts WHERE decision='committed'").map(x => JSON.parse(x.timings_json));
    assert.ok(timings.every(x => x.received_to_claim_ms < x.offset_wait_ms && x.offset_wait_ms > 0));
    released(h);
  } finally { h.close(); }
});

test('a newer delivery never steals the four already active older owners', async () => {
  const h = harness();
  try {
    h.launch('old', RAW - 2009, RAW - 60_000);
    h.launch('new', RAW + 637, RAW);
    await h.finish(); h.successful();
    assert.deepEqual(h.read('SELECT monitor_id,scheduled_slot FROM checks ORDER BY monitor_id'),
      IDS.map(monitor_id => ({ monitor_id, scheduled_slot: SLOT - 60_000 })));
    assert.equal(h.read("SELECT * FROM monitor_attempts WHERE reason='lease_busy'").length, 4);
    assert.ok(h.events.filter(event => event.kind === 'probe').every(event => event.invocation === 'old'));
    released(h);
  } finally { h.close(); }
});

test('a slow claim consumes the original offset rather than adding another five seconds', async () => {
  const h = harness();
  try {
    h.launch('slow', RAW + 637, RAW, { claimMs: 5800 });
    await h.finish(); h.successful();
    for (const probe of h.events.filter(event => event.kind === 'probe')) {
      const claim = h.events.find(event => event.kind === 'claim' && event.id === probe.id);
      assert.equal(probe.at - claim.at, 313, 'only the state read remains after a late claim');
    }
    const rows = h.read('SELECT claimed_at,timings_json FROM monitor_attempts');
    assert.ok(rows.every(row => JSON.parse(row.timings_json).offset_wait_ms === 0));
    released(h);
  } finally { h.close(); }
});

test('an offset failure releases all four owners, identifies offset, and leaves the next slot usable', async () => {
  const h = harness();
  try {
    const failed = h.launch('failed-offset', RAW + 637, RAW, { failOffsetTimer: true });
    h.launch('following', RAW + 60_637, RAW + 60_000, { outcome: 'up', probeMs: 200 });
    await h.finish();
    assert.match(failed.error?.message ?? '', /offset timer unavailable/);
    const failures = h.read("SELECT error_phase,release_outcome FROM monitor_attempts WHERE decision='error'");
    assert.equal(failures.length, 4);
    assert.ok(failures.every(row => row.error_phase === 'offset' && row.release_outcome === 'released'));
    assert.equal(h.events.filter(event => event.kind === 'probe' && event.invocation === 'failed-offset').length, 0);
    assert.deepEqual(h.read('SELECT monitor_id,scheduled_slot FROM checks ORDER BY monitor_id'),
      IDS.map(monitor_id => ({ monitor_id, scheduled_slot: SLOT + 60_000 })));
    released(h);
  } finally { h.close(); }
});

test('an unknown claim acknowledgement is not retried or guessed released before expiry', async () => {
  const h = harness();
  try {
    const lost = h.launch('lost-claim', RAW + 637, RAW, { loseClaimAck: true });
    h.launch('duplicate', RAW + 10_000, RAW);
    h.clock.at(RAW + 30_000, () => {
      assert.equal(h.read('SELECT * FROM checks').length, 0);
      assert.equal(h.events.filter(event => event.kind === 'probe').length, 0);
      assert.ok(h.read('SELECT lease_until FROM monitor_execution').every(row => row.lease_until > h.clock.now),
        'the caller must not guess which unacknowledged owners can be released');
      assert.equal(h.read("SELECT * FROM monitor_attempts WHERE reason='superseded_slot'").length, 4);
    });
    h.launch('after-expiry', RAW + 180_637, RAW + 180_000, { outcome: 'up', probeMs: 200 });
    await h.finish();
    assert.match(lost.error?.message ?? '', /claim acknowledgement lost/);
    assert.equal(h.events.filter(event => event.kind === 'claim').length, 12, 'one transaction per monitor and invocation');
    assert.equal(h.read("SELECT * FROM monitor_attempts WHERE decision='claimed'").length, 4, 'unacknowledged ownership remains evidence');
    assert.equal(h.read("SELECT * FROM monitor_attempts WHERE decision='denied' AND reason='superseded_slot'").length, 4);
    assert.ok(h.events.filter(event => event.kind === 'probe').every(event => event.invocation === 'after-expiry'));
    assert.deepEqual(h.read('SELECT monitor_id,scheduled_slot FROM checks ORDER BY monitor_id'),
      IDS.map(monitor_id => ({ monitor_id, scheduled_slot: SLOT + 180_000 })));
    released(h);
  } finally { h.close(); }
});

test('unknown commit acknowledgements preserve accepted checks and dispatch one alert per availability monitor', async () => {
  const h = harness();
  try {
    h.launch('first-failure', RAW + 637, RAW);
    const lost = h.launch('second-failure', RAW + 60_637, RAW + 60_000, { loseCommitAck: true });
    h.launch('duplicate-second', RAW + 80_000, RAW + 60_000);
    await h.finish();
    assert.match(lost.error?.message ?? '', /commit acknowledgement lost/);
    assert.equal(h.read('SELECT * FROM checks').length, 8);
    assert.ok(h.read('SELECT consecutive_failures FROM monitor_state').every(row => row.consecutive_failures === 2));
    assert.deepEqual(h.read('SELECT monitor_id,kind,status FROM notification_outbox ORDER BY monitor_id'),
      [5, 6].map(monitor_id => ({ monitor_id, kind: 'down', status: 'sent' })));
    assert.deepEqual(h.notifications.sort((a, b) => a.id - b.id), [{ id: 5, kind: 'down' }, { id: 6, kind: 'down' }]);
    assert.equal(h.events.filter(event => event.kind === 'probe').length, 8, 'same-slot duplicate must not probe again');
    released(h);
  } finally { h.close(); }
});

test('a revision change while waiting cannot append the stale check or enqueue its alert', async () => {
  const h = harness();
  try {
    h.launch('first-failure', RAW - 59_363, RAW - 60_000);
    h.launch('second-failure', RAW + 637, RAW);
    h.clock.at(RAW + 2500, () => {
      assert.equal(h.read(`SELECT * FROM monitor_attempts
        WHERE monitor_id=5 AND decision='claimed' AND scheduled_slot=${SLOT}`).length, 1);
      h.sqlite.exec('UPDATE monitors SET config_revision=2 WHERE id=5');
    });
    await h.finish(); h.successful();
    assert.equal(h.read('SELECT * FROM checks').length, 7);
    assert.deepEqual(h.read('SELECT scheduled_slot FROM checks WHERE monitor_id=5'),
      [{ scheduled_slot: SLOT - 60_000 }]);
    assert.equal(h.read("SELECT * FROM monitor_attempts WHERE monitor_id=5 AND reason='configuration_changed'").length, 1);
    assert.deepEqual(h.read('SELECT monitor_id,kind,status FROM notification_outbox ORDER BY monitor_id'),
      [{ monitor_id: 6, kind: 'down', status: 'sent' }]);
    assert.deepEqual(h.notifications, [{ id: 6, kind: 'down' }]);
    released(h);
  } finally { h.close(); }
});

test('notification ownership cannot block new probe ownership or bypass the two-failure threshold', async () => {
  const h = harness();
  try {
    const expires = RAW + 120_000;
    for (const id of [5, 6]) h.sqlite.prepare(`INSERT INTO notification_delivery_state
      (monitor_id,lease_token,lease_until) VALUES (?, 'synthetic-delivery-owner', ?)`).run(id, expires);
    h.launch('first-failure', RAW + 637, RAW);
    h.clock.at(RAW + 30_000, () => {
      assert.equal(h.read('SELECT * FROM checks').length, 4);
      assert.equal(h.read('SELECT * FROM notification_outbox').length, 0);
      assert.deepEqual(h.notifications, []);
    });
    h.launch('second-failure', RAW + 60_637, RAW + 60_000);
    await h.finish(); h.successful();
    assert.equal(h.read('SELECT * FROM checks').length, 8);
    assert.deepEqual(h.read('SELECT monitor_id,kind,status FROM notification_outbox ORDER BY monitor_id'),
      [5, 6].map(monitor_id => ({ monitor_id, kind: 'down', status: 'pending' })));
    assert.deepEqual(h.notifications, []);
    assert.ok(h.read('SELECT lease_until FROM monitor_execution').every(row => row.lease_until === 0));
    assert.ok(h.read('SELECT lease_until FROM notification_delivery_state WHERE monitor_id IN(5,6)').every(row => row.lease_until === expires));
  } finally { h.close(); }
});
