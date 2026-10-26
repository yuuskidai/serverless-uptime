import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTs } from './helpers.mjs';

const { validSecurityAlert, renderSecurityAlert, deliverSecurityAlert } = loadTs('security-notifications');
const now = Date.now();
const env = { SLACK_BOT_TOKEN: 'synthetic-test-token', SLACK_DEFAULT_CHANNEL: 'C0123456789' };
const sample = extra => ({ version: 1, id: '17818655-47b9-443e-8543-a768f3941310', source: 'core',
  kind: 'auth_failure_burst', severity: 'warning', occurredAt: now, windowStart: now - 300_000,
  windowEnd: now, count: 10, host: 'core-os.opus-system.jp', detailCode: 'password', ...extra });
const success = () => Response.json({ ok: true, channel: env.SLACK_DEFAULT_CHANNEL, ts: '1793000000.123456' });
const plain = value => JSON.parse(JSON.stringify(value));

test('strict capability validation refuses arbitrary Slack payloads, secrets, spoofed severity and sources', () => {
  assert.equal(validSecurityAlert(sample(), now), true);
  assert.equal(validSecurityAlert(sample({ kind: 'totp_disabled', severity: 'critical' }), now), true);
  const cases = [null, [], 'text', sample({ text: '<!channel>' }), sample({ channel: 'CATTACKER1' }),
    sample({ token: 'secret' }), sample({ source: 'waf' }), sample({ kind: 'ddos_attack' }),
    sample({ severity: 'critical' }), sample({ host: 'partner-portal.opus-system.jp' }),
    sample({ kind: 'totp_disabled' }), sample({ id: '<!here>' }), sample({ subjectHash: 'user@example.invalid' }),
    sample({ ruleId: '<@U12345678>' }), sample({ detailCode: 'password=secret' }), sample({ action: 'allow' }),
    sample({ count: 0 }), sample({ count: 1.5 }), sample({ count: 1e9 + 1 }),
    sample({ occurredAt: now + 60_001 }), sample({ occurredAt: now - 7 * 86_400_000 - 1 }),
    sample({ windowEnd: now - 300_001 }), sample({ windowStart: now - 7 * 86_400_000 - 1 }),
  ];
  for (const value of cases) assert.equal(validSecurityAlert(value, now), false, JSON.stringify(value));
});

test('a valid warning uses only the fixed channel and safe blocks, and retries retain client_msg_id', async () => {
  const calls = [];
  const options = { wallNow: () => now, fetchImpl: async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) }); return success();
  } };
  assert.deepEqual(plain(await deliverSecurityAlert(env, sample({ subjectHash: 'a'.repeat(64), ruleId: 'safe-rule_1' }), options)), { ok: true });
  assert.deepEqual(plain(await deliverSecurityAlert(env, sample(), options)), { ok: true });
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.equal(call.url, 'https://slack.com/api/chat.postMessage');
    assert.equal(call.init.redirect, 'manual');
    assert.equal(call.init.headers.Authorization, 'Bearer synthetic-test-token');
    assert.equal(call.body.channel, env.SLACK_DEFAULT_CHANNEL);
    assert.equal(call.body.client_msg_id, sample().id);
    assert.equal(call.body.mrkdwn, false); assert.equal(call.body.parse, 'none');
    assert.equal(call.body.link_names, false); assert.equal(call.body.unfurl_links, false);
    assert.equal(call.body.unfurl_media, false);
    assert.equal(call.body.blocks[0].text.type, 'plain_text');
    assert.match(call.body.text, /不正侵入が成立したとは判断できません/);
    assert.doesNotMatch(call.body.text, /synthetic-test-token|https?:|<!|<@/);
  }
});

test('weakening a company security policy is a critical observed change restricted to application sources', () => {
  const alert = sample({ kind: 'security_policy_weakened', severity: 'critical' });
  assert.equal(validSecurityAlert(alert, now), true);
  assert.equal(validSecurityAlert({ ...alert, source: 'portal', host: 'partner-portal.opus-system.jp' }, now), true);
  assert.equal(validSecurityAlert({ ...alert, severity: 'warning' }, now), false);
  assert.equal(validSecurityAlert({ ...alert, source: 'waf', host: 'opus-system.jp' }, now), false);
  const text = renderSecurityAlert(alert);
  assert.match(text, /^【要確認】セキュリティ設定の緩和を記録/);
  assert.match(text, /不正侵入が成立したとは判断できません/);
});

test('invalid alerts and missing configuration cause no outbound request', async () => {
  let calls = 0; const fetchImpl = async () => { calls++; return success(); };
  for (const input of [sample({ token: 'secret' }), sample({ source: 'unknown' })]) {
    assert.equal((await deliverSecurityAlert(env, input, { fetchImpl })).code, 'invalid_alert');
  }
  for (const config of [{}, { ...env, SLACK_DEFAULT_CHANNEL: 'https://attacker.invalid' }, { ...env, SLACK_DEFAULT_CHANNEL: '<!here>' }]) {
    assert.equal((await deliverSecurityAlert(config, sample(), { fetchImpl })).code, 'not_configured');
  }
  assert.equal(calls, 0);
});

test('Slack 429 is typed, clamps retry windows, and never waits for body cancellation', async () => {
  for (const [header, expected] of [['120', 120000], ['0', 1000], ['9999999999', 3600000], ['invalid', 60000],
    [new Date(now + 90_000).toUTCString(), 90_000 - now % 1000]]) {
    let cancelled = false;
    const r = new Response(new ReadableStream({ cancel() { cancelled = true; return new Promise(() => {}); } }),
      { status: 429, headers: { 'Retry-After': header } });
    const result = await deliverSecurityAlert(env, sample(), { wallNow: () => now, timeoutMs: 100,
      fetchImpl: async () => r });
    assert.deepEqual(plain(result), { ok: false, code: 'rate_limited', retryAfterMs: expected });
    assert.equal(cancelled, true);
  }
});

test('the bridge returns only safe error codes for non-JSON, redirects, Slack errors, mismatched destination and oversized bodies', async () => {
  const cases = [
    [() => new Response('secret untrusted body', { status: 502 }), 'slack_unavailable'],
    [() => new Response(null, { status: 302, headers: { Location: 'https://attacker.invalid' } }), 'slack_rejected'],
    [() => new Response('secret untrusted body'), 'invalid_response'],
    [() => Response.json({ ok: false, error: 'invalid_auth', token: 'secret' }), 'slack_rejected'],
    [() => Response.json({ ok: false, error: 'ratelimited' }), 'rate_limited'],
    [() => Response.json({ ok: true, channel: 'CATTACKER1', ts: '1793000000.123456' }), 'invalid_response'],
    [() => Response.json({ ok: true, channel: env.SLACK_DEFAULT_CHANNEL }), 'invalid_response'],
    [() => new Response('x', { headers: { 'Content-Length': '16385' } }), 'invalid_response'],
    [() => new Response('x'.repeat(16385)), 'invalid_response'],
    [() => new Response(new Uint8Array([0xff])), 'network_error'],
  ];
  for (const [makeResponse, expected] of cases) {
    const result = await deliverSecurityAlert(env, sample(), { fetchImpl: async () => makeResponse() });
    assert.equal(result.code, expected); assert.equal(result.ok, false);
    assert.doesNotMatch(JSON.stringify(result), /secret|attacker|invalid_auth/);
  }
});

test('a transport ignoring abort is bounded and its late response is released', async () => {
  let resolve; let cancelled = false;
  const pending = new Promise(r => { resolve = r; });
  const result = await deliverSecurityAlert(env, sample(), { timeoutMs: 25, fetchImpl: () => pending });
  assert.deepEqual(plain(result), { ok: false, code: 'timeout' });
  resolve(new Response(new ReadableStream({ cancel() { cancelled = true; } })));
  await new Promise(r => setTimeout(r, 10));
  assert.equal(cancelled, true);
});

test('a stalled body is bounded and cleanup does not await its cancellation acknowledgement', async () => {
  let cancelled = false;
  const response = new Response(new ReadableStream({
    pull() { return new Promise(() => {}); },
    cancel() { cancelled = true; return new Promise(() => {}); },
  }));
  const result = await deliverSecurityAlert(env, sample(), { timeoutMs: 25, fetchImpl: async () => response });
  assert.deepEqual(plain(result), { ok: false, code: 'timeout' });
  assert.equal(cancelled, true);
});

test('an overdue success cannot win the expiry race before the timer callback runs', async () => {
  let clock = 0;
  const result = await deliverSecurityAlert(env, sample(), { timeoutMs: 25, monotonicNow: () => clock,
    fetchImpl: async () => { clock = 26; return success(); } });
  assert.deepEqual(plain(result), { ok: false, code: 'timeout' });
});
