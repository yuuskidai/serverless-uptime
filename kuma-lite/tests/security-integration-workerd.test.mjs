import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require=createRequire(import.meta.url),wranglerRequire=createRequire(require.resolve('wrangler/package.json'));
const {Miniflare,convertV4MiniflareOptions}=wranglerRequire('miniflare');
const {buildSync}=wranglerRequire('esbuild');
const singleton='fixed-security-hub-v1';
const buildFixture=integrated=>buildSync({stdin:{contents:`
  import {SecurityHub as ExistingSecurityHub} from '../security-alerts/src/hub.ts';
  import {SecurityHub as IntegratedSecurityHub,handleSecurityAdminRequest} from './src/security-integration.ts';
  export {CoreSecurityEvents,PortalSecurityEvents} from './src/security-integration.ts';
  const realNow=Date.now.bind(Date);let clock=null;Date.now=()=>clock??realNow();
  console.info=console.log=console.error=console.warn=()=>{};
  export default {fetch(request,env){return handleSecurityAdminRequest(request,env);}};
  const fingerprint=async storage=>{
    const tables=['control','seen','buckets','outbox','receipts'];
    const data=tables.map(table=>storage.sql.exec('SELECT * FROM '+table+' ORDER BY 1').toArray());
    data.push(await storage.getAlarm());
    return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(data))))).join(',');
  };
  export class TestHub extends ${integrated?'IntegratedSecurityHub':'ExistingSecurityHub'} {
    async testSeedPreservation(){
      const now=Date.now(),future=now+3600000;
      const c=JSON.parse(this.ctx.storage.sql.exec('SELECT value FROM control WHERE id=1').one().value);
      c.enabled=true;c.generation=37;c.lastAlarm=now-60000;c.active={token:crypto.randomUUID(),until:future,generation:37};
      c.pending=1;c.queuedToday=1;c.criticalSeenCount=1;c.sent=1;c.quota.critical={pending:1,day:1};
      c.analytics={cursor:now-120000,lastSuccess:now,nextTry:future,status:'ok',code:null,sampled:true};
      this.ctx.storage.sql.exec('UPDATE control SET value=? WHERE id=1',JSON.stringify(c));
      const alert={version:1,id:crypto.randomUUID(),source:'core',kind:'admin_privilege_changed',severity:'critical',occurredAt:now,windowStart:now,windowEnd:now,count:1};
      this.ctx.storage.sql.exec('INSERT INTO outbox(id,alert,attempts,next,lease_until,lease_token,created,priority) VALUES(?,?,2,?,?,?,?,?)',alert.id,JSON.stringify(alert),now,future,crypto.randomUUID(),now,'critical');
      this.ctx.storage.sql.exec('INSERT INTO seen(id,expires,priority) VALUES(?,?,?)',crypto.randomUUID(),future,'critical');
      this.ctx.storage.sql.exec('INSERT INTO buckets(key,start,count,last_alert,updated) VALUES(?,?,?,?,?)','global:core:auth_failure',now,3,now,now);
      this.ctx.storage.sql.exec('INSERT INTO receipts(id,status,at,alert) VALUES(?,?,?,?)',crypto.randomUUID(),'sent',now,JSON.stringify(alert));
      await this.ctx.storage.setAlarm(future);
      await this.ctx.storage.put('fixture_integrity',await fingerprint(this.ctx.storage));
    }
    async testIntegrity(){return {preserved:(await this.ctx.storage.get('fixture_integrity'))===await fingerprint(this.ctx.storage),
      alarm_present:(await this.ctx.storage.getAlarm())!==null};}
    async testCapabilities(){return {local_notifier:typeof this.env.SLACK_NOTIFIER?.sendSecurityAlert==='function',
      analytics_credential_present:typeof this.env.CF_ANALYTICS_TOKEN==='string',legacy_admin_secret_present:this.env.ADMIN_SECRET!==undefined};}
    async testCounts(){
      const c=JSON.parse(this.ctx.storage.sql.exec('SELECT value FROM control WHERE id=1').one().value);
      return {generation:c.generation,active_present:c.active!==null,pending:c.pending,sent:c.sent,dead:c.dead,
        outbox:this.ctx.storage.sql.exec('SELECT count(*) n FROM outbox').one().n,
        receipts:this.ctx.storage.sql.exec('SELECT count(*) n FROM receipts').one().n,
        core:this.ctx.storage.sql.exec("SELECT count(*) n FROM outbox WHERE json_extract(alert,'$.source')='core'").one().n,
        portal:this.ctx.storage.sql.exec("SELECT count(*) n FROM outbox WHERE json_extract(alert,'$.source')='portal'").one().n};
    }
    async testPrepareDelivery(){
      const c=JSON.parse(this.ctx.storage.sql.exec('SELECT value FROM control WHERE id=1').one().value);
      c.enabled=true;c.analytics.nextTry=Date.now()+3600000;
      this.ctx.storage.sql.exec('UPDATE control SET value=? WHERE id=1',JSON.stringify(c));
    }
    async testAdvance(){clock=(clock??realNow())+60001;}
    async testAlarm(){await this.alarm();}
  }
`,resolveDir:fileURLToPath(new URL('../',import.meta.url)),sourcefile:'local-security-integration-fixture.js'},
  bundle:true,format:'esm',platform:'browser',external:['cloudflare:workers'],write:false}).outputFiles[0].text;

test('integrated native SecurityHub preserves SQLite state and trusted interfaces',async t=>{
  const api='local-monitor-api',channel='C12345678';
  let slackCalls=0,firstMessageId=null,sameMessageId=true,unexpectedOutbound=0;
  const options={workers:[{
    name:'integrated-security-test',script:buildFixture(false),modules:true,compatibilityDate:'2025-01-01',
    durableObjects:{SECURITY_HUB:{className:'TestHub',useSQLite:true}},
    bindings:{API_TOKEN:api,SLACK_BOT_TOKEN:'local-only',SLACK_DEFAULT_CHANNEL:channel,CF_API_TOKEN:'unused-local-management'},
    outboundService:async request=>{
      if(request.url!=='https://slack.com/api/chat.postMessage'){unexpectedOutbound++;throw Error('Unexpected local outbound');}
      slackCalls++;const body=await request.json();
      if(firstMessageId===null)firstMessageId=body.client_msg_id;else sameMessageId&&=firstMessageId===body.client_msg_id;
      return slackCalls===1?new Response('',{status:429,headers:{'Retry-After':'1'}}):Response.json({ok:true,channel,ts:'1790000000.000001'});
    },
  },{
    name:'security-caller-test',modules:true,compatibilityDate:'2025-01-01',
    serviceBindings:{CORE:{name:'integrated-security-test',entrypoint:'CoreSecurityEvents'},PORTAL:{name:'integrated-security-test',entrypoint:'PortalSecurityEvents'}},
    script:`export default {async fetch(request,env){const route=new URL(request.url).pathname;return Response.json(await env[route==='/portal'?'PORTAL':'CORE'].record(await request.json()));}};`,
  }]};
  const mf=new Miniflare(convertV4MiniflareOptions(options));t.after(()=>mf.dispose());
  let namespace=await mf.getDurableObjectNamespace('SECURITY_HUB','integrated-security-test');
  const initialId=namespace.idFromName(singleton).toString();
  await namespace.get(namespace.idFromName(singleton)).testSeedPreservation();
  options.workers[0].script=buildFixture(true);
  await mf.setOptions(convertV4MiniflareOptions(options));
  namespace=await mf.getDurableObjectNamespace('SECURITY_HUB','integrated-security-test');
  const stub=namespace.get(namespace.idFromName(singleton)),worker=await mf.getWorker('integrated-security-test');
  const caller=await mf.getWorker('security-caller-test');
  const admin=(path,extra={})=>worker.fetch('https://monitor.invalid/api/security/'+path,{headers:{Authorization:'Bearer '+api},...extra});
  const event={version:1,eventId:crypto.randomUUID(),occurredAt:Date.now(),kind:'admin_privilege_changed'};
  const record=async(value,path='/core')=>(await caller.fetch('https://caller.invalid'+path,{method:'POST',body:JSON.stringify(value)})).json();

  await t.test('same namespace and existing state survive constructor and script reload',async()=>{
    assert.equal(namespace.idFromName(singleton).toString()===initialId,true);
    const proof=await stub.testIntegrity();assert.equal(proof.preserved,true);assert.equal(proof.alarm_present,true);
    const state=await stub.testCounts();assert.equal(state.generation,37);assert.equal(state.active_present,true);
    assert.equal(state.pending,1);assert.equal(state.outbox,1);assert.equal(state.receipts,1);
    const caps=await stub.testCapabilities();assert.equal(caps.local_notifier,true);
    assert.equal(caps.analytics_credential_present,false);assert.equal(caps.legacy_admin_secret_present,false);
  });

  await t.test('admin uses API_TOKEN without monitor D1 or old secret and rejects mutation parameters',async()=>{
    assert.equal((await worker.fetch('https://monitor.invalid/api/security/status')).status,401);
    assert.equal((await admin('status?target=other')).status,404);
    assert.equal((await admin('start',{method:'POST',body:'{}'})).status,400);
    assert.equal((await admin('record',{method:'POST'})).status,404);
    const response=await admin('status');assert.equal(response.status,200);
    const status=await response.json();assert.equal(status.service,'helth-security');assert.equal(status.generation,37);
    assert.equal((await stub.testIntegrity()).preserved,true);assert.equal(slackCalls,0);assert.equal(unexpectedOutbound,0);
  });

  await t.test('named app bindings retain source pinning, validation and durable deduplication',async()=>{
    assert.equal((await record({...event,source:'portal'})).accepted,false);
    assert.equal((await record(event)).accepted,true);assert.equal((await record(event)).duplicate,true);
    assert.equal((await record(event,'/portal')).accepted,true);
    const state=await stub.testCounts();assert.equal(state.core,2);assert.equal(state.portal,1);assert.equal(state.pending,3);
    assert.equal(slackCalls,0);assert.equal(unexpectedOutbound,0);
  });

  await t.test('local Slack adapter preserves retry timing and stable message id inside hub ownership',async()=>{
    const delivery=namespace.get(namespace.idFromName('local-delivery-fixture'));
    await delivery.testPrepareDelivery();
    assert.equal((await delivery.recordApp('core',{...event,eventId:crypto.randomUUID()})).accepted,true);
    await delivery.testAlarm();
    let state=await delivery.testCounts();assert.equal(slackCalls,1);assert.equal(state.pending,1);assert.equal(state.sent,0);
    await delivery.testAdvance();await delivery.testAlarm();
    state=await delivery.testCounts();assert.equal(slackCalls,2);assert.equal(sameMessageId,true);
    assert.equal(state.pending,0);assert.equal(state.outbox,0);assert.equal(state.sent,1);assert.equal(state.dead,0);
    assert.equal(state.receipts,1);assert.equal(unexpectedOutbound,0);
  });
});
