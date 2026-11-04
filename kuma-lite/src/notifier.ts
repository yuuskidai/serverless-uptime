import type { ComponentHealth, Env, Monitor } from './types';
import { buildSlackBot } from './slack-bot';
import { publicFacingUrl, redactPublicUrls, type PublicUrlContext } from './url-display';
import { renderMonitorSlackMessage } from './slack-notification-layout';

export class NotificationDeliveryError extends Error {
  constructor(public readonly code: 'not_configured' | 'uncertain', public readonly slackAlertTs: string | null = null) {
    super(code === 'not_configured' ? 'No notification channel is configured' : 'Notification delivery was not confirmed');
    this.name = 'NotificationDeliveryError';
  }
}

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
  /** Observation time, preserved when delivery is delayed. */
  observedAt?: number;
}

/** Internal transport diagnostics never describe application availability or open public incidents. */
export async function notifyInternalPath(
  env: Env, monitor: Monitor, detail: IncidentDetail,
  kind: 'down' | 'degraded' | 'partial' | 'up', threadTs: string | null,
): Promise<NotifyDownResult> {
  const normal = kind === 'up';
  const label = normal ? 'NORMAL' : kind === 'partial' ? 'RESPONDING' : 'WARNING';
  const title = `INTERNAL PATH ${label} — ${monitor.name}`;
  const message = normal ? '内部診断で正常応答を確認しました。' : detail.reason;
  const guidance = '公開サービスの稼働判定とは別の内部診断です。';
  const bot = buildSlackBot(env);
  requireNotificationChannel(env);
  const slackMessage = renderMonitorSlackMessage(monitor, detail, kind, { internal: true });
  const [discord, slack] = await Promise.allSettled([
    env.DISCORD_WEBHOOK_URL ? postWebhook(env.DISCORD_WEBHOOK_URL, {
      embeds: [{ title, description: `${truncate(redactPublicUrls(message, [monitor.url, monitor.fallback_url]), 800)}\n\n${guidance}`,
        color: normal ? 0x94a3b8 : 0xfbbf24, timestamp: observedIso(detail) }],
    }, [monitor.url, monitor.fallback_url]) : Promise.resolve(),
    bot?.defaultChannelId ? bot.slack.postBlocks(bot.defaultChannelId, {
      ...slackMessage,
      threadTs: threadTs ?? undefined,
    }) : Promise.resolve(null),
  ]);
  if (discord.status === 'rejected' || slack.status === 'rejected') {
    throw new NotificationDeliveryError('uncertain', slack.status === 'fulfilled' && slack.value ? slack.value.ts || null : null);
  }
  // Only a new diagnostic incident starts a thread. Partial/normal replies keep
  // the original thread metadata and never replace it with a child reply's ts.
  return { slackAlertTs: (kind === 'down' || kind === 'degraded') &&
    slack.status === 'fulfilled' && slack.value ? slack.value.ts || null : null };
}

export async function notifyDown(
  env: Env,
  monitor: Monitor,
  detail: IncidentDetail,
): Promise<NotifyDownResult> {
  requireNotificationChannel(env);
  const [discordResult, slackResult] = await Promise.allSettled([
    sendDiscordDown(env, monitor, detail),
    sendSlackDown(env, monitor, detail),
  ]);
  const slackAlertTs = slackResult.status === 'fulfilled' ? slackResult.value : null;
  if (discordResult.status === 'rejected' || slackResult.status === 'rejected') {
    throw new NotificationDeliveryError('uncertain', slackAlertTs);
  }
  return { slackAlertTs };
}

export async function notifyUp(
  env: Env,
  monitor: Monitor,
  downDurationMs: number,
  slackAlertTs: string | null,
  previousStatus: 'down' | 'degraded' = 'down',
  observedAt?: number,
): Promise<void> {
  requireNotificationChannel(env);
  const detail: IncidentDetail = { reason: '', components: [], version: null, observedAt };
  const results = await Promise.allSettled([
    sendDiscordRecovery(env, monitor, downDurationMs, previousStatus, detail),
    sendSlackRecovery(env, monitor, downDurationMs, slackAlertTs, previousStatus, detail),
  ]);
  if (results.some(item => item.status === 'rejected')) throw new NotificationDeliveryError('uncertain');
}

/** A responding-but-degraded site has not fully recovered; keep the incident thread open. */
export async function notifyPartialRecovery(
  env: Env, monitor: Monitor, detail: IncidentDetail, downDurationMs: number, slackAlertTs: string | null,
): Promise<void> {
  requireNotificationChannel(env);
  const results = await Promise.allSettled([
    sendDiscordRecovery(env, monitor, downDurationMs, 'partial', detail),
    sendSlackRecovery(env, monitor, downDurationMs, slackAlertTs, 'partial', detail),
  ]);
  if (results.some(item => item.status === 'rejected')) throw new NotificationDeliveryError('uncertain');
}

type RecoveryKind = 'down' | 'degraded' | 'partial';

function recoveryText(monitor: Monitor, kind: RecoveryKind, duration: number, detail?: IncidentDetail) {
  const partial = kind === 'partial';
  return {
    title: partial ? `🟡 RESPONSE RESTORED — ${monitor.name}` : `✅ RECOVERED — ${monitor.name}`,
    message: partial
      ? `応答は復旧しましたが、遅延または一部不調が継続しています。${detail ? ` ${detail.reason}` : ''}`
      : kind === 'degraded' ? '連続した正常チェックで遅延・一部不調の解消を確認しました。' : '監視で正常応答への復旧を確認しました。',
    duration: kind === 'degraded' ? null : `監視上の停止期間: ${formatDuration(duration)}`,
  };
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
): Promise<NotifyDownResult> {
  requireNotificationChannel(env);
  const [discordResult, slackResult] = await Promise.allSettled([
    sendDiscordDegraded(env, monitor, detail),
    sendSlackDegraded(env, monitor, detail),
  ]);
  const slackAlertTs = slackResult.status === 'fulfilled' ? slackResult.value : null;
  if (discordResult.status === 'rejected' || slackResult.status === 'rejected') {
    throw new NotificationDeliveryError('uncertain', slackAlertTs);
  }
  return { slackAlertTs };
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
        timestamp: observedIso(detail),
        footer: detail.version ? { text: `build ${detail.version}` } : undefined,
      },
    ],
  }, [monitor.url, monitor.fallback_url]);
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
        timestamp: observedIso(detail),
        footer: detail.version ? { text: `build ${detail.version}` } : undefined,
      },
    ],
  }, [monitor.url, monitor.fallback_url]);
}

async function sendDiscordRecovery(
  env: Env,
  monitor: Monitor,
  downDurationMs: number,
  kind: RecoveryKind,
  detail?: IncidentDetail,
): Promise<void> {
  if (!env.DISCORD_WEBHOOK_URL) return;
  const content = recoveryText(monitor, kind, downDurationMs, detail);
  await postWebhook(env.DISCORD_WEBHOOK_URL, {
    embeds: [
      {
        title: content.title,
        description: [publicFacingUrl(monitor.url), content.message, content.duration].filter(Boolean).join('\n\n'),
        color: kind === 'partial' ? 0xfbbf24 : 0x00cc66,
        timestamp: observedIso(detail),
      },
    ],
  }, [monitor.url, monitor.fallback_url]);
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
  parts.push(`**${reasonLabel}:** ${truncate(redactPublicUrls(detail.reason, [monitor.url, monitor.fallback_url]), 800)}`);
  if (detail.components.length > 0) {
    parts.push('');
    parts.push('**Components**');
    for (const c of detail.components) {
      parts.push(`- ${formatComponentLine(c)}`);
    }
  }
  return parts.join('\n');
}

async function postWebhook(url: string, payload: unknown, probeUrl: PublicUrlContext): Promise<void> {
  const response = await fetch(url, {
    method: 'POST',
    signal: AbortSignal.timeout(6000),
    redirect: 'manual',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...(payload as Record<string, unknown>), allowed_mentions: { parse: [] } },
      (_key, value: unknown) => typeof value === 'string' ? redactPublicUrls(value, probeUrl) : value),
  });
  if (!response.ok && response.status !== 204) {
    const body = await response.text().catch(() => '');
    throw new Error(`Discord webhook failed: ${response.status} ${body.slice(0, 200)}`);
  }
  void response.body?.cancel().catch(() => undefined);
}

// ── Slack via chat-sdk + Block Kit ───────────────────────────────────────

async function sendSlackDown(
  env: Env,
  monitor: Monitor,
  detail: IncidentDetail,
): Promise<string | null> {
  const bot = buildSlackBot(env);
  if (!bot?.defaultChannelId) return null;

  const message = renderMonitorSlackMessage(monitor, detail, 'down');
  const result = await bot.slack.postBlocks(bot.defaultChannelId, message);
  return result.ts || null;
}

async function sendSlackDegraded(
  env: Env,
  monitor: Monitor,
  detail: IncidentDetail,
): Promise<string | null> {
  const bot = buildSlackBot(env);
  if (!bot?.defaultChannelId) return null;

  const message = renderMonitorSlackMessage(monitor, detail, 'degraded');
  const result = await bot.slack.postBlocks(bot.defaultChannelId, message);
  return result.ts || null;
}

async function sendSlackRecovery(
  env: Env,
  monitor: Monitor,
  downDurationMs: number,
  slackAlertTs: string | null,
  kind: RecoveryKind,
  detail?: IncidentDetail,
): Promise<void> {
  const bot = buildSlackBot(env);
  if (!bot?.defaultChannelId) return;

  const channel = bot.defaultChannelId;
  // DOWN -> DEGRADED formerly emitted a green RECOVERED message. Distinguish response
  // restoration from full recovery, and label durations as monitor observations.
  const message = renderMonitorSlackMessage(monitor,
    detail ?? { reason: '', components: [], version: null }, kind === 'partial' ? 'partial' : 'up',
    { durationMs: downDurationMs, previousStatus: kind === 'degraded' ? 'degraded' : 'down' });
  await bot.slack.postBlocks(channel, {
    ...message,
    threadTs: slackAlertTs ?? undefined,
    // Retain the public recovery's existing thread and timeline behavior.
    replyBroadcast: Boolean(slackAlertTs),
  });
  // A failed decorative reaction does not mean the recovery message was undelivered.
  if (slackAlertTs && kind !== 'partial') {
    await bot.slack.addReaction(`slack:${channel}:`, slackAlertTs, 'white_check_mark').catch(() => undefined);
  }
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

function requireNotificationChannel(env: Env): void {
  if (!env.DISCORD_WEBHOOK_URL && !buildSlackBot(env)?.defaultChannelId) throw new NotificationDeliveryError('not_configured');
}

function observedIso(detail?: IncidentDetail): string {
  return new Date(detail?.observedAt ?? Date.now()).toISOString();
}

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
