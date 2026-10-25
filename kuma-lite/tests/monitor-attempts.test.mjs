import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTs, result, sqliteEnv } from './helpers.mjs';

const execution = loadTs('monitor-execution');
const { deriveTransition } = loadTs('state-transition');
const SLOT = Math.floor(Date.now() / 60000) * 60000;

async function commit(f, lease, state='up') {
  const previous = await execution.readMonitorState(f.env,1);
  const check = result(state);
  const transition = deriveTransition(f.monitor,check,previous,Date.now(),lease.slotMs,false);
  return execution.commitMonitorResult(f.env,f.monitor,lease,check,previous,transition,Date.now(),false);
}

test('claim decision persists raw scheduling and the exact rejected ownership snapshot', async () => {
  const f=sqliteEnv();
  try {
    const raw=SLOT+52009, received=raw+25000;
    const first=await execution.claimMonitorSlotDecision(f.env,1,SLOT,1,{scheduledTime:raw,receivedAt:received});
    const blocked=await execution.claimMonitorSlotDecision(f.env,1,SLOT+60000,1,
      {scheduledTime:raw+60000,receivedAt:received+60000});
    assert.ok(first.lease);assert.equal(blocked.lease,null);
    assert.equal(blocked.attempt.reason,'lease_busy');
    assert.equal(blocked.attempt.observed_claimed_slot,SLOT);
    assert.ok(blocked.attempt.observed_lease_until>Date.now());
    const saved=f.sqlite.prepare('SELECT * FROM monitor_attempts WHERE attempt_id=?').get(first.lease.attemptId);
    assert.equal(saved.scheduled_time,raw);assert.equal(saved.received_at,received);
    assert.equal(saved.scheduled_slot,SLOT);assert.equal(saved.decision,'claimed');
    assert.equal(saved.monitor_role,'availability');assert.equal(saved.probe_transport,'legacy');
    assert.equal(f.sqlite.prepare('SELECT finished_at FROM monitor_attempts WHERE attempt_id=?').get(blocked.attempt.attempt_id).finished_at!==null,true);
  } finally {f.close();}
});

for (const [label,mutate,reason] of [
  ['missing',f=>f.sqlite.exec('DELETE FROM monitors WHERE id=1'),'monitor_missing'],
  ['disabled',f=>f.sqlite.exec('UPDATE monitors SET enabled=0'),'monitor_disabled'],
  ['revision',f=>f.sqlite.exec('UPDATE monitors SET config_revision=2'),'configuration_changed'],
  ['already recorded',f=>f.sqlite.prepare("INSERT INTO monitor_state(monitor_id,current_status,last_check_slot) VALUES(1,'up',?)").run(SLOT),'already_recorded'],
  ['newer result already recorded',f=>f.sqlite.prepare("INSERT INTO monitor_state(monitor_id,current_status,last_check_slot) VALUES(1,'up',?)").run(SLOT+60000),'superseded_slot'],
  ['newer slot already claimed',f=>f.sqlite.prepare('INSERT INTO monitor_execution(monitor_id,claimed_slot,lease_token,lease_until) VALUES(1,?,?,0)').run(SLOT+60000,'other'),'superseded_slot'],
]) test(`rejected ${label} observation is durable without a fabricated check`,async()=>{
  const f=sqliteEnv();
  try {
    mutate(f);const decision=await execution.claimMonitorSlotDecision(f.env,1,SLOT,1);
    assert.equal(decision.lease,null);assert.equal(decision.attempt.reason,reason);
    assert.equal(f.sqlite.prepare('SELECT count(*) AS n FROM monitor_attempts').get().n,1);
    assert.equal(f.sqlite.prepare('SELECT count(*) AS n FROM checks').get().n,0);
  } finally {f.close();}
});

test('decision classification and claiming are one atomic unit even if the clock advances mid-batch',async()=>{
  const f=sqliteEnv();
  try {
    let seconds=Math.floor(Date.now()/1000);
    f.sqlite.function('strftime',{varargs:true},()=>String(seconds));
    f.sqlite.prepare('INSERT INTO monitor_execution(monitor_id,claimed_slot,lease_token,lease_until) VALUES(1,?,?,?)')
      .run(SLOT-60000,'previous',(seconds+1)*1000);
    f.hooks.beforeBatchStatement=i=>{if(i===1)seconds+=2;};
    const denied=await execution.claimMonitorSlotDecision(f.env,1,SLOT);
    assert.equal(denied.lease,null);assert.equal(denied.attempt.reason,'lease_busy');
    assert.equal(f.sqlite.prepare('SELECT lease_token FROM monitor_execution').get().lease_token,'previous');
    delete f.hooks.beforeBatchStatement;
    assert.ok((await execution.claimMonitorSlotDecision(f.env,1,SLOT+60000)).lease);
  } finally {f.close();}
});

test('claim write failure rolls its audit snapshot back rather than leaving a false claimed receipt',async()=>{
  const f=sqliteEnv();
  try {
    f.sqlite.exec("CREATE TRIGGER refuse_claim BEFORE INSERT ON monitor_execution BEGIN SELECT RAISE(ABORT,'synthetic claim failure'); END");
    await assert.rejects(()=>execution.claimMonitorSlotDecision(f.env,1,SLOT),/synthetic claim failure/);
    assert.equal(f.sqlite.prepare('SELECT count(*) AS n FROM monitor_attempts').get().n,0);
    assert.equal(f.sqlite.prepare('SELECT count(*) AS n FROM monitor_execution').get().n,0);
  } finally {f.close();}
});

test('successful check, notification enqueue, and audit commit are atomic, with independent release evidence',async()=>{
  const f=sqliteEnv();
  try {
    const first=await execution.claimMonitorSlot(f.env,1,SLOT);assert.equal(await commit(f,first,'down'),true);
    await execution.releaseMonitorSlot(f.env,first);
    const second=await execution.claimMonitorSlot(f.env,1,SLOT+60000);assert.equal(await commit(f,second,'down'),true);
    await execution.releaseMonitorSlot(f.env,second,{schema_ms:1,probe_ms:10000,commit_ms:23});
    const audit=f.sqlite.prepare('SELECT * FROM monitor_attempts WHERE attempt_id=?').get(second.attemptId);
    assert.equal(audit.decision,'committed');assert.equal(audit.reason,'completed');
    assert.ok(audit.probe_started_at>0);assert.ok(audit.committed_at>0);assert.ok(audit.released_at>0);
    assert.equal(audit.release_outcome,'released');
    assert.deepEqual(JSON.parse(audit.timings_json),{schema_ms:1,probe_ms:10000,commit_ms:23});
    assert.equal(f.sqlite.prepare('SELECT count(*) AS n FROM notification_outbox').get().n,1);
    assert.equal(f.sqlite.prepare('SELECT lease_until FROM monitor_execution').get().lease_until,0);
  } finally {f.close();}
});

test('notification enqueue error rolls check/state back while preserving the earlier claim decision',async()=>{
  const f=sqliteEnv();
  try {
    const first=await execution.claimMonitorSlot(f.env,1,SLOT);assert.equal(await commit(f,first,'down'),true);
    await execution.releaseMonitorSlot(f.env,first);
    const second=await execution.claimMonitorSlot(f.env,1,SLOT+60000);
    f.sqlite.exec("CREATE TRIGGER fail_outbox BEFORE INSERT ON notification_outbox BEGIN SELECT RAISE(ABORT,'synthetic outbox failure'); END");
    await assert.rejects(()=>commit(f,second,'down'),/synthetic outbox failure/);
    assert.equal(f.sqlite.prepare('SELECT count(*) AS n FROM checks').get().n,1);
    assert.equal(f.sqlite.prepare('SELECT last_check_slot FROM monitor_state').get().last_check_slot,SLOT);
    assert.equal(f.sqlite.prepare('SELECT count(*) AS n FROM notification_outbox').get().n,0);
    assert.equal(f.sqlite.prepare('SELECT decision FROM monitor_attempts WHERE attempt_id=?').get(second.attemptId).decision,'claimed');
  } finally {f.close();}
});

test('stale commit records the revision rejection and cannot append history',async()=>{
  const f=sqliteEnv();
  try {
    const lease=await execution.claimMonitorSlot(f.env,1,SLOT);
    f.sqlite.exec('UPDATE monitors SET config_revision=2');
    assert.equal(await commit(f,lease,'down'),false);
    const row=f.sqlite.prepare('SELECT decision,reason FROM monitor_attempts WHERE attempt_id=?').get(lease.attemptId);
    assert.equal(row.decision,'commit_rejected');assert.equal(row.reason,'configuration_changed');
    assert.equal(f.sqlite.prepare('SELECT count(*) AS n FROM checks').get().n,0);
  } finally {f.close();}
});

test('late release records lost ownership without affecting the replacement owner',async()=>{
  const f=sqliteEnv();
  try {
    const old=await execution.claimMonitorSlot(f.env,1,SLOT);
    f.sqlite.exec('UPDATE monitor_execution SET lease_until=0');
    const current=await execution.claimMonitorSlot(f.env,1,SLOT+60000);
    await execution.releaseMonitorSlot(f.env,old);
    assert.equal(f.sqlite.prepare('SELECT lease_token FROM monitor_execution').get().lease_token,current.token);
    assert.equal(f.sqlite.prepare('SELECT release_outcome FROM monitor_attempts WHERE attempt_id=?').get(old.attemptId).release_outcome,'ownership_lost');
  } finally {f.close();}
});

test('read budgets end a stalled readonly operation without retrying it',async()=>{
  let calls=0;
  const operation=new Promise(()=>{calls++;});
  await assert.rejects(()=>execution.withReadDeadline(operation,5),/read deadline/);
  assert.equal(calls,1);
});

test('audit write errors cannot roll back an acknowledged probe unlock',async()=>{
  const f=sqliteEnv();
  try {
    const lease=await execution.claimMonitorSlot(f.env,1,SLOT);
    f.sqlite.exec("CREATE TRIGGER reject_release_audit BEFORE UPDATE ON monitor_attempts WHEN NEW.released_at IS NOT NULL BEGIN SELECT RAISE(ABORT,'audit unavailable'); END");
    await execution.releaseMonitorSlot(f.env,lease);
    assert.equal(f.sqlite.prepare('SELECT lease_until FROM monitor_execution').get().lease_until,0);
    assert.ok(await execution.claimMonitorSlot(f.env,1,SLOT+60000));
  } finally {f.close();}
});

test('a lost release acknowledgement is not retried or incorrectly recorded as confirmed',async()=>{
  const f=sqliteEnv();
  try {
    const lease=await execution.claimMonitorSlot(f.env,1,SLOT);
    const prepare=f.env.DB.prepare;
    let releases=0;
    f.env.DB.prepare=query=>{
      const statement=prepare(query);
      if(!/UPDATE monitor_execution SET lease_until = 0/.test(query))return statement;
      const lose=bound=>({...bound,bind(...args){return lose(bound.bind(...args));},async run(){
        releases++;await bound.run();throw new Error('release response lost');
      }});
      return lose(statement);
    };
    await assert.rejects(()=>execution.releaseMonitorSlot(f.env,lease),/release response lost/);
    assert.equal(releases,1);
    assert.equal(f.sqlite.prepare('SELECT lease_until FROM monitor_execution').get().lease_until,0);
    const audit=f.sqlite.prepare('SELECT release_outcome,released_at FROM monitor_attempts WHERE attempt_id=?').get(lease.attemptId);
    assert.equal(audit.release_outcome,'unconfirmed');assert.equal(audit.released_at,null);
  } finally {f.close();}
});
