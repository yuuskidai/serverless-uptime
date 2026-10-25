import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { verifyGithubOidc, GithubOidcError } from '../src/github-oidc.ts';

const NOW = 1_792_923_600_000;
const config = {
  audience: 'https://monitor.example.invalid/api/external-observations',
  repository: 'owner/project', repositoryId: '1229702777', ownerId: '85591602',
  workflowRef: 'owner/project/.github/workflows/external-health.yml@refs/heads/master',
};
const encode = value => Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64url');
const keyPair = await webcrypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048,
  publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
const publicKey = { ...await webcrypto.subtle.exportKey('jwk', keyPair.publicKey), kid: 'trusted-key', use: 'sig', alg: 'RS256' };
const baseClaims = {
  iss: 'https://token.actions.githubusercontent.com', aud: config.audience,
  sub: `repo:${config.repository}:ref:refs/heads/master`, repository: config.repository,
  repository_id: config.repositoryId, repository_owner_id: config.ownerId, ref: 'refs/heads/master',
  workflow_ref: config.workflowRef, event_name: 'schedule', run_id: '40172748648', run_attempt: '1',
  iat: NOW / 1000 - 10, nbf: NOW / 1000 - 10, exp: NOW / 1000 + 290,
  sha: 'fe54133cdef7403d3c75e06d2d9ac2ffbc0b3576',
};
async function token(claims = {}, header = {}, privateKey = keyPair.privateKey) {
  const input = `${encode({ alg: 'RS256', typ: 'JWT', kid: publicKey.kid, ...header })}.${encode({ ...baseClaims, ...claims })}`;
  const signature = await webcrypto.subtle.sign('RSASSA-PKCS1-v1_5', privateKey, Buffer.from(input));
  return `${input}.${Buffer.from(signature).toString('base64url')}`;
}
function fixture({ keys = [publicKey], responder } = {}) {
  const calls = [];
  const fetcher = async (url, init) => {
    calls.push({ url, method: init.method, redirect: init.redirect, headers: init.headers });
    return responder ? responder(url, init) : Response.json({ keys });
  };
  return { calls, fetcher, options: { now: NOW, fetcher } };
}
const isInvalid = error => error instanceof GithubOidcError && error.kind === 'invalid' && !error.retryable;
const isUnavailable = error => error instanceof GithubOidcError && error.kind === 'unavailable' && error.retryable;

test('actual RSA signature is verified against fixed issuer keys and exact workflow identity', async () => {
  const f = fixture();
  const claims = await verifyGithubOidc(await token(), config, f.options);
  assert.equal(claims.run_id, baseClaims.run_id);
  assert.equal(claims.repository_owner_id, config.ownerId);
  assert.equal(claims.sha, baseClaims.sha);
  assert.deepEqual(f.calls, [{ url: 'https://token.actions.githubusercontent.com/.well-known/jwks',
    method: 'GET', redirect: 'error', headers: { Accept: 'application/json' } }]);
});

for (const event_name of ['schedule', 'push', 'workflow_dispatch']) {
  test(`allowed workflow trigger ${event_name} retains strict repository identity`, async () => {
    const f = fixture();
    assert.equal((await verifyGithubOidc(await token({ event_name }), config, f.options)).event_name, event_name);
  });
}

for (const [claim, value] of [
  ['iss', 'https://attacker.invalid'], ['aud', 'other-audience'], ['aud', [config.audience]],
  ['repository', 'attacker/project'], ['repository_id', '42'], ['repository_owner_id', '42'],
  ['ref', 'refs/heads/feature'], ['sub', 'repo:owner/project:pull_request'],
  ['workflow_ref', 'owner/project/.github/workflows/other.yml@refs/heads/master'],
  ['event_name', 'pull_request'], ['run_id', 40172748648], ['run_id', '0'],
  ['run_attempt', '0'], ['run_attempt', ['1']], ['sha', 'invalid-sha'],
]) {
  test(`rejects ${claim} identity variation before a network lookup`, async () => {
    const f = fixture();
    await assert.rejects(verifyGithubOidc(await token({ [claim]: value }), config, f.options), isInvalid);
    assert.equal(f.calls.length, 0);
  });
}

for (const claims of [
  { exp: NOW / 1000 }, { iat: NOW / 1000 - 601 }, { iat: NOW / 1000 + 31 },
  { nbf: NOW / 1000 + 31 }, { nbf: NOW / 1000 - 1000 }, { exp: NOW / 1000 + 3600 },
  { iat: String(NOW / 1000 - 10) }, { nbf: 0 }, { exp: 0 }, { exp: NOW / 1000 + 0.5 },
]) {
  test(`rejects expired, stale, future or malformed timing ${JSON.stringify(claims)}`, async () => {
    const f = fixture();
    await assert.rejects(verifyGithubOidc(await token(claims), config, f.options), isInvalid);
    assert.equal(f.calls.length, 0);
  });
}

for (const header of [
  { alg: 'none' }, { alg: 'HS256' }, { alg: ['RS256'] }, { typ: 'other' }, { kid: ['trusted-key'] },
  { jku: 'https://attacker.invalid/keys' }, { x5u: 'https://attacker.invalid/cert' },
  { jwk: publicKey }, { crit: [] },
]) {
  test(`rejects algorithm/key-source/header confusion ${JSON.stringify(header).slice(0, 70)}`, async () => {
    const f = fixture();
    await assert.rejects(verifyGithubOidc(await token({}, header), config, f.options), isInvalid);
    assert.equal(f.calls.length, 0);
  });
}

test('forged signature and tampered signed payload fail despite correct claim strings', async () => {
  const f = fixture();
  const valid = await token();
  const segments = valid.split('.');
  segments[2] = Buffer.alloc(256, 7).toString('base64url');
  await assert.rejects(verifyGithubOidc(segments.join('.'), config, f.options), isInvalid);
  const changed = valid.split('.');
  changed[1] = encode({ ...baseClaims, run_attempt: '2' });
  await assert.rejects(verifyGithubOidc(changed.join('.'), config, f.options), isInvalid);
  assert.equal(f.calls.length, 1);
});

test('bounded JWKS cache deduplicates concurrent lookups and expires after ten minutes', async () => {
  const f = fixture();
  const first = await token();
  await Promise.all(Array.from({ length: 8 }, () => verifyGithubOidc(first, config, f.options)));
  assert.equal(f.calls.length, 1);
  const later = NOW + 600_001;
  await verifyGithubOidc(await token({ iat: Math.floor(later / 1000), nbf: Math.floor(later / 1000), exp: Math.floor(later / 1000) + 300 }),
    config, { ...f.options, now: later });
  assert.equal(f.calls.length, 2);
});

test('unknown key IDs cannot force repeated issuer fetches and refresh can accept rotated keys', async () => {
  const rotated = { ...publicKey, kid: 'rotated-key' };
  let keys = [publicKey];
  const f = fixture({ responder: () => Response.json({ keys }) });
  await verifyGithubOidc(await token(), config, f.options);
  for (const kid of ['unknown-one', 'unknown-two']) {
    await assert.rejects(verifyGithubOidc(await token({}, { kid }), config, f.options), isInvalid);
  }
  assert.equal(f.calls.length, 1);
  keys = [publicKey, rotated];
  await verifyGithubOidc(await token({}, { kid: rotated.kid }), config, { ...f.options, now: NOW + 31_000 });
  assert.equal(f.calls.length, 2);
});

for (const keys of [
  [], [publicKey, publicKey], [{ ...publicKey, n: Buffer.alloc(128, 255).toString('base64url') }],
  [{ ...publicKey, e: 'Ag' }], [{ ...publicKey, d: 'private-material' }], [{ ...publicKey, kty: 'oct' }],
]) {
  test('rejects missing, duplicate, weak or unsuitable verification keys', async () => {
    const f = fixture({ keys });
    await assert.rejects(verifyGithubOidc(await token(), config, f.options), isUnavailable);
  });
}

for (const responder of [
  () => new Response(null, { status: 302, headers: { Location: 'https://attacker.invalid' } }),
  () => new Response('not json', { status: 200 }),
  () => Response.json({ keys: [publicKey] }, { status: 503 }),
  () => new Response('x'.repeat(65_537), { headers: { 'Content-Type': 'application/json' } }),
  () => new Response('{}', { headers: { 'Content-Type': 'application/json', 'Content-Length': '65537' } }),
]) {
  test('key retrieval failures and oversized responses fail closed without token disclosure', async () => {
    const f = fixture({ responder });
    const signed = await token();
    await assert.rejects(verifyGithubOidc(signed, config, f.options), error => {
      assert.equal(String(error).includes(signed), false);
      return isUnavailable(error);
    });
  });
}

test('fetch and response-body deadlines remain bounded if peer ignores cancellation', async () => {
  const stalledFetch = fixture({ responder: () => new Promise(() => {}) });
  await assert.rejects(verifyGithubOidc(await token(), config, { ...stalledFetch.options, fetchTimeoutMs: 15 }), isUnavailable);
  let cancelled = 0;
  const stalledBody = fixture({ responder: () => new Response(new ReadableStream({
    cancel() { cancelled++; return new Promise(() => {}); },
  }), { headers: { 'Content-Type': 'application/json' } }) });
  await assert.rejects(verifyGithubOidc(await token(), config, { ...stalledBody.options, fetchTimeoutMs: 15 }), isUnavailable);
  assert.equal(cancelled, 1);
});

test('malformed, padded, noncanonical and oversized JWT representations are rejected', async () => {
  const f = fixture();
  const signed = await token();
  for (const malformed of ['', 'a.b', 'a.b.c.d', signed + '=', 'x'.repeat(16_385),
    `${encode('[]')}.${signed.split('.')[1]}.${signed.split('.')[2]}`]) {
    await assert.rejects(verifyGithubOidc(malformed, config, f.options), isInvalid);
  }
  assert.equal(f.calls.length, 0);
});

test('missing configured identity fails unavailable rather than accepting token claims', async () => {
  const f = fixture();
  await assert.rejects(verifyGithubOidc(await token(), { ...config, repositoryId: '' }, f.options), isUnavailable);
  assert.equal(f.calls.length, 0);
});
