import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { handleApiRequest } from '../src/api.ts';
function fixture(){
 const sql=new DatabaseSync(':memory:');sql.exec(readFileSync(new URL('../schema.sql',import.meta.url),'utf8'));
 const DB={prepare(query){let args=[];return {bind(...values){args=values;return this;},async run(){const r=sql.prepare(query).run(...args);return {meta:{last_row_id:Number(r.lastInsertRowid),changes:Number(r.changes)}};},async first(){return sql.prepare(query).get(...args)??null;},async all(){return {results:sql.prepare(query).all(...args)};}};}};
 const env={DB,API_TOKEN:'synthetic-local-token'};
 return {sql,env,request:(method,body,path='/api/monitors')=>handleApiRequest(new Request('https://monitor.invalid'+path,{method,headers:{Authorization:'Bearer synthetic-local-token','Content-Type':'application/json'},body:JSON.stringify(body)}),env)};
}
test('legacy threshold writes only the DB threshold and leaves HTTP opt-in disabled',async()=>{
 const f=fixture();try{const response=await f.request('POST',{name:'Synthetic',url:'https://target.invalid',latency_threshold_ms:1000});assert.equal(response.status,201);
 const row=f.sql.prepare('SELECT * FROM monitors').get();assert.equal(row.db_latency_threshold_ms,1000);assert.equal(row.http_latency_threshold_ms,null);
 assert.equal((await f.request('PATCH',{db_latency_threshold_ms:null},'/api/monitors/1')).status,200);
 const cleared=f.sql.prepare('SELECT * FROM monitors').get();assert.equal(cleared.db_latency_threshold_ms,null);assert.equal(cleared.latency_threshold_ms,null);
 }finally{f.sql.close();}
});
test('new HTTP and DB thresholds are stored independently',async()=>{
 const f=fixture();try{assert.equal((await f.request('POST',{name:'Synthetic',url:'https://target.invalid',db_latency_threshold_ms:1200,http_latency_threshold_ms:3000})).status,201);
 const row=f.sql.prepare('SELECT * FROM monitors').get();assert.equal(row.db_latency_threshold_ms,1200);assert.equal(row.http_latency_threshold_ms,3000);
 assert.equal((await f.request('PATCH',{http_latency_threshold_ms:null},'/api/monitors/1')).status,200);
 const cleared=f.sql.prepare('SELECT * FROM monitors').get();assert.equal(cleared.db_latency_threshold_ms,1200);assert.equal(cleared.http_latency_threshold_ms,null);
 }finally{f.sql.close();}
});
test('conflicting DB alias, fractional, malformed and unsafe values are rejected without writes',async()=>{
 const f=fixture();try{for(const extra of [{latency_threshold_ms:1000,db_latency_threshold_ms:900},{db_latency_threshold_ms:0.5},{http_latency_threshold_ms:'1000oops'},{db_latency_threshold_ms:Number.MAX_SAFE_INTEGER+1}]){
 const response=await f.request('POST',{name:'Synthetic',url:'https://target.invalid',...extra});assert.equal(response.status,400);
 }assert.equal(f.sql.prepare('SELECT COUNT(*) AS n FROM monitors').get().n,0);}finally{f.sql.close();}
});
