import type {
  CheckStatus,
  ComponentHealth,
  Env,
  Monitor,
  MonitorState,
} from './types';
import { classify, KIND_HEADLINE } from './kinds';
import { publicFacingUrl } from './url-display';

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
  '60m': { ms: 60 * 60_000, buckets: 60, label: '直近60分', short: '60分' },
  '12h': { ms: 12 * 3_600_000, buckets: 60, label: '直近12時間', short: '12時間' },
  '24h': { ms: 24 * 3_600_000, buckets: 60, label: '直近24時間', short: '24時間' },
  '7d': { ms: 7 * 86_400_000, buckets: 84, label: '直近7日', short: '7日' },
  '30d': { ms: 30 * 86_400_000, buckets: 30, label: '直近30日', short: '30日' },
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

/**
 * Bucket-level visual state. Adds 'maintenance' (blue) which takes
 * precedence over up/down for buckets that fell entirely inside a
 * declared maintenance window, so calendar bars communicate "expected
 * downtime" instead of "incident".
 */
type BucketState = 'up' | 'down' | 'partial' | 'maintenance' | 'none';

/**
 * Effective state shown on the per-monitor badge and the global header.
 * Tracks the structured /healthz status now that it lands on the
 * monitor — 'degraded' fires when the latest healthz reports degraded
 * (or when the fallback URL responded but the primary /healthz did
 * not). 'maintenance' overrides everything when the monitor is inside
 * a declared window.
 */
type EffectiveState = 'up' | 'degraded' | 'down' | 'maintenance';

interface BucketView {
  index: number;
  fromMs: number;
  toMs: number;
  state: BucketState;
  upCount: number;
  downCount: number;
  /**
   * Human-readable label for the dominant failure in this bucket
   * (e.g. "システムエラー", "応答遅延"). Replaces the previous
   * implementation that surfaced the raw error string — non-technical
   * readers couldn't make sense of "Expected status 200, got 520:
   * error code: 520" so we now classify the error and show the
   * categorised wording instead.
   */
  sampleLabel: string | null;
}

interface MaintenanceView {
  fromMs: number;
  toMs: number;
  reason: string;
  /** True when the current time is inside [fromMs, toMs). */
  active: boolean;
}

interface MonitorView {
  monitor: Monitor;
  state: CheckStatus;
  effState: EffectiveState;
  uptime: number | null;
  latestLatency: number | null;
  latestTs: number | null;
  buckets: BucketView[];
  /** Latest healthz_reason captured from the most recent check. */
  latestReason: string | null;
  /** Latest healthz components (already parsed). */
  latestComponents: ComponentHealth[];
  latestVersion: string | null;
  maintenance: MaintenanceView | null;
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
    `SELECT c.monitor_id, c.latency_ms, c.ts, c.healthz_reason, c.healthz_components, c.healthz_version
       FROM checks c
       JOIN (
         SELECT monitor_id, MAX(ts) AS max_ts
           FROM checks
          WHERE monitor_id IN (${placeholders})
          GROUP BY monitor_id
       ) m ON m.monitor_id = c.monitor_id AND m.max_ts = c.ts`,
  )
    .bind(...ids)
    .all<{
      monitor_id: number;
      latency_ms: number | null;
      ts: number;
      healthz_reason: string | null;
      healthz_components: string | null;
      healthz_version: string | null;
    }>();
  const latestById = new Map<
    number,
    {
      latency_ms: number | null;
      ts: number;
      healthz_reason: string | null;
      healthz_components: string | null;
      healthz_version: string | null;
    }
  >();
  for (const row of latestResult.results ?? []) {
    latestById.set(row.monitor_id, {
      latency_ms: row.latency_ms,
      ts: row.ts,
      healthz_reason: row.healthz_reason,
      healthz_components: row.healthz_components,
      healthz_version: row.healthz_version,
    });
  }

  // Aggregate per-bucket counts on the database side. Without this, a 30-day
  // window with one-minute checks would pull tens of thousands of rows back
  // into the Worker just to bucket them in JS. Maintenance checks are
  // separated so the bar can be coloured blue and excluded from uptime %.
  type BucketRow = {
    monitor_id: number;
    bucket_idx: number;
    total: number;
    ups: number;
    downs: number;
    maints: number;
  };
  const aggregateResult = await env.DB.prepare(
    `SELECT monitor_id,
            CAST((ts - ?) / ? AS INTEGER) AS bucket_idx,
            COUNT(*) AS total,
            SUM(CASE WHEN status = 'up' AND in_maintenance = 0 THEN 1 ELSE 0 END) AS ups,
            SUM(CASE WHEN status = 'down' AND in_maintenance = 0 THEN 1 ELSE 0 END) AS downs,
            SUM(CASE WHEN in_maintenance = 1 THEN 1 ELSE 0 END) AS maints
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

  // Sample-error labels only fetched for short scales. For wider windows,
  // one bucket can span hours-to-days of unrelated incidents and a single
  // sample would mislead. Inside the supported window, we classify the
  // most recent down check per (monitor, bucket) into a kind and store
  // its human-readable headline ("システムエラー", "応答遅延", etc.). The
  // healthz_reason takes precedence when present so the tooltip uses
  // the business-language reason from the monitored site verbatim.
  const sampleLabelByKey = new Map<string, string>();
  if (windowMs <= SAMPLE_ERROR_MAX_SCALE_MS) {
    type ErrRow = {
      monitor_id: number;
      error: string | null;
      status_code: number | null;
      healthz_reason: string | null;
      ts: number;
    };
    const errResult = await env.DB.prepare(
      `SELECT monitor_id, error, status_code, healthz_reason, ts FROM checks
        WHERE ts >= ? AND status = 'down' AND in_maintenance = 0
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
      if (sampleLabelByKey.has(key)) continue;
      const label =
        row.healthz_reason && row.healthz_reason.trim()
          ? row.healthz_reason.trim()
          : KIND_HEADLINE[classify(row.error, row.status_code)];
      sampleLabelByKey.set(key, label);
    }
  }

  const views: MonitorView[] = monitors.map((monitor) => {
    const stateRow = stateById.get(monitor.id);
    const latest = latestById.get(monitor.id);
    const monitorBuckets = bucketsByMonitor.get(monitor.id) ?? new Map<number, BucketRow>();
    const buckets = buildBuckets(
      monitor.id,
      monitorBuckets,
      sampleLabelByKey,
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
    const state = (stateRow?.current_status ?? 'up') as CheckStatus;
    const maintenance = parseMaintenance(stateRow, now);
    const effState = deriveEffState(state, buckets, maintenance);
    return {
      monitor,
      state,
      effState,
      uptime: totalChecks > 0 ? (totalUps / totalChecks) * 100 : null,
      latestLatency: latest?.latency_ms ?? null,
      latestTs: latest?.ts ?? null,
      buckets,
      latestReason: latest?.healthz_reason ?? null,
      latestComponents: parseComponents(latest?.healthz_components ?? null),
      latestVersion: latest?.healthz_version ?? null,
      maintenance,
    };
  });

  const overall = computeOverall(views);
  const html = renderShell('Status', renderBody(views, overall, now, scale), now, scale);
  return htmlResponse(html);
}

function parseMaintenance(state: MonitorState | undefined, now: number): MaintenanceView | null {
  if (!state) return null;
  const from = state.maintenance_from;
  const to = state.maintenance_to;
  const reason = state.maintenance_reason;
  if (!from || !to || !reason) return null;
  // Auto-expire windows whose `to` is in the past, even if the cron
  // hasn't yet refreshed the row.
  if (to <= now) return null;
  return { fromMs: from, toMs: to, reason, active: now >= from && now < to };
}

function parseComponents(json: string | null): ComponentHealth[] {
  if (!json) return [];
  try {
    const arr = JSON.parse(json);
    if (!Array.isArray(arr)) return [];
    return arr.filter((c) => c && typeof c === 'object' && typeof c.name === 'string');
  } catch {
    return [];
  }
}

/**
 * Pick the badge state from the latest non-empty bucket. Empty trailing
 * buckets (the very current minute that hasn't been written to yet) are
 * skipped so the badge doesn't go neutral mid-cron-cycle.
 */
function deriveEffState(
  currentStatus: CheckStatus,
  buckets: BucketView[],
  maintenance: MaintenanceView | null,
): EffectiveState {
  if (maintenance?.active) return 'maintenance';
  if (currentStatus === 'down') return 'down';
  if (currentStatus === 'degraded') return 'degraded';
  for (let i = buckets.length - 1; i >= 0; i--) {
    const b = buckets[i];
    if (!b || b.state === 'none') continue;
    if (b.state === 'down' || b.state === 'partial') return 'degraded';
    return 'up';
  }
  return 'up';
}

function buildBuckets(
  monitorId: number,
  rows: Map<number, { ups: number; downs: number; total: number; maints: number }>,
  sampleLabels: Map<string, string>,
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
      const observed = row.ups + row.downs;
      if (observed === 0 && row.maints > 0) {
        state = 'maintenance';
      } else if (observed === 0) {
        state = 'none';
      } else if (row.downs === 0) {
        state = 'up';
      } else if (row.ups === 0) {
        state = 'down';
      } else {
        state = 'partial';
      }
    }
    out.push({
      index: i,
      fromMs,
      toMs,
      state,
      upCount: row?.ups ?? 0,
      downCount: row?.downs ?? 0,
      sampleLabel: sampleLabels.get(`${monitorId}:${i}`) ?? null,
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

interface OverallStatus {
  status: 'ok' | 'degraded' | 'down' | 'maintenance';
  downCount: number;
  degradedCount: number;
  maintenanceCount: number;
}

function computeOverall(views: MonitorView[]): OverallStatus {
  const downCount = views.filter((v) => v.effState === 'down').length;
  const degradedCount = views.filter((v) => v.effState === 'degraded').length;
  const maintenanceCount = views.filter((v) => v.effState === 'maintenance').length;
  let status: OverallStatus['status'] = 'ok';
  if (downCount > 0) status = 'down';
  else if (degradedCount > 0) status = 'degraded';
  else if (maintenanceCount > 0) status = 'maintenance';
  return { status, downCount, degradedCount, maintenanceCount };
}

function renderShell(title: string, body: string, now: number, scale: Scale): string {
  void title;
  void now;
  return `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="robots" content="noindex" />
  <title>status</title>
  <link rel="icon" type="image/svg+xml" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='8' fill='%230a0f1c'/%3E%3Cpath d='M4 16 H10 L13 9 L16 23 L19 13 L22 18 H28' stroke='%2322c55e' stroke-width='2.5' fill='none' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E">
  <link rel="alternate" type="application/rss+xml" title="kuma-lite ステータスフィード" href="/rss.xml">
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
    .bar-up          { background: linear-gradient(180deg, #34d399 0%, #16a34a 100%); }
    .bar-down        { background: linear-gradient(180deg, #f87171 0%, #dc2626 100%); }
    .bar-partial     { background: linear-gradient(180deg, #fbbf24 0%, #d97706 100%); }
    .bar-maintenance { background: linear-gradient(180deg, #60a5fa 0%, #2563eb 100%); }
    .bar-none        { background: rgba(100, 116, 139, 0.18); }
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
  overall: OverallStatus,
  now: number,
  scale: Scale,
): string {
  const headerStatus = renderHeaderStatus(overall);

  const banner = renderMaintenanceBanner(views, now);
  const cards = views.map((v) => renderCard(v, scale, now)).join('\n');
  const nextRefreshMs = computeNextRefreshMs(now);
  const scaleOptions = SCALE_ORDER.map(
    (key) =>
      `<option value="${key}"${key === scale ? ' selected' : ''}>${escapeHtml(SCALES[key].label)}</option>`,
  ).join('');

  return `
    <header class="mb-8">
      <div class="flex items-center justify-between gap-4 flex-wrap">
        <div class="text-sm">${headerStatus}</div>
        <div class="flex items-center gap-4 flex-wrap">
          <div class="flex items-center gap-2">
            <label for="scale-select" class="text-[10px] uppercase tracking-wider text-slate-500">表示期間</label>
            <select id="scale-select" class="scale-select" aria-label="表示期間">
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
              <span class="text-slate-300">最終更新</span>
              <span class="text-slate-200 tabular-nums" data-jst-datetime="${now}">${formatJstDateTime(now)}</span>
              <span class="mt-1 text-[11px] text-slate-500">
                次回更新まで <span id="refresh-countdown" class="tabular-nums text-slate-400">—</span>秒
              </span>
            </div>
          </div>
        </div>
      </div>
    </header>
    ${banner}
    <main class="space-y-4">
      ${cards}
    </main>
  `;
  // Footer intentionally omitted: the service name appears on each card
  // and the time range is already shown in the <select>.
}

/**
 * Top-level banner shown when one or more monitors have an active or
 * upcoming maintenance window. Lists each (monitor, reason, window)
 * with a JST timestamp pair so visitors see exactly what's planned and
 * when. Active windows render in saturated blue; upcoming ones use a
 * lighter outline so they read as "heads-up, not happening yet."
 */
function renderMaintenanceBanner(views: MonitorView[], now: number): string {
  const announcements = views
    .filter((v) => v.maintenance !== null)
    .map((v) => ({ view: v, m: v.maintenance! }));
  if (announcements.length === 0) return '';
  const items = announcements
    .map(({ view, m }) => {
      const when = `${formatJstDateTime(m.fromMs)} 〜 ${formatJstDateTime(m.toMs)}`;
      const phase = m.active
        ? `<span class="text-blue-200 font-medium">実施中</span>`
        : `<span class="text-blue-300/80 font-medium">予定</span>（開始まで ${formatRelativeFuture(m.fromMs - now)}）`;
      return `<li class="flex flex-col gap-0.5">
        <div class="flex flex-wrap items-baseline gap-2">
          <span class="text-blue-100 font-medium">${escapeHtml(view.monitor.name)}</span>
          ${phase}
        </div>
        <div class="text-blue-200/90 text-xs">${escapeHtml(m.reason)}</div>
        <div class="text-blue-200/60 text-[11px] tabular-nums" data-jst-range-from="${m.fromMs}" data-jst-range-to="${m.toMs}">${escapeHtml(when)}</div>
      </li>`;
    })
    .join('\n');
  return `
    <section class="mb-6 rounded-2xl border border-blue-400/30 bg-blue-500/10 px-5 py-4 text-sm text-blue-50">
      <div class="flex items-center gap-2 text-xs uppercase tracking-wider text-blue-200/80 mb-2">
        <svg class="w-4 h-4" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true"><path d="M10 2a8 8 0 100 16 8 8 0 000-16zm.75 4a.75.75 0 00-1.5 0v4.5c0 .2.08.39.22.53l3 3a.75.75 0 101.06-1.06l-2.78-2.78V6z"/></svg>
        計画メンテナンス
      </div>
      <ul class="space-y-3">
        ${items}
      </ul>
    </section>
  `;
}

function renderHeaderStatus(overall: OverallStatus): string {
  if (overall.status === 'down') {
    const n = overall.downCount;
    return `<div class="flex items-center gap-2.5">
         <span class="relative inline-flex">
           <span class="pulse-dot w-2.5 h-2.5 rounded-full text-red-400 bg-red-400"></span>
         </span>
         <span class="text-red-400 font-medium">${n}件 — 現在アクセスできません</span>
       </div>`;
  }
  if (overall.status === 'degraded') {
    const n = overall.degradedCount;
    return `<div class="flex items-center gap-2.5">
         <span class="relative inline-flex">
           <span class="pulse-dot w-2.5 h-2.5 rounded-full text-amber-400 bg-amber-400"></span>
         </span>
         <span class="text-amber-300 font-medium">${n}件 — 一部機能が不調</span>
       </div>`;
  }
  if (overall.status === 'maintenance') {
    const n = overall.maintenanceCount;
    return `<div class="flex items-center gap-2.5">
         <span class="relative inline-flex">
           <span class="pulse-dot w-2.5 h-2.5 rounded-full text-blue-400 bg-blue-400"></span>
         </span>
         <span class="text-blue-300 font-medium">${n}件 — メンテナンス中</span>
       </div>`;
  }
  return `<div class="flex items-center gap-2.5">
         <span class="relative inline-flex">
           <span class="pulse-dot w-2.5 h-2.5 rounded-full text-green-400 bg-green-400"></span>
         </span>
         <span class="text-green-400 font-medium">すべて正常に稼働中</span>
       </div>`;
}

function renderBadge(effState: EffectiveState): string {
  if (effState === 'down') {
    return `<span class="inline-flex items-center gap-1.5 text-[11px] font-medium px-2.5 py-1 rounded-full bg-red-500/10 text-red-300 border border-red-500/30">
         <span class="w-1.5 h-1.5 rounded-full bg-red-400"></span> 停止中
       </span>`;
  }
  if (effState === 'degraded') {
    return `<span class="inline-flex items-center gap-1.5 text-[11px] font-medium px-2.5 py-1 rounded-full bg-amber-500/10 text-amber-300 border border-amber-500/30">
         <span class="w-1.5 h-1.5 rounded-full bg-amber-400"></span> 一部不調
       </span>`;
  }
  if (effState === 'maintenance') {
    return `<span class="inline-flex items-center gap-1.5 text-[11px] font-medium px-2.5 py-1 rounded-full bg-blue-500/10 text-blue-300 border border-blue-500/30">
         <span class="w-1.5 h-1.5 rounded-full bg-blue-400"></span> メンテ中
       </span>`;
  }
  return `<span class="inline-flex items-center gap-1.5 text-[11px] font-medium px-2.5 py-1 rounded-full bg-green-500/10 text-green-300 border border-green-500/30">
       <span class="w-1.5 h-1.5 rounded-full bg-green-400"></span> 正常
     </span>`;
}

function renderCard(view: MonitorView, scale: Scale, now: number): string {
  const config = SCALES[scale];
  const badge = renderBadge(view.effState);

  const uptimeText = view.uptime === null ? '—' : `${view.uptime.toFixed(2)}%`;
  const latencyText =
    view.latestLatency === null ? '—' : `${view.latestLatency} ミリ秒`;
  const lastCheck =
    view.latestTs === null ? 'データなし' : formatRelative(now - view.latestTs);

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
      const sampleAttr = b.sampleLabel
        ? ` data-label="${escapeAttr(b.sampleLabel)}"`
        : '';
      const cls = `bar bar-${b.state}${isClickable ? ' is-clickable' : ''}`;
      return `<${tag}${href} class="${cls}"${role}
        data-from="${b.fromMs}" data-to="${b.toMs}"
        data-state="${b.state}"${sampleAttr}></${tag}>`;
    })
    .join('');

  const windowStart = view.buckets[0]?.fromMs ?? now - config.ms;
  const windowEnd = view.buckets[view.buckets.length - 1]?.toMs ?? now;
  const useDateLabels = config.ms > 24 * 3_600_000;
  const startLabel = useDateLabels ? formatJstShortDate(windowStart) : formatJstTime(windowStart);
  const endLabel = useDateLabels ? formatJstShortDate(windowEnd) : formatJstTime(windowEnd);

  const descriptionLine = view.monitor.description
    ? `<p class="mt-0.5 text-xs text-slate-300 leading-snug">${escapeHtml(view.monitor.description)}</p>`
    : '';

  const reasonLine = renderLatestReason(view);
  const componentsBlock = renderComponents(view.latestComponents);
  const versionPill = view.latestVersion
    ? `<span class="ml-2 inline-flex items-center gap-1 text-[10px] font-mono text-slate-500" title="ビルド識別子">
         <span class="w-1 h-1 rounded-full bg-slate-600"></span>${escapeHtml(view.latestVersion)}
       </span>`
    : '';

  return `
    <article class="glass rounded-2xl p-5">
      <div class="flex items-start justify-between gap-4">
        <div class="min-w-0 flex-1">
          <h2 class="font-semibold text-slate-100 truncate inline-flex items-baseline">
            ${escapeHtml(view.monitor.name)}${versionPill}
          </h2>
          ${descriptionLine}
          ${(() => {
            const display = publicFacingUrl(view.monitor.url);
            return `<a href="${escapeAttr(display)}" target="_blank" rel="noopener noreferrer"
             class="mt-0.5 text-xs text-slate-500 hover:text-slate-300 truncate block transition-colors font-mono">
            ${escapeHtml(display)}
          </a>`;
          })()}
        </div>
        ${badge}
      </div>

      ${reasonLine}

      <div class="mt-5">
        <div class="bar-row" role="img"
             aria-label="${escapeAttr(view.monitor.name)} の${escapeAttr(config.label)}のタイムライン">
          ${bars}
        </div>
        <div class="mt-2 flex justify-between text-[10px] text-slate-500 font-mono tabular-nums">
          <span data-jst-${useDateLabels ? 'shortdate' : 'time'}="${windowStart}">${startLabel}</span>
          <span class="text-slate-600">${escapeHtml(config.label)}</span>
          <span data-jst-${useDateLabels ? 'shortdate' : 'time'}="${windowEnd}">${endLabel}</span>
        </div>
      </div>

      ${componentsBlock}

      <div class="mt-4 grid grid-cols-3 gap-3 text-xs">
        <div>
          <div class="text-slate-500 uppercase tracking-wider text-[10px]">稼働率 · ${escapeHtml(config.short)}</div>
          <div class="text-slate-100 font-medium mt-1 tabular-nums">${uptimeText}</div>
        </div>
        <div>
          <div class="text-slate-500 uppercase tracking-wider text-[10px]">応答速度</div>
          <div class="text-slate-100 font-medium mt-1 tabular-nums">${latencyText}</div>
        </div>
        <div>
          <div class="text-slate-500 uppercase tracking-wider text-[10px]">最終確認</div>
          <div class="text-slate-100 font-medium mt-1">${lastCheck}</div>
        </div>
      </div>
    </article>
  `;
}

/**
 * Per-card "current reason" line. Only rendered when the monitored site
 * has reported something non-trivial — `ok` checks suppress the line
 * entirely so green cards stay clean. Maintenance windows take precedence
 * with their declared reason so visitors don't double-count "down" with
 * "planned maintenance".
 */
function renderLatestReason(view: MonitorView): string {
  if (view.maintenance?.active) {
    return `<p class="mt-2 text-xs text-blue-300/90 leading-snug">
      <span class="font-medium">メンテナンス中:</span> ${escapeHtml(view.maintenance.reason)}
    </p>`;
  }
  if (view.effState === 'up') return '';
  if (!view.latestReason) return '';
  const tone =
    view.effState === 'down'
      ? 'text-red-300'
      : view.effState === 'degraded'
      ? 'text-amber-300'
      : 'text-slate-300';
  return `<p class="mt-2 text-xs ${tone} leading-snug">${escapeHtml(view.latestReason)}</p>`;
}

/**
 * Component breakdown only shown when at least one component is
 * non-OK — listing five healthy components on a green card is just
 * noise. Each row uses a small dot in the component status colour.
 */
function renderComponents(components: ComponentHealth[]): string {
  if (components.length === 0) return '';
  const unhealthy = components.filter((c) => c.status !== 'ok');
  if (unhealthy.length === 0) return '';
  const rows = unhealthy
    .map((c) => {
      const dotColor =
        c.status === 'down'
          ? 'bg-red-400'
          : c.status === 'degraded'
          ? 'bg-amber-400'
          : 'bg-green-400';
      const reason = c.reason ? ` — ${escapeHtml(c.reason)}` : '';
      return `<li class="flex items-baseline gap-2 text-xs text-slate-300">
        <span class="w-1.5 h-1.5 rounded-full ${dotColor} mt-1 shrink-0"></span>
        <span><span class="font-medium text-slate-200">${escapeHtml(c.name)}</span>${reason}</span>
      </li>`;
    })
    .join('\n');
  return `
    <ul class="mt-3 space-y-1 border-l-2 border-slate-700/60 pl-3">
      ${rows}
    </ul>
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
    up: '正常',
    down: '停止',
    partial: '一部停止',
    maintenance: 'メンテナンス',
    none: 'データなし',
  };
  const STATE_COLOR = {
    up: 'text-green-300',
    down: 'text-red-300',
    partial: 'text-amber-300',
    maintenance: 'text-blue-300',
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
    const label = el.dataset.label; // pre-classified human-readable headline
    const isIncident = state === 'down' || state === 'partial';
    tipCard.innerHTML = [
      '<div class="text-slate-200 font-medium tabular-nums">' +
        formatBucketRange(fromTs, toTs) +
      '</div>',
      '<div class="mt-1 ' + (STATE_COLOR[state] || '') + ' font-medium uppercase tracking-wider text-[10px]">' +
        (STATE_LABEL[state] || state) +
      '</div>',
      isIncident && label
        ? '<div class="mt-2 pt-2 border-t border-slate-700/60 text-slate-200">原因: ' + escapeText(label) + '</div>'
        : '',
      isIncident
        ? '<div class="mt-2 text-[10px] text-slate-500">クリックして詳細を確認</div>'
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
    /* The wall-clock time-of-next-refresh was previously surfaced next to
       the countdown. The seconds-remaining number alone communicates the
       same thing more concisely, so the label is intentionally a no-op
       — kept as a hook in case we want to revive it. */
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
  // data-jst-time-secs intentionally unused on the rendered page now;
  // formatTimeSecs is still defined for forward compatibility.
  void formatTimeSecs;
  document.querySelectorAll('[data-jst-shortdate]').forEach((el) => {
    el.textContent = formatShortDate(el.dataset.jstShortdate);
  });
  document.querySelectorAll('[data-jst-range-from]').forEach((el) => {
    const fromTs = el.dataset.jstRangeFrom;
    const toTs = el.dataset.jstRangeTo;
    if (!fromTs || !toTs) return;
    el.textContent = formatDateTime(fromTs) + ' 〜 ' + formatDateTime(toTs);
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
  if (ms < 60_000) return `${Math.max(1, Math.floor(ms / 1000))}秒前`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}分前`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}時間前`;
  return `${Math.floor(ms / 86_400_000)}日前`;
}

function formatRelativeFuture(ms: number): string {
  if (ms <= 0) return 'まもなく';
  if (ms < 60_000) return `${Math.max(1, Math.floor(ms / 1000))}秒`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}分`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}時間`;
  return `${Math.floor(ms / 86_400_000)}日`;
}
