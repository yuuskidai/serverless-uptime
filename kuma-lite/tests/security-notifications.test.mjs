import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTs } from './helpers.mjs';

const { validSecurityAlert, renderSecurityAlert, renderSecurityAlertBlocks, deliverSecurityAlert } = loadTs('security-notifications');
const now = Date.now();
const env = { SLACK_BOT_TOKEN: 'synthetic-test-token', SLACK_DEFAULT_CHANNEL: 'C0123456789' };
const sample = extra => ({ version: 1, id: '17818655-47b9-443e-8543-a768f3941310', source: 'core',
  kind: 'auth_failure_burst', severity: 'warning', occurredAt: now, windowStart: now - 300_000,
  windowEnd: now, count: 10, host: 'core-os.opus-system.jp', detailCode: 'password', ...extra });
const success = () => Response.json({ ok: true, channel: env.SLACK_DEFAULT_CHANNEL, ts: '1793000000.123456' });
const plain = value => JSON.parse(JSON.stringify(value));
const ruleSummary = extra => ({ rules: [{ ruleId: '2b5d06e34a814a889bee9a0699702280',
  description: 'React - RCE - CVE:CVE-2025-55182', count: 20 }], otherCount: 2, unknownCount: 1, limited: false, ...extra });
const waf = extra => sample({ source: 'waf', kind: 'waf_activity', host: 'partner-portal.opus-system.jp',
  action: 'block', detailCode: 'sampled_waf', count: 23, ...extra });

test('strict capability validation refuses arbitrary Slack payloads, secrets, spoofed severity and sources', () => {
  assert.equal(validSecurityAlert(sample(), now), true);
  assert.equal(validSecurityAlert(sample({ kind: 'totp_disabled', severity: 'critical' }), now), true);
  const cases = [null, [], 'text', sample({ text: '<!channel>' }), sample({ channel: 'CATTACKER1' }),
    sample({ token: 'secret' }), sample({ source: 'waf' }), sample({ kind: 'ddos_attack' }),
    sample({ severity: 'critical' }), sample({ host: 'partner-portal.opus-system.jp' }),
    sample({ kind: 'totp_disabled' }), sample({ id: '<!here>' }), sample({ subjectHash: 'user@example.invalid' }),
    sample({ ruleId: '<@U12345678>' }), sample({ detailCode: 'password=secret' }), sample({ action: 'allow' }),
    sample({ count: 0 }), sample({ count: 1.5 }), sample({ count: 1e9 + 1 }),
    sample({ occurredAt: now + 60_001 }), sample({ occurredAt: now - 7 * 86_400_000 - 1 }),
    sample({ windowEnd: now - 300_001 }), sample({ windowStart: now - 7 * 86_400_000 - 1 }),
  ];
  for (const value of cases) assert.equal(validSecurityAlert(value, now), false, JSON.stringify(value));
});

test('a valid warning uses only the fixed channel and safe blocks, and retries retain client_msg_id', async () => {
  const calls = [];
  const options = { wallNow: () => now, fetchImpl: async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) }); return success();
  } };
  assert.deepEqual(plain(await deliverSecurityAlert(env, sample({ subjectHash: 'a'.repeat(64), ruleId: 'safe-rule_1' }), options)), { ok: true });
  assert.deepEqual(plain(await deliverSecurityAlert(env, sample(), options)), { ok: true });
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.equal(call.url, 'https://slack.com/api/chat.postMessage');
    assert.equal(call.init.redirect, 'manual');
    assert.equal(call.init.headers.Authorization, 'Bearer synthetic-test-token');
    assert.equal(call.body.channel, env.SLACK_DEFAULT_CHANNEL);
    assert.equal(call.body.client_msg_id, sample().id);
    assert.equal(call.body.mrkdwn, false); assert.equal(call.body.parse, 'none');
    assert.equal(call.body.link_names, false); assert.equal(call.body.unfurl_links, false);
    assert.equal(call.body.unfurl_media, false);
    assert.equal(call.body.blocks[0].text.type, 'plain_text');
    assert.equal(call.body.blocks[0].type, 'header');
    assert.ok(call.body.blocks.some(block => block.type === 'divider'));
    assert.ok(call.body.blocks.some(block => block.type === 'section' && block.fields?.length >= 4));
    assert.match(call.body.text, /不正侵入が成立したとは判断できません/);
    assert.doesNotMatch(call.body.text, /synthetic-test-token|https?:|<!|<@/);
  }
});

test('WAF rule summaries are source-pinned, bounded and exactly account for the notification window total', () => {
  assert.equal(validSecurityAlert(waf({ ruleSummary: ruleSummary() }), now), true);
  assert.equal(validSecurityAlert(waf({ ruleSummary: ruleSummary({ rules: [{ ruleId: 'unicode-rule', description: '正規の名前 🔒', count: 20 }] }) }), now), true);
  assert.equal(validSecurityAlert(waf({ ruleSummary: ruleSummary({ rules: [], otherCount: 0, unknownCount: 23 }) }), now), true);
  assert.equal(validSecurityAlert(waf({ ruleSummary: ruleSummary({ rules: [{ ruleId: 'known-name-unavailable', count: 23 }], otherCount: 0, unknownCount: 0 }) }), now), true);
  const rule = { ruleId: 'known-rule', description: 'Provider label', count: 20 };
  const invalid = [
    undefined, null, [], {}, { rules: [rule], otherCount: 2, unknownCount: 1 },
    ruleSummary({ fields: [] }), ruleSummary({ rules: 'not-an-array' }),
    ruleSummary({ rules: Array.from({ length: 4 }, (_, i) => ({ ruleId: 'rule-' + i, count: 5 })), otherCount: 3, unknownCount: 0 }),
    ruleSummary({ rules: [{ ruleId: 'duplicate', count: 10 }, { ruleId: 'duplicate', count: 10 }] }),
    ruleSummary({ rules: [{ ...rule, text: '<!channel>' }] }),
    ruleSummary({ rules: [{ ...rule, url: 'https://attacker.invalid' }] }),
    ruleSummary({ rules: [{ ...rule, ruleId: '<@U12345678>' }] }),
    ruleSummary({ rules: [{ ...rule, ruleId: 'x'.repeat(65) }] }),
    ruleSummary({ rules: [{ ...rule, ruleId: '' }] }),
    ...[0, -1, 1.5, Number.MAX_SAFE_INTEGER, '20'].map(count => ruleSummary({ rules: [{ ...rule, count }] })),
    ...[-1, 1.5, 1_000_000_001, '2'].map(otherCount => ruleSummary({ otherCount })),
    ...[-1, 1.5, 1_000_000_001, '1'].map(unknownCount => ruleSummary({ unknownCount })),
    ruleSummary({ limited: 'false' }), ruleSummary({ otherCount: 1 }), ruleSummary({ unknownCount: 2 }),
    ...['', '   ', 'a'.repeat(161), 'line\nbreak', 'tab\tlabel', 'c1\u0085label',
      'bidi\u202elabel', 'rtl\u200flabel', 'isolate\u2067label', 'paragraph\u2029label',
      'high\ud800label', 'low\udfffLabel'].map(description => ruleSummary({ rules: [{ ...rule, description }] })),
  ];
  for (const summary of invalid) assert.equal(validSecurityAlert(waf({ ruleSummary: summary }), now), false, JSON.stringify(summary));
  for (const alert of [sample({ count: 23 }), sample({ source: 'pipeline', kind: 'pipeline_degraded', host: undefined, count: 23 }),
    sample({ source: 'ddos', kind: 'ddos_attack', host: 'opus-system.jp', count: 23 })]) {
    assert.equal(validSecurityAlert({ ...alert, ruleSummary: ruleSummary() }, now), false);
  }
});

test('the matching-rules section adds names, IDs and observed counts without changing the existing rich card', () => {
  const legacy = renderSecurityAlertBlocks(waf());
  const alert = waf({ ruleSummary: ruleSummary() });
  const blocks = renderSecurityAlertBlocks(alert);
  const index = blocks.findIndex(block => block.type === 'section' && block.text?.text.startsWith('一致ルール'));
  assert.equal(index, 4); assert.equal(blocks[index].text.type, 'plain_text');
  assert.match(blocks[index].text.text, /React - RCE - CVE:CVE-2025-55182｜20 件/);
  assert.match(blocks[index].text.text, /ルールID: 2b5d06e34a814a889bee9a0699702280/);
  assert.match(blocks[index].text.text, /内訳を表示していない記録: 2 件/);
  assert.match(blocks[index].text.text, /ルール情報を取得できない記録: 1 件/);
  assert.deepEqual(plain(blocks.filter((_, i) => i !== index)), plain(legacy));
  assert.match(renderSecurityAlert(alert), /React - RCE/);
  assert.match(renderSecurityAlert(alert), /内訳を表示していない記録: 2 件/);
  assert.match(JSON.stringify(blocks), /サンプリング/);
  assert.doesNotMatch(JSON.stringify(blocks), /23件の攻撃|侵入を防止しました/);
});

test('unknown and capped rule metadata remains explicit, and legacy queued notifications still render', () => {
  const limited = waf({ ruleSummary: ruleSummary({ limited: true }) });
  const rendered = JSON.stringify(renderSecurityAlertBlocks(limited));
  assert.match(rendered, /取得・保持上限により内訳は一部/);
  assert.match(rendered, /全体の順位は示していません/);
  const unknown = waf({ ruleSummary: ruleSummary({ rules: [], otherCount: 0, unknownCount: 23 }) });
  assert.match(JSON.stringify(renderSecurityAlertBlocks(unknown)), /ルール情報を取得できない記録: 23 件/);
  assert.doesNotMatch(JSON.stringify(renderSecurityAlertBlocks(unknown)), /名称未取得|2b5d06/);
  const old = waf({ ruleId: 'legacy-rule' });
  assert.equal(validSecurityAlert(old, now), true);
  assert.match(JSON.stringify(renderSecurityAlertBlocks(old)), /ルール: legacy-rule/);
  assert.match(renderSecurityAlert(old), /ルール: legacy-rule/);
  assert.doesNotMatch(JSON.stringify(renderSecurityAlertBlocks(old)), /一致ルール/);
});

test('provider rule names stay literal and rule-rich retries keep the same destination and message ID', async () => {
  const description = '<!channel> <https://attacker.invalid|open> & *bold*';
  const alert = waf({ count: 1, ruleSummary: ruleSummary({ rules: [{ ruleId: 'literal-label', description, count: 1 }], otherCount: 0, unknownCount: 0 }) });
  assert.equal(validSecurityAlert(alert, now), true);
  const calls = [];
  const options = { wallNow: () => now, fetchImpl: async (_url, init) => { calls.push(JSON.parse(init.body)); return success(); } };
  assert.deepEqual(plain(await deliverSecurityAlert(env, alert, options)), { ok: true });
  assert.deepEqual(plain(await deliverSecurityAlert(env, alert, options)), { ok: true });
  for (const payload of calls) {
    assert.equal(payload.client_msg_id, alert.id); assert.equal(payload.channel, env.SLACK_DEFAULT_CHANNEL);
    assert.equal(payload.mrkdwn, false); assert.equal(payload.parse, 'none'); assert.equal(payload.link_names, false);
    assert.doesNotMatch(payload.text, /<!|<@|<https:/);
    const ruleBlock = payload.blocks.find(block => block.text?.text.includes(description));
    assert.equal(ruleBlock.text.type, 'plain_text');
    assert.ok(payload.blocks.filter(block => block.text?.type === 'mrkdwn').every(block => !block.text.text.includes(description)));
    const buttons = payload.blocks.find(block => block.type === 'actions').elements;
    assert.ok(buttons.every(button => ['https://partner-portal.opus-system.jp/', 'https://dash.cloudflare.com/'].includes(button.url)));
  }
});

test('three maximum-length provider labels and all count fields fit Slack text limits', () => {
  const rules = Array.from({ length: 3 }, (_, i) => ({ ruleId: String(i).repeat(64), description: '&'.repeat(160), count: 333_333_333 }));
  const alert = waf({ count: 1_000_000_000, subjectHash: 'a'.repeat(64), ruleSummary: { rules, otherCount: 1, unknownCount: 0, limited: true } });
  assert.equal(validSecurityAlert(alert, now), true);
  const blocks = renderSecurityAlertBlocks(alert);
  assert.ok(blocks.length <= 50);
  for (const block of blocks) {
    if (block.type === 'header') assert.ok(block.text.text.length <= 150);
    if (block.text) assert.ok(block.text.text.length <= 3000);
    if (block.fields) assert.ok(block.fields.length <= 10 && block.fields.every(field => field.text.length <= 2000));
    if (block.type === 'context') assert.ok(block.elements.length <= 10 && block.elements.every(element => element.text.length <= 2000));
  }
  assert.ok(renderSecurityAlert(alert).length <= 4000);
});

test('rich cards distinguish WAF outcomes and retain sampling limits without inventing attack success', () => {
  const outputs = {};
  for (const action of ['block', 'managed_challenge', 'js_challenge', 'challenge', 'log', 'mixed']) {
    outputs[action] = JSON.stringify(renderSecurityAlertBlocks(sample({ source: 'waf', kind: 'waf_activity',
      host: 'partner-portal.opus-system.jp', action, detailCode: 'sampled_waf', count: 9 })));
    assert.match(outputs[action], /観測記録/);
    assert.match(outputs[action], /サンプリング/);
    assert.match(outputs[action], /通信全件の件数ではありません/);
    assert.match(outputs[action], /侵入が成立したとは判断できません/);
    assert.doesNotMatch(outputs[action], /侵入を防止しました|侵入成功を確認|9人|9件の攻撃/);
  }
  assert.match(outputs.block, /WAFで遮断/);
  for (const action of ['managed_challenge', 'js_challenge', 'challenge']) {
    assert.match(outputs[action], /通過・遮断の最終結果は/);
    assert.doesNotMatch(outputs[action], /WAFで遮断|遮断を記録/);
  }
  assert.match(outputs.log, /記録のみ/);
  assert.match(outputs.log, /遮断されたことは、この記録だけでは確認できません/);
  assert.doesNotMatch(outputs.mixed, /WAFで遮断|遮断を記録/);
});

test('management changes, auth denials, and an unknown monitoring pipeline have actionable distinct wording', () => {
  for (const kind of ['admin_privilege_changed', 'totp_disabled', 'security_policy_weakened']) {
    const blocks = renderSecurityAlertBlocks(sample({ kind, severity: 'critical' }));
    assert.match(blocks[0].text.text, /^🚨 重要な管理変更/);
    assert.match(JSON.stringify(blocks), /優先して確認|優先して確認し/);
    assert.match(JSON.stringify(blocks), /想定外/);
  }
  const denied = JSON.stringify(renderSecurityAlertBlocks(sample({ kind: 'auth_rate_limited_burst' })));
  assert.match(denied, /保存処理の異常でも拒否/);
  assert.match(denied, /上限到達とは断定できません/);
  const unknown = JSON.stringify(renderSecurityAlertBlocks(sample({ source: 'pipeline', kind: 'pipeline_degraded',
    host: undefined, detailCode: 'analytics_gap' })));
  assert.match(unknown, /監視状態が未確認/);
  assert.match(unknown, /監視の正常性は未確認/);
  assert.doesNotMatch(unknown, /正常です|復旧しました|✅/);
});

test('JST time crosses the UTC day boundary correctly and anonymous IDs do not crowd the card', () => {
  const timestamp = Date.parse('2026-11-01T18:36:00Z');
  const alert = sample({ occurredAt: timestamp, windowStart: timestamp - 60_000, windowEnd: timestamp,
    subjectHash: 'a'.repeat(64) });
  const blocks = JSON.stringify(renderSecurityAlertBlocks(alert));
  assert.match(blocks, /2026\/11\/02 03:36:00/);
  assert.match(blocks, /2026\/11\/02 03:35:00/);
  assert.match(blocks, /JST/);
  assert.match(blocks, /aaaaaaaaaaaa…/);
  assert.doesNotMatch(blocks, new RegExp('a'.repeat(64)));
  assert.match(renderSecurityAlert(alert), new RegExp('a'.repeat(64)));
  assert.match(renderSecurityAlert(alert), /対応の目安/);
});

test('all security card variants fit Block Kit limits and expose only fixed navigation URLs', () => {
  const variants = [
    ...['auth_failure_burst', 'account_locked', 'auth_rate_limited_burst', 'authorization_denied_burst',
      'admin_privilege_changed', 'totp_disabled', 'security_policy_weakened'].map(kind => sample({ kind,
      severity: ['admin_privilege_changed', 'totp_disabled', 'security_policy_weakened'].includes(kind) ? 'critical' : 'warning' })),
    sample({ source: 'waf', kind: 'waf_activity', detailCode: 'sampled_waf', action: 'block', host: 'opus-system.jp' }),
    sample({ source: 'ddos', kind: 'ddos_attack', detailCode: 'native_ddos', host: 'opus-system.jp' }),
    sample({ source: 'pipeline', kind: 'pipeline_degraded', detailCode: 'delivery_failed', host: undefined }),
  ];
  const allowed = new Set(['https://core-os.opus-system.jp/', 'https://partner-portal.opus-system.jp/', 'https://dash.cloudflare.com/']);
  for (const variant of variants) {
    const blocks = renderSecurityAlertBlocks({ ...variant, count: 1_000_000_000, subjectHash: 'b'.repeat(64), ruleId: 'r'.repeat(64) });
    assert.ok(blocks.length <= 50);
    for (const block of blocks) {
      if (block.type === 'header') assert.ok(block.text.text.length <= 150);
      if (block.text) assert.ok(block.text.text.length <= 3000);
      if (block.fields) {
        assert.ok(block.fields.length <= 10);
        assert.ok(block.fields.every(field => field.text.length <= 2000));
      }
      if (block.type === 'context') {
        assert.ok(block.elements.length <= 10);
        assert.ok(block.elements.every(element => element.text.length <= 2000));
      }
      if (block.type === 'actions') {
        assert.ok(block.elements.length <= 25);
        for (const button of block.elements) {
          assert.equal(button.type, 'button'); assert.ok(button.text.text.length <= 75);
          assert.ok(allowed.has(button.url)); assert.ok(button.url.length <= 3000);
        }
      }
    }
    assert.ok(renderSecurityAlert(variant).length <= 4000);
    assert.doesNotMatch(JSON.stringify(blocks), /<!|<@|hooks\.slack|token|cookie/i);
  }
});

test('weakening a company security policy is a critical observed change restricted to application sources', () => {
  const alert = sample({ kind: 'security_policy_weakened', severity: 'critical' });
  assert.equal(validSecurityAlert(alert, now), true);
  assert.equal(validSecurityAlert({ ...alert, source: 'portal', host: 'partner-portal.opus-system.jp' }, now), true);
  assert.equal(validSecurityAlert({ ...alert, severity: 'warning' }, now), false);
  assert.equal(validSecurityAlert({ ...alert, source: 'waf', host: 'opus-system.jp' }, now), false);
  const text = renderSecurityAlert(alert);
  assert.match(text, /^【要確認】セキュリティ設定の緩和を記録/);
  assert.match(text, /不正侵入が成立したとは判断できません/);
});

test('invalid alerts and missing configuration cause no outbound request', async () => {
  let calls = 0; const fetchImpl = async () => { calls++; return success(); };
  for (const input of [sample({ token: 'secret' }), sample({ source: 'unknown' })]) {
    assert.equal((await deliverSecurityAlert(env, input, { fetchImpl })).code, 'invalid_alert');
  }
  for (const config of [{}, { ...env, SLACK_DEFAULT_CHANNEL: 'https://attacker.invalid' }, { ...env, SLACK_DEFAULT_CHANNEL: '<!here>' }]) {
    assert.equal((await deliverSecurityAlert(config, sample(), { fetchImpl })).code, 'not_configured');
  }
  assert.equal(calls, 0);
});

test('Slack 429 is typed, clamps retry windows, and never waits for body cancellation', async () => {
  for (const [header, expected] of [['120', 120000], ['0', 1000], ['9999999999', 3600000], ['invalid', 60000],
    [new Date(now + 90_000).toUTCString(), 90_000 - now % 1000]]) {
    let cancelled = false;
    const r = new Response(new ReadableStream({ cancel() { cancelled = true; return new Promise(() => {}); } }),
      { status: 429, headers: { 'Retry-After': header } });
    const result = await deliverSecurityAlert(env, sample(), { wallNow: () => now, timeoutMs: 100,
      fetchImpl: async () => r });
    assert.deepEqual(plain(result), { ok: false, code: 'rate_limited', retryAfterMs: expected });
    assert.equal(cancelled, true);
  }
});

test('the bridge returns only safe error codes for non-JSON, redirects, Slack errors, mismatched destination and oversized bodies', async () => {
  const cases = [
    [() => new Response('secret untrusted body', { status: 502 }), 'slack_unavailable'],
    [() => new Response(null, { status: 302, headers: { Location: 'https://attacker.invalid' } }), 'slack_rejected'],
    [() => new Response('secret untrusted body'), 'invalid_response'],
    [() => Response.json({ ok: false, error: 'invalid_auth', token: 'secret' }), 'slack_rejected'],
    [() => Response.json({ ok: false, error: 'ratelimited' }), 'rate_limited'],
    [() => Response.json({ ok: true, channel: 'CATTACKER1', ts: '1793000000.123456' }), 'invalid_response'],
    [() => Response.json({ ok: true, channel: env.SLACK_DEFAULT_CHANNEL }), 'invalid_response'],
    [() => new Response('x', { headers: { 'Content-Length': '16385' } }), 'invalid_response'],
    [() => new Response('x'.repeat(16385)), 'invalid_response'],
    [() => new Response(new Uint8Array([0xff])), 'network_error'],
  ];
  for (const [makeResponse, expected] of cases) {
    const result = await deliverSecurityAlert(env, sample(), { fetchImpl: async () => makeResponse() });
    assert.equal(result.code, expected); assert.equal(result.ok, false);
    assert.doesNotMatch(JSON.stringify(result), /secret|attacker|invalid_auth/);
  }
});

test('a transport ignoring abort is bounded and its late response is released', async () => {
  let resolve; let cancelled = false;
  const pending = new Promise(r => { resolve = r; });
  const result = await deliverSecurityAlert(env, sample(), { timeoutMs: 25, fetchImpl: () => pending });
  assert.deepEqual(plain(result), { ok: false, code: 'timeout' });
  resolve(new Response(new ReadableStream({ cancel() { cancelled = true; } })));
  await new Promise(r => setTimeout(r, 10));
  assert.equal(cancelled, true);
});

test('a stalled body is bounded and cleanup does not await its cancellation acknowledgement', async () => {
  let cancelled = false;
  const response = new Response(new ReadableStream({
    pull() { return new Promise(() => {}); },
    cancel() { cancelled = true; return new Promise(() => {}); },
  }));
  const result = await deliverSecurityAlert(env, sample(), { timeoutMs: 25, fetchImpl: async () => response });
  assert.deepEqual(plain(result), { ok: false, code: 'timeout' });
  assert.equal(cancelled, true);
});

test('an overdue success cannot win the expiry race before the timer callback runs', async () => {
  let clock = 0;
  const result = await deliverSecurityAlert(env, sample(), { timeoutMs: 25, monotonicNow: () => clock,
    fetchImpl: async () => { clock = 26; return success(); } });
  assert.deepEqual(plain(result), { ok: false, code: 'timeout' });
});
