import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTs, sqliteEnv } from './helpers.mjs';

const { renderStatusPage } = loadTs('status-page', {
  './external-observations': {
    getExternalSummaries: async () => new Map(),
    CLOUDFLARE_WITNESS_STATUS_URL: 'https://witness.example.invalid/status',
  },
});
const M = 60000;
const BASE = Date.UTC(2026, 9, 29, 4, 0);

function fixture(t, now, id = 1) {
  t.mock.method(Date, 'now', () => now);
  const f = sqliteEnv(); t.after(() => f.close());
  f.env.DB.withSession = () => f.env.DB;
  f.sqlite.prepare('UPDATE monitors SET id=?,config_revision=2,interval_minutes=2 WHERE id=1').run(id);
  f.sqlite.prepare("INSERT INTO monitor_state(monitor_id,current_status) VALUES(?,'up')").run(id);
  f.id = id;
  return f;
}
function sample(f, minute, { status = 'up', revision = 2, trace = [{ interval_minutes: 2 }], ts } = {}) {
  const slot = BASE + minute * M;
  f.sqlite.prepare(`INSERT INTO checks(monitor_id,status,status_code,latency_ms,ts,scheduled_slot,
    config_revision,monitor_role,probe_transport,in_maintenance,probe_trace_json)
    VALUES(?,?,?,?,?,?,?,'availability','service_binding',0,?)`).run(f.id, status,
    status === 'down' ? 503 : 200, 100, ts ?? slot + 57000, slot, revision,
    trace === null ? null : JSON.stringify(trace));
}
async function page(f, scale = '60m') {
  return (await renderStatusPage(f.env, new URL('https://status.example.invalid/?scale=' + scale))).text();
}
function bar(html, slot) {
  const tag = html.match(new RegExp('<(?:a|span)\\b[^>]*data-from="' + slot + '"[^>]*>'))?.[0];
  assert.ok(tag, 'Expected scheduled minute bar');
  const attribute = name => tag.match(new RegExp(name + '="([^"]*)"'))?.[1];
  return { tag, state: attribute('data-state'), provenance: attribute('data-provenance'),
    count: Number(attribute('data-observed-count')), sampleTs: attribute('data-sample-ts') };
}

test('two-minute non-due feet hold only real binary samples without inflating uptime or checks', async t => {
  const f = fixture(t, BASE + 8 * M + 10000);
  sample(f, 4, { status: 'down' }); sample(f, 6);
  const html = await page(f);
  assert.equal(bar(html, BASE + 4 * M).provenance, 'observed');
  const heldDown = bar(html, BASE + 5 * M);
  assert.equal(heldDown.state, 'down'); assert.equal(heldDown.provenance, 'held'); assert.equal(heldDown.count, 0);
  assert.match(heldDown.tag, new RegExp('from=' + (BASE + 4 * M + 57000)));
  assert.equal(bar(html, BASE + 7 * M).state, 'up');
  assert.equal(bar(html, BASE + 7 * M).provenance, 'held');
  assert.equal(bar(html, BASE + 8 * M).state, 'pending');
  assert.match(html, /50\.00%/);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM checks').get().n, 2);
  assert.match(html, /継続表示/);
  assert.match(html, /稼働率（実測）/);
});

test('a missing due slot cannot be carried across into the next non-due minute', async t => {
  const f = fixture(t, BASE + 10 * M + 10000); sample(f, 6);
  const html = await page(f);
  assert.equal(bar(html, BASE + 7 * M).provenance, 'held');
  assert.equal(bar(html, BASE + 8 * M).state, 'none');
  assert.equal(bar(html, BASE + 9 * M).state, 'none');
  assert.equal(bar(html, BASE + 10 * M).state, 'pending');
  // The badge's separate existing3I freshness policy is unchanged.
  assert.match(html, /すべて正常に稼働中/);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM checks').get().n, 1);
});

test('invalid interval metadata never creates a planned healthy held minute', async t => {
  const f = fixture(t, BASE + 8 * M + 10000); sample(f, 6, { trace: [{ interval_minutes: null }] });
  const html = await page(f);
  assert.equal(bar(html, BASE + 6 * M).provenance, 'observed');
  assert.equal(bar(html, BASE + 7 * M).state, 'none');
  assert.equal(bar(html, BASE + 7 * M).provenance, 'missing');
});

test('old revision samples remain real history but cannot bridge an unrecorded revision boundary', async t => {
  const f = fixture(t, BASE + 10 * M + 10000);
  sample(f, 6, { revision: 1 }); sample(f, 8);
  const html = await page(f);
  assert.equal(bar(html, BASE + 6 * M).state, 'up');
  assert.equal(bar(html, BASE + 7 * M).state, 'none');
  assert.equal(bar(html, BASE + 9 * M).provenance, 'held');
});

test('late real samples stay in their scheduled foot and incident links include their actual timestamp', async t => {
  const f = fixture(t, BASE + 8 * M + 20000);
  sample(f, 6, { status: 'down', ts: BASE + 7 * M + 5000 });
  const html = await page(f), observed = bar(html, BASE + 6 * M);
  assert.equal(observed.state, 'down'); assert.equal(observed.count, 1);
  assert.match(observed.tag, new RegExp('to=' + (BASE + 7 * M + 5001)));
  assert.equal(bar(html, BASE + 7 * M).provenance, 'held');
});

test('starts at or after the display grace stay real samples but never backfill the old due foot or become hold anchors', async t => {
  for (const delay of [120000, 125000]) await t.test(`late start ${delay}`, async t => {
    const f = fixture(t, BASE + 8 * M + 20000);
    sample(f, 4, { ts: BASE + 4 * M + delay });
    const html = await page(f);
    assert.equal(bar(html, BASE + 4 * M).state, 'none');
    assert.equal(bar(html, BASE + 5 * M).state, 'none');
    assert.equal(bar(html, BASE + 6 * M).provenance, 'observed_late');
    assert.equal(bar(html, BASE + 6 * M).count, 1);
    assert.equal(bar(html, BASE + 7 * M).state, 'none');
    assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM checks').get().n, 1);
    assert.match(html, /検査開始/);
  });
});

test('known old main one-minute history retains its daily down streak after interval cutover', async t => {
  const f = fixture(t, BASE + 10 * M + 10000, 5);
  sample(f, 2, { status: 'down', revision: 1, trace: null });
  sample(f, 3, { status: 'down', revision: 1, trace: null });
  sample(f, 4, { revision: 1, trace: null }); sample(f, 8);
  const html = await page(f, '30d');
  assert.equal(bar(html, Math.floor(BASE / 86400000) * 86400000).state, 'partial');
  assert.match(html, /50\.00%/);
});

test('all scales identify actual aggregates separately from display-only held results', async t => {
  const f = fixture(t, BASE + 8 * M + 10000); sample(f, 6);
  for (const scale of ['60m', '12h', '24h', '7d', '30d']) {
    const html = await page(f, scale);
    assert.match(html, /data-provenance="observed" data-observed-count="1"/);
    assert.match(html, /実測チェックの成功割合/);
    assert.match(html, /継続表示の分数は含みません/);
  }
});

test('card shows actual probe start and the outstanding nominal slot without advancing state or checks', async t => {
  const f = fixture(t, BASE + 8 * M + 10000); sample(f, 6);
  const before = f.sqlite.prepare('SELECT * FROM monitor_state WHERE monitor_id=1').get();
  const html = await page(f);
  assert.match(html, /最終検査/);
  assert.match(html, /2分ごと/);
  assert.match(html, new RegExp('data-next-due-slot="' + (BASE + 8 * M) + '"'));
  assert.match(html, /（結果未確認）/);
  assert.doesNotMatch(html, /画面更新とは別の予定/);
  assert.deepEqual(f.sqlite.prepare('SELECT * FROM monitor_state WHERE monitor_id=1').get(), before);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM checks').get().n, 1);
});
