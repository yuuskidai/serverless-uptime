import { Chat } from 'chat';
import { createMemoryState } from '@chat-adapter/state-memory';
import { createSlackAdapter, SlackWorkersAdapter } from './chat-adapters/slack';
import type { Env } from './types';

export interface SlackBot {
  chat: Chat<{ slack: SlackWorkersAdapter }>;
  slack: SlackWorkersAdapter;
  defaultChannelId?: string;
}

/**
 * Build a chat-sdk Chat instance wired up with the Slack adapter and the
 * `/status` slash command handler. Returns null when the required Slack
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

  chat.onSlashCommand(['/kuma', '/kuma-status'], async (event) => {
    if (event.adapter.name !== 'slack') return;
    const summary = await renderStatusSummary(env);
    await event.channel.post(summary);
  });

  return env.SLACK_DEFAULT_CHANNEL
    ? { chat, slack, defaultChannelId: env.SLACK_DEFAULT_CHANNEL }
    : { chat, slack };
}

interface MonitorRow {
  id: number;
  name: string;
  url: string;
}

interface MonitorWithState extends MonitorRow {
  current_status: 'up' | 'down' | null;
  consecutive_failures: number | null;
  down_since: number | null;
}

async function renderStatusSummary(env: Env): Promise<string> {
  const rows = await env.DB.prepare(
    `SELECT m.id, m.name, m.url,
            s.current_status, s.consecutive_failures, s.down_since
       FROM monitors m
       LEFT JOIN monitor_state s ON s.monitor_id = m.id
      WHERE m.enabled = 1
      ORDER BY m.id`,
  ).all<MonitorWithState>();
  const monitors = rows.results ?? [];
  if (monitors.length === 0) {
    return 'No monitors are configured.';
  }

  const downCount = monitors.filter((m) => m.current_status === 'down').length;
  const header =
    downCount === 0
      ? `:large_green_circle: All ${monitors.length} monitor${monitors.length === 1 ? '' : 's'} up.`
      : `:red_circle: ${downCount} of ${monitors.length} monitor${monitors.length === 1 ? '' : 's'} down.`;

  const lines = monitors.map((m) => {
    const icon = m.current_status === 'down' ? ':red_circle:' : ':large_green_circle:';
    const downFor =
      m.current_status === 'down' && m.down_since
        ? ` (down for ${formatDuration(Date.now() - m.down_since)})`
        : '';
    return `${icon}  *${m.name}* — ${m.url}${downFor}`;
  });

  return [header, '', ...lines].join('\n');
}

function formatDuration(ms: number): string {
  if (ms <= 0) return '<1s';
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
