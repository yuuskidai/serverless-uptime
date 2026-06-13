import type { Env } from './types';

/**
 * Schema gate — verify the D1 database carries every column the
 * current worker code needs *before* we let request and cron paths
 * issue queries against it. Without this check, a code deploy that
 * adds new SELECT/INSERT columns will throw a generic D1 exception
 * during request handling, surfacing to visitors as a Cloudflare
 * 1101 ("Worker threw exception") with no actionable detail.
 *
 * The gate runs at most once per isolate for a successful check
 * (positive cache only) so the hot request path stays cheap; a
 * failing check is re-attempted on the next request so the worker
 * recovers automatically once the operator applies the missing
 * migration.
 */

interface SchemaCheck {
  ok: boolean;
  /** "table.column" identifiers of the columns the gate could not find. */
  missing: string[];
}

/**
 * Canonical list of columns the current code path expects to read
 * or write. We pick one representative per migration step rather
 * than enumerating all of them so the gate stays small. Bump this
 * list whenever a new migration adds a load-bearing column.
 */
const REQUIRED_COLUMNS: Array<{ table: string; column: string }> = [
  { table: 'monitors', column: 'fallback_url' },
  { table: 'checks', column: 'healthz_status' },
  { table: 'checks', column: 'in_maintenance' },
  { table: 'monitor_state', column: 'maintenance_from' },
  { table: 'monitor_state', column: 'consecutive_degraded' },
  { table: 'daily_summary', column: 'day_ms' },
  { table: 'daily_summary', column: 'down_streak' },
];

let cached: SchemaCheck | null = null;

export async function ensureSchema(env: Env): Promise<SchemaCheck> {
  if (cached?.ok) return cached;

  // Dedupe by table so we PRAGMA each table once even when multiple
  // required columns share it, and run the PRAGMA calls in parallel
  // so the cold-isolate gate is one round-trip's worth of latency
  // instead of REQUIRED_COLUMNS.length.
  const tables = Array.from(new Set(REQUIRED_COLUMNS.map((c) => c.table)));
  const colsByTable = new Map<string, Set<string> | null>();
  await Promise.all(
    tables.map(async (table) => {
      try {
        const result = await env.DB.prepare(`PRAGMA table_info(${table})`).all<{ name: string }>();
        colsByTable.set(table, new Set((result.results ?? []).map((r) => r.name)));
      } catch (err) {
        // The table itself might be missing on a totally fresh DB.
        // Treat that as a missing-column signal rather than crashing
        // the gate.
        colsByTable.set(table, null);
        console.error(`schema gate: PRAGMA table_info(${table}) failed`, err);
      }
    }),
  );

  const missing: string[] = [];
  for (const { table, column } of REQUIRED_COLUMNS) {
    const cols = colsByTable.get(table);
    if (!cols || !cols.has(column)) missing.push(`${table}.${column}`);
  }
  const next: SchemaCheck = { ok: missing.length === 0, missing };
  if (next.ok) cached = next; // cache only successful results so we self-heal
  return next;
}

/**
 * Public 503 response shown to visitors when the gate fails. The
 * body intentionally does NOT name the missing columns, the
 * migration filename, or any other implementation detail per the
 * project's "no implementation language in user-facing strings"
 * rule. Operators get the specifics from Workers Logs via the
 * console.error in `logSchemaProblem` below.
 */
export function publicSchemaErrorResponse(): Response {
  return new Response(
    `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="robots" content="noindex" />
  <title>一時的に表示できません</title>
  <style>
    body {
      background: #0a0f1c;
      color: #e2e8f0;
      font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      margin: 0;
    }
    .card {
      max-width: 520px;
      padding: 40px;
      text-align: center;
      background: rgba(15, 23, 42, 0.55);
      border: 1px solid rgba(148, 163, 184, 0.18);
      border-radius: 16px;
    }
    h1 { font-size: 18px; margin: 0 0 12px; color: #f1f5f9; }
    p { font-size: 14px; line-height: 1.6; color: #94a3b8; margin: 0; }
  </style>
</head>
<body>
  <div class="card">
    <h1>一時的にステータスページを表示できません</h1>
    <p>少し経ってから再度アクセスしてください。<br/>復旧までしばらくお待ちください。</p>
  </div>
</body>
</html>`,
    {
      status: 503,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Retry-After': '60',
      },
    },
  );
}

/**
 * JSON variant for /api/* clients — same gate semantics as the
 * public HTML page, but machine-readable. Implementation detail is
 * still kept out of the body; operators inspect Workers Logs.
 */
export function apiSchemaErrorResponse(): Response {
  return new Response(JSON.stringify({ error: 'service_temporarily_unavailable' }), {
    status: 503,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Retry-After': '60',
    },
  });
}

/**
 * Single source of truth for the operator-facing log line. Stays
 * structured-ish so the Workers Logs UI can group by the "kuma-lite
 * schema gate failed" prefix.
 */
export function logSchemaProblem(check: SchemaCheck, where: string): void {
  console.error(
    `kuma-lite schema gate failed in ${where}: missing columns [${check.missing.join(', ')}]`,
  );
}
