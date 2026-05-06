import type { CheckRow, CheckStatus, Env, Monitor, MonitorState } from './types';
import { formatJstDateTime, formatJstTime } from './status-page';

const TIMEZONE = 'Asia/Tokyo';
const CONTEXT_MS = 5 * 60 * 1000;
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

  // Fetch the bucket itself plus a small leading/trailing context window so
  // the surrounding behaviour (a recovery, a cascade) is visible.
  const contextFrom = from - CONTEXT_MS;
  const contextTo = to + CONTEXT_MS;
  const checksResult = await env.DB.prepare(
    `SELECT * FROM checks
       WHERE monitor_id = ? AND ts >= ? AND ts < ?
       ORDER BY ts ASC
       LIMIT ?`,
  )
    .bind(monitorId, contextFrom, contextTo, MAX_ROWS)
    .all<CheckRow>();
  const checks = checksResult.results ?? [];

  const html = shell(
    `Checks · ${monitor.name}`,
    renderBody({ monitor, state, from, to, contextFrom, contextTo, checks }),
  );
  return htmlResponse(html, 200);
}

interface RenderArgs {
  monitor: Monitor;
  state: MonitorState | null;
  from: number;
  to: number;
  contextFrom: number;
  contextTo: number;
  checks: CheckRow[];
}

function renderBody(args: RenderArgs): string {
  const { monitor, state, from, to, contextFrom, contextTo, checks } = args;
  const inBucket = checks.filter((c) => c.ts >= from && c.ts < to);
  const ups = inBucket.filter((c) => c.status === 'up').length;
  const downs = inBucket.length - ups;

  const summary = renderSummary({
    monitor,
    state: state?.current_status ?? 'up',
    ups,
    downs,
    from,
    to,
  });

  const table = checks.length
    ? renderTable(checks, from, to)
    : `<div class="glass rounded-2xl p-6 text-center text-slate-400 text-sm">
         No checks recorded in this window.
       </div>`;

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
      ${summary}
      <section>
        <h2 class="text-xs uppercase tracking-[0.18em] text-slate-500 mb-3">
          Checks · including ±5 min context
        </h2>
        ${table}
        <p class="mt-2 text-[11px] text-slate-500">
          Range:
          <span class="tabular-nums" data-jst-datetime="${contextFrom}">${formatJstDateTime(contextFrom)}</span>
          →
          <span class="tabular-nums" data-jst-datetime="${contextTo}">${formatJstDateTime(contextTo)}</span>
        </p>
      </section>
    </main>
    <footer class="mt-12 pt-6 border-t border-slate-800/50 text-xs text-slate-500 text-center">
      Powered by kuma-lite on Cloudflare Workers
    </footer>
  `;
}

function renderSummary(args: {
  monitor: Monitor;
  state: CheckStatus;
  ups: number;
  downs: number;
  from: number;
  to: number;
}): string {
  const { state, ups, downs, from, to } = args;
  const total = ups + downs;
  const verdict = total === 0
    ? { tone: 'slate', label: 'No data' }
    : downs === 0
    ? { tone: 'green', label: 'All up' }
    : ups === 0
    ? { tone: 'red', label: 'Outage' }
    : { tone: 'amber', label: 'Partial outage' };

  const toneRing = {
    green: 'bg-green-500/10 text-green-300 border-green-500/30',
    amber: 'bg-amber-500/10 text-amber-300 border-amber-500/30',
    red: 'bg-red-500/10 text-red-300 border-red-500/30',
    slate: 'bg-slate-500/10 text-slate-300 border-slate-500/30',
  }[verdict.tone];

  const currentBadge = state === 'up'
    ? `<span class="inline-flex items-center gap-1.5 text-[11px] font-medium px-2.5 py-1 rounded-full bg-green-500/10 text-green-300 border border-green-500/30">
         <span class="w-1.5 h-1.5 rounded-full bg-green-400"></span> Operational
       </span>`
    : `<span class="inline-flex items-center gap-1.5 text-[11px] font-medium px-2.5 py-1 rounded-full bg-red-500/10 text-red-300 border border-red-500/30">
         <span class="w-1.5 h-1.5 rounded-full bg-red-400"></span> Down
       </span>`;

  return `
    <section class="glass rounded-2xl p-5 sm:p-6">
      <div class="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div class="flex items-center gap-2">
            <span class="inline-flex items-center text-[11px] font-medium px-2.5 py-1 rounded-full border ${toneRing}">
              ${escapeHtml(verdict.label)}
            </span>
            <span class="text-xs text-slate-500">in selected bucket</span>
          </div>
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
        <div class="flex items-center gap-3">
          <div class="text-right">
            <p class="text-[10px] uppercase tracking-wider text-slate-500">Current</p>
            <div class="mt-1">${currentBadge}</div>
          </div>
        </div>
      </div>
      <div class="mt-5 grid grid-cols-3 gap-4 text-sm">
        <div>
          <div class="text-[10px] uppercase tracking-wider text-slate-500">Total checks</div>
          <div class="mt-1 text-slate-100 font-semibold tabular-nums">${total}</div>
        </div>
        <div>
          <div class="text-[10px] uppercase tracking-wider text-slate-500">Up</div>
          <div class="mt-1 text-green-300 font-semibold tabular-nums">${ups}</div>
        </div>
        <div>
          <div class="text-[10px] uppercase tracking-wider text-slate-500">Down</div>
          <div class="mt-1 text-red-300 font-semibold tabular-nums">${downs}</div>
        </div>
      </div>
    </section>
  `;
}

function renderTable(checks: CheckRow[], from: number, to: number): string {
  const rows = checks
    .map((c) => {
      const inBucket = c.ts >= from && c.ts < to;
      const isDown = c.status === 'down';
      const statusBadge = isDown
        ? `<span class="inline-flex items-center gap-1.5 text-[11px] font-medium px-2 py-0.5 rounded bg-red-500/10 text-red-300 border border-red-500/30">
             <span class="w-1 h-1 rounded-full bg-red-400"></span> down
           </span>`
        : `<span class="inline-flex items-center gap-1.5 text-[11px] font-medium px-2 py-0.5 rounded bg-green-500/10 text-green-300 border border-green-500/30">
             <span class="w-1 h-1 rounded-full bg-green-400"></span> up
           </span>`;
      const rowClass = inBucket ? 'bg-slate-900/40' : '';
      return `
        <tr class="${rowClass}">
          <td class="py-2.5 px-3 text-slate-300 font-mono tabular-nums whitespace-nowrap"
              data-jst-datetime="${c.ts}">${formatJstDateTime(c.ts)}</td>
          <td class="py-2.5 px-3">${statusBadge}</td>
          <td class="py-2.5 px-3 text-slate-300 font-mono tabular-nums">${c.status_code ?? '—'}</td>
          <td class="py-2.5 px-3 text-slate-300 font-mono tabular-nums">${c.latency_ms ?? '—'}</td>
          <td class="py-2.5 px-3 text-slate-300 font-mono text-[11px] break-all max-w-md">
            ${c.error ? escapeHtml(c.error) : '<span class="text-slate-600">—</span>'}
          </td>
        </tr>`;
    })
    .join('\n');

  return `
    <div class="glass rounded-2xl overflow-hidden">
      <div class="overflow-x-auto">
        <table class="min-w-full text-xs">
          <thead class="border-b border-slate-800/60">
            <tr class="text-left text-[10px] uppercase tracking-wider text-slate-500">
              <th class="py-2.5 px-3 font-medium">Time (JST)</th>
              <th class="py-2.5 px-3 font-medium">Status</th>
              <th class="py-2.5 px-3 font-medium">HTTP</th>
              <th class="py-2.5 px-3 font-medium">Latency (ms)</th>
              <th class="py-2.5 px-3 font-medium">Error</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-slate-800/40">
            ${rows}
          </tbody>
        </table>
      </div>
    </div>
  `;
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
        el.textContent = fmtDateTime(el.dataset.jstDatetime);
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
