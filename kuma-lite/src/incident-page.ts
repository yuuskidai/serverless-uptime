import type { CheckRow, Env, Monitor, MonitorState } from './types';
import { formatJstDateTime, formatJstTime } from './status-page';

const TIMEZONE = 'Asia/Tokyo';
const MAX_ROWS = 200;

export async function renderIncidentPage(env: Env, url: URL): Promise<Response> {
  const monitorId = Number.parseInt(url.searchParams.get('monitor_id') ?? '', 10);
  const from = Number.parseInt(url.searchParams.get('from') ?? '', 10);
  const to = Number.parseInt(url.searchParams.get('to') ?? '', 10);

  if (!Number.isFinite(monitorId) || !Number.isFinite(from) || !Number.isFinite(to) || to <= from) {
    return htmlResponse(
      shell(
        'Invalid request',
        errorBlock('Invalid query parameters. Expected `monitor_id`, `from`, `to`.'),
      ),
      400,
    );
  }

  const monitor = await env.DB.prepare(
    `SELECT * FROM monitors WHERE id = ?`,
  )
    .bind(monitorId)
    .first<Monitor>();

  if (!monitor) {
    return htmlResponse(shell('Not found', errorBlock(`Monitor #${monitorId} not found.`)), 404);
  }

  const state = await env.DB.prepare(
    `SELECT * FROM monitor_state WHERE monitor_id = ?`,
  )
    .bind(monitorId)
    .first<MonitorState>();

  // Only fetch checks inside the selected window. Up/healthy buckets shouldn't
  // reach this page (the status page only links to failure buckets), but if a
  // user crafts a URL by hand we still answer cleanly.
  const checksResult = await env.DB.prepare(
    `SELECT * FROM checks
       WHERE monitor_id = ? AND ts >= ? AND ts < ?
       ORDER BY ts ASC
       LIMIT ?`,
  )
    .bind(monitorId, from, to, MAX_ROWS)
    .all<CheckRow>();
  const checks = checksResult.results ?? [];
  const failures = checks.filter((c) => c.status === 'down');

  const html = shell(
    `Incident · ${monitor.name}`,
    renderBody({ monitor, state, from, to, checks, failures }),
  );
  return htmlResponse(html, 200);
}

interface RenderArgs {
  monitor: Monitor;
  state: MonitorState | null;
  from: number;
  to: number;
  checks: CheckRow[];
  failures: CheckRow[];
}

function renderBody(args: RenderArgs): string {
  const { monitor, state, from, to, checks, failures } = args;

  const totalChecks = checks.length;
  const failureCount = failures.length;
  const verdict =
    failureCount === 0
      ? { tone: 'green' as const, label: 'No incident in this window' }
      : failureCount === totalChecks
      ? { tone: 'red' as const, label: 'Outage' }
      : { tone: 'amber' as const, label: 'Partial outage' };

  const firstFailureTs = failures[0]?.ts ?? null;
  const lastFailureTs = failures[failures.length - 1]?.ts ?? null;
  const durationMs =
    firstFailureTs !== null && lastFailureTs !== null
      ? Math.max(0, lastFailureTs - firstFailureTs)
      : 0;

  const primaryError = mostFrequentError(failures);

  const currentBadge =
    state?.current_status === 'down'
      ? `<span class="inline-flex items-center gap-1.5 text-[11px] font-medium px-2.5 py-1 rounded-full bg-red-500/10 text-red-300 border border-red-500/30">
           <span class="w-1.5 h-1.5 rounded-full bg-red-400"></span> Currently down
         </span>`
      : `<span class="inline-flex items-center gap-1.5 text-[11px] font-medium px-2.5 py-1 rounded-full bg-green-500/10 text-green-300 border border-green-500/30">
           <span class="w-1.5 h-1.5 rounded-full bg-green-400"></span> Currently operational
         </span>`;

  return `
    <header class="mb-8">
      <a href="/" class="inline-flex items-center gap-1.5 text-xs text-slate-400 hover:text-slate-200 transition-colors mb-4">
        <svg class="w-3.5 h-3.5" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
          <path fill-rule="evenodd" d="M9.707 14.707a1 1 0 01-1.414 0l-4-4a1 1 0 010-1.414l4-4a1 1 0 011.414 1.414L7.414 9H15a1 1 0 110 2H7.414l2.293 2.293a1 1 0 010 1.414z" clip-rule="evenodd" />
        </svg>
        Back to status
      </a>
      <p class="text-xs uppercase tracking-[0.18em] text-slate-500 mb-2">Incident detail</p>
      <h1 class="text-2xl sm:text-3xl font-semibold tracking-tight text-slate-100">${escapeHtml(monitor.name)}</h1>
      <a href="${escapeAttr(monitor.url)}" target="_blank" rel="noopener noreferrer"
         class="text-sm text-slate-400 hover:text-slate-200 transition-colors">
        ${escapeHtml(monitor.url)}
      </a>
    </header>

    <main class="space-y-6">
      <section class="glass rounded-2xl p-5 sm:p-6">
        <div class="flex flex-wrap items-start justify-between gap-4">
          <div class="min-w-0">
            <span class="inline-flex items-center text-[11px] font-medium px-2.5 py-1 rounded-full border ${toneClass(verdict.tone)}">
              ${escapeHtml(verdict.label)}
            </span>
            <p class="mt-3 text-sm text-slate-300">
              <span class="text-slate-100 font-medium tabular-nums" data-jst-time="${from}">${formatJstTime(from)}</span>
              <span class="text-slate-500 mx-1.5">–</span>
              <span class="text-slate-100 font-medium tabular-nums" data-jst-time="${to}">${formatJstTime(to)}</span>
              <span class="text-slate-500 ml-2 text-xs">JST</span>
            </p>
            <p class="mt-1 text-xs text-slate-400 tabular-nums" data-jst-datetime="${from}">
              ${formatJstDateTime(from)}
            </p>
          </div>
          <div class="text-right">
            <p class="text-[10px] uppercase tracking-wider text-slate-500">Now</p>
            <div class="mt-1">${currentBadge}</div>
          </div>
        </div>

        ${
          failureCount === 0
            ? `<p class="mt-5 text-sm text-slate-400">
                 No failures recorded in this window. Use the back link to return to the status page.
               </p>`
            : `
        <div class="mt-5 grid grid-cols-1 sm:grid-cols-3 gap-4 text-sm">
          <div>
            <div class="text-[10px] uppercase tracking-wider text-slate-500">First failure</div>
            <div class="mt-1 text-slate-100 font-medium tabular-nums" data-jst-datetime="${firstFailureTs}">
              ${firstFailureTs !== null ? formatJstDateTime(firstFailureTs) : '—'}
            </div>
          </div>
          <div>
            <div class="text-[10px] uppercase tracking-wider text-slate-500">Last failure</div>
            <div class="mt-1 text-slate-100 font-medium tabular-nums" data-jst-datetime="${lastFailureTs}">
              ${lastFailureTs !== null ? formatJstDateTime(lastFailureTs) : '—'}
            </div>
          </div>
          <div>
            <div class="text-[10px] uppercase tracking-wider text-slate-500">Duration</div>
            <div class="mt-1 text-slate-100 font-medium tabular-nums">
              ${durationMs > 0 ? formatDuration(durationMs) : 'instantaneous'}
            </div>
          </div>
        </div>

        ${
          primaryError
            ? `<div class="mt-5">
                 <div class="text-[10px] uppercase tracking-wider text-slate-500 mb-1.5">Most frequent error</div>
                 <div class="bg-slate-950/60 border border-slate-800 rounded-lg px-3 py-2.5 text-xs font-mono text-slate-200 break-all">
                   ${escapeHtml(primaryError)}
                 </div>
               </div>`
            : ''
        }
        `
        }
      </section>

      ${failureCount > 0 ? renderFailureTimeline(failures) : ''}
    </main>

    <footer class="mt-12 pt-6 border-t border-slate-800/50 text-xs text-slate-500 text-center">
      Powered by kuma-lite on Cloudflare Workers
    </footer>
  `;
}

function renderFailureTimeline(failures: CheckRow[]): string {
  const rows = failures
    .map((c) => {
      return `
        <tr>
          <td class="py-2.5 px-3 text-slate-200 font-mono tabular-nums whitespace-nowrap"
              data-jst-datetime="${c.ts}">${formatJstDateTime(c.ts)}</td>
          <td class="py-2.5 px-3 text-slate-300 font-mono tabular-nums">
            ${c.status_code !== null ? `HTTP ${c.status_code}` : 'TIMEOUT'}
          </td>
          <td class="py-2.5 px-3 text-slate-300 font-mono text-[11px] break-all max-w-md">
            ${c.error ? escapeHtml(c.error) : '<span class="text-slate-600">—</span>'}
          </td>
        </tr>`;
    })
    .join('\n');

  return `
    <section>
      <h2 class="text-xs uppercase tracking-[0.18em] text-slate-500 mb-3">
        Failures · ${failures.length} event${failures.length === 1 ? '' : 's'}
      </h2>
      <div class="glass rounded-2xl overflow-hidden">
        <div class="overflow-x-auto">
          <table class="min-w-full text-xs">
            <thead class="border-b border-slate-800/60">
              <tr class="text-left text-[10px] uppercase tracking-wider text-slate-500">
                <th class="py-2.5 px-3 font-medium">Time (JST)</th>
                <th class="py-2.5 px-3 font-medium">Result</th>
                <th class="py-2.5 px-3 font-medium">Error</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-slate-800/40">
              ${rows}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  `;
}

function mostFrequentError(failures: CheckRow[]): string | null {
  if (failures.length === 0) return null;
  const counts = new Map<string, number>();
  for (const f of failures) {
    if (!f.error) continue;
    counts.set(f.error, (counts.get(f.error) ?? 0) + 1);
  }
  let best: { msg: string; n: number } | null = null;
  for (const [msg, n] of counts) {
    if (!best || n > best.n) best = { msg, n };
  }
  return best?.msg ?? failures[failures.length - 1]?.error ?? null;
}

function toneClass(tone: 'green' | 'amber' | 'red' | 'slate'): string {
  return {
    green: 'bg-green-500/10 text-green-300 border-green-500/30',
    amber: 'bg-amber-500/10 text-amber-300 border-amber-500/30',
    red: 'bg-red-500/10 text-red-300 border-red-500/30',
    slate: 'bg-slate-500/10 text-slate-300 border-slate-500/30',
  }[tone];
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
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

function errorBlock(message: string): string {
  return `
    <header class="mb-6">
      <a href="/" class="inline-flex items-center gap-1.5 text-xs text-slate-400 hover:text-slate-200 transition-colors mb-4">
        <svg class="w-3.5 h-3.5" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
          <path fill-rule="evenodd" d="M9.707 14.707a1 1 0 01-1.414 0l-4-4a1 1 0 010-1.414l4-4a1 1 0 011.414 1.414L7.414 9H15a1 1 0 110 2H7.414l2.293 2.293a1 1 0 010 1.414z" clip-rule="evenodd" />
        </svg>
        Back to status
      </a>
    </header>
    <div class="glass rounded-2xl p-6 text-sm text-slate-300">
      ${escapeHtml(message)}
    </div>
  `;
}

function shell(title: string, body: string): string {
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
  <div class="max-w-4xl mx-auto px-4 py-10">
    ${body}
  </div>
  <script>
    (function () {
      const TZ = ${JSON.stringify(TIMEZONE)};
      const dt = new Intl.DateTimeFormat('ja-JP', {
        timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
      });
      const t = new Intl.DateTimeFormat('ja-JP', {
        timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false,
      });
      function fmtDateTime(ts) {
        const parts = dt.formatToParts(new Date(Number(ts)));
        const get = (type) => (parts.find((p) => p.type === type) || {}).value || '';
        return get('year') + '-' + get('month') + '-' + get('day') + ' ' +
               get('hour') + ':' + get('minute') + ':' + get('second') + ' JST';
      }
      document.querySelectorAll('[data-jst-datetime]').forEach((el) => {
        const v = el.dataset.jstDatetime;
        if (!v || v === 'null') return;
        el.textContent = fmtDateTime(v);
      });
      document.querySelectorAll('[data-jst-time]').forEach((el) => {
        el.textContent = t.format(new Date(Number(el.dataset.jstTime)));
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

