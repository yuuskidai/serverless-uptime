#!/usr/bin/env node
import { readFile, mkdir, writeFile, appendFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const CONFIG_URL = new URL('../external-targets.json', import.meta.url);
const JSON_LIMIT = 8192;
const TIMEOUT_MS = 10_000;
const latencyReason = value => typeof value === 'string' && /^応答が \d+(?:\.\d+)?ms を超過 \(\d+(?:\.\d+)?ms\)$/.test(value);
const databaseName = name => /^(database|db|d1)$/i.test(name.trim());
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

async function fetchJson(url, { fetcher = fetch, timeoutMs = TIMEOUT_MS, requestId = null, headers = {}, method = 'GET', body } = {}) {
  const observed_at = Date.now();
  const started = performance.now();
  const controller = new AbortController();
  let response;
  let reader;
  let timedOut = false;
  let timer;
  const operation = (async () => {
    response = await fetcher(url, { method, redirect: 'manual', signal: controller.signal,
      ...(method === 'GET' ? { cache: 'no-store' } : {}),
      headers: { 'User-Agent': 'kuma-lite-external/1 (GitHub Actions witness)',
        ...(requestId ? { 'X-Monitor-Request-ID': requestId } : {}), ...headers },
      ...(body === undefined ? {} : { body }) });
    controller.signal.throwIfAborted();
    reader = response.body?.getReader();
    let count = 0;
    const chunks = [];
    if (reader) for (;;) {
      const part = await reader.read();
      controller.signal.throwIfAborted();
      if (part.done) break;
      count += part.value.byteLength;
      if (count > JSON_LIMIT) throw new Error('invalid_health');
      chunks.push(part.value);
    }
    const bytes = new Uint8Array(count);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (!/^application\/json(?:\s*;|\s*$)/i.test(response.headers.get('content-type') ?? '')) throw new Error('invalid_health');
    let data;
    try { data = JSON.parse(text); } catch { throw new Error('invalid_health'); }
    return data;
  })();
  try {
    const value = await Promise.race([operation, new Promise((_, reject) => {
      timer = setTimeout(() => { timedOut = true; controller.abort(); reject(new Error('deadline')); }, timeoutMs);
    })]);
    return { observed_at, finished_at: Date.now(), total_ms: Math.round((performance.now() - started) * 100) / 100,
      http_status: response.status, value, headers: response.headers, error: null };
  } catch (error) {
    return { observed_at, finished_at: Date.now(), total_ms: Math.round((performance.now() - started) * 100) / 100,
      http_status: response?.status ?? null, value: null, headers: response?.headers ?? new Headers(),
      error: timedOut ? (response ? 'timeout_body' : 'timeout_headers') : error?.message === 'invalid_health' ? 'invalid_health' : 'network_error' };
  } finally {
    clearTimeout(timer);
    if (reader) { void reader.cancel().catch(() => undefined); try { reader.releaseLock(); } catch {} }
    else if (response?.body) void response.body.cancel().catch(() => undefined);
  }
}

function uncached(headers) {
  const policy = headers.get('cache-control') ?? '';
  return /(?:^|,)\s*no-store\s*(?:,|$)/i.test(policy) && !(Number(headers.get('age')) > 0) &&
    !['HIT', 'STALE', 'UPDATING', 'REVALIDATED'].includes(headers.get('cf-cache-status')?.trim().toUpperCase());
}

function health(value, threshold) {
  if (!object(value) || typeof value.status !== 'string' || !['ok', 'degraded', 'down'].includes(value.status) ||
      !Array.isArray(value.components) || value.components.length < 1 || value.components.length > 20 ||
      (value.reason !== undefined && value.reason !== null && typeof value.reason !== 'string')) throw new Error('invalid_health');
  let database = null;
  const names = new Set();
  const original = value.components.map(component => {
    if (!object(component) || typeof component.name !== 'string' || !component.name.trim() || component.name.length > 200 ||
        typeof component.status !== 'string' || !['ok', 'degraded', 'down'].includes(component.status) ||
        (component.reason !== undefined && component.reason !== null && typeof component.reason !== 'string') ||
        (component.latency_ms !== undefined && (typeof component.latency_ms !== 'number' || !Number.isFinite(component.latency_ms) || component.latency_ms < 0 || component.latency_ms > 30_000))) throw new Error('invalid_health');
    const name = component.name.trim().toLowerCase();
    if (names.has(name)) throw new Error('invalid_health');
    names.add(name);
    if (databaseName(name)) {
      if (database !== null || component.latency_ms === undefined) throw new Error('invalid_health');
      database = component.latency_ms;
    }
    return component;
  });
  if (database === null) throw new Error('invalid_health');
  const components = original.map(component => {
    if (!databaseName(component.name) || component.status === 'down') return component;
    if (component.latency_ms >= threshold && (component.status === 'ok' || latencyReason(component.reason))) return { ...component, status: 'degraded' };
    if (component.latency_ms < threshold && component.status === 'degraded' && latencyReason(component.reason)) return { ...component, status: 'ok' };
    return component;
  });
  let status = value.status;
  const unhealthy = components.filter(component => component.status !== 'ok');
  const previous = original.filter(component => component.status !== 'ok');
  if (status === 'degraded' && previous.length > 0 && unhealthy.length === 0 &&
      previous.every(component => databaseName(component.name) && latencyReason(component.reason)) &&
      (!value.reason || latencyReason(value.reason))) status = 'ok';
  if (unhealthy.some(component => component.status === 'down')) status = 'down';
  else if (status === 'ok' && unhealthy.length) status = 'degraded';
  return { status, database_ms: database };
}

function validateTarget(target) {
  const url = new URL(target.url);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.port ||
      url.pathname !== '/healthz' || !Number.isSafeInteger(target.monitor_id) || target.monitor_id < 1 ||
      !Number.isSafeInteger(target.db_threshold_ms) || target.db_threshold_ms < 1) throw new Error('invalid_target_configuration');
}

export async function probeTarget(target, options = {}) {
  validateTarget(target);
  const request_id = crypto.randomUUID();
  const measured = await fetchJson(target.url, { ...options, requestId: request_id });
  let status = 'down'; let database_ms = null; let error = measured.error;
  if (!error) {
    if (!uncached(measured.headers)) error = 'cached_response';
    else {
      try {
        const parsed = health(measured.value, target.db_threshold_ms);
        database_ms = parsed.database_ms;
        if (measured.http_status !== 200) error = 'http_error';
        else status = parsed.status;
      } catch { error = 'invalid_health'; }
    }
  }
  const { observed_at, finished_at, total_ms, http_status } = measured;
  return { monitor_id: target.monitor_id, url: target.url, observed_at, finished_at, total_ms, http_status,
    status, database_ms, db_threshold_ms: target.db_threshold_ms, error, request_id };
}

export async function probeReadiness(url, options = {}) {
  const target = new URL(url);
  if (target.protocol !== 'https:' || target.username || target.password || target.search || target.hash ||
      target.pathname !== '/readyz') throw new Error('invalid_readiness_configuration');
  const measured = await fetchJson(url, options);
  let status = 'unknown'; let error = measured.error;
  if (!error) {
    if (!uncached(measured.headers)) error = 'cached_response';
    else if (measured.http_status !== 200) error = 'http_error';
    else if (object(measured.value) && measured.value.status === 'ok' && measured.value.monitoring_data === 'fresh') status = 'fresh';
    else error = 'invalid_health';
  }
  const { observed_at, finished_at, total_ms, http_status } = measured;
  return { observed_at, finished_at, total_ms, http_status, status, error };
}

async function identityToken(receiver, runtime, fetcher) {
  const url = new URL(runtime.ACTIONS_ID_TOKEN_REQUEST_URL ?? '');
  if (url.protocol !== 'https:' || url.username || url.password || url.hash ||
      !/(?:^|\.)actions\.githubusercontent\.com$/.test(url.hostname) || !runtime.ACTIONS_ID_TOKEN_REQUEST_TOKEN) throw new Error('identity_unavailable');
  url.searchParams.set('audience', receiver);
  const token = await fetchJson(url.href, { fetcher, headers: { Authorization: `Bearer ${runtime.ACTIONS_ID_TOKEN_REQUEST_TOKEN}` } });
  if (token.error || token.http_status !== 200 || typeof token.value?.value !== 'string' ||
      token.value.value.length > 16_384 || !/^[A-Za-z0-9_.-]+$/.test(token.value.value)) throw new Error('identity_unavailable');
  return token.value.value;
}

export async function runExternalWitness(config, runtime = process.env, options = {}) {
  if (!config || config.version !== 1 || !Array.isArray(config.targets) || config.targets.length !== 2) throw new Error('invalid_target_configuration');
  const run_id = runtime.GITHUB_RUN_ID;
  const run_attempt = runtime.GITHUB_RUN_ATTEMPT;
  const commit_sha = runtime.GITHUB_SHA;
  if (!/^[1-9]\d{0,19}$/.test(run_id ?? '') || !/^[1-9]\d{0,5}$/.test(run_attempt ?? '') ||
      !/^[a-f0-9]{40}$/.test(commit_sha ?? '')) throw new Error('invalid_workflow_context');
  const [observations, readiness] = await Promise.all([
    Promise.all(config.targets.map(target => probeTarget(target, options))),
    probeReadiness(config.readiness_url, options),
  ]);
  const payload = { version: 1, run_id, run_attempt, commit_sha, observations, readiness };
  const result = { ...payload, source: 'github_actions', reporting: { accepted: false, status: null, error: null },
    service_failure: observations.some(observation => observation.status === 'down'), monitor_freshness_failure: readiness.status !== 'fresh' };
  if (options.noSubmit) { result.reporting.error = 'not_submitted'; return result; }
  try {
    const receiver = new URL(config.receiver);
    if (receiver.protocol !== 'https:' || receiver.username || receiver.password || receiver.search || receiver.hash ||
        receiver.pathname !== '/api/external-observations' || receiver.origin !== new URL(config.readiness_url).origin) throw new Error('invalid_receiver_configuration');
    const fetcher = options.fetcher ?? fetch;
    const token = await identityToken(receiver.href, runtime, fetcher);
    const body = JSON.stringify(payload);
    for (let attempt = 0; attempt < 3; attempt++) {
      const submission = await fetchJson(receiver.href, { fetcher, method: 'POST', body,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } });
      result.reporting.status = submission.http_status;
      if (submission.http_status === 200 && submission.value?.accepted === true) { result.reporting.accepted = true; break; }
      result.reporting.error = 'receiver_unavailable';
      if (submission.http_status !== null && ![404, 408, 429, 500, 502, 503, 504].includes(submission.http_status)) break;
      if (attempt < 2) await new Promise(resolve => setTimeout(resolve, Math.min(5000, Math.max(1, options.retryDelayMs ?? 5000))));
    }
  } catch { result.reporting.error = 'identity_or_receiver_unavailable'; }
  return result;
}

export async function main() {
  const config = JSON.parse(await readFile(CONFIG_URL, 'utf8'));
  const result = await runExternalWitness(config, process.env, { noSubmit: process.argv.includes('--no-submit') });
  const directory = resolve(process.env.EXTERNAL_PROBE_OUTPUT_DIR ?? 'artifacts');
  await mkdir(directory, { recursive: true });
  await writeFile(resolve(directory, 'external-health.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result));
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY,
    `External HTTPS witness\n\n${result.observations.map(observation => `- monitor ${observation.monitor_id}: ${observation.status}, HTTP ${observation.http_status ?? 'none'}, ${observation.total_ms}ms`).join('\n')}\n- Monitoring data: ${result.readiness.status}\n- Result receipt: ${result.reporting.accepted ? 'accepted' : 'unavailable'}\n`);
  if (result.service_failure || result.monitor_freshness_failure || (!result.reporting.accepted && !process.argv.includes('--no-submit'))) process.exitCode = 1;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch(() => { console.error('External witness could not complete; inspect the workflow step status.'); process.exitCode = 1; });
}
