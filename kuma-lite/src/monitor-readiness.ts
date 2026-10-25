import type { Env, Monitor } from './types';

export type MonitorFreshness = 'fresh' | 'missing' | 'stale';
type FreshnessMonitor = Pick<Monitor, 'interval_minutes' | 'config_revision'>;
export interface FreshnessCheck {
  ts: number;
  scheduled_slot?: number | null;
  config_revision?: number | null;
}

export function freshnessLimitMs(monitor: Pick<Monitor, 'interval_minutes'>): number {
  return Math.max(180_000, Math.max(1, monitor.interval_minutes ?? 1) * 180_000);
}

/** Freshness is independent of whether the latest target response was healthy. */
export function monitorFreshness(monitor: FreshnessMonitor, latest: FreshnessCheck | null,
  now = Date.now()): MonitorFreshness {
  if (!latest || !Number.isSafeInteger(latest.ts) ||
    (latest.config_revision ?? 1) !== (monitor.config_revision ?? 1)) return 'missing';
  const limit = freshnessLimitMs(monitor);
  if (latest.ts > now + 60_000 || now - latest.ts >= limit) return 'stale';
  // A delayed old Cron invocation must not make the monitor appear current.
  if (latest.scheduled_slot != null && (!Number.isSafeInteger(latest.scheduled_slot) ||
    latest.scheduled_slot > now + 60_000 || now - latest.scheduled_slot >= limit)) return 'stale';
  return 'fresh';
}

/** Minimal public heartbeat: reveals neither targets nor internal diagnostic data. */
export async function monitoringReadiness(env: Env, now = Date.now()): Promise<Response> {
  const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };
  try {
    const rows = await env.DB.prepare(
      `SELECT m.interval_minutes, m.config_revision, c.ts, c.scheduled_slot, c.config_revision AS check_revision
         FROM monitors m LEFT JOIN checks c ON c.id =
           (SELECT id FROM checks WHERE monitor_id = m.id AND config_revision = m.config_revision ORDER BY ts DESC LIMIT 1)
        WHERE m.enabled = 1 AND m.monitor_role = 'availability'`,
    ).all<{ interval_minutes: number; config_revision: number; ts: number | null;
      scheduled_slot: number | null; check_revision: number | null }>();
    const availability = rows.results ?? [];
    const fresh = availability.length > 0 && availability.every(row => monitorFreshness(row,
      row.ts == null ? null : { ts: row.ts, scheduled_slot: row.scheduled_slot, config_revision: row.check_revision }, now) === 'fresh');
    return new Response(JSON.stringify({ status: fresh ? 'ok' : 'unknown', monitoring_data: fresh ? 'fresh' : 'missing_or_stale' }),
      { status: fresh ? 200 : 503, headers });
  } catch {
    return new Response(JSON.stringify({ status: 'unknown', monitoring_data: 'unavailable' }), { status: 503, headers });
  }
}
