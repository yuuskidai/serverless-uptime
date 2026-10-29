import { performCheck } from './monitor';
import {
  claimMonitorSlotDecision,
  commitMonitorResult,
  readMonitorState,
  releaseMonitorSlot,
  scheduledSlot,
  withReadDeadline,
  type AttemptPhase,
  type AttemptFailure,
} from './monitor-execution';
import { drainNotificationOutbox } from './notification-outbox';
import { deriveTransition } from './state-transition';
import type { Env, Monitor } from './types';
import { bindingResponseCompleted, createBindingDiagnostic, type BindingDiagnostic } from './binding-diagnostic';

const BATCH_SIZE = 40;

export interface RunTiming {
  receivedAt: number;
  runId?: string;
  schemaMs?: number;
  /** Absolute probe floor supplied by the scheduled handler, consumed after claim. */
  probeNotBeforeMs?: number;
}

export async function runChecks(env: Env, scheduledTime: number, timing: RunTiming = { receivedAt: Date.now() }): Promise<void> {
  const slotMs = scheduledSlot(scheduledTime);
  const selectStarted = Date.now();
  const monitors = await withReadDeadline(env.DB.prepare('SELECT * FROM monitors WHERE enabled = 1').all<Monitor>())
    .catch(error => {
      console.error({ event: 'monitor_list_incomplete', scheduled_time: scheduledTime, scheduled_slot: slotMs,
        received_at: timing.receivedAt, phase: 'select', phase_elapsed_ms: Math.max(0, Date.now() - selectStarted) });
      throw error;
    });
  const selectMs = Math.max(0, Date.now() - selectStarted);
  const due = (monitors.results ?? []).filter((monitor) => {
    const interval = Math.max(1, monitor.interval_minutes ?? 1);
    return Math.floor(slotMs / 60_000) % interval === 0;
  }).sort((left, right) => Number(left.monitor_role !== 'availability' && left.monitor_role != null) -
    Number(right.monitor_role !== 'availability' && right.monitor_role != null));
  const diagnostic = createBindingDiagnostic(env, due, scheduledTime, timing.receivedAt);
  for (let i = 0; i < due.length; i += BATCH_SIZE) {
    const batch = due.slice(i, i + BATCH_SIZE);
    // A failed diagnostic cannot cancel a public check already in progress.
    const settled = await Promise.allSettled(batch.map((monitor) => checkAndRecord(env, monitor, slotMs,
      scheduledTime, timing, selectMs, diagnostic).finally(() => diagnostic?.finish(monitor.id))));
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
  timing: RunTiming, selectMs: number, diagnostic?: BindingDiagnostic): Promise<void> {
  const phases = { offset_ms: 0, offset_wait_ms: 0, lease_ms: 0, state_ms: 0, probe_ms: 0, commit_ms: 0 };
  let stage = Date.now();
  const beforeClaim = { schema_ms: timing.schemaMs ?? 0, offset_ms: 0,
    offset_wait_ms: 0, select_ms: selectMs,
    delivery_lag_ms: Math.max(0, timing.receivedAt - scheduledTime),
    received_to_claim_ms: Math.max(0, stage - timing.receivedAt) };
  const { lease, attempt } = await claimMonitorSlotDecision(env, monitor.id, slotMs, monitor.config_revision ?? 1,
    { scheduledTime, receivedAt: timing.receivedAt, runId: timing.runId,
      timings: { ...beforeClaim, ...diagnostic?.timings(monitor.id) } });
  phases.lease_ms = Math.max(0, Date.now() - stage);
  if (!lease) {
    diagnostic?.finish(monitor.id);
    console.log({ event: 'monitor_execution_skipped', monitor_id: monitor.id,
      config_revision: monitor.config_revision ?? 1, monitor_role: monitor.monitor_role ?? 'availability',
      scheduled_time: scheduledTime, scheduled_slot: slotMs, received_at: timing.receivedAt,
      ...beforeClaim,
      lease_ms: phases.lease_ms, attempt_id: attempt.attempt_id, reason: attempt.reason,
      observed_claimed_slot: attempt.observed_claimed_slot, observed_lease_until: attempt.observed_lease_until,
      observed_last_check_slot: attempt.observed_last_check_slot, observed_revision: attempt.observed_revision });
    await drainSafely(env, monitor.id);
    return;
  }
  let phase: AttemptPhase = 'offset';
  let probeStartedAt: number | null = null;
  let failure: AttemptFailure | undefined;
  try {
    stage = Date.now();
    phases.offset_wait_ms = Math.max(0, (timing.probeNotBeforeMs ?? 0) - stage);
    if (phases.offset_wait_ms > 0) {
      await new Promise((resolve) => setTimeout(resolve, phases.offset_wait_ms));
    }
    phases.offset_ms = Math.max(0, Date.now() - stage);
    // Claim before waiting so a late old slot cannot steal the queued target.
    // The probe's own clock/deadline starts after the run-local dispatch wait.
    if (diagnostic) {
      phase = 'dispatch';
      stage = Date.now();
      try { await diagnostic.wait(monitor.id); }
      catch { diagnostic.bypass(); }
    }
    phase = 'state';
    stage = Date.now();
    const previous = await readMonitorState(env, monitor.id);
    phases.state_ms = Math.max(0, Date.now() - stage);
    // A real per-monitor start, rather than the former shared pre-SELECT time.
    const ts = Date.now();
    probeStartedAt = ts;
    stage = ts;
    phase = 'probe';
    diagnostic?.start(monitor.id);
    const result = await performCheck(env, monitor);
    diagnostic?.finish(monitor.id, bindingResponseCompleted(result.probe_trace_json));
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
      ...beforeClaim, received_to_probe_ms: Math.max(0, ts - timing.receivedAt), ...phases, committed,
      attempt_id: lease.attemptId ?? lease.token });
  } catch (error) {
    if (phase === 'probe') diagnostic?.finish(monitor.id, false);
    // A rejected await still consumed time. Keep that duration in the durable
    // release audit, including a deadline that expired without a response.
    const elapsed = Math.max(0, Date.now() - stage);
    if (phase === 'offset') phases.offset_ms = elapsed;
    else if (phase === 'state') phases.state_ms = elapsed;
    else if (phase === 'probe') phases.probe_ms = elapsed;
    else if (phase === 'commit') phases.commit_ms = elapsed;
    // Capture diagnostics locally. Unlock comes before any separate audit I/O.
    failure = {phase,reason:'operation_failed',probeStartedAt};
    console.error({ event: 'monitor_execution_incomplete', monitor_id: monitor.id,
      config_revision: monitor.config_revision ?? 1, monitor_role: monitor.monitor_role ?? 'availability',
      scheduled_time: scheduledTime, scheduled_slot: slotMs, received_at: timing.receivedAt, phase,
      phase_elapsed_ms: elapsed,
      ...beforeClaim, ...phases, attempt_id: lease.attemptId ?? lease.token });
    throw error;
  } finally {
    diagnostic?.finish(monitor.id);
    // Keep claimed_slot as a durable deduplication watermark after release.
    try {
      await releaseMonitorSlot(env, lease,
        { ...beforeClaim, ...phases, ...diagnostic?.timings(monitor.id),
          received_to_probe_ms: probeStartedAt === null ? undefined : Math.max(0, probeStartedAt - timing.receivedAt) },
        failure ?? lease.auditFailure);
    } catch {
      console.error({ event: 'monitor_release_unacknowledged', monitor_id: monitor.id,
        scheduled_slot: slotMs, attempt_id: lease.attemptId ?? lease.token });
    }
  }
  // Delivery owns a different lease and thread state. Even a slow provider
  // cannot block the next scheduled probe of this monitor.
  await drainSafely(env, monitor.id);
}

async function drainSafely(env: Env, monitorId: number): Promise<void> {
  try { await drainNotificationOutbox(env, monitorId); }
  catch { console.error({ event: 'notification_outbox_drain_incomplete', monitor_id: monitorId }); }
}
