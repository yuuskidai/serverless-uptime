import { Chat } from 'chat';
import { createMemoryState } from '@chat-adapter/state-memory';
import { createSlackAdapter, SlackWorkersAdapter } from './chat-adapters/slack';
import type { Env, Monitor } from './types';
import { AVAILABILITY_ROLE_SQL, availabilityHistorySql } from './monitor-policy';
import { monitorFreshness } from './monitor-readiness';
import { readExternalWitnesses } from './external-observations';

export interface SlackBot {
  chat: Chat<{ slack: SlackWorkersAdapter }>;
  slack: SlackWorkersAdapter;
  defaultChannelId?: string;
}

/**
 * Build a chat-sdk Chat instance wired up with the Slack adapter and the
 * `/kuma` slash command handler. Returns null when the required Slack
 * env vars are missing — callers can short-circuit Slack integration in
 * that case.
 *
 * Constructed fresh per Worker invocation: state lives in-memory and the
 * Slack adapter is stateless (each call carries its own bot token via
 * the SlackClient).
 */
export function buildSlackBot(env: Env): SlackBot | null {
  if (!env.SLACK_BOT_TOKEN || !env.SLACK_SIGNING_SECRET) return null;

  const slack = createSlackAdapter({
    botToken: env.SLACK_BOT_TOKEN,
    signingSecret: env.SLACK_SIGNING_SECRET,
    userName: 'kuma-lite',
  });

  const chat = new Chat({
    userName: 'kuma-lite',
    state: createMemoryState(),
    adapters: { slack },
    logger: 'warn',
  });

  // The handler is captured via closure so we can reach `slack.postBlocks`
  // (a Slack-specific escape hatch). chat-sdk's `event.channel.post(text)`
  // would only let us send plain text, losing Block Kit hierarchy.
  chat.onSlashCommand(['/kuma', '/kuma-status'], async (event) => {
    if (event.adapter.name !== 'slack') return;
    const channelId = stripSlackPrefix(
      // event.channel exposes a chat-sdk Channel; we only need its id here.
      (event.channel as unknown as { id?: string }).id ?? `slack:${env.SLACK_DEFAULT_CHANNEL ?? ''}`,
    );
    if (!channelId) return;
    const { text, blocks } = await renderStatusBlocks(env);
    await slack.postBlocks(`slack:${channelId}`, { text, blocks });
  });

  return env.SLACK_DEFAULT_CHANNEL
    ? { chat, slack, defaultChannelId: env.SLACK_DEFAULT_CHANNEL }
    : { chat, slack };
}

function stripSlackPrefix(id: string): string {
  return id.startsWith('slack:') ? id.slice('slack:'.length) : id;
}

interface MonitorWithState extends Monitor {
  current_status: 'up' | 'down' | 'degraded' | null;
  latest_ts: number | null;
  latest_slot: number | null;
  latest_revision: number | null;
}

export async function renderStatusBlocks(
  env: Env,
): Promise<{ text: string; blocks: unknown[] }> {
  const latest = (column: string) => `(SELECT c.${column} FROM checks c WHERE c.monitor_id = m.id
    AND ${availabilityHistorySql('c')} ORDER BY c.ts DESC LIMIT 1)`;
  const now = Date.now();
  const [rows, externalWitnesses] = await Promise.all([env.DB.prepare(
    `SELECT m.*, s.current_status,
            ${latest('ts')} AS latest_ts,
            ${latest('scheduled_slot')} AS latest_slot,
            ${latest('config_revision')} AS latest_revision
       FROM monitors m
       LEFT JOIN monitor_state s ON s.monitor_id = m.id
      WHERE m.enabled = 1 AND ${AVAILABILITY_ROLE_SQL.replace('COALESCE(monitor_role', 'COALESCE(m.monitor_role')}
      ORDER BY m.id`,
  ).all<MonitorWithState>(), readExternalWitnesses(env, now)]);
  const monitors = rows.results ?? [];
  if (monitors.length === 0) return {
    text: 'No monitors are configured.',
    blocks: [{ type: 'section', text: { type: 'mrkdwn', text: ':information_source: No monitors are configured.' } }],
  };
  const views = monitors.map(monitor => ({
    monitor,
    state: monitorFreshness(monitor, monitor.latest_ts === null ? null : {
      ts: monitor.latest_ts, scheduled_slot: monitor.latest_slot, config_revision: monitor.latest_revision,
    }, now) === 'fresh' ? monitor.current_status ?? 'unknown' : 'unknown',
  }));
  const downCount = views.filter(v => v.state === 'down').length;
  const degradedCount = views.filter(v => v.state === 'degraded').length;
  const unknownCount = views.filter(v => v.state === 'unknown').length;
  const headerText = downCount ? `🔴 ${downCount}/${views.length} DOWN`
    : degradedCount ? `🟡 ${degradedCount}/${views.length} DEGRADED`
    : unknownCount ? `⚪ ${unknownCount}/${views.length} 監視情報未確認`
    : `✅ All ${views.length} monitors operational`;
  const blocks: unknown[] = [{ type: 'header', text: { type: 'plain_text', text: headerText, emoji: true } }];
  for (const {monitor, state} of views) {
    const label = state === 'unknown' ? ':white_circle: 監視情報が古いか、まだ取得されていません'
      : state === 'down' ? ':red_circle: DOWN' : state === 'degraded' ? ':large_yellow_circle: DEGRADED' : ':large_green_circle: UP';
    const external = externalWitnesses.get(monitor.id);
    const externalLabel = external?.status === 'ok' ? '正常' : external?.status === 'degraded' ? '遅延・一部不調'
      : external?.status === 'down' ? '応答確認できず' : '未確認';
    const externalTime = external?.observedAt != null
      ? ` · <!date^${Math.floor(external.observedAt/1000)}^{date_short_pretty} {time}|${new Date(external.observedAt).toISOString()}>` : '';
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text:
      `*${slackEscape(monitor.name)}*\n${label}\n<${monitor.url}|${slackEscape(displayUrl(monitor.url))}>\n外部確認: ${externalLabel}${externalTime}（約5分ごとの補助確認）` } });
  }
  blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text:
    `:clock1: as of <!date^${Math.floor(now/1000)}^{date_short_pretty} {time}|${new Date(now).toISOString()}>` }] });
  return { text: headerText, blocks };
}

function displayUrl(url: string): string {
  try {
    const u = new URL(url);
    return u.host + (u.pathname === '/' ? '' : u.pathname);
  } catch {
    return url;
  }
}

function slackEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
