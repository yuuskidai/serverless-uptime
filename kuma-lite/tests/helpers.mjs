import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { webcrypto } from 'node:crypto';
import ts from 'typescript';

const require = createRequire(import.meta.url);
export const root = new URL('../', import.meta.url);

export function loadTs(file, overrides = {}) {
  const source = readFileSync(new URL(`src/${file}.ts`, root), 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} };
  runInNewContext(output, {
    module, exports: module.exports, crypto: webcrypto, Date, Error, Response,
    console: { error() {}, warn() {}, log() {} },
    setTimeout, clearTimeout,
    require(id) {
      if (Object.hasOwn(overrides, id)) return overrides[id];
      if (id.startsWith('./')) return loadTs(id.slice(2), overrides);
      return require(id);
    },
  }, { filename: file, timeout: 5000 });
  return module.exports;
}

/** Real SQLite statements/transactions behind the small async D1 interface. */
export function sqliteEnv() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON');
  sqlite.exec(readFileSync(new URL('schema.sql', root), 'utf8'));
  const hooks = {};
  const wrap = (query, args = []) => ({
    bind(...next) { return wrap(query, next); },
    async first() { return sqlite.prepare(query).get(...args) ?? null; },
    async all() { return { results: sqlite.prepare(query).all(...args), success: true }; },
    async run() {
      const info = sqlite.prepare(query).run(...args);
      return { success: true, meta: { changes: Number(info.changes) } };
    },
    query, args,
  });
  const env = { DB: {
    prepare: wrap,
    async batch(statements) {
      sqlite.exec('BEGIN IMMEDIATE');
      try {
        const out = [];
        for (let i = 0; i < statements.length; i++) {
          hooks.beforeBatchStatement?.(i);
          out.push(await statements[i].run());
        }
        sqlite.exec('COMMIT');
        return out;
      } catch (err) {
        sqlite.exec('ROLLBACK');
        throw err;
      }
    },
  } };
  sqlite.prepare("INSERT INTO monitors (id,name,url,created_at) VALUES (1,'Synthetic monitor','https://example.invalid/healthz',0)").run();
  const monitor = sqlite.prepare('SELECT * FROM monitors WHERE id = 1').get();
  return { env, sqlite, monitor, hooks, close() { sqlite.close(); } };
}

export const result = (state = 'up') => ({
  status: state === 'down' ? 'down' : 'up', status_code: state === 'down' ? null : 200,
  latency_ms: state === 'down' ? 10000 : 200, error: state === 'down' ? 'Timeout after 10000ms' : null,
  healthz_status: state === 'up' ? 'ok' : state, healthz_reason: null,
  healthz_components: null, healthz_version: 'synthetic', used_fallback: false,
  maintenance: null, probe_trace_json: '[]',
});
