import type { CheckResult, CheckStatus, Monitor, MonitorState } from './types';

export interface OrderedMonitorState extends MonitorState {
  last_check_slot: number;
  consecutive_successes: number;
}

export interface StateTransition {
  next: OrderedMonitorState;
  previousStatus: CheckStatus;
  nextStatus: CheckStatus;
  kind: 'down' | 'degraded' | 'partial' | 'up' | null;
  downDurationMs: number;
  previousSlackAlertTs: string | null;
}

/** Pure threshold calculation; persistence/notification ownership lives in the runner. */
export function deriveTransition(
  monitor: Monitor,
  result: CheckResult,
  previous: OrderedMonitorState | null,
  ts: number,
  slotMs: number,
  inMaintenance: boolean,
): StateTransition {
  const previousStatus = previous?.current_status ?? 'up';
  const next: OrderedMonitorState = {
    monitor_id: monitor.id,
    current_status: previousStatus,
    consecutive_failures: previous?.consecutive_failures ?? 0,
    consecutive_degraded: previous?.consecutive_degraded ?? 0,
    consecutive_successes: previous?.consecutive_successes ?? 0,
    last_notified_at: previous?.last_notified_at ?? null,
    down_since: previous?.down_since ?? null,
    slack_alert_ts: previous?.slack_alert_ts ?? null,
    maintenance_from: null,
    maintenance_to: null,
    maintenance_reason: null,
    last_check_slot: slotMs,
  };
  const threshold = Math.max(1, monitor.retry_threshold ?? 2);
  const maintenanceEnded = !inMaintenance && previous?.maintenance_from != null &&
    previous.maintenance_to != null && previous.maintenance_from <= ts;
  let kind: StateTransition['kind'] = null;
  let downDurationMs = 0;
  if (result.status === 'down') {
    next.consecutive_successes = 0;
    next.consecutive_failures += 1;
    next.consecutive_degraded = 0;
    if ((previousStatus !== 'down' || maintenanceEnded) && next.consecutive_failures >= threshold) {
      next.current_status = 'down';
      next.down_since = ts;
      next.last_notified_at = ts;
      next.slack_alert_ts = null;
      kind = 'down';
    }
  } else if (result.healthz_status === 'degraded') {
    next.consecutive_successes = 0;
    next.consecutive_failures = 0;
    next.consecutive_degraded += 1;
    if ((previousStatus === 'up' || (previousStatus === 'degraded' && maintenanceEnded)) &&
        next.consecutive_degraded >= threshold) {
      next.current_status = 'degraded';
      next.last_notified_at = ts;
      next.slack_alert_ts = null;
      kind = 'degraded';
    } else if (previousStatus === 'down') {
      next.current_status = 'degraded';
      downDurationMs = Math.max(0, ts - (previous?.down_since ?? ts));
      next.down_since = null;
      next.last_notified_at = ts;
      kind = 'partial';
      // Keep the open alert thread for the eventual complete recovery.
    }
  } else {
    next.consecutive_failures = 0;
    next.consecutive_degraded = 0;
    next.consecutive_successes += 1;
    if (previousStatus === 'down' || (previousStatus === 'degraded' && next.consecutive_successes >= threshold)) {
      next.current_status = 'up';
      downDurationMs = Math.max(0, ts - (previous?.down_since ?? ts));
      next.down_since = null;
      next.last_notified_at = ts;
      next.slack_alert_ts = null;
      kind = 'up';
    }
    if (next.current_status === 'up') next.consecutive_successes = 0;
  }
  if (result.maintenance && result.maintenance.to_ms > ts) {
    next.maintenance_from = result.maintenance.from_ms;
    next.maintenance_to = result.maintenance.to_ms;
    next.maintenance_reason = result.maintenance.reason;
  }
  if (inMaintenance) next.last_notified_at = previous?.last_notified_at ?? null;
  return {
    next,
    previousStatus,
    nextStatus: next.current_status,
    kind: inMaintenance ? null : kind,
    downDurationMs,
    previousSlackAlertTs: previous?.slack_alert_ts ?? null,
  };
}
