import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
const require=createRequire(new URL('../../kuma-lite/package.json',import.meta.url));
const {buildSync}=createRequire(require.resolve('wrangler/package.json'))('esbuild');
const bundle=buildSync({stdin:{contents:`export {appEvent,boundedJSON} from './src/validation.ts';export {pollWaf,analyticsDiagnostic} from './src/analytics.ts';`,resolveDir:fileURLToPath(new URL('../',import.meta.url)),sourcefile:'analytics-fixture.js'},bundle:true,format:'esm',platform:'browser',write:false}).outputFiles[0].text;
const {appEvent,boundedJSON,pollWaf,analyticsDiagnostic}=await import('data:text/javascript;base64,'+Buffer.from(bundle).toString('base64'));
const valid=events=>({data:{viewer:{zones:[{firewallEventsAdaptive:events}]}}});
const sample=(at,extra={})=>({action:'block',clientRequestHTTPHost:'core-os.opus-system.jp',datetime:new Date(at).toISOString(),...extra});
const unknownRules=(count,limited=false)=>({rules:[],otherCount:0,unknownCount:count,limited});

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

test('Free sampled WAF records preserve bounded observations and reject invalid times, hosts and unexpected identity fields',async t=>{
 const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;});
 const env={CF_ANALYTICS_TOKEN:'synthetic-local-token'},start=Date.now()-120000,end=Date.now()-60000;
 for(const payload of [{errors:[{message:'permission denied'}]}, {...valid([]),errors:'malformed'}, {data:{viewer:{zones:[]}}},valid(Array.from({length:1001},()=>sample(start))),valid([sample(start-1)]),valid([sample(end)]),valid([sample(start,{datetime:'not-a-date'})]),valid([sample(start,{clientRequestHTTPHost:'attacker.invalid'})]),valid([sample(start,{clientIP:'192.0.2.1'})])]){
  globalThis.fetch=async()=>Response.json(payload);await assert.rejects(pollWaf(env,start,end));
 }
 globalThis.fetch=async(request,options)=>{
  assert.equal(request,'https://api.cloudflare.com/client/v4/graphql');
  const payload=JSON.parse(options.body);
  // Cloudflare's documented API uses the custom lowercase string scalar and a typed filter.
  // Simulate its variable boundary instead of accepting any client JSON as the old fixture did.
  if(!/\$zone\s*:\s*string\b/.test(payload.query)||!/\$filter\s*:\s*FirewallEventsAdaptiveFilter_InputObject\b/.test(payload.query))return Response.json({errors:[{message:'unknown type "String"'}]});
  assert.deepEqual(payload.variables,{zone:'6a83ef6dd7723ac97485c613c9a5ca34',filter:{datetime_geq:new Date(start).toISOString(),datetime_lt:new Date(end).toISOString(),clientRequestHTTPHost_in:['core-os.opus-system.jp','partner-portal.opus-system.jp']}});
  assert.equal(options.redirect,'manual');assert.equal(options.method,'POST');assert.doesNotMatch(payload.query,/clientIP|clientRequestPath|clientRequestQuery|userAgent|firewallEventsAdaptiveGroups/);
  for(const field of ['source','ruleId','description'])assert.match(payload.query,new RegExp(`\\b${field}\\b`));
  return Response.json(valid([sample(start),sample(start+1)]));
 };
 assert.deepEqual(await pollWaf(env,start,end),{groups:[{action:'block',host:'core-os.opus-system.jp',count:2,ruleCounts:unknownRules(2)}],complete:true});
 globalThis.fetch=async()=>Response.json(valid([sample(start,{action:'skip'})]));assert.deepEqual(await pollWaf(env,start,end),{groups:[],complete:true});
 globalThis.fetch=async()=>Response.json(valid(Array.from({length:1000},(_,i)=>sample(start+i))));assert.deepEqual(await pollWaf(env,start,end),{groups:[{action:'block',host:'core-os.opus-system.jp',count:1000,ruleCounts:unknownRules(1000,true)}],complete:false});
});

test('rule metadata counts remain per host/action and rule ID while missing labels remain usable',async t=>{
 const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;});
 const env={CF_ANALYTICS_TOKEN:'synthetic-local-token'},start=Date.now()-120000,end=Date.now()-60000;
 const rows=[
  sample(start,{source:'firewallManaged',ruleId:'rule-a',description:'React RCE'}),
  sample(start+1,{source:'firewallManaged',ruleId:'rule-a',description:'A later label'}),
  sample(start+2,{ruleId:'rule-b',description:null}),
  sample(start+3,{ruleId:'rule-b',description:'Second rule'}),
  sample(start+4,{ruleId:'rule-a',description:'Different action',action:'log'}),
  sample(start+5,{ruleId:'rule-a',description:'Different host',clientRequestHTTPHost:'partner-portal.opus-system.jp'}),
 ];
 globalThis.fetch=async()=>Response.json(valid(rows));
 const read=await pollWaf(env,start,end);
 assert.equal(read.groups.length,3);
 assert.deepEqual(read.groups[0],{action:'block',host:'core-os.opus-system.jp',count:4,ruleCounts:{rules:[
  {ruleId:'rule-a',count:2,description:'React RCE'},{ruleId:'rule-b',count:2,description:'Second rule'},
 ],otherCount:0,unknownCount:0,limited:false}});
 assert.equal(read.groups[1].count,1);assert.equal(read.groups[2].count,1);
 for(const group of read.groups)assert.equal(group.ruleCounts.rules.reduce((n,r)=>n+r.count,0)+group.ruleCounts.otherCount+group.ruleCounts.unknownCount,group.count);
});

test('unknown rule IDs preserve event counts and descriptions are bounded without splitting emoji',async t=>{
 const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;});
 const env={CF_ANALYTICS_TOKEN:'synthetic-local-token'},start=Date.now()-120000,end=Date.now()-60000;
 const invalid=[undefined,null,'','<!here>','x'.repeat(65),{},123];
 const rows=invalid.map((ruleId,i)=>sample(start+i,{ruleId,description:'ignored'}));
 rows.push(sample(start+10,{ruleId:'valid-rule',description:'\u0000  Rule\n\t\u0085\u061c\u200e\u200f\u202e '+ '🔥'.repeat(100)}));
 rows.push(sample(start+11,{ruleId:'label-missing',description:{private:'not retained'}}));
 globalThis.fetch=async()=>Response.json(valid(rows));
 const group=(await pollWaf(env,start,end)).groups[0];
 assert.equal(group.count,9);assert.equal(group.ruleCounts.unknownCount,7);
 const description=group.ruleCounts.rules[0].description;
 assert.ok(description.length<=160);assert.match(description,/^Rule 🔥/);assert.ok(description.endsWith('🔥'));
 assert.doesNotMatch(description,/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/);
 assert.deepEqual(group.ruleCounts.rules[1],{ruleId:'label-missing',count:1});
 assert.doesNotMatch(JSON.stringify(group),/not retained|ignored|<!here>/);
 globalThis.fetch=async()=>Response.json(valid([sample(start,{ruleId:'invalid-unicode',description:'\ud800'}),sample(start+1,{ruleId:'partly-valid',description:'\udc00Valid'})]));
 const unicode=(await pollWaf(env,start,end)).groups[0].ruleCounts.rules;
 assert.deepEqual(unicode,[{ruleId:'invalid-unicode',count:1},{ruleId:'partly-valid',count:1,description:'Valid'}]);
});

test('the per-poll rule cap retains exact known and other counts without dropping observations',async t=>{
 const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;});
 const env={CF_ANALYTICS_TOKEN:'synthetic-local-token'},start=Date.now()-120000,end=Date.now()-60000;
 const rows=Array.from({length:35},(_,i)=>sample(start+i,{ruleId:`rule-${i}`,description:`Rule ${i}`}));
 rows.push(sample(start+40,{ruleId:'rule-34'}),sample(start+41,{ruleId:'rule-0'}),sample(start+42,{ruleId:null}));
 globalThis.fetch=async()=>Response.json(valid(rows));
 const group=(await pollWaf(env,start,end)).groups[0];
 assert.equal(group.count,38);assert.equal(group.ruleCounts.rules.length,32);
 assert.equal(group.ruleCounts.rules[0].count,2);assert.equal(group.ruleCounts.otherCount,4);
 assert.equal(group.ruleCounts.unknownCount,1);assert.equal(group.ruleCounts.limited,true);
 assert.equal(group.ruleCounts.rules.reduce((n,r)=>n+r.count,0)+group.ruleCounts.otherCount+group.ruleCounts.unknownCount,38);
});

test('a full enriched sample fits the finite larger body cap and oversized responses still fail safely',async t=>{
 const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;});
 const env={CF_ANALYTICS_TOKEN:'synthetic-local-token'},start=Date.now()-120000,end=Date.now()-60000;
 const body=JSON.stringify(valid(Array.from({length:1000},(_,i)=>sample(start+i,{source:'firewallManaged',ruleId:'a'.repeat(64),description:'あ'.repeat(160)}))));
 assert.ok(new TextEncoder().encode(body).length>262144);assert.ok(new TextEncoder().encode(body).length<1048576);
 globalThis.fetch=async()=>new Response(body);
 const read=await pollWaf(env,start,end);assert.equal(read.complete,false);
 assert.equal(read.groups[0].count,1000);assert.equal(read.groups[0].ruleCounts.rules[0].count,1000);
 assert.equal(read.groups[0].ruleCounts.limited,true);
 globalThis.fetch=async()=>new Response('x'.repeat(1048577));
 await assert.rejects(pollWaf(env,start,end),error=>analyticsDiagnostic(error).code==='invalid_response');
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
 globalThis.fetch=async()=>Response.json(valid([sample(end)]));assert.deepEqual((await failure()).diagnostic,{code:'row_invalid',httpStatus:200});
 assert.deepEqual(analyticsDiagnostic(new Error('synthetic-secret-token')),{code:'unexpected_error',httpStatus:null});
});
