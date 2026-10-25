import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { loadTs, sqliteEnv } from './helpers.mjs';

function gateWithClock(now, logs) {
  const source = readFileSync(new URL('../src/schema-gate.ts', import.meta.url), 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} };
  runInNewContext(output, {
    module, exports: module.exports, performance: { now }, setTimeout, clearTimeout,
    console: { error: entry => logs.push(entry) }, Response,
  }, { filename: 'schema-gate', timeout: 5000 });
  return module.exports;
}

function interceptReads(env, read) {
  const prepare = env.DB.prepare;
  const calls = [];
  env.DB.prepare = query => {
    assert.match(query, /^PRAGMA table_info\([a-z_]+\)$/);
    const statement = prepare(query);
    return {
      ...statement,
      async all() {
        calls.push(query);
        return read(query, statement);
      },
    };
  };
  return calls;
}

test('the total cold schema read budget bounds a stalled PRAGMA without retrying any table', async () => {
  const f = sqliteEnv();
  try {
    const calls = interceptReads(f.env, (query, statement) => query.includes('(monitor_execution)')
      ? new Promise(() => {}) : statement.all());
    const gate = loadTs('schema-gate');
    const started = Date.now();
    const check = await Promise.race([
      gate.ensureSchema(f.env, 20),
      new Promise((_, reject) => setTimeout(() => reject(Error('schema deadline did not finish')), 500)),
    ]);
    assert.equal(check.ok, false);
    assert.equal(check.reason, 'schema_timeout');
    assert.deepEqual(Array.from(check.missing), []);
    assert.ok(Date.now() - started < 500);
    assert.equal(calls.length, new Set(calls).size);
    assert.ok(calls.length > 1);
    assert.equal(gate.SCHEMA_READ_BUDGET_MS, 5000);
  } finally { f.close(); }
});

test('a healthy PRAGMA result arriving after timeout cannot populate the positive cache', async () => {
  const f = sqliteEnv();
  try {
    let release;
    const held = new Promise(resolve => { release = resolve; });
    let delay = true;
    const calls = interceptReads(f.env, async (_query, statement) => {
      const snapshot = await statement.all();
      if (delay) await held;
      return snapshot;
    });
    const gate = loadTs('schema-gate');
    assert.equal((await gate.ensureSchema(f.env, 10)).reason, 'schema_timeout');
    const firstReads = calls.length;
    delay = false;
    release();
    await new Promise(resolve => setTimeout(resolve, 10));
    f.sqlite.exec('ALTER TABLE monitor_execution RENAME TO missing_execution');
    const missing = await gate.ensureSchema(f.env, 100);
    assert.equal(missing.ok, false);
    assert.equal(missing.reason, 'schema_missing');
    assert.ok(missing.missing.includes('monitor_execution.lease_token'));
    assert.equal(calls.length, firstReads * 2);
    f.sqlite.exec('ALTER TABLE missing_execution RENAME TO monitor_execution');
    assert.equal((await gate.ensureSchema(f.env, 100)).ok, true);
    const recoveredReads = calls.length;
    assert.equal((await gate.ensureSchema(f.env, 1)).ok, true);
    assert.equal(calls.length, recoveredReads);
  } finally { f.close(); }
});

test('an overdue timer cannot let a late healthy I/O result pass or populate the positive cache', async () => {
  for (const elapsed of [5000, 5001]) {
    const f = sqliteEnv();
    try {
      let now = 0;
      let late = true;
      const logs = [];
      const calls = interceptReads(f.env, async (_query, statement) => {
        const snapshot = await statement.all();
        if (late) now = elapsed;
        return snapshot;
      });
      const gate = gateWithClock(() => now, logs);
      const check = await gate.ensureSchema(f.env);
      assert.equal(check.ok, false);
      assert.equal(check.reason, 'schema_timeout');
      assert.deepEqual(Array.from(check.missing), []);
      assert.equal(logs.length, 1);
      assert.equal(logs[0].event, 'schema_gate_timeout');
      assert.equal(logs[0].elapsed_ms, elapsed);
      assert.equal(logs[0].budget_ms, 5000);
      const firstReads = calls.length;
      late = false;
      f.sqlite.exec('ALTER TABLE monitor_execution RENAME TO missing_execution');
      const missing = await gate.ensureSchema(f.env);
      assert.equal(missing.reason, 'schema_missing');
      assert.equal(calls.length, firstReads * 2);
      f.sqlite.exec('ALTER TABLE missing_execution RENAME TO monitor_execution');
      assert.equal((await gate.ensureSchema(f.env)).ok, true);
      const recoveredReads = calls.length;
      assert.equal((await gate.ensureSchema(f.env)).ok, true);
      assert.equal(calls.length, recoveredReads);
    } finally { f.close(); }
  }
});

test('a read failure is unavailable rather than a missing migration and a later invocation recovers', async () => {
  const f = sqliteEnv();
  try {
    let unavailable = true;
    const calls = interceptReads(f.env, (query, statement) => {
      if (unavailable && query.includes('(monitor_execution)')) throw Error('synthetic D1 read failure');
      return statement.all();
    });
    const gate = loadTs('schema-gate');
    const check = await gate.ensureSchema(f.env, 100);
    assert.equal(check.ok, false);
    assert.equal(check.reason, 'schema_unavailable');
    assert.deepEqual(Array.from(check.missing), []);
    assert.equal(calls.length, new Set(calls).size);
    unavailable = false;
    assert.equal((await gate.ensureSchema(f.env, 100)).ok, true);
    const recoveredReads = calls.length;
    assert.equal((await gate.ensureSchema(f.env, 1)).ok, true);
    assert.equal(calls.length, recoveredReads);
  } finally { f.close(); }
});

test('missing columns remain distinct from deadline failures and are checked again after migration', async () => {
  const f = sqliteEnv();
  try {
    f.sqlite.exec('ALTER TABLE monitor_runs RENAME TO missing_runs');
    const gate = loadTs('schema-gate');
    const check = await gate.ensureSchema(f.env, 100);
    assert.equal(check.ok, false);
    assert.equal(check.reason, 'schema_missing');
    assert.ok(check.missing.includes('monitor_runs.run_id'));
    f.sqlite.exec('ALTER TABLE missing_runs RENAME TO monitor_runs');
    assert.equal((await gate.ensureSchema(f.env, 100)).ok, true);
  } finally { f.close(); }
});

test('public schema failure responses preserve their generic 503 bodies', async () => {
  const gate = loadTs('schema-gate');
  const html = gate.publicSchemaErrorResponse();
  const json = gate.apiSchemaErrorResponse();
  assert.equal(html.status, 503);
  assert.equal(json.status, 503);
  assert.doesNotMatch(await html.text(), /schema_timeout|schema_unavailable|monitor_execution/);
  assert.deepEqual(await json.json(), { error: 'service_temporarily_unavailable' });
});
