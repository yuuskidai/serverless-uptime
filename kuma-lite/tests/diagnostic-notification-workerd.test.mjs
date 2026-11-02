import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { result } from './helpers.mjs';

const require=createRequire(import.meta.url);
const wranglerRequire=createRequire(require.resolve('wrangler/package.json'));
const {Miniflare,convertV4MiniflareOptions}=wranglerRequire('miniflare');
const {buildSync}=wranglerRequire('esbuild');
const bundle=buildSync({stdin:{contents:`
 import {claimMonitorSlot,readMonitorState,commitMonitorResult,releaseMonitorSlot} from './src/monitor-execution.ts';
 import {deriveTransition} from './src/state-transition.ts';
 export default {async fetch(request,env){
   const input=await request.json();
   const monitor=await env.DB.prepare('SELECT * FROM monitors WHERE id=?').bind(input.id).first();
   const lease=await claimMonitorSlot(env,input.id,input.slot,monitor.config_revision);
   if(!lease)return Response.json({claimed:false});
   try{
     const previous=await readMonitorState(env,input.id);
     const transition=deriveTransition(monitor,input.result,previous,Date.now(),input.slot,false);
     return Response.json({committed:await commitMonitorResult(env,monitor,lease,input.result,previous,transition,Date.now(),false)});
   }catch{return Response.json({commit_failed:true});}
   finally{await releaseMonitorSlot(env,lease);}
 }};`,resolveDir:fileURLToPath(new URL('../',import.meta.url)),sourcefile:'local-diagnostic-policy-fixture.js'},bundle:true,format:'esm',platform:'browser',write:false}).outputFiles[0].text;

test('real workerd bounds diagnostic notification history and atomically deduplicates concurrent sixth probes',async t=>{
  const mf=new Miniflare(convertV4MiniflareOptions({workers:['left','right'].map(name=>({name,script:bundle,modules:true,compatibilityDate:'2025-01-01',d1Databases:{DB:'synthetic-diagnostic-policy'}}))}));
  t.after(()=>mf.dispose());
  const db=await mf.getD1Database('DB','left');
  const schema=readFileSync(new URL('../schema.sql',import.meta.url),'utf8');
  await db.batch(schema.replace(/^\s*--.*$/gm,'').split(';').map(s=>s.trim()).filter(Boolean).map(s=>db.prepare(s)));
  const workers=await Promise.all(['left','right'].map(name=>mf.getWorker(name)));
  const step=120_000;const base=Math.floor(Date.now()/step)*step-3_600_000;
  async function seed(id){await db.prepare("INSERT INTO monitors(id,name,url,created_at,retry_threshold,interval_minutes,config_revision,monitor_role,probe_transport) VALUES(?,'Synthetic','https://example.invalid/healthz',0,2,2,5,'diagnostic','service_binding')").bind(id).run();}
  async function call(side,id,index,state='down'){
    const response=await workers[side].fetch('http://local-test.invalid/',{method:'POST',body:JSON.stringify({id,slot:base+index*step,result:result(state)})});return response.json();
  }
  const events=async id=>(await db.prepare('SELECT kind FROM notification_outbox WHERE monitor_id=? ORDER BY id').bind(id).all()).results.map(r=>r.kind);
  await t.test('mixed severities, concurrent consumers, and two-normal recovery',async()=>{
    await seed(1);
    for(let i=0;i<5;i++)assert.equal((await call(0,1,i,i%2?'degraded':'down')).committed,true);
    assert.deepEqual(await events(1),[]);
    const both=await Promise.all([call(0,1,5,'degraded'),call(1,1,5,'degraded')]);
    assert.equal(both.filter(r=>r.committed).length,1);assert.deepEqual(await events(1),['degraded']);
    await call(0,1,6,'up');assert.deepEqual(await events(1),['degraded']);
    await call(1,1,7,'up');await call(0,1,8,'up');
    assert.deepEqual(await events(1),['degraded','up']);
  });
  await t.test('missing slot does not become a successful or a sustained bad observation',async()=>{
    await seed(2);
    for(let i=0;i<5;i++)await call(0,2,i);
    await call(1,2,6);assert.deepEqual(await events(2),[]);
    assert.equal((await db.prepare('SELECT COUNT(*) n FROM checks WHERE monitor_id=2').first()).n,6);
  });
  await t.test('outbox rejection rolls back the sixth observation and keeps the prior five',async()=>{
    await seed(3);
    for(let i=0;i<5;i++)await call(0,3,i);
    await db.prepare("CREATE TRIGGER reject_diagnostic BEFORE INSERT ON notification_outbox WHEN NEW.monitor_id=3 BEGIN SELECT RAISE(ABORT,'synthetic failure'); END").run();
    assert.equal((await call(1,3,5)).commit_failed,true);
    assert.equal((await db.prepare('SELECT COUNT(*) n FROM checks WHERE monitor_id=3').first()).n,5);
    assert.deepEqual(await events(3),[]);
  });
});
