import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { loadTs } from './helpers.mjs';

const require = createRequire(import.meta.url);
const { buildSync } = createRequire(require.resolve('wrangler/package.json'))('esbuild');
const code = buildSync({ stdin: { contents: `
  export {buildSlackBot} from './src/slack-bot.ts';
  export {admitSlackWebhook,verifySlackRequest,verifySlackRequestMetadata} from './src/chat-adapters/slack/signing.ts';
`, resolveDir: fileURLToPath(new URL('../', import.meta.url)) }, bundle: true, platform: 'node', format: 'esm', write: false }).outputFiles[0].text;
const actual = await import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'));
const secret = 'synthetic-local-slack-signing-secret';
const env = { SLACK_BOT_TOKEN: 'synthetic-local-bot-token', SLACK_SIGNING_SECRET: secret,
  DB: { prepare() { return { async all() { return { results: [] }; } }; } } };
const now = () => Math.floor(Date.now() / 1000);
function headers(body, timestamp = now()) {
  return { 'content-type': 'application/json', 'x-slack-request-timestamp': String(timestamp),
    'x-slack-signature': 'v0=' + createHmac('sha256', secret).update(`v0:${timestamp}:`).update(body).digest('hex') };
}
function request(body, customHeaders = headers(body)) {
  return new Request('https://monitor.invalid/slack/events', { method: 'POST', headers: customHeaders, body });
}
function fixture() {
  let schemaCalls = 0;
  const tasks = [];
  const { handleSlackWebhook } = loadTs('slack-webhook', {
    './slack-bot': { buildSlackBot: actual.buildSlackBot },
    './chat-adapters/slack/signing': { admitSlackWebhook: actual.admitSlackWebhook },
    './schema-gate': { ensureSchema: async () => { schemaCalls++; return { ok: true }; },
      logSchemaProblem() { assert.fail('unexpected schema error'); }, publicSchemaErrorResponse() { assert.fail('unexpected schema error'); } },
  });
  return { tasks, schemaCalls: () => schemaCalls,
    run: req => handleSlackWebhook(req, env, { waitUntil(task) { tasks.push(task); } }) };
}

test('unsigned requests reject before schema/SDK initialization and make no Slack calls', async t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; assert.fail('unsigned request must never call Slack'); });
  const f = fixture();
  for (const req of [new Request('https://monitor.invalid/slack/events'), request('unsigned', {}),
    request('unsigned', { 'x-slack-request-timestamp': String(now()), 'x-slack-signature': 'bad' }),
    request('stale', headers('stale', now() - 301)),
    request('unsigned', { ...headers('unsigned'), 'x-slack-request-timestamp': `${now()}suffix` })]) {
    const response = await f.run(req);
    assert.ok([401, 405].includes(response.status));
  }
  assert.equal(f.schemaCalls(), 0); assert.equal(calls, 0);
  // Even callers using the SDK directly cannot trigger initialization I/O.
  const bot = actual.buildSlackBot(env);
  assert.equal((await bot.chat.webhooks.slack(request('unsigned', {}))).status, 401);
  assert.equal(calls, 0); await bot.chat.shutdown();
});

test('valid signed UTF-8 challenge is admitted once and needs no Slack identity lookup', async t => {
  t.mock.method(globalThis, 'fetch', async () => assert.fail('challenge must not call Slack'));
  const body = JSON.stringify({ type: 'url_verification', challenge: '合成チャレンジ' });
  const admission = await actual.admitSlackWebhook(request(body), secret);
  assert.equal(admission.ok, true);
  const bot = actual.buildSlackBot(env);
  const response = await bot.chat.webhooks.slack(admission.request);
  assert.equal(response.status, 200); assert.equal((await response.json()).challenge, '合成チャレンジ');
  assert.equal(admission.request.bodyUsed, false, 'adapter reuses private admission instead of consuming the clone again');
  await bot.chat.shutdown();
  const f = fixture(); assert.equal((await f.run(request(body))).status, 200); assert.equal(f.schemaCalls(), 1);
});

test('signed slash commands still acknowledge and deliver the same status payload', async t => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async url => {
    const endpoint = new URL(url).pathname; calls.push(endpoint);
    assert.equal(endpoint, '/api/chat.postMessage');
    return Response.json({ ok: true, ts: '1234567890.123456', channel: 'CSYNTHETIC' });
  });
  const body = new URLSearchParams({ command: '/kuma-status', channel_id: 'CSYNTHETIC', user_id: 'USYNTHETIC' }).toString();
  const h = { ...headers(body), 'content-type': 'application/x-www-form-urlencoded' };
  const bot = actual.buildSlackBot(env), tasks = [];
  assert.equal((await bot.chat.webhooks.slack(request(body, h), { waitUntil(task) { tasks.push(task); } })).status, 200);
  await Promise.all(tasks); await bot.chat.shutdown();
  assert.deepEqual(calls, ['/api/chat.postMessage']);
});

test('tampering, invalid UTF-8 and forged admission headers cannot pass the byte signature boundary', async () => {
  const body = JSON.stringify({ type: 'url_verification', challenge: 'safe' });
  const tampered = await actual.admitSlackWebhook(request(body + ' ', { ...headers(body), 'x-slack-internal-verified': 'true' }), secret);
  assert.equal(tampered.ok, false); assert.equal(tampered.response.status, 401);
  const bytes = new Uint8Array([0xff, 0xfe]);
  const invalid = await actual.admitSlackWebhook(request(bytes, headers(bytes)), secret);
  assert.equal(invalid.ok, false); assert.equal(invalid.response.status, 400);
});

test('large and unfinished bodies have finite limits, cancellation does not wait for the sender', async () => {
  let cancelled = false;
  const stream = new ReadableStream({ start(c) { c.enqueue(new Uint8Array(65)); }, cancel() { cancelled = true; return new Promise(() => {}); } });
  const h = { 'x-slack-request-timestamp': String(now()), 'x-slack-signature': 'v0=' + '0'.repeat(64) };
  const large = await actual.admitSlackWebhook(new Request('https://monitor.invalid/slack/events', { method: 'POST', headers: h, body: stream, duplex: 'half' }), secret, { maxBytes: 64, timeoutMs: 100 });
  assert.equal(large.response.status, 413); assert.equal(cancelled, true);
  let timedCancel = false;
  const unfinished = new ReadableStream({ start(c) { c.enqueue(new Uint8Array([1])); }, cancel() { timedCancel = true; return new Promise(() => {}); } });
  const started = performance.now();
  const timed = await actual.admitSlackWebhook(new Request('https://monitor.invalid/slack/events', { method: 'POST', headers: h, body: unfinished, duplex: 'half' }), secret, { timeoutMs: 20 });
  assert.equal(timed.response.status, 408); assert.equal(timedCancel, true); assert.ok(performance.now() - started < 1000);
  const controller = new AbortController();
  const aborted = new ReadableStream({ start(c) { c.enqueue(new Uint8Array([1])); } });
  const pending = actual.admitSlackWebhook(new Request('https://monitor.invalid/slack/events', { method: 'POST', headers: h, body: aborted, signal: controller.signal, duplex: 'half' }), secret, { timeoutMs: 200 });
  controller.abort(); assert.equal((await pending).response.status, 400);
});

test('an admitted request cannot outlive the Slack signature freshness window', async () => {
  const timestamp = now(), body = '{}';
  const first = await actual.admitSlackWebhook(request(body, headers(body, timestamp)), secret, { nowSeconds: timestamp });
  assert.equal(first.ok, true);
  const next = await actual.admitSlackWebhook(first.request, secret, { nowSeconds: timestamp + 301 });
  assert.equal(next.ok, false); assert.equal(next.response.status, 401);
});

test('fragmented signed bytes and empty chunks retain exact HMAC input and a finite read deadline', async () => {
  const body = JSON.stringify({ type: 'url_verification', challenge: '合成 fragmented challenge' });
  const bytes = new TextEncoder().encode(body);
  let pulls = 0, used = 0;
  const fragmented = new ReadableStream({ pull(c) {
    pulls++;
    if (pulls <= 1024 || pulls % 2 === 0) c.enqueue(new Uint8Array());
    else if (used < bytes.length) c.enqueue(bytes.subarray(used, ++used));
    else c.close();
  } });
  const admitted = await actual.admitSlackWebhook(new Request('https://monitor.invalid/slack/events', {
    method: 'POST', headers: headers(bytes), body: fragmented, duplex: 'half',
  }), secret, { maxBytes: bytes.length });
  assert.equal(admitted.ok, true); assert.equal(admitted.rawBody, body); assert.ok(pulls > 1024);

  // Empty chunks consume no byte quota and may starve the timer's task queue.
  // They still must hit the absolute deadline and cancel without awaiting it.
  let cancelled = false;
  const empty = new ReadableStream({ pull(c) { c.enqueue(new Uint8Array()); },
    cancel() { cancelled = true; return new Promise(() => {}); } });
  const started = performance.now();
  const timed = await actual.admitSlackWebhook(new Request('https://monitor.invalid/slack/events', {
    method: 'POST', headers: headers(''), body: empty, duplex: 'half',
  }), secret, { timeoutMs: 20 });
  assert.equal(timed.ok, false); assert.equal(timed.response.status, 408);
  assert.equal(cancelled, true); assert.ok(performance.now() - started < 1000);
});
