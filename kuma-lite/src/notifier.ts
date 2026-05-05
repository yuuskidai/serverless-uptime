import type { Env, Monitor } from './types';

export async function notifyDown(env: Env, monitor: Monitor, error: string): Promise<void> {
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

export async function notifyUp(
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
