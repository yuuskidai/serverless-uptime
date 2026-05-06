/**
 * Failure-kind classification shared between the status page tooltip
 * and the incident detail page. Keeps the user-facing wording consistent
 * across both surfaces.
 */

export type IncidentKind =
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

export interface KindCopy {
  headline: string;
  detail: string;
}

/**
 * Short, plain-Japanese headline shown on the status-page bar tooltip
 * and as the H2 on the incident detail page.
 */
export const KIND_HEADLINE: Record<IncidentKind, string> = {
  http_500: 'システムエラー',
  http_502: '連携先サーバーの不具合',
  http_503: 'サービス一時停止',
  http_504: '応答タイムアウト',
  http_5xx: 'サーバー側のエラー',
  http_401: '認証エラー',
  http_403: 'アクセス拒否',
  http_404: 'ページ未発見',
  http_429: 'アクセス制限',
  http_4xx: 'リクエストエラー',
  http_other: '想定外の応答',
  timeout: '応答遅延',
  dns: 'ドメイン解決失敗',
  connection: '接続失敗',
  tls: '暗号化通信失敗',
  keyword_missing: 'ページ内容の異常',
  unknown: 'アクセス不可',
};

/** Full copy (headline + 1-line detail) used on the incident detail page. */
export const KIND_COPY: Record<IncidentKind, KindCopy> = {
  http_500: {
    headline: KIND_HEADLINE.http_500,
    detail: 'サイト内部の処理でエラーが発生していました。',
  },
  http_502: {
    headline: KIND_HEADLINE.http_502,
    detail: '連携先サーバーから応答を受け取れない状態でした。',
  },
  http_503: {
    headline: KIND_HEADLINE.http_503,
    detail: 'アクセス集中またはメンテナンスにより応答を停止していました。',
  },
  http_504: {
    headline: KIND_HEADLINE.http_504,
    detail: 'サイトの応答処理が時間内に完了していませんでした。',
  },
  http_5xx: {
    headline: KIND_HEADLINE.http_5xx,
    detail: 'サーバー側で問題が発生し、応答できない状態でした。',
  },
  http_401: {
    headline: KIND_HEADLINE.http_401,
    detail: 'アクセスに必要な認証が通っていない状態でした。',
  },
  http_403: {
    headline: KIND_HEADLINE.http_403,
    detail: 'サーバーがアクセスを拒否していました。',
  },
  http_404: {
    headline: KIND_HEADLINE.http_404,
    detail: '指定のページがサーバーに存在しませんでした。',
  },
  http_429: {
    headline: KIND_HEADLINE.http_429,
    detail: '短時間に多数のアクセスが集中したため、一時的に制限されていました。',
  },
  http_4xx: {
    headline: KIND_HEADLINE.http_4xx,
    detail: 'リクエスト内容に問題があり、正常に応答できませんでした。',
  },
  http_other: {
    headline: KIND_HEADLINE.http_other,
    detail: 'サーバーから想定外の応答が返ってきていました。',
  },
  timeout: {
    headline: KIND_HEADLINE.timeout,
    detail: '応答が遅く、画面の読み込みが完了しない状態でした。',
  },
  dns: {
    headline: KIND_HEADLINE.dns,
    detail: 'サイトのアドレスを特定できない状態でした。',
  },
  connection: {
    headline: KIND_HEADLINE.connection,
    detail: 'サイトに接続できない状態でした。',
  },
  tls: {
    headline: KIND_HEADLINE.tls,
    detail: '安全な通信を確立できない状態でした。',
  },
  keyword_missing: {
    headline: KIND_HEADLINE.keyword_missing,
    detail: 'ページは表示されましたが、想定された内容ではありませんでした。',
  },
  unknown: {
    headline: KIND_HEADLINE.unknown,
    detail: 'サイトに正常にアクセスできない状態でした。',
  },
};

/**
 * Classify a failed check into a kind. The `error` string takes precedence
 * over the status code for network-level failures (timeout / DNS / TCP /
 * TLS) because the status code is null in those cases anyway. When only
 * a status code is available, the function falls back to the HTTP code
 * branches so that 500 vs 502 vs 503 vs 504 each get their own headline.
 *
 * If the error string carries an embedded "got NNN" pattern (which the
 * monitor emits for status-mismatch failures), the embedded code is used
 * as a hint when the explicit `statusCode` argument is null.
 */
export function classify(error: string | null, statusCode: number | null): IncidentKind {
  const s = (error ?? '').toLowerCase();
  if (/timeout|timed out/.test(s)) return 'timeout';
  if (/getaddrinfo|enotfound|dns/.test(s)) return 'dns';
  if (/econnrefused|econnreset|ehostunreach|enetunreach|connect/.test(s)) {
    return 'connection';
  }
  if (/certificate|cert_|ssl|tls|self.signed|hostname/.test(s)) return 'tls';
  if (/keyword/.test(s)) return 'keyword_missing';

  let code = statusCode;
  if (code === null) {
    const m = /got\s+(\d{3})/.exec(s);
    if (m) code = Number.parseInt(m[1] ?? '', 10);
  }
  if (code !== null && Number.isFinite(code)) {
    if (code === 500) return 'http_500';
    if (code === 502) return 'http_502';
    if (code === 503) return 'http_503';
    if (code === 504) return 'http_504';
    if (code >= 500) return 'http_5xx';
    if (code === 401) return 'http_401';
    if (code === 403) return 'http_403';
    if (code === 404) return 'http_404';
    if (code === 429) return 'http_429';
    if (code >= 400) return 'http_4xx';
    return 'http_other';
  }
  return 'unknown';
}
