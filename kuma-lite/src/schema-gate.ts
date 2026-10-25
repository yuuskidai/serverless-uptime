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

export interface SchemaCheck {
  ok: boolean;
  /** "table.column" identifiers of the columns the gate could not find. */
  missing: string[];
  reason?: 'schema_missing' | 'schema_timeout' | 'schema_unavailable';
}

export const SCHEMA_READ_BUDGET_MS = 5_000;

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
  { table: 'monitors', column: 'db_latency_threshold_ms' },
  { table: 'monitors', column: 'http_latency_threshold_ms' },
  { table: 'checks', column: 'scheduled_slot' },
  { table: 'checks', column: 'probe_trace_json' },
  { table: 'monitor_state', column: 'last_check_slot' },
  { table: 'monitor_state', column: 'consecutive_successes' },
  { table: 'monitor_execution', column: 'claimed_slot' },
  { table: 'monitor_execution', column: 'lease_token' },
  { table: 'monitor_execution', column: 'lease_until' },
  { table: 'monitors', column: 'probe_transport' },
  { table: 'monitors', column: 'monitor_role' },
  { table: 'monitors', column: 'parent_monitor_id' },
  { table: 'monitors', column: 'response_mode' },
  { table: 'monitors', column: 'config_revision' },
  { table: 'monitors', column: 'availability_since_ms' },
  { table: 'checks', column: 'config_revision' },
  { table: 'checks', column: 'monitor_role' },
  { table: 'checks', column: 'probe_transport' },
  { table: 'monitor_state', column: 'config_revision' },
  { table: 'monitor_attempts', column: 'attempt_id' },
  { table: 'monitor_attempts', column: 'reason' },
  { table: 'monitor_attempts', column: 'scheduled_time' },
  { table: 'monitor_attempts', column: 'run_id' },
  { table: 'monitor_attempts', column: 'release_outcome' },
  { table: 'monitor_runs', column: 'run_id' },
  { table: 'notification_outbox', column: 'status' },
  { table: 'notification_outbox', column: 'transition_json' },
  { table: 'notification_delivery_state', column: 'lease_token' },
  { table: 'external_probe_runs', column: 'payload_hash' },
  { table: 'external_observations', column: 'monitor_config_revision' },
];

let cached: SchemaCheck | null = null;

async function inspectSchema(env: Env): Promise<SchemaCheck> {
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
      } catch {
        // A failed read cannot establish whether a migration is missing.
        colsByTable.set(table, null);
        console.error({ event: 'schema_gate_unavailable', table });
      }
    }),
  );

  if (Array.from(colsByTable.values()).some((cols) => cols === null)) {
    return { ok: false, missing: [], reason: 'schema_unavailable' };
  }

  const missing: string[] = [];
  for (const { table, column } of REQUIRED_COLUMNS) {
    const cols = colsByTable.get(table);
    if (!cols || !cols.has(column)) missing.push(`${table}.${column}`);
  }
  return missing.length === 0 ? { ok: true, missing } : { ok: false, missing, reason: 'schema_missing' };
}

/** Only reads are abandoned at the deadline. A late result cannot fill the
 * positive cache, and the next invocation may recover without a write retry. */
export async function ensureSchema(env: Env, timeoutMs = SCHEMA_READ_BUDGET_MS): Promise<SchemaCheck> {
  if (cached?.ok) return cached;
  const startedAt = performance.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    let next = await Promise.race([
      inspectSchema(env),
      new Promise<SchemaCheck>((resolve) => {
        timer = setTimeout(() => resolve({ ok: false, missing: [], reason: 'schema_timeout' }), timeoutMs);
      }),
    ]);
    const elapsedMs = Math.max(0, performance.now() - startedAt);
    // A stalled event loop can resolve I/O before an overdue timer callback.
    // Enforce the absolute deadline again before accepting or caching a result.
    if (elapsedMs >= timeoutMs) next = { ok: false, missing: [], reason: 'schema_timeout' };
    if (next.reason === 'schema_timeout') {
      console.error({ event: 'schema_gate_timeout', budget_ms: timeoutMs, elapsed_ms: elapsedMs });
    }
    if (next.ok) cached = next;
    return next;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
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
  if (check.reason === 'schema_timeout' || check.reason === 'schema_unavailable') {
    console.error({ event: 'schema_gate_failed', reason: check.reason, where });
    return;
  }
  console.error(
    `kuma-lite schema gate failed in ${where}: missing columns [${check.missing.join(', ')}]`,
  );
}
