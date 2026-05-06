import type { Env, Monitor } from './types';

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

    const monitorId = Number.parseInt(id, 10);
    if (!Number.isFinite(monitorId)) return jsonError(400, 'invalid id');

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
  method?: unknown;
  expected_status?: unknown;
  keyword?: unknown;
  timeout_ms?: unknown;
  interval_minutes?: unknown;
  retry_threshold?: unknown;
  enabled?: unknown;
}

async function createMonitor(req: Request, env: Env): Promise<Response> {
  const body = (await readJson(req)) as CreateBody | null;
  if (!body) return jsonError(400, 'invalid JSON body');

  const name = asString(body.name);
  const url = asString(body.url);
  if (!name || !url) return jsonError(400, 'name and url are required');
  if (!isHttpUrl(url)) return jsonError(400, 'url must be http(s)');

  const method = (asString(body.method) ?? 'GET').toUpperCase();
  const expected = asInt(body.expected_status, 200);
  const keyword = asString(body.keyword);
  const timeout = clamp(asInt(body.timeout_ms, 10_000), 1_000, 30_000);
  const interval = clamp(asInt(body.interval_minutes, 1), 1, 60);
  const retry = clamp(asInt(body.retry_threshold, 2), 1, 10);
  const enabled = asBoolInt(body.enabled, 1);

  const now = Date.now();
  const result = await env.DB.prepare(
    `INSERT INTO monitors (name, url, method, expected_status, keyword, timeout_ms, interval_minutes, enabled, retry_threshold, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(name, url, method, expected, keyword, timeout, interval, enabled, retry, now)
    .run();

  const insertedId = (result.meta as { last_row_id?: number }).last_row_id;
  return json(201, { id: insertedId });
}

async function updateMonitor(req: Request, env: Env, id: number): Promise<Response> {
  const body = (await readJson(req)) as CreateBody | null;
  if (!body) return jsonError(400, 'invalid JSON body');

  const existing = await env.DB.prepare(`SELECT * FROM monitors WHERE id = ?`)
    .bind(id)
    .first<Monitor>();
  if (!existing) return jsonError(404, 'monitor not found');

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

  if (fields.length === 0) return jsonError(400, 'no fields to update');

  values.push(id);
  await env.DB.prepare(`UPDATE monitors SET ${fields.join(', ')} WHERE id = ?`)
    .bind(...values)
    .run();

  return json(200, { ok: true });
}

async function deleteMonitor(env: Env, id: number): Promise<Response> {
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM checks WHERE monitor_id = ?`).bind(id),
    env.DB.prepare(`DELETE FROM monitor_state WHERE monitor_id = ?`).bind(id),
    env.DB.prepare(`DELETE FROM monitors WHERE id = ?`).bind(id),
  ]);
  return json(200, { ok: true });
}

async function readJson(req: Request): Promise<unknown> {
  try {
    return await req.json();
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

function asString(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const trimmed = v.trim();
  return trimmed.length === 0 ? null : trimmed;
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
