import type {
  CheckBinaryStatus,
  CheckResult,
  CheckStatus,
  ComponentHealth,
  Env,
  HealthzPayload,
  HealthzStatus,
  MaintenanceWindow,
  Monitor,
  MonitorState,
} from './types';
import { type IncidentDetail, notifyDegraded, notifyDown, notifyUp } from './notifier';

const BATCH_SIZE = 40;

export async function runChecks(env: Env): Promise<void> {
  const now = Date.now();
  const monitors = await env.DB.prepare(
    `SELECT * FROM monitors WHERE enabled = 1`,
  ).all<Monitor>();

  const due = (monitors.results ?? []).filter((m) => isDue(m, now));
  if (due.length === 0) return;

  for (let i = 0; i < due.length; i += BATCH_SIZE) {
    const batch = due.slice(i, i + BATCH_SIZE);
    await Promise.all(batch.map((m) => checkAndRecord(env, m, now)));
  }
}

function isDue(monitor: Monitor, now: number): boolean {
  const interval = Math.max(1, monitor.interval_minutes ?? 1);
  if (interval <= 1) return true;
  const minute = Math.floor(now / 60_000);
  return minute % interval === 0;
}

async function checkAndRecord(env: Env, monitor: Monitor, ts: number): Promise<void> {
  const result = await performCheck(env, monitor);
  const inMaintenance = isInsideMaintenance(result.maintenance, ts);

  await env.DB.prepare(
    `INSERT INTO checks (
       monitor_id, status, status_code, latency_ms, error, ts,
       healthz_status, healthz_reason, healthz_components, healthz_version,
       used_fallback, in_maintenance
     )
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      monitor.id,
      result.status,
      result.status_code,
      result.latency_ms,
      result.error,
      ts,
      result.healthz_status,
      result.healthz_reason,
      result.healthz_components,
      result.healthz_version,
      result.used_fallback ? 1 : 0,
      inMaintenance ? 1 : 0,
    )
    .run();

  await reconcileState(env, monitor, result, ts, inMaintenance);
}

/**
 * Runs the structured `/healthz` probe with a fallback chain:
 *   1. Fetch `monitor.url` (typically /healthz).
 *   2. If JSON parse succeeds, trust it (per spec §1.3, JSON wins over
 *      HTTP code mismatch).
 *   3. If the response is non-JSON, parse failed, timed out, or returned
 *      an unexpected non-spec status, fall through to `monitor.fallback_url`
 *      (when configured) and run the legacy "did the site itself respond"
 *      check.
 *   4. If neither succeeds, the monitor is `down`.
 *
 * The fallback path keeps us blind-resistant: an app-layer /healthz bug
 * shouldn't make the rest of the monitoring loop go silent. When fallback
 * succeeds while /healthz failed, we record `degraded` so the badge
 * surfaces the problem without firing a full DOWN alert.
 */
export async function performCheck(env: Env, monitor: Monitor): Promise<CheckResult> {
  const fetcher = resolveFetcher(env, monitor);
  const primary = await probe(
    fetcher,
    monitor.url,
    monitor.method || 'GET',
    monitor.timeout_ms ?? 10_000,
  );

  // Path A: primary returned a body we could parse as the spec'd JSON.
  if (primary.parsedHealthz) {
    return resultFromHealthz(monitor, primary);
  }

  // Path B: primary returned a body, but it didn't speak the spec. Treat
  // it as a legacy site — fall back to the simple status-code + keyword
  // logic against the same URL.
  if (primary.bodySample !== null && !primary.networkFailure) {
    return resultFromLegacy(monitor, primary);
  }

  // Path C: primary failed at the network/parse level. Try the fallback
  // URL if one is configured.
  if (monitor.fallback_url) {
    const fb = await probe(
      fetcher,
      monitor.fallback_url,
      monitor.method || 'GET',
      monitor.timeout_ms ?? 10_000,
    );

    if (fb.networkFailure || fb.statusCode === null) {
      return downResult(primary, fb, true, '監視対象に接続できません');
    }

    // Fallback URL responded → site is at least partially alive. Mark
    // degraded so the badge changes color but the bars stay green for
    // the fallback success.
    if (fb.statusCode >= 200 && fb.statusCode < 400) {
      return {
        status: 'up',
        status_code: fb.statusCode,
        latency_ms: fb.latencyMs,
        error: null,
        healthz_status: 'down',
        healthz_reason: 'ヘルスチェック応答なし、サイト本体は応答',
        healthz_components: null,
        healthz_version: null,
        used_fallback: true,
        maintenance: null,
      };
    }

    // Fallback URL returned an error code too → site genuinely down.
    return {
      status: 'down',
      status_code: fb.statusCode,
      latency_ms: fb.latencyMs,
      error: `Fallback URL returned ${fb.statusCode}`,
      healthz_status: 'down',
      healthz_reason: 'サイトが応答していません',
      healthz_components: null,
      healthz_version: null,
      used_fallback: true,
      maintenance: null,
    };
  }

  // No fallback configured and primary failed → genuine down.
  return downResult(primary, null, false, primary.error ?? 'unknown error');
}

interface ProbeOutcome {
  statusCode: number | null;
  latencyMs: number | null;
  /** First ~4KB of body (or null on read failure / empty body). */
  bodySample: string | null;
  /** Parsed Healthz payload if the body was JSON shaped to spec. */
  parsedHealthz: HealthzPayload | null;
  /** True when the fetch threw before completing (DNS, TCP, TLS, abort). */
  networkFailure: boolean;
  /** Free-form error string for legacy persistence / classification. */
  error: string | null;
}

/**
 * Pick the fetch implementation used to probe a given monitor.
 *
 * For monitored Workers that share the same Cloudflare account as
 * kuma-lite, a bare `fetch()` to their `*.workers.dev` URL is
 * blocked by the runtime with `error code: 1042` (same-zone
 * recursion guard) — the request never reaches the destination, no
 * Cloudflare Access policy or DNS trick can rescue it. The
 * documented escape hatch is a service binding declared in
 * wrangler.toml. The `monitors.service_binding` column names which
 * binding to use; we look it up on `env` and use that binding's
 * `.fetch()` method, which is API-compatible with the global
 * fetch.
 *
 * If the binding name doesn't resolve (typo, or wrangler.toml
 * hasn't shipped the binding yet), we fall back to global `fetch`.
 * The probe will then likely fail with whatever the runtime gives
 * back (1042 for same-zone targets), which is a clearer signal than
 * silently skipping the check.
 */
function resolveFetcher(env: Env, monitor: Monitor): Fetcher {
  if (!monitor.service_binding) return { fetch: globalThis.fetch.bind(globalThis) } as Fetcher;
  const bound = (env as unknown as Record<string, Fetcher | undefined>)[monitor.service_binding];
  if (!bound) {
    console.warn(
      `monitor ${monitor.id} references service_binding=${monitor.service_binding} but no such binding exists on env; falling back to global fetch`,
    );
    return { fetch: globalThis.fetch.bind(globalThis) } as Fetcher;
  }
  return bound;
}

async function probe(
  fetcher: Fetcher,
  url: string,
  method: string,
  timeoutMs: number,
): Promise<ProbeOutcome> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const start = Date.now();

  try {
    const response = await fetcher.fetch(url, {
      method,
      signal: controller.signal,
      redirect: 'follow',
      headers: { 'User-Agent': 'kuma-lite/0.2 (uptime monitor)' },
    });
    const latency = Date.now() - start;
    const body = await safeReadBody(response);
    const parsed = body ? tryParseHealthz(body, response.headers.get('content-type')) : null;

    return {
      statusCode: response.status,
      latencyMs: latency,
      bodySample: body,
      parsedHealthz: parsed,
      networkFailure: false,
      error: null,
    };
  } catch (err) {
    const latency = Date.now() - start;
    const aborted = (err as Error)?.name === 'AbortError';
    return {
      statusCode: null,
      latencyMs: latency,
      bodySample: null,
      parsedHealthz: null,
      networkFailure: true,
      error: aborted ? `Timeout after ${timeoutMs}ms` : errorMessage(err),
    };
  } finally {
    clearTimeout(timer);
  }
}

function tryParseHealthz(body: string, contentType: string | null): HealthzPayload | null {
  // Be permissive: some sites set `application/json` without a charset
  // suffix, others set `text/plain` for /healthz. We try parse-first,
  // and only require Content-Type when the body itself doesn't look
  // like JSON.
  const trimmed = body.trim();
  const looksJson = trimmed.startsWith('{') || trimmed.startsWith('[');
  if (!looksJson && !(contentType ?? '').toLowerCase().includes('json')) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const obj = parsed as Record<string, unknown>;
  // Heuristic: must look like a Healthz payload, not just any JSON.
  // We accept either an explicit `status` field with a known value, or
  // a `components` array — at least one of those tells us it's spec-shaped.
  const status = obj.status;
  const knownStatus = status === 'ok' || status === 'degraded' || status === 'down';
  const hasComponents = Array.isArray(obj.components);
  if (!knownStatus && !hasComponents) return null;
  return obj as HealthzPayload;
}

function resultFromHealthz(monitor: Monitor, p: ProbeOutcome): CheckResult {
  const payload = p.parsedHealthz!;
  const healthzStatus: HealthzStatus = normaliseHealthzStatus(payload.status);
  const components = sanitiseComponents(payload.components);
  const componentsJson = components.length > 0 ? JSON.stringify(components) : null;
  const version = typeof payload.version === 'string' ? payload.version.slice(0, 64) : null;
  const maintenance = parseMaintenance(payload.maintenance ?? null);
  const reason = typeof payload.reason === 'string' && payload.reason.trim()
    ? payload.reason.trim()
    : null;

  // Spec §1.3 — JSON wins over HTTP code mismatch. We drive `status`
  // entirely off `healthzStatus`. degraded → still 'up' for binary
  // bookkeeping (the bars stay green); the nuance lives on the badge.
  const binary: CheckBinaryStatus = healthzStatus === 'down' ? 'down' : 'up';
  void monitor; // kept for future per-monitor overrides
  return {
    status: binary,
    status_code: p.statusCode,
    latency_ms: p.latencyMs,
    error: binary === 'down' ? reason ?? 'healthz reported down' : null,
    healthz_status: healthzStatus,
    healthz_reason: reason,
    healthz_components: componentsJson,
    healthz_version: version,
    used_fallback: false,
    maintenance,
  };
}

function resultFromLegacy(monitor: Monitor, p: ProbeOutcome): CheckResult {
  // Legacy site path: status code + keyword check, no structured info.
  const expected = monitor.expected_status ?? 200;
  if (p.statusCode !== expected) {
    return {
      status: 'down',
      status_code: p.statusCode,
      latency_ms: p.latencyMs,
      error: `Expected status ${expected}, got ${p.statusCode}${
        p.bodySample ? `: ${p.bodySample.slice(0, 120)}` : ''
      }`,
      healthz_status: null,
      healthz_reason: null,
      healthz_components: null,
      healthz_version: null,
      used_fallback: false,
      maintenance: null,
    };
  }
  if (monitor.keyword && p.bodySample !== null && !p.bodySample.includes(monitor.keyword)) {
    return {
      status: 'down',
      status_code: p.statusCode,
      latency_ms: p.latencyMs,
      error: `Keyword "${monitor.keyword}" not found in response`,
      healthz_status: null,
      healthz_reason: null,
      healthz_components: null,
      healthz_version: null,
      used_fallback: false,
      maintenance: null,
    };
  }
  return {
    status: 'up',
    status_code: p.statusCode,
    latency_ms: p.latencyMs,
    error: null,
    healthz_status: null,
    healthz_reason: null,
    healthz_components: null,
    healthz_version: null,
    used_fallback: false,
    maintenance: null,
  };
}

function downResult(
  primary: ProbeOutcome,
  fallback: ProbeOutcome | null,
  usedFallback: boolean,
  reason: string,
): CheckResult {
  const errParts: string[] = [];
  if (primary.error) errParts.push(`primary: ${primary.error}`);
  if (fallback?.error) errParts.push(`fallback: ${fallback.error}`);
  return {
    status: 'down',
    status_code: fallback?.statusCode ?? primary.statusCode,
    latency_ms: fallback?.latencyMs ?? primary.latencyMs,
    error: errParts.length > 0 ? errParts.join(' / ') : reason,
    healthz_status: 'down',
    healthz_reason: reason,
    healthz_components: null,
    healthz_version: null,
    used_fallback: usedFallback,
    maintenance: null,
  };
}

function normaliseHealthzStatus(input: unknown): HealthzStatus {
  if (input === 'ok' || input === 'degraded' || input === 'down') return input;
  return 'ok';
}

function sanitiseComponents(input: unknown): ComponentHealth[] {
  if (!Array.isArray(input)) return [];
  const out: ComponentHealth[] = [];
  for (const raw of input) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    const name = typeof r.name === 'string' ? r.name.slice(0, 200) : null;
    if (!name) continue;
    const status = normaliseHealthzStatus(r.status);
    const latency =
      typeof r.latency_ms === 'number' && Number.isFinite(r.latency_ms)
        ? Math.max(0, Math.floor(r.latency_ms))
        : undefined;
    const reason =
      typeof r.reason === 'string' && r.reason.trim() ? r.reason.trim().slice(0, 500) : null;
    out.push({ name, status, latency_ms: latency, reason });
    if (out.length >= 20) break; // sanity cap; spec doesn't bound this
  }
  return out;
}

function parseMaintenance(input: HealthzPayload['maintenance']): MaintenanceWindow | null {
  if (!input || typeof input !== 'object') return null;
  const from = typeof input.from === 'string' ? input.from : null;
  const to = typeof input.to === 'string' ? input.to : null;
  const reason = typeof input.reason === 'string' && input.reason.trim()
    ? input.reason.trim().slice(0, 500)
    : null;
  if (!from || !to || !reason) return null;
  const fromMs = Date.parse(from);
  const toMs = Date.parse(to);
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) return null;
  return { from, to, reason, from_ms: fromMs, to_ms: toMs };
}

function isInsideMaintenance(window: MaintenanceWindow | null, ts: number): boolean {
  if (!window) return false;
  return ts >= window.from_ms && ts < window.to_ms;
}

async function safeReadBody(response: Response): Promise<string | null> {
  try {
    const text = await response.text();
    // Cap to avoid pulling unbounded HTML pages into memory.
    return text.length > 8192 ? text.slice(0, 8192) : text;
  } catch {
    return null;
  }
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

async function reconcileState(
  env: Env,
  monitor: Monitor,
  result: CheckResult,
  ts: number,
  inMaintenance: boolean,
): Promise<void> {
  const previous = await env.DB.prepare(
    `SELECT * FROM monitor_state WHERE monitor_id = ?`,
  )
    .bind(monitor.id)
    .first<MonitorState>();

  const prevStatus: CheckStatus = previous?.current_status ?? 'up';
  const prevFailures = previous?.consecutive_failures ?? 0;
  const prevDownSince = previous?.down_since ?? null;
  const prevNotifiedAt = previous?.last_notified_at ?? null;
  const prevSlackAlertTs = previous?.slack_alert_ts ?? null;

  let nextStatus: CheckStatus = prevStatus;
  let nextFailures = prevFailures;
  let nextDownSince = prevDownSince;
  let nextNotifiedAt = prevNotifiedAt;
  let nextSlackAlertTs = prevSlackAlertTs;

  const threshold = Math.max(1, monitor.retry_threshold ?? 1);
  // Effective status from the latest check, before threshold smoothing:
  //   - binary down → 'down'
  //   - healthz_status === 'degraded' → 'degraded'
  //   - otherwise → 'up'
  const observed: CheckStatus =
    result.status === 'down'
      ? 'down'
      : result.healthz_status === 'degraded'
      ? 'degraded'
      : 'up';

  if (result.status === 'down') {
    nextFailures = prevFailures + 1;
    if (prevStatus !== 'down' && nextFailures >= threshold) {
      nextStatus = 'down';
      nextDownSince = ts;
      nextNotifiedAt = ts;
      // Suppress Slack/Discord alerts while inside a declared maintenance
      // window (per spec §2). The state still flips so the page shows a
      // blue maintenance bar.
      if (!inMaintenance) {
        const r = await safeNotifyDown(
          env,
          monitor,
          buildIncidentDetail(result, 'unknown error'),
        );
        nextSlackAlertTs = r?.slackAlertTs ?? null;
      }
    }
  } else if (observed === 'degraded') {
    nextFailures = 0;
    if (prevStatus === 'up') {
      nextStatus = 'degraded';
      nextNotifiedAt = ts;
      if (!inMaintenance) {
        await safeNotifyDegraded(env, monitor, buildIncidentDetail(result, '一部の機能が不調'));
      }
    } else if (prevStatus === 'down') {
      nextStatus = 'degraded';
      const downDurationMs = prevDownSince ? ts - prevDownSince : 0;
      nextDownSince = null;
      nextNotifiedAt = ts;
      if (!inMaintenance) {
        await safeNotifyUp(env, monitor, downDurationMs, prevSlackAlertTs);
      }
      nextSlackAlertTs = null;
    }
  } else {
    nextFailures = 0;
    if (prevStatus === 'down') {
      nextStatus = 'up';
      const downDurationMs = prevDownSince ? ts - prevDownSince : 0;
      nextDownSince = null;
      nextNotifiedAt = ts;
      if (!inMaintenance) {
        await safeNotifyUp(env, monitor, downDurationMs, prevSlackAlertTs);
      }
      nextSlackAlertTs = null;
    } else if (prevStatus === 'degraded') {
      nextStatus = 'up';
      nextNotifiedAt = ts;
    }
  }

  // Maintenance fields: store latest declaration verbatim. Cleared
  // (NULL) when site stops declaring or the window has expired.
  let maintenanceFrom: number | null = null;
  let maintenanceTo: number | null = null;
  let maintenanceReason: string | null = null;
  if (result.maintenance && result.maintenance.to_ms > ts) {
    maintenanceFrom = result.maintenance.from_ms;
    maintenanceTo = result.maintenance.to_ms;
    maintenanceReason = result.maintenance.reason;
  }

  await env.DB.prepare(
    `INSERT INTO monitor_state (
       monitor_id, current_status, consecutive_failures, last_notified_at,
       down_since, slack_alert_ts, maintenance_from, maintenance_to, maintenance_reason
     )
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(monitor_id) DO UPDATE SET
       current_status = excluded.current_status,
       consecutive_failures = excluded.consecutive_failures,
       last_notified_at = excluded.last_notified_at,
       down_since = excluded.down_since,
       slack_alert_ts = excluded.slack_alert_ts,
       maintenance_from = excluded.maintenance_from,
       maintenance_to = excluded.maintenance_to,
       maintenance_reason = excluded.maintenance_reason`,
  )
    .bind(
      monitor.id,
      nextStatus,
      nextFailures,
      nextNotifiedAt,
      nextDownSince,
      nextSlackAlertTs,
      maintenanceFrom,
      maintenanceTo,
      maintenanceReason,
    )
    .run();
}

async function safeNotifyDown(
  env: Env,
  monitor: Monitor,
  detail: IncidentDetail,
): Promise<{ slackAlertTs: string | null } | null> {
  try {
    return await notifyDown(env, monitor, detail);
  } catch (err) {
    console.error('notifyDown failed:', errorMessage(err));
    return null;
  }
}

async function safeNotifyDegraded(
  env: Env,
  monitor: Monitor,
  detail: IncidentDetail,
): Promise<void> {
  try {
    await notifyDegraded(env, monitor, detail);
  } catch (err) {
    console.error('notifyDegraded failed:', errorMessage(err));
  }
}

/**
 * Construct the IncidentDetail bundle that the webhook renderer
 * expects from the live `CheckResult`. Walks three sources of
 * truth in order — the structured `healthz_reason`, then the raw
 * monitor `error`, then a caller-provided fallback ("unknown error"
 * / "一部の機能が不調") — so spec-conformant sites get business
 * language while legacy sites still produce a usable headline.
 *
 * `components` is filtered to *unhealthy* entries (status !== 'ok')
 * because the webhook renderer assumes everything passed in is
 * worth surfacing — listing five healthy components on a DOWN
 * alert is just noise.
 */
function buildIncidentDetail(result: CheckResult, fallbackReason: string): IncidentDetail {
  const reason = result.healthz_reason ?? result.error ?? fallbackReason;
  let unhealthy: ComponentHealth[] = [];
  if (result.healthz_components) {
    try {
      const parsed = JSON.parse(result.healthz_components);
      if (Array.isArray(parsed)) {
        unhealthy = parsed.filter(
          (c): c is ComponentHealth =>
            c &&
            typeof c === 'object' &&
            typeof c.name === 'string' &&
            (c.status === 'down' || c.status === 'degraded'),
        );
      }
    } catch {
      // Stored JSON should always parse — sanitiseComponents writes it —
      // but if it ever doesn't, omit the components rather than crash
      // the alert path.
    }
  }
  return {
    reason,
    components: unhealthy,
    version: result.healthz_version,
  };
}

async function safeNotifyUp(
  env: Env,
  monitor: Monitor,
  downDurationMs: number,
  slackAlertTs: string | null,
): Promise<void> {
  try {
    await notifyUp(env, monitor, downDurationMs, slackAlertTs);
  } catch (err) {
    console.error('notifyUp failed:', errorMessage(err));
  }
}

export async function cleanupOldChecks(env: Env): Promise<void> {
  const days = Number.parseInt(env.RETENTION_DAYS ?? '7', 10) || 7;
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  // Roll any completed days into daily_summary before pruning the raw
  // rows that fed them. INSERT OR IGNORE so days already summarised
  // (by a previous cron tick or by the migration's seed insert) are
  // left alone — only newly-completed days get added. Computed first
  // so a prune that races a summary insert can't leave a hole.
  const todayMidnight = Math.floor(Date.now() / 86_400_000) * 86_400_000;
  await env.DB.prepare(
    `INSERT OR IGNORE INTO daily_summary (monitor_id, day_ms, ups, downs, maints)
     SELECT monitor_id,
            (ts / 86400000) * 86400000 AS day_ms,
            SUM(CASE WHEN status = 'up' AND in_maintenance = 0 THEN 1 ELSE 0 END),
            SUM(CASE WHEN status = 'down' AND in_maintenance = 0 THEN 1 ELSE 0 END),
            SUM(CASE WHEN in_maintenance = 1 THEN 1 ELSE 0 END)
       FROM checks
      WHERE ts < ?
      GROUP BY monitor_id, day_ms`,
  )
    .bind(todayMidnight)
    .run();
  await env.DB.prepare(`DELETE FROM checks WHERE ts < ?`).bind(cutoff).run();
}
