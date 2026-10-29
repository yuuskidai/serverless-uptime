import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTs } from './helpers.mjs';

test('security administration bypasses monitor D1 while preserving the retired receiver path',async()=>{
  let securityCalls=0;
  const forbidden=()=>{throw Error('Security route touched monitor D1/schema');};
  const {default:handler}=loadTs('index',{
    './security-integration':{async handleSecurityAdminRequest(){securityCalls++;return new Response('safe',{status:202});}},
    './security-notifications-entrypoint':{},'./api':{},'./edge-cache':{},'./incident-page':{},
    './rca':{},'./rss-feed':{},'./status-page':{},'./slack-bot':{},'./monitor':{},
    './monitor-runner':{},'./notification-outbox':{},'./scheduled-runs':{},
    './monitor-readiness':{},'./schema-gate':{ensureSchema:forbidden},
  });
  for(const path of ['/api/security','/api/security/status','/api/security/start']) {
    assert.equal((await handler.fetch(new Request('https://monitor.invalid'+path),{DB:{prepare:forbidden}},{})).status,202);
  }
  assert.equal(securityCalls,3);
  assert.equal((await handler.fetch(new Request('https://monitor.invalid/api/external-observations',{method:'POST'}),{},{})).status,410);
  assert.equal(securityCalls,3);
});
