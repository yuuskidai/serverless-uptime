import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';

const require = createRequire(import.meta.url);
const wranglerRequire = createRequire(require.resolve('wrangler/package.json'));
const { Miniflare, convertV4MiniflareOptions } = wranglerRequire('miniflare');
const { buildSync } = wranglerRequire('esbuild');
const config = JSON.parse(readFileSync(new URL('../external-targets.json', import.meta.url), 'utf8'));
const repositoryId = '1229702777'; const ownerId = '85591602';
const bundle = buildSync({ stdin: {
  contents: `import { handleExternalObservation } from './src/external-observations.ts';
    export default { fetch(request, env) { return handleExternalObservation(request, env); } };`,
  resolveDir: fileURLToPath(new URL('../', import.meta.url)), sourcefile: 'local-external-receiver-fixture.js',
}, bundle: true, platform: 'browser', format: 'esm', write: false }).outputFiles[0].text;

test('real workerd verifies GitHub-shaped RSA identity and atomically stores both external observations', async t => {
  const pair = await webcrypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
  const key = { ...await webcrypto.subtle.exportKey('jwk', pair.publicKey), kid: 'local-rsa-key', alg: 'RS256', use: 'sig' };
  const outbound = [];
  const mf = new Miniflare(convertV4MiniflareOptions({ workers: [{
    name: 'receiver', script: bundle, modules: true, compatibilityDate: '2025-01-01', compatibilityFlags: ['nodejs_compat'],
    d1Databases: { DB: 'synthetic-external-receiver' },
    bindings: {
      EXTERNAL_PROBE_AUDIENCE: config.receiver, EXTERNAL_PROBE_REPOSITORY: config.repository,
      EXTERNAL_PROBE_REPOSITORY_ID: repositoryId, EXTERNAL_PROBE_OWNER_ID: ownerId,
      EXTERNAL_PROBE_WORKFLOW_REF: `${config.repository}/.github/workflows/external-health.yml@refs/heads/master`,
    },
    outboundService: async request => {
      outbound.push({ url: request.url, method: request.method });
      return Response.json({ keys: [key] });
    },
  }] }));
  t.after(() => mf.dispose());
  const db = await mf.getD1Database('DB', 'receiver');
  const schema = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8');
  await db.batch(schema.replace(/^\s*--.*$/gm, '').split(';').map(sql => sql.trim()).filter(Boolean).map(sql => db.prepare(sql)));
  for (const target of config.targets) await db.prepare(
    'INSERT INTO monitors(id,name,url,db_latency_threshold_ms,created_at) VALUES(?,?,?,?,0)',
  ).bind(target.monitor_id, target.name, target.url, target.db_threshold_ms).run();
  const now = Date.now(); const seconds = Math.floor(now / 1000); const sha = 'a'.repeat(40);
  const payload = { version: 1, run_id: '999991', run_attempt: '1', commit_sha: sha,
    observations: config.targets.map(target => ({ monitor_id: target.monitor_id, url: target.url,
      db_threshold_ms: target.db_threshold_ms, observed_at: now - 500, finished_at: now - 100, total_ms: 400,
      http_status: 200, status: 'ok', database_ms: 100, error: null, request_id: webcrypto.randomUUID() })),
    readiness: { observed_at: now - 500, finished_at: now - 100, total_ms: 400,
      http_status: 200, status: 'fresh', error: null } };
  const claims = { iss: 'https://token.actions.githubusercontent.com', aud: config.receiver,
    repository: config.repository, repository_id: repositoryId, repository_owner_id: ownerId,
    ref: 'refs/heads/master', sub: `repo:${config.repository}:ref:refs/heads/master`,
    workflow_ref: `${config.repository}/.github/workflows/external-health.yml@refs/heads/master`,
    event_name: 'push', run_id: payload.run_id, run_attempt: payload.run_attempt, sha,
    iat: seconds - 5, nbf: seconds - 305, exp: seconds + 295 };
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const input = `${encode({ alg: 'RS256', typ: 'JWT', kid: key.kid })}.${encode(claims)}`;
  const signature = await webcrypto.subtle.sign('RSASSA-PKCS1-v1_5', pair.privateKey, Buffer.from(input));
  const token = `${input}.${Buffer.from(signature).toString('base64url')}`;
  const worker = await mf.getWorker('receiver');
  const submit = () => worker.fetch(config.receiver, { method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  const first = await submit(); const firstBody = await first.text();
  assert.equal(first.status, 200, firstBody);
  assert.equal(JSON.parse(firstBody).accepted, true);
  const duplicate = await submit();
  assert.equal(duplicate.status, 200); assert.equal((await duplicate.json()).duplicate, true);
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM external_probe_runs').first()).n, 1);
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM external_observations').first()).n, 2);
  assert.deepEqual(outbound, [{ url: 'https://token.actions.githubusercontent.com/.well-known/jwks', method: 'GET' }]);
});
