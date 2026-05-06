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
 * Concrete failure categories. Headlines and details aim for the wording
 * a non-technical reader would actually use to describe what happened —
 * "サービス一時停止" rather than "判定しました". HTTP-code branches
 * (500 / 502 / 503 / 504, 401 / 403 / 404 / 429) carry meaningful
 * differences in operator response and are surfaced separately so the
 * detail page is genuinely informative.
 */
type IncidentKind =
  | 'http_500'
  | 'http_502'
  | 'http_503'
  | 'http_504'
  | 'http_5xx'
  | 'http_401'
  | 'http_403'
  | 'http_404'
  | 'http_429'
  | 'http_4xx'
  | 'http_other'
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
  http_500: {
    headline: 'システムエラー',
    detail: 'サイト内部の処理でエラーが発生していました。',
  },
  http_502: {
    headline: '連携先サーバーの不具合',
    detail: '連携先サーバーから応答を受け取れない状態でした。',
  },
  http_503: {
    headline: 'サービス一時停止',
    detail: 'アクセス集中またはメンテナンスにより応答を停止していました。',
  },
  http_504: {
    headline: '応答タイムアウト',
    detail: 'サイトの応答処理が時間内に完了していませんでした。',
  },
  http_5xx: {
    headline: 'サーバー側のエラー',
    detail: 'サーバー側で問題が発生し、応答できない状態でした。',
  },
  http_401: {
    headline: '認証エラー',
    detail: 'アクセスに必要な認証が通っていない状態でした。',
  },
  http_403: {
    headline: 'アクセス拒否',
    detail: 'サーバーがアクセスを拒否していました。',
  },
  http_404: {
    headline: 'ページ未発見',
    detail: '指定のページがサーバーに存在しませんでした。',
  },
  http_429: {
    headline: 'アクセス制限',
    detail: '短時間に多数のアクセスが集中したため、一時的に制限されていました。',
  },
  http_4xx: {
    headline: 'リクエストエラー',
    detail: 'リクエスト内容に問題があり、正常に応答できませんでした。',
  },
  http_other: {
    headline: '想定外の応答',
    detail: 'サーバーから想定外の応答が返ってきていました。',
  },
  timeout: {
    headline: '応答遅延',
    detail: '応答が遅く、画面の読み込みが完了しない状態でした。',
  },
  dns: {
    headline: 'ドメイン解決失敗',
    detail: 'サイトのアドレスを特定できない状態でした。',
  },
  connection: {
    headline: '接続失敗',
    detail: 'サイトに接続できない状態でした。',
  },
  tls: {
    headline: '暗号化通信失敗',
    detail: '安全な通信を確立できない状態でした。',
  },
  keyword_missing: {
    headline: 'ページ内容の異常',
    detail: 'ページは表示されましたが、想定された内容ではありませんでした。',
  },
  unknown: {
    headline: 'アクセス不可',
    detail: 'サイトに正常にアクセスできない状態でした。',
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
    if (statusCode === 500) return 'http_500';
    if (statusCode === 502) return 'http_502';
    if (statusCode === 503) return 'http_503';
    if (statusCode === 504) return 'http_504';
    if (statusCode >= 500) return 'http_5xx';
    if (statusCode === 401) return 'http_401';
    if (statusCode === 403) return 'http_403';
    if (statusCode === 404) return 'http_404';
    if (statusCode === 429) return 'http_429';
    if (statusCode >= 400) return 'http_4xx';
    return 'http_other';
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
            <dt class="text-[10px] uppercase tracking-wider text-slate-500">${escapeHtml(endLabel)}</dt>
            <dd class="mt-1 text-slate-100">${endCell}</dd>
          </div>
          <div>
            <dt class="text-[10px] uppercase tracking-wider text-slate-500">${escapeHtml(durationLabel)}</dt>
            <dd class="mt-1 text-slate-100">${escapeHtml(durationCell)}</dd>
          </div>
        </dl>
      </section>
    </main>
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
      <a href="${escapeAttr(monitor.url)}" target="_blank" rel="noopener noreferrer"
         class="mt-1 inline-block text-xs text-slate-500 hover:text-slate-300 transition-colors break-all font-mono">
        ${escapeHtml(monitor.url)}
      </a>
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
