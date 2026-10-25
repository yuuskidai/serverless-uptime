import type { CheckResult, Env, Monitor } from './types';
import type { OrderedMonitorState, StateTransition } from './state-transition';
import { outboxInsertStatement } from './notification-outbox';

// Two 30s probes plus persistence/notification time. No isolate-local lock:
// every ownership check is serialized by D1 and uses D1's clock.
export const LEASE_MS = 120_000;
export const NOTIFICATION_LEASE_MS = 30_000;
const DB_NOW_MS = `(CAST(strftime('%s', 'now') AS INTEGER) * 1000)`;

export interface MonitorLease {
  monitorId: number;
  slotMs: number;
  token: string;
  configRevision?: number;
  attemptId?: string;
  auditFailure?: AttemptFailure;
}

export interface ClaimTiming {
  scheduledTime: number;
  receivedAt: number;
  runId?: string;
}

export interface MonitorAttemptDecision {
  attempt_id: string;
  decision: string;
  reason: string;
  observed_claimed_slot: number | null;
  observed_lease_until: number | null;
  observed_last_check_slot: number | null;
  observed_revision: number | null;
  observed_enabled: number | null;
}

export const D1_READ_BUDGET_MS = 5_000;

/** Read-only calls may be abandoned safely. Writes are never raced/retried. */
export async function withReadDeadline<T>(operation: Promise<T>, timeoutMs = D1_READ_BUDGET_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Monitoring database read deadline exceeded')), timeoutMs);
    })]);
  } finally { if (timer !== undefined) clearTimeout(timer); }
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
  configRevision = 1,
  timing: ClaimTiming = { scheduledTime: slotMs, receivedAt: Date.now() },
): Promise<MonitorLease | null> {
  return (await claimMonitorSlotDecision(env, monitorId, slotMs, configRevision, timing)).lease;
}

/** The decision snapshot and the conditional ownership write share one transaction. */
export async function claimMonitorSlotDecision(
  env: Env,
  monitorId: number,
  slotMs: number,
  configRevision = 1,
  timing: ClaimTiming = { scheduledTime: slotMs, receivedAt: Date.now() },
): Promise<{ lease: MonitorLease | null; attempt: MonitorAttemptDecision }> {
  if (scheduledSlot(slotMs) !== slotMs) throw new Error('Invalid monitor slot');
  if (!Number.isSafeInteger(configRevision) || configRevision < 1) throw new Error('Invalid monitor revision');
  if (scheduledSlot(timing.scheduledTime) !== slotMs || !Number.isSafeInteger(timing.receivedAt) || timing.receivedAt < 0) {
    throw new Error('Invalid monitor attempt timing');
  }
  const token = crypto.randomUUID();
  const writes = await env.DB.batch([
    env.DB.prepare(`WITH requested AS (
       SELECT ? AS monitor_id, ? AS scheduled_slot, ? AS scheduled_time, ? AS received_at,
              ? AS config_revision, ? AS attempt_id, ? AS run_id
     ), snapshot AS (
       SELECT r.*, m.id AS target_id, m.enabled, m.config_revision AS current_revision,
              COALESCE(m.monitor_role, 'unknown') AS monitor_role,
              COALESCE(m.probe_transport, 'unknown') AS probe_transport,
              e.claimed_slot, e.lease_until, s.last_check_slot
         FROM requested r LEFT JOIN monitors m ON m.id = r.monitor_id
         LEFT JOIN monitor_execution e ON e.monitor_id = r.monitor_id
         LEFT JOIN monitor_state s ON s.monitor_id = r.monitor_id
     ), classified AS (
       SELECT *, CASE
         WHEN target_id IS NULL THEN 'monitor_missing'
         WHEN enabled <> 1 OR enabled IS NULL THEN 'monitor_disabled'
         WHEN current_revision <> config_revision THEN 'configuration_changed'
         WHEN COALESCE(last_check_slot, -1) >= scheduled_slot THEN 'already_recorded'
         WHEN claimed_slot >= scheduled_slot THEN 'superseded_slot'
         WHEN lease_until > ${DB_NOW_MS} THEN 'lease_busy'
         ELSE 'claimable' END AS claim_reason
       FROM snapshot
     ) INSERT INTO monitor_attempts (
       attempt_id,run_id,monitor_id,scheduled_time,scheduled_slot,received_at,config_revision,
       monitor_role,probe_transport,decision,reason,observed_claimed_slot,observed_lease_until,
       observed_last_check_slot,observed_revision,observed_enabled,observed_at,finished_at
     ) SELECT attempt_id,run_id,monitor_id,scheduled_time,scheduled_slot,received_at,config_revision,
       monitor_role,probe_transport,CASE WHEN claim_reason='claimable' THEN 'claimable' ELSE 'denied' END,
       claim_reason,claimed_slot,lease_until,last_check_slot,current_revision,enabled,${DB_NOW_MS},
       CASE WHEN claim_reason = 'claimable' THEN NULL ELSE ${DB_NOW_MS} END
       FROM classified`).bind(monitorId, slotMs, timing.scheduledTime, timing.receivedAt, configRevision, token,
         timing.runId ?? null),
    env.DB.prepare(
    `INSERT INTO monitor_execution (monitor_id, claimed_slot, lease_token, lease_until)
     SELECT id, ?, ?, ${DB_NOW_MS} + ? FROM monitors WHERE id = ? AND enabled = 1 AND config_revision = ?
       AND EXISTS (SELECT 1 FROM monitor_attempts WHERE attempt_id = ? AND decision = 'claimable')
       AND ? > COALESCE((SELECT last_check_slot FROM monitor_state WHERE monitor_id = monitors.id), -1)
     ON CONFLICT(monitor_id) DO UPDATE SET
       claimed_slot = excluded.claimed_slot,
       lease_token = excluded.lease_token,
       lease_until = excluded.lease_until
     WHERE monitor_execution.claimed_slot < excluded.claimed_slot
       AND monitor_execution.lease_until <= ${DB_NOW_MS}
    `,
    ).bind(slotMs, token, LEASE_MS, monitorId, configRevision, token, slotMs),
    env.DB.prepare(`UPDATE monitor_attempts SET
      decision = CASE WHEN EXISTS (SELECT 1 FROM monitor_execution WHERE monitor_id = ? AND claimed_slot = ? AND lease_token = ?)
        THEN 'claimed' ELSE 'denied' END,
      reason = CASE WHEN EXISTS (SELECT 1 FROM monitor_execution WHERE monitor_id = ? AND claimed_slot = ? AND lease_token = ?)
        THEN 'claimed' ELSE 'claim_guard_rejected' END,
      claimed_at = CASE WHEN EXISTS (SELECT 1 FROM monitor_execution WHERE monitor_id = ? AND claimed_slot = ? AND lease_token = ?)
        THEN ${DB_NOW_MS} ELSE NULL END,
      finished_at = CASE WHEN EXISTS (SELECT 1 FROM monitor_execution WHERE monitor_id = ? AND claimed_slot = ? AND lease_token = ?)
        THEN NULL ELSE ${DB_NOW_MS} END
      WHERE attempt_id = ? AND decision = 'claimable'`).bind(
      monitorId, slotMs, token, monitorId, slotMs, token, monitorId, slotMs, token, monitorId, slotMs, token, token),
    env.DB.prepare(`SELECT attempt_id,decision,reason,observed_claimed_slot,observed_lease_until,
      observed_last_check_slot,observed_revision,observed_enabled FROM monitor_attempts WHERE attempt_id = ?`).bind(token),
  ]).catch(error => {
    console.error({ event: 'monitor_claim_unacknowledged', monitor_id: monitorId,
      scheduled_slot: slotMs, scheduled_time: timing.scheduledTime, received_at: timing.receivedAt,
      attempt_id: token, config_revision: configRevision });
    throw error;
  });
  const attempt = writes[3].results?.[0] as unknown as MonitorAttemptDecision | undefined;
  if (!attempt) throw new Error('Monitor attempt decision was not acknowledged');
  const lease = attempt.decision === 'claimed' ? { monitorId, slotMs, token, configRevision, attemptId: token } : null;
  return { lease, attempt };
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
const CURRENT_CONFIG = `EXISTS (SELECT 1 FROM monitors WHERE id = ? AND enabled = 1 AND config_revision = ?)`;

export async function readMonitorState(env: Env, monitorId: number): Promise<OrderedMonitorState | null> {
  return withReadDeadline(env.DB.prepare('SELECT * FROM monitor_state WHERE monitor_id = ?')
    .bind(monitorId).first<OrderedMonitorState>());
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
      expectedSlot >= lease.slotMs || transition.next.last_check_slot !== lease.slotMs ||
      (monitor.config_revision ?? 1) !== (lease.configRevision ?? 1)) {
    lease.auditFailure = { phase:'commit',reason:'local_precondition',decision:'commit_rejected' };
    return false;
  }
  const guardValues = [lease.monitorId, lease.slotMs, lease.token, lease.monitorId, expectedSlot];
  const revisionValues = [lease.monitorId, lease.configRevision ?? 1];
  const next = transition.next;
  let transport = monitor.probe_transport === 'public_fetch' ? 'public_fetch' :
    monitor.probe_transport === 'service_binding' || monitor.service_binding ? 'service_binding' : 'public_fetch';
  try {
    const trace = JSON.parse(result.probe_trace_json)[0];
    if (trace?.transport === 'public_fetch' || trace?.transport === 'service_binding') transport = trace.transport;
  } catch { /* Legacy results may not contain a trace. */ }
  const statements = [
    env.DB.prepare(
      `INSERT INTO checks (
         monitor_id, status, status_code, latency_ms, error, ts,
         healthz_status, healthz_reason, healthz_components, healthz_version,
         used_fallback, in_maintenance, scheduled_slot, probe_trace_json, config_revision, monitor_role, probe_transport
       )
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        WHERE ${ACTIVE_LEASE} AND ${EXPECTED_STATE} AND ${CURRENT_CONFIG}`,
    ).bind(
      monitor.id, result.status, result.status_code, result.latency_ms, result.error, ts,
      result.healthz_status, result.healthz_reason, result.healthz_components, result.healthz_version,
      result.used_fallback ? 1 : 0, inMaintenance ? 1 : 0, lease.slotMs, result.probe_trace_json,
      lease.configRevision ?? 1, monitor.monitor_role ?? 'availability', transport,
      ...guardValues, ...revisionValues,
    ),
    env.DB.prepare(
      `INSERT INTO monitor_state (
         monitor_id, current_status, consecutive_failures, consecutive_degraded,
         last_notified_at, down_since, slack_alert_ts,
         maintenance_from, maintenance_to, maintenance_reason, last_check_slot, consecutive_successes, config_revision
       )
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        WHERE ${LEASE_OWNER} AND ${EXPECTED_STATE} AND ${CURRENT_CONFIG}
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
         consecutive_successes = excluded.consecutive_successes,
         config_revision = excluded.config_revision
       WHERE monitor_state.last_check_slot < excluded.last_check_slot`,
    ).bind(
      next.monitor_id, next.current_status, next.consecutive_failures, next.consecutive_degraded,
      next.last_notified_at, next.down_since, next.slack_alert_ts,
      next.maintenance_from, next.maintenance_to, next.maintenance_reason, next.last_check_slot, next.consecutive_successes,
      lease.configRevision ?? 1,
      ...guardValues, ...revisionValues,
      lease.monitorId, lease.slotMs,
    ),
  ];
  const notification = outboxInsertStatement(env, monitor, lease, result, transition, ts);
  if (notification) statements.push(notification);
  statements.push(env.DB.prepare(`UPDATE monitor_attempts SET
    decision = CASE WHEN EXISTS (SELECT 1 FROM checks c JOIN monitor_state s ON s.monitor_id=c.monitor_id
      WHERE c.monitor_id=? AND c.scheduled_slot=? AND c.config_revision=?
        AND s.last_check_slot=? AND s.config_revision=?) THEN 'committed' ELSE 'commit_rejected' END,
    reason = CASE
      WHEN EXISTS (SELECT 1 FROM checks c JOIN monitor_state s ON s.monitor_id=c.monitor_id
        WHERE c.monitor_id=? AND c.scheduled_slot=? AND c.config_revision=?
          AND s.last_check_slot=? AND s.config_revision=?) THEN 'completed'
      WHEN NOT EXISTS (SELECT 1 FROM monitors WHERE id=?) THEN 'monitor_missing'
      WHEN EXISTS (SELECT 1 FROM monitors WHERE id=? AND (enabled<>1 OR enabled IS NULL)) THEN 'monitor_disabled'
      WHEN EXISTS (SELECT 1 FROM monitors WHERE id=? AND config_revision<>?) THEN 'configuration_changed'
      WHEN NOT EXISTS (SELECT 1 FROM monitor_execution WHERE monitor_id=? AND claimed_slot=? AND lease_token=?) THEN 'ownership_lost'
      WHEN EXISTS (SELECT 1 FROM monitor_execution WHERE monitor_id=? AND lease_until<=${DB_NOW_MS}) THEN 'lease_expired'
      WHEN COALESCE((SELECT last_check_slot FROM monitor_state WHERE monitor_id=?),-1)<>? THEN 'state_changed'
      ELSE 'write_guard_rejected' END,
    probe_started_at = ?,
    committed_at = CASE WHEN EXISTS (SELECT 1 FROM checks c JOIN monitor_state s ON s.monitor_id=c.monitor_id
      WHERE c.monitor_id=? AND c.scheduled_slot=? AND c.config_revision=?
        AND s.last_check_slot=? AND s.config_revision=?) THEN ${DB_NOW_MS} ELSE NULL END
    WHERE attempt_id=?`).bind(
    monitor.id, lease.slotMs, lease.configRevision ?? 1, lease.slotMs, lease.configRevision ?? 1,
    monitor.id, lease.slotMs, lease.configRevision ?? 1, lease.slotMs, lease.configRevision ?? 1,
    monitor.id, monitor.id, monitor.id, lease.configRevision ?? 1,
    lease.monitorId, lease.slotMs, lease.token, lease.monitorId, lease.monitorId, expectedSlot, ts,
    monitor.id, lease.slotMs, lease.configRevision ?? 1, lease.slotMs, lease.configRevision ?? 1,
    lease.attemptId ?? lease.token,
  ));
  const writes = await env.DB.batch(statements);
  return writes[0].meta.changes === 1 && writes[1].meta.changes === 1;
}

export type AttemptPhase = 'claim' | 'state' | 'probe' | 'commit' | 'release';
export type AttemptTimings = Partial<Record<'schema_ms' | 'offset_ms' | 'select_ms' | 'lease_ms' | 'state_ms' |
  'probe_ms' | 'commit_ms', number>>;
export interface AttemptFailure {
  phase: AttemptPhase;
  reason: 'operation_failed' | 'local_precondition';
  decision?: 'error' | 'commit_rejected';
  probeStartedAt?: number | null;
}

export const AUDIT_WAIT_MS = 5_000;

async function boundedAttemptAudit(operation: Promise<unknown>, lease: MonitorLease,
  phase: AttemptPhase): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([operation,new Promise<never>((_resolve,reject)=>{
      timer=setTimeout(()=>reject(new Error('audit_deadline')),AUDIT_WAIT_MS);
    })]);
  } catch {
    console.error({ event:'monitor_audit_unconfirmed',monitor_id:lease.monitorId,
      scheduled_slot:lease.slotMs,attempt_id:lease.attemptId ?? lease.token,phase });
  } finally { if(timer!==undefined)clearTimeout(timer); }
}

function timingsJson(timings: AttemptTimings): string {
  const safe: Record<string, number> = {};
  for (const key of ['schema_ms','offset_ms','select_ms','lease_ms','state_ms','probe_ms','commit_ms'] as const) {
    const value = timings[key];
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) safe[key] = Math.min(value, Number.MAX_SAFE_INTEGER);
  }
  return JSON.stringify(safe);
}

/** Best-effort error evidence never relabels a committed/acknowledgment-lost result. */
export async function recordAttemptFailure(env: Env, lease: MonitorLease, phase: AttemptPhase,
  timings: AttemptTimings, reason = 'operation_failed', probeStartedAt: number | null = null): Promise<void> {
  try {
    await boundedAttemptAudit(env.DB.prepare(`UPDATE monitor_attempts SET
      decision=CASE WHEN decision='committed' THEN decision ELSE 'error' END,
      reason=CASE WHEN decision='committed' THEN reason ELSE ? END,error_phase=?,
      probe_started_at=COALESCE(probe_started_at,?),timings_json=?,finished_at=${DB_NOW_MS}
      WHERE attempt_id=? AND decision NOT IN ('commit_rejected','denied')`)
      .bind(reason === 'local_precondition' ? reason : 'operation_failed', phase, probeStartedAt,
        timingsJson(timings), lease.attemptId ?? lease.token).run(),lease,phase);
  } catch {
    console.error({ event: 'monitor_audit_unavailable', monitor_id: lease.monitorId,
      scheduled_slot: lease.slotMs, attempt_id: lease.attemptId ?? lease.token, phase });
  }
}

/** Fence notification dispatch and its later thread metadata against replacement. */
export async function reserveTransitionNotification(env: Env, lease: MonitorLease): Promise<boolean> {
  const owned = await env.DB.prepare(
    `UPDATE monitor_execution SET lease_until = MAX(lease_until, ${DB_NOW_MS} + ?)
      WHERE monitor_id = ? AND claimed_slot = ? AND lease_token = ?
        AND lease_until > ${DB_NOW_MS}
        AND EXISTS (SELECT 1 FROM monitor_state WHERE monitor_id = ? AND last_check_slot = ?)
        AND ${CURRENT_CONFIG}
      RETURNING 1 AS owned`,
  ).bind(NOTIFICATION_LEASE_MS, lease.monitorId, lease.slotMs, lease.token, lease.monitorId, lease.slotMs,
    lease.monitorId, lease.configRevision ?? 1)
    .first<{ owned: number }>();
  return owned !== null;
}

export async function saveAlertThread(env: Env, lease: MonitorLease, slackAlertTs: string): Promise<void> {
  await env.DB.prepare(
    `UPDATE monitor_state SET slack_alert_ts = ?
      WHERE monitor_id = ? AND last_check_slot = ? AND ${ACTIVE_LEASE} AND ${CURRENT_CONFIG}`,
  ).bind(slackAlertTs, lease.monitorId, lease.slotMs, lease.monitorId, lease.slotMs, lease.token,
    lease.monitorId, lease.configRevision ?? 1).run();
}

export async function releaseMonitorSlot(env: Env, lease: MonitorLease, timings: AttemptTimings = {},
  failure: AttemptFailure | undefined = lease.auditFailure): Promise<void> {
  let released: D1Result;
  try {
    // The ownership mutation is deliberately independent of diagnostic writes.
    // A stalled/failed audit must never roll back or postpone this unlock.
    released = await env.DB.prepare(`UPDATE monitor_execution SET lease_until = 0
      WHERE monitor_id = ? AND claimed_slot = ? AND lease_token = ?`,
    ).bind(lease.monitorId, lease.slotMs, lease.token).run();
  } catch(error) {
    try {
      await boundedAttemptAudit(env.DB.prepare(`UPDATE monitor_attempts SET release_outcome='unconfirmed',
        error_phase='release',timings_json=?,finished_at=${DB_NOW_MS}
        WHERE attempt_id=? AND released_at IS NULL`).bind(timingsJson(timings),lease.attemptId ?? lease.token).run(),lease,'release');
    } catch { /* Ownership acknowledgement remains unknown; never retry the mutation. */ }
    throw error;
  }
  try {
    await boundedAttemptAudit(env.DB.prepare(`UPDATE monitor_attempts SET
      released_at=COALESCE(released_at,${DB_NOW_MS}),finished_at=${DB_NOW_MS},
      release_outcome=CASE WHEN released_at IS NULL THEN ? ELSE release_outcome END,
      timings_json=?,error_phase=COALESCE(?,error_phase),probe_started_at=COALESCE(probe_started_at,?),
      decision=CASE WHEN ? IS NOT NULL AND decision NOT IN('committed','commit_rejected','denied') THEN ? ELSE decision END,
      reason=CASE WHEN ? IS NOT NULL AND decision NOT IN('committed','commit_rejected','denied') THEN ? ELSE reason END
      WHERE attempt_id=?`)
      .bind(released.meta.changes===1?'released':'ownership_lost',timingsJson(timings),failure?.phase ?? null,
        failure?.probeStartedAt ?? null,failure?.phase ?? null,failure?.decision ?? 'error',
        failure?.phase ?? null,failure?.reason ?? 'operation_failed',lease.attemptId ?? lease.token).run(),lease,'release');
  } catch {
    console.error({event:'monitor_audit_unavailable',monitor_id:lease.monitorId,
      scheduled_slot:lease.slotMs,attempt_id:lease.attemptId ?? lease.token,phase:'release'});
  }
}
