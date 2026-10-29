import type { Env, Monitor } from './types';
import * as targetsConfig from '../external-targets.json';
import { verifyGithubOidc, GithubOidcError, type GithubOidcConfig, type GithubOidcClaims } from './github-oidc';

const BODY_LIMIT = 8192;
const OBSERVATION_MAX_AGE = 600_000;
const WITNESS_MAX_AGE = 900_000;
const CLOUDFLARE_WITNESS_MAX_AGE = 150_000;
const CLOUDFLARE_WITNESS_ORIGIN = 'https://helth-witness.opus-system.workers.dev';
export const CLOUDFLARE_WITNESS_STATUS_URL = `${CLOUDFLARE_WITNESS_ORIGIN}/status`;
const FUTURE_TOLERANCE = 30_000;
const ERRORS = new Set(['timeout_headers', 'timeout_body', 'http_error', 'invalid_health', 'cached_response', 'network_error']);
const HEADERS = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };

interface ExternalConfigEnv {
  EXTERNAL_PROBE_AUDIENCE?: string;
  EXTERNAL_PROBE_REPOSITORY?: string;
  EXTERNAL_PROBE_REPOSITORY_ID?: string;
  EXTERNAL_PROBE_OWNER_ID?: string;
  EXTERNAL_PROBE_WORKFLOW_REF?: string;
}
interface ServiceObservation {
  monitor_id: number;
  url: string;
  observed_at: number;
  finished_at: number;
  total_ms: number;
  http_status: number | null;
  status: 'ok' | 'degraded' | 'down';
  database_ms: number | null;
  db_threshold_ms: number;
  error: string | null;
  request_id: string;
}
interface ReadinessObservation {
  observed_at: number;
  finished_at: number;
  total_ms: number;
  http_status: number | null;
  status: 'fresh' | 'unknown';
  error: string | null;
}
interface ExternalReport {
  version: 1;
  run_id: string;
  run_attempt: string;
  commit_sha: string;
  observations: ServiceObservation[];
  readiness: ReadinessObservation;
}
export interface ExternalWitness {
  source: 'github_actions' | 'cloudflare_alarm';
  status: 'ok' | 'degraded' | 'down' | 'unknown';
  observedAt: number | null;
  totalMs: number | null;
  ageMs: number | null;
  runId: string | null;
  runAttempt: string | null;
  runUrl: string | null;
  statusUrl: string | null;
  /** This supplement's validated policy, independent of the primary monitor. */
  dbThresholdMs?: number | null;
}
type HandlerOptions = { now?: number; verifyToken?: typeof verifyGithubOidc; bodyTimeoutMs?: number };

/** This endpoint authenticates a particular workflow, never the general management token. */
export async function handleExternalObservation(req: Request, env: Env, options: HandlerOptions = {}): Promise<Response> {
  if (req.method !== 'POST') return response(405, 'method_not_allowed');
  if (!/^application\/json(?:\s*;|\s*$)/i.test(req.headers.get('content-type') ?? '')) return response(415, 'json_required');
  const config = configuration(env);
  if (!config) return response(503, 'external_witness_not_configured');
  const authorization = req.headers.get('authorization') ?? '';
  if (authorization.length > 16_400 || !/^Bearer [A-Za-z0-9_.-]+$/.test(authorization)) return response(401, 'unauthorized');
  const now = options.now ?? Date.now();
  let claims: GithubOidcClaims;
  try { claims = await (options.verifyToken ?? verifyGithubOidc)(authorization.slice(7), config, { now }); }
  catch (error) {
    const unavailable = error instanceof GithubOidcError && 'retryable' in error && error.retryable === true;
    return response(unavailable ? 503 : 401, unavailable ? 'identity_verification_unavailable' : 'unauthorized');
  }
  let report: ExternalReport;
  try { report = validateReport(JSON.parse(await boundedBody(req, Math.min(5000, Math.max(1, options.bodyTimeoutMs ?? 5000)))), claims, now); }
  catch { return response(400, 'invalid_observation'); }
  try {
    const targets = await env.DB.prepare('SELECT * FROM monitors WHERE id IN (?, ?)')
      .bind(...targetsConfig.targets.map(target => target.monitor_id)).all<Monitor>();
    const monitors = new Map((targets.results ?? []).map(monitor => [monitor.id, monitor]));
    for (const observation of report.observations) {
      const monitor = monitors.get(observation.monitor_id);
      // The signed external report uses its fixed policy; changing the primary ceiling must not reject it.
      // Preserve target identity and fence the captured primary settings again in the atomic write.
      if (!monitor || monitor.enabled !== 1 || monitor.monitor_role !== 'availability' || monitor.url !== observation.url)
        return response(409, 'target_configuration_changed');
    }
    const canonical = {
      ...report,
      observations: report.observations.map(observation => ({ ...observation,
        monitor_config_revision: monitors.get(observation.monitor_id)!.config_revision ?? 1 })),
    };
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(canonical)));
    const hash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
    const targetGuards = canonical.observations.flatMap(observation => [observation.monitor_id,
      observation.monitor_config_revision, observation.url, monitors.get(observation.monitor_id)!.db_latency_threshold_ms]);
    const statements = [env.DB.prepare(
      `INSERT OR IGNORE INTO external_probe_runs
       (run_id,run_attempt,payload_hash,commit_sha,recorded_at,observed_at,readiness_status,readiness_http_status,readiness_total_ms)
       SELECT ?,?,?,?,CAST(strftime('%s','now') AS INTEGER)*1000,?,?,?,?
        WHERE (SELECT COUNT(*) FROM monitors m WHERE m.enabled=1 AND m.monitor_role='availability' AND (
          (m.id=? AND m.config_revision=? AND m.url=? AND m.db_latency_threshold_ms IS ?) OR
          (m.id=? AND m.config_revision=? AND m.url=? AND m.db_latency_threshold_ms IS ?)))=2`,
    ).bind(report.run_id, report.run_attempt, hash, report.commit_sha, report.readiness.observed_at,
      report.readiness.status, report.readiness.http_status, report.readiness.total_ms, ...targetGuards)];
    for (const observation of canonical.observations) statements.push(env.DB.prepare(
      `INSERT OR IGNORE INTO external_observations
       (run_id,run_attempt,monitor_id,monitor_config_revision,observed_at,finished_at,total_ms,status,http_status,
        database_ms,db_threshold_ms,error,request_id)
       SELECT ?,?,?,?,?,?,?,?,?,?,?,?,? FROM monitors m
       WHERE m.id=? AND m.config_revision=? AND m.enabled=1 AND m.monitor_role='availability'
         AND m.url=? AND m.db_latency_threshold_ms IS ?
         AND EXISTS(SELECT 1 FROM external_probe_runs WHERE run_id=? AND run_attempt=? AND payload_hash=?)`,
    ).bind(report.run_id, report.run_attempt, observation.monitor_id, observation.monitor_config_revision,
      observation.observed_at, observation.finished_at, observation.total_ms, observation.status, observation.http_status,
      observation.database_ms, observation.db_threshold_ms, observation.error, observation.request_id,
      observation.monitor_id, observation.monitor_config_revision, observation.url, monitors.get(observation.monitor_id)!.db_latency_threshold_ms,
      report.run_id, report.run_attempt, hash));
    const writes = await env.DB.batch(statements);
    const stored = await env.DB.prepare('SELECT payload_hash FROM external_probe_runs WHERE run_id=? AND run_attempt=?')
      .bind(report.run_id, report.run_attempt).first<{ payload_hash: string }>();
    if (!stored) return response(409, 'target_configuration_changed');
    if (stored.payload_hash !== hash) return response(409, 'observation_replay_conflict');
    const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM external_observations WHERE run_id=? AND run_attempt=?')
      .bind(report.run_id, report.run_attempt).first<{ n: number }>();
    if (count?.n !== targetsConfig.targets.length) return response(409, 'target_configuration_changed');
    return new Response(JSON.stringify({ accepted: true, duplicate: writes[0].meta.changes === 0 }), { status: 200, headers: HEADERS });
  } catch {
    console.warn({ event: 'external_observation_storage_unavailable' });
    return response(503, 'observation_storage_unavailable');
  }
}

/** Supplemental evidence only; freshness never changes the primary monitor state. */
export async function readExternalWitnesses(env: Env, now = Date.now()): Promise<Map<number, ExternalWitness>> {
  const out = new Map<number, ExternalWitness>();
  const config = configuration(env);
  if (!config) return out;
  const rows = await env.DB.prepare(
    `SELECT m.id,m.url,o.status,o.observed_at,o.finished_at,o.total_ms,o.run_id,o.run_attempt,o.db_threshold_ms
       FROM monitors m LEFT JOIN external_observations o ON (o.run_id,o.run_attempt,o.monitor_id)=
        (SELECT run_id,run_attempt,monitor_id FROM external_observations
          WHERE monitor_id=m.id AND monitor_config_revision=m.config_revision
          ORDER BY finished_at DESC,run_id DESC LIMIT 1)
       WHERE m.enabled=1 AND m.monitor_role='availability' AND m.id IN (?,?)`,
  ).bind(...targetsConfig.targets.map(target => target.monitor_id)).all<{
    id: number; url: string; db_threshold_ms: number | null;
    status: 'ok' | 'degraded' | 'down' | null; observed_at: number | null; finished_at: number | null;
    total_ms: number | null; run_id: string | null; run_attempt: string | null;
  }>();
  for (const row of rows.results ?? []) {
    const target = targetsConfig.targets.find(target => target.monitor_id === row.id);
    const policyMatches = target !== undefined && row.url === target.url && row.db_threshold_ms === target.db_threshold_ms;
    const age = row.finished_at == null ? null : now - row.finished_at;
    const fresh = policyMatches && age !== null && age >= -FUTURE_TOLERANCE && age < WITNESS_MAX_AGE;
    const validRun = row.run_id !== null && /^[1-9]\d{0,19}$/.test(row.run_id) && row.run_attempt !== null && /^[1-9]\d{0,5}$/.test(row.run_attempt);
    out.set(row.id, { source: 'github_actions', status: fresh && row.status ? row.status : 'unknown', observedAt: row.observed_at,
      totalMs: fresh ? row.total_ms : null, ageMs: age === null ? null : Math.max(0, age),
      runId: row.run_id, runAttempt: row.run_attempt,
      runUrl: validRun ? `https://github.com/${config.repository}/actions/runs/${row.run_id}/attempts/${row.run_attempt}` : null,
      statusUrl: null, dbThresholdMs: policyMatches ? target!.db_threshold_ms : null });
  }
  return out;
}

/** Display-only source selection. Failure never substitutes a different provider. */
export async function getExternalSummaries(env: Env, now = Date.now(), options: {
  fetcher?: typeof fetch; timeoutMs?: number;
} = {}): Promise<Map<number, ExternalWitness>> {
  if (env.CLOUDFLARE_WITNESS_URL === undefined) return readExternalWitnesses(env, now);
  const out = new Map<number, ExternalWitness>(targetsConfig.targets.map(target => [target.monitor_id, {
    source: 'cloudflare_alarm', status: 'unknown', observedAt: null, totalMs: null, ageMs: null,
    runId: null, runAttempt: null, runUrl: null, statusUrl: CLOUDFLARE_WITNESS_STATUS_URL,
    dbThresholdMs: target.db_threshold_ms,
  }]));
  // Compare the entire configured value before fetching: no userinfo, alternate
  // ports, paths, queries, fragments, redirects, or arbitrary destinations.
  if (env.CLOUDFLARE_WITNESS_URL !== CLOUDFLARE_WITNESS_ORIGIN &&
      env.CLOUDFLARE_WITNESS_URL !== `${CLOUDFLARE_WITNESS_ORIGIN}/`) return out;
  // With the current compatibility flags, same-zone workers.dev calls need a binding. This fetch only
  // reads the fixed public snapshot; it never starts probes or sends controls.
  const fetcher = options.fetcher ?? env.CLOUDFLARE_WITNESS?.fetch.bind(env.CLOUDFLARE_WITNESS);
  if (!fetcher) return out;
  const deadline = performance.now() + Math.min(2000, Math.max(1, options.timeoutMs ?? 2000));
  const requireDeadline = () => { if (performance.now() >= deadline) throw new Error('witness'); };
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let responseBody: ReadableStream<Uint8Array> | null = null;
  const operation = async () => {
    requireDeadline();
    const monitorsPromise = env.DB.prepare(
      'SELECT id,url,enabled,monitor_role FROM monitors WHERE id IN (?,?)',
    ).bind(...targetsConfig.targets.map(target => target.monitor_id)).all<Monitor>().catch(() => ({ results: [] as Monitor[] }));
    const res = await fetcher(`${CLOUDFLARE_WITNESS_ORIGIN}/latest`, {
      method: 'GET', redirect: 'manual', cache: 'no-store', signal: controller.signal,
      headers: { Accept: 'application/json', 'Cache-Control': 'no-store' },
    });
    responseBody = res.body;
    if (controller.signal.aborted || performance.now() >= deadline) {
      void res.body?.cancel().catch(() => undefined);
      throw new Error('witness');
    }
    // Workers supports manual redirect mode. Reject 3xx without following it.
    if (controller.signal.aborted || res.status !== 200 || !res.body ||
        !/^application\/json(?:\s*;|\s*$)/i.test(res.headers.get('content-type') ?? '') ||
        !/(?:^|,)\s*no-store\s*(?:,|$)/i.test(res.headers.get('cache-control') ?? '') ||
        ['HIT', 'STALE', 'UPDATING', 'REVALIDATED'].includes((res.headers.get('cf-cache-status') ?? '').trim().toUpperCase()) ||
        Number(res.headers.get('content-length') ?? 0) > BODY_LIMIT ||
        Number(res.headers.get('age') ?? 0) > 0) {
      void res.body?.cancel().catch(() => undefined);
      throw new Error('witness');
    }
    reader = res.body.getReader();
    let text = ''; let bytes = 0;
    const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });
    try {
      for (;;) {
        const part = await reader.read();
        requireDeadline();
        if (controller.signal.aborted) throw new Error('witness');
        if (part.done) { text += decoder.decode(); break; }
        bytes += part.value.byteLength;
        if (bytes > BODY_LIMIT) throw new Error('witness');
        text += decoder.decode(part.value, { stream: true });
      }
    } finally { reader.releaseLock(); }
    const payload = JSON.parse(text) as unknown;
    const monitors = (await monitorsPromise).results ?? [];
    requireDeadline();
    return { payload, monitors };
  };
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new Error('witness')); },
        Math.max(0, deadline - performance.now()));
    });
    const { payload, monitors } = await Promise.race([operation(), timeout]);
    requireDeadline();
    if (!record(payload) || payload.version !== 1 || payload.source !== 'cloudflare_alarm' ||
        payload.enabled !== true || !record(payload.readiness) || payload.readiness.status !== 'fresh' ||
        !cloudflareInterval(payload, now) || !Array.isArray(payload.results) || payload.results.length !== 2) return out;
    const seen = new Set<number>();
    const summaries: [number, ExternalWitness][] = [];
    for (const input of payload.results) {
      if (!record(input)) return out;
      const target = targetsConfig.targets.find(target => target.monitor_id === input.monitor_id);
      if (!target || seen.has(target.monitor_id)) return out;
      seen.add(target.monitor_id);
      const monitor = monitors.find(monitor => monitor.id === target.monitor_id);
      if (!monitor || monitor.enabled !== 1 || monitor.monitor_role !== 'availability' ||
          monitor.url !== target.url || input.url !== monitor.url ||
          input.db_threshold_ms !== target.db_threshold_ms ||
          !cloudflareInterval(input, now) || !finite(input.total_ms, 0, 30_000) || !statusCode(input.http_status) ||
          (input.observed_at as number) < (payload.observed_at as number) || (input.finished_at as number) > (payload.finished_at as number) ||
          typeof input.status !== 'string' || !['ok', 'degraded', 'down'].includes(input.status) ||
          !durationOrNull(input.database_ms) ||
          (input.status !== 'down' && (input.http_status !== 200 || input.failure !== null || input.database_ms === null)) ||
          (input.status === 'ok' && (input.database_ms as number) >= target.db_threshold_ms)) continue;
      summaries.push([target.monitor_id, { source: 'cloudflare_alarm', status: input.status as ExternalWitness['status'],
        observedAt: input.observed_at as number, totalMs: input.total_ms, ageMs: Math.max(0, now - (input.observed_at as number)),
        runId: null, runAttempt: null, runUrl: null, statusUrl: CLOUDFLARE_WITNESS_STATUS_URL,
        dbThresholdMs: target.db_threshold_ms }]);
    }
    requireDeadline();
    for (const [id, summary] of summaries) out.set(id, summary);
  } catch { /* A supplemental failure is unknown and never changes primary state. */ }
  finally {
    if (timer !== undefined) clearTimeout(timer);
    controller.abort();
    // A stalled peer must not extend the response while acknowledging cancel.
    void reader?.cancel().catch(() => undefined);
    const body = responseBody as ReadableStream<Uint8Array> | null;
    if (body && !body.locked) void body.cancel().catch(() => undefined);
  }
  return out;
}

function cloudflareInterval(value: Record<string, unknown>, now: number): boolean {
  return Number.isSafeInteger(value.observed_at) && Number.isSafeInteger(value.finished_at) &&
    finite(value.observed_at, Math.max(0, now - CLOUDFLARE_WITNESS_MAX_AGE + 1), now + FUTURE_TOLERANCE) &&
    finite(value.finished_at, value.observed_at, now + FUTURE_TOLERANCE);
}

function configuration(env: Env): GithubOidcConfig | null {
  const value = env as Env & ExternalConfigEnv;
  const { EXTERNAL_PROBE_AUDIENCE: audience, EXTERNAL_PROBE_REPOSITORY: repository,
    EXTERNAL_PROBE_REPOSITORY_ID: repositoryId, EXTERNAL_PROBE_OWNER_ID: ownerId,
    EXTERNAL_PROBE_WORKFLOW_REF: workflowRef } = value;
  if (!audience || !repository || !repositoryId || !ownerId || !workflowRef ||
      repository !== targetsConfig.repository || !/^[1-9]\d{0,19}$/.test(repositoryId) || !/^[1-9]\d{0,19}$/.test(ownerId)) return null;
  try {
    const url = new URL(audience);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash ||
        url.pathname !== '/api/external-observations' || audience !== targetsConfig.receiver) return null;
  } catch { return null; }
  return { audience, repository, repositoryId, ownerId, workflowRef };
}

function validateReport(value: unknown, claims: GithubOidcClaims, now: number): ExternalReport {
  if (!record(value) || !keys(value, ['version', 'run_id', 'run_attempt', 'commit_sha', 'observations', 'readiness']) ||
      value.version !== 1 || value.run_id !== claims.run_id || value.run_attempt !== claims.run_attempt ||
      typeof value.commit_sha !== 'string' || !/^[a-f0-9]{40}$/.test(value.commit_sha) || value.commit_sha !== claims.sha ||
      !Array.isArray(value.observations) || value.observations.length !== targetsConfig.targets.length) throw new Error('report');
  const seen = new Set<number>();
  const observations = value.observations.map(input => {
    if (!record(input) || !keys(input, ['monitor_id', 'url', 'observed_at', 'finished_at', 'total_ms', 'http_status', 'status',
      'database_ms', 'db_threshold_ms', 'error', 'request_id'])) throw new Error('observation');
    const target = targetsConfig.targets.find(item => item.monitor_id === input.monitor_id);
    if (!target || seen.has(target.monitor_id) || input.url !== target.url || input.db_threshold_ms !== target.db_threshold_ms ||
        !interval(input, now) || !statusCode(input.http_status) || typeof input.status !== 'string' ||
        !['ok', 'degraded', 'down'].includes(input.status) || !durationOrNull(input.database_ms) ||
        !(input.error === null || (typeof input.error === 'string' && ERRORS.has(input.error))) ||
        typeof input.request_id !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(input.request_id)) throw new Error('observation');
    if ((input.status !== 'down' && (input.http_status !== 200 || input.error !== null || input.database_ms === null)) ||
        (input.status === 'ok' && (input.database_ms as number) >= target.db_threshold_ms)) throw new Error('contradiction');
    seen.add(target.monitor_id);
    return { monitor_id: target.monitor_id, url: target.url, observed_at: input.observed_at, finished_at: input.finished_at,
      total_ms: input.total_ms, http_status: input.http_status, status: input.status, database_ms: input.database_ms,
      db_threshold_ms: target.db_threshold_ms, error: input.error, request_id: input.request_id } as ServiceObservation;
  }).sort((a, b) => a.monitor_id - b.monitor_id);
  const input = value.readiness;
  if (!record(input) || !keys(input, ['observed_at', 'finished_at', 'total_ms', 'http_status', 'status', 'error']) ||
      !interval(input, now) || !statusCode(input.http_status) || !['fresh', 'unknown'].includes(String(input.status)) ||
      typeof input.status !== 'string' || !(input.error === null || (typeof input.error === 'string' && ERRORS.has(input.error))) ||
      (input.status === 'fresh' && (input.http_status !== 200 || input.error !== null))) throw new Error('readiness');
  const readiness = { observed_at: input.observed_at, finished_at: input.finished_at, total_ms: input.total_ms,
    http_status: input.http_status, status: input.status, error: input.error } as ReadinessObservation;
  return { version: 1, run_id: value.run_id as string, run_attempt: value.run_attempt as string,
    commit_sha: value.commit_sha, observations, readiness };
}

function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function keys(value: Record<string, unknown>, expected: string[]): boolean {
  const names = Object.keys(value);
  return names.length === expected.length && names.every(name => expected.includes(name));
}
function durationOrNull(value: unknown): boolean { return value === null || finite(value, 0, 30_000); }
function finite(value: unknown, min: number, max: number): value is number { return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max; }
function statusCode(value: unknown): boolean { return value === null || (Number.isSafeInteger(value) && finite(value, 100, 599)); }
function interval(value: Record<string, unknown>, now: number): boolean {
  return Number.isSafeInteger(value.observed_at) && finite(value.observed_at, now - OBSERVATION_MAX_AGE, now + FUTURE_TOLERANCE) &&
    Number.isSafeInteger(value.finished_at) && finite(value.finished_at, value.observed_at, now + FUTURE_TOLERANCE) &&
    finite(value.total_ms, 0, 30_000) && (value.finished_at as number) - value.observed_at <= 30_000;
}
async function boundedBody(req: Request, timeoutMs: number): Promise<string> {
  if (!req.body) throw new Error('body');
  const reader = req.body.getReader();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const read = (async () => {
    let text = ''; let count = 0; const decoder = new TextDecoder();
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) return text + decoder.decode();
        count += chunk.value.byteLength;
        if (count > BODY_LIMIT) throw new Error('body');
        text += decoder.decode(chunk.value, { stream: true });
      }
    } finally { reader.releaseLock(); }
  })();
  try {
    return await Promise.race([read, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('body')), timeoutMs); })]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    void reader.cancel().catch(() => undefined);
    if (!req.body.locked) void req.body.cancel().catch(() => undefined);
  }
}
function response(status: number, error: string): Response { return new Response(JSON.stringify({ error }), { status, headers: HEADERS }); }
