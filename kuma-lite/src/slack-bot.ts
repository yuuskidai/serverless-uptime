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

  // DOWN first (longest-down at top so the most concerning shows highest),
  // then UP grouped at the bottom and sorted by name for stable reading.
  const down = monitors
    .filter((m) => m.current_status === 'down')
    .sort((a, b) => (a.down_since ?? 0) - (b.down_since ?? 0));
  const up = monitors
    .filter((m) => m.current_status !== 'down')
    .sort((a, b) => a.name.localeCompare(b.name));

  const total = monitors.length;
  const header =
    down.length === 0
      ? `:large_green_circle:  *All ${total} monitor${total === 1 ? '' : 's'} are operational.*`
      : `:red_circle:  *${down.length} of ${total} monitor${total === 1 ? '' : 's'} ${down.length === 1 ? 'is' : 'are'} DOWN.*`;

  const sections: string[] = [header, ''];

  if (down.length > 0) {
    sections.push(`*━━━━━ DOWN  (${down.length}) ━━━━━*`);
    for (const m of down) {
      const downFor = m.down_since
        ? formatDuration(Date.now() - m.down_since)
        : '—';
      sections.push(
        `:red_circle:  *${escapeMrkdwn(m.name)}*`,
        `>  <${m.url}|${escapeMrkdwn(displayUrl(m.url))}>`,
        `>  Down for *${downFor}*`,
        '',
      );
    }
  }

  if (up.length > 0) {
    sections.push(`*━━━━━ UP  (${up.length}) ━━━━━*`);
    for (const m of up) {
      sections.push(
        `:large_green_circle:  *${escapeMrkdwn(m.name)}*  —  <${m.url}|${escapeMrkdwn(displayUrl(m.url))}>`,
      );
    }
    sections.push('');
  }

  sections.push(`_as of ${new Date().toISOString()}_`);
  return sections.join('\n');
}

function displayUrl(url: string): string {
  try {
    const u = new URL(url);
    return u.host + (u.pathname === '/' ? '' : u.pathname);
  } catch {
    return url;
  }
}

function escapeMrkdwn(s: string): string {
  // Slack mrkdwn-safe: only `<`, `>`, `&` need escaping; bold/italic delimiters
  // (`*`, `_`) are intentionally not escaped because monitor names with those
  // chars are vanishingly rare and escaping them produces uglier output.
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
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
