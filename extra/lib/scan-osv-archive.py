"""Read a complete public OSV ZIP without extraction or third-party Python packages."""
import datetime
import json
import re
import sys
import urllib.parse
import zipfile
import zlib
from pathlib import Path


def require(condition, reason):
    if not condition:
        raise ValueError(reason)


def invalid_constant(_value):
    raise ValueError('Invalid nonfinite JSON constant')


def unique_object(items):
    result = {}
    for key, value in items:
        require(key not in result, 'Duplicate JSON object key')
        result[key] = value
    return result


def date_value(value):
    require(isinstance(value, str), 'Invalid OSV date')
    match = re.fullmatch(r'(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})', value)
    require(match is not None, 'Invalid OSV date')
    offset = re.search(r'[+-](\d{2}):(\d{2})$', value)
    require(offset is None or int(offset[1]) <= 23 and int(offset[2]) <= 59, 'Invalid OSV timezone offset')
    # Python3.10 only accepts3/6 fractional digits; public OSV uses up to9.
    # Normalize this validation-only value to microseconds, matching newer
    # Python precision. The original record, bytes, CRC and review hash stay intact.
    fraction = '.' + match[2][:6].ljust(6, '0') if match[2] else ''
    zone = '+00:00' if match[3] == 'Z' else match[3]
    normalized = match[1] + fraction + zone
    return datetime.datetime.fromisoformat(normalized).timestamp() * 1000


def repository_only(affected):
    ranges = affected.get('ranges')
    require(isinstance(ranges, list) and bool(ranges), 'Package-less affected entry needs GIT ranges')
    for item in ranges:
        require(isinstance(item, dict) and item.get('type') == 'GIT', 'Package-less affected entry must be GIT-only')
        repo = item.get('repo')
        require(isinstance(repo, str) and 0 < len(repo) <= 4096, 'Invalid GIT repository')
        parsed = urllib.parse.urlparse(repo)
        require(parsed.scheme in ('http', 'https', 'git', 'ssh') and bool(parsed.hostname), 'Invalid GIT repository URL')
        events = item.get('events')
        require(isinstance(events, list) and bool(events) and isinstance(events[0], dict) and 'introduced' in events[0], 'Invalid GIT events')
        for event in events:
            require(isinstance(event, dict) and len(event) == 1, 'Invalid GIT event')
            field, value = next(iter(event.items()))
            require(field in ('introduced', 'fixed', 'last_affected', 'limit') and isinstance(value, str)
                    and ((field == 'introduced' and value == '0') or re.fullmatch(r'[a-fA-F0-9]{7,64}', value)), 'Invalid GIT event boundary')
    if 'versions' in affected:
        require(isinstance(affected['versions'], list) and all(isinstance(v, str) and 0 < len(v) <= 1024 and not re.search(r'[\x00-\x1f\x7f]', v) for v in affected['versions']), 'Invalid GIT release tags')


def validate(record, filename, now):
    require(isinstance(record, dict), 'Invalid OSV record')
    identity = record.get('id')
    require(isinstance(identity, str) and re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._:-]{0,199}', identity), 'Invalid OSV id')
    require(filename == identity + '.json', 'OSV filename/id mismatch')
    schema = record.get('schema_version')
    require(schema is None or isinstance(schema, str) and re.fullmatch(r'1\.\d+\.\d+', schema), 'Unsupported OSV schema')
    date_value(record.get('modified'))
    if 'published' in record:
        date_value(record['published'])
    aliases = record.get('aliases', [])
    require(isinstance(aliases, list) and all(isinstance(alias, str) and len(alias) <= 250 for alias in aliases), 'Invalid OSV aliases')
    withdrawn = 'withdrawn' in record
    if withdrawn:
        require(date_value(record['withdrawn']) <= now, 'Future OSV withdrawal')
    affected = record.get('affected')
    require(isinstance(affected, list), 'Missing OSV affected array')
    repository_count = 0
    npm_names = []
    for item in affected:
        require(isinstance(item, dict), 'Invalid OSV affected entry')
        if 'package' not in item:
            repository_only(item)
            repository_count += 1
            continue
        package = item['package']
        require(isinstance(package, dict), 'Invalid OSV package')
        ecosystem = package.get('ecosystem')
        name = package.get('name')
        require(isinstance(ecosystem, str) and 0 < len(ecosystem.strip()) <= 256 and not re.search(r'[\x00-\x1f\x7f]', ecosystem), 'Invalid OSV ecosystem')
        require(isinstance(name, str) and 0 < len(name.strip()) and len(name) <= 4096 and not re.search(r'[\x00-\x1f\x7f]', name), 'Invalid OSV package name')
        if ecosystem == 'npm':
            npm_names.append(name)
    return withdrawn, repository_count, npm_names


def emit(value):
    print(json.dumps(value, ensure_ascii=False, separators=(',', ':')), flush=True)


def scan(path, config):
    limits = config['limits']
    now = config['now']
    wanted = set(config['names'])
    require(path.is_file() and path.stat().st_size <= limits['archiveBytes'], 'Invalid/oversized OSV archive')
    stats = dict(centralDirectoryEntries=0, processedEntries=0, inflatedBytes=0, withdrawnRecords=0,
                 repositoryOnlyAffectedEntries=0, crc32VerifiedEntries=0, knownBracesAdvisoryPresent=False, completed=False)
    names = set()
    with zipfile.ZipFile(path) as archive:
        entries = archive.infolist()
        stats['centralDirectoryEntries'] = len(entries)
        require(limits['minimumEntries'] <= len(entries) <= limits['entries'], 'Unexpected OSV entry count')
        for entry in entries:
            require(re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}\.json', entry.filename), 'Unexpected OSV ZIP entry')
            require(entry.filename not in names, 'Duplicate OSV ZIP entry')
            names.add(entry.filename)
            require(entry.compress_type in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED) and not entry.flag_bits & 1, 'Unsupported ZIP compression/encryption')
            require(0 < entry.file_size <= limits['entryBytes'], 'OSV entry exceeds size limit')
            stats['inflatedBytes'] += entry.file_size
            require(stats['inflatedBytes'] <= limits['inflatedBytes'], 'OSV inflated-byte budget exceeded')
            size = 0
            crc = 0
            chunks = []
            with archive.open(entry) as stream:
                while True:
                    chunk = stream.read(min(65536, limits['entryBytes'] + 1 - size))
                    if not chunk:
                        break
                    size += len(chunk)
                    require(size <= entry.file_size and size <= limits['entryBytes'], 'OSV stream exceeds size')
                    crc = zlib.crc32(chunk, crc)
                    chunks.append(chunk)
            require(size == entry.file_size and crc & 0xffffffff == entry.CRC, 'OSV entry size/CRC mismatch')
            stats['crc32VerifiedEntries'] += 1
            record = json.loads(b''.join(chunks).decode('utf-8'), object_pairs_hook=unique_object, parse_constant=invalid_constant)
            withdrawn, repository_count, npm_names = validate(record, entry.filename, now)
            stats['repositoryOnlyAffectedEntries'] += repository_count
            stats['withdrawnRecords'] += int(withdrawn)
            if 'GHSA-vfj7-8cjw-p6xm' in [record['id']] + record.get('aliases', []) and 'braces' in npm_names:
                stats['knownBracesAdvisoryPresent'] = True
            if wanted.intersection(npm_names):
                emit(dict(type='record', record=record, withdrawn=withdrawn))
            stats['processedEntries'] += 1
        require(stats['processedEntries'] == stats['centralDirectoryEntries'], 'Incomplete OSV scan')
        require(not limits['requireKnownAdvisory'] or stats['knownBracesAdvisoryPresent'], 'OSV public anchor is absent')
        stats['completed'] = True
        emit(dict(type='completed', stats=stats))


if __name__ == '__main__':
    try:
        scan(Path(sys.argv[1]), json.load(sys.stdin, object_pairs_hook=unique_object))
    except Exception as error:
        print(type(error).__name__ + ': ' + str(error)[:500], file=sys.stderr)
        sys.exit(1)
