import type { CheckRow, Env, Monitor, MonitorState } from './types';
import { formatJstDateTime } from './status-page';

const TIMEZONE = 'Asia/Tokyo';
const MAX_ROWS = 200;

export async function renderIncidentPage(env: Env, url: URL): Promise<Response> {
  const monitorId = Number.parseInt(url.searchParams.get('monitor_id') ?? '', 10);
  const from = Number.parseInt(url.searchParams.get('from') ?? '', 10);
  const to = Number.parseInt(url.searchParams.get('to') ?? '', 10);

  if (!Number.isFinite(monitorId) || !Number.isFinite(from) || !Number.isFinite(to) || to <= from) {
    return htmlResponse(
      shell(
        '不正なリンク',
        errorBlock('リンクのパラメータが正しくありません。トップに戻ってバーから選択してください。'),
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

/**
 * Translate raw check errors into a category that we can describe in
 * everyday Japanese. The bucket wording presented to readers is built
 * from the dominant kind across all failures in the window.
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
  /** Short label used in pills/headings ("サイトが応答しませんでした"). */
  headline: string;
  /** Plain-language explanation aimed at a non-technical reader. */
  explanation: string;
  /** Whose problem it is — used for the "Was it my fault?" section. */
  attribution: 'service' | 'network' | 'config' | 'unknown';
}

const KIND_COPY: Record<IncidentKind, KindCopy> = {
  http_error_5xx: {
    headline: 'サイトがエラー応答を返しました',
    explanation:
      'サーバーには到達できましたが、サーバー側で問題が起きていて正しい結果を返せない状態でした (サーバーの内部エラー)。',
    attribution: 'service',
  },
  http_error_4xx: {
    headline: '正しいページが返ってきませんでした',
    explanation:
      'リクエストに対してサーバーが「正常な内容ではない」応答を返しました。ページが移動・削除された、もしくは権限の設定が変わった可能性があります。',
    attribution: 'config',
  },
  http_error_other: {
    headline: '想定外の応答が返ってきました',
    explanation:
      '監視対象から、期待していたものとは違う種類の応答が返ってきました。サイトの状態が変わっている可能性があります。',
    attribution: 'service',
  },
  timeout: {
    headline: '応答が時間内に返ってきませんでした',
    explanation:
      '一定時間 (既定 10 秒) 待っても応答がなかったため、利用できない状態と判定しました。サーバー負荷や回線の混雑が考えられます。',
    attribution: 'service',
  },
  dns: {
    headline: 'サイトの場所が分かりませんでした',
    explanation:
      'ドメイン名 (例: example.com) を実際のサーバーの住所に変換できませんでした。ドメインの設定や DNS の問題が考えられます。',
    attribution: 'config',
  },
  connection: {
    headline: 'サイトに接続できませんでした',
    explanation:
      'サーバーまでネットワーク的に到達できませんでした。サービスが停止している、もしくはネットワーク経路に問題があった可能性があります。',
    attribution: 'service',
  },
  tls: {
    headline: '安全な通信が成立しませんでした',
    explanation:
      '通信を暗号化するための証明書か設定に問題があり、安全に接続できませんでした。証明書の有効期限切れや設定ミスがよくある原因です。',
    attribution: 'config',
  },
  keyword_missing: {
    headline: 'ページの内容が想定と違いました',
    explanation:
      'ページ自体は応答しましたが、表示されているはずの文言が見つかりませんでした。レイアウト変更、または画面に異常表示が出ていた可能性があります。',
    attribution: 'service',
  },
  unknown: {
    headline: 'サイトが利用できない状態でした',
    explanation:
      '具体的な原因は自動診断できませんでしたが、自動チェックでサイトに正常にアクセスできませんでした。',
    attribution: 'unknown',
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

/**
 * Pick the most informative kind across all failures. We bias toward
 * non-`unknown` categories so a single classifiable failure produces a
 * useful headline even when the rest of the window is `unknown`.
 */
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
  const { monitor, state, from, to, checks, failures } = args;
  const failureCount = failures.length;
  const totalChecks = checks.length;

  if (failureCount === 0) {
    return renderHealthyWindow(monitor, from, to);
  }

  const kind = dominantKind(failures);
  const copy = KIND_COPY[kind];
  const firstFailureTs = failures[0]?.ts ?? null;
  const lastFailureTs = failures[failures.length - 1]?.ts ?? null;
  const durationMs =
    firstFailureTs !== null && lastFailureTs !== null
      ? Math.max(0, lastFailureTs - firstFailureTs)
      : 0;
  const isOngoing = state?.current_status === 'down';
  const partial = failureCount > 0 && failureCount < totalChecks;

  return `
    ${renderHeader(monitor)}

    <main class="space-y-6">
      ${renderHero({ kind, copy, isOngoing, partial, firstFailureTs, lastFailureTs, durationMs })}

      ${renderWhatHappened(copy, failureCount, totalChecks, partial)}

      ${renderCurrentStatus(isOngoing)}

      ${renderTechnicalDetails(failures)}
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
        <h2 class="text-lg font-semibold text-slate-100">この時間帯は問題ありませんでした</h2>
        <p class="mt-2 text-sm text-slate-400">
          <span class="tabular-nums" data-jst-datetime="${from}">${formatJstDateTime(from)}</span>
          から
          <span class="tabular-nums" data-jst-datetime="${to}">${formatJstDateTime(to)}</span>
          までの自動チェックは、すべて正常に完了しています。
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
      <p class="text-xs uppercase tracking-[0.18em] text-slate-500 mb-2">障害レポート</p>
      <h1 class="text-2xl sm:text-3xl font-semibold tracking-tight text-slate-100">${escapeHtml(monitor.name)}</h1>
      <a href="${escapeAttr(monitor.url)}" target="_blank" rel="noopener noreferrer"
         class="text-sm text-slate-400 hover:text-slate-200 transition-colors break-all">
        ${escapeHtml(monitor.url)}
      </a>
    </header>
  `;
}

interface HeroArgs {
  kind: IncidentKind;
  copy: KindCopy;
  isOngoing: boolean;
  partial: boolean;
  firstFailureTs: number | null;
  lastFailureTs: number | null;
  durationMs: number;
}

function renderHero(args: HeroArgs): string {
  const { copy, isOngoing, partial, firstFailureTs, lastFailureTs, durationMs } = args;
  const verdictLabel = isOngoing
    ? '現在 利用できない状態です'
    : partial
    ? '一時的に利用しづらい状態でした'
    : '利用できない時間帯がありました';
  const verdictTone = isOngoing
    ? 'red'
    : partial
    ? 'amber'
    : 'red';
  const verdictPill = `
    <span class="inline-flex items-center gap-2 text-xs font-medium px-3 py-1.5 rounded-full ${toneClass(verdictTone)}">
      <span class="w-1.5 h-1.5 rounded-full" style="background:currentColor"></span>
      ${escapeHtml(verdictLabel)}
    </span>`;

  const startLine = firstFailureTs !== null
    ? `<span class="tabular-nums" data-jst-friendly="${firstFailureTs}">${formatJstFriendly(firstFailureTs)}</span>`
    : '—';
  const endLine = isOngoing
    ? '<span class="text-amber-300">継続中</span>'
    : lastFailureTs !== null
    ? `<span class="tabular-nums" data-jst-friendly="${lastFailureTs}">${formatJstFriendly(lastFailureTs)}</span>`
    : '—';
  const durationLabel = isOngoing
    ? `${formatHumanDuration(Math.max(0, Date.now() - (firstFailureTs ?? Date.now())))} 経過`
    : durationMs > 0
    ? `約 ${formatHumanDuration(durationMs)}`
    : '一瞬';

  return `
    <section class="glass rounded-2xl p-6 sm:p-7">
      <div class="flex flex-wrap items-start justify-between gap-3 mb-5">
        ${verdictPill}
      </div>
      <h2 class="text-lg sm:text-xl font-semibold text-slate-100 leading-snug">
        ${escapeHtml(copy.headline)}
      </h2>

      <ol class="mt-6 space-y-3 text-sm">
        <li class="flex items-start gap-3">
          <span class="flex-none mt-1 w-2 h-2 rounded-full bg-red-400" aria-hidden="true"></span>
          <span>
            <span class="block text-[10px] uppercase tracking-wider text-slate-500">問題が起き始めた時刻</span>
            <span class="block text-slate-100 mt-0.5">${startLine}</span>
          </span>
        </li>
        <li class="flex items-start gap-3">
          <span class="flex-none mt-1 w-2 h-2 rounded-full ${isOngoing ? 'bg-amber-400' : 'bg-green-400'}" aria-hidden="true"></span>
          <span>
            <span class="block text-[10px] uppercase tracking-wider text-slate-500">${isOngoing ? '今のところ最後に確認された不調' : '正常に戻った時刻'}</span>
            <span class="block text-slate-100 mt-0.5">${endLine}</span>
          </span>
        </li>
        <li class="flex items-start gap-3">
          <span class="flex-none mt-1 w-2 h-2 rounded-full bg-slate-500" aria-hidden="true"></span>
          <span>
            <span class="block text-[10px] uppercase tracking-wider text-slate-500">影響していた時間</span>
            <span class="block text-slate-100 mt-0.5">${escapeHtml(durationLabel)}</span>
          </span>
        </li>
      </ol>
    </section>
  `;
}

function renderWhatHappened(
  copy: KindCopy,
  failureCount: number,
  totalChecks: number,
  partial: boolean,
): string {
  const attributionCopy = {
    service: 'これは監視対象のサイト側で発生した事象です。閲覧していた方の回線や端末は無関係です。',
    network: '通信経路で発生した可能性のある事象です。場所や端末によって挙動が違ったかもしれません。',
    config: 'サイトの設定変更や、外部サービスとの連携部分で発生した可能性が高い事象です。',
    unknown: 'どこに原因があったかは自動では判断できませんでした。',
  } as const;

  const checksLine = partial
    ? `この時間帯に行った自動チェック ${totalChecks} 回のうち、${failureCount} 回が失敗しました。完全に止まっていたわけではなく、一部だけ反応しない状態だったと考えられます。`
    : `この時間帯に行った自動チェック ${totalChecks} 回がすべて失敗しました。サイトはこの間、ほぼ利用できない状態でした。`;

  return `
    <section>
      <h3 class="text-xs uppercase tracking-[0.18em] text-slate-500 mb-3">何が起きていたか</h3>
      <div class="glass rounded-2xl p-6 space-y-4 text-sm leading-relaxed text-slate-200">
        <p>${escapeHtml(copy.explanation)}</p>
        <p class="text-slate-300">${escapeHtml(checksLine)}</p>
        <p class="text-slate-400">${escapeHtml(attributionCopy[copy.attribution])}</p>
      </div>
    </section>
  `;
}

function renderCurrentStatus(isOngoing: boolean): string {
  if (isOngoing) {
    return `
      <section>
        <h3 class="text-xs uppercase tracking-[0.18em] text-slate-500 mb-3">現在の状況</h3>
        <div class="glass rounded-2xl p-6 border-amber-500/20">
          <div class="flex items-start gap-3">
            <span class="flex-none mt-0.5 w-8 h-8 rounded-full bg-amber-500/15 border border-amber-500/30 flex items-center justify-center">
              <svg class="w-4 h-4 text-amber-300" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
                <path fill-rule="evenodd" d="M8.485 2.495c.673-1.167 2.357-1.167 3.03 0l6.28 10.875c.673 1.167-.17 2.625-1.516 2.625H3.72c-1.347 0-2.189-1.458-1.515-2.625L8.485 2.495zM10 5a.75.75 0 01.75.75v3.5a.75.75 0 01-1.5 0v-3.5A.75.75 0 0110 5zm0 9a1 1 0 100-2 1 1 0 000 2z" clip-rule="evenodd"/>
              </svg>
            </span>
            <div>
              <p class="text-sm font-medium text-slate-100">現在もまだ復旧していません</p>
              <p class="mt-1 text-sm text-slate-400">
                自動チェックは引き続き 1 分ごとに実行されています。復旧が確認され次第、ステータスページの表示が自動的に変わります。
              </p>
            </div>
          </div>
        </div>
      </section>
    `;
  }
  return `
    <section>
      <h3 class="text-xs uppercase tracking-[0.18em] text-slate-500 mb-3">現在の状況</h3>
      <div class="glass rounded-2xl p-6 border-green-500/20">
        <div class="flex items-start gap-3">
          <span class="flex-none mt-0.5 w-8 h-8 rounded-full bg-green-500/15 border border-green-500/30 flex items-center justify-center">
            <svg class="w-4 h-4 text-green-300" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
              <path fill-rule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clip-rule="evenodd"/>
            </svg>
          </span>
          <div>
            <p class="text-sm font-medium text-slate-100">現在は通常通りに動作しています</p>
            <p class="mt-1 text-sm text-slate-400">
              この障害はすでに解消しています。同じ症状が出ていないかは、ステータスページの最新の表示で確認できます。
            </p>
          </div>
        </div>
      </div>
    </section>
  `;
}

function renderTechnicalDetails(failures: CheckRow[]): string {
  const rows = failures
    .map(
      (c) => `
        <tr>
          <td class="py-2 px-3 text-slate-300 font-mono tabular-nums whitespace-nowrap"
              data-jst-datetime="${c.ts}">${formatJstDateTime(c.ts)}</td>
          <td class="py-2 px-3 text-slate-300 font-mono tabular-nums">${
            c.status_code !== null ? `HTTP ${c.status_code}` : 'TIMEOUT'
          }</td>
          <td class="py-2 px-3 text-slate-400 font-mono text-[11px] break-all">
            ${c.error ? escapeHtml(c.error) : '<span class="text-slate-600">—</span>'}
          </td>
        </tr>`,
    )
    .join('\n');

  return `
    <section>
      <details class="glass rounded-2xl">
        <summary class="cursor-pointer select-none px-6 py-4 text-sm text-slate-300 hover:text-slate-100 flex items-center justify-between">
          <span class="flex items-center gap-2">
            <svg class="w-4 h-4 text-slate-500" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
              <path d="M5 4a2 2 0 012-2h6a2 2 0 012 2v14l-5-2.5L5 18V4z"/>
            </svg>
            技術者向け：詳細ログ (${failures.length} 件)
          </span>
          <span class="text-[11px] text-slate-500">クリックで展開</span>
        </summary>
        <div class="border-t border-slate-800/60 overflow-x-auto">
          <table class="min-w-full text-xs">
            <thead class="bg-slate-950/40">
              <tr class="text-left text-[10px] uppercase tracking-wider text-slate-500">
                <th class="py-2 px-3 font-medium">時刻 (JST)</th>
                <th class="py-2 px-3 font-medium">応答</th>
                <th class="py-2 px-3 font-medium">エラー詳細</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-slate-800/40">
              ${rows}
            </tbody>
          </table>
        </div>
      </details>
    </section>
  `;
}

function renderFooter(): string {
  return `
    <footer class="mt-12 pt-6 border-t border-slate-800/50 text-xs text-slate-500 text-center">
      自動監視 by kuma-lite (Cloudflare Workers)
    </footer>
  `;
}

function toneClass(tone: 'green' | 'amber' | 'red' | 'slate'): string {
  return {
    green: 'bg-green-500/10 text-green-300 border border-green-500/30',
    amber: 'bg-amber-500/10 text-amber-300 border border-amber-500/30',
    red: 'bg-red-500/10 text-red-300 border border-red-500/30',
    slate: 'bg-slate-500/10 text-slate-300 border border-slate-500/30',
  }[tone];
}

/**
 * Format a timestamp as `2026年5月6日 (火) 21:24` for the body of the
 * incident report. The day-of-week makes the date easier to place
 * mentally for a non-technical reader.
 */
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

/** Plain-language duration: 「3 分間」「2 時間 5 分」「1 日 4 時間」. */
function formatHumanDuration(ms: number): string {
  if (ms < 1000) return `${ms} ミリ秒`;
  if (ms < 60_000) return `${Math.max(1, Math.floor(ms / 1000))} 秒間`;
  const totalMin = Math.floor(ms / 60_000);
  if (totalMin < 60) return `${totalMin} 分間`;
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
  <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@300;400;500;600;700&family=Noto+Sans+JP:wght@400;500;600&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
  <script src="https://cdn.tailwindcss.com"></script>
  <script>
    tailwind.config = {
      theme: {
        extend: {
          fontFamily: {
            sans: ['"Plus Jakarta Sans"', '"Noto Sans JP"', 'system-ui', 'sans-serif'],
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
    details > summary { list-style: none; }
    details > summary::-webkit-details-marker { display: none; }
    details[open] > summary { border-bottom: 1px solid rgba(148, 163, 184, 0.10); }
  </style>
</head>
<body class="text-slate-100 font-sans antialiased">
  <div class="max-w-3xl mx-auto px-4 py-10">
    ${body}
  </div>
  <script>
    (function () {
      const TZ = ${JSON.stringify(TIMEZONE)};
      const dt = new Intl.DateTimeFormat('ja-JP', {
        timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
      });
      const friendly = new Intl.DateTimeFormat('ja-JP', {
        timeZone: TZ, year: 'numeric', month: 'long', day: 'numeric',
        weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
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
