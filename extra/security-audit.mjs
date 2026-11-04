import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readFileSync, realpathSync, readdirSync, statSync } from 'node:fs';
import { mkdir, mkdtemp, open, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { affectedBySemver, npmRangesForComparison, parseVersion } from './lib/osv-semver.mjs';
import { verifyLegacyPatches, classifyReviewedMatch } from './lib/legacy-patch-review.mjs';

export const OSV_URL = 'https://osv-vulnerabilities.storage.googleapis.com/npm/all.zip';
export const LIMITS = Object.freeze({ archiveBytes: 512 * 1024 * 1024, entryBytes: 16 * 1024 * 1024,
  inflatedBytes: 2 * 1024 * 1024 * 1024, entries: 500_000, minimumEntries: 1000,
  maximumAgeMs: 48 * 60 * 60 * 1000, futureToleranceMs: 5 * 60 * 1000, requireKnownAdvisory: true });
const DEFAULT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const sha = value => createHash('sha256').update(value).digest('hex');
const packageName = value => typeof value === 'string' && value.length <= 214 && value.trim() === value
  && !/[\x00-\x1f\x7f]/.test(value) && /^(?:@[A-Za-z0-9_.~-]+\/)?[A-Za-z0-9_.~-]+$/.test(value);
function dateValue(value, label) {
  assert.equal(typeof value, 'string', `Missing/invalid ${label}`);
  const time = Date.parse(value);
  assert.ok(Number.isFinite(time), `Invalid ${label}`);
  return time;
}

export function verifyFreshness(lastModified, now = Date.now(), limits = LIMITS) {
  const time = dateValue(lastModified, 'database modification timestamp');
  assert.ok(time <= now + limits.futureToleranceMs, 'Database timestamp is in the future');
  assert.ok(now - time <= limits.maximumAgeMs, 'Database is stale; obtain a fresh public snapshot');
  return new Date(time).toISOString();
}

export async function hashFile(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

/** The only network request is this fixed public GET; no lock/name/version/body is sent. */
export async function downloadPublicDatabase(destination, { fetchImpl = fetch, now = Date.now(), limits = LIMITS } = {}) {
  assert.ok(!existsSync(destination), 'Database destination already exists');
  const response = await fetchImpl(OSV_URL, { method: 'GET', redirect: 'error', credentials: 'omit',
    headers: { Accept: 'application/zip', 'Cache-Control': 'no-cache' }, signal: AbortSignal.timeout(120_000) });
  let lengthText, bytes, lastModified;
  try {
    assert.equal(response.status, 200, `Public OSV snapshot download failed: HTTP ${response.status}`);
    assert.ok(!response.url || response.url === OSV_URL, 'Unexpected public database origin');
    lengthText = response.headers.get('content-length');
    assert.ok(typeof lengthText === 'string' && /^[1-9][0-9]*$/.test(lengthText), 'Missing/invalid public snapshot Content-Length');
    bytes = Number(lengthText);
    assert.ok(Number.isSafeInteger(bytes) && bytes <= limits.archiveBytes, 'Public snapshot exceeds size limit');
    assert.ok([null, 'identity'].includes(response.headers.get('content-encoding')), 'Unexpected snapshot content encoding');
    lastModified = response.headers.get('last-modified');
    verifyFreshness(lastModified, now, limits);
    assert.ok(response.body, 'Public database response is empty');
  } catch (error) {
    await response.body?.cancel().catch(() => {});
    throw error;
  }
  const temporary = destination + '.partial';
  const hash = createHash('sha256');
  let written = 0;
  const file = await open(temporary, 'wx');
  try {
    for await (const value of response.body) {
      const chunk = Buffer.from(value);
      written += chunk.length;
      assert.ok(written <= bytes && written <= limits.archiveBytes, 'Snapshot body exceeds declared size');
      hash.update(chunk);
      let offset = 0;
      while (offset < chunk.length) {
        const { bytesWritten } = await file.write(chunk, offset, chunk.length - offset);
        assert.ok(bytesWritten > 0, 'Snapshot write did not advance');
        offset += bytesWritten;
      }
    }
    assert.equal(written, bytes, 'Incomplete public snapshot body');
    await file.sync();
    await file.close();
    await rename(temporary, destination);
  } catch (error) {
    await file.close().catch(() => {});
    await rm(temporary, { force: true });
    throw error;
  }
  return { source: OSV_URL, method: 'GET', requestBodyBytes: 0, dependencyMetadataSent: false,
    credentialsSent: false, startedAt: new Date(now).toISOString(), completedAt: new Date().toISOString(), path: destination,
    bytes, sha256: hash.digest('hex'), responseHeaders: {
      'Content-Length': lengthText, 'Last-Modified': lastModified, ETag: response.headers.get('etag'),
      'x-goog-generation': response.headers.get('x-goog-generation'), 'x-goog-hash': response.headers.get('x-goog-hash'),
    } };
}

export async function databaseProvenance(path, metadataPath, now, limits) {
  assert.ok(metadataPath, 'Local database requires a publisher GET receipt');
  const stat = statSync(path);
  assert.ok(stat.isFile() && stat.size > 0 && stat.size <= limits.archiveBytes, 'Missing/oversized database file');
  const digest = await hashFile(path);
  if (metadataPath) {
    const metadata = JSON.parse(readFileSync(metadataPath, 'utf8'));
    assert.equal(metadata.source, OSV_URL, 'Unexpected database provenance source');
    assert.equal(metadata.method, 'GET', 'Unexpected database provenance method');
    assert.equal(metadata.requestBodyBytes, 0, 'Unexpected database provenance request body');
    assert.equal(metadata.dependencyMetadataSent, false, 'Unverified dependency metadata privacy');
    assert.equal(metadata.credentialsSent, false, 'Unverified credential privacy');
    assert.ok(typeof metadata.sha256 === 'string' && /^[a-f0-9]{64}$/.test(metadata.sha256), 'Invalid database SHA256');
    assert.ok(Number.isSafeInteger(metadata.bytes), 'Invalid database byte receipt');
    assert.ok(/^[1-9][0-9]*$/.test(metadata.responseHeaders?.['Content-Length']), 'Invalid database Content-Length receipt');
    assert.equal(metadata.sha256, digest, 'Database hash disagrees with provenance');
    assert.equal(metadata.bytes, stat.size, 'Database size disagrees with provenance');
    assert.equal(Number(metadata.responseHeaders?.['Content-Length']), stat.size, 'Database Content-Length mismatch');
    const modified = verifyFreshness(metadata.responseHeaders?.['Last-Modified'], now, limits);
    return { ...metadata, path, explicitLocalInput: true, metadataPath,
      metadataSha256: sha(readFileSync(metadataPath)), publisherLastModified: modified, localMtime: stat.mtime.toISOString() };
  }
  throw new Error('Local database requires a publisher GET receipt');
}

function inside(root, path) {
  const relation = relative(root, path);
  return relation === '' || relation !== '..' && !relation.startsWith('..' + sep) && !isAbsolute(relation);
}
function localPath(root, locator) {
  assert.equal(typeof locator, 'string', 'Missing local dependency target');
  assert.ok(locator && !locator.includes('\\') && !isAbsolute(locator) && !/^[A-Za-z][A-Za-z0-9+.-]*:/.test(locator), 'Unsupported local dependency target');
  const location = realpathSync(resolve(root, locator));
  assert.ok(inside(root, location) && location !== root, 'Local dependency escapes repository');
  assert.ok(statSync(location).isDirectory(), 'Local dependency must be a directory');
  return location;
}
function manifestAt(directory) {
  const path = join(directory, 'package.json'), bytes = readFileSync(path);
  assert.ok(bytes.length <= 1024 * 1024, 'Package manifest exceeds size limit');
  const value = JSON.parse(bytes);
  assert.ok(packageName(value.name), 'Package manifest has no canonical name');
  parseVersion(value.version);
  return { value, path, sha256: sha(bytes) };
}
function inferName(locator) {
  const name = locator.slice(locator.lastIndexOf('node_modules/') + 'node_modules/'.length);
  assert.ok(packageName(name), 'Invalid installed package locator');
  return name;
}
function resolveLocked(packages, from, name) {
  let current = from;
  for (;;) {
    const candidate = (current ? current + '/' : '') + 'node_modules/' + name;
    if (Object.hasOwn(packages, candidate)) return candidate;
    if (!current) return null;
    current = current.includes('/node_modules/') ? current.slice(0, current.lastIndexOf('/node_modules/')) : '';
  }
}

/** Inventory every locked root package and its installed identity; unresolved file/link entries fail closed. */
export function loadRootInventory(root = DEFAULT_ROOT) {
  root = realpathSync(root);
  const lockPath = join(root, 'package-lock.json'), source = readFileSync(lockPath);
  assert.ok(source.length <= 64 * 1024 * 1024, 'Lockfile exceeds size limit');
  const lock = JSON.parse(source);
  assert.ok([2, 3].includes(lock.lockfileVersion) && object(lock.packages) && object(lock.packages['']), 'Unsupported or incomplete npm lock');
  const project = manifestAt(root);
  assert.equal(lock.packages[''].name ?? lock.name, project.value.name, 'Root package name differs from lock');
  assert.equal(lock.packages[''].version ?? lock.version, project.value.version, 'Root package version differs from lock');
  for (const kind of ['dependencies', 'devDependencies', 'optionalDependencies']) {
    assert.deepEqual(lock.packages[''][kind] ?? {}, project.value[kind] ?? {}, 'Root dependency declarations differ from lock');
  }
  const packages = [], localSources = [], links = new Map(), manifests = new Map([[project.path, project.sha256]]);
  for (const [locator, entry] of Object.entries(lock.packages)) {
    assert.ok(object(entry), 'Invalid lock package entry');
    if (locator === '') continue;
    assert.ok(locator && !locator.includes('\\') && !locator.split('/').includes('..') && !isAbsolute(locator), 'Invalid lock package path');
    if (entry.link === true) {
      assert.ok(locator.startsWith('node_modules/'), 'Linked dependency needs an installed locator');
      links.set(locator, localPath(root, entry.resolved));
    }
  }
  for (const [locator, entry] of Object.entries(lock.packages)) {
    if (locator === '') continue;
    if (!locator.startsWith('node_modules/')) {
      const location = localPath(root, locator);
      assert.ok([...links.values()].includes(location), 'Unreferenced local source in lock');
      const sourceManifest = manifestAt(location);
      assert.equal(entry.version, sourceManifest.value.version, 'Local source version differs from lock');
      if (entry.name !== undefined) assert.equal(entry.name, sourceManifest.value.name, 'Local source name differs from lock');
      localSources.push({ locator, directory: location, name: sourceManifest.value.name, version: sourceManifest.value.version });
      manifests.set(sourceManifest.path, sourceManifest.sha256);
      continue;
    }
    const inferred = inferName(locator);
    let sourceDirectory = links.get(locator);
    if (!sourceDirectory && typeof entry.resolved === 'string' && entry.resolved.startsWith('file:')) sourceDirectory = localPath(root, entry.resolved.slice(5));
    let sourceManifest;
    if (sourceDirectory) {
      sourceManifest = manifestAt(sourceDirectory);
      manifests.set(sourceManifest.path, sourceManifest.sha256);
    }
    const name = entry.name ?? sourceManifest?.value.name ?? inferred;
    const version = entry.version ?? sourceManifest?.value.version;
    assert.ok(packageName(name), 'Missing canonical locked package name');
    parseVersion(version);
    if (sourceManifest) {
      assert.equal(name, sourceManifest.value.name, 'Local source name differs from lock');
      assert.equal(version, sourceManifest.value.version, 'Local source version differs from lock');
    }
    const installedPath = resolve(root, locator);
    let installedDirectory = null;
    if (existsSync(installedPath)) {
      installedDirectory = realpathSync(installedPath);
      assert.ok(inside(root, installedDirectory), 'Installed dependency escapes repository');
      if (entry.link === true) assert.equal(installedDirectory, sourceDirectory, 'Installed link differs from lock');
      const installed = manifestAt(installedDirectory);
      assert.equal(installed.value.name, name, 'Installed package name differs from lock');
      assert.equal(installed.value.version, version, 'Installed package version differs from lock');
      manifests.set(installed.path, installed.sha256);
    } else assert.ok(entry.optional === true, 'Required installed package is absent');
    packages.push({ name, version, locator, lockPath: 'package-lock.json', localDirectory: sourceDirectory ?? null,
      installedDirectory, optionalAbsent: installedDirectory === null });
  }
  assert.ok(packages.length > 0, 'No locked packages');
  // Dependency links cannot silently disappear from an otherwise successful inventory.
  for (const [locator, entry] of Object.entries(lock.packages)) {
    for (const name of Object.keys(entry.dependencies ?? {})) {
      if (Object.hasOwn(entry.optionalDependencies ?? {}, name)) continue;
      assert.ok(packageName(name) && resolveLocked(lock.packages, locator, name), 'Missing required dependency graph edge');
    }
  }
  const observed = new Set();
  const visitModules = (directory, logical = 'node_modules', depth = 0) => {
    assert.ok(depth <= 64, 'Installed dependency graph nesting exceeds limit');
    if (!existsSync(directory)) return;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const children = entry.name.startsWith('@') ? readdirSync(join(directory, entry.name)).map(name => entry.name + '/' + name) : [entry.name];
      for (const child of children) {
        const locator = logical + '/' + child, path = join(directory, child);
        assert.ok(Object.hasOwn(lock.packages, locator), 'Installed package is missing from lock inventory');
        assert.ok(!observed.has(locator), 'Duplicate installed package locator');
        observed.add(locator);
        assert.ok(inside(root, realpathSync(path)), 'Installed package escapes repository');
        visitModules(join(path, 'node_modules'), locator + '/node_modules', depth + 1);
      }
    }
  };
  visitModules(join(root, 'node_modules'));
  return { root, packages, localSources, manifests: [...manifests].map(([path, sha256]) => ({ path, sha256 })),
    locks: [{ path: 'package-lock.json', sha256: sha(source), packageEntries: packages.length }], observedInstalledEntries: observed.size };
}

/** Python3 reads and validates every ZIP member/CRC and emits only relevant public records. */
export async function scanOsvArchive(path, names, onRecord, { limits = LIMITS, now = Date.now() } = {}) {
  const child = spawn('python3', [fileURLToPath(new URL('./lib/scan-osv-archive.py', import.meta.url)), resolve(path)], { stdio: ['pipe', 'pipe', 'pipe'],
    // The local ZIP reader needs no provider credentials or application secrets.
    env: { PATH: process.env.PATH ?? '', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' } });
  let stderr = '', stats;
  child.stderr.on('data', data => { stderr = (stderr + data.toString()).slice(0, 2048); });
  const completion = new Promise((accept, reject) => {
    child.once('error', reject);
    child.once('close', code => code === 0 ? accept() : reject(new Error(`Public OSV ZIP scan failed (${code}): ${stderr}`)));
  });
  // Register rejection now, including an interpreter startup failure before stdout is consumed.
  completion.catch(() => {});
  const timer = setTimeout(() => child.kill('SIGKILL'), 180_000);
  child.stdin.on('error', () => {});
  child.stdin.end(JSON.stringify({ limits, now, names: [...names] }));
  try {
    for await (const line of createInterface({ input: child.stdout, crlfDelay: Infinity })) {
      assert.ok(Buffer.byteLength(line) <= limits.entryBytes * 2, 'OSV scanner output exceeds record limit');
      const message = JSON.parse(line);
      assert.ok(!stats, 'Unexpected output after completed OSV scan');
      if (message.type === 'record') await onRecord(message.record, { withdrawn: message.withdrawn });
      else { assert.equal(message.type, 'completed', 'Invalid OSV scanner message'); stats = message.stats; }
    }
    await completion;
    assert.ok(stats?.completed && stats.processedEntries === stats.centralDirectoryEntries
      && stats.crc32VerifiedEntries === stats.processedEntries, 'Incomplete/unchecked OSV ZIP');
    return stats;
  } catch (error) { child.kill('SIGKILL'); await completion.catch(() => {}); throw error; }
  finally { clearTimeout(timer); }
}

/** Stable loader name for the installed-patch regression harness. */
export const loadLegacyInventory = loadRootInventory;

function assertInventoryStable(root, inventory) {
  assert.deepEqual(loadRootInventory(root), inventory, 'Dependency inventory changed during audit');
  for (const manifest of inventory.manifests) assert.equal(sha(readFileSync(manifest.path)), manifest.sha256, 'Installed/source manifest changed during audit');
}

/** Audit the complete legacy root graph locally; private dependency metadata is never uploaded. */
export async function runSecurityAudit({ root = DEFAULT_ROOT, databasePath, metadataPath,
  output = resolve(root, '.security-audit', 'osv-report.json'), now = Date.now(), limits = LIMITS } = {}) {
  root = realpathSync(root);
  const report = { generatedAt: new Date(now).toISOString(), scope: 'Legacy root package-lock: every production/development/optional package and actual installed occurrence, including reviewed local file dependencies.',
    privacy: 'Only fixed public OSV database GET; no dependency names, versions, lockfiles, credentials or request body are sent.',
    result: 'error', matchingComplete: false, locks: [], database: null, feed: null, matches: [], unsupported: [], comparisonAdapters: [] };
  let temporary, phase = 'inventory';
  try {
    const inventory = loadRootInventory(root);
    report.locks = inventory.locks;
    report.lockedPackageEntries = inventory.packages.length;
    report.observedInstalledEntries = inventory.observedInstalledEntries;
    report.localSources = inventory.localSources;
    phase = 'source_review';
    const verification = verifyLegacyPatches(root, inventory);
    report.patchVerification = verification;
    const { runLegacyPatchRegressions } = await import('./legacy-dependency-regressions.mjs');
    report.patchRegression = await runLegacyPatchRegressions(root, verification);
    assert.ok(report.patchRegression.completed, 'Patch regression did not complete');
    assert.deepEqual(verifyLegacyPatches(root, inventory), verification, 'Patched source changed during regressions');
    assertInventoryStable(root, inventory);
    const index = new Map();
    for (const dependency of inventory.packages) {
      if (!index.has(dependency.name)) index.set(dependency.name, new Map());
      const versions = index.get(dependency.name);
      if (!versions.has(dependency.version)) versions.set(dependency.version, []);
      versions.get(dependency.version).push(dependency);
    }
    report.uniquePackageNames = index.size;
    phase = 'database';
    if (databasePath) {
      assert.ok(metadataPath, 'Local database requires a public publisher GET receipt');
      report.database = await databaseProvenance(resolve(databasePath), resolve(metadataPath), now, limits);
    } else {
      assert.ok(!metadataPath, 'Metadata requires an explicit database path');
      temporary = await mkdtemp(join(tmpdir(), 'legacy-public-osv-'));
      databasePath = join(temporary, 'npm-all.zip');
      report.database = await downloadPublicDatabase(databasePath, { now, limits });
      report.database.publisherLastModified = verifyFreshness(report.database.responseHeaders['Last-Modified'], now, limits);
    }
    const seenMatches = new Set();
    phase = 'matching';
    report.feed = await scanOsvArchive(databasePath, index.keys(), (record, { withdrawn }) => {
      if (withdrawn) return;
      for (const affected of record.affected) {
        if (affected.package?.ecosystem !== 'npm' || !index.has(affected.package.name)) continue;
        for (const [version, occurrences] of index.get(affected.package.name)) {
          let matches;
          try {
            const comparison = npmRangesForComparison(affected.ranges);
            for (const adaptation of comparison.adaptations) report.comparisonAdapters.push({ advisoryId: record.id, package: affected.package.name, version, ...adaptation });
            matches = affectedBySemver(version, comparison.ranges, affected.versions);
          } catch (error) {
            report.unsupported.push({ advisoryId: record.id, package: affected.package.name, version, ranges: affected.ranges ?? [], versions: affected.versions ?? [], reason: error.message });
            continue;
          }
          if (!matches) continue;
          for (const dependency of occurrences) {
            const key = JSON.stringify([record.id, dependency.locator]);
            if (seenMatches.has(key)) continue;
            seenMatches.add(key);
            const reviewed = classifyReviewedMatch(record, dependency, verification, report.patchRegression);
            report.matches.push({ advisoryId: record.id, aliases: record.aliases ?? [], package: dependency.name, version,
              lockPath: dependency.lockPath, locator: dependency.locator, installedDirectory: dependency.installedDirectory,
              localDirectory: dependency.localDirectory, severity: record.database_specific?.severity ?? null,
              osvSeverity: record.severity ?? [], ranges: affected.ranges ?? [], versions: affected.versions ?? [],
              classification: reviewed?.classification ?? 'actionable', reviewReason: reviewed?.reason ?? null });
          }
        }
      }
    }, { limits, now });
    assert.equal(await hashFile(databasePath), report.database.sha256, 'Database changed during local scan');
    assertInventoryStable(root, inventory);
    assert.deepEqual(verifyLegacyPatches(root, inventory), verification, 'Patched source changed during audit');
    report.result = report.unsupported.length ? 'unsupported' : report.matches.some(match => match.classification === 'actionable') ? 'actionable' : 'passed';
  } catch (error) {
    report.error = error.message;
    report.failedPhase = phase;
    if (['inventory', 'source_review'].includes(phase)) {
      report.result = 'unsupported';
      report.unsupported.push({ category: phase === 'inventory' ? 'INVENTORY_UNSUPPORTED' : 'PATCH_REVIEW_INCOMPLETE', reason: error.message });
    }
  } finally {
    report.rawMatchingOccurrences = report.matches.length;
    report.reviewedPatchedOccurrences = report.matches.filter(match => match.classification === 'reviewed_patched').length;
    report.reviewedNotAffectedOccurrences = report.matches.filter(match => match.classification === 'reviewed_not_affected').length;
    report.actionableOccurrences = report.matches.filter(match => match.classification === 'actionable').length;
    report.matchingComplete = !report.error && report.feed?.completed === true && report.unsupported.length === 0;
    report.completedAt = new Date().toISOString();
    report.limitations = [
      'OSV snapshot matching is not npm audit v2 advisory propagation or a proof that no vulnerability or malicious package exists.',
      'Publisher freshness is at most48h; local inputs require an explicit public GET receipt with matching archive SHA256/size. A local receipt is not a publisher digital signature.',
      'Every ZIP JSON and CRC is checked. Invalid metadata, unresolved source identities, missing installed packages and unsupported relevant ranges fail closed.',
      'Raw matches remain visible for exact reviewed backports and source-not-affected legacy matcher classifications; new advisory content is actionable.',
      'Python3 is required for the complete ZIP reader. This command does not audit the separate kuma-lite/security Worker graphs or bundled package-manager runtimes.',
    ];
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, JSON.stringify(report, null, 2) + '\n');
    if (temporary) await rm(temporary, { recursive: true, force: true });
  }
  return report;
}

export function parseAuditArguments(args) {
  const result = {}, seen = new Set();
  for (const argument of args) {
    const match = /^--(database|database-metadata|output)=(.+)$/.exec(argument);
    assert.ok(match && !seen.has(match[1]), 'Usage: node extra/security-audit.mjs [--database=archive.zip --database-metadata=receipt.json] [--output=report.json]');
    seen.add(match[1]);
    result[{ database: 'databasePath', 'database-metadata': 'metadataPath', output: 'output' }[match[1]]] = resolve(match[2]);
  }
  assert.ok(!result.metadataPath || result.databasePath, 'Metadata requires --database');
  assert.ok(!result.databasePath || result.metadataPath, 'Local database requires --database-metadata');
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const report = await runSecurityAudit(parseAuditArguments(process.argv.slice(2)));
    console.log(`Legacy local OSV audit: result=${report.result}; raw=${report.rawMatchingOccurrences}; patched=${report.reviewedPatchedOccurrences}; notAffected=${report.reviewedNotAffectedOccurrences}; actionable=${report.actionableOccurrences}; unsupported=${report.unsupported.length}`);
    if (report.result !== 'passed' || !report.matchingComplete) process.exitCode = 1;
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
