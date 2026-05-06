import type { CheckStatus, Env, Monitor, MonitorState } from './types';

const TIMEZONE = 'Asia/Tokyo';
// Buffer between the cron tick (every minute at :00) and our reload, so the
// new check has time to fetch + write into D1 before we pull fresh data.
const REFRESH_BUFFER_MS = 5 * 1000;

type Scale = '60m' | '12h' | '24h' | '7d' | '30d';

interface ScaleConfig {
  /** Total window length in milliseconds. */
  ms: number;
  /** How many bars to render across that window. */
  buckets: number;
  /** Human-readable label for the <select>. */
  label: string;
  /** Short suffix used by the "Uptime · X" stat. */
  short: string;
}

const SCALES: Record<Scale, ScaleConfig> = {
  '60m': { ms: 60 * 60_000, buckets: 60, label: '直近60分', short: '60m' },
  '12h': { ms: 12 * 3_600_000, buckets: 60, label: '直近12時間', short: '12h' },
  '24h': { ms: 24 * 3_600_000, buckets: 60, label: '直近24時間', short: '24h' },
  '7d': { ms: 7 * 86_400_000, buckets: 84, label: '直近7日', short: '7d' },
  '30d': { ms: 30 * 86_400_000, buckets: 30, label: '直近30日', short: '30d' },
};

const SCALE_ORDER: Scale[] = ['60m', '12h', '24h', '7d', '30d'];
const DEFAULT_SCALE: Scale = '30d';
/**
 * Sample error messages are only meaningful when a single bucket likely
 * represents one incident. Past 24h the bucket spans hours-to-days and many
 * unrelated failures could share it — leaking just one would mislead.
 */
const SAMPLE_ERROR_MAX_SCALE_MS = 24 * 3_600_000;

function parseScale(input: string | null): Scale {
  if (input && Object.prototype.hasOwnProperty.call(SCALES, input)) {
    return input as Scale;
  }
  return DEFAULT_SCALE;
}

/**
 * Compute the next reload target aligned to the cron schedule, not to the
 * client's page-load instant. The minute-aligned target shared by server
 * and client guarantees that "Updated" and "Next refresh" advance together.
 */
function computeNextRefreshMs(now: number): number {
  const nextMinute = Math.ceil(now / 60_000) * 60_000;
  let target = nextMinute + REFRESH_BUFFER_MS;
  if (target - now < 3_000) target += 60_000;
  return target;
}

type BucketState = 'up' | 'down' | 'partial' | 'none';

interface BucketView {
  index: number;
  fromMs: number;
  toMs: number;
  state: BucketState;
  upCount: number;
  downCount: number;
  sampleError: string | null;
}

interface MonitorView {
  monitor: Monitor;
  state: CheckStatus;
  uptime: number | null;
  latestLatency: number | null;
  latestTs: number | null;
  buckets: BucketView[];
}

export async function renderStatusPage(env: Env, url: URL): Promise<Response> {
  const now = Date.now();
  const scale = parseScale(url.searchParams.get('scale'));
  const config = SCALES[scale];
  const windowMs = config.ms;
  const bucketCount = config.buckets;
  const bucketMs = Math.floor(windowMs / bucketCount);
  const sinceWindow = now - windowMs;

  const hidden = parseHidden(env.HIDDEN_MONITOR_IDS);

  const monitorsResult = await env.DB.prepare(
    `SELECT * FROM monitors WHERE enabled = 1 ORDER BY id ASC`,
  ).all<Monitor>();
  const monitors = (monitorsResult.results ?? []).filter((m) => !hidden.has(m.id));

  if (monitors.length === 0) {
    return htmlResponse(renderShell('No monitors configured', emptyState(), now, scale));
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

  // Aggregate per-bucket counts on the database side. Without this, a 30-day
  // window with one-minute checks would pull tens of thousands of rows back
  // into the Worker just to bucket them in JS.
  type BucketRow = {
    monitor_id: number;
    bucket_idx: number;
    total: number;
    ups: number;
    downs: number;
  };
  const aggregateResult = await env.DB.prepare(
    `SELECT monitor_id,
            CAST((ts - ?) / ? AS INTEGER) AS bucket_idx,
            COUNT(*) AS total,
            SUM(CASE WHEN status = 'up' THEN 1 ELSE 0 END) AS ups,
            SUM(CASE WHEN status = 'down' THEN 1 ELSE 0 END) AS downs
       FROM checks
      WHERE ts >= ? AND monitor_id IN (${placeholders})
      GROUP BY monitor_id, bucket_idx`,
  )
    .bind(sinceWindow, bucketMs, sinceWindow, ...ids)
    .all<BucketRow>();
  const bucketsByMonitor = new Map<number, Map<number, BucketRow>>();
  for (const row of aggregateResult.results ?? []) {
    let m = bucketsByMonitor.get(row.monitor_id);
    if (!m) {
      m = new Map();
      bucketsByMonitor.set(row.monitor_id, m);
    }
    m.set(row.bucket_idx, row);
  }

  // Sample errors only fetched for short scales. For wider windows, a single
  // sample error per bucket would conflate distinct incidents; the user can
  // click through to /incident for the actual list.
  const sampleErrorByKey = new Map<string, string>();
  if (windowMs <= SAMPLE_ERROR_MAX_SCALE_MS) {
    type ErrRow = { monitor_id: number; error: string | null; ts: number };
    const errResult = await env.DB.prepare(
      `SELECT monitor_id, error, ts FROM checks
        WHERE ts >= ? AND status = 'down' AND error IS NOT NULL
              AND monitor_id IN (${placeholders})
        ORDER BY ts DESC
        LIMIT 5000`,
    )
      .bind(sinceWindow, ...ids)
      .all<ErrRow>();
    for (const row of errResult.results ?? []) {
      const idx = Math.floor((row.ts - sinceWindow) / bucketMs);
      if (idx < 0 || idx >= bucketCount) continue;
      const key = `${row.monitor_id}:${idx}`;
      // First seen is most recent because we sorted DESC by ts.
      if (!sampleErrorByKey.has(key) && row.error) {
        sampleErrorByKey.set(key, row.error);
      }
    }
  }

  const views: MonitorView[] = monitors.map((monitor) => {
    const stateRow = stateById.get(monitor.id);
    const latest = latestById.get(monitor.id);
    const monitorBuckets = bucketsByMonitor.get(monitor.id) ?? new Map<number, BucketRow>();
    const buckets = buildBuckets(
      monitor.id,
      monitorBuckets,
      sampleErrorByKey,
      sinceWindow,
      bucketMs,
      bucketCount,
    );
    let totalChecks = 0;
    let totalUps = 0;
    for (const b of buckets) {
      totalChecks += b.upCount + b.downCount;
      totalUps += b.upCount;
    }
    return {
      monitor,
      state: stateRow?.current_status ?? 'up',
      uptime: totalChecks > 0 ? (totalUps / totalChecks) * 100 : null,
      latestLatency: latest?.latency_ms ?? null,
      latestTs: latest?.ts ?? null,
      buckets,
    };
  });

  const overall = computeOverall(views);
  const html = renderShell('Status', renderBody(views, overall, now, scale), now, scale);
  return htmlResponse(html);
}

function buildBuckets(
  monitorId: number,
  rows: Map<number, { ups: number; downs: number; total: number }>,
  sampleErrors: Map<string, string>,
  sinceWindow: number,
  bucketMs: number,
  bucketCount: number,
): BucketView[] {
  const out: BucketView[] = [];
  for (let i = 0; i < bucketCount; i++) {
    const fromMs = sinceWindow + i * bucketMs;
    const toMs = sinceWindow + (i + 1) * bucketMs;
    const row = rows.get(i);
    let state: BucketState = 'none';
    if (row && row.total > 0) {
      if (row.downs === 0) state = 'up';
      else if (row.ups === 0) state = 'down';
      else state = 'partial';
    }
    out.push({
      index: i,
      fromMs,
      toMs,
      state,
      upCount: row?.ups ?? 0,
      downCount: row?.downs ?? 0,
      sampleError: sampleErrors.get(`${monitorId}:${i}`) ?? null,
    });
  }
  return out;
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

function computeOverall(views: MonitorView[]): { ok: boolean; downCount: number } {
  const downCount = views.filter((v) => v.state === 'down').length;
  return { ok: downCount === 0, downCount };
}

function renderShell(title: string, body: string, now: number, scale: Scale): string {
  void now;
  return `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="robots" content="noindex" />
  <title>${escapeHtml(title)} · kuma-lite</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
  <script src="https://cdn.tailwindcss.com"></script>
  <script>
    tailwind.config = {
      theme: {
        extend: {
          fontFamily: {
            sans: ['"Plus Jakarta Sans"', 'system-ui', 'sans-serif'],
            mono: ['"JetBrains Mono"', 'ui-monospace', 'monospace'],
          },
        },
      },
    };
  </script>
  <style>
    :root {
      color-scheme: dark;
    }
    body {
      background:
        radial-gradient(1200px 600px at 80% -10%, rgba(34, 197, 94, 0.10), transparent 60%),
        radial-gradient(900px 500px at 0% 40%, rgba(59, 130, 246, 0.07), transparent 55%),
        #0a0f1c;
      min-height: 100vh;
    }
    .glass {
      background: rgba(15, 23, 42, 0.55);
      backdrop-filter: blur(14px) saturate(140%);
      -webkit-backdrop-filter: blur(14px) saturate(140%);
      border: 1px solid rgba(148, 163, 184, 0.10);
      transition: border-color 200ms ease, transform 200ms ease, box-shadow 200ms ease;
    }
    .glass:hover {
      border-color: rgba(148, 163, 184, 0.22);
      box-shadow: 0 8px 32px -12px rgba(34, 197, 94, 0.10);
    }
    .pulse-dot {
      box-shadow: 0 0 0 0 currentColor;
      animation: pulse-glow 2.4s cubic-bezier(0.4, 0, 0.6, 1) infinite;
    }
    @keyframes pulse-glow {
      0%, 100% { box-shadow: 0 0 0 0 currentColor; opacity: 1; }
      50%      { box-shadow: 0 0 0 6px transparent; opacity: 0.6; }
    }
    /* Each bar takes an equal share of the row so the strip spans the
       full card width regardless of bucket count or viewport. min-width
       keeps it scrollable-free on narrow screens. */
    .bar-row {
      display: flex;
      align-items: stretch;
      gap: 3px;
    }
    .bar {
      flex: 1 1 0;
      min-width: 3px;
      height: 36px;
      border-radius: 3px;
      transition: transform 180ms ease, filter 180ms ease;
    }
    .bar.is-clickable { cursor: pointer; }
    .bar.is-clickable:hover {
      transform: scaleY(1.12);
      filter: brightness(1.25);
    }
    .bar:focus-visible {
      outline: 2px solid rgba(148, 163, 184, 0.6);
      outline-offset: 2px;
    }
    .bar-up      { background: linear-gradient(180deg, #34d399 0%, #16a34a 100%); }
    .bar-down    { background: linear-gradient(180deg, #f87171 0%, #dc2626 100%); }
    .bar-partial { background: linear-gradient(180deg, #fbbf24 0%, #d97706 100%); }
    .bar-none    { background: rgba(100, 116, 139, 0.18); }
    select.scale-select {
      background: rgba(15, 23, 42, 0.6);
      border: 1px solid rgba(148, 163, 184, 0.18);
      border-radius: 8px;
      padding: 6px 32px 6px 12px;
      color: #e2e8f0;
      font-size: 12px;
      cursor: pointer;
      appearance: none;
      -webkit-appearance: none;
      background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 20 20' fill='%2394a3b8'><path d='M5 8l5 5 5-5z'/></svg>");
      background-repeat: no-repeat;
      background-position: right 10px center;
      transition: border-color 180ms ease, background-color 180ms ease;
    }
    select.scale-select:hover {
      border-color: rgba(148, 163, 184, 0.35);
    }
    select.scale-select:focus {
      outline: none;
      border-color: rgba(34, 197, 94, 0.6);
    }
    #tooltip {
      position: fixed;
      pointer-events: none;
      z-index: 50;
      max-width: 320px;
      opacity: 0;
      transform: translateY(-4px);
      transition: opacity 140ms ease, transform 140ms ease;
    }
    #tooltip.show {
      opacity: 1;
      transform: translateY(0);
    }
    .tooltip-card {
      background: rgba(15, 23, 42, 0.92);
      backdrop-filter: blur(12px);
      -webkit-backdrop-filter: blur(12px);
      border: 1px solid rgba(148, 163, 184, 0.18);
      border-radius: 10px;
      padding: 10px 12px;
      box-shadow: 0 16px 40px -12px rgba(0, 0, 0, 0.7);
      font-size: 12px;
      line-height: 1.5;
    }
    .refresh-ring {
      transition: stroke-dashoffset 1s linear;
    }
    @media (prefers-reduced-motion: reduce) {
      .pulse-dot { animation: none; }
      .bar.is-clickable:hover { transform: none; filter: none; }
      #tooltip { transition: none; }
      .refresh-ring { transition: none; }
    }
  </style>
</head>
<body class="text-slate-100 font-sans antialiased" data-scale="${scale}" data-window-ms="${SCALES[scale].ms}">
  <div class="max-w-4xl mx-auto px-4 py-10">
    ${body}
  </div>
  <div id="tooltip" role="tooltip" aria-hidden="true"><div class="tooltip-card"></div></div>
  ${renderClientScript()}
</body>
</html>`;
}

function emptyState(): string {
  return `
    <header class="mb-8">
      <h1 class="text-3xl font-semibold tracking-tight">kuma-lite</h1>
      <p class="text-slate-400 mt-2">No monitors configured yet.</p>
    </header>
    <div class="glass rounded-2xl p-6">
      <p class="text-slate-300 text-sm">Add a monitor via the API:</p>
      <pre class="mt-3 bg-slate-950/60 p-4 rounded-lg text-xs overflow-x-auto font-mono border border-slate-800"><code>curl -X POST $WORKER_URL/api/monitors \\
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
  scale: Scale,
): string {
  const config = SCALES[scale];
  const headerStatus = overall.ok
    ? `<div class="flex items-center gap-2.5">
         <span class="relative inline-flex">
           <span class="pulse-dot w-2.5 h-2.5 rounded-full text-green-400 bg-green-400"></span>
         </span>
         <span class="text-green-400 font-medium">All systems operational</span>
       </div>`
    : `<div class="flex items-center gap-2.5">
         <span class="relative inline-flex">
           <span class="pulse-dot w-2.5 h-2.5 rounded-full text-red-400 bg-red-400"></span>
         </span>
         <span class="text-red-400 font-medium">${overall.downCount} monitor${overall.downCount === 1 ? '' : 's'} down</span>
       </div>`;

  const cards = views.map((v) => renderCard(v, scale)).join('\n');
  const nextRefreshMs = computeNextRefreshMs(now);
  const scaleOptions = SCALE_ORDER.map(
    (key) =>
      `<option value="${key}"${key === scale ? ' selected' : ''}>${escapeHtml(SCALES[key].label)}</option>`,
  ).join('');

  return `
    <header class="mb-10">
      <div class="flex items-end justify-between gap-4 flex-wrap">
        <div>
          <p class="text-xs uppercase tracking-[0.18em] text-slate-500 mb-2">Service Status</p>
          <h1 class="text-3xl sm:text-4xl font-semibold tracking-tight">kuma-lite</h1>
          <div class="mt-3 text-sm">${headerStatus}</div>
        </div>
        <div class="flex items-center gap-4 flex-wrap">
          <div class="flex items-center gap-2">
            <label for="scale-select" class="text-[10px] uppercase tracking-wider text-slate-500">Range</label>
            <select id="scale-select" class="scale-select" aria-label="Time scale">
              ${scaleOptions}
            </select>
          </div>
          <div class="flex items-center gap-3 text-xs text-slate-400" data-next-refresh="${nextRefreshMs}">
            <svg class="w-10 h-10" viewBox="0 0 36 36" aria-hidden="true">
              <circle cx="18" cy="18" r="15" fill="none" stroke="rgba(148,163,184,0.18)" stroke-width="2"/>
              <circle id="refresh-ring" class="refresh-ring" cx="18" cy="18" r="15" fill="none"
                      stroke="rgba(34,197,94,0.85)" stroke-width="2"
                      stroke-linecap="round" stroke-dasharray="94.2" stroke-dashoffset="94.2"
                      transform="rotate(-90 18 18)"/>
            </svg>
            <div class="flex flex-col leading-tight">
              <span class="text-slate-300">Updated</span>
              <span class="text-slate-200 tabular-nums" data-jst-datetime="${now}">${formatJstDateTime(now)}</span>
              <span class="mt-1 text-[11px] text-slate-500">
                Next refresh
                <span class="text-slate-400 tabular-nums" data-jst-time-secs="${nextRefreshMs}">${formatJstTimeSecs(nextRefreshMs)}</span>
                · <span id="refresh-countdown" class="tabular-nums">—</span>s
              </span>
            </div>
          </div>
        </div>
      </div>
    </header>
    <main class="space-y-4">
      ${cards}
    </main>
    <footer class="mt-12 pt-6 border-t border-slate-800/50 text-xs text-slate-500 text-center">
      Powered by kuma-lite on Cloudflare Workers · ${escapeHtml(config.label)}
    </footer>
  `;
}

function renderCard(view: MonitorView, scale: Scale): string {
  const config = SCALES[scale];
  const isUp = view.state === 'up';
  const badge = isUp
    ? `<span class="inline-flex items-center gap-1.5 text-[11px] font-medium px-2.5 py-1 rounded-full bg-green-500/10 text-green-300 border border-green-500/30">
         <span class="w-1.5 h-1.5 rounded-full bg-green-400"></span> Operational
       </span>`
    : `<span class="inline-flex items-center gap-1.5 text-[11px] font-medium px-2.5 py-1 rounded-full bg-red-500/10 text-red-300 border border-red-500/30">
         <span class="w-1.5 h-1.5 rounded-full bg-red-400"></span> Down
       </span>`;

  const uptimeText = view.uptime === null ? '—' : `${view.uptime.toFixed(2)}%`;
  const latencyText = view.latestLatency === null ? '—' : `${view.latestLatency} ms`;
  const lastCheck =
    view.latestTs === null ? 'never' : `${formatRelative(Date.now() - view.latestTs)} ago`;

  const monitorId = view.monitor.id;
  const bars = view.buckets
    .map((b) => {
      const isClickable = b.state === 'down' || b.state === 'partial';
      const tag = isClickable ? 'a' : 'span';
      const href = isClickable
        ? ` href="/incident?monitor_id=${monitorId}&from=${b.fromMs}&to=${b.toMs}"`
        : '';
      const role = isClickable
        ? ' role="button" tabindex="0"'
        : ' aria-hidden="true"';
      const sampleError = b.sampleError
        ? ` data-error="${escapeAttr(truncate(b.sampleError, 200))}"`
        : '';
      const cls = `bar bar-${b.state}${isClickable ? ' is-clickable' : ''}`;
      return `<${tag}${href} class="${cls}"${role}
        data-from="${b.fromMs}" data-to="${b.toMs}"
        data-state="${b.state}"${sampleError}></${tag}>`;
    })
    .join('');

  const windowStart = view.buckets[0]?.fromMs ?? Date.now() - config.ms;
  const windowEnd = view.buckets[view.buckets.length - 1]?.toMs ?? Date.now();
  const useDateLabels = config.ms > 24 * 3_600_000;
  const startLabel = useDateLabels ? formatJstShortDate(windowStart) : formatJstTime(windowStart);
  const endLabel = useDateLabels ? formatJstShortDate(windowEnd) : formatJstTime(windowEnd);

  return `
    <article class="glass rounded-2xl p-5">
      <div class="flex items-start justify-between gap-4">
        <div class="min-w-0 flex-1">
          <h2 class="font-semibold text-slate-100 truncate">${escapeHtml(view.monitor.name)}</h2>
          <a href="${escapeAttr(view.monitor.url)}" target="_blank" rel="noopener noreferrer"
             class="mt-0.5 text-xs text-slate-400 hover:text-slate-200 truncate block transition-colors">
            ${escapeHtml(view.monitor.url)}
          </a>
        </div>
        ${badge}
      </div>

      <div class="mt-5">
        <div class="bar-row" role="img"
             aria-label="${escapeAttr(config.label)} timeline for ${escapeAttr(view.monitor.name)}">
          ${bars}
        </div>
        <div class="mt-2 flex justify-between text-[10px] text-slate-500 font-mono tabular-nums">
          <span data-jst-${useDateLabels ? 'shortdate' : 'time'}="${windowStart}">${startLabel}</span>
          <span class="text-slate-600">${escapeHtml(config.label)} · JST</span>
          <span data-jst-${useDateLabels ? 'shortdate' : 'time'}="${windowEnd}">${endLabel}</span>
        </div>
      </div>

      <div class="mt-4 grid grid-cols-3 gap-3 text-xs">
        <div>
          <div class="text-slate-500 uppercase tracking-wider text-[10px]">Uptime · ${escapeHtml(config.short)}</div>
          <div class="text-slate-100 font-medium mt-1 tabular-nums">${uptimeText}</div>
        </div>
        <div>
          <div class="text-slate-500 uppercase tracking-wider text-[10px]">Latency</div>
          <div class="text-slate-100 font-medium mt-1 tabular-nums">${latencyText}</div>
        </div>
        <div>
          <div class="text-slate-500 uppercase tracking-wider text-[10px]">Last check</div>
          <div class="text-slate-100 font-medium mt-1">${lastCheck}</div>
        </div>
      </div>
    </article>
  `;
}

function renderClientScript(): string {
  // Pure vanilla, no build step. Wires:
  //   1. The bar tooltip (hover + keyboard focus). Bucket-spanning windows
  //      ≥ 1 day get a date-only label; sub-day ranges show HH:MM – HH:MM.
  //      Healthy / no-data buckets get a clean two-liner with no CTA.
  //   2. The cron-aligned auto-refresh timer (server-supplied target,
  //      pause-on-interaction, ring countdown over 60s window).
  //   3. The scale <select>: navigates to ?scale=… while preserving any
  //      other query params.
  //   4. Live JST timestamp formatting on [data-jst-*] attributes.
  const script = `
(function () {
  const TZ = ${JSON.stringify(TIMEZONE)};
  const REFRESH_BUFFER_MS = ${REFRESH_BUFFER_MS};
  const RING_WINDOW_MS = 60000;
  const RING_LEN = 94.2;
  const PAUSE_GRACE_MS = 2500;
  const ONE_DAY_MS = 86400000;
  const ONE_HOUR_MS = 3600000;
  const fmtDateTime = new Intl.DateTimeFormat('ja-JP', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  });
  const fmtTime = new Intl.DateTimeFormat('ja-JP', {
    timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const fmtTimeSecs = new Intl.DateTimeFormat('ja-JP', {
    timeZone: TZ, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  });
  const fmtShortDate = new Intl.DateTimeFormat('ja-JP', {
    timeZone: TZ, month: '2-digit', day: '2-digit',
  });
  const fmtFullDate = new Intl.DateTimeFormat('ja-JP', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  });
  function formatDateTime(ts) {
    const parts = fmtDateTime.formatToParts(new Date(Number(ts)));
    const get = (t) => (parts.find((p) => p.type === t) || {}).value || '';
    return get('year') + '-' + get('month') + '-' + get('day') + ' ' +
           get('hour') + ':' + get('minute') + ':' + get('second') + ' JST';
  }
  function formatTime(ts) { return fmtTime.format(new Date(Number(ts))); }
  function formatTimeSecs(ts) { return fmtTimeSecs.format(new Date(Number(ts))); }
  function formatShortDate(ts) {
    return fmtShortDate.format(new Date(Number(ts))).replace(/\\//g, '-');
  }
  function formatFullDate(ts) {
    return fmtFullDate.format(new Date(Number(ts))).replace(/\\//g, '-');
  }
  function nextCronRefresh() {
    const now = Date.now();
    const nextMinute = Math.ceil(now / 60000) * 60000;
    let target = nextMinute + REFRESH_BUFFER_MS;
    if (target - now < 3000) target += 60000;
    return target;
  }

  // --- Tooltip ---
  const tip = document.getElementById('tooltip');
  const tipCard = tip.firstElementChild;
  const STATE_LABEL = {
    up: 'Operating normally',
    down: 'Outage',
    partial: 'Partial outage',
    none: 'No data',
  };
  const STATE_COLOR = {
    up: 'text-green-300',
    down: 'text-red-300',
    partial: 'text-amber-300',
    none: 'text-slate-400',
  };
  function formatBucketRange(fromTs, toTs) {
    const span = toTs - fromTs;
    if (span >= ONE_DAY_MS) {
      // Day-scale bucket: show only the calendar date(s) it covers.
      const start = formatFullDate(fromTs);
      const end = formatFullDate(toTs - 1);
      return start === end ? start : start + ' – ' + end;
    }
    if (span >= ONE_HOUR_MS) {
      // Multi-hour bucket: include the date so users on a long scale can
      // tell which day they're hovering.
      return formatFullDate(fromTs) + ' ' + formatTime(fromTs) +
             ' – ' + formatTime(toTs);
    }
    return formatTime(fromTs) + ' – ' + formatTime(toTs);
  }
  function showTooltip(el, evt) {
    const state = el.dataset.state;
    const fromTs = Number(el.dataset.from);
    const toTs = Number(el.dataset.to);
    const error = el.dataset.error;
    const isIncident = state === 'down' || state === 'partial';
    tipCard.innerHTML = [
      '<div class="text-slate-200 font-medium tabular-nums">' +
        formatBucketRange(fromTs, toTs) +
      '</div>',
      '<div class="mt-1 ' + (STATE_COLOR[state] || '') + ' font-medium uppercase tracking-wider text-[10px]">' +
        (STATE_LABEL[state] || state) +
      '</div>',
      isIncident && error
        ? '<div class="mt-2 pt-2 border-t border-slate-700/60 text-slate-300 font-mono text-[11px] break-all">' + escapeText(error) + '</div>'
        : '',
      isIncident
        ? '<div class="mt-2 text-[10px] text-slate-500">Click to inspect</div>'
        : '',
    ].join('');
    positionTooltip(evt);
    tip.classList.add('show');
    tip.setAttribute('aria-hidden', 'false');
  }
  function positionTooltip(evt) {
    const x = evt.clientX || 0;
    const y = evt.clientY || 0;
    const tipW = tip.offsetWidth;
    const tipH = tip.offsetHeight;
    const padding = 12;
    let left = x + 14;
    let top = y - tipH - 12;
    if (left + tipW + padding > window.innerWidth) left = x - tipW - 14;
    if (top < padding) top = y + 18;
    tip.style.left = left + 'px';
    tip.style.top = top + 'px';
  }
  function hideTooltip() {
    tip.classList.remove('show');
    tip.setAttribute('aria-hidden', 'true');
  }
  function escapeText(s) {
    const d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
  }
  document.querySelectorAll('.bar').forEach((bar) => {
    bar.addEventListener('mouseenter', (e) => showTooltip(bar, e));
    bar.addEventListener('mousemove', positionTooltip);
    bar.addEventListener('mouseleave', hideTooltip);
    bar.addEventListener('focus', () => {
      const r = bar.getBoundingClientRect();
      showTooltip(bar, { clientX: r.left + r.width / 2, clientY: r.top });
    });
    bar.addEventListener('blur', hideTooltip);
  });

  // --- Auto-refresh aligned to cron ---
  const refreshContainer = document.querySelector('[data-next-refresh]');
  const ring = document.getElementById('refresh-ring');
  const countdownEl = document.getElementById('refresh-countdown');
  let target = refreshContainer ? Number(refreshContainer.dataset.nextRefresh) : NaN;
  if (!Number.isFinite(target) || target <= Date.now()) {
    target = nextCronRefresh();
    if (refreshContainer) refreshContainer.dataset.nextRefresh = String(target);
  }
  let lastInteractionAt = 0;
  function isInteracting() {
    return Date.now() - lastInteractionAt < PAUSE_GRACE_MS;
  }
  function updateNextRefreshLabel() {
    const el = document.querySelector('[data-jst-time-secs]');
    if (el) {
      el.dataset.jstTimeSecs = String(target);
      el.textContent = formatTimeSecs(target);
    }
  }
  function tick() {
    const now = Date.now();
    const remainingMs = target - now;
    if (remainingMs <= 0) {
      if (!isInteracting()) {
        window.location.reload();
        return;
      }
      target = nextCronRefresh();
      updateNextRefreshLabel();
      return;
    }
    if (countdownEl) countdownEl.textContent = String(Math.ceil(remainingMs / 1000));
    if (ring) {
      const elapsed = Math.max(0, RING_WINDOW_MS - remainingMs);
      const progress = Math.min(1, elapsed / RING_WINDOW_MS);
      ring.setAttribute('stroke-dashoffset', String((1 - progress) * RING_LEN));
    }
  }
  setInterval(tick, 250);
  tick();
  ['mousemove', 'mousedown', 'keydown', 'touchstart'].forEach((evt) => {
    document.addEventListener(evt, () => { lastInteractionAt = Date.now(); }, { passive: true });
  });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) lastInteractionAt = 0;
  });

  // --- Scale selector ---
  const scaleSelect = document.getElementById('scale-select');
  if (scaleSelect) {
    scaleSelect.addEventListener('change', function () {
      const u = new URL(window.location.href);
      u.searchParams.set('scale', this.value);
      window.location.href = u.toString();
    });
  }

  // --- Live JST timestamp formatting ---
  document.querySelectorAll('[data-jst-datetime]').forEach((el) => {
    const v = el.dataset.jstDatetime;
    if (!v || v === 'null') return;
    el.textContent = formatDateTime(v);
  });
  document.querySelectorAll('[data-jst-time]').forEach((el) => {
    el.textContent = formatTime(el.dataset.jstTime);
  });
  document.querySelectorAll('[data-jst-time-secs]').forEach((el) => {
    el.textContent = formatTimeSecs(el.dataset.jstTimeSecs);
  });
  document.querySelectorAll('[data-jst-shortdate]').forEach((el) => {
    el.textContent = formatShortDate(el.dataset.jstShortdate);
  });
})();
`;
  return `<script>${script}</script>`;
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

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function jstParts(ts: number): Record<Intl.DateTimeFormatPartTypes, string> {
  const fmt = new Intl.DateTimeFormat('ja-JP', {
    timeZone: TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const out: Partial<Record<Intl.DateTimeFormatPartTypes, string>> = {};
  for (const part of fmt.formatToParts(new Date(ts))) {
    out[part.type] = part.value;
  }
  return out as Record<Intl.DateTimeFormatPartTypes, string>;
}

export function formatJstDateTime(ts: number): string {
  const p = jstParts(ts);
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second} JST`;
}

export function formatJstTime(ts: number): string {
  const p = jstParts(ts);
  return `${p.hour}:${p.minute}`;
}

export function formatJstTimeSecs(ts: number): string {
  const p = jstParts(ts);
  return `${p.hour}:${p.minute}:${p.second}`;
}

export function formatJstShortDate(ts: number): string {
  const p = jstParts(ts);
  return `${p.month}-${p.day}`;
}

function formatRelative(ms: number): string {
  if (ms < 60_000) return `${Math.max(1, Math.floor(ms / 1000))}s`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h`;
  return `${Math.floor(ms / 86_400_000)}d`;
}
