import type { CheckRow, CheckStatus, Env, Monitor, MonitorState } from './types';

const WINDOW_MS = 90 * 60 * 1000; // 90 minutes
const BUCKET_MS = 3 * 60 * 1000; // 3 minutes
const BUCKET_COUNT = WINDOW_MS / BUCKET_MS; // 30

interface MonitorView {
  monitor: Monitor;
  state: CheckStatus;
  uptime24h: number | null;
  latestLatency: number | null;
  latestTs: number | null;
  buckets: BucketState[];
}

type BucketState = 'up' | 'down' | 'partial' | 'none';

export async function renderStatusPage(env: Env): Promise<Response> {
  const now = Date.now();
  const since24h = now - 24 * 60 * 60 * 1000;
  const sinceWindow = now - WINDOW_MS;

  const hidden = parseHidden(env.HIDDEN_MONITOR_IDS);

  const monitorsResult = await env.DB.prepare(
    `SELECT * FROM monitors WHERE enabled = 1 ORDER BY id ASC`,
  ).all<Monitor>();
  const monitors = (monitorsResult.results ?? []).filter((m) => !hidden.has(m.id));

  if (monitors.length === 0) {
    return htmlResponse(renderShell('No monitors configured', emptyState()));
  }

  const ids = monitors.map((m) => m.id);
  const placeholders = ids.map(() => '?').join(',');

  const statesResult = await env.DB.prepare(
    `SELECT * FROM monitor_state WHERE monitor_id IN (${placeholders})`,
  )
    .bind(...ids)
    .all<MonitorState>();
  const stateById = new Map<number, MonitorState>();
  for (const row of statesResult.results ?? []) stateById.set(row.monitor_id, row);

  const uptimeResult = await env.DB.prepare(
    `SELECT monitor_id,
            COUNT(*) AS total,
            SUM(CASE WHEN status = 'up' THEN 1 ELSE 0 END) AS ups
       FROM checks
      WHERE ts >= ? AND monitor_id IN (${placeholders})
      GROUP BY monitor_id`,
  )
    .bind(since24h, ...ids)
    .all<{ monitor_id: number; total: number; ups: number }>();
  const uptimeById = new Map<number, { total: number; ups: number }>();
  for (const row of uptimeResult.results ?? []) {
    uptimeById.set(row.monitor_id, { total: row.total, ups: row.ups });
  }

  const latestResult = await env.DB.prepare(
    `SELECT c.monitor_id, c.latency_ms, c.ts
       FROM checks c
       JOIN (
         SELECT monitor_id, MAX(ts) AS max_ts
           FROM checks
          WHERE monitor_id IN (${placeholders})
          GROUP BY monitor_id
       ) m ON m.monitor_id = c.monitor_id AND m.max_ts = c.ts`,
  )
    .bind(...ids)
    .all<{ monitor_id: number; latency_ms: number | null; ts: number }>();
  const latestById = new Map<number, { latency_ms: number | null; ts: number }>();
  for (const row of latestResult.results ?? []) {
    latestById.set(row.monitor_id, { latency_ms: row.latency_ms, ts: row.ts });
  }

  const recentResult = await env.DB.prepare(
    `SELECT monitor_id, status, ts FROM checks
      WHERE ts >= ? AND monitor_id IN (${placeholders})
      ORDER BY ts ASC`,
  )
    .bind(sinceWindow, ...ids)
    .all<Pick<CheckRow, 'monitor_id' | 'status' | 'ts'>>();
  const recentByMonitor = new Map<number, Array<{ status: CheckStatus; ts: number }>>();
  for (const row of recentResult.results ?? []) {
    const list = recentByMonitor.get(row.monitor_id) ?? [];
    list.push({ status: row.status, ts: row.ts });
    recentByMonitor.set(row.monitor_id, list);
  }

  const views: MonitorView[] = monitors.map((monitor) => {
    const state = stateById.get(monitor.id);
    const uptime = uptimeById.get(monitor.id);
    const latest = latestById.get(monitor.id);
    const recent = recentByMonitor.get(monitor.id) ?? [];
    return {
      monitor,
      state: state?.current_status ?? 'up',
      uptime24h: uptime && uptime.total > 0 ? (uptime.ups / uptime.total) * 100 : null,
      latestLatency: latest?.latency_ms ?? null,
      latestTs: latest?.ts ?? null,
      buckets: computeBuckets(recent, sinceWindow),
    };
  });

  const overall = computeOverall(views);
  const html = renderShell('Status', renderBody(views, overall, now));
  return htmlResponse(html);
}

function parseHidden(input: string | undefined): Set<number> {
  const set = new Set<number>();
  if (!input) return set;
  for (const part of input.split(',')) {
    const n = Number.parseInt(part.trim(), 10);
    if (Number.isFinite(n)) set.add(n);
  }
  return set;
}

function computeBuckets(
  rows: Array<{ status: CheckStatus; ts: number }>,
  start: number,
): BucketState[] {
  const buckets: BucketState[] = Array.from({ length: BUCKET_COUNT }, () => 'none');
  const counts = Array.from({ length: BUCKET_COUNT }, () => ({ up: 0, down: 0 }));
  for (const row of rows) {
    const idx = Math.floor((row.ts - start) / BUCKET_MS);
    if (idx < 0 || idx >= BUCKET_COUNT) continue;
    counts[idx][row.status === 'up' ? 'up' : 'down']++;
  }
  for (let i = 0; i < BUCKET_COUNT; i++) {
    const { up, down } = counts[i];
    if (up === 0 && down === 0) buckets[i] = 'none';
    else if (down === 0) buckets[i] = 'up';
    else if (up === 0) buckets[i] = 'down';
    else buckets[i] = 'partial';
  }
  return buckets;
}

function computeOverall(views: MonitorView[]): { ok: boolean; downCount: number } {
  const downCount = views.filter((v) => v.state === 'down').length;
  return { ok: downCount === 0, downCount };
}

function renderShell(title: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="robots" content="noindex" />
  <title>${escapeHtml(title)} · kuma-lite</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <style>
    .bar { width: 6px; height: 28px; border-radius: 2px; }
    .bar-up { background: #16a34a; }
    .bar-down { background: #dc2626; }
    .bar-partial { background: #eab308; }
    .bar-none { background: #1f2937; }
  </style>
</head>
<body class="bg-slate-950 text-slate-100 min-h-screen">
  <div class="max-w-4xl mx-auto px-4 py-10">
    ${body}
  </div>
</body>
</html>`;
}

function emptyState(): string {
  return `
    <header class="mb-6">
      <h1 class="text-2xl font-semibold">kuma-lite</h1>
      <p class="text-slate-400 mt-1">No monitors configured yet.</p>
    </header>
    <div class="bg-slate-900 rounded-lg p-6 border border-slate-800">
      <p class="text-slate-300">
        Add a monitor via the API:
      </p>
      <pre class="mt-3 bg-slate-950 p-3 rounded text-xs overflow-x-auto"><code>curl -X POST $WORKER_URL/api/monitors \\
  -H "Authorization: Bearer $API_TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{"name":"My Site","url":"https://example.com"}'</code></pre>
    </div>
  `;
}

function renderBody(
  views: MonitorView[],
  overall: { ok: boolean; downCount: number },
  now: number,
): string {
  const headerStatus = overall.ok
    ? `<span class="text-green-400">All systems operational</span>`
    : `<span class="text-red-400">${overall.downCount} monitor${overall.downCount === 1 ? '' : 's'} down</span>`;

  const cards = views.map((v) => renderCard(v, now)).join('\n');

  return `
    <header class="mb-8 flex items-center justify-between">
      <div>
        <h1 class="text-2xl font-semibold">Status</h1>
        <p class="text-sm text-slate-400 mt-1">${headerStatus}</p>
      </div>
      <div class="text-xs text-slate-500">
        Updated ${formatTime(now)}
      </div>
    </header>
    <main class="space-y-3">
      ${cards}
    </main>
    <footer class="mt-10 text-xs text-slate-500 text-center">
      Powered by kuma-lite on Cloudflare Workers
    </footer>
  `;
}

function renderCard(view: MonitorView, now: number): string {
  const isUp = view.state === 'up';
  const badge = isUp
    ? `<span class="inline-flex items-center gap-1.5 text-xs font-medium px-2 py-1 rounded-full bg-green-500/10 text-green-400 border border-green-500/30">
         <span class="w-1.5 h-1.5 rounded-full bg-green-400"></span> Operational
       </span>`
    : `<span class="inline-flex items-center gap-1.5 text-xs font-medium px-2 py-1 rounded-full bg-red-500/10 text-red-400 border border-red-500/30">
         <span class="w-1.5 h-1.5 rounded-full bg-red-400"></span> Down
       </span>`;

  const uptimeText =
    view.uptime24h === null ? '—' : `${view.uptime24h.toFixed(2)}%`;
  const latencyText =
    view.latestLatency === null ? '—' : `${view.latestLatency} ms`;
  const lastCheck =
    view.latestTs === null ? 'never' : `${formatRelative(now - view.latestTs)} ago`;

  const bars = view.buckets
    .map((b) => `<div class="bar bar-${b}" title="${b}"></div>`)
    .join('');

  return `
    <article class="bg-slate-900 border border-slate-800 rounded-lg p-4">
      <div class="flex items-start justify-between gap-3">
        <div class="min-w-0">
          <h2 class="font-medium truncate">${escapeHtml(view.monitor.name)}</h2>
          <a href="${escapeAttr(view.monitor.url)}" class="text-xs text-slate-400 hover:text-slate-200 truncate block" target="_blank" rel="noopener noreferrer">${escapeHtml(view.monitor.url)}</a>
        </div>
        ${badge}
      </div>
      <div class="mt-4 flex items-center gap-1">
        ${bars}
      </div>
      <div class="mt-3 grid grid-cols-3 gap-3 text-xs text-slate-400">
        <div>
          <div class="text-slate-500">Uptime (24h)</div>
          <div class="text-slate-200 mt-0.5">${uptimeText}</div>
        </div>
        <div>
          <div class="text-slate-500">Latency</div>
          <div class="text-slate-200 mt-0.5">${latencyText}</div>
        </div>
        <div>
          <div class="text-slate-500">Last check</div>
          <div class="text-slate-200 mt-0.5">${lastCheck}</div>
        </div>
      </div>
    </article>
  `;
}

function htmlResponse(html: string): Response {
  return new Response(html, {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'public, max-age=15',
    },
  });
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeAttr(s: string): string {
  return escapeHtml(s);
}

function formatTime(ts: number): string {
  return new Date(ts).toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
}

function formatRelative(ms: number): string {
  if (ms < 60_000) return `${Math.max(1, Math.floor(ms / 1000))}s`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h`;
  return `${Math.floor(ms / 86_400_000)}d`;
}
