import type { CheckResult, CheckStatus, Env, Monitor, MonitorState } from './types';
import { notifyDown, notifyUp } from './notifier';

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
  const result = await performCheck(monitor);

  await env.DB.prepare(
    `INSERT INTO checks (monitor_id, status, status_code, latency_ms, error, ts)
     VALUES (?, ?, ?, ?, ?, ?)`,
  )
    .bind(monitor.id, result.status, result.status_code, result.latency_ms, result.error, ts)
    .run();

  await reconcileState(env, monitor, result, ts);
}

export async function performCheck(monitor: Monitor): Promise<CheckResult> {
  const controller = new AbortController();
  const timeoutMs = monitor.timeout_ms ?? 10_000;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const start = Date.now();

  try {
    const response = await fetch(monitor.url, {
      method: monitor.method || 'GET',
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        'User-Agent': 'kuma-lite/0.1 (uptime monitor)',
      },
    });
    const latency = Date.now() - start;

    if (response.status !== monitor.expected_status) {
      const body = await safeReadBody(response);
      return {
        status: 'down',
        status_code: response.status,
        latency_ms: latency,
        error: `Expected status ${monitor.expected_status}, got ${response.status}${body ? `: ${body.slice(0, 120)}` : ''}`,
      };
    }

    if (monitor.keyword) {
      const body = await safeReadBody(response);
      if (body === null) {
        return {
          status: 'down',
          status_code: response.status,
          latency_ms: latency,
          error: 'Failed to read response body for keyword check',
        };
      }
      if (!body.includes(monitor.keyword)) {
        return {
          status: 'down',
          status_code: response.status,
          latency_ms: latency,
          error: `Keyword "${monitor.keyword}" not found in response`,
        };
      }
    } else {
      // Drain body so the connection can close cleanly.
      await safeReadBody(response);
    }

    return {
      status: 'up',
      status_code: response.status,
      latency_ms: latency,
      error: null,
    };
  } catch (err) {
    const latency = Date.now() - start;
    const aborted = (err as Error)?.name === 'AbortError';
    return {
      status: 'down',
      status_code: null,
      latency_ms: latency,
      error: aborted ? `Timeout after ${timeoutMs}ms` : errorMessage(err),
    };
  } finally {
    clearTimeout(timer);
  }
}

async function safeReadBody(response: Response): Promise<string | null> {
  try {
    return await response.text();
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

  let nextStatus: CheckStatus = prevStatus;
  let nextFailures = prevFailures;
  let nextDownSince = prevDownSince;
  let nextNotifiedAt = prevNotifiedAt;

  const threshold = Math.max(1, monitor.retry_threshold ?? 1);

  if (result.status === 'down') {
    nextFailures = prevFailures + 1;
    if (prevStatus === 'up' && nextFailures >= threshold) {
      nextStatus = 'down';
      nextDownSince = ts;
      nextNotifiedAt = ts;
      await safeNotify(() => notifyDown(env, monitor, result.error ?? 'unknown error'));
    }
  } else {
    nextFailures = 0;
    if (prevStatus === 'down') {
      nextStatus = 'up';
      const downDurationMs = prevDownSince ? ts - prevDownSince : 0;
      nextDownSince = null;
      nextNotifiedAt = ts;
      await safeNotify(() => notifyUp(env, monitor, downDurationMs));
    }
  }

  await env.DB.prepare(
    `INSERT INTO monitor_state (monitor_id, current_status, consecutive_failures, last_notified_at, down_since)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(monitor_id) DO UPDATE SET
       current_status = excluded.current_status,
       consecutive_failures = excluded.consecutive_failures,
       last_notified_at = excluded.last_notified_at,
       down_since = excluded.down_since`,
  )
    .bind(monitor.id, nextStatus, nextFailures, nextNotifiedAt, nextDownSince)
    .run();
}

async function safeNotify(fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    console.error('notification failed:', errorMessage(err));
  }
}

export async function cleanupOldChecks(env: Env): Promise<void> {
  const days = Number.parseInt(env.RETENTION_DAYS ?? '7', 10) || 7;
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  await env.DB.prepare(`DELETE FROM checks WHERE ts < ?`).bind(cutoff).run();
}
