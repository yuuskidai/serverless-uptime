import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';

// Exact reviewed advisory/source identities, never a name/version-only waiver.
const CONTRACT = {
  "glob": {
    "securityManifestSha256": "35fd6b2b2f2e0736846a996d89c5e27e7105fd10a4c453447c014307c7fdbf8c",
    "advisoryId": "GHSA-3g3m-2fjr-6pw4",
    "canonicalSha256": "9979a966558ddd4ba8b2d8c432e5604a5619123614db2278ffefbd2fcd45f113"
  },
  "minimatch": {
    "securityManifestSha256": "43ba06c986ae18e4d691cfb313a95d24b9af04d34284cde38e2019f313b49ae2",
    "advisoryId": "GHSA-g3hv-75wg-m249",
    "canonicalSha256": "cc73e968e3d8f0127835fb904dabc45475ce8adee1a1ebc42546e61654d97007"
  },
  "minimatch-3.1.5": {
    "files": {
      "package.json": "eefa1c89527d52bbb2e8b053fe8ecf3e3ced399bdba82cf27e0e92edfd833938",
      "minimatch.js": "746849f267c4868a53729225bd85c7dccd387712136fb305fcc0a3eadd4a3d9d"
    },
    "archiveSha256": "d81817ecf72de3c8c5d3724407752d943c9e1a42af5c437d9cb923be8a72c648",
    "registry": {
      "name": "minimatch",
      "version": "3.1.5",
      "license": "ISC",
      "engines": {
        "node": "*"
      },
      "dependencies": {
        "brace-expansion": "^1.1.7"
      },
      "dist": {
        "url": "https://registry.npmjs.org/minimatch/-/minimatch-3.1.5.tgz",
        "integrity": "sha512-VgjWUsnnT6n+NUk6eZq77zeFdpW2LWDzP6zFGrCbHXiYNul5Dzqk2HHQ5uFH2DNW5Xbp8+jVzaeNt94ssEEl4w==",
        "sha256": "d81817ecf72de3c8c5d3724407752d943c9e1a42af5c437d9cb923be8a72c648"
      }
    }
  },
  "minimatch-5.1.9": {
    "files": {
      "package.json": "dc1b9424c2ec4c845ba05e7402f7d22807f4ac85d31725892fd3dcafaa08f800",
      "minimatch.js": "1339bca8b70e33847860daa8fc3ccfa62487e143670da01a3b718d40d5fd424f"
    },
    "archiveSha256": "67e7dacfba9fcabb6ac661620b67e6c22600b4aa56ffa14431cbdfdeebbd4cfe",
    "registry": {
      "name": "minimatch",
      "version": "5.1.9",
      "dist": {
        "shasum": "1293ef15db0098b394540e8f9f744f9fda8dee4b",
        "tarball": "https://registry.npmjs.org/minimatch/-/minimatch-5.1.9.tgz",
        "fileCount": 6,
        "integrity": "sha512-7o1wEA2RyMP7Iu7GNba9vc0RWWGACJOCZBJX2GJWip0ikV+wcOsgVuY9uE8CPiyQhkGFSlhuSkZPavN7u1c2Fw==",
        "signatures": [
          {
            "sig": "MEUCIQDMZPEZGke1MxDoxcV04xps/y9Kk+iVNN1cPhmGsdSvLwIgF0QACHWl1SLxTpq9E+P281itO/rD0E6NU0R7X3inOQw=",
            "keyid": "SHA256:DhQ8wR5APBvFHLF/+Tc+AYvPOdTpcIDqOhxsBHRwC7U"
          }
        ],
        "unpackedSize": 42367
      },
      "archiveSha256": "67e7dacfba9fcabb6ac661620b67e6c22600b4aa56ffa14431cbdfdeebbd4cfe"
    }
  }
};
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const inside = (root, path) => { const rel = relative(root, path); return rel === '' || rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel); };
function filesUnder(directory, prefix = '') {
  const files = [];
  for (const entry of readdirSync(join(directory, prefix), { withFileTypes: true })) {
    if (entry.name === 'node_modules' || !prefix && entry.name === 'SECURITY_PATCH.json') continue;
    assert.ok(!entry.isSymbolicLink(), 'Unreviewed symlink in patched source');
    const path = prefix ? prefix + '/' + entry.name : entry.name;
    if (entry.isDirectory()) files.push(...filesUnder(directory, path)); else files.push(path);
  }
  return files.sort();
}
function verifySource(directory, manifest, pin, requireMetadata = false) {
  // npm packs the declared dist plus mandatory package/license/readme files;
  // provenance stays pinned at the vendor source even when metadata is omitted.
  const metadata = join(directory, 'SECURITY_PATCH.json');
  if (requireMetadata || existsSync(metadata)) assert.equal(sha(readFileSync(metadata)), pin.securityManifestSha256, 'Patch review manifest changed');
  const expected = Object.keys(manifest.files).sort();
  assert.deepEqual(filesUnder(directory), expected, 'Patch source file inventory changed');
  for (const path of expected) {
    assert.ok(path && !path.split('/').includes('..') && !isAbsolute(path), 'Invalid patch source path');
    assert.equal(sha(readFileSync(join(directory, path))), manifest.files[path], 'Reviewed patch source changed');
  }
}

/** Verify fixed vendor and every actual installed occurrence before any advisory classification. */
export function verifyLegacyPatches(root, inventory) {
  assert.ok(inventory && Array.isArray(inventory.packages), 'Complete dependency inventory is required');
  const result = { completed: true, profiles: {}, legacy: [] };
  for (const name of ['glob', 'minimatch']) {
    const pin = CONTRACT[name], vendor = realpathSync(join(root, 'vendor', name));
    assert.ok(inside(realpathSync(root), vendor), 'Patch vendor escapes repository');
    const manifestBytes = readFileSync(join(vendor, 'SECURITY_PATCH.json'));
    assert.equal(sha(manifestBytes), pin.securityManifestSha256, 'Patch metadata changed');
    const manifest = JSON.parse(manifestBytes);
    assert.equal(manifest.name, name, 'Patch name changed');
    assert.equal(manifest.advisoryId, pin.advisoryId, 'Patch advisory changed');
    verifySource(vendor, manifest, pin, true);
    const directories = [];
    for (const dependency of inventory.packages.filter(item => item.name === name && item.version === manifest.version)) {
      assert.ok(dependency.installedDirectory, 'Patched dependency is not installed');
      const directory = realpathSync(dependency.installedDirectory);
      verifySource(directory, manifest, pin);
      if (!directories.includes(directory)) directories.push(directory);
    }
    assert.ok(directories.length, 'Reviewed patch has no installed consumer');
    result.profiles[name] = { name, version: manifest.version, vendor, verified: true,
      advisoryId: pin.advisoryId, canonicalSha256: pin.canonicalSha256,
      securityManifestSha256: pin.securityManifestSha256, directories: directories.sort() };
  }
  // These legacy implementations do not contain the affected level-two optimizer.
  // Keep the raw OSV hit and accept only the reviewed source hashes and exact GHSA.
  for (const dependency of inventory.packages.filter(item => item.name === 'minimatch' && ['3.1.5', '5.1.9'].includes(item.version))) {
    assert.ok(dependency.installedDirectory, 'Reviewed legacy matcher is not installed');
    const directory = realpathSync(dependency.installedDirectory), pin = CONTRACT['minimatch-' + dependency.version];
    for (const [path, digest] of Object.entries(pin.files)) assert.equal(sha(readFileSync(join(directory, path))), digest, 'Legacy matcher source changed');
    assert.ok(!readFileSync(join(directory, 'minimatch.js'), 'utf8').includes('optimizationLevel'), 'Legacy matcher unexpectedly contains optimizer');
    if (!result.legacy.some(item => item.directory === directory)) result.legacy.push({ version: dependency.version, directory, verified: true, files: pin.files });
  }
  result.legacy.sort((a, b) => a.directory.localeCompare(b.directory));
  return result;
}

/** Waive only an unchanged known advisory after source verification and actual regressions. */
export function classifyReviewedMatch(record, dependency, verification, regression) {
  const pin = CONTRACT[dependency.name];
  if (!pin || !verification?.completed || !dependency.installedDirectory) return null;
  if (record.id !== pin.advisoryId || sha(JSON.stringify(record)) !== pin.canonicalSha256
    || [record.id, ...(record.aliases ?? [])].filter(id => id.startsWith('GHSA-')).some(id => id !== pin.advisoryId)) return null;
  const directory = realpathSync(dependency.installedDirectory), profile = verification.profiles[dependency.name];
  const expectedCases = { glob: 10, minimatch: 6 }[dependency.name];
  if (profile?.verified && profile.version === dependency.version && profile.directories.includes(directory)
    && regression?.completed === true && regression.results?.some(result => result.name === dependency.name
      && result.directory === directory && result.completed === true && result.cases === expectedCases)) {
    return { classification: 'reviewed_patched', reason: 'Exact reviewed advisory JSON SHA256, full vendor/installed source hashes and actual installed consumer regressions verified.' };
  }
  if (dependency.name === 'minimatch' && verification.legacy.some(item => item.version === dependency.version && item.directory === directory && item.verified)
    && regression?.completed === true && regression.results?.some(result => result.name === 'minimatch-legacy'
      && result.directory === directory && result.version === dependency.version && result.completed === true && result.cases === 4)) {
    return { classification: 'reviewed_not_affected', reason: 'Exact minimatch3/5 source hashes and known advisory content; this reviewed implementation has no affected level-two optimizer. Raw OSV version match is retained.' };
  }
  return null;
}
