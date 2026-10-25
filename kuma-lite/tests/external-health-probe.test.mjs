import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { probeTarget, probeReadiness, runExternalWitness } from '../scripts/external-health-probe.mjs';

const config = JSON.parse(readFileSync(new URL('../external-targets.json', import.meta.url), 'utf8'));
const target = config.targets[0];
const healthy = () => ({ status: 'ok', components: [{ name: 'Database', status: 'ok', latency_ms: 100 }] });
const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
const reply = (value = healthy(), options = {}) => Response.json(value, { headers, ...options });

test('fixed public probe sends only bounded GET with request ID and does not follow redirects', async () => {
  const result = await probeTarget(target, { fetcher: async (url, init) => {
    assert.equal(url, target.url); assert.equal(init.method, 'GET'); assert.equal(init.redirect, 'manual');
    assert.equal(init.cache, 'no-store'); assert.equal(init.headers.Authorization, undefined);
    assert.match(init.headers['X-Monitor-Request-ID'], /^[a-f0-9-]{36}$/);
    return reply();
  } });
  assert.equal(result.status, 'ok'); assert.equal(result.database_ms, 100);
  assert.equal(result.error, null); assert.equal('value' in result, false);
});

for (const [name, response, error] of [
  ['login HTML', () => new Response('PRIVATE LOGIN BODY'), 'invalid_health'],
  ['empty JSON', () => new Response('', { headers }), 'invalid_health'],
  ['malformed JSON', () => new Response('{"private":"SECRET"', { headers }), 'invalid_health'],
  ['array overall status', () => reply({ ...healthy(), status: ['down'] }), 'invalid_health'],
  ['array component status', () => reply({ status: 'ok', components: [{ name: 'Database', status: ['down'], latency_ms: 100 }] }), 'invalid_health'],
  ['unknown component status', () => reply({ status: 'ok', components: [{ name: 'Database', status: 'mystery', latency_ms: 100 }] }), 'invalid_health'],
  ['missing database', () => reply({ status: 'ok', components: [{ name: 'Search', status: 'ok' }] }), 'invalid_health'],
  ['HTTP503 plus ok JSON', () => reply(healthy(), { status: 503 }), 'http_error'],
  ['redirect response', () => reply(healthy(), { status: 302, headers: { ...headers, Location: '/login' } }), 'http_error'],
  ['missing no-store', () => reply(healthy(), { headers: { 'Content-Type': 'application/json' } }), 'cached_response'],
  ['cached response', () => reply(healthy(), { headers: { ...headers, 'CF-Cache-Status': 'HIT' } }), 'cached_response'],
  ['positive cache age', () => reply(healthy(), { headers: { ...headers, Age: '30' } }), 'cached_response'],
  ['oversized response', () => new Response(' '.repeat(9000), { headers }), 'invalid_health'],
]) test(`outside probe rejects ${name} without storing response content`, async () => {
  const result = await probeTarget(target, { fetcher: async () => response() });
  assert.equal(result.status, 'down'); assert.equal(result.error, error);
  assert.equal(JSON.stringify(result).includes('PRIVATE'), false); assert.equal(JSON.stringify(result).includes('SECRET'), false);
});

test('DB threshold handles999/1000ms and preserves unrelated component failures', async () => {
  for (const duration of [900, 999, 1000, 1001]) {
    const reason = `応答が 800ms を超過 (${duration}ms)`;
    const value = { status: 'degraded', reason, components: [{ name: 'Database', status: 'degraded', latency_ms: duration, reason }] };
    const result = await probeTarget(target, { fetcher: async () => reply(value) });
    assert.equal(result.status, duration < 1000 ? 'ok' : 'degraded');
  }
  const otherFailure = healthy(); otherFailure.components.push({ name: 'Search', status: 'down', reason: 'unavailable' });
  assert.equal((await probeTarget(target, { fetcher: async () => reply(otherFailure) })).status, 'down');
  const mixed = { status: 'degraded', reason: 'latency; replication unavailable',
    components: [{ name: 'Database', status: 'degraded', latency_ms: 100, reason: 'latency; replication unavailable' }] };
  assert.equal((await probeTarget(target, { fetcher: async () => reply(mixed) })).status, 'degraded');
});

test('explicit DB-down503 retains measured evidence', async () => {
  const result = await probeTarget(target, { fetcher: async () => reply({ status: 'down',
    components: [{ name: 'Database', status: 'down', latency_ms: 2500, reason: 'unavailable' }] }, { status: 503 }) });
  assert.equal(result.status, 'down'); assert.equal(result.database_ms, 2500); assert.equal(result.http_status, 503);
});

test('deadline works even when a mocked fetch ignores abort', async () => {
  const result = await probeTarget(target, { fetcher: () => new Promise(() => {}), timeoutMs: 5 });
  assert.equal(result.error, 'timeout_headers'); assert.equal(result.status, 'down');
});

test('real local HTTP stalled body is bounded, cancelled and never establishes health', async t => {
  const server = createServer((_req, response) => { response.writeHead(200, headers); response.flushHeaders(); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const result = await probeTarget(target, { timeoutMs: 100,
    fetcher: (_url, init) => fetch(`http://127.0.0.1:${server.address().port}/`, init) });
  assert.equal(result.error, 'timeout_body'); assert.equal(result.http_status, 200); assert.equal(result.status, 'down');
});

test('monitor readiness is a separate signal from target health', async () => {
  assert.equal((await probeReadiness(config.readiness_url, { fetcher: async () => reply({ status: 'ok', monitoring_data: 'fresh' }) })).status, 'fresh');
  assert.equal((await probeReadiness(config.readiness_url, { fetcher: async () => reply({ status: 'unknown', monitoring_data: 'missing_or_stale' }, { status: 503 }) })).status, 'unknown');
});

test('GitHub runner obtains audience-limited identity and reports without exposing either bearer token', async () => {
  const calls = [];
  const runtime = { GITHUB_RUN_ID: '12345', GITHUB_RUN_ATTEMPT: '1', GITHUB_SHA: 'a'.repeat(40),
    ACTIONS_ID_TOKEN_REQUEST_URL: 'https://vstoken.actions.githubusercontent.com/identity',
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'PRIVATE_REQUEST_TOKEN' };
  let submission;
  const result = await runExternalWitness(config, runtime, { fetcher: async (url, init) => {
    calls.push({ url, method: init.method });
    if (String(url).includes('vstoken.actions')) {
      assert.equal(new URL(url).searchParams.get('audience'), config.receiver);
      assert.equal(init.headers.Authorization, 'Bearer PRIVATE_REQUEST_TOKEN');
      return reply({ value: 'PRIVATE_OIDC_TOKEN.payload.signature' });
    }
    if (url === config.receiver) {
      assert.equal(init.headers.Authorization, 'Bearer PRIVATE_OIDC_TOKEN.payload.signature');
      submission = JSON.parse(init.body); return reply({ accepted: true });
    }
    if (url === config.readiness_url) return reply({ status: 'ok', monitoring_data: 'fresh' });
    return reply();
  } });
  assert.equal(result.reporting.accepted, true); assert.equal(result.service_failure, false);
  assert.equal(result.monitor_freshness_failure, false); assert.equal(submission.observations.length, 2);
  assert.equal(new Set(submission.observations.map(row => row.request_id)).size, 2);
  assert.equal(JSON.stringify(result).includes('PRIVATE_'), false);
  assert.equal(calls.length, 5);
});

test('receiver unavailability does not turn healthy services into failed services', async () => {
  const runtime = { GITHUB_RUN_ID: '12345', GITHUB_RUN_ATTEMPT: '1', GITHUB_SHA: 'a'.repeat(40),
    ACTIONS_ID_TOKEN_REQUEST_URL: 'https://vstoken.actions.githubusercontent.com/identity', ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'private' };
  const result = await runExternalWitness(config, runtime, { fetcher: async url => {
    if (String(url).includes('vstoken.actions')) return reply({ value: 'header.payload.signature' });
    if (url === config.receiver) return reply({ error: 'unauthorized' }, { status: 401 });
    if (url === config.readiness_url) return reply({ status: 'ok', monitoring_data: 'fresh' });
    return reply();
  } });
  assert.equal(result.service_failure, false); assert.equal(result.reporting.accepted, false);
  assert.equal(result.reporting.status, 401);
});

test('idempotent receiver retry sends the exact same observation body', async () => {
  const runtime = { GITHUB_RUN_ID: '12345', GITHUB_RUN_ATTEMPT: '1', GITHUB_SHA: 'a'.repeat(40),
    ACTIONS_ID_TOKEN_REQUEST_URL: 'https://vstoken.actions.githubusercontent.com/identity', ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'private' };
  const bodies = [];
  const result = await runExternalWitness(config, runtime, { retryDelayMs: 1, fetcher: async (url, init) => {
    if (String(url).includes('vstoken.actions')) return reply({ value: 'header.payload.signature' });
    if (url === config.receiver) { bodies.push(init.body); return bodies.length === 1 ? reply({}, { status: 503 }) : reply({ accepted: true }); }
    if (url === config.readiness_url) return reply({ status: 'ok', monitoring_data: 'fresh' });
    return reply();
  } });
  assert.equal(result.reporting.accepted, true); assert.equal(bodies.length, 2); assert.equal(bodies[0], bodies[1]);
});
