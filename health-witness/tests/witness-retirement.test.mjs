import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(new URL('../../kuma-lite/package.json', import.meta.url));
const wranglerRequire = createRequire(require.resolve('wrangler/package.json'));
const { Miniflare, convertV4MiniflareOptions } = wranglerRequire('miniflare');
const { build } = wranglerRequire('esbuild');
const bundle = (await build({ stdin: {
  contents: `import handler from './src/index.ts';
    import { ProbeScheduler } from './src/scheduler.ts';
    import { probeCalls } from './src/probe.ts';
    console.info=console.log=console.warn=console.error=()=>{};
    export default handler;
    export class TestScheduler extends ProbeScheduler {
      async testSeed(activePresent=false) {
        const slot=Math.floor(Date.now()/60000)*60000-60000;
        const control={enabled:true,generation:7,next_slot:Date.now()+3600000,
          last_claimed_slot:slot,active:activePresent?{slot,generation:7,token:crypto.randomUUID(),lease_until:Date.now()+30000}:null};
        const history=[{slot:slot-60000,generation:7,attempt_id:crypto.randomUUID(),phase:'completed',
          completed_at:slot-50000,probe_started_at:slot-59000,probe_finished_at:slot-58000,
          alarm_received_at:slot-60000,alarm_lateness_ms:0,alarm_retry_count:0,
          version:{id:null,tag:null,timestamp:null},targets:[]}];
        await this.ctx.storage.transaction(async tx=>{
          await tx.put('control',control);await tx.put('history',history);
          await tx.put('fixture_original',{control,history});await tx.setAlarm(control.next_slot);
        });
      }
      async testInvokeAlarm(){await this.alarm({isRetry:true,retryCount:1});}
      async testLateFinish(){
        const original=await this.ctx.storage.get('fixture_original');
        await this.finish(original.control.active,[],'completed',Date.now(),Date.now());
      }
      async testEvidence(){
        const control=await this.ctx.storage.get('control'),history=await this.ctx.storage.get('history');
        const original=await this.ctx.storage.get('fixture_original');
        return {control_exists:control!==undefined,history_exists:history!==undefined,
          enabled:control?.enabled??false,next_slot:control?.next_slot??null,
          alarm_present:(await this.ctx.storage.getAlarm())!==null,probe_calls:probeCalls,
          generation_unchanged:!original||control.generation===original.control.generation,
          active_unchanged:!original||JSON.stringify(control.active)===JSON.stringify(original.control.active),
          watermark_unchanged:!original||control.last_claimed_slot===original.control.last_claimed_slot,
          history_unchanged:!original||JSON.stringify(history)===JSON.stringify(original.history)};
      }
    }`, resolveDir: fileURLToPath(new URL('../', import.meta.url)), sourcefile: 'local-retirement-fixture.js',
  }, bundle: true, format: 'esm', platform: 'browser', external: ['cloudflare:workers'], write: false,
  plugins: [{ name: 'no-probe-retirement-fixture', setup(builder) {
    builder.onLoad({filter:/[\\/]src[\\/]probe\.ts$/},()=>({contents:
      "export let probeCalls=0;export const TARGETS=[];export async function checkTargets(){probeCalls++;throw Error('Retired branch invoked probe');}"}));
  } }],
})).outputFiles[0].text;

test('retired native Durable Object preserves history and ownership without probes', async t => {
  let outbound=0;
  const mf=new Miniflare(convertV4MiniflareOptions({workers:[{
    name:'retirement-test',script:bundle,modules:true,compatibilityDate:'2025-01-01',
    bindings:{RETIRED:'true'},durableObjects:{SCHEDULER:{className:'TestScheduler',useSQLite:true}},
    outboundService:async()=>{outbound++;throw Error('Unexpected retired outbound');},
  }]}));
  t.after(()=>mf.dispose());
  const worker=await mf.getWorker('retirement-test');
  const namespace=await mf.getDurableObjectNamespace('SCHEDULER','retirement-test');
  const stub=namespace.get(namespace.idFromName('fixed-public-health-v1'));
  const call=path=>worker.fetch('https://witness.invalid'+path);
  const evidence=()=>stub.testEvidence();
  const preserved=value=>{
    for(const key of ['generation_unchanged','active_unchanged','watermark_unchanged','history_unchanged']) assert.equal(value[key],true,key);
    assert.equal(value.probe_calls,0);assert.equal(outbound,0);
  };

  await t.test('retired GET is safe and does not initialise storage or alarms',async()=>{
    for(const path of ['/status','/latest']){
      const payload=await(await call(path)).json();
      assert.equal(payload.retired,true);assert.equal(payload.enabled,false);
      assert.equal(payload.alarm_present,false);assert.equal(payload.last_observation,null);
      for(const key of ['history','latest','active','attempt_id']) assert.equal(Object.hasOwn(payload,key),false);
    }
    const state=await evidence();assert.equal(state.control_exists,false);assert.equal(state.history_exists,false);preserved(state);
  });

  await t.test('read-only verification reports pending alarm without clearing it',async()=>{
    await stub.testSeed(false);
    const payload=await(await call('/latest')).json();
    assert.equal(payload.enabled,true);assert.equal(payload.alarm_present,true);assert.equal(payload.active_present,false);
    assert.equal(typeof payload.last_observation.observed_at,'number');
    assert.deepEqual(Object.keys(payload.last_observation).sort(),['finished_at','observed_at','slot']);
    const state=await evidence();assert.equal(state.alarm_present,true);preserved(state);
  });

  await t.test('both retired admin paths are410 without touching generation or alarm',async()=>{
    for(const path of ['/admin/start','/admin/stop']){
      assert.equal((await worker.fetch('https://witness.invalid'+path,{method:'POST'})).status,410);
      assert.equal((await stub.fetch(new Request('https://scheduler.invalid'+path,{method:'POST'}))).status,410);
    }
    const state=await evidence();assert.equal(state.enabled,true);assert.equal(state.alarm_present,true);preserved(state);
  });

  await t.test('alarm and repeated retry disable scheduling without probing or resetting history',async()=>{
    for(let i=0;i<2;i++){
      await stub.testInvokeAlarm();
      const state=await evidence();assert.equal(state.enabled,false);assert.equal(state.next_slot,null);assert.equal(state.alarm_present,false);preserved(state);
    }
    const payload=await(await call('/latest')).json();
    assert.equal(payload.next_alarm,null);assert.equal(payload.alarm_at,null);assert.equal(payload.alarm_present,false);
    assert.equal(payload.generation,7);assert.equal(payload.history_count,1);
  });

  await t.test('active ownership remains fenced and is never reported as drained',async()=>{
    await stub.testSeed(true);await stub.testInvokeAlarm();await stub.testLateFinish();
    const state=await evidence();preserved(state);
    const payload=await(await call('/status')).json();
    assert.equal(payload.enabled,false);assert.equal(payload.active_present,true);assert.equal(payload.alarm_present,false);
    assert.equal(Object.hasOwn(payload,'drained'),false);
    for(const key of ['history','latest','active','attempt_id']) assert.equal(Object.hasOwn(payload,key),false);
  });
});
