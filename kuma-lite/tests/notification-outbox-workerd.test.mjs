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
    const lease=await claimMonitorSlot(env,input.id,input.slot,1);
    if(!lease)return Response.json({claimed:false});
    try {
      const previous=await readMonitorState(env,input.id);
      const transition=deriveTransition(monitor,input.result,previous,Date.now(),input.slot,false);
      return Response.json({claimed:true,committed:await commitMonitorResult(env,monitor,lease,input.result,previous,transition,Date.now(),false)});
    } catch {return Response.json({claimed:true,commit_failed:true});}
    finally {await releaseMonitorSlot(env,lease);}
  }};`,resolveDir:fileURLToPath(new URL('../',import.meta.url)),sourcefile:'local-outbox-fixture.js'},bundle:true,format:'esm',platform:'browser',write:false}).outputFiles[0].text;

test('real workerd persists outbox only with an atomic accepted observation',async t=>{
  const mf=new Miniflare(convertV4MiniflareOptions({workers:['left','right'].map(name=>({name,script:bundle,modules:true,compatibilityDate:'2025-01-01',d1Databases:{DB:'synthetic-outbox'}}))}));
  t.after(()=>mf.dispose());
  const db=await mf.getD1Database('DB','left');
  const schema=readFileSync(new URL('../schema.sql',import.meta.url),'utf8');
  await db.batch(schema.replace(/^\s*--.*$/gm,'').split(';').map(s=>s.trim()).filter(Boolean).map(s=>db.prepare(s)));
  const workers=await Promise.all(['left','right'].map(name=>mf.getWorker(name)));
  const slot=Math.floor(Date.now()/60000)*60000;
  async function seed(id){await db.prepare("INSERT INTO monitors(id,name,url,created_at,retry_threshold) VALUES(?,'Synthetic','https://example.invalid/healthz',0,1)").bind(id).run();}
  async function call(side,id){const response=await workers[side].fetch('http://local-test.invalid/',{method:'POST',body:JSON.stringify({id,slot,result:result('down')})});return response.json();}
  await t.test('independent isolates cannot queue duplicate incident events',async()=>{
    await seed(1);
    const calls=await Promise.all([call(0,1),call(1,1)]);
    assert.equal(calls.filter(c=>c.committed).length,1);
    assert.equal((await db.prepare('SELECT COUNT(*) n FROM checks WHERE monitor_id=1').first()).n,1);
    assert.equal((await db.prepare('SELECT COUNT(*) n FROM notification_outbox WHERE monitor_id=1').first()).n,1);
  });
  await t.test('an outbox write failure rolls back the accepted check and state together',async()=>{
    await seed(2);
    await db.prepare("CREATE TRIGGER fail_notification BEFORE INSERT ON notification_outbox WHEN NEW.monitor_id=2 BEGIN SELECT RAISE(ABORT,'synthetic failure'); END").run();
    assert.equal((await call(0,2)).commit_failed,true);
    assert.equal((await db.prepare('SELECT COUNT(*) n FROM checks WHERE monitor_id=2').first()).n,0);
    assert.equal((await db.prepare('SELECT COUNT(*) n FROM monitor_state WHERE monitor_id=2').first()).n,0);
    assert.equal((await db.prepare('SELECT COUNT(*) n FROM notification_outbox WHERE monitor_id=2').first()).n,0);
  });

});
