import type { Env } from './types';

const AUDIT_WAIT_MS = 5_000;
const NOW = "CAST(strftime('%s','now') AS INTEGER)*1000";

export interface ScheduledRun {
  runId: string;
  scheduledTime: number;
  receivedAt: number;
  audit: Promise<void>;
}

/** Audit writes have no retry after an unknown acknowledgement. Their IDs remain
 * stable if D1 completes late; probe observations are never manufactured. */
async function boundedAudit(operation: Promise<unknown>, runId: string, stage: string): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([operation, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('audit_deadline')), AUDIT_WAIT_MS);
    })]);
  } catch {
    console.error({ event: 'scheduled_audit_unconfirmed', run_id: runId, stage });
  } finally { if (timer !== undefined) clearTimeout(timer); }
}

export async function beginScheduledRun(env: Env, cron: string, scheduledTime: number,
  receivedAt: number): Promise<ScheduledRun> {
  const run = { runId: crypto.randomUUID(), scheduledTime, receivedAt, audit: Promise.resolve() };
  console.log({ event: 'scheduled_received', run_id: run.runId,
    scheduled_time: scheduledTime, received_at: receivedAt, cron });
  // Start persistence immediately, but do not make the probe wait for an
  // observability acknowledgement. The ordered chain is joined at completion.
  run.audit = boundedAudit(env.DB.prepare(`INSERT INTO monitor_runs
    (run_id,scheduled_time,scheduled_slot,received_at,cron,stage,updated_at)
    VALUES(?,?,?,?,?,'schema',${NOW})`)
    .bind(run.runId, scheduledTime, Math.floor(scheduledTime / 60_000) * 60_000,
      receivedAt, cron).run(), run.runId, 'received');
  return run;
}

export async function advanceScheduledRun(env: Env, run: ScheduledRun, stage: 'offset' | 'checks',
  timings: Record<string, number>): Promise<void> {
  const payload = JSON.stringify({ ...timings, phase_observed_at: Date.now() });
  run.audit = run.audit.then(() => boundedAudit(env.DB.prepare(`UPDATE monitor_runs
    SET stage=?,updated_at=${NOW},timings_json=? WHERE run_id=? AND finished_at IS NULL`)
    .bind(stage, payload, run.runId).run(), run.runId, stage));
}

export async function finishScheduledRun(env: Env, run: ScheduledRun,
  outcome: 'completed' | 'failed' | 'schema_missing', errorPhase: string | null,
  timings: Record<string, number>): Promise<void> {
  const payload = JSON.stringify({ ...timings, phase_observed_at: Date.now() });
  run.audit = run.audit.then(() => boundedAudit(env.DB.prepare(`UPDATE monitor_runs
    SET stage=?,error_phase=?,finished_at=${NOW},updated_at=${NOW},timings_json=?
    WHERE run_id=? AND finished_at IS NULL`)
    .bind(outcome, errorPhase, payload, run.runId).run(), run.runId, outcome));
  await run.audit;
}
