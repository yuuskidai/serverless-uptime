import type { Env, Monitor } from './types';

// A source-reviewed absolute window keeps cold isolates from extending the
// diagnostic by starting a fresh relative timer. Both unset means disabled.
export const BINDING_DIAGNOSTIC_FROM: string | null = '2026-10-29T01:38:00.000Z';
export const BINDING_DIAGNOSTIC_UNTIL: string | null = '2026-10-29T01:58:00.000Z';
export type BindingDiagnosticMode = 'parallel_control' | 'portal_first' | 'core_first';
export interface BindingDiagnosticTimings {
  diagnostic_mode: BindingDiagnosticMode;
  dispatch_wait_ms: number;
  diagnostic_contaminated: boolean;
}
interface Window { from: string | null; until: string | null }
interface Clock {
  now(): number;
  setTimeout(callback: () => void, ms: number): ReturnType<typeof setTimeout>;
  clearTimeout(timer: ReturnType<typeof setTimeout>): void;
}
// Legacy Workers timers reject a Clock object as their receiver. Keep native
// global calls inside wrappers so cleanup cannot drop the queued observation.
const clock: Clock = { now: () => Date.now(), setTimeout: (callback, ms) => setTimeout(callback, ms), clearTimeout: timer => clearTimeout(timer) };

export function isBindingDiagnosticMode(value: unknown): value is BindingDiagnosticMode {
  return value === 'parallel_control' || value === 'portal_first' || value === 'core_first';
}

/** A caller timeout/cancel does not establish that the callee stopped running. */
export function bindingResponseCompleted(traceJson: string): boolean {
  try {
    const traces: unknown = JSON.parse(traceJson);
    return Array.isArray(traces) && traces.length > 0 && traces.every(trace => trace && typeof trace === 'object'
      && trace.failure_phase === null && typeof trace.headers_ms === 'number' && typeof trace.body_ms === 'number'
      && typeof trace.status_code === 'number');
  } catch { return false; }
}

function absoluteTime(value: string | null): number {
  return typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)$/.test(value)
    ? Date.parse(value) : NaN;
}

function matchesTarget(env: Env, monitor: Monitor, id: number): boolean {
  const portal = id === 5 || id === 9, main = id === 5 || id === 6;
  const binding = portal ? 'PARTNER_PORTAL' : 'CORE_OS';
  return monitor.id === id && monitor.enabled === 1 && monitor.method === 'GET' && monitor.expected_status === 200
    && monitor.url === `https://${portal ? 'partner-portal' : 'core-os'}.opus-system.jp/healthz`
    && monitor.interval_minutes === 1 && monitor.timeout_ms === 10_000 && monitor.retry_threshold === 2
    && monitor.db_latency_threshold_ms === 1000 && monitor.http_latency_threshold_ms === null
    && monitor.config_revision === (main ? 1 : 3) && monitor.monitor_role === (main ? 'availability' : 'shadow')
    && monitor.probe_transport === (main ? 'legacy' : 'public_fetch')
    && monitor.response_mode === (main ? 'legacy_http' : 'strict_healthz')
    && (!main || (monitor.service_binding === binding && typeof env[binding]?.fetch === 'function'));
}

/** Dispatch only within this run: never a cross-request lock or ownership lease. */
export interface BindingDiagnostic {
  wait(monitorId: number): Promise<void>;
  bypass(): void;
  start(monitorId: number): void;
  finish(monitorId: number, responseCompleted?: boolean): void;
  timings(monitorId: number): BindingDiagnosticTimings;
}

export function createBindingDiagnostic(env: Env, monitors: Monitor[], scheduledTime: number, receivedAt: number,
  window: Window = { from: BINDING_DIAGNOSTIC_FROM, until: BINDING_DIAGNOSTIC_UNTIL }, time: Clock = clock,
): BindingDiagnostic | undefined {
  const from = absoluteTime(window.from), until = absoluteTime(window.until), now = time.now();
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(until) || until <= from || until - from > 20 * 60_000
    || !Number.isSafeInteger(scheduledTime) || !Number.isSafeInteger(receivedAt) || scheduledTime > receivedAt
    || scheduledTime < from || scheduledTime >= until || receivedAt < from || receivedAt >= until || now < from || now >= until) return;
  // Parallel binding callbacks may contend during app readiness waits. Restrict
  // this experiment to the unchanged four-target cohort, never unknown routes.
  if (monitors.length !== 4 || ![5, 6, 9, 10].every(id => {
    const matches = monitors.filter(monitor => monitor.id === id);
    return matches.length === 1 && matchesTarget(env, matches[0], id);
  })) return;
  const cycle = (Math.floor(scheduledTime / 60_000) - Math.floor(from / 60_000)) % 4;
  const mode: BindingDiagnosticMode = cycle === 1 ? 'portal_first' : cycle === 3 ? 'core_first' : 'parallel_control';
  const first = mode === 'portal_first' ? 5 : 6, second = first === 5 ? 6 : 5;
  let firstFinished = false, contaminated = false, bypassed = false;
  let releaseFirst!: () => void;
  const firstDone = new Promise<void>(resolve => { releaseFirst = resolve; });
  const waits = new Map<number, number>(), active = new Set<number>();
  const deadline = Math.min(until, receivedAt + 25_000, scheduledTime + 35_000);
  const expired = () => time.now() < from || time.now() >= until;
  const bypass = () => {
    contaminated = true;
    bypassed = true;
    firstFinished = true;
    releaseFirst();
  };
  return {
    bypass,
    async wait(id) {
      if (id !== 5 && id !== 6) return;
      const began = time.now();
      if (bypassed) { waits.set(id, 0); return; }
      if (expired()) { contaminated = true; return; }
      if (mode !== 'parallel_control' && id === second && !firstFinished) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          if (time.now() < deadline) await Promise.race([firstDone, new Promise<void>(resolve => {
            timer = time.setTimeout(resolve, Math.max(0, deadline - time.now()));
          })]);
          // Delayed timers cannot extend the restriction. Resume the original
          // parallel behavior instead of dropping a scheduled observation.
          if (!firstFinished || time.now() >= deadline) contaminated = true;
        } catch {
          // Diagnostic timer failures must not become a missing health check.
          // Drop only this run's restriction; preserve the real probe result.
          bypass();
        } finally {
          if (timer !== undefined) {
            try { time.clearTimeout(timer); }
            catch { bypass(); }
          }
        }
      }
      waits.set(id, Math.max(0, time.now() - began));
    },
    start(id) {
      if (expired()) contaminated = true;
      if (id !== 5 && id !== 6) return;
      if (mode !== 'parallel_control' && active.size > 0) contaminated = true;
      active.add(id);
    },
    finish(id, responseCompleted = true) {
      if ((id === 5 || id === 6) && !responseCompleted) contaminated = true;
      if (active.has(id) && expired()) contaminated = true;
      active.delete(id);
      if (id === first && !firstFinished) { firstFinished = true; releaseFirst(); }
    },
    timings(id) {
      return { diagnostic_mode: mode, dispatch_wait_ms: waits.get(id) ?? 0, diagnostic_contaminated: contaminated };
    },
  };
}
