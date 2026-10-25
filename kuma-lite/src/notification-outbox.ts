import type { CheckResult, Env, Monitor } from './types';
import type { MonitorLease } from './monitor-execution';
import type { StateTransition } from './state-transition';

const DB_NOW = "(CAST(strftime('%s','now') AS INTEGER) * 1000)";
export const NOTIFICATION_DELIVERY_LEASE_MS = 30_000;
const MAX_EVENTS_PER_DRAIN = 8;
const MAX_DRAIN_MS = 25_000;

interface OutboxRow {
  id: number;
  monitor_id: number;
  scheduled_slot: number;
  config_revision: number;
  kind: NonNullable<StateTransition['kind']>;
  observed_at: number;
  result_json: string;
  transition_json: string;
  status: string;
}
interface DeliveryState {
  monitor_id: number;
  lease_token: string | null;
  lease_until: number;
  active_outbox_id: number | null;
  last_processed_slot: number;
  slack_alert_ts: string | null;
}

/** Include this statement after the accepted check and state writes in the same D1 batch. */
export function outboxInsertStatement(
  env: Env, monitor: Monitor, lease: MonitorLease, result: CheckResult, transition: StateTransition, ts: number,
): D1PreparedStatement | null {
  if (monitor.monitor_role === 'shadow' ||
    !['availability', 'diagnostic'].includes(monitor.monitor_role ?? 'availability')) return null;
  let kind = transition.kind;
  const repair = kind === null;
  if (repair) {
    // A settings revision can cancel a queued transition after the probe state
    // has already advanced. Only a fresh corroborating result may replace it.
    if (transition.nextStatus === 'down' && result.status === 'down') kind = 'down';
    else if (transition.nextStatus === 'degraded' && result.healthz_status === 'degraded') kind = 'degraded';
    else if (transition.nextStatus === 'up' && result.status === 'up' && result.healthz_status !== 'degraded') kind = 'up';
    else return null;
  }
  if (!kind) return null;
  const resultJson = JSON.stringify(result);
  const transitionJson = JSON.stringify({ ...transition, kind });
  if (resultJson.length > 32768 || transitionJson.length > 16384) throw new Error('Notification payload exceeds bounds');
  const repairParams: unknown[] = [];
  let repairCte = '';
  let repairGuard = '';
  let transitionExpression = '?';
  if (repair) {
    repairParams.push(monitor.id, lease.configRevision ?? 1, kind);
    let anchorGuard = '';
    if (kind !== 'up') {
      anchorGuard = 'AND observed_at >= ?';
      repairParams.push(transition.next.down_since ?? transition.next.last_notified_at ?? ts);
    }
    const safeJson = "CASE WHEN json_valid(transition_json) THEN transition_json ELSE '{}' END";
    repairCte = `WITH replacement AS (SELECT observed_at, transition_json FROM notification_outbox
      WHERE monitor_id=? AND config_revision<>? AND kind=? AND status='cancelled' ${anchorGuard}
        AND json_valid(transition_json)
      ORDER BY id DESC LIMIT 1) `;
    repairGuard = `AND EXISTS (SELECT 1 FROM replacement)
      AND NOT EXISTS (SELECT 1 FROM notification_outbox acknowledged WHERE acknowledged.monitor_id=?
        AND acknowledged.kind ${kind === 'up' ? "= 'up'" : "IN ('down','degraded')"}
        AND acknowledged.status IN ('pending','processing','sent','uncertain')
        AND acknowledged.observed_at >= (SELECT observed_at FROM replacement))`;
    if (kind === 'up') {
      repairGuard += ` AND EXISTS (SELECT 1 FROM notification_delivery_state delivered WHERE monitor_id=?
          AND (slack_alert_ts IS NOT NULL OR EXISTS (SELECT 1 FROM notification_outbox bad
            WHERE bad.monitor_id=delivered.monitor_id AND bad.kind IN ('down','degraded')
              AND bad.status IN ('sent','uncertain') AND bad.observed_at <= (SELECT observed_at FROM replacement)
              AND NOT EXISTS (SELECT 1 FROM notification_outbox resolved
                WHERE resolved.monitor_id=bad.monitor_id AND resolved.kind='up' AND resolved.status IN ('sent','uncertain')
                  AND resolved.observed_at>bad.observed_at))))
        AND (SELECT json_extract(${safeJson},'$.previousStatus') FROM replacement) IN ('down','degraded')`;
      transitionExpression = `json_set(?, '$.previousStatus',
        (SELECT json_extract(${safeJson},'$.previousStatus') FROM replacement), '$.downDurationMs',
        COALESCE((SELECT json_extract(${safeJson},'$.downDurationMs') FROM replacement),0))`;
    }
  }
  const repairGuardParams = repair ? [monitor.id, ...(kind === 'up' ? [monitor.id] : [])] : [];
  return env.DB.prepare(`${repairCte}INSERT OR IGNORE INTO notification_outbox
    (monitor_id, scheduled_slot, config_revision, kind, observed_at, result_json, transition_json, created_at)
    SELECT ?, ?, ?, ?, ?, ?, ${transitionExpression}, ${DB_NOW}
     WHERE changes()=1
       AND EXISTS (SELECT 1 FROM monitor_execution WHERE monitor_id=? AND claimed_slot=? AND lease_token=?)
       AND EXISTS (SELECT 1 FROM checks WHERE monitor_id=? AND scheduled_slot=? AND config_revision=?)
       AND EXISTS (SELECT 1 FROM monitor_state WHERE monitor_id=? AND last_check_slot=? AND config_revision=?)
       AND EXISTS (SELECT 1 FROM monitors WHERE id=? AND enabled=1 AND config_revision=?
         AND monitor_role IN ('availability','diagnostic')) ${repairGuard}`)
    .bind(...repairParams, monitor.id, lease.slotMs, lease.configRevision ?? 1, kind, ts, resultJson, transitionJson,
      monitor.id, lease.slotMs, lease.token, monitor.id, lease.slotMs, lease.configRevision ?? 1,
      monitor.id, lease.slotMs, lease.configRevision ?? 1, monitor.id, lease.configRevision ?? 1, ...repairGuardParams);

}

/** A provider may have accepted an unacknowledged send. Expired sends are terminal, never auto-retried. */
async function expireUnconfirmed(env: Env, monitorId: number): Promise<void> {
  await env.DB.prepare(`UPDATE notification_outbox SET status='uncertain', completed_at=${DB_NOW},
    last_error='delivery_lease_expired', lease_until=0
    WHERE monitor_id=? AND status='processing' AND lease_until<=${DB_NOW}`)
    .bind(monitorId).run();
}

async function claimDelivery(env: Env, monitorId: number, token: string): Promise<boolean> {
  const row = await env.DB.prepare(`INSERT INTO notification_delivery_state
      (monitor_id, lease_token, lease_until, last_processed_slot, slack_alert_ts)
    SELECT id, ?, ${DB_NOW}+?, -1,
      (SELECT slack_alert_ts FROM monitor_state WHERE monitor_id=monitors.id)
      FROM monitors WHERE id=?
    ON CONFLICT(monitor_id) DO UPDATE SET lease_token=excluded.lease_token,
      lease_until=excluded.lease_until, active_outbox_id=NULL
      WHERE notification_delivery_state.lease_until<=${DB_NOW}
    RETURNING monitor_id`)
    .bind(token, NOTIFICATION_DELIVERY_LEASE_MS, monitorId).first();
  return row !== null;
}

const OWNER = `EXISTS (SELECT 1 FROM notification_delivery_state WHERE monitor_id=? AND lease_token=? AND lease_until>${DB_NOW})`;

async function startEvent(env: Env, event: OutboxRow, token: string): Promise<boolean> {
  const results = await env.DB.batch([
    env.DB.prepare(`UPDATE notification_outbox SET status='processing', lease_token=?, lease_until=${DB_NOW}+?, attempts=attempts+1
      WHERE id=? AND status='pending' AND ${OWNER}
        AND NOT EXISTS (SELECT 1 FROM notification_outbox earlier WHERE earlier.monitor_id=notification_outbox.monitor_id
          AND earlier.status IN ('pending','processing') AND earlier.id<notification_outbox.id)`)
      .bind(token, NOTIFICATION_DELIVERY_LEASE_MS, event.id, event.monitor_id, token),
    env.DB.prepare(`UPDATE notification_delivery_state SET active_outbox_id=?, lease_until=${DB_NOW}+?
      WHERE monitor_id=? AND lease_token=? AND lease_until>${DB_NOW}
        AND EXISTS (SELECT 1 FROM notification_outbox WHERE id=? AND status='processing' AND lease_token=?)`)
      .bind(event.id, NOTIFICATION_DELIVERY_LEASE_MS, event.monitor_id, token, event.id, token),
  ]);
  return results[0].meta.changes === 1 && results[1].meta.changes === 1;
}

async function finishEvent(env: Env, event: OutboxRow, token: string,
  status: 'sent' | 'cancelled' | 'uncertain' | 'failed', error: string | null, thread: string | null): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(`WITH delivery_config AS (SELECT EXISTS (SELECT 1 FROM monitors
        WHERE id=? AND enabled=1 AND config_revision=? AND monitor_role IN ('availability','diagnostic')) AS current)
      UPDATE notification_outbox SET
        status=CASE WHEN ? IN ('sent','uncertain') AND NOT (SELECT current FROM delivery_config) THEN 'uncertain' ELSE ? END,
        completed_at=${DB_NOW},
        last_error=CASE WHEN ? IN ('sent','uncertain') AND NOT (SELECT current FROM delivery_config)
          THEN 'configuration_changed_during_delivery' ELSE ? END,
        slack_alert_ts=?, lease_until=0
      WHERE id=? AND status='processing' AND lease_token=? AND ${OWNER}`)
      .bind(event.monitor_id,event.config_revision,status,status,status,error,thread,event.id,token,event.monitor_id,token),
    env.DB.prepare(`UPDATE notification_delivery_state SET last_processed_slot=MAX(last_processed_slot,?),
        slack_alert_ts=?, active_outbox_id=NULL
      WHERE monitor_id=? AND lease_token=? AND lease_until>${DB_NOW}
        AND EXISTS (SELECT 1 FROM notification_outbox WHERE id=? AND lease_token=? AND status=?)
        AND EXISTS (SELECT 1 FROM monitors WHERE id=? AND enabled=1 AND config_revision=?
          AND monitor_role IN ('availability','diagnostic'))`)
      .bind(event.scheduled_slot,thread,event.monitor_id,token,event.id,token,status,event.monitor_id,event.config_revision),
  ]);
}

/** Recheck ownership and configuration immediately before issuing an external side effect. */
async function reserveDispatch(env: Env, event: OutboxRow, token: string): Promise<boolean> {
  const owned = await env.DB.prepare(`UPDATE notification_delivery_state SET lease_until=${DB_NOW}+?
    WHERE monitor_id=? AND lease_token=? AND lease_until>${DB_NOW} AND active_outbox_id=?
      AND EXISTS (SELECT 1 FROM notification_outbox WHERE id=? AND status='processing' AND lease_token=?)
      AND EXISTS (SELECT 1 FROM monitors WHERE id=? AND enabled=1 AND config_revision=?
        AND monitor_role IN ('availability','diagnostic')) RETURNING monitor_id`)
    .bind(NOTIFICATION_DELIVERY_LEASE_MS,event.monitor_id,token,event.id,event.id,token,event.monitor_id,event.config_revision).first();
  return owned !== null;
}

function readPayload(event: OutboxRow): { result: CheckResult; transition: StateTransition } {
  if (event.result_json.length > 32768 || event.transition_json.length > 16384) throw new Error('Invalid outbox payload');
  const result = JSON.parse(event.result_json) as CheckResult;
  const transition = JSON.parse(event.transition_json) as StateTransition;
  if (!result || !transition || transition.kind !== event.kind || transition.next?.monitor_id !== event.monitor_id ||
    transition.next.last_check_slot !== event.scheduled_slot ||
    (transition.next.config_revision ?? 1) !== event.config_revision ||
    !['up','down'].includes(result.status) || !['down','degraded','partial','up'].includes(event.kind)) {
    throw new Error('Invalid outbox payload');
  }
  return { result, transition };
}

async function drainMonitor(env: Env, monitorId: number): Promise<void> {
  const token = crypto.randomUUID();
  if (!(await claimDelivery(env, monitorId, token))) return;
  const started = Date.now();
  try {
    await expireUnconfirmed(env, monitorId);
    for (let i=0; i<MAX_EVENTS_PER_DRAIN && Date.now()-started<MAX_DRAIN_MS; i++) {
      const event = await env.DB.prepare(`SELECT * FROM notification_outbox
        WHERE monitor_id=? AND status='pending' ORDER BY scheduled_slot,id LIMIT 1`).bind(monitorId).first<OutboxRow>();
      if (!event || !(await startEvent(env, event, token))) return;
      const state = await env.DB.prepare('SELECT * FROM notification_delivery_state WHERE monitor_id=?')
        .bind(monitorId).first<DeliveryState>();
      let thread = state?.slack_alert_ts ?? null;
      const monitor = await env.DB.prepare('SELECT * FROM monitors WHERE id=?').bind(monitorId).first<Monitor>();
      if (!monitor || !monitor.enabled || (monitor.config_revision ?? 1)!==event.config_revision ||
        !['availability','diagnostic'].includes(monitor.monitor_role ?? 'availability')) {
        await finishEvent(env, event, token, 'cancelled', 'configuration_changed', thread);
        continue;
      }
      let payload: ReturnType<typeof readPayload>;
      try { payload = readPayload(event); }
      catch {
        await finishEvent(env, event, token, 'failed', 'invalid_payload', thread);
        continue;
      }
      if (!thread && state?.last_processed_slot === -1 && (event.kind === 'partial' || event.kind === 'up')) {
        const legacyThread = payload.transition.previousSlackAlertTs;
        if (typeof legacyThread === 'string' && legacyThread.length > 0 && legacyThread.length <= 128) thread=legacyThread;
      }
      const transition = { ...payload.transition, previousSlackAlertTs: thread };
      if (event.kind==='down' || event.kind==='degraded') thread=null;
      let status: 'sent' | 'uncertain' | 'failed' = 'sent';
      let errorCode: string | null = null;
      try {
        // Lazy loading also keeps probe persistence independent of notification adapters.
        const { notifyTransition } = await import('./state-notifications');
        if (!(await reserveDispatch(env,event,token))) {
          await finishEvent(env,event,token,'cancelled','ownership_or_configuration_changed',thread);
          return;
        }
        const sent = await notifyTransition(env, monitor, payload.result, transition, event.observed_at);
        if (event.kind==='down' || event.kind==='degraded') thread=sent?.slackAlertTs ?? null;
      } catch (error) {
        const problem = error as { code?: string; slackAlertTs?: string | null };
        status = problem?.code==='not_configured' ? 'failed' : 'uncertain';
        errorCode = status==='failed' ? 'not_configured' : 'delivery_unconfirmed';
        if ((event.kind==='down' || event.kind==='degraded') && typeof problem?.slackAlertTs==='string') thread=problem.slackAlertTs;
      }
      if (event.kind==='up') thread=null;
      await finishEvent(env, event, token, status, errorCode, thread);
      console.log({ event:'notification_outbox_delivery', monitor_id:monitorId, outbox_id:event.id,
        scheduled_slot:event.scheduled_slot, config_revision:event.config_revision, attempted_status:status });
    }
  } finally {
    await env.DB.prepare(`UPDATE notification_delivery_state SET lease_until=0,active_outbox_id=NULL
      WHERE monitor_id=? AND lease_token=?`).bind(monitorId, token).run();
  }
}

/** Delivery ownership is separate from monitor_execution, so slow sends never hold a probe lease. */
export async function drainNotificationOutbox(env: Env, monitorId?: number): Promise<void> {
  if (monitorId !== undefined) return drainMonitor(env, monitorId);
  const pending = await env.DB.prepare(`SELECT DISTINCT monitor_id FROM notification_outbox
    WHERE status IN ('pending','processing') ORDER BY monitor_id LIMIT 16`).all<{monitor_id:number}>();
  const outcomes = await Promise.allSettled((pending.results ?? []).map(row=>drainMonitor(env,row.monitor_id)));
  outcomes.forEach((outcome,index)=>{
    if (outcome.status==='rejected') console.error({ event:'notification_outbox_incomplete',
      monitor_id:pending.results?.[index]?.monitor_id });
  });
}
