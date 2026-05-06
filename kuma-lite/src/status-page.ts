import type { CheckRow, CheckStatus, Env, Monitor, MonitorState } from './types';

const WINDOW_MS = 90 * 60 * 1000; // 90 minutes
const BUCKET_MS = 3 * 60 * 1000; // 3 minutes
const BUCKET_COUNT = WINDOW_MS / BUCKET_MS; // 30
// Buffer between the cron tick (every minute at :00) and our reload, so the
// new check has time to fetch + write into D1 before we pull fresh data.
const REFRESH_BUFFER_MS = 5 * 1000;
const TIMEZONE = 'Asia/Tokyo';

/**
 * Compute the next reload target aligned to the cron schedule, not to the
 * client's page-load instant. The minute-aligned target shared by server
 * and client guarantees that:
 *   1. The countdown tracks real cron freshness, not a per-client phase.
 *   2. The "Updated" timestamp on the next render is roughly 60s after
 *      this one (the cron interval), so the two no longer drift.
 *   3. Mouse activity defers the reload past the missed boundary instead
 *      of resetting the timer relative to the user.
 */
function computeNextRefreshMs(now: number): number {
  const nextMinute = Math.ceil(now / 60_000) * 60_000;
  let target = nextMinute + REFRESH_BUFFER_MS;
  // If the buffer window is closing in less than 3s, the freshly-baked
  // cron data may still be in flight — push to the following minute.
  if (target - now < 3_000) target += 60_000;
  return target;
}

interface MonitorView {
  monitor: Monitor;
  state: CheckStatus;
  uptime24h: number | null;
  latestLatency: number | null;
  latestTs: number | null;
  buckets: BucketView[];
}

interface BucketView {
  index: number;
  fromMs: number;
  toMs: number;
  state: BucketState;
  upCount: number;
  downCount: number;
  /** Sample error from the most recent down check in this bucket. */
  sampleError: string | null;
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
    return htmlResponse(renderShell('No monitors configured', emptyState(), now));
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
    `SELECT monitor_id, status, error, ts FROM checks
      WHERE ts >= ? AND monitor_id IN (${placeholders})
      ORDER BY ts ASC`,
  )
    .bind(sinceWindow, ...ids)
    .all<Pick<CheckRow, 'monitor_id' | 'status' | 'error' | 'ts'>>();
  const recentByMonitor = new Map<number, RecentCheck[]>();
  for (const row of recentResult.results ?? []) {
    const list = recentByMonitor.get(row.monitor_id) ?? [];
    list.push({ status: row.status, ts: row.ts, error: row.error });
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
  const html = renderShell('Status', renderBody(views, overall, now), now);
  return htmlResponse(html);
}

interface RecentCheck {
  status: CheckStatus;
  ts: number;
  error: string | null;
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

function computeBuckets(rows: RecentCheck[], start: number): BucketView[] {
  const buckets: BucketView[] = Array.from({ length: BUCKET_COUNT }, (_, i) => ({
    index: i,
    fromMs: start + i * BUCKET_MS,
    toMs: start + (i + 1) * BUCKET_MS,
    state: 'none' as BucketState,
    upCount: 0,
    downCount: 0,
    sampleError: null,
  }));
  for (const row of rows) {
    const idx = Math.floor((row.ts - start) / BUCKET_MS);
    if (idx < 0 || idx >= BUCKET_COUNT) continue;
    const b = buckets[idx];
    if (!b) continue;
    if (row.status === 'up') {
      b.upCount += 1;
    } else {
      b.downCount += 1;
      // Keep the most recent down error as the representative sample.
      if (row.error) b.sampleError = row.error;
    }
  }
  for (const b of buckets) {
    if (b.upCount === 0 && b.downCount === 0) b.state = 'none';
    else if (b.downCount === 0) b.state = 'up';
    else if (b.upCount === 0) b.state = 'down';
    else b.state = 'partial';
  }
  return buckets;
}

function computeOverall(views: MonitorView[]): { ok: boolean; downCount: number } {
  const downCount = views.filter((v) => v.state === 'down').length;
  return { ok: downCount === 0, downCount };
}

function renderShell(title: string, body: string, now: number): string {
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
    .bar {
      width: 8px;
      height: 36px;
      border-radius: 3px;
      cursor: pointer;
      transition: transform 180ms ease, filter 180ms ease;
    }
    .bar:hover {
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
    .bar-none {
      background: rgba(148, 163, 184, 0.10);
      cursor: default;
    }
    .bar-none:hover { transform: none; filter: none; }
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
      .bar:hover { transform: none; filter: none; }
      #tooltip { transition: none; }
      .refresh-ring { transition: none; }
    }
  </style>
</head>
<body class="text-slate-100 font-sans antialiased">
  <div class="max-w-4xl mx-auto px-4 py-10">
    ${body}
  </div>
  <div id="tooltip" role="tooltip" aria-hidden="true"><div class="tooltip-card"></div></div>
  ${renderClientScript(now)}
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
): string {
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

  const cards = views.map((v) => renderCard(v, now)).join('\n');
  const nextRefreshMs = computeNextRefreshMs(now);

  return `
    <header class="mb-10">
      <div class="flex items-end justify-between gap-4 flex-wrap">
        <div>
          <p class="text-xs uppercase tracking-[0.18em] text-slate-500 mb-2">Service Status</p>
          <h1 class="text-3xl sm:text-4xl font-semibold tracking-tight">kuma-lite</h1>
          <div class="mt-3 text-sm">${headerStatus}</div>
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
    </header>
    <main class="space-y-4">
      ${cards}
    </main>
    <footer class="mt-12 pt-6 border-t border-slate-800/50 text-xs text-slate-500 text-center">
      Powered by kuma-lite on Cloudflare Workers
    </footer>
  `;
}

function renderCard(view: MonitorView, now: number): string {
  const isUp = view.state === 'up';
  const badge = isUp
    ? `<span class="inline-flex items-center gap-1.5 text-[11px] font-medium px-2.5 py-1 rounded-full bg-green-500/10 text-green-300 border border-green-500/30">
         <span class="w-1.5 h-1.5 rounded-full bg-green-400"></span> Operational
       </span>`
    : `<span class="inline-flex items-center gap-1.5 text-[11px] font-medium px-2.5 py-1 rounded-full bg-red-500/10 text-red-300 border border-red-500/30">
         <span class="w-1.5 h-1.5 rounded-full bg-red-400"></span> Down
       </span>`;

  const uptimeText = view.uptime24h === null ? '—' : `${view.uptime24h.toFixed(2)}%`;
  const latencyText = view.latestLatency === null ? '—' : `${view.latestLatency} ms`;
  const lastCheck =
    view.latestTs === null ? 'never' : `${formatRelative(now - view.latestTs)} ago`;

  const monitorId = view.monitor.id;
  const bars = view.buckets
    .map((b) => {
      const isClickable = b.state !== 'none';
      const tag = isClickable ? 'a' : 'span';
      const href = isClickable
        ? ` href="/incident?monitor_id=${monitorId}&from=${b.fromMs}&to=${b.toMs}"`
        : '';
      const role = isClickable ? ' role="button" tabindex="0"' : ' aria-hidden="true"';
      const sampleError = b.sampleError
        ? ` data-error="${escapeAttr(truncate(b.sampleError, 200))}"`
        : '';
      return `<${tag}${href} class="bar bar-${b.state}"${role}
        data-from="${b.fromMs}" data-to="${b.toMs}"
        data-state="${b.state}" data-up="${b.upCount}" data-down="${b.downCount}"${sampleError}></${tag}>`;
    })
    .join('');

  const windowStart = view.buckets[0]?.fromMs ?? now - WINDOW_MS;
  const windowEnd = view.buckets[view.buckets.length - 1]?.toMs ?? now;

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
        <div class="flex items-center gap-[3px]" role="img"
             aria-label="Last 90 minutes timeline for ${escapeAttr(view.monitor.name)}">
          ${bars}
        </div>
        <div class="mt-2 flex justify-between text-[10px] text-slate-500 font-mono tabular-nums">
          <span data-jst-time="${windowStart}">${formatJstTime(windowStart)}</span>
          <span class="text-slate-600">90 min window · JST</span>
          <span data-jst-time="${windowEnd}">${formatJstTime(windowEnd)}</span>
        </div>
      </div>

      <div class="mt-4 grid grid-cols-3 gap-3 text-xs">
        <div>
          <div class="text-slate-500 uppercase tracking-wider text-[10px]">Uptime · 24h</div>
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

function renderClientScript(now: number): string {
  // The script is intentionally vanilla (no build step). It:
  //   1. Wires the bar tooltip (hover on desktop, focus for keyboard)
  //   2. Counts down to a server-supplied absolute target (cron-aligned).
  //      User interaction does NOT reset the target; if the user is mid-
  //      interaction when the target arrives, we defer to the *next* cron
  //      mark. This keeps "Updated" and "Next refresh" in sync.
  //   3. Animates the SVG ring as a countdown indicator over the most
  //      recent 60-second window.
  //   4. Re-formats [data-jst-*] timestamps client-side using
  //      Intl.DateTimeFormat with the Asia/Tokyo timezone.
  const script = `
(function () {
  const TZ = ${JSON.stringify(TIMEZONE)};
  const REFRESH_BUFFER_MS = ${REFRESH_BUFFER_MS};
  const RING_WINDOW_MS = 60000;
  const RING_LEN = 94.2;       // 2 * pi * 15
  const PAUSE_GRACE_MS = 2500; // user-interaction debounce
  const jstDate = new Intl.DateTimeFormat('ja-JP', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  });
  const jstTime = new Intl.DateTimeFormat('ja-JP', {
    timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const jstTimeSecs = new Intl.DateTimeFormat('ja-JP', {
    timeZone: TZ, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  });
  function formatDateTime(ts) {
    const parts = jstDate.formatToParts(new Date(Number(ts)));
    const get = (t) => (parts.find((p) => p.type === t) || {}).value || '';
    return get('year') + '-' + get('month') + '-' + get('day') + ' ' +
           get('hour') + ':' + get('minute') + ':' + get('second') + ' JST';
  }
  function formatTime(ts) {
    return jstTime.format(new Date(Number(ts)));
  }
  function formatTimeSecs(ts) {
    return jstTimeSecs.format(new Date(Number(ts)));
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
    up: 'All checks passed',
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
  function showTooltip(el, evt) {
    const state = el.dataset.state;
    if (state === 'none') return;
    const fromTs = Number(el.dataset.from);
    const toTs = Number(el.dataset.to);
    const up = el.dataset.up;
    const down = el.dataset.down;
    const error = el.dataset.error;
    const total = Number(up) + Number(down);
    tipCard.innerHTML = [
      '<div class="text-slate-200 font-medium tabular-nums">' +
        formatTime(fromTs) + ' – ' + formatTime(toTs) +
      '</div>',
      '<div class="mt-1 ' + (STATE_COLOR[state] || '') + ' font-medium uppercase tracking-wider text-[10px]">' +
        (STATE_LABEL[state] || state) +
      '</div>',
      '<div class="mt-1.5 text-slate-400">' + total + ' check' + (total === 1 ? '' : 's') +
        ' · <span class="text-green-300">' + up + ' up</span>' +
        ' · <span class="text-red-300">' + down + ' down</span>' +
      '</div>',
      error
        ? '<div class="mt-2 pt-2 border-t border-slate-700/60 text-slate-300 font-mono text-[11px] break-all">' + escapeText(error) + '</div>'
        : '',
      '<div class="mt-2 text-[10px] text-slate-500">Click to inspect</div>',
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
    bar.addEventListener('focus', (e) => {
      const r = bar.getBoundingClientRect();
      showTooltip(bar, { clientX: r.left + r.width / 2, clientY: r.top });
    });
    bar.addEventListener('blur', hideTooltip);
  });

  // --- Auto-refresh aligned to the server-side cron schedule ---
  // The server passes the next absolute reload target on the timer container
  // (data-next-refresh). The client never resets this target on interaction —
  // it only defers past it, so "Updated" and "Next refresh" stay in sync.
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
      // User is mid-interaction. Defer to the next cron mark and keep ticking;
      // the displayed countdown jumps forward but the visible "Next refresh"
      // time updates with it, so nothing is misleading.
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
    if (!document.hidden) {
      // Discard any stale interaction marker; if the cron mark passed while
      // hidden, the next tick will reload immediately.
      lastInteractionAt = 0;
    }
  });

  // --- Live JST timestamp formatting ---
  document.querySelectorAll('[data-jst-datetime]').forEach((el) => {
    el.textContent = formatDateTime(el.dataset.jstDatetime);
  });
  document.querySelectorAll('[data-jst-time]').forEach((el) => {
    el.textContent = formatTime(el.dataset.jstTime);
  });
  document.querySelectorAll('[data-jst-time-secs]').forEach((el) => {
    el.textContent = formatTimeSecs(el.dataset.jstTimeSecs);
  });
})();
`;
  // The `now` value is intentionally not interpolated into the script; the
  // server-rendered timestamps inside `data-jst-*` attributes already carry
  // the canonical times. We just expose `now` here for any future use.
  void now;
  return `<script>${script}</script>`;
}

function htmlResponse(html: string): Response {
  return new Response(html, {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      // Short cache so the page reflects the most recent cron tick on reload,
      // while keeping CF edge cache benefit for bursty refresh storms.
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

function formatRelative(ms: number): string {
  if (ms < 60_000) return `${Math.max(1, Math.floor(ms / 1000))}s`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h`;
  return `${Math.floor(ms / 86_400_000)}d`;
}
