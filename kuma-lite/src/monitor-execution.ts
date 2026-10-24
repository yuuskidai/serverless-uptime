import type { CheckResult, Env, Monitor } from './types';
import type { OrderedMonitorState, StateTransition } from './state-transition';

// Two 30s probes plus persistence/notification time. No isolate-local lock:
// every ownership check is serialized by D1 and uses D1's clock.
export const LEASE_MS = 120_000;
export const NOTIFICATION_LEASE_MS = 30_000;
const DB_NOW_MS = `(CAST(strftime('%s', 'now') AS INTEGER) * 1000)`;

export interface MonitorLease {
  monitorId: number;
  slotMs: number;
  token: string;
}

export function scheduledSlot(scheduledTime: number): number {
  if (!Number.isSafeInteger(scheduledTime) || scheduledTime < 0) {
    throw new Error('Invalid monitor scheduled time');
  }
  return Math.floor(scheduledTime / 60_000) * 60_000;
}

/**
 * A scheduled slot is attempted at most once per monitor, even after release
 * or a crash. An expired runner can be replaced by a strictly newer slot.
 * Late delivery of an older event never advances the claim backwards.
 */
export async function claimMonitorSlot(
  env: Env,
  monitorId: number,
  slotMs: number,
): Promise<MonitorLease | null> {
  if (scheduledSlot(slotMs) !== slotMs) throw new Error('Invalid monitor slot');
  const token = crypto.randomUUID();
  const claimed = await env.DB.prepare(
    `INSERT INTO monitor_execution (monitor_id, claimed_slot, lease_token, lease_until)
     SELECT id, ?, ?, ${DB_NOW_MS} + ? FROM monitors WHERE id = ? AND enabled = 1
       AND ? > COALESCE((SELECT last_check_slot FROM monitor_state WHERE monitor_id = monitors.id), -1)
     ON CONFLICT(monitor_id) DO UPDATE SET
       claimed_slot = excluded.claimed_slot,
       lease_token = excluded.lease_token,
       lease_until = excluded.lease_until
     WHERE monitor_execution.claimed_slot < excluded.claimed_slot
       AND monitor_execution.lease_until <= ${DB_NOW_MS}
     RETURNING monitor_id`,
  ).bind(slotMs, token, LEASE_MS, monitorId, slotMs).first<{ monitor_id: number }>();
  return claimed ? { monitorId, slotMs, token } : null;
}

const LEASE_OWNER = `EXISTS (
  SELECT 1 FROM monitor_execution
   WHERE monitor_id = ? AND claimed_slot = ? AND lease_token = ?
)`;
const ACTIVE_LEASE = `EXISTS (
  SELECT 1 FROM monitor_execution
   WHERE monitor_id = ? AND claimed_slot = ? AND lease_token = ?
     AND lease_until > ${DB_NOW_MS}
)`;
const EXPECTED_STATE = `COALESCE((SELECT last_check_slot FROM monitor_state WHERE monitor_id = ?), -1) = ?`;

export async function readMonitorState(env: Env, monitorId: number): Promise<OrderedMonitorState | null> {
  return env.DB.prepare('SELECT * FROM monitor_state WHERE monitor_id = ?')
    .bind(monitorId).first<OrderedMonitorState>();
}

/**
 * D1 batch is one transaction. The first INSERT is the linearization point:
 * it requires a live lease and the expected state. The state write requires
 * that inserted receipt and the same owner/CAS, without rechecking the clock
 * between statements (expiry at that boundary must not leave an orphan check).
 * No other owner can interleave in the transaction. An expired/delayed owner
 * cannot append a stale check row or advance state.
 */
export async function commitMonitorResult(
  env: Env,
  monitor: Monitor,
  lease: MonitorLease,
  result: CheckResult,
  previous: OrderedMonitorState | null,
  transition: StateTransition,
  ts: number,
  inMaintenance: boolean,
): Promise<boolean> {
  const expectedSlot = previous?.last_check_slot ?? -1;
  if (monitor.id !== lease.monitorId || transition.next.monitor_id !== monitor.id ||
      expectedSlot >= lease.slotMs || transition.next.last_check_slot !== lease.slotMs) return false;
  const guardValues = [lease.monitorId, lease.slotMs, lease.token, lease.monitorId, expectedSlot];
  const next = transition.next;
  const writes = await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO checks (
         monitor_id, status, status_code, latency_ms, error, ts,
         healthz_status, healthz_reason, healthz_components, healthz_version,
         used_fallback, in_maintenance, scheduled_slot, probe_trace_json
       )
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        WHERE ${ACTIVE_LEASE} AND ${EXPECTED_STATE}`,
    ).bind(
      monitor.id, result.status, result.status_code, result.latency_ms, result.error, ts,
      result.healthz_status, result.healthz_reason, result.healthz_components, result.healthz_version,
      result.used_fallback ? 1 : 0, inMaintenance ? 1 : 0, lease.slotMs, result.probe_trace_json,
      ...guardValues,
    ),
    env.DB.prepare(
      `INSERT INTO monitor_state (
         monitor_id, current_status, consecutive_failures, consecutive_degraded,
         last_notified_at, down_since, slack_alert_ts,
         maintenance_from, maintenance_to, maintenance_reason, last_check_slot, consecutive_successes
       )
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        WHERE ${LEASE_OWNER} AND ${EXPECTED_STATE}
          AND EXISTS (SELECT 1 FROM checks WHERE monitor_id = ? AND scheduled_slot = ?)
       ON CONFLICT(monitor_id) DO UPDATE SET
         current_status = excluded.current_status,
         consecutive_failures = excluded.consecutive_failures,
         consecutive_degraded = excluded.consecutive_degraded,
         last_notified_at = excluded.last_notified_at,
         down_since = excluded.down_since,
         slack_alert_ts = excluded.slack_alert_ts,
         maintenance_from = excluded.maintenance_from,
         maintenance_to = excluded.maintenance_to,
         maintenance_reason = excluded.maintenance_reason,
         last_check_slot = excluded.last_check_slot,
         consecutive_successes = excluded.consecutive_successes
       WHERE monitor_state.last_check_slot < excluded.last_check_slot`,
    ).bind(
      next.monitor_id, next.current_status, next.consecutive_failures, next.consecutive_degraded,
      next.last_notified_at, next.down_since, next.slack_alert_ts,
      next.maintenance_from, next.maintenance_to, next.maintenance_reason, next.last_check_slot, next.consecutive_successes,
      ...guardValues,
      lease.monitorId, lease.slotMs,
    ),
  ]);
  return writes[0].meta.changes === 1 && writes[1].meta.changes === 1;
}

/** Fence notification dispatch and its later thread metadata against replacement. */
export async function reserveTransitionNotification(env: Env, lease: MonitorLease): Promise<boolean> {
  const owned = await env.DB.prepare(
    `UPDATE monitor_execution SET lease_until = MAX(lease_until, ${DB_NOW_MS} + ?)
      WHERE monitor_id = ? AND claimed_slot = ? AND lease_token = ?
        AND lease_until > ${DB_NOW_MS}
        AND EXISTS (SELECT 1 FROM monitor_state WHERE monitor_id = ? AND last_check_slot = ?)
      RETURNING 1 AS owned`,
  ).bind(NOTIFICATION_LEASE_MS, lease.monitorId, lease.slotMs, lease.token, lease.monitorId, lease.slotMs)
    .first<{ owned: number }>();
  return owned !== null;
}

export async function saveAlertThread(env: Env, lease: MonitorLease, slackAlertTs: string): Promise<void> {
  await env.DB.prepare(
    `UPDATE monitor_state SET slack_alert_ts = ?
      WHERE monitor_id = ? AND last_check_slot = ? AND ${ACTIVE_LEASE}`,
  ).bind(slackAlertTs, lease.monitorId, lease.slotMs, lease.monitorId, lease.slotMs, lease.token).run();
}

export async function releaseMonitorSlot(env: Env, lease: MonitorLease): Promise<void> {
  await env.DB.prepare(
    `UPDATE monitor_execution SET lease_until = 0
      WHERE monitor_id = ? AND claimed_slot = ? AND lease_token = ?`,
  ).bind(lease.monitorId, lease.slotMs, lease.token).run();
}
