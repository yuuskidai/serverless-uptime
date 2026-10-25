import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

// Verify the production global-fetch, streamed JWKS and WebCrypto paths inside
// workerd. The outbound service is local: no real identity token or remote API
// is involved, and requests/tokens are never included in assertion output.
const require = createRequire(import.meta.url);
const wranglerRequire = createRequire(require.resolve('wrangler/package.json'));
const { Miniflare, convertV4MiniflareOptions } = wranglerRequire('miniflare');
const { buildSync } = wranglerRequire('esbuild');
const NOW = 1_792_923_600_000;
const config = {
  audience: 'https://monitor.example.invalid/api/external-observations',
  repository: 'owner/project', repositoryId: '1229702777', ownerId: '85591602',
  workflowRef: 'owner/project/.github/workflows/external-health.yml@refs/heads/master',
};
const claims = {
  iss: 'https://token.actions.githubusercontent.com', aud: config.audience,
  sub: `repo:owner@${config.ownerId}/project@${config.repositoryId}:ref:refs/heads/master`,
  repository: config.repository, repository_id: config.repositoryId,
  repository_owner_id: config.ownerId, ref: 'refs/heads/master', workflow_ref: config.workflowRef,
  event_name: 'schedule', run_id: '40172748648', run_attempt: '1',
  iat: NOW / 1000 - 10, nbf: NOW / 1000 - 610, exp: NOW / 1000 + 290,
};
const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
const pairs = await Promise.all(Array.from({ length: 4 }, () => webcrypto.subtle.generateKey({
  name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048,
  publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256',
}, true, ['sign', 'verify'])));
const keys = await Promise.all(pairs.map(async (pair, index) => ({
  ...await webcrypto.subtle.exportKey('jwk', pair.publicKey),
  kid: `github-shaped-key-${index}`, use: 'sig', alg: 'RS256',
})));
async function token(overrides = {}, keyIndex = 0) {
  const input = `${encode({ alg: 'RS256', typ: 'JWT', kid: keys[keyIndex].kid })}.${encode({ ...claims, ...overrides })}`;
  const signature = await webcrypto.subtle.sign('RSASSA-PKCS1-v1_5', pairs[keyIndex].privateKey, Buffer.from(input));
  return `${input}.${Buffer.from(signature).toString('base64url')}`;
}
const bundle = buildSync({
  stdin: {
    contents: `import { verifyGithubOidc, GithubOidcError } from './src/github-oidc.ts';
      export default { async fetch(request) {
        try {
          const claims = await verifyGithubOidc(await request.text(), ${JSON.stringify(config)}, { now: ${NOW} });
          return Response.json({ run_id: claims.run_id, run_attempt: claims.run_attempt,
            repository_owner_id: claims.repository_owner_id, sub: claims.sub });
        } catch (error) {
          return Response.json({ kind: error instanceof GithubOidcError ? error.kind : 'unexpected',
            name: error.name, message: error.message }, {
            status: error instanceof GithubOidcError && error.kind === 'invalid' ? 401 : 503 });
        }
      } };`,
    resolveDir: fileURLToPath(new URL('../', import.meta.url)),
    sourcefile: 'local-github-oidc-fixture.js',
  },
  bundle: true, format: 'esm', platform: 'browser', write: false,
}).outputFiles[0].text;

test('real workerd verifies GitHub-shaped RSA JWKS using the production global fetch path', async t => {
  const outbound = [];
  const redirectOutbound = [];
  const jwksBytes = new TextEncoder().encode(JSON.stringify({ keys }));
  const mf = new Miniflare(convertV4MiniflareOptions({ workers: [{
    name: 'oidc', modules: true, script: bundle, compatibilityDate: '2025-01-01',
    outboundService: async request => {
      outbound.push({ url: request.url, method: request.method, accept: request.headers.get('Accept') });
      // Multiple chunks exercise Workers' actual Response.body reader/decoder,
      // rather than passing a Node response directly to an injected fetcher.
      return new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(jwksBytes.slice(0, 31));
          controller.enqueue(jwksBytes.slice(31));
          controller.close();
        },
      }), { headers: { 'Content-Type': 'application/json; charset=utf-8' } });
    },
  }, {
    name: 'oidc-redirect', modules: true, script: bundle, compatibilityDate: '2025-01-01',
    outboundService: async request => {
      redirectOutbound.push(request.url);
      return new Response(null, { status: 302, headers: { Location: 'https://attacker.invalid/keys' } });
    },
  }] }));
  t.after(() => mf.dispose());
  const worker = await mf.getWorker('oidc');
  async function verify(value) {
    const response = await worker.fetch('http://local-test.invalid/', { method: 'POST', body: value });
    return { status: response.status, body: await response.json() };
  }

  await t.test('imports each of four keys and accepts signed GitHub timing/immutable subject', async () => {
    for (let index = 0; index < pairs.length; index++) {
      const result = await verify(await token({}, index));
      assert.equal(result.status, 200, JSON.stringify(result.body));
      assert.deepEqual(result.body, { run_id: claims.run_id, run_attempt: '1',
        repository_owner_id: config.ownerId, sub: claims.sub });
    }
    assert.deepEqual(outbound, [{ url: 'https://token.actions.githubusercontent.com/.well-known/jwks',
      method: 'GET', accept: 'application/json' }]);
  });

  await t.test('cryptographic verification rejects a forged signature after JWKS cache fill', async () => {
    const parts = (await token()).split('.');
    parts[2] = Buffer.alloc(256, 7).toString('base64url');
    const result = await verify(parts.join('.'));
    assert.equal(result.status, 401, JSON.stringify(result.body));
    assert.equal(result.body.kind, 'invalid');
    assert.equal(outbound.length, 1);
  });

  await t.test('correct signature does not bypass repository/audience trust checks', async () => {
    for (const override of [{ aud: 'https://attacker.invalid' }, { repository_owner_id: '42' }]) {
      const result = await verify(await token(override));
      assert.equal(result.status, 401, JSON.stringify(result.body));
      assert.equal(result.body.kind, 'invalid');
    }
    assert.equal(outbound.length, 1);
  });

  await t.test('Workers-compatible manual redirect mode rejects issuer redirects without following them', async () => {
    const redirectWorker = await mf.getWorker('oidc-redirect');
    const response = await redirectWorker.fetch('http://local-test.invalid/', { method: 'POST', body: await token() });
    assert.equal(response.status, 503);
    assert.equal((await response.json()).kind, 'unavailable');
    assert.deepEqual(redirectOutbound, ['https://token.actions.githubusercontent.com/.well-known/jwks']);
  });
});
