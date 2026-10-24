import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as urlDisplay from '../src/url-display.ts';

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
 const notifier=load('notifier',{'./slack-bot':{buildSlackBot:()=>bot},'./url-display':urlDisplay},{fetch:async(_url,init)=>{discord.push(JSON.parse(init.body));assert.equal(init.redirect,'manual');assert.ok(init.signal instanceof AbortSignal);return new Response(null,{status:204});}});
 const transition=load('state-notifications',{'./notifier':notifier,'./rca':{async enqueueRca(_env,job){jobs.push(job);}}},{setTimeout:(callback,ms)=>setTimeout(callback,options.shortDeadline&&ms===18000?5:ms)});
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
 const returned=await f.transition.notifyTransition(f.env,f.monitor,result,{kind:'down',previousStatus:'up',nextStatus:'down',downDurationMs:0,previousSlackAlertTs:null},1000);
 assert.equal(returned,null);release({ts:'late-thread'});await new Promise(resolve=>setTimeout(resolve,0));
 assert.equal(f.jobs.length,0);
});
test('Slack API requests use bounded native fetch deadlines and do not follow credential-bearing redirects',async()=>{
 const seen=[];class SyntheticError extends Error{}
 const {SlackClient}=load('chat-adapters/slack/client',{'./errors':{AdapterRateLimitError:SyntheticError,AuthenticationError:SyntheticError,NetworkError:SyntheticError,ValidationError:SyntheticError}});
 const client=new SlackClient({token:'synthetic-token',fetchImpl:async(_url,init)=>{seen.push(init);return Response.json({ok:true});}});
 await client.call('chat.postMessage',{channel:'synthetic-channel',text:'synthetic'});
 assert.equal(seen[0].redirect,'manual');assert.ok(seen[0].signal instanceof AbortSignal);
});
