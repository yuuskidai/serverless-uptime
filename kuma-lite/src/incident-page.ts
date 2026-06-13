import type { CheckRow, ComponentHealth, Env, Monitor, MonitorState } from './types';
import { classify, KIND_COPY, type IncidentKind } from './kinds';
import { publicFacingUrl } from './url-display';

const TIMEZONE = 'Asia/Tokyo';
const MAX_ROWS = 200;

export async function renderIncidentPage(env: Env, url: URL): Promise<Response> {
  const renderStartedAt = Date.now();
  const monitorId = Number.parseInt(url.searchParams.get('monitor_id') ?? '', 10);
  const from = Number.parseInt(url.searchParams.get('from') ?? '', 10);
  const to = Number.parseInt(url.searchParams.get('to') ?? '', 10);

  if (!Number.isFinite(monitorId) || !Number.isFinite(from) || !Number.isFinite(to) || to <= from) {
    return htmlResponse(
      shell('不正なリンク', errorBlock('リンクのパラメータが正しくありません。')),
      400,
    );
  }

  // See status-page.ts for the rationale on 'first-unconstrained' —
  // incident pages are public, read-only, and tolerate replica lag.
  const db = env.DB.withSession('first-unconstrained');

  const dbStartedAt = Date.now();
  const monitor = await db.prepare(
    `SELECT * FROM monitors WHERE id = ?`,
  )
    .bind(monitorId)
    .first<Monitor>();

  if (!monitor) {
    return htmlResponse(
      shell('対象が見つかりません', errorBlock('指定された監視対象が見つかりませんでした。')),
      404,
    );
  }

  const [state, checksResult] = await Promise.all([
    db.prepare(`SELECT * FROM monitor_state WHERE monitor_id = ?`)
      .bind(monitorId)
      .first<MonitorState>(),
    // Filter to real failures (down, non-maintenance) at the SQL level —
    // a window can contain ~1440 checks/day at the default 1-minute
    // interval, and a plain ORDER BY ts ASC LIMIT here would silently
    // truncate to the first ~3 hours, hiding any failure that occurred
    // later in the window. Down checks are rare, so MAX_ROWS effectively
    // never binds for this query.
    db.prepare(
      `SELECT * FROM checks
         WHERE monitor_id = ? AND ts >= ? AND ts < ? AND status = 'down' AND in_maintenance = 0
         ORDER BY ts ASC
         LIMIT ?`,
    )
      .bind(monitorId, from, to, MAX_ROWS)
      .all<CheckRow>(),
  ]);
  const failures = checksResult.results ?? [];

  const dbMs = Date.now() - dbStartedAt;
  const html = shell(
    `${monitor.name} の状況詳細`,
    renderBody({ monitor, state, from, to, failures }),
  );
  console.log(
    JSON.stringify({
      route: 'incident',
      monitorId,
      failures: failures.length,
      dbMs,
      totalMs: Date.now() - renderStartedAt,
      d1Region: checksResult.meta?.served_by_region ?? null,
      d1Primary: checksResult.meta?.served_by_primary ?? null,
    }),
  );
  return htmlResponse(html, 200);
}

interface RenderArgs {
  monitor: Monitor;
  state: MonitorState | null;
  from: number;
  to: number;
  failures: CheckRow[];
}

function dominantKind(failures: CheckRow[]): IncidentKind {
  if (failures.length === 0) return 'unknown';
  const counts = new Map<IncidentKind, number>();
  for (const f of failures) {
    const k = classify(f.error, f.status_code);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  let best: { kind: IncidentKind; n: number } | null = null;
  for (const [kind, n] of counts) {
    if (kind === 'unknown') continue;
    if (!best || n > best.n) best = { kind, n };
  }
  return best?.kind ?? 'unknown';
}

function renderBody(args: RenderArgs): string {
  const { monitor, state, from, to, failures } = args;
  if (failures.length === 0) {
    return renderHealthyWindow(monitor, from, to);
  }

  const kind = dominantKind(failures);
  const copy = KIND_COPY[kind];
  const firstFailureTs = failures[0]?.ts ?? null;
  const lastFailureTs = failures[failures.length - 1]?.ts ?? null;
  const isOngoing = state?.current_status === 'down';
  // Pull the most recent structured reason from the failure window so
  // the headline can be replaced with the site's own business-language
  // explanation when present (e.g. "決済 (Stripe) で応答遅延が発生").
  const latestStructured = pickLatestStructured(failures);
  const headline = latestStructured?.reason ?? copy.headline;
  const detail = latestStructured?.reason ? null : copy.detail;
  const components = latestStructured?.components ?? [];

  const verdict = isOngoing
    ? { tone: 'red' as const, label: '継続中' }
    : { tone: 'green' as const, label: '復旧済' };

  const startCell = firstFailureTs !== null
    ? `<span class="tabular-nums" data-jst-friendly="${firstFailureTs}">${formatJstFriendly(firstFailureTs)}</span>`
    : '—';
  const endCell = isOngoing
    ? '<span class="text-amber-300">継続中</span>'
    : lastFailureTs !== null
    ? `<span class="tabular-nums" data-jst-friendly="${lastFailureTs}">${formatJstFriendly(lastFailureTs)}</span>`
    : '—';
  const durationMs = isOngoing && firstFailureTs !== null
    ? Date.now() - firstFailureTs
    : firstFailureTs !== null && lastFailureTs !== null
    ? Math.max(0, lastFailureTs - firstFailureTs)
    : 0;
  const durationCell = isOngoing
    ? `${formatHumanDuration(durationMs)} 経過`
    : durationMs >= 1000
    ? `約 ${formatHumanDuration(durationMs)}`
    : '1秒未満';
  const durationLabel = isOngoing ? '経過時間' : '影響時間';
  const endLabel = isOngoing ? '状況' : '復旧';

  return `
    ${renderHeader(monitor)}
    <main class="space-y-6">
      <section class="glass rounded-2xl p-6 sm:p-7">
        <span class="inline-flex items-center gap-2 text-xs font-medium px-3 py-1.5 rounded-full ${toneClass(verdict.tone)}">
          <span class="w-1.5 h-1.5 rounded-full" style="background:currentColor"></span>
          ${escapeHtml(verdict.label)}
        </span>
        <h2 class="mt-4 text-lg sm:text-xl font-semibold text-slate-100 leading-snug">
          ${escapeHtml(headline)}
        </h2>
        ${detail ? `<p class="mt-2 text-sm text-slate-300">${escapeHtml(detail)}</p>` : ''}

        <dl class="mt-6 grid grid-cols-1 sm:grid-cols-3 gap-4 text-sm">
          <div>
            <dt class="text-[10px] uppercase tracking-wider text-slate-500">発生</dt>
            <dd class="mt-1 text-slate-100">${startCell}</dd>
          </div>
          <div>
            <dt class="text-[10px] uppercase tracking-wider text-slate-500">${escapeHtml(endLabel)}</dt>
            <dd class="mt-1 text-slate-100">${endCell}</dd>
          </div>
          <div>
            <dt class="text-[10px] uppercase tracking-wider text-slate-500">${escapeHtml(durationLabel)}</dt>
            <dd class="mt-1 text-slate-100">${escapeHtml(durationCell)}</dd>
          </div>
        </dl>

        ${renderComponentsBlock(components)}
      </section>
    </main>
  `;
}

/**
 * Walk the failure list newest-first looking for a row that captured
 * structured /healthz output (a non-null healthz_components or
 * healthz_reason). The most recent structured snapshot is the most
 * useful for the visitor — it reflects what the site is currently
 * reporting, not a stale earlier hypothesis.
 */
function pickLatestStructured(failures: CheckRow[]): {
  reason: string | null;
  components: ComponentHealth[];
} | null {
  for (let i = failures.length - 1; i >= 0; i--) {
    const f = failures[i];
    if (!f) continue;
    const hasReason = !!f.healthz_reason;
    const components = parseComponents(f.healthz_components);
    if (hasReason || components.length > 0) {
      return {
        reason: f.healthz_reason,
        components,
      };
    }
  }
  return null;
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

function renderComponentsBlock(components: ComponentHealth[]): string {
  if (components.length === 0) return '';
  // Show *all* components (not just unhealthy) on the incident page — a
  // visitor coming in from a red bar wants to see the full breakdown so
  // they can tell which dependency is the problem and which are fine.
  const rows = components
    .map((c) => {
      const dotColor =
        c.status === 'down'
          ? 'bg-red-400'
          : c.status === 'degraded'
          ? 'bg-amber-400'
          : 'bg-green-400';
      const statusLabel =
        c.status === 'down' ? '停止' : c.status === 'degraded' ? '不調' : '正常';
      const reason = c.reason ? `<div class="text-xs text-slate-400 mt-0.5">${escapeHtml(c.reason)}</div>` : '';
      const latency =
        typeof c.latency_ms === 'number'
          ? `<span class="text-[11px] font-mono text-slate-500 ml-2 tabular-nums">${c.latency_ms} ms</span>`
          : '';
      return `<li class="flex items-start gap-2 py-2 border-t border-slate-700/50 first:border-t-0">
        <span class="w-1.5 h-1.5 rounded-full ${dotColor} mt-2 shrink-0"></span>
        <div class="min-w-0 flex-1">
          <div class="flex items-baseline gap-2">
            <span class="text-sm font-medium text-slate-100">${escapeHtml(c.name)}</span>
            <span class="text-[10px] uppercase tracking-wider text-slate-400">${escapeHtml(statusLabel)}</span>
            ${latency}
          </div>
          ${reason}
        </div>
      </li>`;
    })
    .join('\n');
  return `
    <div class="mt-6">
      <div class="text-[10px] uppercase tracking-wider text-slate-500 mb-1">構成要素ごとの状態</div>
      <ul class="rounded-lg bg-slate-950/40 px-3 border border-slate-700/40">
        ${rows}
      </ul>
    </div>
  `;
}

function renderHealthyWindow(monitor: Monitor, from: number, to: number): string {
  return `
    ${renderHeader(monitor)}
    <main class="space-y-6">
      <section class="glass rounded-2xl p-6 sm:p-8 text-center">
        <div class="inline-flex items-center justify-center w-12 h-12 rounded-full bg-green-500/15 border border-green-500/30 mb-4">
          <svg class="w-6 h-6 text-green-400" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
            <path fill-rule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clip-rule="evenodd"/>
          </svg>
        </div>
        <h2 class="text-lg font-semibold text-slate-100">この時間帯に問題はありませんでした</h2>
        <p class="mt-2 text-sm text-slate-400">
          <span class="tabular-nums" data-jst-friendly="${from}">${formatJstFriendly(from)}</span>
          から
          <span class="tabular-nums" data-jst-friendly="${to}">${formatJstFriendly(to)}</span>
          までのチェックはすべて成功しています。
        </p>
      </section>
    </main>
  `;
}

function renderHeader(monitor: Monitor): string {
  const descriptionLine = monitor.description
    ? `<p class="mt-2 text-sm text-slate-300 leading-relaxed">${escapeHtml(monitor.description)}</p>`
    : '';
  return `
    <header class="mb-8">
      <a href="/" class="inline-flex items-center gap-1.5 text-xs text-slate-400 hover:text-slate-200 transition-colors mb-4">
        <svg class="w-3.5 h-3.5" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
          <path fill-rule="evenodd" d="M9.707 14.707a1 1 0 01-1.414 0l-4-4a1 1 0 010-1.414l4-4a1 1 0 011.414 1.414L7.414 9H15a1 1 0 110 2H7.414l2.293 2.293a1 1 0 010 1.414z" clip-rule="evenodd" />
        </svg>
        ステータスページに戻る
      </a>
      <p class="text-xs uppercase tracking-[0.18em] text-slate-500 mb-2">状況レポート</p>
      <h1 class="text-2xl sm:text-3xl font-semibold tracking-tight text-slate-100">${escapeHtml(monitor.name)}</h1>
      ${descriptionLine}
      ${(() => {
        const display = publicFacingUrl(monitor.url);
        return `<a href="${escapeAttr(display)}" target="_blank" rel="noopener noreferrer"
         class="mt-1 inline-block text-xs text-slate-500 hover:text-slate-300 transition-colors break-all font-mono">
        ${escapeHtml(display)}
      </a>`;
      })()}
    </header>
  `;
}

function toneClass(tone: 'green' | 'amber' | 'red'): string {
  return {
    green: 'bg-green-500/10 text-green-300 border border-green-500/30',
    amber: 'bg-amber-500/10 text-amber-300 border border-amber-500/30',
    red: 'bg-red-500/10 text-red-300 border border-red-500/30',
  }[tone];
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

function errorBlock(message: string): string {
  return `
    <header class="mb-6">
      <a href="/" class="inline-flex items-center gap-1.5 text-xs text-slate-400 hover:text-slate-200 transition-colors mb-4">
        <svg class="w-3.5 h-3.5" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
          <path fill-rule="evenodd" d="M9.707 14.707a1 1 0 01-1.414 0l-4-4a1 1 0 010-1.414l4-4a1 1 0 011.414 1.414L7.414 9H15a1 1 0 110 2H7.414l2.293 2.293a1 1 0 010 1.414z" clip-rule="evenodd" />
        </svg>
        ステータスページに戻る
      </a>
    </header>
    <div class="glass rounded-2xl p-6 text-sm text-slate-300">
      ${escapeHtml(message)}
    </div>
  `;
}

function shell(title: string, body: string): string {
  void title;
  return `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="robots" content="noindex" />
  <title>status</title>
  <link rel="icon" type="image/svg+xml" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='8' fill='%230a0f1c'/%3E%3Cpath d='M4 16 H10 L13 9 L16 23 L19 13 L22 18 H28' stroke='%2322c55e' stroke-width='2.5' fill='none' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@300;400;500;600;700&family=Noto+Sans+JP:wght@400;500;600&display=swap" rel="stylesheet">
  <script src="https://cdn.tailwindcss.com"></script>
  <script>
    tailwind.config = {
      theme: {
        extend: {
          fontFamily: {
            sans: ['"Plus Jakarta Sans"', '"Noto Sans JP"', 'system-ui', 'sans-serif'],
          },
        },
      },
    };
  </script>
  <style>
    :root { color-scheme: dark; }
    body {
      background:
        radial-gradient(1200px 600px at 80% -10%, rgba(34, 197, 94, 0.08), transparent 60%),
        radial-gradient(900px 500px at 0% 40%, rgba(59, 130, 246, 0.06), transparent 55%),
        #0a0f1c;
      min-height: 100vh;
    }
    .glass {
      background: rgba(15, 23, 42, 0.55);
      backdrop-filter: blur(14px) saturate(140%);
      -webkit-backdrop-filter: blur(14px) saturate(140%);
      border: 1px solid rgba(148, 163, 184, 0.10);
    }
  </style>
</head>
<body class="text-slate-100 font-sans antialiased">
  <div class="max-w-3xl mx-auto px-4 py-10">
    ${body}
  </div>
  <script>
    (function () {
      const TZ = ${JSON.stringify(TIMEZONE)};
      const friendly = new Intl.DateTimeFormat('ja-JP', {
        timeZone: TZ, year: 'numeric', month: 'long', day: 'numeric',
        weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
      });
      document.querySelectorAll('[data-jst-friendly]').forEach((el) => {
        const v = el.dataset.jstFriendly;
        if (!v || v === 'null') return;
        el.textContent = friendly.format(new Date(Number(v)));
      });
    })();
  </script>
</body>
</html>`;
}

function htmlResponse(html: string, status: number): Response {
  return new Response(html, {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      // See status-page.ts for the 50s rationale — same constraint set.
      'Cache-Control': 'public, max-age=50',
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
