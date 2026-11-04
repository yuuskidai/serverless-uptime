import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTs, sqliteEnv } from './helpers.mjs';

const { publicFacingUrl, publicFacingDisplay, safePublicWebUrl, redactPublicUrls } = loadTs('url-display');
const { renderMonitorSlackMessage } = loadTs('slack-notification-layout');
const { notifyDown } = loadTs('notifier', { './slack-bot': { buildSlackBot: () => null } });
const { hiddenPublicMonitorIds } = loadTs('public-monitor-visibility');
const { renderStatusPage } = loadTs('status-page');
const { renderIncidentPage } = loadTs('incident-page');
const { renderRssFeed } = loadTs('rss-feed');
const { renderStatusBlocks } = loadTs('slack-bot', { chat: { Chat: class {} },
  '@chat-adapter/state-memory': { createMemoryState: () => ({}) },
  './chat-adapters/slack': { createSlackAdapter: () => ({}) } });
function fixture(t) {
  const f = sqliteEnv(); t.after(() => f.close());
  f.env.DB.withSession = () => f.env.DB;
  f.sqlite.prepare("UPDATE monitors SET name='Visible service' WHERE id=1").run();
  f.sqlite.prepare("INSERT INTO monitor_state(monitor_id,current_status) VALUES(1,'up')").run();
  return f;
}
function addCheck(f, id, ts, status = 'up') {
  f.sqlite.prepare(`INSERT INTO checks(monitor_id,status,status_code,ts,scheduled_slot,config_revision,monitor_role,probe_transport,in_maintenance)
    VALUES(?,?,?,?,?,1,'availability','public_fetch',0)`).run(id, status, status === 'up' ? 200 : 503, ts, Math.floor(ts / 60000) * 60000);
}
const origin = 'https://status.example.invalid';
const incidentUrl = id => new URL(`${origin}/incident?monitor_id=${id}&from=${Date.now() - 600000}&to=${Date.now()}`);

test('public URL sanitization removes only presentation secrets while preserving legitimate service paths', () => {
  assert.equal(publicFacingUrl('https://user:synthetic-password@example.invalid/healthz?key=synthetic-query#synthetic-fragment'), 'https://example.invalid/');
  assert.equal(publicFacingUrl('https://user:synthetic-password@example.invalid/path/to/service?key=synthetic-query#synthetic-fragment'), 'https://example.invalid/path/to/service');
  assert.equal(publicFacingDisplay('https://user:synthetic-password@example.invalid/path?key=synthetic-query#synthetic-fragment'), 'example.invalid/path');
  assert.equal(safePublicWebUrl('https://example.invalid/path', true), 'https://example.invalid/');
  assert.equal(redactPublicUrls('Fetch https://example.invalid?email=user@other.invalid'), 'Fetch https://example.invalid/');
  assert.equal(redactPublicUrls('Fetch https://user:synthetic password@example.invalid/healthz?token=secret'), 'Fetch https://example.invalid/');
  assert.equal(redactPublicUrls('Fetch https://example.invalid/healthz?token=raw secret"suffix',
    ['https://example.invalid/healthz', 'https://example.invalid/healthz?token=raw secret"suffix']), 'Fetch https://example.invalid/');
  for (const input of ['javascript:alert(1)', 'data:text/plain,synthetic-password', 'file:///synthetic-password', 'malformed synthetic-password']) {
    assert.equal(safePublicWebUrl(input), null); assert.equal(publicFacingUrl(input), ''); assert.equal(publicFacingDisplay(input), '');
  }
});

test('credential-bearing probe URLs are redacted in actual public renderers and Slack without changing the stored probe', async t => {
  const f = fixture(t), url = 'https://synthetic-user:synthetic-password@example.invalid/healthz?key=synthetic-query#synthetic-fragment';
  f.sqlite.prepare('UPDATE monitors SET url=? WHERE id=1').run(url); addCheck(f, 1, Date.now() - 1000);
  const html = await (await renderStatusPage(f.env, new URL(origin))).text();
  const detail = await (await renderIncidentPage(f.env, incidentUrl(1))).text();
  const slack = JSON.stringify(await renderStatusBlocks(f.env));
  for (const output of [html, detail, slack]) {
    assert.doesNotMatch(output, /synthetic-user|synthetic-password|synthetic-query|synthetic-fragment/);
    assert.match(output, /https:\/\/example\.invalid\//);
  }
  assert.equal(f.sqlite.prepare('SELECT url FROM monitors WHERE id=1').get().url, url);
});

test('hidden monitors cannot be enumerated through incident or leak into RSS or shared Slack status', async t => {
  const f = fixture(t), now = Date.now(); addCheck(f, 1, now - 1000);
  f.env.HIDDEN_MONITOR_IDS = '2';
  f.sqlite.prepare("INSERT INTO monitors(id,name,url,created_at) VALUES(2,'PRIVATE service','https://private.example.invalid/healthz',0)").run();
  f.sqlite.prepare("INSERT INTO monitor_state(monitor_id,current_status) VALUES(2,'down')").run();
  addCheck(f, 2, now - 125000, 'down'); addCheck(f, 2, now - 65000, 'down');
  const original = f.env.DB.withSession;
  f.env.DB.withSession = () => assert.fail('hidden direct lookup must reject before a database read');
  assert.equal((await renderIncidentPage(f.env, incidentUrl(2))).status, 404);
  f.env.DB.withSession = original;
  const outputs = [await (await renderStatusPage(f.env, new URL(origin))).text(),
    await (await renderRssFeed(f.env, new URL(origin + '/rss.xml'))).text(),
    JSON.stringify(await renderStatusBlocks(f.env))];
  for (const output of outputs) assert.doesNotMatch(output, /PRIVATE service|private\.example/);
  assert.match(outputs[0], /Visible service/); assert.match(outputs[2], /All 1 monitors operational/);
  assert.equal(f.sqlite.prepare('SELECT count(*) AS n FROM checks WHERE monitor_id=2').get().n, 2);
  assert.equal(f.sqlite.prepare('SELECT current_status FROM monitor_state WHERE monitor_id=2').get().current_status, 'down');
});

test('probe URLs repeated in failure and component text are redacted before public/notification output', async t => {
  const f = fixture(t), now = Date.now();
  // A complete stored URL can contain raw delimiters that a generic matcher
  // cannot safely guess. Its full reprint must be removed before escaping.
  const url = 'https://synthetic-user:synthetic-password@example.invalid/healthz?key=synthetic-query synthetic-space"synthetic-quote#synthetic-fragment';
  const fallback = 'https://synthetic-fallback-user:synthetic-fallback-password@fallback.example.invalid/healthz?key=synthetic-fallback-query synthetic-fallback-space"synthetic-fallback-quote#synthetic-fallback-fragment';
  const reason = `Fetch failed for ${url}; fallback failed for ${fallback}`;
  const components = [{ name: `Database ${url}`, status: 'down', reason: `Probe ${fallback}`, latency_ms: 2500 }];
  f.sqlite.prepare('UPDATE monitors SET url=?,fallback_url=?,name=?,description=? WHERE id=1')
    .run(url, fallback, `Visible service ${url} ${fallback}`, `Probe description ${url} ${fallback}`);
  f.sqlite.prepare("UPDATE monitor_state SET current_status='down' WHERE monitor_id=1").run();
  for (const ts of [now - 65000, now - 1000]) {
    addCheck(f, 1, ts, 'down');
    f.sqlite.prepare('UPDATE checks SET error=?,healthz_reason=?,healthz_components=? WHERE monitor_id=1 AND ts=?')
      .run(`TypeError: Request ${url}`, reason, JSON.stringify(components), ts);
  }
  const outputs = [await (await renderStatusPage(f.env, new URL(origin))).text(),
    await (await renderIncidentPage(f.env, incidentUrl(1))).text(),
    await (await renderRssFeed(f.env, new URL(origin + '/rss.xml'))).text(),
    JSON.stringify(await renderStatusBlocks(f.env))];
  const monitor = f.sqlite.prepare('SELECT * FROM monitors WHERE id=1').get();
  const detail = { reason, components, version: 'synthetic', observedAt: now };
  outputs.push(JSON.stringify(renderMonitorSlackMessage(monitor, detail, 'down')));
  t.mock.method(globalThis, 'fetch', async (_url, init) => { outputs.push(init.body); return new Response('{}'); });
  await notifyDown({ ...f.env, DISCORD_WEBHOOK_URL: 'https://webhook.example.invalid/synthetic' }, monitor, detail);
  for (const output of outputs) {
    assert.doesNotMatch(output, /synthetic-(?:fallback-)?(?:user|password|query|space|quote|fragment)/);
    assert.match(output, /example\.invalid/);
  }
  assert.match(outputs[2], /incident\?monitor_id=1&amp;from=/, 'public RSS links keep their safe routing parameters');
  assert.equal(f.sqlite.prepare('SELECT error FROM checks WHERE monitor_id=1 ORDER BY ts DESC LIMIT 1').get().error, `TypeError: Request ${url}`);
  assert.equal(f.sqlite.prepare('SELECT fallback_url FROM monitors WHERE id=1').get().fallback_url, fallback);
});

test('invalid privacy configuration fails closed rather than silently un-hiding monitors', async t => {
  assert.deepEqual([...hiddenPublicMonitorIds('1, 2,1,')], [1, 2]);
  for (const value of ['1junk', '-1', '0', '1.5', '9007199254740992']) assert.throws(() => hiddenPublicMonitorIds(value), /Invalid HIDDEN_MONITOR_IDS/);
  const f = fixture(t); f.env.HIDDEN_MONITOR_IDS = 'invalid';
  await assert.rejects(() => renderStatusPage(f.env, new URL(origin)), /Invalid HIDDEN_MONITOR_IDS/);
  await assert.rejects(() => renderRssFeed(f.env, new URL(origin + '/rss.xml')), /Invalid HIDDEN_MONITOR_IDS/);
});
