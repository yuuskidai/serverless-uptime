import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTs, sqliteEnv } from './helpers.mjs';

const { historicalIntervalSql, resolveCheckIntervalMs, isDueSlot, nextDueSlot, validIntervalMinutes } = loadTs('check-schedule');
const trace = values => JSON.stringify(values.map(interval_minutes => ({ interval_minutes })));
const cases = [
  ['new snapshot survives settings changes', 1, 3, 5, 1, trace([2]), 120000],
  ['primary and fallback agree', 1, 3, 5, 1, trace([3, 3]), 180000],
  ['JSON real integer agrees with JS integer semantics', 1, 3, 5, 1, '[{"interval_minutes":2.0}]', 120000],
  ['boolean snapshot is not a number', 1, 3, 5, 3, trace([true]), null],
  ['fractional snapshot is unknown', 1, 3, 5, 3, trace([2.5]), null],
  ['snapshot is never a numeric string', 1, 3, 5, 3, trace(['2']), null],
  ['snapshot is bounded', 5, 2, 2, 1, trace([61]), null],
  ['conflicting traces are unknown', 5, 2, 2, 1, trace([1, 2]), null],
  ['partially missing snapshot is unknown', 5, 2, 2, 1, '[{"interval_minutes":2},{}]', null],
  ['null snapshot cannot fall back', 5, 2, 2, 1, trace([null]), null],
  ['malformed trace cannot fall back', 5, 2, 2, 1, '{broken', null],
  ['nonobject trace cannot fall back', 5, 2, 2, 1, '[2]', null],
  ['empty legacy array has no snapshot and preserves frozen interpretation', 5, 2, 2, 1, '[]', 60000],
  ['empty unrelated legacy array keeps monitor-specific interpretation', 1, 3, 5, 1, '[]', 300000],
  ['main legacy interpretation is frozen', 5, 2, 2, 1, '[{}]', 60000],
  ['second main legacy interpretation is frozen', 6, 2, 2, 1, null, 60000],
  ['shadow legacy interpretation through revision3 is frozen', 9, 4, 2, 3, null, 60000],
  ['second shadow legacy interpretation is frozen', 10, 4, 2, 2, null, 60000],
  ['later shadow revision is not frozen', 9, 5, 5, 4, null, null],
  ['matching explicit current revision can resolve', 1, 3, 5, 3, null, 300000],
  ['unrelated old legacy keeps its prior monitor-specific interpretation', 1, 3, 5, 1, null, 300000],
  ['unrelated missing legacy revision keeps its prior interpretation', 1, 1, 1, null, null, 60000],
  ['target later old revision without snapshot stays unknown', 5, 3, 5, 2, null, null],
  ['target current revision without snapshot can resolve', 5, 2, 2, 2, null, 120000],
  ['fractional historical revision is unknown', 9, 4, 2, 1.5, null, null],
  ['invalid current interval is unknown', 1, 2, 1.5, 2, null, null],
];

for (const [name, id, currentRevision, interval, revision, json, expected] of cases) test(name, () => {
  const f = sqliteEnv();
  try {
    if (id !== 1) f.sqlite.prepare("INSERT INTO monitors(id,name,url,created_at) VALUES (?,'Synthetic','https://example.invalid',0)").run(id);
    f.sqlite.prepare('UPDATE monitors SET config_revision=?,interval_minutes=? WHERE id=?').run(currentRevision, interval, id);
    const monitor = f.sqlite.prepare('SELECT * FROM monitors WHERE id=?').get(id);
    f.sqlite.prepare("INSERT INTO checks(monitor_id,status,ts,config_revision,probe_trace_json) VALUES (?,'down',0,?,?)").run(id, revision, json);
    const check = f.sqlite.prepare('SELECT * FROM checks').get();
    assert.equal(resolveCheckIntervalMs(monitor, check), expected);
    assert.equal(f.sqlite.prepare(`SELECT ${historicalIntervalSql('c')} AS ms FROM checks c`).get().ms, expected);
  } finally { f.close(); }
});

test('phase-zero due slots and inclusive next due preserve scheduler semantics', () => {
  for (const minutes of [1, 2, 3, 5, 60]) {
    const interval = minutes * 60000;
    assert.equal(isDueSlot(0, interval), true);
    assert.equal(isDueSlot(interval, interval), true);
    assert.equal(isDueSlot(interval + 1, interval), false);
    assert.equal(nextDueSlot(interval, interval), interval);
    assert.equal(nextDueSlot(interval + 1, interval), interval * 2);
  }
  for (const value of [0, 61, 1.5, '2', null, NaN, Infinity]) assert.equal(validIntervalMinutes(value), null);
  assert.equal(isDueSlot(0, 0), false);
  assert.throws(() => nextDueSlot(0, 0), /Invalid check schedule/);
  assert.throws(() => historicalIntervalSql('checks;DROP'), /Invalid SQL alias/);
});
