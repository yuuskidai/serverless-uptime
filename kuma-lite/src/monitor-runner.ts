import { performCheck } from './monitor';
import {
  claimMonitorSlot,
  commitMonitorResult,
  reserveTransitionNotification,
  readMonitorState,
  releaseMonitorSlot,
  saveAlertThread,
  scheduledSlot,
} from './monitor-execution';
import { notifyTransition } from './state-notifications';
import { deriveTransition } from './state-transition';
import type { Env, Monitor } from './types';

const BATCH_SIZE = 40;

export interface RunTiming {
  receivedAt: number;
  schemaMs?: number;
  offsetMs?: number;
}

export async function runChecks(env: Env, scheduledTime: number, timing: RunTiming = { receivedAt: Date.now() }): Promise<void> {
  const slotMs = scheduledSlot(scheduledTime);
  const selectStarted = Date.now();
  const monitors = await env.DB.prepare('SELECT * FROM monitors WHERE enabled = 1').all<Monitor>();
  const selectMs = Math.max(0, Date.now() - selectStarted);
  const due = (monitors.results ?? []).filter((monitor) => {
    const interval = Math.max(1, monitor.interval_minutes ?? 1);
    return Math.floor(slotMs / 60_000) % interval === 0;
  }).sort((left, right) => Number(left.monitor_role !== 'availability' && left.monitor_role != null) -
    Number(right.monitor_role !== 'availability' && right.monitor_role != null));
  for (let i = 0; i < due.length; i += BATCH_SIZE) {
    const batch = due.slice(i, i + BATCH_SIZE);
    // A failed diagnostic cannot cancel a public check already in progress.
    const settled = await Promise.allSettled(batch.map((monitor) => checkAndRecord(env, monitor, slotMs,
      scheduledTime, timing, selectMs)));
    let publicError: unknown;
    settled.forEach((item, index) => {
      if (item.status !== 'rejected') return;
      const monitor = batch[index];
      console.error({ event: 'monitor_execution_error', monitor_id: monitor.id, scheduled_slot: slotMs,
        config_revision: monitor.config_revision ?? 1, monitor_role: monitor.monitor_role ?? 'availability' });
      if ((monitor.monitor_role ?? 'availability') === 'availability') publicError ??= item.reason;
    });
    if (publicError) throw publicError;
  }
}

async function checkAndRecord(env: Env, monitor: Monitor, slotMs: number, scheduledTime: number,
  timing: RunTiming, selectMs: number): Promise<void> {
  const phases = { lease_ms: 0, state_ms: 0, probe_ms: 0, commit_ms: 0 };
  let stage = Date.now();
  const lease = await claimMonitorSlot(env, monitor.id, slotMs, monitor.config_revision ?? 1);
  phases.lease_ms = Math.max(0, Date.now() - stage);
  if (!lease) {
    console.log({ event: 'monitor_execution_skipped', monitor_id: monitor.id,
      config_revision: monitor.config_revision ?? 1, monitor_role: monitor.monitor_role ?? 'availability',
      scheduled_time: scheduledTime, scheduled_slot: slotMs, received_at: timing.receivedAt,
      schema_ms: timing.schemaMs ?? 0, offset_ms: timing.offsetMs ?? 0, select_ms: selectMs,
      lease_ms: phases.lease_ms, reason: 'lease_or_configuration_unavailable' });
    return;
  }
  let phase = 'state';
  try {
    stage = Date.now();
    const previous = await readMonitorState(env, monitor.id);
    phases.state_ms = Math.max(0, Date.now() - stage);
    // A real per-monitor start, rather than the former shared pre-SELECT time.
    const ts = Date.now();
    stage = ts;
    phase = 'probe';
    const result = await performCheck(env, monitor);
    phases.probe_ms = Math.max(0, Date.now() - stage);
    const inMaintenance = Boolean(result.maintenance && ts >= result.maintenance.from_ms && ts < result.maintenance.to_ms);
    const transition = deriveTransition(monitor, result, previous, ts, slotMs, inMaintenance);
    stage = Date.now();
    phase = 'commit';
    const committed = await commitMonitorResult(env, monitor, lease, result, previous, transition, ts, inMaintenance);
    phases.commit_ms = Math.max(0, Date.now() - stage);
    console.log({ event: 'monitor_execution', monitor_id: monitor.id, monitor_role: monitor.monitor_role ?? 'availability',
      config_revision: monitor.config_revision ?? 1, scheduled_time: scheduledTime, scheduled_slot: slotMs,
      received_at: timing.receivedAt, probe_started_at: ts, committed_at: committed ? Date.now() : null,
      schema_ms: timing.schemaMs ?? 0, offset_ms: timing.offsetMs ?? 0, select_ms: selectMs, ...phases, committed });
    if (!committed || monitor.monitor_role === 'shadow' || !transition.kind ||
      !(await reserveTransitionNotification(env, lease))) return;
    phase = 'notification';
    const sent = await notifyTransition(env, monitor, result, transition, ts);
    if (sent?.slackAlertTs) await saveAlertThread(env, lease, sent.slackAlertTs);
  } catch (error) {
    console.error({ event: 'monitor_execution_incomplete', monitor_id: monitor.id,
      config_revision: monitor.config_revision ?? 1, monitor_role: monitor.monitor_role ?? 'availability',
      scheduled_time: scheduledTime, scheduled_slot: slotMs, received_at: timing.receivedAt, phase,
      phase_elapsed_ms: Math.max(0, Date.now() - stage), schema_ms: timing.schemaMs ?? 0,
      offset_ms: timing.offsetMs ?? 0, select_ms: selectMs, ...phases });
    throw error;
  } finally {
    // Keep claimed_slot as a durable deduplication watermark after release.
    await releaseMonitorSlot(env, lease);
  }
}
