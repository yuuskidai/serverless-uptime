import test, { afterEach, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { loadTs } from './helpers.mjs';

const base={id:1,name:'Synthetic',url:'https://synthetic.invalid/healthz?private=not-logged',description:null,fallback_url:null,service_binding:null,method:'GET',expected_status:200,keyword:null,timeout_ms:1000,interval_minutes:1,enabled:1,retry_threshold:2,latency_threshold_ms:1000,db_latency_threshold_ms:1000,http_latency_threshold_ms:null,created_at:0};
let events;
// Load after each test installs its clock/timer mocks, as the former native import did.
const performCheck = (...args) => loadTs('monitor', { console: { error() {}, warn() {}, log() {}, info(event) { events.push(event); } } }).performCheck(...args);
beforeEach(()=>{events=[];});
afterEach(()=>mock.restoreAll());
const payload=(status='degraded',extra={})=>({status,reason:status==='degraded'?'応答が 800ms を超過 (900ms)':null,components:[{name:'Database',status,latency_ms:900,...(status==='degraded'?{reason:'応答が 800ms を超過 (900ms)'}:{})}],...extra});
function reply(value,{rtt=0,echo=true}={}){
  let clock=0;mock.method(performance,'now',()=>clock);
  mock.method(globalThis,'fetch',async(_url,init)=>{clock+=rtt;return Response.json(value,{headers:echo?{'X-Monitor-Request-ID':init.headers['X-Monitor-Request-ID']}:{}});});
}

test('HTTP RTT never substitutes for database latency and the deprecated field never enables HTTP alarms',async()=>{
  reply(payload(),{rtt:2051});
  const result=await performCheck({}, {...base,timeout_ms:3000});
  assert.equal(result.healthz_status,'ok');
  assert.equal(result.latency_ms,2051);
  assert.equal(JSON.parse(result.healthz_components)[0].latency_ms,900);
  const [trace]=JSON.parse(result.probe_trace_json);
  assert.equal(trace.headers_ms,2051);assert.equal(trace.body_ms,0);assert.equal(trace.total_ms,2051);
  assert.equal(trace.request_id_matched,true);assert.match(trace.request_id,/^[a-f0-9-]{36}$/);
  assert.equal(trace.transport,'public_fetch');
  assert.equal(JSON.stringify(events).includes('private=not-logged'),false);
});
test('stored probe trace snapshots its bounded interval before an in-flight settings object changes',async()=>{
  const monitor={...base,interval_minutes:2};
  mock.method(globalThis,'fetch',async()=>{monitor.interval_minutes=5;return Response.json(payload('ok'));});
  const result=await performCheck({},monitor);
  assert.equal(JSON.parse(result.probe_trace_json)[0].interval_minutes,2);
  assert.equal(result.status,'up');
});
test('invalid interval configuration is recorded as unknown without changing probe health',async()=>{
  reply(payload('ok'));
  const result=await performCheck({}, {...base,interval_minutes:61});
  assert.equal(JSON.parse(result.probe_trace_json)[0].interval_minutes,null);
  assert.equal(result.status,'up');
});
test('explicit DB null disables the migrated override even while old latency field is populated',async()=>{
  reply(payload());const result=await performCheck({}, {...base,db_latency_threshold_ms:null});
  assert.equal(result.healthz_status,'degraded');
});
test('HTTP ceiling is an independent opt-in and preserves the DB observation',async()=>{
  reply(payload(),{rtt:2051});const result=await performCheck({}, {...base,timeout_ms:3000,http_latency_threshold_ms:2000});
  assert.equal(result.healthz_status,'degraded');
  assert.match(result.healthz_reason,/HTTP/);
  const components=JSON.parse(result.healthz_components);
  assert.equal(components[0].status,'ok');assert.equal(components.at(-1).name,'HTTP response');
});
test('a fast overall response cannot hide a non-latency DB failure or mixed failure reason',async()=>{
  const reason='Database latency high; replication failed';reply(payload('degraded',{reason,components:[{name:'Database',status:'degraded',latency_ms:100,reason}]}));
  const result=await performCheck({},base);assert.equal(result.healthz_status,'degraded');assert.equal(result.healthz_reason,reason);
});
for(const status of ['down','degraded'])test(`top-level ok never hides a ${status} component`,async()=>{
  reply(payload('ok',{components:[{name:'Payments',status,reason:'payment provider unavailable',latency_ms:5}]}));
  const result=await performCheck({},base);assert.equal(result.healthz_status,status);assert.equal(result.status,status==='down'?'down':'up');
});
test('DB down remains down under any latency override',async()=>{
  reply(payload('degraded',{components:[{name:'Database',status:'down',latency_ms:2,reason:'Database unavailable'}]}));
  const result=await performCheck({},base);assert.equal(result.status,'down');assert.equal(result.healthz_status,'down');
});
test('tightening DB threshold can detect slow DB even if target reports ok',async()=>{
  reply(payload('ok'));const result=await performCheck({}, {...base,db_latency_threshold_ms:800});
  assert.equal(result.healthz_status,'degraded');assert.match(result.healthz_reason,/Database/);
});
test('non-DB degradation and unknown overall degradation remain degraded',async()=>{
  reply(payload('degraded',{reason:'Search index unavailable',components:[{name:'Search',status:'degraded',latency_ms:1,reason:'Search index unavailable'}]}));
  assert.equal((await performCheck({},base)).healthz_status,'degraded');
});
test('fallback uses a distinct attempt ID and remains degraded, with honest binding transport',async()=>{
  const ids=[];let calls=0;
  const binding={fetch:async(_url,init)=>{ids.push(init.headers['X-Monitor-Request-ID']);if(++calls===1)throw Error('synthetic outage');return new Response('Site alive',{headers:{'X-Monitor-Request-ID':ids.at(-1)}});}};
  const result=await performCheck({CORE_OS:binding},{...base,interval_minutes:2,service_binding:'CORE_OS',fallback_url:'https://synthetic.invalid/'});
  assert.equal(result.status,'up');assert.equal(result.healthz_status,'degraded');assert.equal(result.used_fallback,true);
  const traces=JSON.parse(result.probe_trace_json);assert.equal(traces.length,2);assert.notEqual(ids[0],ids[1]);
  assert.equal(traces[0].failure_phase,'headers');assert.equal(traces[1].request_id_matched,true);
  assert.equal(traces.every(x=>x.transport==='service_binding'),true);
  assert.equal(traces.every(x=>x.interval_minutes===2),true);
});
test('invalid or mismatched echoed IDs are diagnostic only and never change health',async()=>{
  mock.method(globalThis,'fetch',async()=>Response.json(payload('ok'),{headers:{'X-Monitor-Request-ID':'bad header with spaces'}}));
  const result=await performCheck({},base);const [trace]=JSON.parse(result.probe_trace_json);
  assert.equal(result.status,'up');assert.equal(trace.response_request_id,null);assert.equal(trace.request_id_matched,false);
});
test('deadline covers an unfinished body and cancellation does not wait for upstream acknowledgment',async()=>{
  let cancelled=0;let response;
  mock.method(globalThis,'fetch',async()=>{response=new Response(new ReadableStream({cancel(){cancelled++;return new Promise(()=>{});}}));return response;});
  const result=await performCheck({}, {...base,timeout_ms:15});await Promise.resolve();
  const [trace]=JSON.parse(result.probe_trace_json);assert.equal(result.status,'down');assert.match(result.error,/Timeout after 15ms/);
  assert.equal(trace.failure_phase,'body');assert.equal(trace.status_code,200);assert.notEqual(trace.headers_ms,null);
  assert.equal(cancelled,1);assert.equal(response.body.locked,false);
});
test('headers that never arrive are bounded and phase is recorded',async()=>{
  mock.method(globalThis,'fetch',()=>new Promise(()=>{}));
  const result=await performCheck({}, {...base,timeout_ms:15});const [trace]=JSON.parse(result.probe_trace_json);
  assert.equal(result.status,'down');assert.equal(trace.failure_phase,'headers');assert.equal(trace.headers_ms,null);
});
test('a fetch that settles after the timeout result cancels its late body without waiting for acknowledgment',async()=>{
  let resolveFetch,cancelled=0;
  mock.method(globalThis,'fetch',()=>new Promise(resolve=>{resolveFetch=resolve;}));
  const result=await performCheck({}, {...base,timeout_ms:15});
  assert.equal(result.status,'down');assert.match(result.error,/Timeout after 15ms/);
  assert.equal(cancelled,0);
  const response=new Response(new ReadableStream({cancel(){cancelled++;return new Promise(()=>{});}}));
  resolveFetch(response);
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(cancelled,1);assert.equal(response.body.locked,false);
});
for(const transport of ['public_fetch','service_binding'])test(`late ${transport} headers cannot beat an overdue timer to establish readiness`,async()=>{
  let clock=0,requestSignal;
  mock.method(performance,'now',()=>clock);
  const fetcher=async(_url,init)=>{
    requestSignal=init.signal;clock=1001;
    return Response.json(payload('ok'),{headers:{'Cache-Control':'no-store'}});
  };
  mock.method(globalThis,'fetch',fetcher);
  const result=await performCheck({CORE_OS:{fetch:fetcher}}, {...base,probe_transport:transport,
    service_binding:'CORE_OS',response_mode:'strict_healthz'});
  const [trace]=JSON.parse(result.probe_trace_json);
  assert.equal(result.status,'down');assert.match(result.error,/Timeout after 1000ms/);
  assert.equal(requestSignal.aborted,true);assert.equal(trace.failure_phase,'headers');
  assert.equal(trace.timeout_ms,1000);assert.equal(trace.total_ms,1001);
  assert.equal(trace.timeout_callback_elapsed_ms,null);assert.equal(trace.deadline_overrun_ms,1);
});
for(const completion of ['chunk','eof'])test(`late body ${completion} cannot establish readiness before an overdue timer runs`,async()=>{
  let clock=0,reads=0;
  mock.method(performance,'now',()=>clock);
  const bytes=new TextEncoder().encode(JSON.stringify(payload('ok')));
  mock.method(globalThis,'fetch',async()=>{
    clock=1;
    return new Response(new ReadableStream({pull(controller){
      if(reads++===0){
        if(completion==='chunk')clock=1001;
        controller.enqueue(bytes);
      }else{clock=1001;controller.close();}
    }},{highWaterMark:0}),{headers:{'Content-Type':'application/json','Cache-Control':'no-store'}});
  });
  const result=await performCheck({}, {...base,response_mode:'strict_healthz'});
  const [trace]=JSON.parse(result.probe_trace_json);
  assert.equal(result.status,'down');assert.match(result.error,/Timeout after 1000ms/);
  assert.equal(trace.failure_phase,'body');assert.equal(trace.status_code,200);assert.equal(trace.headers_ms,1);
  assert.equal(trace.body_ms,1000);assert.equal(trace.timeout_callback_elapsed_ms,null);
  assert.equal(trace.total_ms,1001);assert.equal(trace.deadline_overrun_ms,1);
});
test('a delayed timeout callback records its actual elapsed time without hiding the overrun',async()=>{
  let clock=0,fireTimer,requestedDelay;
  mock.method(performance,'now',()=>clock);
  mock.method(globalThis,'setTimeout',(callback,delay)=>{fireTimer=callback;requestedDelay=delay;return 0;});
  mock.method(globalThis,'fetch',()=>new Promise(()=>{clock=21950;queueMicrotask(()=>fireTimer());}));
  const result=await performCheck({}, {...base,timeout_ms:10000,response_mode:'strict_healthz'});
  const [trace]=JSON.parse(result.probe_trace_json);
  assert.equal(requestedDelay,10000);assert.equal(result.status,'down');assert.match(result.error,/Timeout after 10000ms/);
  assert.equal(trace.failure_phase,'headers');assert.equal(trace.timeout_ms,10000);
  assert.equal(trace.total_ms,21950);assert.equal(trace.timeout_callback_elapsed_ms,21950);
  assert.equal(trace.deadline_overrun_ms,11950);
});
test('body byte cap cancels huge legacy pages before buffering them fully',async()=>{
  let cancelled=0;mock.method(globalThis,'fetch',async()=>new Response(new ReadableStream({start(c){c.enqueue(new Uint8Array(1_000_000).fill(65));},cancel(){cancelled++;return new Promise(()=>{});}})));
  const result=await performCheck({},base);assert.equal(result.status,'up');assert.equal(cancelled,1);
  assert.equal(JSON.parse(result.probe_trace_json)[0].body_truncated,true);assert.ok(result.probe_trace_json.length<2048);
});
for(const [label,body,contentType] of [
  ['parseable JSON prefix','{"status":"ok"}'+ ' '.repeat(8192)+'trailing-junk','text/plain'],
  ['declared JSON response','x'.repeat(9000),'application/json'],
])test(`truncated ${label} never establishes a healthy primary result`,async()=>{
  mock.method(globalThis,'fetch',async()=>new Response(body,{headers:{'Content-Type':contentType}}));
  const result=await performCheck({},base);
  assert.equal(result.status,'down');assert.equal(result.healthz_status,'down');
  assert.match(result.error,/Health response exceeds 8192 bytes/);
  assert.equal(JSON.parse(result.probe_trace_json)[0].body_truncated,true);
});
test('a live fallback after a truncated JSON prefix stays degraded rather than fully recovered',async()=>{
  let calls=0;mock.method(globalThis,'fetch',async()=>++calls===1
    ? new Response('{"status":"ok"}'+' '.repeat(8192)+'trailing-junk',{headers:{'Content-Type':'application/json'}})
    : new Response('Fallback alive'));
  const result=await performCheck({}, {...base,fallback_url:'https://synthetic.invalid/'});
  assert.equal(result.status,'up');assert.equal(result.healthz_status,'degraded');assert.equal(result.used_fallback,true);
  const traces=JSON.parse(result.probe_trace_json);assert.equal(traces.length,2);
  assert.equal(traces[0].body_truncated,true);assert.notEqual(traces[0].request_id,traces[1].request_id);
});
