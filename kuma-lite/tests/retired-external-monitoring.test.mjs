import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadTs } from './helpers.mjs';

test('retired receiver rejects deliveries without accessing D1, OIDC or the request body', async () => {
  const unexpected = () => { throw new Error('retired receiver touched a dependency'); };
  const { default: worker } = loadTs('index', {
    './security-notifications-entrypoint': {}, './security-integration': {}, './api': {}, './edge-cache': {}, './incident-page': {},
    './rca': {}, './rss-feed': {}, './status-page': {}, './slack-bot': {}, './monitor': {},
    './monitor-runner': {}, './notification-outbox': {}, './scheduled-runs': {},
    './monitor-readiness': {}, './schema-gate': { ensureSchema: unexpected },
  });
  for (const method of ['POST', 'PUT', 'DELETE']) {
    const response = await worker.fetch({ url: 'https://status.invalid/api/external-observations', method,
      get body() { return unexpected(); }, get headers() { return unexpected(); } }, {}, {});
    assert.equal(response.status, 410);
    assert.deepEqual(await response.json(), { error: 'external_monitoring_retired' });
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
  }
});

test('builds omit retired bindings from production and previews while retaining main services', t => {
  const temporaryRoot = fs.realpathSync(os.tmpdir());
  const root = fs.mkdtempSync(path.join(temporaryRoot, 'retired-monitor-build-'));
  t.after(() => {
    assert.equal(path.dirname(fs.realpathSync(root)), temporaryRoot);
    fs.rmSync(root, { recursive: true, force: true });
  });
  fs.mkdirSync(path.join(root, 'scripts'));
  const packageRoot = fileURLToPath(new URL('../', import.meta.url));
  fs.copyFileSync(path.join(packageRoot, 'scripts/build-wrangler-toml.mjs'), path.join(root, 'scripts/build-wrangler-toml.mjs'));
  fs.copyFileSync(path.join(packageRoot, 'wrangler.toml.example'), path.join(root, 'wrangler.toml.example'));
  execFileSync(process.execPath, [path.join(root, 'scripts/build-wrangler-toml.mjs')], { env: { ...process.env,
    D1_DATABASE_ID: '00000000-0000-4000-8000-000000000000', RCA_QUEUE_NAME: '',
    WRANGLER_SERVICES: 'PORTAL=partner-portal,CORE=core-os,CLOUDFLARE_WITNESS=helth-witness,OLD_WITNESS=helth-witness',
  }, stdio: 'pipe' });
  const config = fs.readFileSync(path.join(root, 'wrangler.toml'), 'utf8');
  const activeConfig = config.split('\n').filter(line => !line.trimStart().startsWith('#')).join('\n');
  assert.doesNotMatch(activeConfig, /CLOUDFLARE_WITNESS|helth-witness|OLD_WITNESS/);
  assert.equal((activeConfig.match(/binding = "PORTAL"/g) ?? []).length, 2);
  assert.equal((activeConfig.match(/binding = "CORE"/g) ?? []).length, 2);
});
