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

interface MonitorWithState {
  id: number;
  name: string;
  url: string;
  current_status: 'up' | 'down' | null;
  consecutive_failures: number | null;
  down_since: number | null;
}

async function renderStatusBlocks(
  env: Env,
): Promise<{ text: string; blocks: unknown[] }> {
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
    return {
      text: 'No monitors are configured.',
      blocks: [
        {
          type: 'section',
          text: { type: 'mrkdwn', text: ':information_source:  No monitors are configured.' },
        },
      ],
    };
  }

  const down = monitors
    .filter((m) => m.current_status === 'down')
    .sort((a, b) => (a.down_since ?? 0) - (b.down_since ?? 0));
  const up = monitors
    .filter((m) => m.current_status !== 'down')
    .sort((a, b) => a.name.localeCompare(b.name));

  const total = monitors.length;
  const headerText =
    down.length === 0
      ? `✅  All ${total} monitor${total === 1 ? '' : 's'} operational`
      : `🔴  ${down.length}/${total} monitor${total === 1 ? '' : 's'} DOWN`;

  const blocks: unknown[] = [
    {
      type: 'header',
      text: { type: 'plain_text', text: headerText, emoji: true },
    },
  ];

  if (down.length > 0) {
    blocks.push({ type: 'divider' });
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `*🔴  DOWN  (${down.length})*` }],
    });
    for (const m of down) {
      const downFor = m.down_since ? formatDuration(Date.now() - m.down_since) : '—';
      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: [
            `:red_circle:  *${slackEscape(m.name)}*`,
            `<${m.url}|${slackEscape(displayUrl(m.url))}>`,
            `_Down for *${downFor}*_`,
          ].join('\n'),
        },
      });
    }
  }

  if (up.length > 0) {
    blocks.push({ type: 'divider' });
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `*🟢  UP  (${up.length})*` }],
    });
    // 2 monitors per section.fields row for compactness.
    for (let i = 0; i < up.length; i += 2) {
      const left = up[i];
      const right = up[i + 1];
      const fields: unknown[] = [];
      if (left) {
        fields.push({
          type: 'mrkdwn',
          text: `:large_green_circle:  *${slackEscape(left.name)}*\n<${left.url}|${slackEscape(displayUrl(left.url))}>`,
        });
      }
      if (right) {
        fields.push({
          type: 'mrkdwn',
          text: `:large_green_circle:  *${slackEscape(right.name)}*\n<${right.url}|${slackEscape(displayUrl(right.url))}>`,
        });
      }
      blocks.push({ type: 'section', fields });
    }
  }

  blocks.push({
    type: 'context',
    elements: [
      {
        type: 'mrkdwn',
        text: `:clock1:  as of <!date^${unixSec()}^{date_short_pretty} {time}|${new Date().toISOString()}>`,
      },
    ],
  });

  return { text: headerText, blocks };
}

function unixSec(): number {
  return Math.floor(Date.now() / 1000);
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
