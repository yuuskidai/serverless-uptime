import type { CheckResult, ComponentHealth, Env, Monitor } from './types';
import { type IncidentDetail, notifyDegraded, notifyDown, notifyUp, notifyPartialRecovery, notifyInternalPath, NotificationDeliveryError } from './notifier';
import { enqueueRca } from './rca';
import type { StateTransition } from './state-transition';
import { isAvailabilityMonitor } from './monitor-policy';

/** Called by the independently leased outbox after the observation committed. */
export async function notifyTransition(
  env: Env,
  monitor: Monitor,
  result: CheckResult,
  transition: StateTransition,
  ts: number,
): Promise<{ slackAlertTs: string | null } | null> {
  if (!transition.kind || monitor.monitor_role === 'shadow') return null;
  if (!isAvailabilityMonitor(monitor) && monitor.monitor_role !== 'diagnostic') return null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let active = true;
  let acknowledgedThread: string | null = null;
  try {
    return await Promise.race([
      deliverTransition(env, monitor, result, transition, ts, () => active, thread=>{acknowledgedThread=thread;}),
      new Promise<never>((_resolve, reject) => { timer = setTimeout(() => {
        console.warn('monitor notification deadline exceeded', monitor.id);
        reject(new NotificationDeliveryError('uncertain',acknowledgedThread));
      }, 18_000); }),
    ]);
  } finally { active = false; if (timer !== undefined) clearTimeout(timer); }
}

async function deliverTransition(
  env: Env, monitor: Monitor, result: CheckResult, transition: StateTransition, ts: number, active: () => boolean,
  acknowledged: (thread: string | null)=>void,
): Promise<{ slackAlertTs: string | null } | null> {
  if (monitor.monitor_role === 'diagnostic') {
    return notifyInternalPath(env, monitor, buildIncidentDetail(result, '内部診断の状態が変化しました', ts),
      transition.kind!, transition.previousSlackAlertTs);
  }
  if (transition.kind === 'down' || transition.kind === 'degraded') {
    const detail = buildIncidentDetail(result, transition.kind === 'down' ? 'unknown error' : '一部の機能が不調', ts);
    const sent = transition.kind === 'down'
      ? await notifyDown(env, monitor, detail)
      : await notifyDegraded(env, monitor, detail);
    acknowledged(sent.slackAlertTs);
    // Analysis is supplementary. A failed queue publish must not relabel an
    // acknowledged alert as undelivered or cause the alert to be replayed.
    if (sent.slackAlertTs && active()) {
      try {
        await enqueueRca(env, {
          monitorId: monitor.id,
          configRevision: monitor.config_revision ?? 1,
          alertTs: sent.slackAlertTs,
          downSince: ts,
          reason: detail.reason,
          kind: transition.kind,
        });
      } catch { console.warn('notification RCA enqueue failed', monitor.id); }
    }
    return sent;
  }
  if (transition.kind === 'partial') {
    await notifyPartialRecovery(env, monitor, buildIncidentDetail(result, '遅延または一部不調が継続', ts),
      transition.downDurationMs, transition.previousSlackAlertTs);
  } else {
    await notifyUp(env, monitor, transition.downDurationMs, transition.previousSlackAlertTs,
      transition.previousStatus === 'degraded' ? 'degraded' : 'down', ts);
  }
  return null;
}

function buildIncidentDetail(result: CheckResult, fallbackReason: string, observedAt: number): IncidentDetail {
  const reason = result.healthz_reason ?? result.error ?? fallbackReason;
  let unhealthy: ComponentHealth[] = [];
  if (result.healthz_components) {
    try {
      const parsed = JSON.parse(result.healthz_components);
      if (Array.isArray(parsed)) {
        unhealthy = parsed.filter(
          (c): c is ComponentHealth =>
            c &&
            typeof c === 'object' &&
            typeof c.name === 'string' &&
            (c.status === 'down' || c.status === 'degraded'),
        );
      }
    } catch {
      // Stored JSON should always parse — sanitiseComponents writes it —
      // but if it ever doesn't, omit the components rather than crash
      // the alert path.
    }
  }
  return {
    reason,
    components: unhealthy,
    version: result.healthz_version,
    observedAt,
  };
}
