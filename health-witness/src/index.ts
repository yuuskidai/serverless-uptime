import type { Env, Version } from './types';
export { ProbeScheduler } from './scheduler';

export const SINGLETON = 'fixed-public-health-v1';
export function isRetired(env: Env): boolean { return env.RETIRED === 'true'; }
export function version(env: Env): Version {
  const clean = (value: unknown) => typeof value === 'string' && /^[A-Za-z0-9._:+-]{1,128}$/.test(value) ? value : null;
  return { id: clean(env.VERSION_METADATA?.id), tag: clean(env.VERSION_METADATA?.tag), timestamp: clean(env.VERSION_METADATA?.timestamp) };
}
export function json(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: {
    'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
  } });
}
async function authorised(request: Request, env: Env): Promise<boolean> {
  const secret = env.ADMIN_SECRET;
  if (!secret || !/^(?:[a-fA-F0-9]{64}|[A-Za-z0-9_-]{43})$/.test(secret)) return false;
  const supplied = request.headers.get('authorization') ?? '';
  if (supplied.length > 128) return false;
  const bytes = new TextEncoder();
  const [actual, expected] = await Promise.all([supplied, `Bearer ${secret}`].map(value => crypto.subtle.digest('SHA-256', bytes.encode(value))));
  const a = new Uint8Array(actual), b = new Uint8Array(expected);
  let different = 0;
  for (let i = 0; i < a.length; i++) different |= a[i] ^ b[i];
  return different === 0;
}
async function emptyBody(request: Request): Promise<boolean> {
  const declared = request.headers.get('content-length');
  if (declared !== null && declared !== '0') return false;
  if (request.body === null) return true;
  const reader = request.body.getReader();
  const deadline = performance.now() + 250;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // A real empty HTTP POST can still expose an empty stream in workerd.
    // Inspect at most its first chunk, with a deadline; never buffer input.
    return await Promise.race([
      reader.read().then(part => part.done === true && performance.now() < deadline),
      new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), 250); }),
    ]);
  } catch { return false; }
  finally { if (timer !== undefined) clearTimeout(timer); void reader.cancel().catch(() => undefined); }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.search) return json({ error: 'not_found' }, 404);
    if (request.method === 'GET' && url.pathname === '/healthz') {
      return json({ status: 'ok', scope: 'worker_liveness', service: 'helth-witness', version: version(env),
        ...(isRetired(env) ? { retired: true } : {}) });
    }
    const isStatus = request.method === 'GET' && ['/status', '/latest'].includes(url.pathname);
    const isAdmin = request.method === 'POST' && ['/admin/start', '/admin/stop'].includes(url.pathname);
    if (!isStatus && !isAdmin) return json({ error: 'not_found' }, 404);
    // Retirement must never restart probing or invoke the old generation-changing stop control.
    if (isAdmin && isRetired(env)) return json({ error: 'witness_retired' }, 410);
    if (isAdmin && !await authorised(request, env)) return json({ error: 'unauthorised' }, 401);
    // These controls accept no body, target, interval, URL, object name or other parameters.
    if (isAdmin && !await emptyBody(request)) return json({ error: 'body_not_allowed' }, 400);
    // Best-effort first placement hint only; this does not guarantee Japan/APAC execution.
    const stub = env.SCHEDULER.get(env.SCHEDULER.idFromName(SINGLETON), { locationHint: 'apac' });
    // Do not forward the administrative bearer (or any public headers) to the object.
    return stub.fetch(new Request(`https://scheduler.invalid${url.pathname}`, { method: request.method }));
  },
} satisfies ExportedHandler<Env>;
