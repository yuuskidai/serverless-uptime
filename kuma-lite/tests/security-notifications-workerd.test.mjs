import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const wranglerRequire = createRequire(require.resolve('wrangler/package.json'));
const { Miniflare, convertV4MiniflareOptions } = wranglerRequire('miniflare');
const { buildSync } = wranglerRequire('esbuild');
const bundle = buildSync({ stdin: {
  contents: `export { SecurityNotifications } from './src/security-notifications-entrypoint.ts';
    export default { fetch() { return new Response('Not found', {status:404}); } };`,
  resolveDir: fileURLToPath(new URL('../', import.meta.url)), sourcefile: 'security-notifications-fixture.js',
}, bundle: true, format: 'esm', platform: 'browser', external: ['cloudflare:workers'], write: false }).outputFiles[0].text;

test('real workerd grants Slack delivery only through the named binding and keeps input out of public fetch', async t => {
  const calls = [];
  const channel = 'C0123456789';
  const mf = new Miniflare(convertV4MiniflareOptions({ workers: [{
    name: 'bridge', script: bundle, modules: true, compatibilityDate: '2025-01-01',
    bindings: { SLACK_BOT_TOKEN: 'synthetic-local-token', SLACK_DEFAULT_CHANNEL: channel },
    outboundService: async request => {
      calls.push({ url: request.url, body: await request.json() });
      return Response.json({ ok: true, ts: '1793000000.123456', channel });
    },
  }, {
    name: 'caller', modules: true, compatibilityDate: '2025-01-01',
    serviceBindings: { SLACK_NOTIFIER: { name: 'bridge', entrypoint: 'SecurityNotifications' } },
    // Test-only trusted caller. This HTTP surface is never deployed.
    script: `export default { async fetch(request, env) {
      return Response.json(await env.SLACK_NOTIFIER.sendSecurityAlert(await request.json()));
    } };`,
  }] }));
  t.after(() => mf.dispose());
  const now = Date.now();
  const alert = { version: 1, id: '17818655-47b9-443e-8543-a768f3941310', source: 'core',
    kind: 'account_locked', severity: 'warning', occurredAt: now, windowStart: now - 300000, windowEnd: now,
    count: 1, host: 'core-os.opus-system.jp', subjectHash: 'a'.repeat(64) };
  const bridge = await mf.getWorker('bridge');
  for (const path of ['/sendSecurityAlert', '/SecurityNotifications', '/internal/security-alert', '/']) {
    assert.equal((await bridge.fetch('https://bridge.invalid' + path,
      { method: 'POST', body: JSON.stringify(alert) })).status, 404);
  }
  assert.equal(calls.length, 0);
  const caller = await mf.getWorker('caller');
  const invoke = async payload => (await caller.fetch('https://caller.invalid/',
    { method: 'POST', body: JSON.stringify(payload) })).json();
  assert.deepEqual(await invoke({ ...alert, channel: 'CATTACKER1', text: '<!channel>' }), { ok: false, code: 'invalid_alert' });
  assert.equal(calls.length, 0);
  assert.deepEqual(await invoke(alert), { ok: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://slack.com/api/chat.postMessage');
  assert.equal(calls[0].body.channel, channel);
  assert.equal(calls[0].body.client_msg_id, alert.id);
  assert.equal(calls[0].body.blocks[0].text.type, 'plain_text');
  assert.equal(calls[0].body.blocks[0].type, 'header');
  assert.ok(calls[0].body.blocks.some(block => block.type === 'section' && block.fields?.length >= 4));
  assert.match(JSON.stringify(calls[0].body.blocks), /対応の目安/);
  assert.doesNotMatch(JSON.stringify(calls[0].body), /synthetic-local-token|<!|<@/);
  const waf = { ...alert, id: '27818655-47b9-443e-8543-a768f3941310', source: 'waf', kind: 'waf_activity',
    host: 'partner-portal.opus-system.jp', count: 9, action: 'block', detailCode: 'sampled_waf',
    ruleSummary: { rules: [{ ruleId: '2b5d06e34a814a889bee9a0699702280',
      description: 'React - RCE - CVE:CVE-2025-55182', count: 7 }], otherCount: 1, unknownCount: 1, limited: false } };
  assert.deepEqual(await invoke(waf), { ok: true });
  assert.equal(calls.length, 2); assert.equal(calls[1].body.client_msg_id, waf.id);
  const rules = calls[1].body.blocks.find(block => block.text?.text.startsWith('一致ルール'));
  assert.equal(rules.text.type, 'plain_text'); assert.match(rules.text.text, /React - RCE/);
  assert.match(rules.text.text, /内訳を表示していない記録: 1 件/); assert.match(rules.text.text, /ルール情報を取得できない記録: 1 件/);
  assert.deepEqual(await invoke({ ...waf, count: 8 }), { ok: false, code: 'invalid_alert' });
  assert.deepEqual(await invoke({ ...alert, ruleSummary: waf.ruleSummary }), { ok: false, code: 'invalid_alert' });
  assert.equal(calls.length, 2);
});
