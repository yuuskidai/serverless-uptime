import { handleApiRequest } from './api';
import { withEdgeCache } from './edge-cache';
import { renderIncidentPage } from './incident-page';
import { handleRcaBatch, type RcaJob } from './rca';
import { cleanupOldChecks } from './monitor';
import { runChecks } from './monitor-runner';
import { monitoringReadiness } from './monitor-readiness';
import { drainNotificationOutbox } from './notification-outbox';
import { beginScheduledRun, advanceScheduledRun, finishScheduledRun } from './scheduled-runs';
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
export { SecurityNotifications } from './security-notifications-entrypoint';

const SCHEDULED_OFFSET_MS = 5_000;

/** Align to the original schedule rather than adding another delay on receipt.
 * An invalid/future provider timestamp keeps the former bounded wait. */
export function scheduledOffsetWaitMs(scheduledTime: number, now: number, receivedAt = now): number {
  if (!Number.isSafeInteger(scheduledTime) || scheduledTime < 0 || scheduledTime > receivedAt) {
    console.error({ event: 'scheduled_time_anomaly', scheduled_time: scheduledTime, received_at: receivedAt });
    return SCHEDULED_OFFSET_MS;
  }
  return Math.max(0, Math.min(SCHEDULED_OFFSET_MS, SCHEDULED_OFFSET_MS - (now - scheduledTime)));
}

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
        const run = await beginScheduledRun(env, event.cron, event.scheduledTime, receivedAt);
        const timings: Record<string, number> = {};
        let phase = 'schema';
        try {
          const schemaStarted = Date.now();
          const check = await ensureSchema(env);
          timings.schema_ms = Math.max(0, Date.now() - schemaStarted);
          if (!check.ok) {
            logSchemaProblem(check, 'scheduled cron');
            const reason = check.reason ?? 'schema_missing';
            await finishScheduledRun(env, run, reason === 'schema_missing' ? 'schema_missing' : 'failed',
              reason === 'schema_missing' ? phase : reason, timings);
            return;
          }
          // Claim each monitor before waiting so a late older invocation cannot
          // take its lease while an earlier-received newer slot waits here.
          // The original schedule still sets the probe floor; late events add no wait.
          const offsetStarted = Date.now();
          const probeNotBeforeMs = offsetStarted + scheduledOffsetWaitMs(event.scheduledTime, offsetStarted, receivedAt);
          phase = 'checks';
          await advanceScheduledRun(env, run, 'checks', timings);
          const backlog = drainNotificationOutbox(env).catch(() => {
            console.error({ event: 'notification_outbox_backlog_unconfirmed', run_id: run.runId });
          });
          try {
            await runChecks(env, event.scheduledTime, { receivedAt, runId: run.runId,
              schemaMs: timings.schema_ms, probeNotBeforeMs });
          } finally { await backlog; }
          await finishScheduledRun(env, run, 'completed', null, timings);
        } catch (error) {
          await finishScheduledRun(env, run, 'failed', phase, timings);
          throw error;
        }
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
    // Supplemental probes are retired; reject late deliveries before reading a body or D1.
    // The authenticated GET below remains available for retained observation history.
    if (url.pathname === '/api/external-observations' && req.method !== 'GET') {
      return Response.json({ error: 'external_monitoring_retired' }, { status: 410,
        headers: { 'Cache-Control': 'no-store' } });
    }

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
