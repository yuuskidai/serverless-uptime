import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
const require=createRequire(new URL('../../kuma-lite/package.json',import.meta.url));
const {buildSync}=createRequire(require.resolve('wrangler/package.json'))('esbuild');
const bundle=buildSync({stdin:{contents:`export {appEvent,boundedJSON} from './src/validation.ts';export {pollWaf,analyticsDiagnostic} from './src/analytics.ts';`,resolveDir:fileURLToPath(new URL('../',import.meta.url)),sourcefile:'analytics-fixture.js'},bundle:true,format:'esm',platform:'browser',write:false}).outputFiles[0].text;
const {appEvent,boundedJSON,pollWaf,analyticsDiagnostic}=await import('data:text/javascript;base64,'+Buffer.from(bundle).toString('base64'));
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
 globalThis.fetch=async(request,options)=>{
  assert.equal(request,'https://api.cloudflare.com/client/v4/graphql');
  const payload=JSON.parse(options.body);
  // Cloudflare's documented API uses the custom lowercase string scalar and a typed filter.
  // Simulate its variable boundary instead of accepting any client JSON as the old fixture did.
  if(!/\$zone\s*:\s*string\b/.test(payload.query)||!/\$filter\s*:\s*FirewallEventsAdaptiveGroupsFilter_InputObject\b/.test(payload.query))return Response.json({errors:[{message:'unknown type "String"'}]});
  assert.deepEqual(payload.variables,{zone:'6a83ef6dd7723ac97485c613c9a5ca34',filter:{datetime_geq:new Date(start).toISOString(),datetime_lt:new Date(end).toISOString(),clientRequestHTTPHost_in:['core-os.opus-system.jp','partner-portal.opus-system.jp']}});
  assert.equal(options.redirect,'manual');assert.equal(options.method,'POST');return Response.json(valid([group]));
 };
 assert.deepEqual(await pollWaf(env,start,end),[{action:'block',host:'core-os.opus-system.jp',count:2}]);
 globalThis.fetch=async()=>Response.json(valid([{...group,dimensions:{...group.dimensions,action:'skip'}}]));assert.deepEqual(await pollWaf(env,start,end),[]);
});


test('private WAF diagnostics distinguish missing credentials, HTTP status and finite GraphQL failures without copying server data',async t=>{
 const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;});
 const env={CF_ANALYTICS_TOKEN:'synthetic-not-a-real-token'},start=Date.now()-120000,end=Date.now()-60000;
 const failure=async(config=env)=>{try{await pollWaf(config,start,end);assert.fail('expected failure');}catch(error){return {diagnostic:analyticsDiagnostic(error),message:error.message};}};
 let calls=0;globalThis.fetch=async()=>{calls++;throw new Error('synthetic-secret-token actor-private-id');};
 assert.deepEqual((await failure({})).diagnostic,{code:'credential_missing',httpStatus:null});assert.equal(calls,0);
 assert.deepEqual((await failure()).diagnostic,{code:'network_error',httpStatus:null});
 for(const [status,code]of [[401,'http_unauthorized'],[403,'http_forbidden'],[429,'http_rate_limited'],[503,'http_server_error'],[302,'http_unexpected_status']]){
  globalThis.fetch=async()=>new Response('synthetic-secret-token actor-private-id',{status});
  const result=await failure();assert.deepEqual(result.diagnostic,{code,httpStatus:status});assert.equal(result.message,'analytics_unavailable');assert.doesNotMatch(JSON.stringify(result),/synthetic-secret|actor-private/);
 }
 const cases=[
  ['unknown type "Time"','graphql_unknown_type'],
  ['Cannot query field "firewallEventsAdaptiveGroups" on type "zone".','graphql_unknown_field'],
  ['Variable "$start" got invalid value','graphql_invalid_variable'],
  ['Syntax Error: Expected Name','graphql_query_invalid'],
  ['not authorized to access zone: missing permission com.cloudflare.api.account.zone.analytics.read','graphql_unauthorized'],
  ['zone actor-private-id does not have access to field firewallEventsAdaptiveGroups','graphql_dataset_forbidden'],
  ['Authentication error: invalid token synthetic-secret-token','graphql_unauthorized'],
  ['forbidden','graphql_forbidden'],
  ['too many requests','graphql_rate_limited'],
  ['opaque server failure synthetic-secret-token actor-private-id','graphql_error'],
 ];
 for(const [message,code]of cases){
  globalThis.fetch=async()=>Response.json({errors:[{message,extensions:{ray_id:'private-ray-id',secret:'synthetic-secret-token'},path:['private-path']}]});
  const result=await failure();assert.deepEqual(result.diagnostic,{code,httpStatus:200});assert.equal(result.message,'analytics_unavailable');assert.doesNotMatch(JSON.stringify(result),/synthetic-secret|actor-private|private-ray|private-path|extensions/);
 }
 globalThis.fetch=async()=>Response.json({errors:'synthetic-secret-token'});assert.deepEqual((await failure()).diagnostic,{code:'invalid_response',httpStatus:200});
 globalThis.fetch=async()=>Response.json({data:{viewer:{zones:[]}}});assert.deepEqual((await failure()).diagnostic,{code:'zone_missing',httpStatus:200});
 globalThis.fetch=async()=>Response.json(valid(Array.from({length:100},()=>group)));const truncated=await failure();assert.deepEqual(truncated.diagnostic,{code:'result_truncated',httpStatus:200});assert.equal(truncated.message,'analytics_gap');
 assert.deepEqual(analyticsDiagnostic(new Error('synthetic-secret-token')),{code:'unexpected_error',httpStatus:null});
});
