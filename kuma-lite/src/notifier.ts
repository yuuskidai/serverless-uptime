import type { Env, Monitor } from './types';
import { encodeSlackThreadId } from './chat-adapters/slack';
import { buildSlackBot } from './slack-bot';

export interface NotifyDownResult {
  /**
   * Slack message ts of the posted DOWN alert when the Slack post
   * succeeded; null otherwise (Slack disabled, channel missing, post
   * failed). Persisted as `monitor_state.slack_alert_ts` so the matching
   * recovery can be threaded under it.
   */
  slackAlertTs: string | null;
}

export async function notifyDown(
  env: Env,
  monitor: Monitor,
  error: string,
): Promise<NotifyDownResult> {
  const [, slackResult] = await Promise.allSettled([
    sendDiscordDown(env, monitor, error),
    sendSlackDown(env, monitor, error),
  ]);
  const slackAlertTs =
    slackResult.status === 'fulfilled' ? slackResult.value : null;
  return { slackAlertTs };
}

export async function notifyUp(
  env: Env,
  monitor: Monitor,
  downDurationMs: number,
  slackAlertTs: string | null,
): Promise<void> {
  await Promise.allSettled([
    sendDiscordUp(env, monitor, downDurationMs),
    sendSlackUp(env, monitor, downDurationMs, slackAlertTs),
  ]);
}

// ── Discord (unchanged) ─────────────────────────────────────────────────

async function sendDiscordDown(env: Env, monitor: Monitor, error: string): Promise<void> {
  if (!env.DISCORD_WEBHOOK_URL) return;
  await postWebhook(env.DISCORD_WEBHOOK_URL, {
    embeds: [
      {
        title: `🔴 DOWN: ${monitor.name}`,
        description: `${monitor.url}\n\n**Error:** ${truncate(error, 800)}`,
        color: 0xff0000,
        timestamp: new Date().toISOString(),
      },
    ],
  });
}

async function sendDiscordUp(
  env: Env,
  monitor: Monitor,
  downDurationMs: number,
): Promise<void> {
  if (!env.DISCORD_WEBHOOK_URL) return;
  await postWebhook(env.DISCORD_WEBHOOK_URL, {
    embeds: [
      {
        title: `🟢 UP: ${monitor.name}`,
        description: `${monitor.url}\n\n**Recovered after:** ${formatDuration(downDurationMs)}`,
        color: 0x00cc66,
        timestamp: new Date().toISOString(),
      },
    ],
  });
}

async function postWebhook(url: string, payload: unknown): Promise<void> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!response.ok && response.status !== 204) {
    const body = await response.text().catch(() => '');
    throw new Error(`Discord webhook failed: ${response.status} ${body.slice(0, 200)}`);
  }
}

// ── Slack via chat-sdk ──────────────────────────────────────────────────

/**
 * Post the top-level DOWN alert and return its ts. The recovery message
 * later threads under this ts and adds a checkmark reaction to it.
 */
async function sendSlackDown(
  env: Env,
  monitor: Monitor,
  error: string,
): Promise<string | null> {
  const bot = buildSlackBot(env);
  if (!bot?.defaultChannelId) return null;

  const text = [
    `:red_circle:  *DOWN:* ${monitor.name}`,
    `<${monitor.url}|${monitor.url}>`,
    '',
    `>  *Error:* \`${truncate(error, 500)}\``,
    `>  _at ${new Date().toISOString()}_`,
  ].join('\n');

  const threadId = encodeSlackThreadId({ channel: bot.defaultChannelId, threadTs: '' });
  const result = await bot.slack.postMessage(threadId, text);
  return result.id || null;
}

/**
 * Post the recovery message. When `slackAlertTs` is provided, the message
 * is threaded under the open DOWN alert and a `:white_check_mark:` reaction
 * is added to that DOWN message so the channel timeline shows resolved
 * incidents at a glance.
 */
async function sendSlackUp(
  env: Env,
  monitor: Monitor,
  downDurationMs: number,
  slackAlertTs: string | null,
): Promise<void> {
  const bot = buildSlackBot(env);
  if (!bot?.defaultChannelId) return;

  const channel = bot.defaultChannelId;
  const text = [
    `:large_green_circle:  *RECOVERED:* ${monitor.name}`,
    `<${monitor.url}|${monitor.url}>`,
    '',
    `>  *Down for:* ${formatDuration(downDurationMs)}`,
    `>  _at ${new Date().toISOString()}_`,
  ].join('\n');

  // Reply in the same thread as the DOWN alert when we have its ts; fall
  // back to a top-level post when the ts is missing (e.g., the DOWN was
  // posted before slack_alert_ts was tracked).
  const threadId = encodeSlackThreadId({
    channel,
    threadTs: slackAlertTs ?? '',
  });

  await Promise.allSettled([
    bot.slack.postMessage(threadId, text),
    slackAlertTs
      ? bot.slack.addReaction(
          encodeSlackThreadId({ channel, threadTs: '' }),
          slackAlertTs,
          'white_check_mark',
        )
      : Promise.resolve(),
  ]);
}

// ── Helpers ─────────────────────────────────────────────────────────────

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function formatDuration(ms: number): string {
  if (ms <= 0) return 'less than a second';
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const parts: string[] = [];
  if (h) parts.push(`${h}h`);
  if (m) parts.push(`${m}m`);
  if (s || parts.length === 0) parts.push(`${s}s`);
  return parts.join(' ');
}
