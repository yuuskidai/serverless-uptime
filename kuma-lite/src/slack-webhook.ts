import type { Env } from './types';
import { buildSlackBot } from './slack-bot';
import { admitSlackWebhook } from './chat-adapters/slack/signing';
import { ensureSchema, logSchemaProblem, publicSchemaErrorResponse } from './schema-gate';

/** Admission runs before SDK initialization or D1 work; unsigned traffic is cheap. */
export async function handleSlackWebhook(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  if (!env.SLACK_SIGNING_SECRET || !env.SLACK_BOT_TOKEN) return new Response('slack_not_configured', { status: 503 });
  const admission = await admitSlackWebhook(request, env.SLACK_SIGNING_SECRET);
  if (!admission.ok) {
    // Retain a finite rejection signal without logging bodies or signature data.
    console.warn({ event: 'slack_webhook_rejected', status: admission.response.status });
    return admission.response;
  }
  const schema = await ensureSchema(env);
  if (!schema.ok) {
    logSchemaProblem(schema, 'fetch /slack/events');
    return publicSchemaErrorResponse();
  }
  const bot = buildSlackBot(env);
  if (!bot) return new Response('slack_not_configured', { status: 503 });
  return bot.chat.webhooks.slack(admission.request, { waitUntil: task => ctx.waitUntil(task) });
}
