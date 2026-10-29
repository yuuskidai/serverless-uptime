import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTs, sqliteEnv } from './helpers.mjs';

const { renderRssFeed } = loadTs('rss-feed');
const snapshot = minutes => JSON.stringify([{ interval_minutes: minutes }]);
const cases = [
  ['known pre-cutover interpretation remains one minute', 5, 2, 2, 1, null, null, 60000, true],
  ['two-minute observations are consecutive', 1, 2, 2, 2, snapshot(2), snapshot(2), 120000, true],
  ['missing expected two-minute observation breaks streak', 1, 2, 2, 2, snapshot(2), snapshot(2), 240000, false],
  ['snapshot preserves other historical intervals', 1, 2, 2, 1, snapshot(1), snapshot(1), 60000, true],
  ['unrelated legacy keeps its prior current-interval interpretation', 1, 2, 2, 1, null, null, 120000, true],
  ['target later legacy revision without snapshot remains unknown', 5, 3, 2, 2, null, null, 120000, false],
  ['conflicting per-row intervals cannot bridge a streak', 1, 2, 2, 2, snapshot(1), snapshot(2), 120000, false],
  ['invalid snapshot cannot fall back to current interval', 1, 2, 2, 2, snapshot(2), '[{"interval_minutes":"2"}]', 120000, false],
];

for (const [name,id,currentRevision,interval,revision,firstTrace,secondTrace,gap,expected] of cases) test(`RSS ${name}`, async () => {
  const f = sqliteEnv();
  try {
    f.env.DB.withSession = () => f.env.DB;
    if (id !== 1) f.sqlite.prepare("INSERT INTO monitors(id,name,url,created_at) VALUES (?,'Synthetic','https://example.invalid',0)").run(id);
    f.sqlite.prepare('UPDATE monitors SET config_revision=?,interval_minutes=? WHERE id=?').run(currentRevision,interval,id);
    const slot = Math.floor((Date.now()-600000)/120000)*120000;
    const insert = f.sqlite.prepare("INSERT INTO checks(monitor_id,status,status_code,ts,scheduled_slot,config_revision,probe_trace_json) VALUES (?,'down',503,?,?,?,?)");
    insert.run(id,slot+57000,slot,revision,firstTrace);
    insert.run(id,slot+gap+57000,slot+gap,revision,secondTrace);
    const xml = await (await renderRssFeed(f.env,new URL('https://status.example.invalid/rss.xml'))).text();
    assert.equal(xml.includes('<item>'),expected);
  } finally { f.close(); }
});
