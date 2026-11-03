import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
const require=createRequire(new URL('../../kuma-lite/package.json',import.meta.url));
const {buildSync}=createRequire(require.resolve('wrangler/package.json'))('esbuild');
const bundle=buildSync({stdin:{contents:`export {appendWafRuleWindow,summarizeWafRules} from './src/waf-rule-counts.ts';`,resolveDir:fileURLToPath(new URL('../',import.meta.url)),sourcefile:'waf-rules-fixture.js'},bundle:true,format:'esm',platform:'browser',write:false}).outputFiles[0].text;
const {appendWafRuleWindow:append,summarizeWafRules:summary}=await import('data:text/javascript;base64,'+Buffer.from(bundle).toString('base64'));
const one=(id,count,description)=>({ruleId:id,count,...(description?{description}:{})});
const breakdown=(rules,extra={})=>({rules,otherCount:0,unknownCount:0,limited:false,...extra});
const sum=s=>s.rules.reduce((n,r)=>n+r.count,0)+s.otherCount+s.unknownCount;

test('successive polls retain same-window rule counts without assigning the cumulative total to the last rule',()=>{
  const first=append(undefined,1000,0,3,breakdown([one('A',3,'React RCE')]));
  const next=append(first,1000,3,5,breakdown([one('B',5,'Other managed rule')]));
  assert.equal(next.count,8);assert.equal(sum(next.breakdown),8);
  assert.deepEqual(summary(next),breakdown([one('B',5,'Other managed rule'),one('A',3,'React RCE')]));
  assert.deepEqual(first.breakdown.rules,[one('A',3,'React RCE')]);
});

test('a reset or missing old metadata becomes a new window or explicit unknown rather than a false attribution',()=>{
  const old=append(undefined,1000,0,4,breakdown([one('old',4)]));
  assert.deepEqual(append(old,301000,0,2,breakdown([one('new',2)])).breakdown,breakdown([one('new',2)]));
  const legacy=append(undefined,1000,7,2,breakdown([one('new',2)]));
  assert.deepEqual(legacy.breakdown,breakdown([one('new',2)],{unknownCount:7}));
  const olderWriter=append(old,1000,9,2,breakdown([one('new',2)]));
  assert.equal(olderWriter.breakdown.unknownCount,5);assert.equal(sum(olderWriter.breakdown),11);
});

test('only three rows are displayed while the omitted records still match the complete observed count',()=>{
  const rules=Array.from({length:6},(_,i)=>one(`rule-${i}`,i+1));
  const state=append(undefined,1000,0,21,breakdown(rules));
  const view=summary(state);
  assert.deepEqual(view.rules.map(r=>r.ruleId),['rule-5','rule-4','rule-3']);
  assert.equal(view.otherCount,6);assert.equal(sum(view),21);assert.equal(view.limited,false);
});

test('retention and query limits preserve accounting and make no complete ranking claim',()=>{
  let state=append(undefined,1000,0,32,breakdown(Array.from({length:32},(_,i)=>one(`rule-${i}`,1))));
  state=append(state,1000,32,2,breakdown([one('new',2)]));
  assert.equal(state.breakdown.rules.length,32);assert.equal(state.breakdown.otherCount,2);assert.equal(state.breakdown.limited,true);
  assert.equal(sum(summary(state)),34);
  const sampled=append(undefined,1000,0,1000,breakdown([one('kept',3)],{otherCount:996,unknownCount:1,limited:true}));
  assert.equal(sum(summary(sampled)),1000);assert.equal(summary(sampled).limited,true);
});

test('opaque prototype-like IDs do not corrupt maps and a missing description is filled safely',()=>{
  const state=append(undefined,1000,0,2,breakdown([one('__proto__',1),one('constructor',1)]));
  const next=append(state,1000,2,2,breakdown([one('__proto__',1,'First safe name'),one('constructor',1)]));
  assert.equal(next.breakdown.rules[0].count,2);assert.equal(next.breakdown.rules[0].description,'First safe name');
  const renamed=append(next,1000,4,1,breakdown([one('__proto__',1,'Later name')]));
  assert.equal(renamed.breakdown.rules[0].description,'First safe name');assert.equal(sum(renamed.breakdown),5);
});

test('malformed persisted or incoming metadata is accounted as unknown and cannot poison the outgoing DTO',()=>{
  for(const bad of [undefined,breakdown([one('x',2)]),breakdown([one('x',1)],{extra:'not allowed'}),
    breakdown([{...one('x',1),url:'https://example.invalid'}]),breakdown([one('x',1,'unsafe\u2028name')]),
    breakdown([one('x',1,'lone\ud800')]),breakdown([one('x',1,'bidi\u202e')]),breakdown([one('x',1,'   ')])]){
    const state=append(undefined,1000,0,1,bad);assert.equal(state.breakdown.unknownCount,1);assert.equal(sum(summary(state)),1);
  }
  const malformed={start:1000,count:5,breakdown:breakdown([one('bad',99)])};
  const state=append(malformed,1000,5,1,breakdown([one('good',1)]));
  assert.equal(state.breakdown.unknownCount,5);assert.equal(sum(summary(state)),6);
});

test('the existing count ceiling does not create a rule count larger than the alert total',()=>{
  const state=append(undefined,1000,999999999,5,breakdown([one('new',5)]));
  assert.equal(state.count,1000000000);assert.equal(sum(summary(state)),1000000000);assert.equal(state.breakdown.limited,true);
});
