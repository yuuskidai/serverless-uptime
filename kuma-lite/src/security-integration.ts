import { SecurityHub as ExistingSecurityHub } from '../../security-alerts/src/hub';
import { json } from '../../security-alerts/src/index';
import { SINGLETON } from '../../security-alerts/src/types';
import { authorize } from './api';
import { deliverSecurityAlert } from './security-notifications';
import type { Env } from './types';

// Preserve fixed app identities and the existing record DTO; HTTP never accepts app events.
export { CoreSecurityEvents, PortalSecurityEvents } from '../../security-alerts/src/index';

/** Same exported DO class name and storage implementation; only the delivery transport is local. */
export class SecurityHub extends ExistingSecurityHub {
  constructor(ctx: DurableObjectState, env: Env) {
    if (!env.SECURITY_HUB) throw new Error('security_hub_not_configured');
    super(ctx, {
      SECURITY_HUB: env.SECURITY_HUB,
      CF_ANALYTICS_TOKEN: env.CF_ANALYTICS_TOKEN,
      VERSION_METADATA: env.VERSION_METADATA,
      // Keep the existing stable alert id, validation and delivery result inside the original outbox fence.
      SLACK_NOTIFIER: { sendSecurityAlert: alert => deliverSecurityAlert(env, alert) },
    });
  }
}

async function emptyBody(request: Request): Promise<boolean> {
  if (request.headers.has('content-length') && request.headers.get('content-length') !== '0') return false;
  if (!request.body) return true;
  const reader = request.body.getReader(), deadline = performance.now() + 250;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([reader.read().then(value => value.done && performance.now() < deadline),
      new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), 250); })]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    void reader.cancel().catch(() => undefined);
  }
}

/** API_TOKEN replaces the old Worker's administrative secret; all hub responses stay unchanged. */
export async function handleSecurityAdminRequest(request: Request, env: Env): Promise<Response> {
  if (!authorize(request, env)) return json({ error: 'unauthorized' }, 401);
  const url = new URL(request.url);
  if (url.search) return json({ error: 'not_found' }, 404);
  const status = request.method === 'GET' && url.pathname === '/api/security/status';
  const action = request.method === 'POST' && ['/api/security/start', '/api/security/stop', '/api/security/acknowledge'].includes(url.pathname);
  if (!status && !action) return json({ error: 'not_found' }, 404);
  if (!env.SECURITY_HUB) return json({ error: 'security_hub_not_configured' }, 503);
  if (action && !await emptyBody(request)) return json({ error: 'body_not_allowed' }, 400);
  try {
    const stub = env.SECURITY_HUB.get(env.SECURITY_HUB.idFromName(SINGLETON), { locationHint: 'apac' });
    return json(status ? await stub.status() : url.pathname === '/api/security/start' ? await stub.start() :
      url.pathname === '/api/security/acknowledge' ? await stub.acknowledge() : await stub.stop());
  } catch { return json({ error: 'security_unavailable' }, 503); }
}
