import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(new URL('../../kuma-lite/package.json', import.meta.url));
const wranglerRequire = createRequire(require.resolve('wrangler/package.json'));
const { build } = wranglerRequire('esbuild');
const bundle = await build({
  entryPoints: [fileURLToPath(new URL('../src/scheduler.ts', import.meta.url))],
  bundle: true, format: 'esm', platform: 'browser', write: false,
  plugins: [{ name: 'local-storage-clock-fixture', setup(builder) {
    builder.onResolve({ filter: /^cloudflare:workers$/ }, () => ({ path: 'fixture', namespace: 'local-durable-base' }));
    builder.onLoad({ filter: /.*/, namespace: 'local-durable-base' }, () => ({ contents:
      'export class DurableObject { constructor(ctx,env) { this.ctx=ctx; this.env=env; } }' }));
  } }],
});
const { ProbeScheduler } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);

test('status and compact latest include storage wait in their actual freshness decision', async t => {
  const realNow = Date.now;
  let clock = 1_800_000_000_000;
  Date.now = () => clock;
  t.after(() => { Date.now = realNow; });
  for (const route of ['/status', '/latest']) {
    const beforeStorage = clock;
    const started = beforeStorage - 149_000;
    const history = [{ slot: started, generation: 1, attempt_id: 'local-clock-attempt',
      alarm_received_at: started, alarm_lateness_ms: 0, alarm_retry_count: 0,
      phase: 'completed', completed_at: started + 10,
      probe_started_at: started, probe_finished_at: started + 10,
      version: { id: null, tag: null, timestamp: null },
      targets: ['portal', 'core'].map(target => ({ target, status: 'ok', observed_at: started,
        finished_at: started + 10, http_status: 200, total_ms: 10, database_ms: 1,
        failure: null, request_id: null, response_request_id: null, healthz_version: null })),
    }];
    const data = { control: { enabled: true, generation: 1, next_slot: clock + 60_000,
      last_claimed_slot: started, active: null }, history };
    const storage = { async transaction(callback) {
      const result = await callback({ async get(key) { return data[key]; } });
      // The snapshot was ready, but the storage await resumes after freshness expires.
      clock += 2_000;
      return result;
    } };
    const object = new ProbeScheduler({ storage }, {});
    const payload = await (await object.fetch(new Request(`https://local.invalid${route}`))).json();
    assert.equal(payload.age_ms, 151_000);
    if (route === '/status') {
      assert.equal(payload.observed_at, beforeStorage + 2_000);
      assert.equal(payload.status, 'unknown'); assert.equal(payload.fresh, false);
    } else {
      assert.equal(payload.readiness.status, 'unknown');
      assert.equal(payload.observed_at, null); assert.equal(payload.finished_at, null);
    }
    assert.ok((payload.targets ?? payload.results).every(target => target.status === 'unknown'));
  }
});
