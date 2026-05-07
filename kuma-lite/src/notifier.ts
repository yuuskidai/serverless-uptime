import type { ComponentHealth, Env, Monitor } from './types';
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

/**
 * Operator-facing context attached to a DOWN or DEGRADED transition.
 * Built by monitor.ts from the live `CheckResult` and rendered into
 * Slack Block Kit / Discord embeds. We pass a typed bundle rather
 * than a flat string so the webhook surfaces the same structured
 * information visitors see on the status page (business-language
 * reason, which component is unhealthy, what build SHA reported it).
 */
export interface IncidentDetail {
  /**
   * One-line headline for the alert. Prefer the site's own
   * business-language `reason` from /healthz; fall back to the raw
   * HTTP / network error string for legacy sites that don't speak
   * the spec.
   */
  reason: string;
  /**
   * Unhealthy components (`status !== 'ok'`) reported by /healthz.
   * Pre-filtered by the caller — the renderer assumes everything
   * passed in is worth surfacing.
   */
  components: ComponentHealth[];
  /** Short build SHA the monitored site reports under `version`. */
  version: string | null;
}

export async function notifyDown(
  env: Env,
  monitor: Monitor,
  detail: IncidentDetail,
): Promise<NotifyDownResult> {
  const [, slackResult] = await Promise.allSettled([
    sendDiscordDown(env, monitor, detail),
    sendSlackDown(env, monitor, detail),
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
  detail: IncidentDetail,
): Promise<void> {
  await Promise.allSettled([
    sendDiscordDegraded(env, monitor, detail),
    sendSlackDegraded(env, monitor, detail),
  ]);
}

// ── Discord ────────────────────────────────────────────────────────────

async function sendDiscordDown(
  env: Env,
  monitor: Monitor,
  detail: IncidentDetail,
): Promise<void> {
  if (!env.DISCORD_WEBHOOK_URL) return;
  await postWebhook(env.DISCORD_WEBHOOK_URL, {
    embeds: [
      {
        title: `🔴 DOWN: ${monitor.name}`,
        description: discordIncidentBody(monitor, detail, 'Reason'),
        color: 0xff0000,
        timestamp: new Date().toISOString(),
        footer: detail.version ? { text: `build ${detail.version}` } : undefined,
      },
    ],
  });
}

async function sendDiscordDegraded(
  env: Env,
  monitor: Monitor,
  detail: IncidentDetail,
): Promise<void> {
  if (!env.DISCORD_WEBHOOK_URL) return;
  await postWebhook(env.DISCORD_WEBHOOK_URL, {
    embeds: [
      {
        title: `🟡 DEGRADED: ${monitor.name}`,
        description: discordIncidentBody(monitor, detail, 'Reason'),
        color: 0xfbbf24,
        timestamp: new Date().toISOString(),
        footer: detail.version ? { text: `build ${detail.version}` } : undefined,
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

/**
 * Common Discord description body for DOWN/DEGRADED — URL link,
 * labelled reason, and the affected-components list (only when
 * non-empty). Build SHA goes in the embed footer instead of the
 * body so it sits in the small grey timestamp row, matching the
 * "operator metadata" placement convention.
 */
function discordIncidentBody(
  monitor: Monitor,
  detail: IncidentDetail,
  reasonLabel: string,
): string {
  const parts: string[] = [];
  parts.push(publicFacingUrl(monitor.url));
  parts.push('');
  parts.push(`**${reasonLabel}:** ${truncate(detail.reason, 800)}`);
  if (detail.components.length > 0) {
    parts.push('');
    parts.push('**Components**');
    for (const c of detail.components) {
      parts.push(`- ${formatComponentLine(c)}`);
    }
  }
  return parts.join('\n');
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
  detail: IncidentDetail,
): Promise<string | null> {
  const bot = buildSlackBot(env);
  if (!bot?.defaultChannelId) return null;

  const fallback = `🔴 DOWN: ${monitor.name} — ${detail.reason}`;
  const blocks: unknown[] = [
    {
      type: 'header',
      text: { type: 'plain_text', text: `🔴  DOWN — ${monitor.name}`, emoji: true },
    },
    {
      type: 'section',
      fields: [
        {
          type: 'mrkdwn',
          text: `*URL*\n<${publicFacingUrl(monitor.url)}|${slackEscape(publicFacingDisplay(monitor.url))}>`,
        },
        {
          type: 'mrkdwn',
          text: `*Triggered*\n<!date^${unixSec()}^{date_short_pretty} {time}|${new Date().toISOString()}>`,
        },
      ],
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Reason*\n${slackEscape(truncate(detail.reason, 500))}`,
      },
    },
    ...componentsSlackBlocks(detail.components),
    ...buildContextBlocks(detail.version, ':warning:  Recovery will reply in this thread.'),
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
  detail: IncidentDetail,
): Promise<void> {
  const bot = buildSlackBot(env);
  if (!bot?.defaultChannelId) return;

  const fallback = `🟡 DEGRADED: ${monitor.name} — ${detail.reason}`;
  const blocks: unknown[] = [
    {
      type: 'header',
      text: { type: 'plain_text', text: `🟡  DEGRADED — ${monitor.name}`, emoji: true },
    },
    {
      type: 'section',
      fields: [
        {
          type: 'mrkdwn',
          text: `*URL*\n<${publicFacingUrl(monitor.url)}|${slackEscape(publicFacingDisplay(monitor.url))}>`,
        },
        {
          type: 'mrkdwn',
          text: `*Detected*\n<!date^${unixSec()}^{date_short_pretty} {time}|${new Date().toISOString()}>`,
        },
      ],
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Reason*\n${slackEscape(truncate(detail.reason, 500))}`,
      },
    },
    ...componentsSlackBlocks(detail.components),
    ...buildContextBlocks(detail.version, null),
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
        {
          type: 'mrkdwn',
          text: `*URL*\n<${publicFacingUrl(monitor.url)}|${slackEscape(publicFacingDisplay(monitor.url))}>`,
        },
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

// ── Block Kit helpers ────────────────────────────────────────────────────

/**
 * Render a "Components" section block when the incident has any
 * unhealthy components. Returns an empty array when there's nothing
 * to show, so the caller can spread it inline without extra
 * conditionals. The list is bullet-formatted via mrkdwn rather than
 * built as separate blocks to keep the message compact.
 */
function componentsSlackBlocks(components: ComponentHealth[]): unknown[] {
  if (components.length === 0) return [];
  const lines = components.map((c) => `• ${formatComponentLine(c)}`).join('\n');
  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Components*\n${slackEscape(lines)}`,
      },
    },
  ];
}

/**
 * Combine the optional build-SHA chip and a static guidance line
 * (e.g. "Recovery will reply in this thread.") into a single
 * context block. Returns at most one block — empty array when
 * neither piece of context is present.
 */
function buildContextBlocks(version: string | null, guidance: string | null): unknown[] {
  const elements: unknown[] = [];
  if (version) {
    elements.push({ type: 'mrkdwn', text: `:gear:  build \`${slackEscape(version)}\`` });
  }
  if (guidance) {
    elements.push({ type: 'mrkdwn', text: guidance });
  }
  if (elements.length === 0) return [];
  return [{ type: 'context', elements }];
}

function formatComponentLine(c: ComponentHealth): string {
  const status = statusLabel(c.status);
  const latency =
    typeof c.latency_ms === 'number' && Number.isFinite(c.latency_ms) ? `, ${c.latency_ms}ms` : '';
  const reason = c.reason ? ` — ${c.reason}` : '';
  return `${c.name} (${status}${latency})${reason}`;
}

function statusLabel(s: ComponentHealth['status']): string {
  switch (s) {
    case 'down':
      return 'down';
    case 'degraded':
      return 'degraded';
    default:
      return 'ok';
  }
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
