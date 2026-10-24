import type { CheckResult, ComponentHealth, Env, Monitor } from './types';
import { type IncidentDetail, notifyDegraded, notifyDown, notifyUp, notifyPartialRecovery } from './notifier';
import { enqueueRca } from './rca';
import type { StateTransition } from './state-transition';

/** Called only after the check and state transition committed under the lease. */
export async function notifyTransition(
  env: Env,
  monitor: Monitor,
  result: CheckResult,
  transition: StateTransition,
  ts: number,
): Promise<{ slackAlertTs: string | null } | null> {
  if (!transition.kind) return null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let active = true;
  try {
    return await Promise.race([
      deliverTransition(env, monitor, result, transition, ts, () => active),
      new Promise<null>(resolve => { timer = setTimeout(() => {
        console.warn('monitor notification deadline exceeded', monitor.id);
        resolve(null);
      }, 18_000); }),
    ]);
  } finally { active = false; if (timer !== undefined) clearTimeout(timer); }
}

async function deliverTransition(
  env: Env, monitor: Monitor, result: CheckResult, transition: StateTransition, ts: number, active: () => boolean,
): Promise<{ slackAlertTs: string | null } | null> {
  try {
    if (transition.kind === 'down' || transition.kind === 'degraded') {
      const detail = buildIncidentDetail(result, transition.kind === 'down' ? 'unknown error' : '一部の機能が不調');
      const sent = transition.kind === 'down'
        ? await notifyDown(env, monitor, detail)
        : await notifyDegraded(env, monitor, detail);
      // A provider may finish after our deadline. Do not start a fresh AI queue job once
      // notification ownership has expired; already-sent external messages cannot be retracted.
      if (sent.slackAlertTs && active()) {
        await enqueueRca(env, {
          monitorId: monitor.id,
          alertTs: sent.slackAlertTs,
          downSince: ts,
          reason: detail.reason,
          kind: transition.kind,
        });
      }
      return sent;
    }
    if (transition.kind === 'partial') {
      await notifyPartialRecovery(env, monitor, buildIncidentDetail(result, '遅延または一部不調が継続'),
        transition.downDurationMs, transition.previousSlackAlertTs);
    } else {
      await notifyUp(env, monitor, transition.downDurationMs, transition.previousSlackAlertTs,
        transition.previousStatus === 'degraded' ? 'degraded' : 'down');
    }
    return null;
  } catch (err) {
    console.error('monitor transition notification failed:', err instanceof Error ? err.message : 'unknown error');
    return null;
  }
}

function buildIncidentDetail(result: CheckResult, fallbackReason: string): IncidentDetail {
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
  };
}
