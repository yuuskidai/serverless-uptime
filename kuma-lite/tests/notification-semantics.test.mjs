import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as urlDisplay from '../src/url-display.ts';
import * as monitorPolicy from '../src/monitor-policy.ts';

function load(file,dependencies,globals={}){
 const module={exports:{}};const source=readFileSync(new URL('../src/'+file+'.ts',import.meta.url),'utf8');
 const compiled=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
 runInNewContext(compiled,{module,exports:module.exports,AbortSignal,Date,URL,Response,setTimeout,clearTimeout,
  console:{error(){},warn(){},log(){}},require(id){if(Object.hasOwn(dependencies,id))return dependencies[id];throw Error('Unexpected module '+id);},...globals},{filename:file+'.ts'});
 return module.exports;
}
function fixture(options={}){
 const posts=[],reactions=[],discord=[],jobs=[];
 const bot={defaultChannelId:'synthetic-channel',slack:{async postBlocks(_channel,payload){posts.push(payload);if(options.post)return options.post(payload);return {ts:'synthetic-thread'};},async addReaction(...args){reactions.push(args);}}};
 const notifier=load('notifier',{'./slack-bot':{buildSlackBot:()=>bot},'./url-display':urlDisplay},{fetch:async(_url,init)=>{discord.push(JSON.parse(init.body));assert.equal(init.redirect,'manual');assert.ok(init.signal instanceof AbortSignal);return options.discordResponse?options.discordResponse():new Response(null,{status:204});}});
 const transition=load('state-notifications',{'./notifier':notifier,'./monitor-policy':monitorPolicy,'./rca':{async enqueueRca(_env,job){jobs.push(job);if(options.enqueue)return options.enqueue();}}},{setTimeout:(callback,ms)=>setTimeout(callback,options.shortDeadline&&ms===18000?5:ms)});
 return {notifier,transition,posts,reactions,discord,jobs,env:{DISCORD_WEBHOOK_URL:'https://synthetic.invalid/discord'},monitor:{id:1,name:'Synthetic',url:'https://synthetic.invalid/healthz'},detail:{reason:'応答遅延が継続',components:[],version:null}};
}
const text=f=>JSON.stringify({posts:f.posts,discord:f.discord});
test('DOWN to DEGRADED reports yellow response restoration and keeps the original thread open',async()=>{
 const f=fixture();await f.notifier.notifyPartialRecovery(f.env,f.monitor,f.detail,38000,'original-down-thread');
 assert.match(text(f),/RESPONSE RESTORED/);assert.match(text(f),/応答は復旧.*不調が継続/);
 assert.match(text(f),/監視上の停止期間/);assert.match(text(f),/38s/);assert.doesNotMatch(text(f),/RECOVERED|Down for/);
 assert.equal(f.discord[0].embeds[0].color,0xfbbf24);assert.equal(f.posts[0].threadTs,'original-down-thread');
 assert.equal(f.reactions.length,0);
});
test('stable DEGRADED to OK emits full recovery in that thread without a fictitious down duration',async()=>{
 const f=fixture();await f.notifier.notifyUp(f.env,f.monitor,0,'original-degraded-thread','degraded');
 assert.match(text(f),/RECOVERED/);assert.match(text(f),/連続した正常チェック/);
 assert.doesNotMatch(text(f),/停止期間|Down for|down for|less than a second/);
 assert.equal(f.discord[0].embeds[0].color,0x00cc66);assert.equal(f.posts[0].threadTs,'original-degraded-thread');
 assert.equal(f.reactions.length,1);assert.equal(f.reactions[0][2],'white_check_mark');
});
test('DOWN to OK labels only the observed monitor down duration',async()=>{
 const f=fixture();await f.notifier.notifyUp(f.env,f.monitor,38000,'down-thread');
 assert.match(text(f),/監視上の停止期間/);assert.doesNotMatch(text(f),/Down for|down for/);
});
test('the committed partial transition routes to partial recovery and does not enqueue RCA',async()=>{
 const f=fixture();const result={healthz_reason:'応答遅延が継続',error:null,healthz_components:null,healthz_version:null};
 await f.transition.notifyTransition(f.env,f.monitor,result,{kind:'partial',previousStatus:'down',nextStatus:'degraded',downDurationMs:38000,previousSlackAlertTs:'down-thread'},1000);
 assert.match(text(f),/RESPONSE RESTORED/);assert.doesNotMatch(text(f),/RECOVERED/);assert.equal(f.jobs.length,0);
 assert.equal(f.posts[0].threadTs,'down-thread');assert.equal(f.reactions.length,0);
});
test('partial then stable full recovery reuses the down thread and closes it only on full recovery',async()=>{
 const f=fixture();const result={healthz_reason:null,error:null,healthz_components:null,healthz_version:null};
 await f.transition.notifyTransition(f.env,f.monitor,result,{kind:'partial',previousStatus:'down',nextStatus:'degraded',downDurationMs:38000,previousSlackAlertTs:'original-down'},1000);
 await f.transition.notifyTransition(f.env,f.monitor,result,{kind:'up',previousStatus:'degraded',nextStatus:'up',downDurationMs:0,previousSlackAlertTs:'original-down'},2000);
 assert.equal(f.posts.length,2);assert.equal(f.posts.every(p=>p.threadTs==='original-down'),true);
 assert.equal(f.reactions.length,1);assert.doesNotMatch(JSON.stringify(f.posts[1]),/停止期間|Down for/);
});
test('an unresponsive provider cannot hold notification ownership or enqueue new RCA after the deadline',async()=>{
 let release;const f=fixture({shortDeadline:true,post:()=>new Promise(resolve=>{release=resolve;})});
 const result={healthz_reason:'synthetic failure',error:null,healthz_components:null,healthz_version:null};
 await assert.rejects(f.transition.notifyTransition(f.env,f.monitor,result,{kind:'down',previousStatus:'up',nextStatus:'down',downDurationMs:0,previousSlackAlertTs:null},1000),error=>error.code==='uncertain');
 release({ts:'late-thread'});await new Promise(resolve=>setTimeout(resolve,0));
 assert.equal(f.jobs.length,0);
});
test('Slack API requests use bounded native fetch deadlines and do not follow credential-bearing redirects',async()=>{
 const seen=[];class SyntheticError extends Error{}
 const {SlackClient}=load('chat-adapters/slack/client',{'./errors':{AdapterRateLimitError:SyntheticError,AuthenticationError:SyntheticError,NetworkError:SyntheticError,ValidationError:SyntheticError}});
 const client=new SlackClient({token:'synthetic-token',fetchImpl:async(_url,init)=>{seen.push(init);return Response.json({ok:true});}});
 await client.call('chat.postMessage',{channel:'synthetic-channel',text:'synthetic'});
 assert.equal(seen[0].redirect,'manual');assert.ok(seen[0].signal instanceof AbortSignal);
});

test('a successful Discord response releases its unused body without waiting for cancellation acknowledgment',{timeout:1000},async()=>{
 let cancelled=0;
 const f=fixture({discordResponse:()=>new Response(new ReadableStream({cancel(){cancelled++;return new Promise(()=>{});}}),{status:200})});
 const sent=await f.notifier.notifyDown(f.env,f.monitor,f.detail);
 assert.equal(sent.slackAlertTs,'synthetic-thread');assert.equal(cancelled,1);
});
for(const status of [429,500])test(`Slack HTTP ${status} releases its unused body and preserves the error without waiting for cancellation acknowledgment`,{timeout:1000},async()=>{
 let cancelled=0;
 class SyntheticError extends Error{}
 class RateLimitError extends Error{constructor(_adapter,retryAfter){super('ratelimited');this.retryAfter=retryAfter;}}
 class SlackNetworkError extends Error{constructor(_adapter,message){super(message);}}
 const {SlackClient}=load('chat-adapters/slack/client',{'./errors':{AdapterRateLimitError:RateLimitError,
  AuthenticationError:SyntheticError,NetworkError:SlackNetworkError,ValidationError:SyntheticError}});
 const client=new SlackClient({token:'synthetic-token',fetchImpl:async()=>new Response(new ReadableStream({
  cancel(){cancelled++;return new Promise(()=>{});},
 }),{status,headers:{'Retry-After':'7'}})});
 await assert.rejects(client.call('chat.postMessage'),error=>status===429
  ?error instanceof RateLimitError&&error.retryAfter===7
  :error instanceof SlackNetworkError&&error.message==='chat.postMessage returned HTTP 500');
 assert.equal(cancelled,1);
});

for (const kind of ['down','degraded','partial','up']) test(`internal ${kind} notifications never report application DOWN/RECOVERED or enqueue RCA`,async()=>{
 const f=fixture();f.monitor.monitor_role='diagnostic';
 const notification=await f.transition.notifyTransition(f.env,f.monitor,{healthz_reason:'内部診断待ち',error:null,healthz_components:null,healthz_version:null},{kind,previousStatus:'down',nextStatus:'up',downDurationMs:0,previousSlackAlertTs:'internal-thread'},1000);
 assert.equal(notification.slackAlertTs,kind==='up'||kind==='partial'?null:'synthetic-thread');
 assert.match(text(f),/INTERNAL PATH/);assert.doesNotMatch(text(f),/DOWN|RECOVERED|RESPONSE RESTORED|incident\?/);
 assert.match(text(f),/公開サービスの稼働判定とは別/);assert.equal(f.jobs.length,0);assert.equal(f.reactions.length,0);
 assert.equal(f.posts[0].threadTs,'internal-thread');
});
test('shadow transitions have no notifications, reactions or RCA jobs',async()=>{
 const f=fixture();f.monitor.monitor_role='shadow';
 await f.transition.notifyTransition(f.env,f.monitor,{healthz_reason:'synthetic',error:null,healthz_components:null,healthz_version:null},{kind:'down'},1000);
 assert.equal(f.posts.length+f.discord.length+f.jobs.length+f.reactions.length,0);
});
test('availability RCA carries the configuration revision of the committed observation',async()=>{
 const f=fixture();f.monitor.config_revision=9;
 await f.transition.notifyTransition(f.env,f.monitor,{healthz_reason:'synthetic',error:null,healthz_components:null,healthz_version:null},{kind:'down',previousSlackAlertTs:null},1000);
 assert.equal(f.jobs.length,1);assert.equal(f.jobs[0].configRevision,9);
});


test('acknowledgement failures propagate as uncertainty instead of pretending success',async()=>{
 const f=fixture({post:async()=>{throw Error('provider did not acknowledge');}});
 await assert.rejects(f.notifier.notifyDown(f.env,f.monitor,f.detail),error=>error.code==='uncertain');
 await assert.rejects(f.notifier.notifyUp(f.env,f.monitor,1,'old-thread'),error=>error.code==='uncertain');
 assert.equal(f.jobs.length,0);
});
test('queued delivery renders the observation time rather than the later send time',async()=>{
 const f=fixture();const observed=Date.parse('2026-10-25T10:00:00Z');
 await f.transition.notifyTransition(f.env,f.monitor,{healthz_reason:'failure',error:null,healthz_components:null,healthz_version:null},
  {kind:'down',previousSlackAlertTs:null},observed);
 assert.match(JSON.stringify(f.posts),new RegExp(String(observed/1000)));
 assert.equal(f.discord[0].embeds[0].timestamp,'2026-10-25T10:00:00.000Z');
});
test('missing notification channels are a known unsent failure',async()=>{
 const notifier=load('notifier',{'./slack-bot':{buildSlackBot:()=>null},'./url-display':urlDisplay});
 await assert.rejects(notifier.notifyDown({}, {name:'Synthetic'}, {reason:'failure',components:[],version:null}),error=>error.code==='not_configured');
});


test('a deadline during supplementary RCA retains the already acknowledged Slack thread',async()=>{
 const f=fixture({shortDeadline:true,enqueue:()=>new Promise(()=>{})});
 await assert.rejects(f.transition.notifyTransition(f.env,f.monitor,{healthz_reason:'failure',error:null,healthz_components:null,healthz_version:null},
  {kind:'down',previousSlackAlertTs:null},1000),error=>error.code==='uncertain'&&error.slackAlertTs==='synthetic-thread');
 assert.equal(f.posts.length,1);assert.equal(f.jobs.length,1);
});
