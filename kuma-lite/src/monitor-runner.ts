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

export async function runChecks(env: Env, scheduledTime: number): Promise<void> {
  const slotMs = scheduledSlot(scheduledTime);
  const monitors = await env.DB.prepare('SELECT * FROM monitors WHERE enabled = 1').all<Monitor>();
  const due = (monitors.results ?? []).filter((monitor) => {
    const interval = Math.max(1, monitor.interval_minutes ?? 1);
    return Math.floor(slotMs / 60_000) % interval === 0;
  });
  for (let i = 0; i < due.length; i += BATCH_SIZE) {
    await Promise.all(due.slice(i, i + BATCH_SIZE).map((monitor) => checkAndRecord(env, monitor, slotMs)));
  }
}

async function checkAndRecord(env: Env, monitor: Monitor, slotMs: number): Promise<void> {
  const lease = await claimMonitorSlot(env, monitor.id, slotMs);
  if (!lease) return;
  try {
    const previous = await readMonitorState(env, monitor.id);
    // A real per-monitor start, rather than the former shared pre-SELECT time.
    const ts = Date.now();
    const result = await performCheck(env, monitor);
    const inMaintenance = Boolean(result.maintenance && ts >= result.maintenance.from_ms && ts < result.maintenance.to_ms);
    const transition = deriveTransition(monitor, result, previous, ts, slotMs, inMaintenance);
    const committed = await commitMonitorResult(env, monitor, lease, result, previous, transition, ts, inMaintenance);
    if (!committed || !transition.kind || !(await reserveTransitionNotification(env, lease))) return;
    const sent = await notifyTransition(env, monitor, result, transition, ts);
    if (sent?.slackAlertTs) await saveAlertThread(env, lease, sent.slackAlertTs);
  } finally {
    // Keep claimed_slot as a durable deduplication watermark after release.
    await releaseMonitorSlot(env, lease);
  }
}
