import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTs, result, sqliteEnv } from './helpers.mjs';

const execution = loadTs('monitor-execution');
const SLOT = Math.floor(Date.now() / 60000) * 60000;

function runner(probe, notifications, executionOverride = execution, deliver) {
  return loadTs('monitor-runner', {
    './monitor': { performCheck: probe },
    './monitor-execution': executionOverride,
    './state-notifications': {
      async notifyTransition(_env, _monitor, _result, transition) {
        notifications.push(transition.kind);
        if (deliver) return deliver(transition);
        return { slackAlertTs: 'synthetic-thread' };
      },
    },
  }).runChecks;
}

test('duplicate minute delivery does not double-count failure thresholds or dispatch alerts', async () => {
  const f = sqliteEnv(), notifications = [];
  try {
    let probes = 0;
    const run = runner(async () => { probes++; return result('down'); }, notifications);
    await run(f.env, SLOT);
    assert.equal(probes, 1);
    assert.deepEqual(notifications, []);
    await Promise.all(Array.from({ length: 4 }, () => run(f.env, SLOT + 60000)));
    assert.equal(probes, 2);
    assert.deepEqual(notifications, ['down']);
    assert.equal((await execution.readMonitorState(f.env, 1)).consecutive_failures, 2);
    assert.equal(f.sqlite.prepare('SELECT slack_alert_ts FROM notification_delivery_state WHERE monitor_id=1').get().slack_alert_ts, 'synthetic-thread');
    assert.equal(f.sqlite.prepare("SELECT count(*) AS n FROM notification_outbox WHERE status='sent'").get().n, 1);
    assert.equal(f.sqlite.prepare('SELECT count(*) AS n FROM checks').get().n, 2);
  } finally { f.close(); }
});

test('slow old recovery cannot overwrite a newer failure and a missing slot breaks its failure streak', async () => {
  const f = sqliteEnv(), notifications = [];
  try {
    await runner(async () => result('down'), notifications)(f.env, SLOT);
    let finish, began;
    const started = new Promise(resolve => { began = resolve; });
    const slow = runner(() => { began(); return new Promise(resolve => { finish = resolve; }); }, notifications)(f.env, SLOT + 60000);
    await started;
    f.sqlite.exec('UPDATE monitor_execution SET lease_until = 0');
    await runner(async () => result('down'), notifications)(f.env, SLOT + 120000);
    finish(result('up'));
    await slow;
    assert.deepEqual(notifications, []);
    assert.equal((await execution.readMonitorState(f.env, 1)).current_status, 'up');
    assert.equal((await execution.readMonitorState(f.env, 1)).consecutive_failures, 1);
    assert.equal((await execution.readMonitorState(f.env, 1)).last_check_slot, SLOT + 120000);
    assert.equal(f.sqlite.prepare('SELECT count(*) AS n FROM checks').get().n, 2);
    await runner(async () => result('down'), notifications)(f.env, SLOT + 180000);
    assert.deepEqual(notifications, ['down']);
  } finally { f.close(); }
});

test('a shadow route records independent state without dispatching public notifications', async () => {
  const f = sqliteEnv(), notifications = [];
  try {
    f.sqlite.exec("UPDATE monitors SET monitor_role='shadow',probe_transport='public_fetch'");
    const run = runner(async () => result('down'), notifications);
    await run(f.env, SLOT);
    await run(f.env, SLOT + 60000);
    assert.deepEqual(notifications, []);
    assert.equal((await execution.readMonitorState(f.env, 1)).current_status, 'down');
    const row = f.sqlite.prepare('SELECT monitor_role,probe_transport FROM checks LIMIT 1').get();
    assert.equal(row.monitor_role, 'shadow');
    assert.equal(row.probe_transport, 'public_fetch');
  } finally { f.close(); }
});

test('a stalled internal diagnostic does not hold public check persistence', { timeout: 2000 }, async () => {
  const f = sqliteEnv(), notifications = [];
  try {
    f.sqlite.exec("INSERT INTO monitors(id,name,url,created_at,monitor_role) VALUES (2,'Internal','https://example.invalid/healthz',0,'diagnostic')");
    let finishDiagnostic, publicCommitted;
    const committed = new Promise(resolve => { publicCommitted = resolve; });
    const actualBatch = f.env.DB.batch;
    f.env.DB.batch = async statements => {
      const records = await actualBatch(statements);
      if (statements.some(statement => /INSERT INTO checks/.test(statement.query) && statement.args[0] === 1)) publicCommitted();
      return records;
    };
    const pending = runner(async (_env, monitor) => monitor.id === 2
      ? new Promise(resolve => { finishDiagnostic = resolve; }) : result('up'), notifications)(f.env, SLOT);
    await committed;
    assert.equal(f.sqlite.prepare('SELECT count(*) AS n FROM checks WHERE monitor_id=1').get().n, 1);
    assert.equal(f.sqlite.prepare('SELECT count(*) AS n FROM checks WHERE monitor_id=2').get().n, 0);
    finishDiagnostic(result('down'));
    await pending;
  } finally { f.close(); }
});

test('a diagnostic execution error does not reject or cancel the availability run', async () => {
  const f = sqliteEnv(), notifications = [];
  try {
    f.sqlite.exec("INSERT INTO monitors(id,name,url,created_at,monitor_role) VALUES (2,'Internal','https://example.invalid/healthz',0,'diagnostic')");
    await runner(async (_env, monitor) => {
      if (monitor.id === 2) throw new Error('diagnostic unavailable');
      return result('up');
    }, notifications)(f.env, SLOT);
    assert.equal(f.sqlite.prepare('SELECT count(*) AS n FROM checks WHERE monitor_id=1').get().n, 1);
    assert.equal(f.sqlite.prepare('SELECT lease_until FROM monitor_execution WHERE monitor_id=2').get().lease_until, 0);
  } finally { f.close(); }
});

test('a slow notification cannot hold the next probe lease or overwrite its newer state', async () => {
  const f = sqliteEnv(), notifications = [];
  try {
    await runner(async () => result('down'), notifications)(f.env, SLOT);
    let completeNotification, began;
    const sending = new Promise(resolve => { began = resolve; });
    const old = runner(async () => result('down'), notifications, execution, transition => {
      if (transition.kind !== 'down') return { slackAlertTs:null };
      began();
      return new Promise(resolve => { completeNotification = resolve; });
    })(f.env, SLOT + 60000);
    await sending;
    assert.equal(f.sqlite.prepare('SELECT lease_until FROM monitor_execution WHERE monitor_id=1').get().lease_until, 0);
    await runner(async () => result('up'), notifications)(f.env, SLOT + 120000);
    assert.equal((await execution.readMonitorState(f.env, 1)).last_check_slot, SLOT + 120000);
    assert.equal((await execution.readMonitorState(f.env, 1)).current_status, 'up');
    assert.equal(f.sqlite.prepare("SELECT count(*) AS n FROM notification_outbox WHERE status='pending'").get().n, 1);
    completeNotification({ slackAlertTs: 'old-down-thread' });
    await old;
    assert.deepEqual(notifications, ['down', 'up']);
    assert.equal(f.sqlite.prepare("SELECT count(*) AS n FROM notification_outbox WHERE status='sent'").get().n, 2);
    assert.equal((await execution.readMonitorState(f.env, 1)).current_status, 'up');
  } finally { f.close(); }
});

test('unknown commit response is not retried and cannot emit a duplicate notification', async () => {
  const f = sqliteEnv(), notifications = [];
  try {
    const actualBatch = f.env.DB.batch;
    let probes = 0;
    f.env.DB.batch = async statements => {
      const response = await actualBatch(statements);
      if (statements.some(statement => /INSERT INTO checks/.test(statement.query))) {
        throw new Error('synthetic response loss after commit');
      }
      return response;
    };
    const run = runner(async () => { probes++; return result('down'); }, notifications);
    await assert.rejects(() => run(f.env, SLOT), /response loss/);
    f.env.DB.batch = actualBatch;
    await run(f.env, SLOT);
    assert.equal(probes, 1);
    assert.deepEqual(notifications, []);
    assert.equal(f.sqlite.prepare('SELECT count(*) AS n FROM checks').get().n, 1);
    await run(f.env, SLOT + 60000);
    assert.deepEqual(notifications, ['down']);
  } finally { f.close(); }
});

test('a stalled failure audit cannot postpone releasing the probe or block the next scheduled claim', {timeout:8000},async()=>{
  const f=sqliteEnv(),notifications=[];
  try {
    const prepare=f.env.DB.prepare;
    let began;
    const auditing=new Promise(resolve=>{began=resolve;});
    f.env.DB.prepare=query=>{
      const statement=prepare(query);
      if (!/released_at=COALESCE/.test(query)) return statement;
      const stalled=bound=>({...bound,bind(...args){return stalled(bound.bind(...args));},
        async run(){began();return new Promise(()=>{});}});
      return stalled(statement);
    };
    const failed=runner(async()=>{throw new Error('synthetic probe failure');},notifications)(f.env,SLOT)
      .then(()=>null,error=>error);
    await auditing;
    assert.equal(f.sqlite.prepare('SELECT lease_until FROM monitor_execution WHERE monitor_id=1').get().lease_until,0);
    assert.ok(await execution.claimMonitorSlot(f.env,1,SLOT+60000));
    const error=await failed;
    assert.match(error.message,/synthetic probe failure/);
    assert.equal(f.sqlite.prepare('SELECT count(*) AS n FROM checks').get().n,0);
  } finally {f.close();}
});
