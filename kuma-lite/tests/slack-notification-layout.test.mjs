import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTs } from './helpers.mjs';

const {renderMonitorSlackMessage,notificationServiceUrl,notificationTimeJst}=loadTs('slack-notification-layout');
const monitor={id:5,name:'Partner Portal',url:'https://partner-portal.opus-system.jp/healthz',interval_minutes:2};
const detail={reason:'Database 応答が監視閾値1500msを超過（1936ms）',components:[{name:'Database',status:'degraded',latency_ms:1936,reason:'応答に時間がかかっています'}],version:'0086dab',observedAt:Date.parse('2026-11-02T21:33:00Z')};
function validateText(value,max){assert.equal(typeof value.text,'string');assert.ok(value.text.length<=max,`${value.text.length}>${max}`);}
function validateCard(card){
  assert.ok(card.blocks.length<=50);assert.ok(card.text.length<=4000);
  for(const block of card.blocks){
    if(block.type==='header')validateText(block.text,150);
    if(block.type==='section'){
      if(block.text)validateText(block.text,3000);
      if(block.fields){assert.ok(block.fields.length<=10);for(const f of block.fields)validateText(f,2000);}
    }
    if(block.type==='context'){assert.ok(block.elements.length<=10);for(const e of block.elements)validateText(e,2000);}
    if(block.type==='actions'){
      assert.ok(block.elements.length<=25);
      for(const button of block.elements){validateText(button.text,75);assert.ok(button.url.length<=3000);assert.match(button.url,/^https?:\/\//);}
    }
  }
}

test('public cards identify impact, observed JST time, component latency and read-only next actions',()=>{
  const card=renderMonitorSlackMessage(monitor,detail,'degraded');validateCard(card);
  assert.match(card.blocks[0].text.text,/応答遅延・一部不調.*Partner Portal/);
  const all=JSON.stringify(card);assert.match(all,/公開HTTPS/);assert.match(all,/2026\/11\/03 06:33:00 JST/);
  assert.match(all,/Database/);assert.match(all,/1,936 ms/);assert.match(all,/対応の目安/);
  assert.ok(card.blocks.some(b=>b.type==='divider'));
  const buttons=card.blocks.find(b=>b.type==='actions').elements;
  assert.equal(buttons[0].url,'https://partner-portal.opus-system.jp/');
  assert.ok(buttons.every(b=>b.type==='button'&&b.url));
});

test('internal warnings and recovery never assert the public service is down, healthy or recovered',()=>{
  for(const kind of ['down','degraded','partial','up']){
    const card=renderMonitorSlackMessage(monitor,detail,kind,{internal:true});validateCard(card);
    assert.match(card.blocks[0].text.text,/内部経路/);
    assert.doesNotMatch(card.blocks[0].text.text,/公開サービス|DOWN|RECOVERED/);
    assert.match(JSON.stringify(card),/公開サービスの稼働判定とは別の内部診断/);
    assert.ok(!card.blocks.some(b=>b.fields?.some(f=>f.text.includes('停止期間'))));
  }
});

test('partial response recovery remains a warning while full recovery avoids a fictitious degraded down duration',()=>{
  const partial=renderMonitorSlackMessage(monitor,detail,'partial',{durationMs:38000});validateCard(partial);
  assert.match(JSON.stringify(partial),/完全復旧はまだ確認していません/);
  assert.match(JSON.stringify(partial),/38秒/);
  const recovered=renderMonitorSlackMessage(monitor,detail,'up',{previousStatus:'degraded',durationMs:0});
  assert.match(JSON.stringify(recovered),/連続した正常チェック/);
  assert.doesNotMatch(JSON.stringify(recovered),/停止期間|1秒未満|1936/);
  const noDuration=renderMonitorSlackMessage(monitor,detail,'up',{previousStatus:'down',durationMs:0});
  assert.doesNotMatch(JSON.stringify(noDuration),/停止期間|1秒未満/);
});

test('untrusted formatting stays literal and credentials never appear in clickable service URLs',()=>{
  const card=renderMonitorSlackMessage({...monitor,name:'<!channel> *malicious*'},
    {...detail,reason:'<!here> <@U12345678> <https://attacker.invalid|open> `*styled*`',version:'<!channel>`version'},'down');
  validateCard(card);assert.doesNotMatch(card.text,/<!|<@|<https:/);
  const reason=card.blocks.find(b=>b.type==='section'&&b.text?.text.startsWith('原因・観測内容'));
  assert.equal(reason.text.type,'plain_text');
  assert.equal(notificationServiceUrl('https://user:private-password@example.invalid/healthz?token=private-query#private-fragment'),'https://example.invalid/');
  for(const url of ['javascript:alert(1)','data:text/html,payload','file:///private','not a url'])assert.equal(notificationServiceUrl(url),null);
  const invalid=renderMonitorSlackMessage({...monitor,url:'javascript:alert(1)'},detail,'down');
  assert.equal(invalid.blocks.find(b=>b.type==='actions').elements.length,1);
});

test('maximum input lengths, escape expansion and emoji stay within Slack Block Kit limits',()=>{
  const huge={...detail,reason:'<&*`\u202e'.repeat(5000),version:'<&'.repeat(500),components:Array.from({length:20},(_,i)=>({name:'🔥'.repeat(200),status:i%2?'down':'degraded',latency_ms:999999999,reason:'<&long reason'.repeat(500)}))};
  for(const internal of [false,true])for(const kind of ['down','degraded','partial','up']){
    const card=renderMonitorSlackMessage({...monitor,name:'🔥'.repeat(200)},huge,kind,{internal});validateCard(card);
    assert.doesNotMatch(JSON.stringify(card),/\u202e/);assert.doesNotMatch(JSON.stringify(card),/\\u(?:d8|d9|da|db)[0-9a-f]{2}(?!\\u(?:dc|dd|de|df))/i);
    if(kind!=='up')assert.match(JSON.stringify(card),/ほか 15 コンポーネント/);
  }
});

test('observation time is explicit JST and invalid supplied timestamps are not replaced with a fresh time',()=>{
  assert.equal(notificationTimeJst(Date.parse('2026-11-02T15:00:00Z')),'2026/11/03 00:00:00 JST');
  assert.equal(notificationTimeJst(NaN),'観測時刻不明');assert.equal(notificationTimeJst(Infinity),'観測時刻不明');
});

test('the actual Block Kit adapter keeps fallback text literal and preserves threaded recovery delivery',async()=>{
  const calls=[];
  class Client{
    async postMessage(payload){calls.push(payload);return {ts:'1793660400.123456',channel:payload.channel};}
  }
  const {SlackWorkersAdapter}=loadTs('chat-adapters/slack/adapter',{
    chat:{Message:class{},toPlainText:()=>''},'./client':{SlackClient:Client},
    './errors':{ValidationError:class extends Error{}},'./signing':{verifySlackRequest:()=>false},
  });
  const adapter=new SlackWorkersAdapter({botToken:'synthetic-token'});
  const card=renderMonitorSlackMessage(monitor,{...detail,reason:'<!channel> untrusted'},'down');
  const first=await adapter.postBlocks('C0123456789',card);
  await adapter.postBlocks('slack:C0123456789:',{...renderMonitorSlackMessage(monitor,detail,'up'),threadTs:first.ts,replyBroadcast:true});
  for(const payload of calls){
    assert.equal(payload.parse,'none');assert.equal(payload.link_names,false);assert.equal(payload.mrkdwn,false);
    assert.equal(payload.unfurl_links,false);assert.equal(payload.unfurl_media,false);
  }
  assert.doesNotMatch(calls[0].text,/<!channel>/);
  assert.equal(calls[0].thread_ts,undefined);assert.equal(calls[0].reply_broadcast,undefined);
  assert.equal(calls[1].thread_ts,first.ts);assert.equal(calls[1].reply_broadcast,true);
});
