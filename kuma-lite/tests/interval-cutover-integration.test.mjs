import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTs, result, sqliteEnv } from './helpers.mjs';

const execution=loadTs('monitor-execution');
const {performCheck}=loadTs('monitor');
const {deriveTransition}=loadTs('state-transition');
const {monitorFreshness}=loadTs('monitor-readiness');
const {resolveCheckIntervalMs,historicalIntervalSql}=loadTs('check-schedule');
const {renderRssFeed}=loadTs('rss-feed');
const {renderStatusPage}=loadTs('status-page',{'./external-observations':{getExternalSummaries:async()=>new Map(),CLOUDFLARE_WITNESS_STATUS_URL:'https://witness.example.invalid/status'}});
const MINUTE=60000,SLOT=Math.floor(Date.now()/120000)*120000;

function readSafeState(f){return f.sqlite.prepare('SELECT current_status,consecutive_failures,consecutive_degraded,consecutive_successes,last_check_slot,config_revision FROM monitor_state WHERE monitor_id=1').get();}
function historyCheck(f,{id=1,slot,revision,status='down',trace=null}){
 f.sqlite.prepare(`INSERT INTO checks(monitor_id,status,ts,scheduled_slot,config_revision,monitor_role,probe_transport,status_code,latency_ms,in_maintenance,probe_trace_json)
  VALUES(?,?,?,?,?,'availability','public_fetch',?,100,0,?)`).run(id,status,slot+1000,slot,revision,status==='down'?503:200,trace);
}
const feed=async f=>(await renderRssFeed(f.env,new URL('https://status.example.invalid/rss.xml'))).text();

test('two-minute runner uses actual threshold/snapshot and never probes or advances state on planned minutes',async()=>{
 const f=sqliteEnv(),notifications=[];let probes=0;
 try{
  f.sqlite.exec("UPDATE monitors SET interval_minutes=2,db_latency_threshold_ms=1500,config_revision=2,timeout_ms=10000,service_binding='CORE_OS',probe_transport='legacy',response_mode='legacy_http' WHERE id=1");
  const readings=[1200,1800,1800,'down','down',100];
  f.env.CORE_OS={async fetch(_url,init){const value=readings[probes++],down=value==='down',db=down?2500:value;
   const reason=down?'Synthetic database pending':'\u5fdc\u7b54\u304c 800ms \u3092\u8d85\u904e ('+db+'ms)';
   return Response.json({status:down?'down':db>=800?'degraded':'ok',version:'synthetic',reason:down||db>=800?reason:null,
    components:[{name:'Database',status:down?'down':db>=800?'degraded':'ok',latency_ms:db,...(down||db>=800?{reason}:{})}]},
    {status:down?503:200,headers:{'X-Monitor-Request-ID':new Headers(init.headers).get('X-Monitor-Request-ID')}});
  }};
  const run=loadTs('monitor-runner',{'./monitor':{performCheck},'./state-notifications':{async notifyTransition(_env,_monitor,_result,transition){notifications.push(transition.kind);return{slackAlertTs:null};}}}).runChecks;
  await run(f.env,SLOT);
  const first=f.sqlite.prepare('SELECT status,healthz_status,probe_trace_json FROM checks ORDER BY id LIMIT 1').get();
  assert.equal(first.status,'up');assert.equal(first.healthz_status,'ok');
  assert.equal(JSON.parse(first.probe_trace_json)[0].interval_minutes,2);
  for(let index=0;index<6;index++){
   if(index>0)await run(f.env,SLOT+index*2*MINUTE);
   const before=readSafeState(f),checks=f.sqlite.prepare('SELECT count(*) AS n FROM checks').get().n,events=notifications.length;
   await run(f.env,SLOT+(index*2+1)*MINUTE);
   assert.equal(probes,index+1);assert.equal(f.sqlite.prepare('SELECT count(*) AS n FROM checks').get().n,checks);
   assert.deepEqual(readSafeState(f),before);assert.equal(notifications.length,events);
  }
  assert.deepEqual(notifications,['degraded','down','up']);
  assert.equal(f.sqlite.prepare('SELECT count(*) AS n FROM checks').get().n,6);
  assert.equal(f.sqlite.prepare("SELECT count(*) AS n FROM checks WHERE status='down' AND status_code=503").get().n,2);
  assert.equal(f.sqlite.prepare("SELECT count(*) AS n FROM checks WHERE json_extract(probe_trace_json,'$[0].interval_minutes')=2").get().n,6);
  assert.equal(readSafeState(f).current_status,'up');
 }finally{f.close();}
});

test('a missing expected two-minute slot breaks the next real failure streak without making a healthy result',()=>{
 const monitor={id:1,config_revision:2,interval_minutes:2,retry_threshold:2};
 const first=deriveTransition(monitor,result('down'),null,SLOT+1000,SLOT,false);
 const afterMissing=deriveTransition(monitor,result('down'),first.next,SLOT+4*MINUTE+1000,SLOT+4*MINUTE,false);
 assert.equal(first.kind,null);assert.equal(afterMissing.kind,null);assert.equal(afterMissing.next.consecutive_failures,1);
 assert.equal(afterMissing.next.last_check_slot,SLOT+4*MINUTE);
 const next=deriveTransition(monitor,result('down'),afterMissing.next,SLOT+6*MINUTE+1000,SLOT+6*MINUTE,false);
 assert.equal(next.kind,'down');assert.equal(next.next.current_status,'down');
});

test('interval/revision cutover keeps frozen one-minute historical SQL and RSS incidents',async()=>{
 const f=sqliteEnv();try{
  f.env.DB.withSession=()=>f.env.DB;
  f.sqlite.exec('UPDATE monitors SET id=5,config_revision=1,interval_minutes=1,db_latency_threshold_ms=1000 WHERE id=1');
  const start=SLOT-10*MINUTE;historyCheck(f,{id:5,slot:start,revision:1});historyCheck(f,{id:5,slot:start+MINUTE,revision:1});
  const key=`kuma-lite:incident:5:${start+1000}:ongoing`;
  assert.ok((await feed(f)).includes(key));
  f.sqlite.exec('UPDATE monitors SET interval_minutes=2,db_latency_threshold_ms=1500,config_revision=2 WHERE id=5');
  const monitor={id:5,config_revision:2,interval_minutes:2};
  assert.equal(resolveCheckIntervalMs(monitor,{config_revision:1,probe_trace_json:null}),MINUTE);
  const intervals=f.sqlite.prepare(`SELECT ${historicalIntervalSql('c')} AS interval_ms FROM checks c ORDER BY ts`).all();
  assert.deepEqual(intervals.map(row=>row.interval_ms),[MINUTE,MINUTE]);
  assert.ok((await feed(f)).includes(key));
  assert.equal(f.sqlite.prepare('SELECT count(*) AS n FROM checks WHERE config_revision=1').get().n,2);
 }finally{f.close();}
});

test('unknown preceding schedule does not bridge a two-minute RSS failure pair',async()=>{
 const f=sqliteEnv();try{
  f.env.DB.withSession=()=>f.env.DB;f.sqlite.exec('UPDATE monitors SET interval_minutes=2,config_revision=2 WHERE id=1');
  const start=SLOT-10*MINUTE,invalid='[{"interval_minutes":"2"}]',valid='[{"interval_minutes":2}]';
  historyCheck(f,{slot:start,revision:2,trace:invalid});historyCheck(f,{slot:start+2*MINUTE,revision:2,trace:valid});
  const intervals=f.sqlite.prepare(`SELECT ${historicalIntervalSql('c')} AS interval_ms FROM checks c ORDER BY ts`).all();
  assert.deepEqual(intervals.map(row=>row.interval_ms),[null,2*MINUTE]);assert.doesNotMatch(await feed(f),/<item>/);
  historyCheck(f,{slot:start+4*MINUTE,revision:2,trace:valid});
  assert.ok((await feed(f)).includes(`kuma-lite:incident:1:${start+2*MINUTE+1000}:ongoing`));
 }finally{f.close();}
});

test('current-state freshness grace is separate from a missing due history cell and revision cutover',()=>{
 const monitor={interval_minutes:2,config_revision:2},latest={ts:SLOT+1000,scheduled_slot:SLOT,config_revision:2};
 assert.equal(monitorFreshness(monitor,latest,SLOT+2*MINUTE),'fresh');
 assert.equal(monitorFreshness(monitor,latest,SLOT+6*MINUTE-1),'fresh');
 assert.equal(monitorFreshness(monitor,latest,SLOT+6*MINUTE),'stale');
 assert.equal(monitorFreshness({...monitor,config_revision:3},latest,SLOT+2*MINUTE),'missing');
});

test('late old-revision result cannot commit after interval cutover',async()=>{
 const f=sqliteEnv();try{
  const lease=await execution.claimMonitorSlot(f.env,1,SLOT,1),old={...f.monitor};assert.ok(lease);
  const transition=deriveTransition(old,result('down'),null,SLOT+1000,SLOT,false);
  f.sqlite.exec('UPDATE monitors SET interval_minutes=2,db_latency_threshold_ms=1500,config_revision=2 WHERE id=1');
  assert.equal(await execution.commitMonitorResult(f.env,old,lease,result('down'),null,transition,SLOT+1000,false),false);
  assert.equal(f.sqlite.prepare('SELECT count(*) AS n FROM checks').get().n,0);
  assert.equal(f.sqlite.prepare('SELECT count(*) AS n FROM notification_outbox').get().n,0);
  assert.equal(await execution.readMonitorState(f.env,1),null);
  await execution.releaseMonitorSlot(f.env,lease);
 }finally{f.close();}
});

test('a very old scheduled slot with a recent probe start is one late sample and no scheduled coverage',async t=>{
 const base=Date.UTC(2026,9,29,4,0),now=base+8*MINUTE+10000,actualTs=base+6*MINUTE+5000;
 t.mock.method(Date,'now',()=>now);
 const f=sqliteEnv();try{
  f.env.DB.withSession=()=>f.env.DB;f.sqlite.exec("UPDATE monitors SET interval_minutes=2,config_revision=2 WHERE id=1; INSERT INTO monitor_state(monitor_id,current_status) VALUES(1,'up')");
  f.sqlite.prepare(`INSERT INTO checks(monitor_id,status,status_code,latency_ms,ts,scheduled_slot,config_revision,monitor_role,probe_transport,in_maintenance,probe_trace_json)
   VALUES(1,'up',200,100,?,?,2,'availability','public_fetch',0,'[{"interval_minutes":2}]')`).run(actualTs,base-180*MINUTE);
  const html=await(await renderStatusPage(f.env,new URL('https://status.example.invalid/?scale=60m'))).text();
  const tag=slot=>html.match(new RegExp('<(?:a|span)\\b[^>]*data-from="'+slot+'"[^>]*>'))?.[0]??'';
  const actual=tag(base+6*MINUTE),following=tag(base+7*MINUTE);
  assert.match(actual,/data-provenance="observed_late"/);assert.match(actual,/data-observed-count="1"/);
  assert.match(actual,new RegExp('data-sample-ts="'+actualTs+'"'));
  assert.match(following,/data-state="none"/);assert.match(following,/data-observed-count="0"/);
  assert.equal((html.match(/data-provenance="observed_late"/g)??[]).length,1);
  assert.equal((html.match(/<(?:a|span)\b[^>]*data-provenance="held"/g)??[]).length,0);
  // A recent actual start cannot hide a three-hour-old scheduled observation.
  assert.ok(/監視情報が古いか、まだ取得されていません/.test(html),'A late start with a stale scheduled slot must leave current readiness unknown');
  assert.equal(f.sqlite.prepare('SELECT count(*) AS n FROM checks').get().n,1);
 }finally{f.close();}
});
