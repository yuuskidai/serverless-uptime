import { performCheck } from '../../kuma-lite/src/monitor';
import type { CheckResult, Monitor, ProbeTrace } from '../../kuma-lite/src/types';
import type { TargetObservation } from './types';

export const TARGETS = Object.freeze([
  { target: 'portal' as const, id: 5, name: 'Partner Portal', url: 'https://partner-portal.opus-system.jp/healthz' },
  { target: 'core' as const, id: 6, name: 'Core OS', url: 'https://core-os.opus-system.jp/healthz' },
]);

export async function checkTargets(): Promise<TargetObservation[]> {
  return Promise.all(TARGETS.map(async target => {
    const monitor: Monitor = {
      id: target.id, name: target.name, url: target.url, description: null,
      fallback_url: null, service_binding: null, probe_transport: 'public_fetch',
      monitor_role: 'availability', response_mode: 'strict_healthz', config_revision: 1,
      method: 'GET', expected_status: 200, keyword: null, timeout_ms: 10_000,
      interval_minutes: 1, enabled: 1, retry_threshold: 1,
      latency_threshold_ms: null, http_latency_threshold_ms: null,
      db_latency_threshold_ms: 1000, created_at: 0,
    };
    // performCheck only reads optional service bindings for other transport modes.
    // This public-fetch-only call uses no database or privileged environment binding.
    const observedAt = Date.now();
    const result = await performCheck({} as Parameters<typeof performCheck>[0], monitor);
    return { ...sanitiseResult(target.target, result), observed_at: observedAt, finished_at: Date.now() };
  }));
}

function sanitiseResult(target: TargetObservation['target'], result: CheckResult): TargetObservation {
  const traces = JSON.parse(result.probe_trace_json) as ProbeTrace[];
  const trace = traces[0];
  const components = result.healthz_components ? JSON.parse(result.healthz_components) as { name: string; latency_ms?: number }[] : [];
  const db = components.find(component => /^(?:database|db|d1)$/i.test(component.name.trim()));
  const failed = result.status === 'down';
  return {
    target, observed_at: null, finished_at: null, status: failed ? 'down' : result.healthz_status ?? 'unknown',
    http_status: result.status_code, total_ms: result.latency_ms,
    database_ms: db?.latency_ms ?? null,
    failure: !failed ? null : /Timeout after/.test(result.error ?? '') ? 'timeout'
      : trace?.failure_phase ?? 'invalid_healthz',
    request_id: trace?.request_id ?? null, response_request_id: trace?.response_request_id ?? null,
    request_id_matched: trace?.request_id_matched ?? false,
    headers_ms: trace?.headers_ms ?? null, body_ms: trace?.body_ms ?? null,
    timeout_callback_elapsed_ms: trace?.timeout_callback_elapsed_ms ?? null,
    deadline_overrun_ms: trace?.deadline_overrun_ms ?? null,
    healthz_version: result.healthz_version && /^[A-Za-z0-9._-]{1,64}$/.test(result.healthz_version) ? result.healthz_version : null,
  };
}
