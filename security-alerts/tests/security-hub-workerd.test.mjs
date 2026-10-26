import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
const require=createRequire(new URL('../../kuma-lite/package.json',import.meta.url));
const wranglerRequire=createRequire(require.resolve('wrangler/package.json'));
const {Miniflare,convertV4MiniflareOptions}=wranglerRequire('miniflare');
const {buildSync}=wranglerRequire('esbuild');
const secret='a'.repeat(64), singleton='fixed-security-hub-v1';
const bundle=buildSync({stdin:{contents:`import handler from './src/index.ts';
  export {CoreSecurityEvents,PortalSecurityEvents} from './src/index.ts';
  import {SecurityHub} from './src/hub.ts';
  export default handler;
  export class TestHub extends SecurityHub {
    async testRows() {return {control:JSON.parse(this.ctx.storage.sql.exec('SELECT value FROM control WHERE id=1').one().value),
      outbox:this.ctx.storage.sql.exec('SELECT * FROM outbox ORDER BY created').toArray(),
      buckets:this.ctx.storage.sql.exec('SELECT * FROM buckets').toArray(),receipts:this.ctx.storage.sql.exec('SELECT * FROM receipts').toArray(),alarm:await this.ctx.storage.getAlarm()};}
    async testControl(patch) {const row=JSON.parse(this.ctx.storage.sql.exec('SELECT value FROM control WHERE id=1').one().value);
      this.ctx.storage.sql.exec('UPDATE control SET value=? WHERE id=1',JSON.stringify({...row,...patch}));}
    async testReceipt() {this.ctx.storage.sql.exec('INSERT INTO receipts(id,status,at,alert) VALUES(?,?,?,?)','old-dead-receipt','dead',Date.now(),'{}');}
    async testDue() {this.ctx.storage.sql.exec('UPDATE outbox SET next=0,lease_until=0,lease_token=NULL');}
    async testReset() {await this.stop();this.ctx.storage.sql.exec('DELETE FROM seen;DELETE FROM buckets;DELETE FROM outbox;DELETE FROM receipts;');
      await this.testControl({seenCount:0,criticalSeenCount:0,lockedSeenCount:0,bucketCount:0,pending:0,sent:0,dead:0,deadAcknowledged:0,deadAcknowledgedAt:null,rejected:0,saturated:false,saturationUntil:0,quota:{regular:{pending:0,day:0},critical:{pending:0,day:0},locked:{pending:0,day:0},pipeline:{pending:0,day:0}},queuedToday:0,suppressed:0,
        analytics:{cursor:null,lastSuccess:null,nextTry:0,status:'unknown',code:'not_started',sampled:true}});}
    async testAlarm() {await this.alarm();}
  }`,resolveDir:fileURLToPath(new URL('../',import.meta.url)),sourcefile:'security-test-fixture.js'},bundle:true,format:'esm',platform:'browser',external:['cloudflare:workers'],write:false}).outputFiles[0].text;
const event=(kind='auth_failure',extra={})=>({version:1,eventId:crypto.randomUUID(),occurredAt:Date.now(),kind,actorHash:'b'.repeat(64),...extra});

test('security hub keeps trust, aggregation, durable delivery and runtime alarms bounded',async t=>{
  const sent=[];let reply={ok:true};let release;const queries=[];let analyticsReply={errors:[{message:'not authorized'}]};
  const mf=new Miniflare(convertV4MiniflareOptions({workers:[{
    name:'security',script:bundle,modules:true,compatibilityDate:'2025-01-01',
    durableObjects:{SECURITY_HUB:{className:'TestHub',useSQLite:true}},bindings:{ADMIN_SECRET:secret,CF_ANALYTICS_TOKEN:'synthetic-analytics-token'},
    outboundService:async request=>{queries.push(await request.json());return Response.json(analyticsReply);},
    serviceBindings:{SLACK_NOTIFIER:{name:'notifier',entrypoint:'Notifier'}},
  },{
    name:'notifier',modules:true,compatibilityDate:'2025-01-01',
    script:`import {WorkerEntrypoint} from 'cloudflare:workers';
      export class Notifier extends WorkerEntrypoint {async sendSecurityAlert(alert){return (await fetch('https://notifier.invalid/',{method:'POST',body:JSON.stringify(alert)})).json();}}
      export default {fetch(){return new Response('notfound',{status:404});}};`,
    outboundService:async request=>{sent.push(await request.json());if(release)await new Promise(resolve=>release.push(resolve));return Response.json(reply);},
  },{
    name:'caller',modules:true,compatibilityDate:'2025-01-01',
    serviceBindings:{CORE:{name:'security',entrypoint:'CoreSecurityEvents'},PORTAL:{name:'security',entrypoint:'PortalSecurityEvents'}},
    // Test-only route for invoking named bindings; never deployed.
    script:`export default {async fetch(request,env){return Response.json(await env[new URL(request.url).pathname==='/portal'?'PORTAL':'CORE'].record(await request.json()));}};`,
  }]}));
  t.after(()=>mf.dispose());
  const worker=await mf.getWorker('security'),caller=await mf.getWorker('caller');
  const ns=await mf.getDurableObjectNamespace('SECURITY_HUB','security'),stub=ns.get(ns.idFromName(singleton));
  const call=(path,opts)=>worker.fetch(`https://security.invalid${path}`,opts);
  const admin=(path,method='POST')=>call(`/admin/${path}`,{method,headers:{Authorization:`Bearer ${secret}`}});
  const record=async(payload,path='/core')=>(await caller.fetch(`https://caller.invalid${path}`,{method:'POST',body:JSON.stringify(payload)})).json();
  const reset=async()=>{await stub.testReset();sent.length=0;reply={ok:true};release=undefined;queries.length=0;analyticsReply={errors:[{message:'not authorized'}]};};
  const prepare=async()=>{await stub.testControl({enabled:true,analytics:{cursor:null,lastSuccess:null,nextTry:Date.now()+3600000,status:'unknown',code:'not_started',sampled:true}});};

  await t.test('public HTTP cannot ingest, read status, control schedules or spoof named app identity',async()=>{
    await reset();
    assert.equal((await call('/healthz')).status,200);
    for(const path of ['/record','/hooks/cloudflare','/status','/admin/start','/admin/status'])assert.ok([401,404].includes((await call(path,{method:'POST',body:'{}'})).status));
    assert.equal((await admin('start?target=https://attacker.invalid')).status,404);
    assert.equal((await call('/admin/start',{method:'POST',headers:{Authorization:secret}})).status,401);
    assert.equal((await call('/admin/start',{method:'POST',headers:{Authorization:`Bearer ${secret}`},body:'{}'})).status,400);
    assert.equal((await stub.testRows()).alarm,null);
    for(const payload of [event('auth_failure',{source:'portal'}),event('auth_failure',{email:'secret@example.test'}),event('auth_failure',{occurredAt:Date.now()-301000}),event('auth_failure',{occurredAt:Date.now()+31000}),event('auth_failure',{actorHash:'<@everyone>'})])assert.deepEqual(await record(payload),{accepted:false,reason:'invalid'});
    assert.deepEqual((await stub.testRows()).outbox,[]);
  });
  await t.test('five failures for one actor queue once; duplicate ID does not add a failure or second alert',async()=>{
    await reset();const first=event();assert.deepEqual(await record(first),{accepted:true});assert.deepEqual(await record(first),{accepted:true,duplicate:true});
    for(let i=0;i<3;i++)await record(event());assert.equal((await stub.testRows()).outbox.length,0);
    await record(event());const rows=await stub.testRows();assert.equal(rows.outbox.length,1);
    const alert=JSON.parse(rows.outbox[0].alert);assert.equal(alert.kind,'auth_failure_burst');assert.equal(alert.source,'core');assert.equal(alert.count,5);assert.equal(alert.severity,'warning');
    for(let i=0;i<6;i++)await record(event());assert.equal((await stub.testRows()).outbox.length,1);
  });
  await t.test('global fixed bucket detects distributed password spray with no per-actor burst',async()=>{
    await reset();for(let i=0;i<20;i++)await record(event('auth_failure',{actorHash:i.toString(16).padStart(64,'0')}));
    const rows=await stub.testRows();assert.equal(rows.outbox.length,1);const alert=JSON.parse(rows.outbox[0].alert);
    assert.equal(alert.count,20);assert.equal(alert.subjectHash,undefined);assert.equal(alert.kind,'auth_failure_burst');
  });
  await t.test('pinned portal identity and critical observed changes never assert compromise or retain extra values',async()=>{
    await reset();const input=event('totp_disabled');await record(input,'/portal');await record(input,'/portal');
    const rows=await stub.testRows();assert.equal(rows.outbox.length,1);const alert=JSON.parse(rows.outbox[0].alert);
    assert.equal(alert.source,'portal');assert.equal(alert.host,'partner-portal.opus-system.jp');assert.equal(alert.severity,'critical');assert.equal(alert.kind,'totp_disabled');
    await record(event('totp_disabled'),'/portal');assert.equal((await stub.testRows()).outbox.length,2);
    assert.doesNotMatch(rows.outbox[0].alert,/email|password=|Cookie|Bearer|secret/);
  });
  await t.test('event and delivery capacity fail visibly without unbounded outbox or new keys',async()=>{
    await reset();await stub.testControl({seenCount:2048});assert.deepEqual(await record(event()),{accepted:false,reason:'capacity'});
    let rows=await stub.testRows();assert.equal(rows.control.rejected,1);assert.equal(rows.control.saturated,true);
    await reset();for(let i=0;i<110;i++)for(let n=0;n<5;n++)await record(event('auth_failure',{actorHash:i.toString(16).padStart(64,'0')}));
    rows=await stub.testRows();assert.equal(rows.control.quota.regular.pending,96);assert.equal(rows.control.quota.pipeline.pending,1);assert.equal(rows.control.saturated,true);
    await record(event('account_locked'));await record(event('security_policy_weakened'));rows=await stub.testRows();assert.equal(rows.control.quota.critical.pending,1);assert.equal(rows.control.quota.locked.pending,1);assert.ok(rows.outbox.length<=128);
    assert.ok(rows.buckets.length<=280);assert.equal((await stub.status()).readiness,'unknown');
  });
  await t.test('sensitive committed changes retain reserved ingress and dispatch ahead of warning backlog',async()=>{
    await reset();await stub.testControl({seenCount:1792});assert.deepEqual(await record(event()),{accepted:false,reason:'capacity'});
    assert.deepEqual(await record(event('totp_disabled')),{accepted:true});
    await reset();for(let i=0;i<8;i++)for(let n=0;n<5;n++)await record(event('auth_failure',{actorHash:i.toString(16).padStart(64,'0')}));
    await record(event('security_policy_weakened'));await prepare();await stub.testAlarm();
    assert.equal(sent[0].kind,'security_policy_weakened');assert.equal(sent[0].severity,'critical');
    assert.ok((await stub.testRows()).outbox.length>0);
  });
  await t.test('failed Slack sends persist bounded backoff and reuse stable alert ID on retry',async()=>{
    await reset();await record(event('account_locked'));await prepare();reply={ok:false,code:'rate_limited',retryAfterMs:120000};
    await stub.testAlarm();let rows=await stub.testRows();assert.equal(sent.length,1);assert.equal(rows.outbox[0].attempts,1);assert.ok(rows.outbox[0].next>=Date.now()+119000);assert.equal(rows.control.sent,0);
    const id=sent[0].id;reply={ok:true};await stub.testDue();await stub.testAlarm();rows=await stub.testRows();assert.equal(sent.length,2);assert.equal(sent[1].id,id);assert.equal(rows.outbox.length,0);assert.equal(rows.control.sent,1);assert.equal(rows.receipts[0].status,'sent');
  });
  await t.test('leased sends exclude concurrent alarms; successor is already scheduled during network work',async()=>{
    await reset();await record(event('account_locked'));await prepare();release=[];
    const running=stub.testAlarm();const until=Date.now()+3000;while(sent.length<1&&Date.now()<until)await new Promise(resolve=>setTimeout(resolve,10));assert.equal(sent.length,1);
    const during=await stub.testRows();assert.ok(during.alarm>Date.now());assert.ok(during.outbox[0].lease_until>Date.now());
    await stub.testAlarm();assert.equal(sent.length,1);for(const done of release)done();release=undefined;await running;
    assert.equal((await stub.testRows()).control.sent,1);
  });
  await t.test('a successful old Slack ACK is retained across stop/start but the stale invocation cannot send its next row',async()=>{
    await reset();await record(event('account_locked'));await record(event('totp_disabled'));await prepare();release=[];
    const running=stub.testAlarm();const until=Date.now()+3000;while(sent.length<1&&Date.now()<until)await new Promise(resolve=>setTimeout(resolve,10));assert.equal(sent.length,1);
    const before=await stub.testRows();await stub.stop();await stub.start();
    for(const done of release)done();release=undefined;await running;
    const after=await stub.testRows();assert.equal(sent.length,1);assert.equal(after.control.sent,1);assert.equal(after.control.pending,1);assert.ok(after.control.generation>before.control.generation);assert.equal(after.control.active,null);
    await stub.stop();
  });
  await t.test('bounded WAF catch-up closes backlog and alerts use the actual sampled query interval',async()=>{
    await reset();const end=Math.floor((Date.now()-90000)/60000)*60000;
    analyticsReply={data:{viewer:{zones:[{firewallEventsAdaptiveGroups:[{count:3,dimensions:{action:'block',clientRequestHTTPHost:'core-os.opus-system.jp'}}]}]}}};
    await stub.testControl({enabled:true,analytics:{cursor:end-10*60000,lastSuccess:null,nextTry:0,status:'unknown',code:'analytics_gap',sampled:true,diagnostic:{code:'graphql_forbidden',httpStatus:200,at:Date.now()}}});
    await stub.testAlarm();let rows=await stub.testRows();assert.equal(queries.length,1);assert.equal(rows.control.analytics.cursor,end-5*60000);assert.equal(rows.control.analytics.status,'unknown');
    const alert=sent.find(x=>x.kind==='waf_activity');assert.ok(alert);assert.equal(alert.windowStart,end-10*60000);assert.equal(alert.windowEnd,end-5*60000);assert.equal(alert.detailCode,'sampled_waf');
    await stub.testAlarm();rows=await stub.testRows();assert.equal(queries.length,2);assert.equal(rows.control.analytics.cursor,end);assert.equal(rows.control.analytics.status,'ok');assert.equal(rows.control.analytics.diagnostic,null);
    assert.deepEqual(queries[0].variables.hosts,['core-os.opus-system.jp','partner-portal.opus-system.jp']);assert.doesNotMatch(queries[0].query,/clientIP|clientRequestPath|clientRequestQuery/);
  });
  await t.test('missing Analytics permission remains unknown, queues operational warning and avoids fabricated zero',async()=>{
    await reset();await stub.testControl({enabled:true});await stub.testAlarm();const rows=await stub.testRows();
    assert.equal(rows.control.analytics.status,'unknown');assert.equal(rows.control.analytics.code,'analytics_unavailable');assert.equal(rows.control.analytics.lastSuccess,null);
    assert.deepEqual(rows.control.analytics.diagnostic.code,'graphql_unauthorized');assert.equal(rows.control.analytics.diagnostic.httpStatus,200);assert.ok(Number.isSafeInteger(rows.control.analytics.diagnostic.at));
    assert.doesNotMatch(await (await call('/healthz')).text(),/diagnostic|graphql_|not authorized/);
    assert.ok(rows.control.analytics.nextTry>Date.now());assert.ok(sent.some(x=>x.kind==='pipeline_degraded'&&x.detailCode==='analytics_unavailable'));
  });
  await t.test('a real runtime alarm dispatches the persisted queue and schedules its successor',async()=>{
    await reset();await record(event('account_locked'));
    await stub.testControl({analytics:{cursor:null,lastSuccess:null,nextTry:Date.now()+3600000,status:'unknown',code:'not_started',sampled:true}});
    await stub.start();const until=Date.now()+4000;while(sent.length<1&&Date.now()<until)await new Promise(resolve=>setTimeout(resolve,20));
    const rows=await stub.testRows();assert.equal(sent.length,1);assert.ok(rows.control.lastAlarm!==null);assert.ok(rows.alarm>Date.now());assert.equal(rows.outbox.length,0);await stub.stop();
  });
  await t.test('explicit dead-letter acknowledgement requires fresh healthy idle pipeline and preserves history',async()=>{
    await reset();await stub.testReceipt();await stub.testControl({dead:1});
    assert.deepEqual(await (await admin('acknowledge')).json(),{acknowledged:false,reason:'not_ready'});
    const fresh={cursor:Date.now()-120000,lastSuccess:Date.now(),nextTry:0,status:'ok',code:null,sampled:true};
    await stub.testControl({enabled:true,analytics:fresh,active:{token:'test-active',until:Date.now()+10000,generation:1}});
    assert.deepEqual(await (await admin('acknowledge')).json(),{acknowledged:false,reason:'not_ready'});
    await stub.testControl({active:null,pending:1});assert.deepEqual(await (await admin('acknowledge')).json(),{acknowledged:false,reason:'not_ready'});
    await stub.testControl({pending:0});assert.equal((await (await admin('acknowledge')).json()).acknowledged,true);
    const rows=await stub.testRows();assert.equal(rows.control.dead,1);assert.equal(rows.control.deadAcknowledged,1);assert.equal(rows.receipts.length,1);assert.equal((await stub.status()).unacknowledgedDead,0);
    assert.equal((await call('/admin/acknowledge',{method:'POST'})).status,401);
    assert.equal((await call('/admin/acknowledge',{method:'POST',headers:{Authorization:`Bearer ${secret}`},body:'{}'})).status,400);
  });
  await t.test('stop is durable; public reads do not restart; explicit idempotent start creates one alarm',async()=>{
    await reset();const start=await (await admin('start')).json();const again=await (await admin('start')).json();assert.deepEqual(start,again);
    assert.equal(start.enabled,true);assert.ok((await stub.testRows()).alarm>Date.now());await admin('stop');
    assert.equal((await stub.testRows()).alarm,null);await call('/healthz');assert.equal((await stub.testRows()).alarm,null);assert.equal((await stub.status()).enabled,false);
  });
});
