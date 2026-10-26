import { WorkerEntrypoint } from 'cloudflare:workers';
import type { Env } from './types';
import { SINGLETON } from './types';
import { appEvent, equalSecret } from './validation';
import type { SecurityHub } from './hub';
export { SecurityHub } from './hub';
function hub(env: Env) { return env.SECURITY_HUB.get(env.SECURITY_HUB.idFromName(SINGLETON), {locationHint:'apac'}) as unknown as SecurityHub; }
export class CoreSecurityEvents extends WorkerEntrypoint<Env> {
  async record(input: unknown) { const value = appEvent(input, Date.now()); return value ? hub(this.env).recordApp('core', value) : {accepted:false,reason:'invalid'}; }
}
export class PortalSecurityEvents extends WorkerEntrypoint<Env> {
  async record(input: unknown) { const value = appEvent(input, Date.now()); return value ? hub(this.env).recordApp('portal', value) : {accepted:false,reason:'invalid'}; }
}
export function json(value: unknown, status = 200) { return Response.json(value, {status, headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'none'; frame-ancestors 'none'"}}); }
async function emptyBody(request: Request) {
  if (request.headers.has('content-length') && request.headers.get('content-length') !== '0') return false;
  if (!request.body) return true;
  const reader = request.body.getReader(), deadline = performance.now()+250; let timer: ReturnType<typeof setTimeout> | undefined;
  try {return await Promise.race([reader.read().then(v => v.done && performance.now()<deadline),new Promise<boolean>(resolve=>{timer=setTimeout(()=>resolve(false),250);})]);}
  finally {if(timer!==undefined)clearTimeout(timer);void reader.cancel().catch(()=>undefined);}
}
export default {
  async fetch(request: Request, env: Env) {
    const url = new URL(request.url);
    if (url.search) return json({error:'not_found'},404);
    if (request.method==='GET' && url.pathname==='/healthz') return json({status:'ok',scope:'worker_liveness',service:'helth-security'});
    const control=request.method==='POST' && ['/admin/start','/admin/stop','/admin/acknowledge'].includes(url.pathname);
    const status=request.method==='GET' && url.pathname==='/admin/status';
    if(!control&&!status)return json({error:'not_found'},404);
    const authorization=request.headers.get('authorization');
    if(!authorization?.startsWith('Bearer ')||!await equalSecret(authorization.slice(7),env.ADMIN_SECRET))return json({error:'unauthorised'},401);
    if(control&&!await emptyBody(request))return json({error:'body_not_allowed'},400);
    const stub=hub(env);
    return json(status?await stub.status():url.pathname==='/admin/start'?await stub.start():url.pathname==='/admin/acknowledge'?await stub.acknowledge():await stub.stop());
  },
} satisfies ExportedHandler<Env>;
