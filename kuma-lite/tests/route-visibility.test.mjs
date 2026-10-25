import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTs, sqliteEnv } from './helpers.mjs';

const { renderStatusPage } = loadTs('status-page');
const { renderIncidentPage } = loadTs('incident-page');
const { renderRssFeed } = loadTs('rss-feed');
const { renderStatusBlocks } = loadTs('slack-bot', {
  chat: { Chat: class {} },
  '@chat-adapter/state-memory': { createMemoryState: () => ({}) },
  './chat-adapters/slack': { createSlackAdapter: () => ({}) },
});

function fixture(t) {
  const f = sqliteEnv();
  t.after(() => f.close());
  f.env.DB.withSession = () => f.env.DB;
  f.sqlite.prepare("UPDATE monitors SET name='Public service' WHERE id=1").run();
  f.sqlite.prepare("INSERT INTO monitor_state(monitor_id,current_status) VALUES (1,'up')").run();
  return f;
}
function check(f, { id = 1, ts = Date.now() - 1000, slot = Math.floor(ts / 60000) * 60000, status = 'up', revision = 1, role = 'availability', transport = 'public_fetch' } = {}) {
  f.sqlite.prepare(`INSERT INTO checks(monitor_id,status,ts,scheduled_slot,config_revision,monitor_role,probe_transport,status_code,latency_ms,in_maintenance)
    VALUES (?,?,?,?,?,?,?,?,100,0)`).run(id, status, ts, slot, revision, role, transport, status === 'up' ? 200 : 503);
}
const status = async (f, scale = '60m') => (await renderStatusPage(f.env, new URL('https://status.example.invalid/?scale=' + scale))).text();
const feed = async f => (await renderRssFeed(f.env, new URL('https://status.example.invalid/rss.xml'))).text();
const incident = (f, id, from = Date.now() - 600000, to = Date.now()) => renderIncidentPage(f.env,
  new URL(`https://status.example.invalid/incident?monitor_id=${id}&from=${from}&to=${to}`));

test('internal and shadow monitors cannot appear on status, RSS, incident links or Slack status', async t => {
  const f = fixture(t);
  check(f);
  for (const [id, role] of [[2, 'diagnostic'], [3, 'shadow']]) {
    f.sqlite.prepare(`INSERT INTO monitors(id,name,url,monitor_role,parent_monitor_id,created_at)
      VALUES (?,?,'https://private.example.invalid/healthz',?,1,0)`).run(id, 'PRIVATE-' + role, role);
    f.sqlite.prepare("INSERT INTO monitor_state(monitor_id,current_status) VALUES (?,'down')").run(id);
    check(f, { id, ts: Date.now() - 65000, status: 'down', role });
    check(f, { id, ts: Date.now() - 1000, status: 'down', role });
    assert.equal((await incident(f, id)).status, 404);
  }
  const html = await status(f);
  assert.match(html, /Public service/);
  assert.doesNotMatch(html, /PRIVATE-|private\.example/);
  assert.match(html, /すべて正常に稼働中/);
  assert.doesNotMatch(await feed(f), /PRIVATE-|private\.example/);
  const slack = await renderStatusBlocks(f.env);
  assert.match(slack.text, /All 1 monitors operational/);
  assert.doesNotMatch(JSON.stringify(slack), /PRIVATE-|private\.example/);
});

test('missing, stale, stale-slot and old-revision observations never display a healthy current state', async t => {
  for (const kind of ['missing', 'stale', 'slot', 'revision']) {
    await t.test(kind, async t => {
      const f = fixture(t);
      if (kind === 'stale') check(f, { ts: Date.now() - 190000 });
      if (kind === 'slot') check(f, { slot: Math.floor((Date.now() - 190000) / 60000) * 60000 });
      if (kind === 'revision') { check(f); f.sqlite.prepare('UPDATE monitors SET config_revision=2 WHERE id=1').run(); }
      const html = await status(f);
      assert.match(html, /未確認/);
      assert.match(html, /監視情報が古いか、まだ取得されていません/);
      assert.doesNotMatch(html, /すべて正常に稼働中/);
      const slack = await renderStatusBlocks(f.env);
      assert.match(slack.text, /監視情報未確認/);
      assert.doesNotMatch(slack.text, /operational/);
    });
  }
});

test('public series excludes pre-cutover internal checks including mixed daily summaries', async t => {
  const f = fixture(t);
  const now = Date.now(), today = Math.floor(now / 86400000) * 86400000, cutover = today - 43200000;
  f.sqlite.prepare('UPDATE monitors SET availability_since_ms=? WHERE id=1').run(cutover);
  check(f, { ts: cutover - 120000, status: 'down' });
  check(f, { ts: cutover - 60000, status: 'down' });
  check(f, { ts: cutover + 60000 });
  check(f, { ts: now - 1000 });
  f.sqlite.prepare('INSERT INTO daily_summary(monitor_id,day_ms,ups,downs,maints,down_streak) VALUES (1,?,1,900,0,900)').run(today - 86400000);
  const html = await status(f, '30d');
  assert.match(html, /100\.00%/);
  assert.match(html, /公開HTTPS監視開始/);
  assert.doesNotMatch(await feed(f), /<item>/);
  const old = await incident(f, 1, cutover - 180000, cutover);
  assert.match(await old.text(), /公開HTTPS監視の開始前/);
  assert.equal(f.sqlite.prepare("SELECT count(*) AS n FROM checks WHERE status='down'").get().n, 2);
});

test('RSS consecutive failures use scheduled slots and revision, and report the actual first failure time', async t => {
  const cases = [
    { name: 'missing scheduled slot despite compressed arrivals', gap: 120000, arrival: 1000, sameRevision: true, expected: false },
    { name: 'configuration change', gap: 60000, arrival: 60000, sameRevision: false, expected: false },
    { name: 'contiguous slots despite delayed arrivals', gap: 60000, arrival: 120000, sameRevision: true, expected: true },
  ];
  for (const c of cases) await t.test(c.name, async t => {
    const f = fixture(t);
    const firstTs = Date.now() - 600000, firstSlot = Math.floor(firstTs / 60000) * 60000;
    check(f, { ts: firstTs, slot: firstSlot, status: 'down' });
    check(f, { ts: firstTs + c.arrival, slot: firstSlot + c.gap, status: 'down', revision: c.sameRevision ? 1 : 2 });
    const xml = await feed(f);
    assert.equal(xml.includes('<item>'), c.expected);
    if (c.expected) assert.ok(xml.includes(`kuma-lite:incident:1:${firstTs}:ongoing`));
  });
});

test('fresh confirmed recovery stays operational even when today contains historical failures',async t=>{
 const f=fixture(t),now=Date.now(),today=Math.floor(now/86400000)*86400000;
 const first=Math.max(today,now-600000);
 check(f,{ts:first,status:'down'});check(f,{ts:first+60000,status:'down'});check(f,{ts:now-1000});
 const html=await status(f,'30d');assert.match(html,/すべて正常に稼働中/);assert.match(html,/> 正常/);assert.doesNotMatch(html,/> 一部不調/);
});
test('an incident window without stored checks never claims every check succeeded',async t=>{
 const f=fixture(t);const html=await(await incident(f,1)).text();
 assert.match(html,/障害サンプルは記録されていません/);assert.match(html,/チェック未取得の期間の正常性は確認できません/);assert.doesNotMatch(html,/すべて成功|問題はありません/);
});
test('non-public transport records after cutover remain stored but cannot enter public availability',async t=>{
 const f=fixture(t),now=Date.now(),cutover=now-600000;
 f.sqlite.prepare('UPDATE monitors SET availability_since_ms=? WHERE id=1').run(cutover);
 check(f,{ts:cutover+100000,status:'down',transport:'service_binding'});
 check(f,{ts:cutover+160000,status:'down',transport:'service_binding'});
 check(f,{ts:now-1000});
 assert.match(await status(f),/100\.00%/);assert.doesNotMatch(await feed(f),/<item>/);
});

test('daily status bars do not merge down samples across missing slots or configuration changes', async t => {
  const now = Date.UTC(2026, 9, 25, 12);
  t.mock.method(Date, 'now', () => now);
  for (const [gap, revision, expected] of [[120000, 1, 'up'], [60000, 2, 'up'], [60000, 1, 'partial']]) {
    await t.test(`gap ${gap}, revision ${revision}`, async t => {
      const f = fixture(t), first = now - 600000;
      check(f, { ts: first, slot: first, status: 'down' });
      check(f, { ts: first + 1000, slot: first + gap, status: 'down', revision });
      check(f, { ts: now - 1000 });
      const html = await status(f, '30d');
      const bars = [...html.matchAll(/class="bar bar-([^" ]+)/g)];
      assert.equal(bars.at(-1)[1], expected);
    });
  }
});

test('cutover-day bars retain the same streak rules after the day has passed', async t => {
  const now = Date.UTC(2026, 9, 25, 12);
  t.mock.method(Date, 'now', () => now);
  const cutover = now - 86400000;
  for (const [gap, revision, expected] of [[120000, 1, 'up'], [60000, 2, 'up'], [60000, 1, 'partial']]) {
    await t.test(`gap ${gap}, revision ${revision}`, async t => {
      const f = fixture(t);
      f.sqlite.prepare('UPDATE monitors SET availability_since_ms=? WHERE id=1').run(cutover);
      check(f, { ts: cutover + 60000, slot: cutover + 60000, status: 'down' });
      check(f, { ts: cutover + 61000, slot: cutover + 60000 + gap, status: 'down', revision });
      check(f, { ts: cutover + 600000 });
      check(f, { ts: now - 1000 });
      const html = await status(f, '30d');
      const bars = [...html.matchAll(/class="bar bar-([^" ]+)/g)];
      assert.equal(bars.at(-2)[1], expected);
    });
  }
});
