import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTs } from './helpers.mjs';

const mocks={
  './security-notifications-entrypoint':{},
  './security-integration':{},
  './api':{},'./edge-cache':{},'./incident-page':{},'./rca':{},'./rss-feed':{},
  './status-page':{},'./slack-bot':{},'./monitor':{},'./monitor-runner':{},
  './notification-outbox':{},'./scheduled-runs':{},'./schema-gate':{},
};
const {scheduledOffsetWaitMs}=loadTs('index',mocks);

test('the offset consumes delivery and schema time, while keeping the original scheduled slot',()=>{
  const scheduled=1792926052009;
  assert.equal(scheduledOffsetWaitMs(scheduled,scheduled),5000);
  assert.equal(scheduledOffsetWaitMs(scheduled,scheduled+400,scheduled+100),4600);
  assert.equal(scheduledOffsetWaitMs(scheduled,scheduled+4999,scheduled+100),1);
  assert.equal(scheduledOffsetWaitMs(scheduled,scheduled+5000,scheduled+100),0);
  assert.equal(scheduledOffsetWaitMs(scheduled,scheduled+71911,scheduled+71911),0);
});

test('invalid or future raw timing falls back to the former bounded five-second wait',()=>{
  const now=1792926052009;
  for(const raw of [NaN,Infinity,-1,1.5,Number.MAX_SAFE_INTEGER+1,now+1]) {
    assert.equal(scheduledOffsetWaitMs(raw,now),5000);
  }
  // Schema work catching up with a future timestamp must not hide the anomaly.
  assert.equal(scheduledOffsetWaitMs(now+100,now+500,now),5000);
});

test('a 72-second delayed invocation passes the original time and an already-reached probe floor to the runner',async()=>{
  const scheduled=Date.now()-71911, calls=[], pending=[];
  const {default:worker}=loadTs('index',{...mocks,
    './schema-gate':{ensureSchema:async()=>({ok:true}),logSchemaProblem(){}},
    './scheduled-runs':{
      beginScheduledRun:async(_env,_cron,scheduledTime,receivedAt)=>({runId:'late-run',scheduledTime,receivedAt}),
      advanceScheduledRun:async()=>{},finishScheduledRun:async()=>{},
    },
    './monitor-runner':{runChecks:async(_env,time,timing)=>calls.push({time,timing})},
    './notification-outbox':{drainNotificationOutbox:async()=>{}},
  });
  await worker.scheduled({cron:'* * * * *',scheduledTime:scheduled},{},{waitUntil:p=>pending.push(p)});
  await Promise.all(pending);
  assert.equal(calls.length,1);
  assert.equal(calls[0].time,scheduled);
  assert.ok(calls[0].timing.probeNotBeforeMs>=calls[0].timing.receivedAt);
  assert.ok(calls[0].timing.probeNotBeforeMs<=Date.now());
  assert.equal(calls[0].timing.offsetWaitMs,undefined);
  assert.equal(calls[0].timing.offsetMs,undefined);
});

test('an on-time invocation reaches the claim runner before the original probe floor, without a run-wide offset stage',async()=>{
  const calls=[], stages=[], pending=[];
  const {default:worker}=loadTs('index',{...mocks,
    './schema-gate':{ensureSchema:async()=>({ok:true}),logSchemaProblem(){}},
    './scheduled-runs':{
      beginScheduledRun:async(_env,_cron,scheduledTime,receivedAt)=>({runId:'on-time-run',scheduledTime,receivedAt}),
      advanceScheduledRun:async(_env,_run,stage)=>stages.push(stage),finishScheduledRun:async()=>{},
    },
    './monitor-runner':{runChecks:async(_env,time,timing)=>calls.push({time,timing,calledAt:Date.now()})},
    './notification-outbox':{drainNotificationOutbox:async()=>{}},
  });
  const scheduled=Date.now();
  await worker.scheduled({cron:'* * * * *',scheduledTime:scheduled},{},{waitUntil:p=>pending.push(p)});
  await Promise.all(pending);
  assert.equal(calls.length,1);
  assert.equal(calls[0].time,scheduled);
  assert.equal(calls[0].timing.probeNotBeforeMs,scheduled+5000);
  assert.ok(calls[0].calledAt<calls[0].timing.probeNotBeforeMs);
  assert.deepEqual(stages,['checks']);
});

for(const reason of ['schema_timeout','schema_unavailable','schema_missing']) {
  test(`a ${reason} skips probes and retains its distinct scheduled-run diagnosis`,async()=>{
    const outcomes=[],pending=[];
    const {default:worker}=loadTs('index',{...mocks,
      './schema-gate':{ensureSchema:async()=>({ok:false,missing:[],reason}),logSchemaProblem(){}},
      './scheduled-runs':{
        beginScheduledRun:async()=>({runId:'schema-run'}),advanceScheduledRun:async()=>{},
        finishScheduledRun:async(_env,_run,outcome,phase)=>outcomes.push({outcome,phase}),
      },
      './monitor-runner':{runChecks:async()=>assert.fail('schema failure must not probe')},
    });
    await worker.scheduled({cron:'* * * * *',scheduledTime:Date.now()},{},{waitUntil:p=>pending.push(p)});
    await Promise.all(pending);
    assert.deepEqual(outcomes,[{outcome:reason==='schema_missing'?'schema_missing':'failed',
      phase:reason==='schema_missing'?'schema':reason}]);
  });
}
