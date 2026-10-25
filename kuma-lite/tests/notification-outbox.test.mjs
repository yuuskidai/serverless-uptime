import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTs, result, sqliteEnv } from './helpers.mjs';

const SLOT = Math.floor(Date.now()/60000)*60000;
const { deriveTransition } = loadTs('state-transition');
const pause = ms => new Promise(resolve=>setTimeout(resolve,ms));
async function until(predicate) {
  for (let i=0;i<100;i++) { if (predicate()) return; await pause(1); }
  assert.fail('Expected bounded asynchronous stage did not occur');
}
function fixture(deliver=async()=>({slackAlertTs:'root-thread'})) {
  const f=sqliteEnv();
  const calls=[];
  const outbox=loadTs('notification-outbox', {'./state-notifications':{
    async notifyTransition(...args) { calls.push(args); return deliver(...args); },
  }});
  f.monitor.retry_threshold=1;
  async function queue(kind,slot=SLOT,options={}) {
    const revision=f.monitor.config_revision??1;
    const observation=result(options.resultState??(kind==='down'?'down':kind==='up'?'up':'degraded'));
    const transition=deriveTransition(f.monitor,observation,null,slot+1000,slot,false);
    transition.kind=kind;
    Object.assign(transition,options.transition);
    Object.assign(transition.next,options.next);
    const token='probe-'+slot;
    const lease={monitorId:1,slotMs:slot,token,configRevision:revision};
    f.sqlite.prepare(`INSERT INTO monitor_execution(monitor_id,claimed_slot,lease_token,lease_until) VALUES(1,?,?,0)
      ON CONFLICT(monitor_id) DO UPDATE SET claimed_slot=excluded.claimed_slot,lease_token=excluded.lease_token,lease_until=0`).run(slot,token);
    const statement=outbox.outboxInsertStatement(f.env,f.monitor,lease,observation,transition,slot+1000);
    await f.env.DB.batch([
      f.env.DB.prepare(`INSERT INTO checks(monitor_id,status,ts,scheduled_slot,config_revision,monitor_role,probe_transport)
        VALUES(1,?,?,?,?,'availability','public_fetch')`).bind(observation.status,slot+1000,slot,revision),
      f.env.DB.prepare(`INSERT INTO monitor_state(monitor_id,current_status,last_check_slot,config_revision)
        VALUES(1,?,?,?) ON CONFLICT(monitor_id) DO UPDATE SET current_status=excluded.current_status,last_check_slot=excluded.last_check_slot,config_revision=excluded.config_revision,slack_alert_ts=NULL`)
        .bind(transition.nextStatus,slot,revision),
      ...(statement?[statement]:[]),
    ]);
    return {observation,transition,lease,statement};
  }
  return {...f,outbox,calls,queue};
}

test('outbox inserts require the accepted state write and original probe owner',async()=>{
  const f=fixture();
  try {
    const q=await f.queue('down');
    assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM notification_outbox').get().n,1);
    f.sqlite.exec('DELETE FROM notification_outbox');
    // A rejected state write does not authorize a notification from an existing receipt.
    await f.env.DB.batch([
      f.env.DB.prepare('UPDATE monitor_state SET current_status=current_status WHERE monitor_id=-1'),
      q.statement,
    ]);
    assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM notification_outbox').get().n,0);
    f.sqlite.exec("UPDATE monitor_execution SET lease_token='new-owner'");
    await f.env.DB.batch([
      f.env.DB.prepare('UPDATE monitor_state SET current_status=current_status WHERE monitor_id=1'),q.statement,
    ]);
    assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM notification_outbox').get().n,0);
    assert.equal(f.outbox.outboxInsertStatement(f.env,{...f.monitor,monitor_role:'shadow'},q.lease,q.observation,q.transition,SLOT),null);
  } finally {f.close();}
});

test('ordered delivery retains the DOWN thread even after probe state has already recovered',async()=>{
  const f=fixture(async(_env,_monitor,_result,transition)=>transition.kind==='down'?{slackAlertTs:'posted-down'}:null);
  try {
    await f.queue('down',SLOT);await f.queue('partial',SLOT+60000);await f.queue('up',SLOT+120000);
    assert.equal(f.sqlite.prepare('SELECT current_status FROM monitor_state').get().current_status,'up');
    await f.outbox.drainNotificationOutbox(f.env,1);
    assert.deepEqual(f.calls.map(args=>[args[3].kind,args[3].previousSlackAlertTs,args[4]]),
      [['down',null,SLOT+1000],['partial','posted-down',SLOT+61000],['up','posted-down',SLOT+121000]]);
    assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM notification_outbox WHERE status='sent'").get().n,3);
    assert.equal(f.sqlite.prepare('SELECT slack_alert_ts FROM notification_delivery_state').get().slack_alert_ts,null);
  } finally {f.close();}
});

test('slow notification ownership neither holds the probe lease nor permits duplicate delivery consumers',async()=>{
  let release;
  const f=fixture(()=>new Promise(resolve=>{release=resolve;}));
  try {
    await f.queue('down');
    const sending=f.outbox.drainNotificationOutbox(f.env,1);
    await until(()=>f.calls.length===1);
    assert.equal(f.sqlite.prepare('SELECT lease_until FROM monitor_execution').get().lease_until,0);
    const execution=loadTs('monitor-execution');
    const next=await execution.claimMonitorSlot(f.env,1,SLOT+60000,1);
    assert.ok(next,'The next probe can claim while the prior alert is still waiting');
    await f.outbox.drainNotificationOutbox(f.env,1);
    assert.equal(f.calls.length,1);
    release({slackAlertTs:'down-thread'});await sending;
    assert.equal(f.sqlite.prepare('SELECT status FROM notification_outbox').get().status,'sent');
  } finally {f.close();}
});

test('ambiguous delivery is recorded once and is not blindly retried',async()=>{
  const f=fixture(async()=>{throw Object.assign(Error('lost acknowledgement'),{code:'uncertain'});});
  try {
    await f.queue('down');await f.outbox.drainNotificationOutbox(f.env,1);await f.outbox.drainNotificationOutbox(f.env,1);
    assert.equal(f.calls.length,1);
    const row=f.sqlite.prepare('SELECT status,last_error,attempts FROM notification_outbox').get();
    assert.equal(row.status,'uncertain');assert.equal(row.last_error,'delivery_unconfirmed');assert.equal(row.attempts,1);
  } finally {f.close();}
});

test('expired processing is uncertain, and stale delivery cannot replace the new owner or thread',async()=>{
  let release;
  const f=fixture(()=>new Promise(resolve=>{release=resolve;}));
  try {
    await f.queue('down');const sending=f.outbox.drainNotificationOutbox(f.env,1);
    await until(()=>f.calls.length===1);
    f.sqlite.exec('UPDATE notification_delivery_state SET lease_until=0; UPDATE notification_outbox SET lease_until=0');
    await f.outbox.drainNotificationOutbox(f.env,1);
    assert.equal(f.sqlite.prepare('SELECT status FROM notification_outbox').get().status,'uncertain');
    release({slackAlertTs:'stale-thread'});await sending;
    assert.equal(f.sqlite.prepare('SELECT slack_alert_ts FROM notification_delivery_state').get().slack_alert_ts,null);
    assert.equal(f.calls.length,1);
  } finally {f.close();}
});

for (const setting of ["enabled=0","config_revision=2","monitor_role='shadow'"]) test(`queued notifications reject changed ${setting}`,async()=>{
  const f=fixture();
  try {
    await f.queue('down');f.sqlite.exec('UPDATE monitors SET '+setting);
    await f.outbox.drainNotificationOutbox(f.env,1);
    assert.equal(f.calls.length,0);assert.equal(f.sqlite.prepare('SELECT status FROM notification_outbox').get().status,'cancelled');
  } finally {f.close();}
});

test('a known missing channel failure is visible and does not pretend delivery succeeded',async()=>{
  const f=fixture(async()=>{throw Object.assign(Error('not configured'),{code:'not_configured'});});
  try {
    await f.queue('down');await f.outbox.drainNotificationOutbox(f.env,1);
    assert.equal(f.sqlite.prepare('SELECT status FROM notification_outbox').get().status,'failed');
  } finally {f.close();}
});

test('a settings change during provider I/O cannot install a stale thread or claim current delivery',async()=>{
  let release;
  const f=fixture(()=>new Promise(resolve=>{release=resolve;}));
  try {
    await f.queue('down');const sending=f.outbox.drainNotificationOutbox(f.env,1);
    await until(()=>f.calls.length===1);
    f.sqlite.exec('UPDATE monitors SET config_revision=2');
    release({slackAlertTs:'old-revision-thread'});await sending;
    const receipt=f.sqlite.prepare('SELECT status,last_error FROM notification_outbox').get();
    assert.equal(receipt.status,'uncertain');assert.equal(receipt.last_error,'configuration_changed_during_delivery');
    assert.equal(f.sqlite.prepare('SELECT slack_alert_ts FROM notification_delivery_state').get().slack_alert_ts,null);
  } finally {f.close();}
});

test('a cancelled old-revision DOWN is replaced once only by a fresh accepted bad observation',async()=>{
  const f=fixture();
  try {
    await f.queue('down');
    f.sqlite.exec('UPDATE monitors SET config_revision=2');f.monitor.config_revision=2;
    await f.outbox.drainNotificationOutbox(f.env,1);
    const options={resultState:'down',transition:{previousStatus:'down',nextStatus:'down'},next:{down_since:SLOT+1000,last_notified_at:SLOT+1000}};
    await f.queue(null,SLOT+60000,options);await f.queue(null,SLOT+120000,options);
    assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM notification_outbox WHERE status='pending'").get().n,1);
    await f.outbox.drainNotificationOutbox(f.env,1);
    await f.queue(null,SLOT+180000,options);await f.outbox.drainNotificationOutbox(f.env,1);
    assert.equal(f.calls.length,1);assert.equal(f.calls[0][3].kind,'down');
    assert.equal(f.calls[0][4],SLOT+61000);
  } finally {f.close();}
});

test('cancelled DEGRADED does not produce a replacement warning on a fresh normal response',async()=>{
  const f=fixture();
  try {
    await f.queue('degraded');f.sqlite.exec('UPDATE monitors SET config_revision=2');f.monitor.config_revision=2;
    await f.outbox.drainNotificationOutbox(f.env,1);
    await f.queue(null,SLOT+60000,{resultState:'up',transition:{previousStatus:'degraded',nextStatus:'degraded'},next:{last_notified_at:SLOT+1000}});
    await f.outbox.drainNotificationOutbox(f.env,1);assert.equal(f.calls.length,0);
  } finally {f.close();}
});

for (const delivery of ['sent','uncertain']) test(`an already ${delivery} old-revision alert is not resent after settings change`,async()=>{
  const f=fixture(delivery==='uncertain'?async()=>{throw Object.assign(Error(),{code:'uncertain'});}:undefined);
  try {
    await f.queue('down');await f.outbox.drainNotificationOutbox(f.env,1);
    f.sqlite.exec('UPDATE monitors SET config_revision=2');f.monitor.config_revision=2;
    await f.queue(null,SLOT+60000,{resultState:'down',transition:{previousStatus:'down',nextStatus:'down'},next:{down_since:SLOT+1000,last_notified_at:SLOT+1000}});
    await f.outbox.drainNotificationOutbox(f.env,1);assert.equal(f.calls.length,1);
  } finally {f.close();}
});

test('cancelled old-revision recovery is replaced from a fresh normal observation and resolves its known thread',async()=>{
  const f=fixture(async(_env,_monitor,_result,transition)=>transition.kind==='down'?{slackAlertTs:'known-root'}:null);
  try {
    await f.queue('down');await f.outbox.drainNotificationOutbox(f.env,1);
    await f.queue('up',SLOT+60000,{transition:{previousStatus:'down',nextStatus:'up',downDurationMs:38000}});
    f.sqlite.exec('UPDATE monitors SET config_revision=2');f.monitor.config_revision=2;
    await f.outbox.drainNotificationOutbox(f.env,1);
    await f.queue(null,SLOT+120000,{resultState:'up',transition:{previousStatus:'up',nextStatus:'up'}});
    await f.queue(null,SLOT+180000,{resultState:'up',transition:{previousStatus:'up',nextStatus:'up'}});
    await f.outbox.drainNotificationOutbox(f.env,1);
    assert.equal(f.calls.length,2);
    assert.equal(f.calls[1][3].kind,'up');assert.equal(f.calls[1][3].previousStatus,'down');
    assert.equal(f.calls[1][3].downDurationMs,38000);assert.equal(f.calls[1][3].previousSlackAlertTs,'known-root');
    assert.equal(f.sqlite.prepare('SELECT slack_alert_ts FROM notification_delivery_state').get().slack_alert_ts,null);
  } finally {f.close();}
});

for (const priorDelivery of ['sent','uncertain']) test(`Discord-only recovery repairs a cancelled revision after a ${priorDelivery} incident without a Slack thread`,async()=>{
  let first=true;
  const f=fixture(async()=>{
    if(first){first=false;if(priorDelivery==='uncertain')throw Object.assign(Error(),{code:'uncertain'});}
    return {slackAlertTs:null};
  });
  try {
    await f.queue('down');await f.outbox.drainNotificationOutbox(f.env,1);
    assert.equal(f.sqlite.prepare('SELECT slack_alert_ts FROM notification_delivery_state').get().slack_alert_ts,null);
    await f.queue('up',SLOT+60000,{transition:{previousStatus:'down',nextStatus:'up',downDurationMs:38000}});
    f.sqlite.exec('UPDATE monitors SET config_revision=2');f.monitor.config_revision=2;
    await f.outbox.drainNotificationOutbox(f.env,1);
    await f.queue(null,SLOT+120000,{resultState:'up',transition:{previousStatus:'up',nextStatus:'up'}});
    await f.outbox.drainNotificationOutbox(f.env,1);
    await f.queue(null,SLOT+180000,{resultState:'up',transition:{previousStatus:'up',nextStatus:'up'}});
    await f.outbox.drainNotificationOutbox(f.env,1);
    assert.equal(f.calls.length,2);assert.equal(f.calls[1][3].kind,'up');
    assert.equal(f.calls[1][3].previousSlackAlertTs,null);assert.equal(f.calls[1][3].previousStatus,'down');
    assert.equal(f.calls[1][3].downDurationMs,38000);
  } finally {f.close();}
});

test('first delivery after migration can adopt the legacy thread opened after the schema seed',async()=>{
  const f=fixture(async()=>null);
  try {
    f.sqlite.exec('INSERT INTO notification_delivery_state(monitor_id) VALUES(1)');
    await f.queue('up',SLOT,{transition:{previousStatus:'down',previousSlackAlertTs:'legacy-open-thread'}});
    await f.outbox.drainNotificationOutbox(f.env,1);
    assert.equal(f.calls[0][3].previousSlackAlertTs,'legacy-open-thread');
    assert.equal(f.sqlite.prepare('SELECT last_processed_slot FROM notification_delivery_state').get().last_processed_slot,SLOT);
  } finally {f.close();}
});

test('accepted check and state still queue their notification if the lease expires before the third statement',async()=>{
  const f=sqliteEnv();
  try {
    f.monitor.retry_threshold=1;
    const execution=loadTs('monitor-execution');
    const lease=await execution.claimMonitorSlot(f.env,1,SLOT,1);
    const until=f.sqlite.prepare('SELECT lease_until FROM monitor_execution').get().lease_until;
    let seconds=(until-1000)/1000;
    f.sqlite.function('strftime',{varargs:true},()=>String(seconds));
    f.hooks.beforeBatchStatement=i=>{if(i===2)seconds=(until+1000)/1000;};
    const observation=result('down');const transition=deriveTransition(f.monitor,observation,null,SLOT+1000,SLOT,false);
    assert.equal(await execution.commitMonitorResult(f.env,f.monitor,lease,observation,null,transition,SLOT+1000,false),true);
    assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM notification_outbox').get().n,1);
  } finally {f.close();}
});
