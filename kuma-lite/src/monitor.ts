import type {
  CheckResult, ComponentHealth, Env, HealthzPayload, HealthzStatus,
  MaintenanceWindow, Monitor, ProbeTrace,
} from './types';

type UntracedResult = Omit<CheckResult, 'probe_trace_json'>;
type ProbeFetcher = Pick<Fetcher, 'fetch'>;
const BODY_LIMIT_BYTES = 8192;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,64}$/;

/** Probe only the configured path. A service binding does not measure public DNS/TLS or a remote region. */
export async function performCheck(env: Env, monitor: Monitor): Promise<CheckResult> {
  const { fetcher, transport } = resolveFetcher(env, monitor);
  const strict = monitor.response_mode === 'strict_healthz';
  const traces: ProbeTrace[] = [];
  const run = async (attempt: ProbeTrace['attempt'], url: string) => {
    const result = await probe(fetcher, url, monitor.method || 'GET', monitor.timeout_ms ?? 10_000, attempt, transport, strict);
    traces.push(result.trace);
    // No URL, headers, response body or provider metadata enters this diagnostic event.
    console.info({ event: 'monitor_probe', monitor_id: monitor.id, ...result.trace });
    return result;
  };
  const finish = (result: UntracedResult): CheckResult => ({
    ...applyHttpThreshold(result, monitor), probe_trace_json: JSON.stringify(traces),
  });
  const primary = await run('primary', monitor.url);
  if (primary.parsedHealthz) return finish(resultFromHealthz(monitor, primary));
  // A site root or login page cannot replace this endpoint's readiness contract.
  if (strict) return finish(downResult(primary, null, false, primary.error ?? 'Invalid health response'));
  if (primary.bodySample !== null && !primary.networkFailure) return finish(resultFromLegacy(monitor, primary));

  if (monitor.fallback_url) {
    const fb = await run('fallback', monitor.fallback_url);
    if (fb.networkFailure || fb.statusCode === null) return finish(downResult(primary, fb, true, '監視対象に接続できません'));
    if (fb.statusCode >= 200 && fb.statusCode < 400) {
      return finish({
        status: 'up', status_code: fb.statusCode, latency_ms: fb.latencyMs, error: null,
        // A live fallback proves response recovery only, not that the failed health check recovered.
        healthz_status: 'degraded', healthz_reason: 'ヘルスチェック応答なし、サイト本体は応答',
        healthz_components: null, healthz_version: null, used_fallback: true, maintenance: null,
      });
    }
    return finish({
      status: 'down', status_code: fb.statusCode, latency_ms: fb.latencyMs,
      error: `Fallback URL returned ${fb.statusCode}`, healthz_status: 'down',
      healthz_reason: 'サイトが応答していません', healthz_components: null,
      healthz_version: null, used_fallback: true, maintenance: null,
    });
  }
  return finish(downResult(primary, null, false, primary.error ?? 'unknown error'));
}

interface ProbeOutcome {
  statusCode: number | null;
  latencyMs: number;
  bodySample: string | null;
  parsedHealthz: HealthzPayload | null;
  networkFailure: boolean;
  error: string | null;
  trace: ProbeTrace;
}

function resolveFetcher(env: Env, monitor: Monitor): { fetcher: ProbeFetcher; transport: ProbeTrace['transport'] } {
  const configured = monitor.probe_transport ?? 'legacy';
  if (configured !== 'legacy' && configured !== 'public_fetch' && configured !== 'service_binding') {
    return { fetcher: failedFetcher('Unknown probe transport'), transport: 'public_fetch' };
  }
  if (configured === 'service_binding' || (configured === 'legacy' && monitor.service_binding)) {
    const bound = monitor.service_binding
      ? (env as unknown as Record<string, Fetcher | undefined>)[monitor.service_binding] : undefined;
    if (bound && typeof bound.fetch === 'function') return { fetcher: bound, transport: 'service_binding' };
    if (configured === 'service_binding') {
      return { fetcher: failedFetcher('Service binding is unavailable'), transport: 'service_binding' };
    }
    console.warn(`monitor ${monitor.id} has an unavailable service binding; using public fetch`);
  }
  return { fetcher: { fetch: globalThis.fetch.bind(globalThis) }, transport: 'public_fetch' };
}

function failedFetcher(reason: string): ProbeFetcher {
  return { fetch: async () => { throw new Error(`Monitor configuration error: ${reason}`); } };
}

async function probe(
  fetcher: ProbeFetcher, url: string, method: string, timeoutMs: number,
  attempt: ProbeTrace['attempt'], transport: ProbeTrace['transport'],
  strict: boolean,
): Promise<ProbeOutcome> {
  const start = performance.now();
  const elapsed = () => Math.max(0, Math.round((performance.now() - start) * 10) / 10);
  const limit = Number.isFinite(timeoutMs) ? Math.min(30_000, Math.max(1, timeoutMs)) : 10_000;
  const deadline = start + limit;
  const controller = new AbortController();
  const { signal } = controller;
  const trace: ProbeTrace = {
    attempt, transport, request_id: crypto.randomUUID(), response_request_id: null,
    request_id_matched: false, status_code: null, headers_ms: null, body_ms: null,
    total_ms: 0, timeout_ms: limit, timeout_callback_elapsed_ms: null, deadline_overrun_ms: 0,
    failure_phase: null, body_truncated: false,
  };
  let rejectAbort!: (reason: unknown) => void;
  const aborted = new Promise<never>((_, reject) => { rejectAbort = reject; });
  const onAbort = () => rejectAbort(signal.reason);
  signal.addEventListener('abort', onAbort, { once: true });
  const timeoutError = () => new Error(`Timeout after ${limit}ms`);
  const assertBeforeDeadline = () => {
    // Workers' clock advances at I/O boundaries. A completed fetch/read can
    // resume before an overdue timer, so checking the signal alone is unsafe.
    if (!signal.aborted && performance.now() >= deadline) controller.abort(timeoutError());
    signal.throwIfAborted();
  };
  const finishTiming = () => {
    trace.total_ms = elapsed();
    trace.deadline_overrun_ms = Math.max(0, Math.round((trace.total_ms - limit) * 10) / 10);
  };
  const timer = setTimeout(() => {
    trace.timeout_callback_elapsed_ms = elapsed();
    controller.abort(timeoutError());
  }, Math.max(0, deadline - performance.now()));
  let response: Response | undefined;
  try {
    // The deadline covers headers AND body. A stalled body/cancel acknowledgement must not hold a Cron lease forever.
    const operation = (async () => {
      assertBeforeDeadline();
      if (strict) {
        const target = new URL(url);
        if (target.protocol !== 'https:' || target.username || target.password || method !== 'GET') {
          throw new Error('Strict health checks require credential-free HTTPS GET');
        }
      }
      response = await fetcher.fetch(url, {
        method, signal, redirect: strict ? 'manual' : 'follow',
        // Workers rejects cache:no-store combined with cf.cacheTtl. Use the
        // standard bypass by itself; response freshness is validated below.
        ...(strict ? { cache: 'no-store' as const } : {}),
        headers: { 'User-Agent': 'kuma-lite/0.3 (uptime monitor)', 'X-Monitor-Request-ID': trace.request_id },
      });
      try { assertBeforeDeadline(); }
      catch (error) {
        // The timeout race may already have returned before this fetch settles.
        // Its outer finally cannot cancel a response that did not exist yet.
        void response.body?.cancel().catch(() => undefined);
        throw error;
      }
      trace.status_code = response.status;
      trace.headers_ms = elapsed();
      const echoed = response.headers.get('X-Monitor-Request-ID');
      trace.response_request_id = echoed && REQUEST_ID_PATTERN.test(echoed) ? echoed : null;
      trace.request_id_matched = trace.response_request_id === trace.request_id;
      const body = await readBody(response, signal, assertBeforeDeadline);
      trace.body_truncated = body.truncated;
      trace.body_ms = Math.max(0, elapsed() - trace.headers_ms);
      assertBeforeDeadline();
      const contentType = response.headers.get('content-type');
      const parsed = tryParseHealthz(body.text, contentType);
      // Even a parseable JSON prefix can hide unread trailing data after the byte cap.
      // A truncated JSON response cannot prove readiness; only legacy non-JSON pages use a sample.
      const looksJson = /^[{\[]/.test(body.text.trimStart()) || (contentType ?? '').toLowerCase().includes('json');
      if (body.truncated && (strict || parsed !== null || looksJson)) throw new Error('Health response exceeds 8192 bytes');
      if (strict) validateStrictHealthz(response, parsed);
      assertBeforeDeadline();
      return { body: body.text, parsed };
    })();
    const { body, parsed } = await Promise.race([operation, aborted]);
    finishTiming();
    assertBeforeDeadline();
    return { statusCode: trace.status_code, latencyMs: trace.total_ms, bodySample: body,
      parsedHealthz: parsed, networkFailure: false, error: null, trace };
  } catch (err) {
    finishTiming();
    trace.failure_phase = trace.headers_ms === null ? 'headers' : 'body';
    if (trace.headers_ms !== null) trace.body_ms = Math.max(0, trace.total_ms - trace.headers_ms);
    return { statusCode: trace.status_code, latencyMs: trace.total_ms, bodySample: null,
      parsedHealthz: null, networkFailure: true, error: errorMessage(signal.aborted ? signal.reason : err), trace };
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', onAbort);
    if (signal.aborted && !response?.body?.locked) void response?.body?.cancel().catch(() => undefined);
  }
}

/** Fail closed for the readiness probes; legacy HTTP monitors retain their existing contract. */
function validateStrictHealthz(response: Response, payload: HealthzPayload | null): void {
  if (!/^application\/json(?:\s*;|\s*$)/i.test(response.headers.get('content-type') ?? '')) {
    throw new Error('Health response must use application/json');
  }
  if (!payload || typeof payload.status !== 'string' || !['ok', 'degraded', 'down'].includes(payload.status) ||
      !Array.isArray(payload.components) || payload.components.length === 0 || payload.components.length > 20) {
    throw new Error('Health response has an invalid readiness schema');
  }
  const names = new Set<string>();
  let hasDatabase = false;
  for (const component of payload.components) {
    if (!component || typeof component !== 'object' || typeof component.name !== 'string' ||
        !component.name.trim() || component.name.length > 200 ||
        typeof component.status !== 'string' || !['ok', 'degraded', 'down'].includes(component.status) ||
        (component.reason !== undefined && component.reason !== null && typeof component.reason !== 'string') ||
        (component.latency_ms !== undefined && (typeof component.latency_ms !== 'number' ||
          !Number.isFinite(component.latency_ms) || component.latency_ms < 0 || component.latency_ms > Number.MAX_SAFE_INTEGER))) {
      throw new Error('Health response has an invalid component');
    }
    const name = component.name.trim().toLowerCase();
    if (names.has(name)) throw new Error('Health response has duplicate components');
    names.add(name);
    if (isDatabase(component)) {
      if (hasDatabase || component.latency_ms === undefined) throw new Error('Health response has an invalid Database component');
      hasDatabase = true;
    }
  }
  if (!hasDatabase) throw new Error('Health response is missing the Database component');
  // A valid explicit DOWN may retain its component evidence on HTTP 503. No other
  // HTTP error, redirect or contradictory ok JSON can establish availability.
  if (response.status !== 200 && !(response.status === 503 && payload.status === 'down')) {
    throw new Error(`Health endpoint returned HTTP ${response.status}`);
  }
  const cacheControl = response.headers.get('cache-control') ?? '';
  const age = response.headers.get('age');
  const cacheStatus = response.headers.get('cf-cache-status')?.trim().toUpperCase();
  if (!/(?:^|,)\s*no-store\s*(?:,|$)/i.test(cacheControl) ||
      (age !== null && Number(age) > 0) || (cacheStatus && ['HIT', 'STALE', 'UPDATING', 'REVALIDATED'].includes(cacheStatus))) {
    throw new Error('Health response cannot establish fresh readiness (cache policy)');
  }
}

async function readBody(response: Response, signal: AbortSignal, assertBeforeDeadline: () => void): Promise<{ text: string; truncated: boolean }> {
  if (!response.body) return { text: '', truncated: false };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0, truncated = false;
  const cancel = () => { void reader.cancel(signal.reason).catch(() => undefined); };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    for (;;) {
      assertBeforeDeadline();
      const part = await reader.read();
      assertBeforeDeadline();
      if (part.done) break;
      const remaining = BODY_LIMIT_BYTES - total;
      if (part.value.byteLength > remaining) {
        if (remaining > 0) chunks.push(part.value.subarray(0, remaining));
        total += Math.max(0, remaining);
        truncated = true;
        break;
      }
      chunks.push(part.value); total += part.value.byteLength;
    }
  } finally {
    signal.removeEventListener('abort', cancel);
    if (truncated || signal.aborted) cancel();
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return { text: new TextDecoder().decode(bytes), truncated };
}

function tryParseHealthz(body: string, contentType: string | null): HealthzPayload | null {
  const text = body.trim();
  if (!text.startsWith('{') && !(contentType ?? '').toLowerCase().includes('json')) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const value = parsed as Record<string, unknown>;
    if (!['ok', 'degraded', 'down'].includes(String(value.status)) && !Array.isArray(value.components)) return null;
    return value as HealthzPayload;
  } catch { return null; }
}

function resultFromHealthz(monitor: Monitor, p: ProbeOutcome): UntracedResult {
  const payload = p.parsedHealthz!;
  const original = sanitiseComponents(payload.components);
  const threshold = positiveThreshold(monitor.db_latency_threshold_ms);
  const components = original.map(component => {
    if (!threshold || !isDatabase(component) || component.latency_ms === undefined || component.status === 'down') return component;
    if (component.latency_ms >= threshold && (component.status === 'ok' ||
        (component.status === 'degraded' && isLatencyReason(component.reason)))) {
      return { ...component, status: 'degraded' as const,
        reason: `Database 応答が監視閾値 ${threshold}ms を超過 (${component.latency_ms}ms)` };
    }
    if (component.latency_ms < threshold && component.status === 'degraded' && isLatencyReason(component.reason)) {
      return { ...component, status: 'ok' as const, reason: null };
    }
    return component;
  });
  let status = normaliseHealthzStatus(payload.status);
  let reason = typeof payload.reason === 'string' && payload.reason.trim() ? payload.reason.trim().slice(0, 500) : null;
  const unhealthy = components.filter(component => component.status !== 'ok');
  const originalUnhealthy = original.filter(component => component.status !== 'ok');
  // Comparing HTTP RTT with a DB threshold previously hid unrelated component failures.
  // Only actual DB component latency can resolve a matching latency-only degradation.
  if (status === 'degraded' && originalUnhealthy.length > 0 && unhealthy.length === 0
    && originalUnhealthy.every(component => isDatabase(component) && isLatencyReason(component.reason))
    && (!reason || isLatencyReason(reason))) {
    status = 'ok'; reason = null;
  }
  if (unhealthy.some(component => component.status === 'down')) status = 'down';
  else if (status === 'ok' && unhealthy.length > 0) status = 'degraded';
  if (unhealthy.length > 0 && unhealthy.every(component => isDatabase(component) && component.status === 'degraded') &&
      (!reason || isLatencyReason(reason)) &&
      originalUnhealthy.every(component => isDatabase(component) && isLatencyReason(component.reason))) {
    reason = unhealthy[0].reason ?? reason;
  }
  if (!reason && unhealthy.length > 0) reason = unhealthy[0].reason ?? `${unhealthy[0].name} が不調です`;
  return {
    status: status === 'down' ? 'down' : 'up', status_code: p.statusCode, latency_ms: p.latencyMs,
    error: status === 'down' ? reason ?? 'healthz reported down' : null,
    healthz_status: status, healthz_reason: reason,
    healthz_components: components.length ? JSON.stringify(components) : null,
    healthz_version: typeof payload.version === 'string' ? payload.version.slice(0, 64) : null,
    used_fallback: false, maintenance: parseMaintenance(payload.maintenance ?? null),
  };
}

function applyHttpThreshold(result: UntracedResult, monitor: Monitor): UntracedResult {
  const threshold = positiveThreshold(monitor.http_latency_threshold_ms);
  if (!threshold || result.status === 'down' || result.latency_ms === null || result.latency_ms < threshold) return result;
  const reason = `HTTP応答が監視閾値 ${threshold}ms を超過 (${result.latency_ms}ms)`;
  const components: ComponentHealth[] = result.healthz_components ? JSON.parse(result.healthz_components) : [];
  components.push({ name: 'HTTP response', status: 'degraded', latency_ms: result.latency_ms, reason });
  return { ...result, healthz_status: 'degraded', healthz_reason: result.healthz_reason ?? reason,
    healthz_components: JSON.stringify(components) };
}

function positiveThreshold(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;
}
function isDatabase(component: ComponentHealth): boolean { return /^(?:database|db|d1)$/i.test(component.name.trim()); }
function isLatencyReason(value: unknown): boolean {
  // Match the app's complete latency-only message, not mixed failures such as
  // "latency high; replication failed" which must remain degraded.
  return typeof value === 'string' && /^応答が \d+(?:\.\d+)?ms を超過 \(\d+(?:\.\d+)?ms\)$/.test(value);
}

function resultFromLegacy(monitor: Monitor, p: ProbeOutcome): UntracedResult {
  const expected = monitor.expected_status ?? 200;
  const error = p.statusCode !== expected ? `Expected status ${expected}, got ${p.statusCode}`
    : monitor.keyword && !p.bodySample?.includes(monitor.keyword) ? 'Expected keyword not found in bounded response sample' : null;
  return { status: error ? 'down' : 'up', status_code: p.statusCode, latency_ms: p.latencyMs, error,
    healthz_status: null, healthz_reason: null, healthz_components: null, healthz_version: null,
    used_fallback: false, maintenance: null };
}

function downResult(primary: ProbeOutcome, fallback: ProbeOutcome | null, usedFallback: boolean, reason: string): UntracedResult {
  const errors = [primary.error, fallback?.error].filter(Boolean).join(' / ');
  return { status: 'down', status_code: fallback?.statusCode ?? primary.statusCode,
    latency_ms: fallback?.latencyMs ?? primary.latencyMs, error: errors || reason, healthz_status: 'down',
    healthz_reason: reason.slice(0, 500), healthz_components: null, healthz_version: null,
    used_fallback: usedFallback, maintenance: null };
}
function normaliseHealthzStatus(value: unknown): HealthzStatus {
  return value === 'degraded' || value === 'down' ? value : 'ok';
}
function sanitiseComponents(input: unknown): ComponentHealth[] {
  if (!Array.isArray(input)) return [];
  const out: ComponentHealth[] = [];
  for (const raw of input) {
    if (!raw || typeof raw !== 'object') continue;
    const value = raw as Record<string, unknown>;
    if (typeof value.name !== 'string' || !value.name.trim()) continue;
    out.push({ name: value.name.slice(0, 200), status: normaliseHealthzStatus(value.status),
      latency_ms: typeof value.latency_ms === 'number' && Number.isFinite(value.latency_ms) && value.latency_ms >= 0
        ? Math.min(Number.MAX_SAFE_INTEGER, Math.floor(value.latency_ms)) : undefined,
      reason: typeof value.reason === 'string' ? value.reason.trim().slice(0, 500) || null : null });
    if (out.length === 20) break;
  }
  return out;
}
function parseMaintenance(input: HealthzPayload['maintenance']): MaintenanceWindow | null {
  if (!input || typeof input !== 'object' || typeof input.from !== 'string' || typeof input.to !== 'string' || typeof input.reason !== 'string') return null;
  const from = Date.parse(input.from), to = Date.parse(input.to);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from || !input.reason.trim()) return null;
  return { from: input.from.slice(0, 64), to: input.to.slice(0, 64), reason: input.reason.trim().slice(0, 500), from_ms: from, to_ms: to };
}
function errorMessage(err: unknown): string { return (err instanceof Error ? err.message : 'Probe failed').slice(0, 500); }

export async function cleanupOldChecks(env: Env): Promise<void> {
  const days = Number.parseInt(env.RETENTION_DAYS ?? '7', 10) || 7;
  const now = Date.now();
  const cutoff = now - days * 24 * 60 * 60 * 1000;
  // Roll any completed days into daily_summary before pruning the raw
  // rows that fed them. INSERT OR IGNORE so days already summarised
  // (by a previous cron tick or by the migration's seed insert) are
  // left alone — only newly-completed days get added. Computed first
  // so a prune that races a summary insert can't leave a hole.
  //
  // down_streak requires neighboring scheduled slots of the same revision.
  // Missing observations, maintenance/up rows and configuration changes break
  // an island. Historical checks have no slot, so use their minute-rounded ts
  // rather than interpreting separated old rows as consecutive observations.
  const todayMidnight = Math.floor(now / 86_400_000) * 86_400_000;
  await env.DB.prepare(
    `INSERT OR IGNORE INTO daily_summary (monitor_id, day_ms, ups, downs, maints, down_streak)
     WITH days AS (
       SELECT id, monitor_id,
              (ts / 86400000) * 86400000 AS day_ms,
              status,
              in_maintenance,
              CASE WHEN status = 'down' AND in_maintenance = 0 THEN 1 ELSE 0 END AS is_down,
              COALESCE(scheduled_slot, (ts / 60000) * 60000) AS slot_ms,
              COALESCE(config_revision, 1) AS revision,
              MAX(1, COALESCE((SELECT interval_minutes FROM monitors WHERE id = checks.monitor_id), 1)) * 60000 AS interval_ms,
              ts
         FROM checks
        WHERE ts < ?
     ),
     ordered AS (
       SELECT *,
              LAG(is_down) OVER observation_order AS previous_down,
              LAG(slot_ms) OVER observation_order AS previous_slot,
              LAG(revision) OVER observation_order AS previous_revision
         FROM days
       WINDOW observation_order AS (PARTITION BY monitor_id, day_ms ORDER BY ts, id)
     ),
     islands AS (
       SELECT monitor_id, day_ms, is_down,
              SUM(CASE WHEN is_down = 1 AND previous_down = 1 AND revision = previous_revision
                            AND slot_ms - previous_slot = interval_ms THEN 0 ELSE 1 END)
                OVER (PARTITION BY monitor_id, day_ms ORDER BY ts, id) AS island_id
         FROM ordered
     ),
     streaks AS (
       SELECT monitor_id, day_ms, MAX(run_len) AS down_streak
         FROM (
           SELECT monitor_id, day_ms, island_id, COUNT(*) AS run_len
             FROM islands
            WHERE is_down = 1
            GROUP BY monitor_id, day_ms, island_id
         )
        GROUP BY monitor_id, day_ms
     )
     SELECT d.monitor_id,
            d.day_ms,
            SUM(CASE WHEN d.status = 'up' AND d.in_maintenance = 0 THEN 1 ELSE 0 END),
            SUM(CASE WHEN d.status = 'down' AND d.in_maintenance = 0 THEN 1 ELSE 0 END),
            SUM(CASE WHEN d.in_maintenance = 1 THEN 1 ELSE 0 END),
            COALESCE(s.down_streak, 0)
       FROM days d
       LEFT JOIN streaks s ON s.monitor_id = d.monitor_id AND s.day_ms = d.day_ms
      GROUP BY d.monitor_id, d.day_ms`,
  )
    .bind(todayMidnight)
    .run();
  // The cutover day has a mixed daily_summary (old binding + public HTTPS).
  // Public charts read that day's post-cutover raw slice instead. Retain only
  // that bounded slice until its UTC day leaves the 30-day chart window; the
  // rest of the raw history still follows RETENTION_DAYS.
  await env.DB.prepare(
    `DELETE FROM checks WHERE ts < ? AND NOT EXISTS (
       SELECT 1 FROM monitors m
        WHERE m.id = checks.monitor_id AND m.monitor_role = 'availability'
          AND m.availability_since_ms > 0 AND m.availability_since_ms % 86400000 <> 0
          AND m.availability_since_ms >= ?
          AND checks.ts >= m.availability_since_ms
          AND checks.ts < ((m.availability_since_ms + 86399999) / 86400000) * 86400000
          AND checks.monitor_role = 'availability' AND checks.probe_transport = 'public_fetch'
     )`,
  ).bind(cutoff, todayMidnight - 29 * 86_400_000).run();
  // Execution decisions retain missing/deleted monitor IDs for diagnosis. Delivery
  // work is never pruned while pending; ambiguous sends keep a longer audit trail.
  await env.DB.batch([
    env.DB.prepare('DELETE FROM monitor_runs WHERE received_at < ?').bind(cutoff),
    env.DB.prepare('DELETE FROM monitor_attempts WHERE observed_at < ?').bind(cutoff),
    env.DB.prepare(`DELETE FROM notification_outbox WHERE status IN ('sent', 'cancelled', 'failed')
      AND completed_at IS NOT NULL AND completed_at < ?`).bind(cutoff),
    env.DB.prepare(`DELETE FROM notification_outbox WHERE status = 'uncertain'
      AND completed_at IS NOT NULL AND completed_at < ?`).bind(now - Math.max(30, days) * 86_400_000),
    // Run deletion cascades to its observations; never delete delivery thread state.
    env.DB.prepare('DELETE FROM external_probe_runs WHERE recorded_at < ?').bind(cutoff),
  ]);
}
