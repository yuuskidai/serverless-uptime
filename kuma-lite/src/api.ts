import type { Env, Monitor, MonitorRole, ProbeTransport, ResponseMode } from './types';

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8' };

export async function handleApiRequest(req: Request, env: Env): Promise<Response> {
  if (!authorize(req, env)) {
    return jsonError(401, 'unauthorized');
  }

  const url = new URL(req.url);
  const segments = url.pathname.replace(/^\/+|\/+$/g, '').split('/');
  // segments[0] === 'api'
  const resource = segments[1];
  const id = segments[2];

  if (resource !== 'monitors') {
    return jsonError(404, 'not found');
  }

  try {
    if (!id) {
      if (req.method === 'GET') return await listMonitors(env);
      if (req.method === 'POST') return await createMonitor(req, env);
      return jsonError(405, 'method not allowed');
    }

    const monitorId = /^\d+$/.test(id) ? Number(id) : NaN;
    if (!Number.isSafeInteger(monitorId) || monitorId < 1) return jsonError(400, 'invalid id');

    if (req.method === 'GET') return await getMonitor(env, monitorId);
    if (req.method === 'PATCH') return await updateMonitor(req, env, monitorId);
    if (req.method === 'DELETE') return await deleteMonitor(env, monitorId);
    return jsonError(405, 'method not allowed');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return jsonError(500, msg);
  }
}

function authorize(req: Request, env: Env): boolean {
  if (!env.API_TOKEN) return false;
  const header = req.headers.get('Authorization') ?? '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) return false;
  const provided = match[1].trim();
  return safeEqual(provided, env.API_TOKEN);
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

async function listMonitors(env: Env): Promise<Response> {
  const result = await env.DB.prepare(
    `SELECT * FROM monitors ORDER BY id ASC`,
  ).all<Monitor>();
  return json(200, { monitors: result.results ?? [] });
}

async function getMonitor(env: Env, id: number): Promise<Response> {
  const row = await env.DB.prepare(`SELECT * FROM monitors WHERE id = ?`).bind(id).first<Monitor>();
  if (!row) return jsonError(404, 'monitor not found');
  return json(200, { monitor: row });
}

interface CreateBody {
  name?: unknown;
  url?: unknown;
  description?: unknown;
  fallback_url?: unknown;
  service_binding?: unknown;
  method?: unknown;
  expected_status?: unknown;
  keyword?: unknown;
  timeout_ms?: unknown;
  interval_minutes?: unknown;
  retry_threshold?: unknown;
  enabled?: unknown;
  latency_threshold_ms?: unknown;
  db_latency_threshold_ms?: unknown;
  http_latency_threshold_ms?: unknown;
  probe_transport?: unknown;
  monitor_role?: unknown;
  parent_monitor_id?: unknown;
  response_mode?: unknown;
  config_revision?: unknown;
  availability_since_ms?: unknown;
}

const DESCRIPTION_MAX_LENGTH = 500;

function asDescription(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const trimmed = v.trim();
  if (trimmed.length === 0) return null;
  return trimmed.length > DESCRIPTION_MAX_LENGTH
    ? trimmed.slice(0, DESCRIPTION_MAX_LENGTH)
    : trimmed;
}

async function createMonitor(req: Request, env: Env): Promise<Response> {
  const body = (await readJson(req)) as CreateBody | null;
  if (!body) return jsonError(400, 'invalid JSON body');

  const name = asString(body.name);
  const url = asString(body.url);
  if (!name || !url) return jsonError(400, 'name and url are required');
  if (!isHttpUrl(url)) return jsonError(400, 'url must be http(s)');

  const description = asDescription(body.description);
  const fallbackRaw = asString(body.fallback_url);
  if (fallbackRaw && !isHttpUrl(fallbackRaw)) {
    return jsonError(400, 'fallback_url must be http(s)');
  }
  const fallbackUrl = fallbackRaw;
  const bindingRaw = asString(body.service_binding);
  if (bindingRaw && !isValidBindingName(bindingRaw)) {
    return jsonError(400, 'service_binding must be uppercase ASCII letters, digits, or underscore');
  }
  const serviceBinding = bindingRaw;
  const method = (asString(body.method) ?? 'GET').toUpperCase();
  const expected = asInt(body.expected_status, 200);
  const keyword = asString(body.keyword);
  const timeout = clamp(asInt(body.timeout_ms, 10_000), 1_000, 30_000);
  const interval = clamp(asInt(body.interval_minutes, 1), 1, 60);
  const retry = clamp(asInt(body.retry_threshold, 2), 1, 10);
  const enabled = asBoolInt(body.enabled, 1);
  const thresholds = readLatencyThresholds(body);
  if ('error' in thresholds) return jsonError(400, thresholds.error);

  const route = readRoute(body);
  if ('error' in route) return jsonError(400, route.error);
  const routeError = validateRoute(route, url, method, serviceBinding);
  if (routeError) return jsonError(400, routeError);
  if (!(await validParent(env, route.parent_monitor_id))) return jsonError(400, 'parent must be an availability monitor');

  const now = Date.now();
  const result = await env.DB.prepare(
    `INSERT INTO monitors (name, url, description, fallback_url, service_binding, method, expected_status, keyword, timeout_ms, interval_minutes, enabled, retry_threshold, latency_threshold_ms, db_latency_threshold_ms, http_latency_threshold_ms, created_at,
       probe_transport, monitor_role, parent_monitor_id, response_mode, availability_since_ms)
     SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      WHERE ? IS NULL OR EXISTS (SELECT 1 FROM monitors WHERE id = ? AND monitor_role = 'availability')`,
  )
    .bind(
      name,
      url,
      description,
      fallbackUrl,
      serviceBinding,
      method,
      expected,
      keyword,
      timeout,
      interval,
      enabled,
      retry,
      thresholds.database,
      thresholds.database,
      thresholds.http,
      now,
      route.probe_transport, route.monitor_role, route.parent_monitor_id, route.response_mode,
      route.probe_transport === 'public_fetch' && route.monitor_role === 'availability' ? now : null,
      route.parent_monitor_id, route.parent_monitor_id,
    )
    .run();

  if (result.meta.changes !== 1) return jsonError(409, 'parent changed; retry with current configuration');
  const insertedId = (result.meta as { last_row_id?: number }).last_row_id;
  return json(201, { id: insertedId });
}

async function updateMonitor(req: Request, env: Env, id: number): Promise<Response> {
  const body = (await readJson(req)) as CreateBody | null;
  if (!body) return jsonError(400, 'invalid JSON body');
  const thresholds = readLatencyThresholds(body);
  if ('error' in thresholds) return jsonError(400, thresholds.error);

  const existing = await env.DB.prepare(`SELECT * FROM monitors WHERE id = ?`)
    .bind(id)
    .first<Monitor>();
  if (!existing) return jsonError(404, 'monitor not found');

  const route = readRoute(body, existing);
  if ('error' in route) return jsonError(400, route.error);
  const nextUrl = 'url' in body ? asString(body.url) : existing.url;
  const nextMethod = 'method' in body ? (asString(body.method) ?? 'GET').toUpperCase() : existing.method;
  const nextBinding = 'service_binding' in body ? asString(body.service_binding) : existing.service_binding;
  const routeError = validateRoute(route, nextUrl ?? '', nextMethod, nextBinding);
  if (routeError) return jsonError(400, routeError);
  if (route.parent_monitor_id === id || !(await validParent(env, route.parent_monitor_id))) {
    return jsonError(400, 'parent must be a different availability monitor');
  }
  if (route.monitor_role !== 'availability' && await hasChildren(env, id)) {
    return jsonError(409, 'remove child monitors before changing the parent role');
  }

  const fields: string[] = [];
  const values: unknown[] = [];

  if ('name' in body) {
    const v = asString(body.name);
    if (!v) return jsonError(400, 'name cannot be empty');
    fields.push('name = ?');
    values.push(v);
  }
  if ('url' in body) {
    const v = asString(body.url);
    if (!v || !isHttpUrl(v)) return jsonError(400, 'url must be http(s)');
    fields.push('url = ?');
    values.push(v);
  }
  if ('description' in body) {
    fields.push('description = ?');
    values.push(asDescription(body.description));
  }
  if ('fallback_url' in body) {
    const v = asString(body.fallback_url);
    if (v !== null && !isHttpUrl(v)) {
      return jsonError(400, 'fallback_url must be http(s)');
    }
    fields.push('fallback_url = ?');
    values.push(v);
  }
  if ('service_binding' in body) {
    const v = asString(body.service_binding);
    if (v !== null && !isValidBindingName(v)) {
      return jsonError(
        400,
        'service_binding must be uppercase ASCII letters, digits, or underscore',
      );
    }
    fields.push('service_binding = ?');
    values.push(v);
  }
  if ('method' in body) {
    const v = (asString(body.method) ?? 'GET').toUpperCase();
    fields.push('method = ?');
    values.push(v);
  }
  if ('expected_status' in body) {
    fields.push('expected_status = ?');
    values.push(asInt(body.expected_status, existing.expected_status));
  }
  if ('keyword' in body) {
    fields.push('keyword = ?');
    values.push(asString(body.keyword));
  }
  if ('timeout_ms' in body) {
    fields.push('timeout_ms = ?');
    values.push(clamp(asInt(body.timeout_ms, existing.timeout_ms), 1_000, 30_000));
  }
  if ('interval_minutes' in body) {
    fields.push('interval_minutes = ?');
    values.push(clamp(asInt(body.interval_minutes, existing.interval_minutes), 1, 60));
  }
  if ('retry_threshold' in body) {
    fields.push('retry_threshold = ?');
    values.push(clamp(asInt(body.retry_threshold, existing.retry_threshold), 1, 10));
  }
  if ('enabled' in body) {
    fields.push('enabled = ?');
    values.push(asBoolInt(body.enabled, existing.enabled));
  }
  if ('latency_threshold_ms' in body || 'db_latency_threshold_ms' in body) {
    // The old field represented the service's DB threshold. Never migrate it into HTTP RTT alerting.
    fields.push('latency_threshold_ms = ?', 'db_latency_threshold_ms = ?');
    values.push(thresholds.database, thresholds.database);
  }
  if ('http_latency_threshold_ms' in body) {
    fields.push('http_latency_threshold_ms = ?');
    values.push(thresholds.http);
  }

  for (const key of ['probe_transport', 'monitor_role', 'parent_monitor_id', 'response_mode'] as const) {
    if (key in body) {
      fields.push(`${key} = ?`);
      values.push(route[key]);
    }
  }

  if (fields.length === 0) return jsonError(400, 'no fields to update');

  const routeChanged = route.probe_transport !== (existing.probe_transport ?? 'legacy') ||
    route.monitor_role !== (existing.monitor_role ?? 'availability') ||
    route.response_mode !== (existing.response_mode ?? 'legacy_http') ||
    route.parent_monitor_id !== (existing.parent_monitor_id ?? null) ||
    nextUrl !== existing.url || nextMethod !== existing.method || nextBinding !== existing.service_binding;
  if (routeChanged) {
    fields.push('availability_since_ms = ?');
    values.push(route.probe_transport === 'public_fetch' && route.monitor_role === 'availability' ? Date.now() : null);
  }
  fields.push('config_revision = config_revision + 1');
  values.push(id, existing.config_revision ?? 1, route.parent_monitor_id, route.parent_monitor_id);
  // Evaluate ownership/state with the write, not just a prior read. An old runner
  // cannot commit against the new revision even if it read settings before PATCH.
  const safeCutover = routeChanged ? ` AND NOT EXISTS (
      SELECT 1 FROM monitor_execution WHERE monitor_id = monitors.id
        AND lease_until > CAST(strftime('%s','now') AS INTEGER) * 1000)
    AND NOT EXISTS (SELECT 1 FROM monitor_state WHERE monitor_id = monitors.id AND current_status <> 'up')` : '';
  const safeParent = route.monitor_role === 'availability' ? '' :
    ' AND NOT EXISTS (SELECT 1 FROM monitors AS child WHERE child.parent_monitor_id = monitors.id)';
  const result = await env.DB.prepare(`UPDATE monitors SET ${fields.join(', ')}
    WHERE id = ? AND config_revision = ?
      AND (? IS NULL OR EXISTS (SELECT 1 FROM monitors AS parent WHERE parent.id = ? AND parent.monitor_role = 'availability'))
      ${safeCutover}${safeParent}`)
    .bind(...values)
    .run();
  if (result.meta.changes !== 1) return jsonError(409, 'configuration changed or monitor is not ready for route cutover');

  return json(200, { ok: true, config_revision: (existing.config_revision ?? 1) + 1 });
}

async function deleteMonitor(env: Env, id: number): Promise<Response> {
  if (await hasChildren(env, id)) return jsonError(409, 'remove child monitors before deleting their parent');
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM checks WHERE monitor_id = ?`).bind(id),
    env.DB.prepare(`DELETE FROM monitor_state WHERE monitor_id = ?`).bind(id),
    env.DB.prepare(`DELETE FROM monitors WHERE id = ?`).bind(id),
  ]);
  return json(200, { ok: true });
}

interface MonitorRoute {
  probe_transport: ProbeTransport;
  monitor_role: MonitorRole;
  parent_monitor_id: number | null;
  response_mode: ResponseMode;
}

function readRoute(body: CreateBody, existing?: Monitor): MonitorRoute | { error: string } {
  if ('config_revision' in body || 'availability_since_ms' in body) {
    return { error: 'config_revision and availability_since_ms are managed by the server' };
  }
  const transport = 'probe_transport' in body ? body.probe_transport : existing?.probe_transport ?? 'legacy';
  const role = 'monitor_role' in body ? body.monitor_role : existing?.monitor_role ?? 'availability';
  const mode = 'response_mode' in body ? body.response_mode : existing?.response_mode ?? 'legacy_http';
  if (typeof transport !== 'string' || !['legacy', 'public_fetch', 'service_binding'].includes(transport)) return { error: 'invalid probe_transport' };
  if (typeof role !== 'string' || !['availability', 'diagnostic', 'shadow'].includes(role)) return { error: 'invalid monitor_role' };
  if (typeof mode !== 'string' || !['legacy_http', 'strict_healthz'].includes(mode)) return { error: 'invalid response_mode' };
  const parent = 'parent_monitor_id' in body ? body.parent_monitor_id : existing?.parent_monitor_id ?? null;
  if (parent !== null && (typeof parent !== 'number' || !Number.isSafeInteger(parent) || parent < 1)) {
    return { error: 'parent_monitor_id must be a positive safe integer or null' };
  }
  if ((role === 'availability' && parent !== null) || (role !== 'availability' && parent === null)) {
    return { error: 'availability monitors have no parent; diagnostic and shadow monitors require a parent' };
  }
  return { probe_transport: transport as ProbeTransport, monitor_role: role as MonitorRole,
    response_mode: mode as ResponseMode, parent_monitor_id: parent as number | null };
}

function validateRoute(route: MonitorRoute, url: string, method: string, binding: string | null): string | null {
  if (route.probe_transport === 'service_binding' && !binding) return 'service_binding transport requires a binding name';
  if (route.probe_transport === 'public_fetch' || route.response_mode === 'strict_healthz') {
    if (!isPublicHttpsUrl(url)) return 'explicit public and strict health probes require a public HTTPS domain without credentials, query or fragment';
  }
  if (route.response_mode === 'strict_healthz' && (method !== 'GET' || new URL(url).pathname !== '/healthz')) {
    return 'strict_healthz requires GET /healthz';
  }
  return null;
}

function isPublicHttpsUrl(value: string): boolean {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase().replace(/\.$/, '');
    // Administrators still control DNS. Reject literals and local names here;
    // redirects are independently prohibited by the explicit health probe.
    return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash &&
      (!url.port || url.port === '443') && host.includes('.') && !/^[\d.]+$/.test(host) &&
      /^[a-z0-9.-]+$/.test(host) && !/(?:^|\.)(?:localhost|local|localdomain|internal|lan|home|onion|arpa)$/.test(host);
  } catch { return false; }
}

async function validParent(env: Env, id: number | null): Promise<boolean> {
  if (id === null) return true;
  return await env.DB.prepare("SELECT id FROM monitors WHERE id = ? AND monitor_role = 'availability'")
    .bind(id).first() !== null;
}

async function hasChildren(env: Env, id: number): Promise<boolean> {
  return await env.DB.prepare('SELECT id FROM monitors WHERE parent_monitor_id = ? LIMIT 1').bind(id).first() !== null;
}

async function readJson(req: Request): Promise<unknown> {
  try {
    const value: unknown = await req.json();
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function isHttpUrl(s: string): boolean {
  try {
    const u = new URL(s);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Service binding identifiers in wrangler.toml are conventionally
 * uppercase, alphanumeric with underscores (e.g., `PARTNER_PORTAL`).
 * Constraining the API to that shape keeps casual typos from
 * silently disabling a monitor (the worker logs a warning when it
 * can't resolve the binding, but the monitor would still be
 * recorded as up/down on whatever the bare fetch returned).
 */
function isValidBindingName(s: string): boolean {
  return /^[A-Z][A-Z0-9_]{0,63}$/.test(s);
}

function asString(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const trimmed = v.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function asNullablePositiveInt(v: unknown): number | null | undefined {
  if (v === null || v === undefined) return null;
  const n = typeof v === 'string' && /^\d+$/.test(v.trim()) ? Number(v.trim()) : v;
  return typeof n === 'number' && Number.isSafeInteger(n) && n > 0 ? n : undefined;
}

function readLatencyThresholds(body: CreateBody): { database: number | null; http: number | null } | { error: string } {
  const legacy = asNullablePositiveInt(body.latency_threshold_ms);
  const database = asNullablePositiveInt(body.db_latency_threshold_ms);
  const http = asNullablePositiveInt(body.http_latency_threshold_ms);
  if (legacy === undefined || database === undefined || http === undefined) {
    return { error: 'latency thresholds must be positive safe integers or null' };
  }
  if ('latency_threshold_ms' in body && 'db_latency_threshold_ms' in body && legacy !== database) {
    return { error: 'latency_threshold_ms is a deprecated DB alias; conflicting DB thresholds are not allowed' };
  }
  return { database: 'db_latency_threshold_ms' in body ? database : legacy, http };
}

function asInt(v: unknown, fallback: number): number {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.trunc(v);
  if (typeof v === 'string') {
    const n = Number.parseInt(v, 10);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}

function asBoolInt(v: unknown, fallback: number): number {
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'number') return v ? 1 : 0;
  if (typeof v === 'string') {
    if (/^(true|1|yes|on)$/i.test(v)) return 1;
    if (/^(false|0|no|off)$/i.test(v)) return 0;
  }
  return fallback;
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

function json(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), { status, headers: JSON_HEADERS });
}

function jsonError(status: number, message: string): Response {
  return json(status, { error: message });
}
