import type { CheckResult, Env, Monitor } from './types';
import type { MonitorLease } from './monitor-execution';
import type { StateTransition } from './state-transition';

export const DIAGNOSTIC_BAD_OBSERVATIONS = 6;
export const DIAGNOSTIC_NORMAL_OBSERVATIONS = 2;
const DB_NOW = "(CAST(strftime('%s','now') AS INTEGER) * 1000)";

/**
 * Short internal-path fluctuations generated warning/recovery pairs even while
 * the public service was healthy. Keep every check and the existing state
 * thresholds, but page only for a sustained diagnostic episode. Read the
 * accepted, bounded slot history so missing observations and mixed severities
 * cannot manufacture either a streak or a recovery.
 */
export function diagnosticOutboxInsertStatement(
  env: Env, monitor: Monitor, lease: MonitorLease, result: CheckResult, transition: StateTransition, ts: number,
): D1PreparedStatement | null {
  if (result.maintenance && ts >= result.maintenance.from_ms && ts < result.maintenance.to_ms) return null;
  const bad = result.status === 'down' || result.healthz_status === 'degraded';
  if (!bad && !(result.status === 'up' && result.healthz_status === 'ok')) return null;
  const kind = bad ? (result.status === 'down' ? 'down' : 'degraded') : 'up';
  const count = bad ? DIAGNOSTIC_BAD_OBSERVATIONS : DIAGNOSTIC_NORMAL_OBSERVATIONS;
  const interval = Math.max(1, monitor.interval_minutes ?? 1) * 60_000;
  const firstSlot = lease.slotMs - (count - 1) * interval;
  const revision = lease.configRevision ?? 1;
  const transport = monitor.probe_transport ?? 'service_binding';
  const resultJson = JSON.stringify(result);
  const transitionJson = JSON.stringify({ ...transition, kind });
  if (resultJson.length > 32768 || transitionJson.length > 16384) throw new Error('Notification payload exceeds bounds');
  const eligible = "status IN ('pending','processing','sent','uncertain')";
  return env.DB.prepare(`WITH boundary AS (
      SELECT COALESCE(MAX(scheduled_slot),-1) AS slot FROM notification_outbox
      WHERE monitor_id=? AND kind='up' AND (${eligible}
        OR (status='cancelled' AND last_error='diagnostic_thread_unavailable'))
    ), open_warning AS (
      SELECT 1 FROM notification_outbox WHERE monitor_id=? AND kind IN ('down','degraded')
        AND ${eligible} AND scheduled_slot>(SELECT slot FROM boundary)
      UNION ALL SELECT 1 FROM notification_delivery_state WHERE monitor_id=? AND slack_alert_ts IS NOT NULL
    ) INSERT OR IGNORE INTO notification_outbox
      (monitor_id,scheduled_slot,config_revision,kind,observed_at,result_json,transition_json,created_at)
    SELECT ?,?,?,?,?,?,?,${DB_NOW} WHERE changes()=1
      AND EXISTS (SELECT 1 FROM monitor_execution WHERE monitor_id=? AND claimed_slot=? AND lease_token=?)
      AND EXISTS (SELECT 1 FROM monitor_state WHERE monitor_id=? AND last_check_slot=? AND config_revision=?)
      AND EXISTS (SELECT 1 FROM monitors WHERE id=? AND enabled=1 AND config_revision=?
        AND monitor_role='diagnostic' AND probe_transport=?)
      AND (SELECT COUNT(*) FROM checks WHERE monitor_id=? AND scheduled_slot BETWEEN ? AND ?
        AND (? - scheduled_slot) % ? = 0 AND config_revision=? AND monitor_role='diagnostic'
        AND probe_transport=? AND in_maintenance=0
        AND ${bad ? "(status='down' OR healthz_status='degraded')" : "(status='up' AND healthz_status='ok')"})=?
      AND ${bad ? `NOT EXISTS (SELECT 1 FROM open_warning)
        AND NOT EXISTS (SELECT 1 FROM notification_outbox WHERE monitor_id=? AND kind IN ('down','degraded')
          AND status='failed' AND scheduled_slot BETWEEN ? AND ?)` : `EXISTS (SELECT 1 FROM open_warning)
        AND NOT EXISTS (SELECT 1 FROM notification_outbox WHERE monitor_id=? AND kind='up'
          AND (status IN ('pending','processing') OR (status='failed' AND scheduled_slot>=?)))`}`)
    .bind(monitor.id,monitor.id,monitor.id,
      monitor.id,lease.slotMs,revision,kind,ts,resultJson,transitionJson,
      monitor.id,lease.slotMs,lease.token,monitor.id,lease.slotMs,revision,
      monitor.id,revision,transport,
      monitor.id,firstSlot,lease.slotMs,lease.slotMs,interval,revision,transport,count,
      monitor.id,...(bad ? [firstSlot,lease.slotMs] : [lease.slotMs-(DIAGNOSTIC_BAD_OBSERVATIONS-1)*interval]));
}
