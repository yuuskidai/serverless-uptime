import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

function fixture(t) {
  const temporaryRoot = fs.realpathSync(os.tmpdir());
  const root = fs.mkdtempSync(path.join(temporaryRoot, 'security-transfer-build-'));
  t.after(() => {
    assert.equal(path.dirname(fs.realpathSync(root)), temporaryRoot);
    fs.rmSync(root, { recursive: true, force: true });
  });
  const packageRoot = fileURLToPath(new URL('../', import.meta.url));
  fs.mkdirSync(path.join(root, 'scripts'));
  for (const file of ['scripts/build-wrangler-toml.mjs', 'wrangler.toml.example']) {
    fs.copyFileSync(path.join(packageRoot, file), path.join(root, file));
  }
  return { root, build: branch => spawnSync(process.execPath, [path.join(root, 'scripts/build-wrangler-toml.mjs')], {
    env: { ...process.env, WORKERS_CI: '1', WORKERS_CI_BRANCH: branch,
      D1_DATABASE_ID: '00000000-0000-4000-8000-000000000000', WRANGLER_SERVICES: '', RCA_QUEUE_NAME: '' },
    encoding: 'utf8',
  }) };
}

test('production configuration transfers existing security storage and never creates or deletes it', t => {
  const f = fixture(t);
  const result = f.build('master');
  assert.equal(result.status, 0);
  const config = fs.readFileSync(path.join(f.root, 'wrangler.toml'), 'utf8');
  assert.match(config, /^name = "helth"/);
  assert.match(config, /name = "SECURITY_HUB"\s+class_name = "SecurityHub"/);
  assert.match(config, /transferred_classes = \[\{ from = "SecurityHub", from_script = "helth-security", to = "SecurityHub" \}\]/);
  assert.doesNotMatch(config, /new_sqlite_classes|new_classes|deleted_classes/);
});

test('nonproduction Builds fail before generating or replacing a transfer configuration', t => {
  const f = fixture(t), output = path.join(f.root, 'wrangler.toml');
  fs.writeFileSync(output, 'existing configuration');
  for (const branch of ['', 'codex/security-test', 'main']) {
    const result = f.build(branch);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /production-only/);
    assert.equal(fs.readFileSync(output, 'utf8'), 'existing configuration');
  }
});
