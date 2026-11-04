import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { loadTs } from './helpers.mjs';
const require = createRequire(import.meta.url);
const { buildSync } = createRequire(require.resolve('wrangler/package.json'))('esbuild');
const script = buildSync({ stdin: { contents: "export {withEdgeCache} from './src/edge-cache.ts';", resolveDir: fileURLToPath(new URL('../', import.meta.url)) },
  bundle: true, format: 'esm', platform: 'node', write: false }).outputFiles[0].text;
const { withEdgeCache } = await import('data:text/javascript;base64,' + Buffer.from(script).toString('base64'));
const { publicMonitorCacheScope } = loadTs('public-monitor-visibility');

test('public cache keys isolate old responses, deployments and hidden-monitor settings', async t => {
  const responses = new Map(), writes = [];
  const original = Object.getOwnPropertyDescriptor(globalThis, 'caches');
  Object.defineProperty(globalThis, 'caches', { configurable: true, value: { default: {
    async match(request) { return responses.get(request.url)?.clone(); },
    async put(request, response) { responses.set(request.url, response); writes.push(request.url); },
  } } });
  t.after(() => { if (original) Object.defineProperty(globalThis, 'caches', original); else delete globalThis.caches; });
  const req = new Request('https://status.example.invalid/status?__monitor_public_scope=caller-chosen');
  responses.set(req.url, new Response('old synthetic private information'));
  const tasks = [], ctx = { waitUntil(task) { tasks.push(task); } };
  const firstScope = await publicMonitorCacheScope({ HIDDEN_MONITOR_IDS: '', VERSION_METADATA: { id: 'synthetic-version-1' } });
  const hiddenScope = await publicMonitorCacheScope({ HIDDEN_MONITOR_IDS: '2', VERSION_METADATA: { id: 'synthetic-version-1' } });
  const nextScope = await publicMonitorCacheScope({ HIDDEN_MONITOR_IDS: '2', VERSION_METADATA: { id: 'synthetic-version-2' } });
  assert.notEqual(firstScope, hiddenScope); assert.notEqual(hiddenScope, nextScope);
  assert.equal(hiddenScope, await publicMonitorCacheScope({ HIDDEN_MONITOR_IDS: '2, 2', VERSION_METADATA: { id: 'synthetic-version-1' } }));
  let renders = 0;
  const produce = async () => { renders++; return new Response('safe visible service', { headers: { 'Cache-Control': 'public,max-age=15' } }); };
  const first = await withEdgeCache(req, ctx, produce, firstScope);
  assert.equal(first.headers.get('CF-Worker-Cache'), 'MISS'); assert.equal(await first.text(), 'safe visible service'); await Promise.all(tasks);
  const hit = await withEdgeCache(req, ctx, produce, firstScope);
  assert.equal(hit.headers.get('CF-Worker-Cache'), 'HIT'); assert.equal(renders, 1);
  const privateResponse = await withEdgeCache(req, ctx, async () => new Response('not found', { status: 404 }), hiddenScope);
  assert.equal(privateResponse.status, 404); assert.equal(writes.length, 1);
  assert.equal(new URL(writes[0]).searchParams.get('__monitor_public_scope'), firstScope);
  assert.equal((await withEdgeCache(req, ctx, produce, nextScope)).headers.get('CF-Worker-Cache'), 'MISS'); await Promise.all(tasks);
});
