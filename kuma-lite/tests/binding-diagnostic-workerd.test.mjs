import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const toolchain = createRequire(require.resolve('wrangler/package.json'));
const { Miniflare, convertV4MiniflareOptions } = toolchain('miniflare');
const { build } = toolchain('esbuild');
const directory = fileURLToPath(new URL('../', import.meta.url));
const helperPath = fileURLToPath(new URL('../src/binding-diagnostic.ts', import.meta.url));

// This fixture injects only a test window. The real runner, probe, transitions,
// D1 ownership and native timer globals are bundled unchanged. Production
// source stays OFF; no global timer mocks or network-connected services exist.
async function bundle(cycle, fault = 'none') {
  return (await build({
    stdin: { sourcefile: 'binding-diagnostic-native-fixture.js', resolveDir: directory,
      contents: `import { runChecks } from './src/monitor-runner.ts';
        import { createBindingDiagnostic } from './src/binding-diagnostic.ts';
        console.log = console.info = console.warn = console.error = () => {};
        export default { async fetch(request, env) {
          const action = new URL(request.url).pathname;
          try {
            const now = Date.now();
            if (action === '/native-brand-check') {
              const timer = setTimeout(() => {}, 1000);
              try { ({ clearTimeout }).clearTimeout(timer); return Response.json({ nativeError: null }); }
              catch (error) { return Response.json({ nativeError: error.message }); }
              finally { clearTimeout(timer); }
            }
            if (action === '/run') {
              await runChecks(env, now, { receivedAt: now, runId: 'synthetic-native-run' });
              return Response.json({ ok: true });
            }
            const monitors = (await env.DB.prepare('SELECT * FROM monitors ORDER BY id').all()).results;
            const start = Date.now(), from = Math.floor(start / 60000) * 60000 - 60000;
            const until = action === '/bypass' ? start + 50 : from + 1200000;
            const lane = createBindingDiagnostic(env, monitors, start, start,
              { from: new Date(from).toISOString(), until: new Date(until).toISOString() });
            lane.start(5);
            const waiting = lane.wait(6);
            if (action === '/resume') {
              await new Promise(resolve => setTimeout(resolve, 30));
              lane.finish(5);
            }
            await waiting;
            lane.start(6);
            const timings = lane.timings(6);
            lane.finish(5); lane.finish(6);
            return Response.json({ ok: true, timings });
          } catch (error) {
            return Response.json({ ok: false, error: error instanceof Error ? error.message : 'unknown' });
          }
        } };`,
    }, bundle: true, platform: 'browser', format: 'esm', write: false,
    plugins: [{ name: 'local-diagnostic-window', setup(builder) {
      builder.onResolve({ filter: /^\.\/binding-diagnostic$/ }, args =>
        basename(args.importer) === 'monitor-runner.ts' ? { path: 'window', namespace: 'diagnostic-window' } : undefined);
      builder.onLoad({ filter: /.*/, namespace: 'diagnostic-window' }, () => ({
        loader: 'ts', resolveDir: directory,
        contents: `import { createBindingDiagnostic as realCreate, bindingResponseCompleted } from './src/binding-diagnostic.ts';
          export { bindingResponseCompleted };
          export function createBindingDiagnostic(env, monitors, scheduled, received) {
            const from = Math.floor(scheduled / 60000) * 60000 - ${cycle} * 60000;
            return realCreate(env, monitors, scheduled, received,
              { from: new Date(from).toISOString(), until: new Date(from + 1200000).toISOString() });
          }`,
      }));
      if (fault === 'cleanup' || fault === 'setup') builder.onLoad({ filter: /binding-diagnostic\.ts$/ }, () => ({
        loader: 'ts', contents: fault === 'cleanup'
          ? readFileSync(helperPath, 'utf8').replace('clearTimeout: timer => clearTimeout(timer)', 'clearTimeout')
          : readFileSync(helperPath, 'utf8').replace('setTimeout: (callback, ms) => setTimeout(callback, ms)', "setTimeout: () => { throw Error('synthetic diagnostic timer rejected'); }"),
      }));
      if (fault === 'wait') builder.onLoad({ filter: /monitor-runner\.ts$/ }, args => ({
        loader: 'ts', contents: readFileSync(args.path, 'utf8').replace('await diagnostic.wait(monitor.id);', "await Promise.reject(Error('synthetic diagnostic wait rejected'));"),
      }));
      if (fault === 'probe') builder.onLoad({ filter: /monitor\.ts$/ }, args => ({
        loader: 'ts', contents: readFileSync(args.path, 'utf8').replace("  const { fetcher, transport } = resolveFetcher(env, monitor);", "  if (monitor.id === 5) throw Error('synthetic original probe failure');\n  const { fetcher, transport } = resolveFetcher(env, monitor);"),
      }));
      if (fault === 'state') builder.onLoad({ filter: /monitor-execution\.ts$/ }, args => ({
        loader: 'ts', contents: readFileSync(args.path, 'utf8').replace('export async function readMonitorState(env: Env, monitorId: number): Promise<OrderedMonitorState | null> {', "export async function readMonitorState(env: Env, monitorId: number): Promise<OrderedMonitorState | null> {\n  if (monitorId === 5) throw Error('synthetic original state failure');"),
      }));
    } }],
  })).outputFiles[0].text;
}

const health = { status: 'ok', version: 'synthetic-native', components: [{ name: 'Database', status: 'ok', latency_ms: 82 }] };
const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache, no-store, must-revalidate' };
function targetScript(delay) {
  return `const calls = [];
    export default { async fetch(request) {
      if (new URL(request.url).pathname === '/test-calls') return Response.json(calls);
      const call = { start: Date.now(), end: null }; calls.push(call);
      await new Promise(resolve => setTimeout(resolve, ${delay})); call.end = Date.now();
      return Response.json(${JSON.stringify(health)}, { headers: { ...${JSON.stringify(headers)},
        'X-Monitor-Request-ID': request.headers.get('X-Monitor-Request-ID') } });
    } };`;
}

async function fixture(t, cycle = 1, fault = 'none') {
  let publicCalls = 0, forbiddenOutbound = 0;
  const deny = async () => { forbiddenOutbound++; throw Error('External network is forbidden in this test'); };
  const mf = new Miniflare(convertV4MiniflareOptions({ workers: [
    { name: 'runner', script: await bundle(cycle, fault), modules: true,
      compatibilityDate: '2025-01-01', compatibilityFlags: ['nodejs_compat'],
      d1Databases: { DB: 'fresh-native-diagnostic' }, serviceBindings: { PARTNER_PORTAL: 'portal', CORE_OS: 'core' },
      outboundService: async request => {
        if (!['partner-portal.opus-system.jp', 'core-os.opus-system.jp'].includes(new URL(request.url).hostname)
          || new URL(request.url).pathname !== '/healthz') return deny();
        publicCalls++;
        return Response.json(health, { headers });
      },
    },
    { name: 'portal', script: targetScript(cycle === 3 ? 10 : 180), modules: true, compatibilityDate: '2025-01-01', outboundService: deny },
    { name: 'core', script: targetScript(cycle === 3 ? 180 : 10), modules: true, compatibilityDate: '2025-01-01', outboundService: deny },
  ] }));
  t.after(() => mf.dispose());
  const db = await mf.getD1Database('DB', 'runner');
  const schema = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8');
  await db.batch(schema.replace(/^\s*--.*$/gm, '').split(';').map(value => value.trim()).filter(Boolean).map(sql => db.prepare(sql)));
  for (const id of [5, 6, 9, 10]) {
    const main = id < 9, portal = id === 5 || id === 9;
    await db.prepare(`INSERT INTO monitors(id,name,url,created_at,enabled,method,expected_status,
      service_binding,probe_transport,monitor_role,response_mode,config_revision,interval_minutes,
      timeout_ms,retry_threshold,db_latency_threshold_ms,http_latency_threshold_ms,parent_monitor_id)
      VALUES(?,?,?,0,1,'GET',200,?,?,?,?,?,1,10000,2,1000,NULL,?)`).bind(id, `Native ${id}`,
      `https://${portal ? 'partner-portal' : 'core-os'}.opus-system.jp/healthz`, portal ? 'PARTNER_PORTAL' : 'CORE_OS',
      main ? 'legacy' : 'public_fetch', main ? 'availability' : 'shadow', main ? 'legacy_http' : 'strict_healthz',
      main ? 1 : 3, main ? null : id - 4).run();
  }
  if (fault === 'commit') await db.exec("CREATE TRIGGER original_commit_failure BEFORE INSERT ON checks WHEN NEW.monitor_id=5 BEGIN SELECT RAISE(ABORT,'synthetic original commit failure'); END");
  const worker = await mf.getWorker('runner');
  return { db, mf, counts: () => ({ publicCalls, forbiddenOutbound }),
    call: async action => (await worker.fetch('http://local-test.invalid/' + action)).json() };
}

test('legacy native timers resume the queued target and expiry bypass without receiver errors', async t => {
  const f = await fixture(t);
  const resume = await f.call('resume');
  assert.equal(resume.ok, true, resume.error);
  assert.equal(resume.timings.diagnostic_mode, 'portal_first');
  assert.ok(resume.timings.dispatch_wait_ms >= 20);
  assert.equal(resume.timings.diagnostic_contaminated, false);
  const bypass = await f.call('bypass');
  assert.equal(bypass.ok, true, bypass.error);
  assert.ok(bypass.timings.dispatch_wait_ms >= 30);
  assert.equal(bypass.timings.diagnostic_contaminated, true);
  assert.deepEqual(f.counts(), { publicCalls: 0, forbiddenOutbound: 0 });
});

for (const cycle of [1, 3]) test(`native active runner commits all four targets and releases all owners in cycle${cycle}`, async t => {
  const f = await fixture(t, cycle);
  const response = await f.call('run'); assert.equal(response.ok, true, response.error);
  const checks = (await f.db.prepare('SELECT monitor_id,ts,scheduled_slot,config_revision,probe_transport,status,healthz_status FROM checks ORDER BY monitor_id').all()).results;
  const attempts = (await f.db.prepare('SELECT monitor_id,decision,error_phase,release_outcome,timings_json FROM monitor_attempts ORDER BY monitor_id').all()).results;
  assert.deepEqual(checks.map(value => value.monitor_id), [5, 6, 9, 10]);
  assert.equal(new Set(checks.map(value => value.scheduled_slot)).size, 1);
  assert.deepEqual(checks.map(value => value.probe_transport), ['service_binding', 'service_binding', 'public_fetch', 'public_fetch']);
  assert.deepEqual(checks.map(value => value.config_revision), [1, 1, 3, 3]);
  assert.ok(checks.every(value => value.status === 'up' && value.healthz_status === 'ok'));
  assert.ok(attempts.every(value => value.decision === 'committed' && value.error_phase === null && value.release_outcome === 'released'));
  const first = cycle === 1 ? 5 : 6, second = first === 5 ? 6 : 5;
  const timings = new Map(attempts.map(value => [value.monitor_id, JSON.parse(value.timings_json)]));
  const mode = cycle === 1 ? 'portal_first' : 'core_first';
  assert.ok([...timings.values()].every(value => value.diagnostic_mode === mode && value.diagnostic_contaminated === false));
  assert.equal(timings.get(first).dispatch_wait_ms, 0);
  assert.ok(timings.get(second).dispatch_wait_ms >= 100);
  assert.ok(timings.get(second).received_to_probe_ms >= timings.get(second).dispatch_wait_ms);
  assert.ok(timings.get(second).probe_ms < timings.get(second).dispatch_wait_ms, 'queue time must not become probe time');
  const firstCheck = checks.find(value => value.monitor_id === first), secondCheck = checks.find(value => value.monitor_id === second);
  assert.ok(firstCheck.ts + timings.get(first).probe_ms <= secondCheck.ts);
  assert.equal((await f.db.prepare('SELECT count(*) n FROM monitor_execution WHERE lease_until<>0').first()).n, 0);
  assert.equal((await f.db.prepare('SELECT count(*) n FROM notification_outbox').first()).n, 0);
  assert.deepEqual(f.counts(), { publicCalls: 2, forbiddenOutbound: 0 });
  for (const target of ['portal', 'core']) {
    const calls = await (await (await f.mf.getWorker(target)).fetch('http://local-test.invalid/test-calls')).json();
    assert.equal(calls.length, 1);
  }
});

test('old native receiver behavior is exercised without leaking diagnostic errors into probes', async t => {
  const f = await fixture(t, 1, 'cleanup');
  const brand = await f.call('native-brand-check'); assert.match(brand.nativeError, /Illegal invocation/);
  const response = await f.call('run'); assert.equal(response.ok, true, response.error);
  assert.equal((await f.db.prepare('SELECT count(*) n FROM checks').first()).n, 4);
  assert.equal((await f.db.prepare("SELECT count(*) n FROM monitor_attempts WHERE decision='error'").first()).n, 0);
  const main = (await f.db.prepare('SELECT timings_json FROM monitor_attempts WHERE monitor_id IN(5,6)').all()).results;
  assert.ok(main.every(value => JSON.parse(value.timings_json).diagnostic_contaminated === true));
  assert.equal((await f.db.prepare('SELECT count(*) n FROM monitor_execution WHERE lease_until<>0').first()).n, 0);
  assert.deepEqual(f.counts(), { publicCalls: 2, forbiddenOutbound: 0 });
});

for (const fault of ['setup', 'wait']) test(`diagnostic ${fault} failure keeps all four native observations`, async t => {
  const f = await fixture(t, 1, fault);
  const response = await f.call('run'); assert.equal(response.ok, true, response.error);
  assert.equal((await f.db.prepare('SELECT count(*) n FROM checks').first()).n, 4);
  assert.equal((await f.db.prepare("SELECT count(*) n FROM monitor_attempts WHERE decision='committed' AND error_phase IS NULL").first()).n, 4);
  const main = (await f.db.prepare('SELECT timings_json FROM monitor_attempts WHERE monitor_id IN(5,6)').all()).results;
  assert.ok(main.every(value => JSON.parse(value.timings_json).diagnostic_contaminated === true));
  assert.equal((await f.db.prepare('SELECT count(*) n FROM monitor_execution WHERE lease_until<>0').first()).n, 0);
  assert.deepEqual(f.counts(), { publicCalls: 2, forbiddenOutbound: 0 });
});

for (const fault of ['state', 'probe', 'commit']) test(`original ${fault} failure still propagates while the native successor proceeds`, async t => {
  const f = await fixture(t, 1, fault);
  const response = await f.call('run'); assert.equal(response.ok, false); assert.match(response.error, new RegExp('synthetic original ' + fault + ' failure'));
  const checks = (await f.db.prepare('SELECT monitor_id FROM checks ORDER BY monitor_id').all()).results;
  assert.deepEqual(checks.map(value => value.monitor_id), [6, 9, 10]);
  const failed = (await f.db.prepare("SELECT monitor_id,error_phase,release_outcome FROM monitor_attempts WHERE decision='error'").all()).results;
  assert.equal(failed.length, 1); assert.equal(failed[0].monitor_id, 5); assert.equal(failed[0].error_phase, fault);
  assert.equal(failed[0].release_outcome, 'released');
  assert.equal((await f.db.prepare('SELECT count(*) n FROM monitor_execution WHERE lease_until<>0').first()).n, 0);
  assert.equal(f.counts().forbiddenOutbound, 0);
});
