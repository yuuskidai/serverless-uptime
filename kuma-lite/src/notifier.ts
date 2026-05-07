import type { Env, Monitor } from './types';
import { buildSlackBot } from './slack-bot';
import { publicFacingDisplay, publicFacingUrl } from './url-display';

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

/**
 * Soft warning when a monitor transitions up → degraded based on the
 * /healthz JSON. Quieter than DOWN: amber color, no @here, single
 * line. Suppressed by the caller while inside a maintenance window.
 */
export async function notifyDegraded(
  env: Env,
  monitor: Monitor,
  reason: string,
): Promise<void> {
  await Promise.allSettled([
    sendDiscordDegraded(env, monitor, reason),
    sendSlackDegraded(env, monitor, reason),
  ]);
}

// ── Discord (unchanged) ─────────────────────────────────────────────────

async function sendDiscordDown(env: Env, monitor: Monitor, error: string): Promise<void> {
  if (!env.DISCORD_WEBHOOK_URL) return;
  await postWebhook(env.DISCORD_WEBHOOK_URL, {
    embeds: [
      {
        title: `🔴 DOWN: ${monitor.name}`,
        description: `${publicFacingUrl(monitor.url)}\n\n**Error:** ${truncate(error, 800)}`,
        color: 0xff0000,
        timestamp: new Date().toISOString(),
      },
    ],
  });
}

async function sendDiscordDegraded(
  env: Env,
  monitor: Monitor,
  reason: string,
): Promise<void> {
  if (!env.DISCORD_WEBHOOK_URL) return;
  await postWebhook(env.DISCORD_WEBHOOK_URL, {
    embeds: [
      {
        title: `🟡 DEGRADED: ${monitor.name}`,
        description: `${publicFacingUrl(monitor.url)}\n\n**Reason:** ${truncate(reason, 800)}`,
        color: 0xfbbf24,
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
        description: `${publicFacingUrl(monitor.url)}\n\n**Recovered after:** ${formatDuration(downDurationMs)}`,
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

// ── Slack via chat-sdk + Block Kit ───────────────────────────────────────

async function sendSlackDown(
  env: Env,
  monitor: Monitor,
  error: string,
): Promise<string | null> {
  const bot = buildSlackBot(env);
  if (!bot?.defaultChannelId) return null;

  const fallback = `🔴 DOWN: ${monitor.name} — ${publicFacingUrl(monitor.url)}`;
  const blocks: unknown[] = [
    {
      type: 'header',
      text: { type: 'plain_text', text: `🔴  DOWN — ${monitor.name}`, emoji: true },
    },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*URL*\n<${publicFacingUrl(monitor.url)}|${slackEscape(publicFacingDisplay(monitor.url))}>` },
        { type: 'mrkdwn', text: `*Triggered*\n<!date^${unixSec()}^{date_short_pretty} {time}|${new Date().toISOString()}>` },
      ],
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Error*\n\`\`\`${slackEscape(truncate(error, 500))}\`\`\``,
      },
    },
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `:warning:  Recovery will reply in this thread.`,
        },
      ],
    },
  ];

  const result = await bot.slack.postBlocks(bot.defaultChannelId, {
    text: fallback,
    blocks,
  });
  return result.ts || null;
}

async function sendSlackDegraded(
  env: Env,
  monitor: Monitor,
  reason: string,
): Promise<void> {
  const bot = buildSlackBot(env);
  if (!bot?.defaultChannelId) return;

  const fallback = `🟡 DEGRADED: ${monitor.name} — ${reason}`;
  const blocks: unknown[] = [
    {
      type: 'header',
      text: { type: 'plain_text', text: `🟡  DEGRADED — ${monitor.name}`, emoji: true },
    },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*URL*\n<${publicFacingUrl(monitor.url)}|${slackEscape(publicFacingDisplay(monitor.url))}>` },
        { type: 'mrkdwn', text: `*Detected*\n<!date^${unixSec()}^{date_short_pretty} {time}|${new Date().toISOString()}>` },
      ],
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Reason*\n${slackEscape(truncate(reason, 500))}`,
      },
    },
  ];
  await bot.slack.postBlocks(bot.defaultChannelId, { text: fallback, blocks });
}

async function sendSlackUp(
  env: Env,
  monitor: Monitor,
  downDurationMs: number,
  slackAlertTs: string | null,
): Promise<void> {
  const bot = buildSlackBot(env);
  if (!bot?.defaultChannelId) return;

  const channel = bot.defaultChannelId;
  const fallback = `✅ RECOVERED: ${monitor.name} (down for ${formatDuration(downDurationMs)})`;
  const blocks: unknown[] = [
    {
      type: 'header',
      text: { type: 'plain_text', text: `✅  RECOVERED — ${monitor.name}`, emoji: true },
    },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*URL*\n<${publicFacingUrl(monitor.url)}|${slackEscape(publicFacingDisplay(monitor.url))}>` },
        { type: 'mrkdwn', text: `*Down for*\n${formatDuration(downDurationMs)}` },
      ],
    },
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `:large_green_circle:  Recovered at <!date^${unixSec()}^{date_short_pretty} {time}|${new Date().toISOString()}>`,
        },
      ],
    },
  ];

  await Promise.allSettled([
    bot.slack.postBlocks(channel, {
      text: fallback,
      blocks,
      threadTs: slackAlertTs ?? undefined,
      // Threaded recoveries also broadcast to the channel timeline so the
      // resolution is visible without expanding the thread. No-op when
      // there's no thread (top-level fallback path).
      replyBroadcast: Boolean(slackAlertTs),
    }),
    slackAlertTs
      ? bot.slack.addReaction(`slack:${channel}:`, slackAlertTs, 'white_check_mark')
      : Promise.resolve(),
  ]);
}

// ── Helpers ─────────────────────────────────────────────────────────────

function unixSec(): number {
  return Math.floor(Date.now() / 1000);
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function slackEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
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
