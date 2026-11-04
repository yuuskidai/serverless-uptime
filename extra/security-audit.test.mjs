import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { OSV_URL, LIMITS, loadRootInventory, scanOsvArchive, databaseProvenance,
  downloadPublicDatabase, parseAuditArguments, runSecurityAudit, verifyFreshness, classifyAuditFailure } from './security-audit.mjs';
import { classifyReviewedMatch } from './lib/legacy-patch-review.mjs';
import { affectedBySemver, npmRangesForComparison } from './lib/osv-semver.mjs';

const epoch = Date.parse('2026-11-04T10:00:00Z');
function directory(t) {
  const root = mkdtempSync(join(tmpdir(), 'legacy-osv-unit-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
function writeJson(path, value) { mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, JSON.stringify(value)); }
function fixture(t) {
  const root = directory(t);
  const project = { name: 'synthetic-legacy', version: '1.0.0', dependencies: { alpha: '1.0.0' },
    devDependencies: { beta: '2.0.0' }, optionalDependencies: { optional: '3.0.0' } };
  const lock = { name: project.name, version: project.version, lockfileVersion: 3, packages: {
    '': structuredClone(project), 'node_modules/alpha': { version: '1.0.0' }, 'node_modules/beta': { version: '2.0.0', dev: true },
    'node_modules/optional': { version: '3.0.0', optional: true },
  } };
  const save = () => { writeJson(join(root, 'package.json'), project); writeJson(join(root, 'package-lock.json'), lock); };
  save();
  for (const [name, version] of [['alpha', '1.0.0'], ['beta', '2.0.0']]) writeJson(join(root, 'node_modules', name, 'package.json'), { name, version });
  return { root, project, lock, save };
}
function advisory(name = 'alpha', id = 'GHSA-synthetic-safe') {
  return { schema_version: '1.9.0', id, modified: '2026-11-04T09:00:00Z',
    affected: [{ package: { ecosystem: 'npm', name }, ranges: [{ type: 'SEMVER', events: [{ introduced: '0' }, { fixed: '1.0.1' }] }] }] };
}
function zip(root, entries) {
  const path = join(root, 'database.zip');
  const result = spawnSync('python3', ['-c', `import json,sys,zipfile
with zipfile.ZipFile(sys.argv[1],'w',compression=zipfile.ZIP_STORED) as z:
 for name,value in json.load(sys.stdin): z.writestr(name,json.dumps(value,separators=(',',':')))
`, path], { input: JSON.stringify(entries), encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return path;
}
const limits = { ...LIMITS, minimumEntries: 1, requireKnownAdvisory: false };

test('finite diagnostics distinguish network, HTTP and evidence failures without echoing bodies or credentials', () => {
  const network = new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } });
  assert.deepEqual(classifyAuditFailure(network, 'database'), { phase: 'database', kind: 'network', code: 'ECONNRESET' });
  assert.deepEqual(classifyAuditFailure(new Error('Public OSV snapshot download failed: HTTP 503'), 'database'),
    { phase: 'database', kind: 'publisher_http', code: 'HTTP_503' });
  let httpAssertion;
  try { assert.equal(503, 200, 'Public OSV snapshot download failed: HTTP 503'); } catch (error) { httpAssertion = error; }
  assert.deepEqual(classifyAuditFailure(httpAssertion, 'database'), { phase: 'database', kind: 'publisher_http', code: 'HTTP_503' });
  assert.deepEqual(classifyAuditFailure(new Error('Database is stale; obtain a fresh public snapshot'), 'database'),
    { phase: 'database', kind: 'evidence', code: 'SNAPSHOT_STALE' });
  const poison = new Error('Authorization: Bearer synthetic-do-not-echo; provider raw response');
  poison.cause = { code: 'synthetic-do-not-echo' };
  const diagnostic = classifyAuditFailure(poison, 'synthetic-do-not-echo');
  assert.deepEqual(diagnostic, { phase: 'unknown', kind: 'validation', code: 'UNKNOWN_FAILURE' });
  assert.ok(!JSON.stringify(diagnostic).includes('synthetic-do-not-echo'));
});

test('inventory includes production/dev/absent optional and resolves a real local source link', t => {
  const f = fixture(t);
  f.project.dependencies.gamma = 'file:vendor/gamma';
  f.lock.packages[''].dependencies.gamma = f.project.dependencies.gamma;
  writeJson(join(f.root, 'vendor/gamma/package.json'), { name: 'gamma', version: '4.0.0' });
  symlinkSync('../vendor/gamma', join(f.root, 'node_modules/gamma'), 'dir');
  f.lock.packages['node_modules/gamma'] = { resolved: 'vendor/gamma', link: true };
  f.lock.packages['vendor/gamma'] = { version: '4.0.0' };
  f.save();
  const result = loadRootInventory(f.root);
  assert.equal(result.packages.length, 4);
  assert.equal(result.observedInstalledEntries, 3);
  assert.equal(result.packages.find(item => item.name === 'optional').optionalAbsent, true);
  assert.equal(result.packages.find(item => item.name === 'gamma').version, '4.0.0');
  assert.equal(result.localSources.length, 1);
});

test('unresolved links, missing graph edges, unlisted installed packages and changed identities fail closed', t => {
  const f = fixture(t);
  f.lock.packages['node_modules/alpha'].dependencies = { missing: '1.0.0' }; f.save();
  assert.throws(() => loadRootInventory(f.root), /Missing required dependency/);
  delete f.lock.packages['node_modules/alpha'].dependencies; f.save();
  writeJson(join(f.root, 'node_modules/extra/package.json'), { name: 'extra', version: '1.0.0' });
  assert.throws(() => loadRootInventory(f.root), /missing from lock/);
  rmSync(join(f.root, 'node_modules/extra'), { recursive: true });
  writeJson(join(f.root, 'node_modules/alpha/package.json'), { name: 'alpha', version: '2.0.0' });
  assert.throws(() => loadRootInventory(f.root), /version differs/);
  f.lock.packages['node_modules/alpha'] = { link: true, resolved: 'vendor/missing' }; f.save();
  assert.throws(() => loadRootInventory(f.root));
});

test('an unresolved local package produces unsupported and never attempts public download', async t => {
  const f = fixture(t);
  f.lock.packages['node_modules/alpha'] = { version: '1.0.0', resolved: 'file:vendor/missing' }; f.save();
  t.mock.method(globalThis, 'fetch', () => assert.fail('invalid inventory must not send a request'));
  const report = await runSecurityAudit({ root: f.root, output: join(f.root, 'report.json') });
  assert.equal(report.result, 'unsupported'); assert.equal(report.matchingComplete, false);
  assert.equal(report.unsupported[0].category, 'INVENTORY_UNSUPPORTED');
});

test('public GET downloads only the fixed database and records exact hash/size without a graph body', async t => {
  const root = directory(t), bytes = Buffer.from('synthetic public archive');
  const receipt = await downloadPublicDatabase(join(root, 'download.zip'), { now: epoch,
    fetchImpl: async (url, options) => {
      assert.equal(url, OSV_URL); assert.equal(options.method, 'GET'); assert.equal(options.redirect, 'error');
      assert.equal(options.credentials, 'omit'); assert.equal(options.body, undefined);
      assert.deepEqual(Object.keys(options.headers).sort(), ['Accept', 'Cache-Control']);
      return new Response(bytes, { headers: { 'content-length': String(bytes.length), 'last-modified': new Date(epoch).toUTCString() } });
    } });
  assert.equal(receipt.sha256, createHash('sha256').update(bytes).digest('hex'));
  assert.equal(receipt.dependencyMetadataSent, false); assert.equal(receipt.credentialsSent, false);
  assert.equal(receipt.bytes, bytes.length);
});

test('local receipt requires exact hash/size/public GET privacy and fresh publisher time', async t => {
  const root = directory(t), path = zip(root, [['GHSA-synthetic-safe.json', advisory()]]);
  const data = readFileSync(path);
  const receipt = { source: OSV_URL, method: 'GET', requestBodyBytes: 0, dependencyMetadataSent: false, credentialsSent: false,
    sha256: createHash('sha256').update(data).digest('hex'), bytes: data.length,
    responseHeaders: { 'Content-Length': String(data.length), 'Last-Modified': new Date(epoch).toUTCString() } };
  const metadata = join(root, 'receipt.json'); writeJson(metadata, receipt);
  assert.equal((await databaseProvenance(path, metadata, epoch, limits)).sha256, receipt.sha256);
  await assert.rejects(databaseProvenance(path, undefined, epoch, limits), /receipt/);
  for (const change of [{ sha256: '0'.repeat(64) }, { bytes: data.length - 1 }, { method: 'POST' }, { dependencyMetadataSent: true },
    { responseHeaders: { ...receipt.responseHeaders, 'Last-Modified': new Date(epoch - LIMITS.maximumAgeMs - 1000).toUTCString() } }]) {
    writeJson(metadata, { ...receipt, ...change });
    await assert.rejects(databaseProvenance(path, metadata, epoch, limits));
  }
  assert.throws(() => verifyFreshness(new Date(epoch + LIMITS.futureToleranceMs + 1000).toISOString(), epoch), /future/);
});

test('complete ZIP scan verifies every entry and filters only after metadata/CRC validation', async t => {
  const root = directory(t);
  const irrelevant = { ...advisory('other', 'GHSA-synthetic-other'), summary: 'CRC-ORIGINAL' };
  const path = zip(root, [['GHSA-synthetic-safe.json', advisory()], ['GHSA-synthetic-other.json', irrelevant]]);
  const observed = [];
  const stats = await scanOsvArchive(path, ['alpha'], record => observed.push(record.id), { limits, now: epoch });
  assert.deepEqual(observed, ['GHSA-synthetic-safe']);
  assert.equal(stats.processedEntries, 2); assert.equal(stats.crc32VerifiedEntries, 2); assert.equal(stats.completed, true);
  const bytes = readFileSync(path), at = bytes.indexOf(Buffer.from('CRC-ORIGINAL'));
  assert.ok(at >= 0); bytes[at] ^= 1; writeFileSync(path, bytes);
  await assert.rejects(scanOsvArchive(path, ['alpha'], () => {}, { limits, now: epoch }), /CRC|scan failed/);
});

test('OSV fractional timestamps work on Python3.10 without changing advisory bytes or review hashes', async t => {
  const root = directory(t);
  const records = Array.from({ length: 10 }, (_, digits) => {
    const fraction = digits ? '.' + '123456789'.slice(0, digits) : '';
    return { ...advisory('alpha', 'GHSA-fraction-' + digits), modified: '2026-11-04T09:00:00' + fraction + 'Z' };
  });
  const path = zip(root, records.map(record => [record.id + '.json', record]));
  const observed = [];
  const stats = await scanOsvArchive(path, ['alpha'], record => observed.push(record), { limits, now: epoch });
  assert.equal(stats.processedEntries, records.length);
  assert.equal(stats.crc32VerifiedEntries, records.length);
  assert.deepEqual(observed, records);
  for (let i = 0; i < records.length; i++) {
    assert.equal(createHash('sha256').update(JSON.stringify(observed[i])).digest('hex'),
      createHash('sha256').update(JSON.stringify(records[i])).digest('hex'));
  }
});

test('fraction compatibility still rejects malformed dates, excessive precision and future withdrawals', async t => {
  const root = directory(t);
  for (const modified of ['2026-11-04T09:00:00.1234567890Z', '2026-02-30T09:00:00.1Z',
    '2026-11-04T24:00:00.1234Z', '2026-11-04T09:00:00.12+24:00']) {
    const path = zip(root, [['GHSA-synthetic-safe.json', { ...advisory(), modified }]]);
    await assert.rejects(scanOsvArchive(path, ['alpha'], () => {}, { limits, now: epoch }), /scan failed/);
  }
  const future = { ...advisory(), withdrawn: '2026-11-04T10:00:01.123456789Z' };
  const path = zip(root, [['GHSA-synthetic-safe.json', future]]);
  await assert.rejects(scanOsvArchive(path, ['alpha'], () => {}, { limits, now: epoch }), /Future OSV withdrawal/);
});

test('malformed unrelated metadata and duplicate/truncated archives cannot report success', async t => {
  const root = directory(t);
  let path = zip(root, [['GHSA-synthetic-safe.json', advisory()],
    ['GHSA-synthetic-other.json', { ...advisory('other', 'GHSA-synthetic-other'), modified: '2026-99-04T09:00:00Z' }]]);
  await assert.rejects(scanOsvArchive(path, ['alpha'], () => {}, { limits, now: epoch }), /scan failed/);
  path = zip(root, [['GHSA-synthetic-safe.json', advisory()], ['GHSA-synthetic-safe.json', advisory()]]);
  await assert.rejects(scanOsvArchive(path, ['alpha'], () => {}, { limits, now: epoch }), /Duplicate/);
  path = zip(root, [['GHSA-synthetic-safe.json', advisory()]]);
  const bytes = readFileSync(path); writeFileSync(path, bytes.subarray(0, bytes.length - 16));
  await assert.rejects(scanOsvArchive(path, ['alpha'], () => {}, { limits, now: epoch }), /scan failed/);
});

test('strict SemVer intervals retain prereleases and conservative npm ECOSYSTEM lower bounds', () => {
  const ranges = npmRangesForComparison([{ type: 'ECOSYSTEM', events: [{ introduced: '1.2' }, { fixed: '1.2.4' }] }]);
  assert.equal(affectedBySemver('1.2.0-rc.1', ranges.ranges), true);
  assert.equal(affectedBySemver('1.2.4', ranges.ranges), false);
  assert.throws(() => npmRangesForComparison([{ type: 'ECOSYSTEM', events: [{ introduced: '0' }, { fixed: '1.2' }] }]));
});

test('unreviewed advisory identity/content never inherits a backport classification', () => {
  const dependency = { name: 'minimatch', version: '9.0.9', installedDirectory: '/not-used' };
  assert.equal(classifyReviewedMatch({ id: 'GHSA-new-unreviewed' }, dependency, { completed: true }, { completed: true }), null);
  assert.equal(classifyReviewedMatch({ id: 'GHSA-g3hv-75wg-m249', aliases: [], modified: 'changed-content' }, dependency,
    { completed: true, profiles: {}, legacy: [] }, { completed: true }), null);
});

test('CLI refuses stale/ignore/custom-registry bypasses and ambiguous local inputs', () => {
  assert.throws(() => parseAuditArguments(['--database=x']));
  assert.throws(() => parseAuditArguments(['--database-metadata=x']));
  assert.throws(() => parseAuditArguments(['--allow-stale=true']));
  assert.throws(() => parseAuditArguments(['--output=a', '--output=b']));
  assert.throws(() => parseAuditArguments(['--registry=https://private.invalid']));
  assert.equal(Object.keys(parseAuditArguments(['--database=a', '--database-metadata=b', '--output=c'])).length, 3);
});
