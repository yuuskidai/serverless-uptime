import { handleApiRequest } from './api';
import { renderIncidentPage } from './incident-page';
import { cleanupOldChecks, runChecks } from './monitor';
import { renderStatusPage } from './status-page';
import { buildSlackBot } from './slack-bot';
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

  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === '/healthz') {
      return new Response('ok', { status: 200 });
    }

    if (url.pathname.startsWith('/api/')) {
      return handleApiRequest(req, env);
    }

    if (url.pathname === '/slack/events') {
      const bot = buildSlackBot(env);
      if (!bot) {
        return new Response('slack_not_configured', { status: 503 });
      }
      return bot.chat.webhooks.slack(req, {
        waitUntil: (task) => ctx.waitUntil(task),
      });
    }

    if (url.pathname === '/' || url.pathname === '/status') {
      return renderStatusPage(env, url);
    }

    if (url.pathname === '/incident') {
      return renderIncidentPage(env, url);
    }

    return new Response('Not found', { status: 404 });
  },
};
