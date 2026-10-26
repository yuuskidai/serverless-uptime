import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
const require=createRequire(new URL('../../kuma-lite/package.json',import.meta.url));
const {buildSync}=createRequire(require.resolve('wrangler/package.json'))('esbuild');
const bundle=buildSync({stdin:{contents:`export {appEvent,boundedJSON} from './src/validation.ts';export {pollWaf} from './src/analytics.ts';`,resolveDir:fileURLToPath(new URL('../',import.meta.url)),sourcefile:'analytics-fixture.js'},bundle:true,format:'esm',platform:'browser',write:false}).outputFiles[0].text;
const {appEvent,boundedJSON,pollWaf}=await import('data:text/javascript;base64,'+Buffer.from(bundle).toString('base64'));
const valid=groups=>({data:{viewer:{zones:[{firewallEventsAdaptiveGroups:groups}]}}});
const group={count:2,dimensions:{action:'block',clientRequestHTTPHost:'core-os.opus-system.jp'}};

test('event allowlist rejects extra fields, unsafe hashes and stale/future input',()=>{
 const now=Date.now(),event={version:1,eventId:crypto.randomUUID(),occurredAt:now,kind:'auth_failure',actorHash:'b'.repeat(64)};
 assert.deepEqual(appEvent(event,now),event);
 for(const patch of [{kind:'arbitrary'},{password:'secret'},{actorHash:'RAW@example.test'},{occurredAt:now-300001},{occurredAt:now+30001},{requestId:'unsafe'}])assert.equal(appEvent({...event,...patch},now),null);
 assert.equal(appEvent({...event,kind:'security_policy_weakened'},now).kind,'security_policy_weakened');
});

test('bounded body rejects oversize and absolute deadline after a paused read',async()=>{
 await assert.rejects(boundedJSON(new Response('{}'.repeat(40000)),65536,100));
 const body=new ReadableStream({pull(controller){const until=performance.now()+25;while(performance.now()<until){}controller.enqueue(new TextEncoder().encode('{}'));controller.close();}});
 await assert.rejects(boundedJSON(new Response(body),65536,5),/timeout/);
});

test('WAF API response validation fails closed for permission, malformed and truncated data',async t=>{
 const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;});
 const env={CF_ANALYTICS_TOKEN:'synthetic-local-token'},start=Date.now()-120000,end=Date.now()-60000;
 for(const payload of [{errors:[{message:'permission denied'}]}, {...valid([]),errors:'malformed'}, {data:{viewer:{zones:[]}}},valid(Array.from({length:100},()=>group)),valid([{...group,count:-1}]),valid([{...group,dimensions:{...group.dimensions,clientRequestHTTPHost:'attacker.invalid'}}])]){
  globalThis.fetch=async()=>Response.json(payload);await assert.rejects(pollWaf(env,start,end));
 }
 globalThis.fetch=async request=>{assert.equal(request,'https://api.cloudflare.com/client/v4/graphql');return Response.json(valid([group]));};
 assert.deepEqual(await pollWaf(env,start,end),[{action:'block',host:'core-os.opus-system.jp',count:2}]);
 globalThis.fetch=async()=>Response.json(valid([{...group,dimensions:{...group.dimensions,action:'skip'}}]));assert.deepEqual(await pollWaf(env,start,end),[]);
});
