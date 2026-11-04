import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url), runtime = createRequire(require.resolve('wrangler/package.json'));
const { Miniflare, convertV4MiniflareOptions, Log, LogLevel } = runtime('miniflare');
const { buildSync } = runtime('esbuild');
const script = buildSync({ entryPoints: [fileURLToPath(new URL('../src/index.ts', import.meta.url))],
  // Worker conditions avoid a dependency's DOM-only browser entrypoint.
  bundle: true, platform: 'neutral', mainFields: ['module', 'main'], conditions: ['workerd', 'worker'],
  format: 'esm', external: ['cloudflare:workers', 'node:*'], write: false }).outputFiles[0].text;

test('actual Worker rejects unsigned Slack traffic before its D1 schema gate and without provider I/O', { timeout: 30000 }, async t => {
  let outbound = 0;
  const mf = new Miniflare(convertV4MiniflareOptions({ script, modules: true, compatibilityDate: '2025-01-01',
    compatibilityFlags: ['nodejs_compat'], bindings: { SLACK_BOT_TOKEN: 'synthetic-token', SLACK_SIGNING_SECRET: 'synthetic-secret' },
    outboundService: async () => { outbound++; return new Response(null, { status: 502 }); },
    log: new Log(LogLevel.ERROR) }));
  t.after(() => mf.dispose());
  assert.equal((await mf.dispatchFetch('https://monitor.invalid/slack/events', { method: 'POST', body: 'unsigned' })).status, 401);
  assert.equal((await mf.dispatchFetch('https://monitor.invalid/slack/events')).status, 405);
  assert.equal((await mf.dispatchFetch('https://monitor.invalid/slack/events', { method: 'POST', body: 'bad',
    headers: { 'x-slack-signature': 'invalid', 'x-slack-request-timestamp': String(Math.floor(Date.now() / 1000)) } })).status, 401);
  assert.equal(outbound, 0);
});
