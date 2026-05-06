import { handleApiRequest } from './api';
import { cleanupOldChecks, runChecks } from './monitor';
import { renderStatusPage } from './status-page';
import type { Env } from './types';

export type { Env };

export default {
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    if (event.cron === '0 3 * * *') {
      ctx.waitUntil(cleanupOldChecks(env));
    } else {
      ctx.waitUntil(runChecks(env));
    }
  },

  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === '/healthz') {
      return new Response('ok', { status: 200 });
    }

    if (url.pathname.startsWith('/api/')) {
      return handleApiRequest(req, env);
    }

    if (url.pathname === '/' || url.pathname === '/status') {
      return renderStatusPage(env);
    }

    return new Response('Not found', { status: 404 });
  },
};
