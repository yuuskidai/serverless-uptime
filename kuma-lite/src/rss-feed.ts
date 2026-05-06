import type { CheckRow, Env, Monitor } from './types';
import { classify, KIND_COPY, type IncidentKind } from './kinds';

const TIMEZONE = 'Asia/Tokyo';
/** How far back to look when synthesising the incident timeline. */
const HISTORY_WINDOW_MS = 30 * 86_400_000;
/** Cap on the number of incidents emitted to keep the feed compact. */
const MAX_ITEMS = 50;

interface Incident {
  monitor: Monitor;
  startedAt: number;
  /** null when the incident is still ongoing. */
  endedAt: number | null;
  kind: IncidentKind;
  /**
   * Most recent business-language `reason` reported by the site's
   * /healthz JSON during this incident. Replaces the kind headline in
   * the RSS title when present so subscribers see the same wording as
   * the status page.
   */
  reason: string | null;
}

/**
 * RSS 2.0 feed of recent state transitions, derived on-the-fly from the
 * `checks` table. Each incident produces one item; if the incident has
 * resolved, the item carries the resolution time in its description.
 *
 * The feed is intentionally minimal — it mirrors the public status page
 * for non-technical readers who want to track outage history in their
 * RSS reader. No technical noise (no raw HTTP codes, no error strings)
 * leaks through; the human-readable category headline is the only
 * cause description in each item.
 */
export async function renderRssFeed(env: Env, baseUrl: URL): Promise<Response> {
  const now = Date.now();
  const since = now - HISTORY_WINDOW_MS;

  const monitorsResult = await env.DB.prepare(
    `SELECT * FROM monitors WHERE enabled = 1 ORDER BY id ASC`,
  ).all<Monitor>();
  const monitors = monitorsResult.results ?? [];

  const incidents: Incident[] = [];
  for (const monitor of monitors) {
    const checksResult = await env.DB.prepare(
      `SELECT * FROM checks
         WHERE monitor_id = ? AND ts >= ?
         ORDER BY ts ASC`,
    )
      .bind(monitor.id, since)
      .all<CheckRow>();
    const checks = checksResult.results ?? [];
    const monitorIncidents = deriveIncidents(monitor, checks);
    for (const inc of monitorIncidents) incidents.push(inc);
  }

  // Most recent incidents first; cap to MAX_ITEMS.
  incidents.sort((a, b) => b.startedAt - a.startedAt);
  const items = incidents.slice(0, MAX_ITEMS);

  const xml = renderRssXml(items, baseUrl, now, monitors.length);
  return new Response(xml, {
    status: 200,
    headers: {
      'Content-Type': 'application/rss+xml; charset=utf-8',
      // Reasonable cache: RSS readers typically poll every 15-30 minutes
      // anyway, so a short edge cache absorbs duplicate requests without
      // losing freshness.
      'Cache-Control': 'public, max-age=300',
    },
  });
}

/**
 * Walk per-monitor checks chronologically and emit one incident per
 * transition that crossed `retry_threshold` consecutive failures. The
 * threshold mirrors the live notifier in monitor.ts so RSS items only
 * fire for the same events that triggered Slack/Discord alerts.
 */
function deriveIncidents(monitor: Monitor, checks: CheckRow[]): Incident[] {
  const out: Incident[] = [];
  const threshold = Math.max(1, monitor.retry_threshold ?? 1);
  let consecFails = 0;
  let inIncident = false;
  let openIncident: Incident | null = null;
  // Track failure counts per kind within the current incident so we can
  // surface the dominant cause.
  let kindCounts: Map<IncidentKind, number> | null = null;
  // Most recent structured reason captured during the current incident.
  let latestReason: string | null = null;

  for (const c of checks) {
    // Maintenance windows aren't incidents and shouldn't fire RSS items
    // (per spec §2 — "DOWN 通知抑止" extends to the public feed).
    if (c.in_maintenance) {
      consecFails = 0;
      if (inIncident && openIncident && kindCounts) {
        openIncident.endedAt = c.ts;
        openIncident.kind = pickDominant(kindCounts);
        openIncident.reason = latestReason;
        out.push(openIncident);
        inIncident = false;
        openIncident = null;
        kindCounts = null;
        latestReason = null;
      }
      continue;
    }
    if (c.status === 'down') {
      consecFails += 1;
      if (!inIncident && consecFails >= threshold) {
        inIncident = true;
        kindCounts = new Map();
        latestReason = null;
        openIncident = {
          monitor,
          // Mark the incident's start at the first of the consecutive
          // failures, not at the threshold-crossing check.
          startedAt: c.ts - (threshold - 1) * 60_000,
          endedAt: null,
          kind: 'unknown',
          reason: null,
        };
      }
      if (inIncident && kindCounts) {
        const k = classify(c.error, c.status_code);
        kindCounts.set(k, (kindCounts.get(k) ?? 0) + 1);
        if (c.healthz_reason && c.healthz_reason.trim()) {
          latestReason = c.healthz_reason.trim();
        }
      }
    } else {
      consecFails = 0;
      if (inIncident && openIncident && kindCounts) {
        openIncident.endedAt = c.ts;
        openIncident.kind = pickDominant(kindCounts);
        openIncident.reason = latestReason;
        out.push(openIncident);
        inIncident = false;
        openIncident = null;
        kindCounts = null;
        latestReason = null;
      }
    }
  }
  // Incident still open at end-of-window.
  if (inIncident && openIncident && kindCounts) {
    openIncident.kind = pickDominant(kindCounts);
    openIncident.reason = latestReason;
    out.push(openIncident);
  }
  return out;
}

function pickDominant(counts: Map<IncidentKind, number>): IncidentKind {
  let best: { kind: IncidentKind; n: number } | null = null;
  for (const [kind, n] of counts) {
    if (kind === 'unknown') continue;
    if (!best || n > best.n) best = { kind, n };
  }
  if (best) return best.kind;
  // All entries were 'unknown' — return that.
  for (const k of counts.keys()) return k;
  return 'unknown';
}

function renderRssXml(
  items: Incident[],
  baseUrl: URL,
  now: number,
  monitorCount: number,
): string {
  const channelLink = `${baseUrl.origin}/`;
  const selfLink = `${baseUrl.origin}/rss.xml`;
  const lastBuildDate = formatRfc822(now);
  const channelTitle = 'kuma-lite ステータスフィード';
  const channelDescription = `自動監視 ${monitorCount} 件の障害履歴。直近${Math.floor(
    HISTORY_WINDOW_MS / 86_400_000,
  )}日分の不調イベントを最新順で配信します。`;

  const itemsXml = items.map((inc) => renderItem(inc, baseUrl)).join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${escapeXml(channelTitle)}</title>
    <link>${escapeXml(channelLink)}</link>
    <atom:link href="${escapeXml(selfLink)}" rel="self" type="application/rss+xml" />
    <description>${escapeXml(channelDescription)}</description>
    <language>ja</language>
    <lastBuildDate>${escapeXml(lastBuildDate)}</lastBuildDate>
    <generator>kuma-lite</generator>
${itemsXml}
  </channel>
</rss>`;
}

function renderItem(inc: Incident, baseUrl: URL): string {
  const { monitor, startedAt, endedAt, kind, reason } = inc;
  const copy = KIND_COPY[kind];
  const isOngoing = endedAt === null;
  const statusPrefix = isOngoing ? '[障害発生]' : '[復旧済]';
  const monitorLabel = monitor.description
    ? `${monitor.name} (${monitor.description})`
    : monitor.name;
  // Title prefers the site's own business-language reason when it sent
  // one through /healthz; otherwise falls back to the kind-headline so
  // pre-/healthz monitors still produce readable items.
  const titleCause = reason ?? copy.headline;
  const title = `${statusPrefix} ${monitorLabel} — ${titleCause}`;

  const linkFromMs = startedAt;
  const linkToMs = endedAt ?? Date.now();
  const link = `${baseUrl.origin}/incident?monitor_id=${monitor.id}&from=${linkFromMs}&to=${linkToMs}`;

  // Most-recently-relevant moment drives both pubDate and guid suffix:
  // - resolved → resolution time, item is final
  // - ongoing  → start time, item updates as new RSS reads find a new
  //              endedAt
  const pubDateMs = endedAt ?? startedAt;
  const guid = `kuma-lite:incident:${monitor.id}:${startedAt}${endedAt ? `:${endedAt}` : ':ongoing'}`;

  const descriptionLines: string[] = [];
  if (reason) descriptionLines.push(reason);
  descriptionLines.push(copy.detail);
  descriptionLines.push(`発生: ${formatJstFriendly(startedAt)}`);
  if (endedAt !== null) {
    descriptionLines.push(`復旧: ${formatJstFriendly(endedAt)}`);
    const durationMs = Math.max(0, endedAt - startedAt);
    descriptionLines.push(`影響時間: 約 ${formatHumanDuration(durationMs)}`);
  } else {
    descriptionLines.push('現在も継続中です。');
  }

  const description = descriptionLines.join('\n');

  return `    <item>
      <title>${escapeXml(title)}</title>
      <link>${escapeXml(link)}</link>
      <guid isPermaLink="false">${escapeXml(guid)}</guid>
      <pubDate>${escapeXml(formatRfc822(pubDateMs))}</pubDate>
      <description>${escapeCdata(description)}</description>
    </item>`;
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function escapeCdata(s: string): string {
  // CDATA can hold anything except the literal terminator. Split occurrences.
  const safe = s.replace(/]]>/g, ']]]]><![CDATA[>');
  return `<![CDATA[${safe}]]>`;
}

function formatRfc822(ts: number): string {
  // RFC 822 / 2822 date string in JST. Example: "Wed, 06 May 2026 22:34:05 +0900".
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: TIMEZONE,
    weekday: 'short',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const parts = fmt.formatToParts(new Date(ts));
  const get = (t: Intl.DateTimeFormatPartTypes): string =>
    parts.find((p) => p.type === t)?.value ?? '';
  return `${get('weekday')}, ${get('day')} ${get('month')} ${get('year')} ${get('hour')}:${get('minute')}:${get('second')} +0900`;
}

function formatJstFriendly(ts: number): string {
  const fmt = new Intl.DateTimeFormat('ja-JP', {
    timeZone: TIMEZONE,
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  return fmt.format(new Date(ts));
}

function formatHumanDuration(ms: number): string {
  if (ms < 1000) return `${ms} ミリ秒`;
  if (ms < 60_000) return `${Math.max(1, Math.floor(ms / 1000))} 秒`;
  const totalMin = Math.floor(ms / 60_000);
  if (totalMin < 60) return `${totalMin} 分`;
  const totalHr = Math.floor(totalMin / 60);
  const remMin = totalMin % 60;
  if (totalHr < 24) {
    return remMin > 0 ? `${totalHr} 時間 ${remMin} 分` : `${totalHr} 時間`;
  }
  const days = Math.floor(totalHr / 24);
  const remHr = totalHr % 24;
  return remHr > 0 ? `${days} 日 ${remHr} 時間` : `${days} 日`;
}
