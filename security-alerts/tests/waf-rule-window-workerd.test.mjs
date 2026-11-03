import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';

const require=createRequire(new URL('../../kuma-lite/package.json',import.meta.url));
const runtimeRequire=createRequire(require.resolve('wrangler/package.json'));
const {Miniflare,convertV4MiniflareOptions}=runtimeRequire('miniflare');
const {buildSync}=runtimeRequire('esbuild');
const singleton='synthetic-rule-window';
const minute=60_000;
const bundle=buildSync({stdin:{contents:`
  import {WorkerEntrypoint} from 'cloudflare:workers';
  import {SecurityHub} from './src/hub.ts';
  import {validSecurityAlert} from '../kuma-lite/src/security-notifications.ts';
  export class TestNotifier extends WorkerEntrypoint {
    async sendSecurityAlert(alert){return validSecurityAlert(alert)?{ok:true}:{ok:false,code:'invalid_alert'};}
  }
  export class TestHub extends SecurityHub {
    async testBump(input){
      return this.ctx.storage.transactionSync(()=>{
        const c=this.control();
        const queued=this.bump(c,input.key,input.count,1,input.now,
          {source:'waf',kind:'waf_activity',severity:'warning',occurredAt:input.now,
            host:'core-os.opus-system.jp',action:'block',detailCode:'sampled_waf'},
          input.allowAlert??true,input.start,input.ruleCounts);
        this.save(c);return queued;
      });
    }
    async testSeed(input){
      this.ctx.storage.transactionSync(()=>{
        this.ctx.storage.sql.exec('INSERT OR REPLACE INTO buckets(key,start,count,last_alert,updated) VALUES(?,?,?,?,?)',
          input.key,input.start,input.count,input.lastAlert,input.start);
      });
    }
    async testRows(){
      const c=this.control();
      const alerts=this.ctx.storage.sql.exec('SELECT alert FROM outbox ORDER BY created,id').toArray()
        .map(row=>{const alert=JSON.parse(row.alert);return {alert,bridgeValid:validSecurityAlert(alert)};});
      const receipts=this.ctx.storage.sql.exec('SELECT alert,status FROM receipts ORDER BY at,id').toArray()
        .map(row=>{const alert=JSON.parse(row.alert);return {alert,status:row.status,bridgeValid:validSecurityAlert(alert)};});
      return {windows:c.wafRuleWindows??{},buckets:this.ctx.storage.sql.exec('SELECT key,start,count,last_alert FROM buckets').toArray(),
        alerts,receipts,queued:c.queuedToday,pending:c.pending,alarm:await this.ctx.storage.getAlarm(),
        objectPrototypeUnmodified:Object.prototype.syntheticRulePollution===undefined};
    }
    async testEnable(start){
      this.ctx.storage.transactionSync(()=>{
        const c=this.control();c.enabled=true;c.generation++;
        c.analytics={...c.analytics,cursor:start,nextTry:0,status:'unknown',code:'not_started'};this.save(c);
      });
    }
    async testAlarm(){await this.alarm();}
  }
  export default {fetch(){return new Response('notfound',{status:404});}};
`,resolveDir:fileURLToPath(new URL('../',import.meta.url)),sourcefile:'synthetic-waf-rule-window.js'},bundle:true,format:'esm',platform:'browser',external:['cloudflare:workers'],write:false}).outputFiles[0].text;
const counts=(rules,unknownCount=0,otherCount=0,limited=false)=>({rules,unknownCount,otherCount,limited});
const rule=(ruleId,count,description)=>({ruleId,count,...(description?{description}:{})});
const sum=summary=>summary.rules.reduce((n,r)=>n+r.count,0)+summary.otherCount+summary.unknownCount;

test('native SQLite WAF windows retain correct rule attribution and the existing notification cadence',{timeout:30_000},async t=>{
  const queries=[];
  const mf=new Miniflare(convertV4MiniflareOptions({workers:[{
    name:'rules',script:bundle,modules:true,compatibilityDate:'2025-01-01',
    durableObjects:{HUB:{className:'TestHub',useSQLite:true}},
    bindings:{CF_ANALYTICS_TOKEN:'synthetic-local-token'},
    serviceBindings:{SLACK_NOTIFIER:{name:'rules',entrypoint:'TestNotifier'}},
    outboundService:async request=>{
      const query=await request.json();queries.push(query);
      const datetime=query.variables.filter.datetime_geq;
      return Response.json({data:{viewer:{zones:[{firewallEventsAdaptive:[
        {action:'block',clientRequestHTTPHost:'core-os.opus-system.jp',datetime,source:'firewallManaged',ruleId:'alarm-rule-a',description:'React RCE'},
        {action:'block',clientRequestHTTPHost:'core-os.opus-system.jp',datetime,source:'firewallManaged',ruleId:'alarm-rule-b',description:'Second rule'},
      ]}]}}});
    },
  }]}));
  t.after(()=>mf.dispose());
  const ns=await mf.getDurableObjectNamespace('HUB','rules');
  let sequence=0;
  const instance=()=>ns.get(ns.idFromName(singleton+'-'+sequence++));
  const key='waf:core-os.opus-system.jp:block';
  const base=Date.now()-30*minute;
  const bump=(stub,now,count,ruleCounts,start=base,allowAlert=true)=>stub.testBump({key,start,now,count,ruleCounts,allowAlert});

  await t.test('different polls in the same window contribute only their own rule counts',async()=>{
    const stub=instance();await stub.testSeed({key,start:base,count:0,lastAlert:base-14*minute});
    assert.equal(await bump(stub,base,2,counts([rule('rule-a',2,'First rule')])),false);
    assert.equal(await bump(stub,base+minute,3,counts([rule('rule-b',3,'Second rule')])),true);
    const before=await stub.testRows();assert.equal(before.alerts.length,1);
    const queued=before.alerts[0];assert.equal(queued.bridgeValid,true);assert.equal(queued.alert.count,5);
    assert.deepEqual(queued.alert.ruleSummary.rules,[rule('rule-b',3,'Second rule'),rule('rule-a',2,'First rule')]);
    assert.equal(queued.alert.windowStart,base);assert.equal(queued.alert.windowEnd,base+minute);
    await bump(stub,base+2*minute,4,counts([rule('rule-c',4,'Later rule')]));
    const after=await stub.testRows();assert.equal(after.alerts.length,1);
    assert.deepEqual(after.alerts[0],queued,'a later suppressed poll must not relabel a queued alert');
    assert.equal(after.windows[key].count,9);assert.equal(sum(after.windows[key].breakdown),9);
  });

  await t.test('five-minute count reset does not remove the fifteen-minute notification cooldown',async()=>{
    const stub=instance();assert.equal(await bump(stub,base,2,counts([rule('first',2)])),true);
    assert.equal(await bump(stub,base+5*minute,4,counts([rule('suppressed',4)]),base+5*minute),false);
    let rows=await stub.testRows();assert.equal(rows.alerts.length,1);
    assert.equal(rows.windows[key].start,base+5*minute);assert.equal(rows.windows[key].count,4);
    assert.deepEqual(rows.windows[key].breakdown.rules,[rule('suppressed',4)]);
    assert.equal(await bump(stub,base+15*minute,1,counts([rule('next-window',1)]),base+15*minute),true);
    rows=await stub.testRows();assert.equal(rows.alerts.length,2);
    const alerts=rows.alerts.map(row=>row.alert).sort((a,b)=>a.windowStart-b.windowStart);assert.ok(rows.alerts.every(row=>row.bridgeValid));
    assert.deepEqual(alerts.map(alert=>alert.count),[2,1]);
    const next=alerts.find(alert=>alert.windowStart===base+15*minute);
    assert.deepEqual(next.ruleSummary,counts([rule('next-window',1)]));
  });

  await t.test('legacy SQL counts without metadata become unknown rather than the latest rule count',async()=>{
    const stub=instance();await stub.testSeed({key,start:base,count:7,lastAlert:0});
    await bump(stub,base+minute,3,counts([rule('new-rule',3,'Only newly observed metadata')]));
    const rows=await stub.testRows();assert.equal(rows.alerts.length,1);
    const {alert,bridgeValid}=rows.alerts[0];assert.equal(bridgeValid,true);assert.equal(alert.count,10);
    assert.deepEqual(alert.ruleSummary,counts([rule('new-rule',3,'Only newly observed metadata')],7));
    assert.equal(sum(alert.ruleSummary),10);
  });

  await t.test('display and retained-rule caps preserve unknown and other totals with bounded JSON',async()=>{
    const stub=instance();const rules=Array.from({length:32},(_,i)=>rule(`rule-${String(i).padStart(2,'0')}`,i+1,`Rule ${i}`));
    await bump(stub,base,541,counts(rules,4,9,true));
    const first=await stub.testRows();const {alert,bridgeValid}=first.alerts[0];
    assert.equal(bridgeValid,true);assert.equal(alert.ruleSummary.rules.length,3);
    assert.deepEqual(alert.ruleSummary.rules.map(rule=>rule.count),[32,31,30]);
    assert.equal(alert.ruleSummary.otherCount,444);assert.equal(alert.ruleSummary.unknownCount,4);
    assert.equal(alert.ruleSummary.limited,true);assert.equal(sum(alert.ruleSummary),541);
    await bump(stub,base+minute,2,counts([rule('rule-over-cap',2)]));
    const after=await stub.testRows();assert.equal(after.alerts.length,1);
    assert.equal(after.windows[key].breakdown.rules.length,32);assert.equal(after.windows[key].breakdown.otherCount,11);
    assert.equal(sum(after.windows[key].breakdown),543);
  });

  await t.test('opaque prototype-like IDs survive JSON persistence and invalid metadata remains unknown',async()=>{
    const stub=instance();await bump(stub,base,6,counts([rule('__proto__',3),rule('constructor',2),rule('toString',1)]));
    const rows=await stub.testRows();assert.equal(rows.objectPrototypeUnmodified,true);
    assert.equal(rows.alerts[0].bridgeValid,true);assert.equal(sum(rows.alerts[0].alert.ruleSummary),6);
    assert.deepEqual(new Set(rows.windows[key].breakdown.rules.map(rule=>rule.ruleId)),new Set(['__proto__','constructor','toString']));
    const invalid=instance();await bump(invalid,base,2,counts([rule('invalid-control',2,'bad\nlabel')]));
    const alert=(await invalid.testRows()).alerts[0];assert.equal(alert.bridgeValid,true);
    assert.deepEqual(alert.alert.ruleSummary,counts([],2));
  });

  await t.test('the actual alarm collects rule metadata and dispatches an alert accepted by the real bridge validator',async()=>{
    const stub=instance();const queryEnd=Math.floor((Date.now()-90000)/minute)*minute;
    await stub.testEnable(queryEnd-minute);await stub.testAlarm();await stub.stop();
    const rows=await stub.testRows();assert.equal(rows.pending,0);assert.equal(rows.receipts.length,1);
    const receipt=rows.receipts[0];assert.equal(receipt.status,'sent');assert.equal(receipt.bridgeValid,true);
    assert.equal(receipt.alert.count,2);assert.deepEqual(receipt.alert.ruleSummary,counts([rule('alarm-rule-a',1,'React RCE'),rule('alarm-rule-b',1,'Second rule')]));
    assert.equal(rows.alarm,null);assert.equal(queries.length,1);assert.match(queries[0].query,/ruleId description/);
  });
});
