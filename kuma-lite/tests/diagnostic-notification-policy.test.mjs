import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTs, result, sqliteEnv } from './helpers.mjs';

const STEP=120_000;
const BASE=Math.floor(Date.now()/STEP)*STEP-3_600_000;
const {deriveTransition}=loadTs('state-transition');
function fixture(deliver=async(_env,_monitor,_result,transition)=>transition.kind==='up'?null:{slackAlertTs:'diagnostic-root'}) {
  const f=sqliteEnv();const calls=[];
  f.sqlite.exec("UPDATE monitors SET monitor_role='diagnostic',probe_transport='service_binding',interval_minutes=2,config_revision=5,retry_threshold=2");
  const outbox=loadTs('notification-outbox',{'./state-notifications':{async notifyTransition(...args){calls.push(args);return deliver(...args);}}});
  const execution=loadTs('monitor-execution',{'./notification-outbox':outbox});
  let nextSlot=BASE;
  async function observe(state,options={}) {
    nextSlot+=(options.skip??0)*STEP;
    const slot=nextSlot;nextSlot+=STEP;
    if(options.revision)f.sqlite.prepare('UPDATE monitors SET config_revision=?').run(options.revision);
    if(options.transport)f.sqlite.prepare('UPDATE monitors SET probe_transport=?').run(options.transport);
    const monitor=f.sqlite.prepare('SELECT * FROM monitors WHERE id=1').get();
    const lease=await execution.claimMonitorSlot(f.env,1,slot,monitor.config_revision);
    assert.ok(lease);
    const observation=result(state);
    if(state==='down')observation.status_code=503;
    if(options.maintenance)observation.maintenance={from_ms:slot,to_ms:slot+STEP,reason:'synthetic'};
    const previous=await execution.readMonitorState(f.env,1);
    const transition=deriveTransition(monitor,observation,previous,slot+1000,slot,Boolean(options.maintenance));
    try {assert.equal(await execution.commitMonitorResult(f.env,monitor,lease,observation,previous,transition,slot+1000,Boolean(options.maintenance)),true);}
    finally{await execution.releaseMonitorSlot(f.env,lease);}
    return transition;
  }
  const events=()=>f.sqlite.prepare('SELECT kind,status,last_error,scheduled_slot,slack_alert_ts FROM notification_outbox ORDER BY id').all();
  const drain=()=>outbox.drainNotificationOutbox(f.env,1);
  return {...f,calls,observe,events,drain};
}

test('short internal episodes keep raw incident state/checks without Slack warning, partial, or orphan recovery',async()=>{
  const f=fixture();try{
    await f.observe('down');await f.observe('down');
    assert.equal(f.sqlite.prepare('SELECT current_status FROM monitor_state').get().current_status,'down');
    await f.observe('degraded');await f.observe('degraded');
    await f.observe('up');await f.observe('up');await f.drain();
    assert.equal(f.events().length,0);assert.equal(f.calls.length,0);
    assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM checks').get().n,6);
  }finally{f.close();}
});

test('six mixed bad slots warn once even when raw state has not crossed either same-severity threshold',async()=>{
  const f=fixture();try{
    for(let i=0;i<5;i++)await f.observe(i%2?'degraded':'down');
    assert.equal(f.events().length,0);
    const transition=await f.observe('degraded');
    assert.equal(transition.nextStatus,'up');
    assert.deepEqual(f.events().map(r=>r.kind),['degraded']);
    for(const state of ['down','degraded','down','degraded'])await f.observe(state);
    assert.equal(f.events().length,1);
    await f.observe('up');assert.equal(f.events().length,1);
    await f.observe('up');await f.observe('up');
    assert.deepEqual(f.events().map(r=>r.kind),['degraded','up']);
    await f.drain();
    assert.deepEqual(f.calls.map(a=>[a[3].kind,a[3].previousSlackAlertTs]),[['degraded',null],['up','diagnostic-root']]);
    assert.ok(f.events().every(e=>e.status==='sent'));
    for(let i=0;i<6;i++)await f.observe('down');
    assert.deepEqual(f.events().map(r=>r.kind),['degraded','up','down']);
  }finally{f.close();}
});

for(const breakType of ['missing','revision','transport','maintenance'])test(`${breakType} breaks diagnostic persistence without inventing normal observations`,async()=>{
  const f=fixture();try{
    for(let i=0;i<5;i++)await f.observe('down');
    await f.observe('down',breakType==='missing'?{skip:1}:breakType==='revision'?{revision:6}:breakType==='transport'?{transport:'public_fetch'}:{maintenance:true});
    assert.equal(f.events().length,0);
    for(let i=0;i<(breakType==='maintenance'?5:4);i++)await f.observe('down');
    assert.equal(f.events().length,0);
    await f.observe('down');assert.deepEqual(f.events().map(r=>r.kind),['down']);
  }finally{f.close();}
});

test('a gap or a bad observation interrupts the two-normal recovery requirement',async()=>{
  const f=fixture();try{
    for(let i=0;i<6;i++)await f.observe('down');await f.drain();
    await f.observe('up');await f.observe('up',{skip:1});
    assert.equal(f.events().length,1);
    await f.observe('degraded');await f.observe('up');assert.equal(f.events().length,1);
    await f.observe('up');assert.deepEqual(f.events().map(r=>r.kind),['down','up']);
  }finally{f.close();}
});

test('ambiguous warning is not replayed, and an unknown Slack root does not create a top-level recovery',async()=>{
  const f=fixture(async()=>{throw Object.assign(Error('synthetic lost acknowledgement'),{code:'uncertain'});});
  Object.assign(f.env,{SLACK_BOT_TOKEN:'synthetic-token',SLACK_SIGNING_SECRET:'synthetic-signing-secret',SLACK_DEFAULT_CHANNEL:'synthetic-channel'});
  try{
    for(let i=0;i<6;i++)await f.observe('down');await f.drain();
    for(let i=0;i<8;i++)await f.observe('down');await f.drain();
    assert.equal(f.calls.length,1);assert.equal(f.events()[0].status,'uncertain');
    await f.observe('up');await f.observe('up');await f.drain();
    assert.equal(f.calls.length,1);
    assert.equal(f.events()[1].status,'cancelled');assert.equal(f.events()[1].last_error,'diagnostic_thread_unavailable');
    for(let i=0;i<6;i++)await f.observe('down');
    assert.equal(f.events().length,3);assert.equal(f.events()[0].status,'uncertain');
  }finally{f.close();}
});

test('Discord-only diagnostic recovery does not require a Slack thread',async()=>{
  const f=fixture(async()=>({slackAlertTs:null}));
  f.env.DISCORD_WEBHOOK_URL='https://example.invalid/synthetic';
  try{
    for(let i=0;i<6;i++)await f.observe('down');await f.drain();
    await f.observe('up');await f.observe('up');await f.drain();
    assert.deepEqual(f.calls.map(a=>a[3].kind),['down','up']);assert.ok(f.events().every(e=>e.status==='sent'));
  }finally{f.close();}
});

test('a known unsent warning failure does not queue a new attempt on every probe',async()=>{
  const f=fixture(async()=>{throw Object.assign(Error('synthetic no channel'),{code:'not_configured'});});
  try{
    for(let i=0;i<6;i++)await f.observe('down');await f.drain();
    assert.equal(f.events()[0].status,'failed');
    for(let i=0;i<5;i++)await f.observe('down');assert.equal(f.events().length,1);
    await f.observe('up');await f.observe('up');assert.equal(f.events().length,1);
    for(let i=0;i<6;i++)await f.observe('down');assert.equal(f.events().length,2);
  }finally{f.close();}
});

test('diagnostic outbox failure rolls back the sixth check/state without losing previous history',async()=>{
  const f=fixture();try{
    for(let i=0;i<5;i++)await f.observe('down');
    f.sqlite.exec("CREATE TRIGGER reject_diagnostic BEFORE INSERT ON notification_outbox BEGIN SELECT RAISE(ABORT,'synthetic failure'); END");
    await assert.rejects(f.observe('down'));
    assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM checks').get().n,5);
    assert.equal(f.sqlite.prepare('SELECT last_check_slot FROM monitor_state').get().last_check_slot,BASE+4*STEP);
    assert.equal(f.events().length,0);
  }finally{f.close();}
});

test('a known unsent diagnostic recovery retains its warning thread and uses a bounded retry interval',async()=>{
  let failRecovery=true;
  const f=fixture(async(_env,_monitor,_result,transition)=>{
    if(transition.kind==='up' && failRecovery)throw Object.assign(Error('synthetic no channel'),{code:'not_configured'});
    return transition.kind==='up'?null:{slackAlertTs:'diagnostic-root'};
  });
  try{
    for(let i=0;i<6;i++)await f.observe('down');await f.drain();
    await f.observe('up');await f.observe('up');await f.drain();
    assert.equal(f.events()[1].status,'failed');
    assert.equal(f.sqlite.prepare('SELECT slack_alert_ts FROM notification_delivery_state').get().slack_alert_ts,'diagnostic-root');
    for(let i=0;i<5;i++){await f.observe('up');await f.drain();}
    assert.equal(f.calls.length,2);assert.equal(f.events().length,2);
    failRecovery=false;await f.observe('up');await f.drain();
    assert.equal(f.calls.length,3);assert.equal(f.calls[2][3].previousSlackAlertTs,'diagnostic-root');
    assert.equal(f.events()[2].status,'sent');
  }finally{f.close();}
});

test('public availability retains the original two-bad and immediate DOWN recovery semantics',async()=>{
  const f=fixture();try{
    f.sqlite.exec("UPDATE monitors SET monitor_role='availability',probe_transport='public_fetch'");
    await f.observe('down');assert.equal(f.events().length,0);
    await f.observe('down');assert.deepEqual(f.events().map(r=>r.kind),['down']);
    await f.observe('up');assert.deepEqual(f.events().map(r=>r.kind),['down','up']);
  }finally{f.close();}
});
