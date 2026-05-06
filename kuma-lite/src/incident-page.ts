import type { CheckRow, Env, Monitor, MonitorState } from './types';

const TIMEZONE = 'Asia/Tokyo';
const MAX_ROWS = 200;

export async function renderIncidentPage(env: Env, url: URL): Promise<Response> {
  const monitorId = Number.parseInt(url.searchParams.get('monitor_id') ?? '', 10);
  const from = Number.parseInt(url.searchParams.get('from') ?? '', 10);
  const to = Number.parseInt(url.searchParams.get('to') ?? '', 10);

  if (!Number.isFinite(monitorId) || !Number.isFinite(from) || !Number.isFinite(to) || to <= from) {
    return htmlResponse(
      shell('不正なリンク', errorBlock('リンクのパラメータが正しくありません。')),
      400,
    );
  }

  const monitor = await env.DB.prepare(
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

  const state = await env.DB.prepare(
    `SELECT * FROM monitor_state WHERE monitor_id = ?`,
  )
    .bind(monitorId)
    .first<MonitorState>();

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
    `${monitor.name} の状況詳細`,
    renderBody({ monitor, state, from, to, failures }),
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

/**
 * Translate raw check errors into a category that we can describe in
 * everyday Japanese. The headline + 1-line explanation are picked from
 * the dominant kind across all failures in the bucket. The wording is
 * intentionally short and certain — speculative attributions ("…の
 * 可能性があります") have been removed.
 */
type IncidentKind =
  | 'http_error_5xx'
  | 'http_error_4xx'
  | 'http_error_other'
  | 'timeout'
  | 'dns'
  | 'connection'
  | 'tls'
  | 'keyword_missing'
  | 'unknown';

interface KindCopy {
  headline: string;
  detail: string;
}

const KIND_COPY: Record<IncidentKind, KindCopy> = {
  http_error_5xx: {
    headline: 'サイトがエラーを返していました',
    detail: 'サーバー側で内部エラーが発生していました。',
  },
  http_error_4xx: {
    headline: '想定したページが返ってきませんでした',
    detail: 'リクエストに対して正常な内容の応答が得られませんでした。',
  },
  http_error_other: {
    headline: '想定外の応答が返ってきました',
    detail: '応答内容が期待していたものと一致しませんでした。',
  },
  timeout: {
    headline: '応答が時間内に返りませんでした',
    detail: '応答が一定時間内に返ってこなかったため、利用できないと判定しました。',
  },
  dns: {
    headline: 'サイトのアドレスを特定できませんでした',
    detail: 'サイトのアドレスを特定できませんでした。',
  },
  connection: {
    headline: 'サイトに接続できませんでした',
    detail: 'サイトに到達できませんでした。',
  },
  tls: {
    headline: '安全な通信が成立しませんでした',
    detail: '安全な通信を確立できませんでした。',
  },
  keyword_missing: {
    headline: 'ページの内容が想定と違いました',
    detail: '応答はありましたが、確認したい文言がページに見つかりませんでした。',
  },
  unknown: {
    headline: 'サイトが利用できない状態でした',
    detail: '自動チェックでアクセスできませんでした。',
  },
};

function classify(error: string | null, statusCode: number | null): IncidentKind {
  const s = (error ?? '').toLowerCase();
  if (/timeout|timed out/.test(s)) return 'timeout';
  if (/getaddrinfo|enotfound|dns/.test(s)) return 'dns';
  if (/econnrefused|econnreset|ehostunreach|enetunreach|connect/.test(s)) {
    return 'connection';
  }
  if (/certificate|cert_|ssl|tls|self.signed|hostname/.test(s)) return 'tls';
  if (/keyword/.test(s)) return 'keyword_missing';
  if (statusCode !== null) {
    if (statusCode >= 500) return 'http_error_5xx';
    if (statusCode >= 400) return 'http_error_4xx';
    return 'http_error_other';
  }
  return 'unknown';
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

  const verdict = isOngoing
    ? { tone: 'red' as const, label: '現在も継続中の障害です' }
    : { tone: 'green' as const, label: 'すでに復旧しました' };

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

  return `
    ${renderHeader(monitor)}
    <main class="space-y-6">
      <section class="glass rounded-2xl p-6 sm:p-7">
        <span class="inline-flex items-center gap-2 text-xs font-medium px-3 py-1.5 rounded-full ${toneClass(verdict.tone)}">
          <span class="w-1.5 h-1.5 rounded-full" style="background:currentColor"></span>
          ${escapeHtml(verdict.label)}
        </span>
        <h2 class="mt-4 text-lg sm:text-xl font-semibold text-slate-100 leading-snug">
          ${escapeHtml(copy.headline)}
        </h2>
        <p class="mt-2 text-sm text-slate-300">
          ${escapeHtml(copy.detail)}
        </p>

        <dl class="mt-6 grid grid-cols-1 sm:grid-cols-3 gap-4 text-sm">
          <div>
            <dt class="text-[10px] uppercase tracking-wider text-slate-500">発生</dt>
            <dd class="mt-1 text-slate-100">${startCell}</dd>
          </div>
          <div>
            <dt class="text-[10px] uppercase tracking-wider text-slate-500">${isOngoing ? '直近の確認時刻' : '復旧'}</dt>
            <dd class="mt-1 text-slate-100">${endCell}</dd>
          </div>
          <div>
            <dt class="text-[10px] uppercase tracking-wider text-slate-500">${escapeHtml(durationLabel)}</dt>
            <dd class="mt-1 text-slate-100">${escapeHtml(durationCell)}</dd>
          </div>
        </dl>
      </section>
    </main>
    ${renderFooter()}
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
          までの自動チェックはすべて成功しています。
        </p>
      </section>
    </main>
    ${renderFooter()}
  `;
}

function renderHeader(monitor: Monitor): string {
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
      <a href="${escapeAttr(monitor.url)}" target="_blank" rel="noopener noreferrer"
         class="text-sm text-slate-400 hover:text-slate-200 transition-colors break-all">
        ${escapeHtml(monitor.url)}
      </a>
    </header>
  `;
}

function renderFooter(): string {
  return `
    <footer class="mt-12 pt-6 border-t border-slate-800/50 text-xs text-slate-500 text-center">
      kuma-lite による自動監視
    </footer>
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
  return `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="robots" content="noindex" />
  <title>${escapeHtml(title)} · kuma-lite</title>
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
