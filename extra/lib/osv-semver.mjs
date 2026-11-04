// OSV SEMVER intervals use precedence comparisons, including prereleases.
// The full relevant record is validated even if one union branch already matches.
const fail = () => { throw new Error('Unsupported or malformed relevant OSV SEMVER data'); };
const numeric = text => /^[0-9]+$/.test(text);
const compareNumber = (left, right) => left.length === right.length
  ? (left === right ? 0 : left < right ? -1 : 1)
  : left.length < right.length ? -1 : 1;

export function parseVersion(value) {
  if (typeof value !== 'string' || value.length > 1024) fail();
  const match = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(value);
  if (!match || match[0] !== value) fail();
  const prerelease = match[4] ? match[4].split('.') : [];
  if (prerelease.some(part => numeric(part) && part.length > 1 && part[0] === '0')) fail();
  return { core: [match[1], match[2], match[3]], prerelease, build: match[5] ? match[5].split('.') : [] };
}

function compareParsed(left, right) {
  for (let i = 0; i < 3; i++) {
    const comparison = compareNumber(left.core[i], right.core[i]);
    if (comparison) return comparison;
  }
  const a = left.prerelease, b = right.prerelease;
  if (!a.length || !b.length) return a.length === b.length ? 0 : a.length ? -1 : 1;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i] === b[i]) continue;
    const aNumeric = numeric(a[i]), bNumeric = numeric(b[i]);
    if (aNumeric && bNumeric) return compareNumber(a[i], b[i]);
    if (aNumeric !== bNumeric) return aNumeric ? -1 : 1;
    return a[i] < b[i] ? -1 : 1;
  }
  return a.length === b.length ? 0 : a.length < b.length ? -1 : 1;
}

export function compareVersions(left, right) {
  return compareParsed(parseVersion(left), parseVersion(right));
}

/** Adapt only npm-labelled ECOSYSTEM ranges before strict SemVer comparison. */
export function npmRangesForComparison(ranges = []) {
  if (!Array.isArray(ranges)) fail();
  const adaptations = [];
  const converted = ranges.map((range, rangeIndex) => {
    if (!range || range.type !== 'ECOSYSTEM') return range;
    if (!Array.isArray(range.events) || !range.events.length) fail();
    const events = range.events.map(event => {
      if (!event || typeof event !== 'object' || Array.isArray(event)) fail();
      const fields = Object.keys(event);
      if (fields.length !== 1 || !['introduced', 'fixed', 'last_affected', 'limit'].includes(fields[0])) fail();
      const field = fields[0], raw = event[field];
      let value = raw;
      if (!(field === 'introduced' && raw === '0')) {
        // npm ECOSYSTEM can publish a partial introduction such as "13.0".
        // Starting at its earliest prerelease over-reports an ambiguous lower
        // bound instead of missing vulnerable prereleases. Partial upper bounds
        // and other formats stay unsupported; never coerce them into a fix.
        const partial = typeof raw === 'string'
          ? /^(0|[1-9][0-9]*)(?:\.(0|[1-9][0-9]*))?$/.exec(raw) : null;
        if (field === 'introduced' && partial && partial[0] === raw) {
          value = `${partial[1]}.${partial[2] ?? '0'}.0-0`;
        } else parseVersion(raw);
      }
      return { [field]: value };
    });
    const comparisonRange = { ...range, type: 'SEMVER', events };
    adaptations.push({ rangeIndex, adapter: 'npm-ecosystem-conservative-semver-v1',
      originalRange: range, comparisonRange,
      policy: 'Strict full SemVer boundaries; only partial numeric introduced bounds become the earliest prerelease in that prefix. Partial upper bounds and other formats remain unsupported.' });
    return comparisonRange;
  });
  return { ranges: converted, adaptations };
}

export function affectedBySemver(version, ranges = [], versions = []) {
  const installed = parseVersion(version);
  if (!Array.isArray(ranges) || !Array.isArray(versions) || !ranges.length && !versions.length) fail();
  // Build metadata does not establish a fix. Equal precedence is conservatively affected.
  let affected = versions.map(parseVersion).some(candidate => compareParsed(installed, candidate) === 0);
  for (const range of ranges) {
    if (!range || range.type !== 'SEMVER' || !Array.isArray(range.events) || !range.events.length) fail();
    let start;
    let open = false;
    for (const event of range.events) {
      if (!event || typeof event !== 'object' || Array.isArray(event)) fail();
      const fields = Object.keys(event);
      if (fields.length !== 1 || !['introduced', 'fixed', 'last_affected', 'limit'].includes(fields[0])) fail();
      const field = fields[0], raw = event[field];
      if (field === 'introduced') {
        if (open) fail();
        start = raw === '0' ? null : parseVersion(raw);
        open = true;
      } else {
        if (!open) fail();
        const end = parseVersion(raw);
        if (start !== null && compareParsed(start, end) > 0) fail();
        const lower = start === null || compareParsed(installed, start) >= 0;
        const comparison = compareParsed(installed, end);
        const upper = field === 'last_affected' ? comparison <= 0 : comparison < 0;
        affected ||= lower && upper;
        open = false;
      }
    }
    if (open && (start === null || compareParsed(installed, start) >= 0)) affected = true;
  }
  return affected;
}
