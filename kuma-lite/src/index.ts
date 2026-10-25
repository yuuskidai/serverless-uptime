import { handleApiRequest } from './api';
import { withEdgeCache } from './edge-cache';
import { renderIncidentPage } from './incident-page';
import { handleRcaBatch, type RcaJob } from './rca';
import { cleanupOldChecks } from './monitor';
import { runChecks } from './monitor-runner';
import { monitoringReadiness } from './monitor-readiness';
import { renderRssFeed } from './rss-feed';
import {
  apiSchemaErrorResponse,
  ensureSchema,
  logSchemaProblem,
  publicSchemaErrorResponse,
} from './schema-gate';
import { renderStatusPage } from './status-page';
import { buildSlackBot } from './slack-bot';
import type { Env } from './types';

export type { Env };

export default {
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    const receivedAt = Date.now();
    // The separate minute trigger still handles the 03:00 check. The daily
    // trigger must not fall through and create another probe for that slot.
    if (event.cron === '0 3 * * *') {
      ctx.waitUntil((async () => {
        const check = await ensureSchema(env);
        if (!check.ok) {
          logSchemaProblem(check, 'scheduled cleanup');
          return;
        }
        await cleanupOldChecks(env);
      })());
      return;
    }
    // The minute cron writes to `checks` and `monitor_state` using
    // the latest column set; if the migration hasn't been applied,
    // we'd corrupt the run for every monitor. Skip the tick instead
    // and surface the cause to Workers Logs so the operator can
    // apply the migration without combing through D1 errors.
    ctx.waitUntil(
      (async () => {
        const schemaStarted = Date.now();
        const check = await ensureSchema(env);
        const schemaMs = Math.max(0, Date.now() - schemaStarted);
        if (!check.ok) {
          logSchemaProblem(check, 'scheduled cron');
          return;
        }
        // Preserve the existing five-second scheduling offset. This is
        // not mutual exclusion: D1 slot claims and leases prevent overlap.
        const offsetStarted = Date.now();
        await new Promise((resolve) => setTimeout(resolve, 5_000));
        await runChecks(env, event.scheduledTime, { receivedAt, schemaMs, offsetMs: Math.max(0, Date.now() - offsetStarted) });
      })(),
    );
  },

  // Consumer for RCA_QUEUE: AI root-cause analysis replies to DOWN/DEGRADED
  // alerts, run off the cron path so probes never wait on the LLM.
  async queue(batch: MessageBatch<RcaJob>, env: Env): Promise<void> {
    await handleRcaBatch(batch, env);
  },

  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);

    // Worker-level liveness — DB-independent on purpose so that a
    // missing/broken D1 doesn't make the worker itself look dead to
    // upstream health checkers.
    if (url.pathname === '/healthz') {
      return new Response('ok', { status: 200 });
    }
    if (url.pathname === '/readyz') return monitoringReadiness(env);

    // Every other path eventually queries D1. Run the schema gate
    // once per isolate; on miss, return a friendly 503 with a
    // human-readable reason and log the implementation detail to
    // Workers Logs for the operator.
    const schema = await ensureSchema(env);
    if (!schema.ok) {
      logSchemaProblem(schema, `fetch ${url.pathname}`);
      if (url.pathname.startsWith('/api/')) return apiSchemaErrorResponse();
      return publicSchemaErrorResponse();
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
      return withEdgeCache(req, ctx, () => renderStatusPage(env, url));
    }

    if (url.pathname === '/incident') {
      return withEdgeCache(req, ctx, () => renderIncidentPage(env, url));
    }

    if (url.pathname === '/rss.xml' || url.pathname === '/feed') {
      return withEdgeCache(req, ctx, () => renderRssFeed(env, url));
    }

    return new Response('Not found', { status: 404 });
  },
};
