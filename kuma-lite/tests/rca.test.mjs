import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as monitorPolicy from '../src/monitor-policy.ts';

const source = readFileSync(new URL('../src/rca.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

function fixture(options = {}) {
  const incident = Date.now() - 60_000;
  const requestId = 'synthetic-monitor-request-1';
  const trace = { attempt: 'primary', transport: 'service_binding', request_id: requestId,
    response_request_id: requestId, request_id_matched: true, status_code: 200,
    headers_ms: 2100, body_ms: 2, total_ms: 2102, failure_phase: null, body_truncated: false };
  const row = { ts: incident, status: 'up', status_code: 200, latency_ms: 2102, error: null,
    healthz_status: 'degraded', healthz_reason: 'DB応答遅延', healthz_version: 'synthetic-build',
    healthz_components: JSON.stringify([{ name: 'database', status: 'degraded', latency_ms: 900 }]),
    probe_trace_json: JSON.stringify([trace]), ...options.row };
  const inputs = [], posts = [], requests = [];
  let acked = 0, retried = 0;
  const env = { CF_API_TOKEN: 'synthetic-token', CF_ACCOUNT_ID: 'synthetic-account',
    RCA_WORKER_SCRIPTS: options.mapped === false ? undefined : '{"1":"core-os"}',
    AI: { async run(_model, input) { inputs.push(input); return options.ai ? options.ai(input) : {
      response: JSON.stringify(options.proposal ?? { hypotheses: [{ cause: 'database_latency', evidence_ids: ['check:1'] }],
        next_checks: ['correlate_request_ids', 'inspect_database_phases'] }),
    }; } },
    DB: { prepare(sql) { return { bind() { return this; },
      async first() { return { id: 1, name: options.name ?? 'Synthetic monitor', url: 'https://user:secret@example.invalid/healthz?token=hidden#private', ...options.monitor }; },
      async all() { assert.match(sql, /probe_trace_json/); return { results: [row] }; },
    }; } },
  };
  const fetcher = async (url, init) => {
    requests.push({ url, init });
    if (String(url).includes('cloudflarestatus')) return options.statusResponse?.() ?? Response.json({ incidents: [] });
    if (String(url).includes('/deployments')) return Response.json({ success: true, result: {
      deployments: options.deployments ?? [],
    } });
    const query = JSON.parse(init.body);
    if (query.queryId === 'kuma-lite-rca-probes' && options.indexedUnavailable) return new Response(null, { status: 400 });
    const rows = query.queryId === 'kuma-lite-rca-probes' ? options.probeEvents
      : query.queryId === 'kuma-lite-rca-probe-messages' ? options.messageEvents : options.errorEvents;
    return Response.json({ success: true, result: { events: { events: rows ?? [] } } });
  };
  const module = { exports: {} };
  runInNewContext(compiled, {
    module, exports: module.exports, AbortController, URL, Response, TextDecoder, Uint8Array,
    setTimeout: options.setTimeout ?? setTimeout, clearTimeout, fetch: fetcher,
    console: { error() {}, warn() {}, log() {} },
    require(id) {
      if (id === './monitor-policy') return monitorPolicy;
      assert.equal(id, './slack-bot');
      return { buildSlackBot() { return { defaultChannelId: 'synthetic-channel', slack: {
        async postBlocks(_channel, payload) { posts.push(payload); },
      } }; } };
    },
  }, { filename: 'rca.ts' });
  return { env, inputs, posts, requests, incident, requestId,
    enqueue(job) { return module.exports.enqueueRca(env, job); },
    get acked() { return acked; }, get retried() { return retried; },
    async run() { await module.exports.handleRcaBatch({ messages: [{
      body: { monitorId: 1, alertTs: 'synthetic-thread', downSince: incident, reason: 'DB応答遅延', kind: 'degraded', ...options.job },
      ack() { acked++; }, retry() { retried++; },
    }] }, env); },
    evidence() { return JSON.parse(inputs[0].messages.at(-1).content.replace(/^<data>\n|\n<\/data>$/g, '')); },
    text() { return posts[0].blocks.filter(block => block.type === 'section').map(block => block.text.text).join('\n'); },
  };
}

test('RCA separates rendered facts from supported, explicitly unconfirmed hypotheses', async () => {
  const f = fixture();
  await f.run();
  assert.equal(f.acked, 1);
  assert.equal(f.retried, 0);
  assert.match(f.text(), /確認できた事実/);
  assert.match(f.text(), /仮説（未確認・原因の確定ではありません）/);
  assert.match(f.text(), /DB応答遅延との関連/);
  assert.match(f.text(), /primary\/service_binding/);
  assert.match(f.text(), /地域や公開HTTP経路の観測ではない/);
  assert.equal(f.evidence().monitor.url, 'https://example.invalid/healthz');
  assert.equal(JSON.stringify(f.inputs).includes('token=hidden'), false);
  assert.equal(JSON.stringify(f.inputs).includes('user:secret'), false);
});

test('unmapped targets never use account-wide errors or unrelated deployment evidence', async () => {
  const f = fixture({ mapped: false, proposal: {
    hypotheses: [{ cause: 'deployment_change', evidence_ids: ['deployment:99'] }], next_checks: [],
  } });
  await f.run();
  assert.equal(f.requests.filter(item => item.url.includes('api.cloudflare.com')).length, 0);
  assert.match(f.text(), /データ不足/);
  assert.match(f.text(), /アカウント全体のログは対象と関連付けない/);
  assert.equal(f.text().includes('配備変更との関連'), false);
});

test('only same-worker health_probe events with an exact request ID contribute private phase metadata', async () => {
  const requestId = 'synthetic-monitor-request-1';
  const valid = { timestamp: Date.now() - 59_000, $metadata: { service: 'core-os' }, event: 'health_probe',
    request_id: requestId, status: 'degraded', handler_total_ms: 2050, database_component_ms: 900,
    d1: { roundtrip_ms: 900, pending_ms: 880, meta: { served_by_region: 'APAC', served_by_colo: 'NRT',
      timings: { sql_duration_ms: 2 }, secret: 'MUST-NOT-LEAVE-LOG' } }, headers: { authorization: 'MUST-NOT-LEAVE-LOG' } };
  const records = [valid, { ...valid, request_id: 'different-request' }, { ...valid, $metadata: { service: 'other-worker' } }];
  const withLogs = fixture({ probeEvents: records, proposal: {
    hypotheses: [{ cause: 'database_latency', evidence_ids: ['probe-log:1'] }], next_checks: ['inspect_database_phases'],
  } });
  await withLogs.run();
  const evidence = withLogs.evidence();
  const logs = evidence.observations.filter(item => item.source === 'matched_probe');
  assert.equal(logs.length, 1);
  assert.equal(logs[0].data.request_id, requestId);
  assert.equal(logs[0].data.d1_sql_duration_ms, 2);
  assert.equal(logs[0].data.served_by_region, 'APAC');
  assert.equal(JSON.stringify(evidence).includes('MUST-NOT-LEAVE-LOG'), false);
  assert.match(withLogs.text(), /障害範囲を示すものではない/);
  const query = withLogs.requests.find(item => item.init?.body?.includes('kuma-lite-rca-probes'));
  assert.ok(query);
  assert.match(query.init.body, /request_id/);
});

test('post-incident deployments are observations and cannot support a causal deployment hypothesis', async () => {
  const now = Date.now();
  const f = fixture({ deployments: [
    { created_on: new Date(now - 10_000).toISOString(), source: 'api', author_email: 'private@example.invalid' },
    { created_on: new Date(now + 3_600_000).toISOString(), source: 'future' },
  ], proposal: { hypotheses: [{ cause: 'deployment_change', evidence_ids: ['deployment:1'] }], next_checks: ['review_deployment'] } });
  await f.run();
  const deployments = f.evidence().observations.filter(item => item.source === 'deployment');
  assert.equal(deployments.length, 1);
  assert.match(deployments[0].fact, /以後/);
  assert.equal(JSON.stringify(f.inputs).includes('private@example.invalid'), false);
  assert.equal(f.text().includes('配備変更との関連'), false);
  assert.match(f.text(), /データ不足/);
});

for (const indexedUnavailable of [false, true]) {
  test(`JSON-string health_probe logs are joined by exact ID when indexed query ${indexedUnavailable ? 'fails' : 'is empty'}`, async () => {
    const requestId = 'synthetic-monitor-request-1';
    const event = { timestamp: Date.now() - 59_000, $metadata: { service: 'core-os',
      message: JSON.stringify({ event: 'health_probe', request_id: requestId, status: 'degraded',
        handler_total_ms: 2100, database_component_ms: 900, d1: { pending_ms: 880,
          meta: { timings: { sql_duration_ms: 2 }, served_by_region: 'APAC' } }, secret: 'UNRELATED-SECRET' }) } };
    const f = fixture({ indexedUnavailable, messageEvents: [event,
      { ...event, $metadata: { service: 'core-os', message: JSON.stringify({ event: 'health_probe', request_id: 'unrelated' }) } },
      { ...event, $metadata: { ...event.$metadata, service: 'other-worker' } },
    ], proposal: { hypotheses: [{ cause: 'database_latency', evidence_ids: ['probe-log:1'] }], next_checks: ['inspect_database_phases'] } });
    await f.run();
    const logs = f.evidence().observations.filter(item => item.source === 'matched_probe');
    assert.equal(logs.length, 1);
    assert.equal(logs[0].data.request_id, requestId);
    assert.equal(logs[0].data.d1_pending_ms, 880);
    assert.equal(JSON.stringify(f.inputs).includes('UNRELATED-SECRET'), false);
    const query = f.requests.find(item => item.init?.body?.includes('kuma-lite-rca-probe-messages'));
    assert.ok(query);
    const filters = JSON.parse(query.init.body).parameters.filters;
    assert.ok(filters.some(filter => filter.key === '$metadata.service' && filter.value === 'core-os'));
    assert.ok(filters.some(filter => filter.key === '$metadata.message' && filter.operation === 'includes' && filter.value === 'health_probe'));
    assert.match(f.text(), /待ち=880ms\/SQL=2ms/);
  });
}

test('free-form or invented model claims cannot reach Slack; external mentions are escaped', async () => {
  const f = fixture({ name: '<!channel> Synthetic', ai: async () => ({
    response: '{"confirmed_cause":"Tokyo deployment caused the outage <!here>","hypotheses":[],"next_checks":[]}',
  }) });
  await f.run();
  assert.equal(f.text().includes('Tokyo'), false);
  assert.equal(JSON.stringify(f.posts).includes('<!channel>'), false);
  assert.equal(JSON.stringify(f.posts).includes('<!here>'), false);
  assert.match(f.posts[0].text, /&lt;!channel&gt;/);
  assert.match(f.text(), /データ不足/);
});

test('evidence byte limits cancel oversized streams without awaiting cancellation acknowledgement', async () => {
  let cancelled = false;
  const f = fixture({ mapped: false, statusResponse: () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(256 * 1024 + 1)); },
    cancel() { cancelled = true; return new Promise(() => {}); },
  })) });
  await f.run();
  assert.equal(cancelled, true);
  assert.equal(f.acked, 1);
  assert.match(f.text(), /cfStatus: 取得に失敗/);
});

test('body deadlines keep missing evidence explicit and do not wait for a stalled peer', async () => {
  let cancelled = false;
  const f = fixture({ mapped: false, statusResponse: () => new Response(new ReadableStream({
    cancel() { cancelled = true; return new Promise(() => {}); },
  })), setTimeout(callback, ms) { return setTimeout(callback, ms === 10_000 ? 5 : ms); } });
  await f.run();
  assert.equal(cancelled, true);
  assert.equal(f.acked, 1);
  assert.match(f.text(), /cfStatus: 取得に失敗/);
});

test('a stalled AI call falls back to known facts instead of retrying inference or fabricating a cause', async () => {
  const f = fixture({ ai: () => new Promise(() => {}),
    setTimeout(callback, ms) { return setTimeout(callback, ms === 45_000 ? 5 : ms); } });
  await f.run();
  assert.equal(f.acked, 1);
  assert.equal(f.inputs.length, 1);
  assert.match(f.text(), /確認できた事実/);
  assert.match(f.text(), /データ不足/);
});

test('malformed or oversized trace input cannot inject fields or trigger correlated queries', async () => {
  const f = fixture({ row: { probe_trace_json: 'x'.repeat(9000) } });
  await f.run();
  assert.equal(f.evidence().observations[0].data.probe_trace.length, 0);
  assert.equal(f.requests.some(item => item.init?.body?.includes('kuma-lite-rca-probes')), false);
  assert.equal(f.acked, 1);
});

test('queue send wait is bounded without retrying an unconfirmed publish or leaking a late rejection', async () => {
  let sends = 0, rejectPublish;
  const f = fixture({ setTimeout(callback, ms) { return setTimeout(callback, ms === 2000 ? 5 : ms); } });
  f.env.RCA_QUEUE = { send() { sends++; return new Promise((_resolve, reject) => { rejectPublish = reject; }); } };
  await f.enqueue({ monitorId: 1, alertTs: 'synthetic-thread', downSince: Date.now(), reason: 'synthetic' });
  assert.equal(sends, 1);
  rejectPublish(new Error('synthetic late rejection'));
  await Promise.resolve();
  assert.equal(f.posts.length, 0);
});

for (const role of ['diagnostic','shadow']) test(`queued RCA skips a monitor now assigned the ${role} role`,async()=>{
 const f=fixture({monitor:{monitor_role:role}});await f.run();
 assert.equal(f.acked,1);assert.equal(f.inputs.length+f.posts.length+f.requests.length,0);
});
test('queued RCA cannot cross a configuration revision or availability cutover',async()=>{
 for(const options of [
  {monitor:{config_revision:2}},
  {monitor:{config_revision:2},job:{configRevision:1}},
  {monitor:{config_revision:2,availability_since_ms:Date.now()},job:{configRevision:2}},
 ]) {const f=fixture(options);await f.run();assert.equal(f.inputs.length+f.posts.length+f.requests.length,0);assert.equal(f.acked,1);}
});
test('same-revision availability RCA still runs',async()=>{
 const f=fixture({monitor:{config_revision:2,monitor_role:'availability'},job:{configRevision:2}});await f.run();
 assert.equal(f.inputs.length,1);assert.equal(f.posts.length,1);
});

test('RCA rechecks role, enabled state and revision after inference before posting',async()=>{
 for (const change of [{monitor_role:'diagnostic'},{monitor_role:'shadow'},{config_revision:2},{enabled:0}]) {
  const monitor={config_revision:1,monitor_role:'availability',enabled:1};
  const f=fixture({monitor,ai:async()=>{Object.assign(monitor,change);return {response:JSON.stringify({hypotheses:[],next_checks:[]})};}});
  await f.run();assert.equal(f.inputs.length,1);assert.equal(f.posts.length,0);assert.equal(f.acked,1);
 }
});
