import { DurableObject } from 'cloudflare:workers';
import { checkTargets, TARGETS } from './probe';
import { isRetired, json, version } from './index';
import type { Active, Control, Env, SlotRecord, Status, TargetObservation } from './types';

export const INTERVAL_MS = 60_000;
export const STALE_AFTER_MS = 150_000;
export const BUSY_LEASE_MS = 30_000;
const CONTROL_KEY = 'control';
const HISTORY_KEY = 'history';
const initial = (): Control => ({ enabled: false, generation: 0, next_slot: null, last_claimed_slot: -1, active: null });
const nextMinute = (now: number) => Math.floor(now / INTERVAL_MS) * INTERVAL_MS + INTERVAL_MS;
const bounded = (history: SlotRecord[]) => history.sort((a, b) => a.slot - b.slot).slice(-15);
const unknownTargets = (): TargetObservation[] => ['portal', 'core'].map(target => ({
  target: target as TargetObservation['target'], status: 'unknown', http_status: null, total_ms: null,
  observed_at: null, finished_at: null,
  database_ms: null, failure: 'internal', request_id: null, response_request_id: null,
  request_id_matched: false, headers_ms: null, body_ms: null,
  timeout_callback_elapsed_ms: null, deadline_overrun_ms: null, healthz_version: null,
}));

export class ProbeScheduler extends DurableObject<Env> {
  // Constructors and read-only requests never schedule alarms or revive a stopped object.
  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (request.method === 'GET' && ['/status', '/latest'].includes(path)) return this.status(path === '/latest');
    if (request.method !== 'POST' || !['/admin/start', '/admin/stop'].includes(path)) return json({ error: 'not_found' }, 404);
    if (isRetired(this.env)) return json({ error: 'witness_retired' }, 410);
    const start = path === '/admin/start';
    const result = await this.ctx.storage.transaction(async tx => {
      const control = await tx.get<Control>(CONTROL_KEY) ?? initial();
      const history = await tx.get<SlotRecord[]>(HISTORY_KEY) ?? [];
      if (start && control.enabled) return control;
      control.generation++;
      control.enabled = start;
      if (control.active) {
        const record = history.find(row => row.attempt_id === control.active!.token);
        if (record && record.phase === 'checking') { record.phase = 'cancelled'; record.completed_at = Date.now(); }
      }
      control.active = null;
      control.next_slot = start ? nextMinute(Date.now()) : null;
      if (control.next_slot !== null) await tx.setAlarm(control.next_slot);
      else await tx.deleteAlarm();
      await tx.put(CONTROL_KEY, control);
      await tx.put(HISTORY_KEY, bounded(history));
      return control;
    });
    return json({ enabled: result.enabled, generation: result.generation, next_alarm: result.next_slot });
  }

  async alarm(info?: AlarmInvocationInfo): Promise<void> {
    if (isRetired(this.env)) {
      // A retired deployment consumes existing alarm deliveries without new probes or ownership/history resets.
      // Retries may still arrive; every delivery follows this same no-probe branch.
      await this.ctx.storage.transaction(async tx => {
        const control = await tx.get<Control>(CONTROL_KEY);
        if (control) await tx.put(CONTROL_KEY, { ...control, enabled: false, next_slot: null });
        await tx.deleteAlarm();
      });
      return;
    }
    const receivedAt = Date.now();
    const active = await this.ctx.storage.transaction(async tx => {
      const control = await tx.get<Control>(CONTROL_KEY) ?? initial();
      if (!control.enabled || control.next_slot === null) { await tx.deleteAlarm(); return null; }
      // An at-least-once retry can arrive after the original handler reserved the next alarm.
      if (control.next_slot > receivedAt) { await tx.setAlarm(control.next_slot); return null; }
      const slot = control.next_slot;
      control.next_slot = nextMinute(receivedAt);
      // Reserve the next alarm before any network request or completed-probe storage write.
      await tx.setAlarm(control.next_slot);
      if (slot <= control.last_claimed_slot) { await tx.put(CONTROL_KEY, control); return null; }
      const history = await tx.get<SlotRecord[]>(HISTORY_KEY) ?? [];
      const record: SlotRecord = {
        slot, generation: control.generation, attempt_id: crypto.randomUUID(),
        alarm_received_at: receivedAt, alarm_lateness_ms: Math.max(0, receivedAt - slot),
        alarm_retry_count: info?.retryCount ?? 0, phase: 'checking', completed_at: null,
        probe_started_at: null, probe_finished_at: null,
        version: version(this.env), targets: [],
      };
      control.last_claimed_slot = slot;
      if (control.active && control.active.lease_until > receivedAt) {
        record.phase = 'skipped_busy'; record.completed_at = receivedAt;
        history.push(record);
        await tx.put(CONTROL_KEY, control); await tx.put(HISTORY_KEY, bounded(history));
        return null;
      }
      if (control.active) {
        const old = history.find(row => row.attempt_id === control.active!.token);
        if (old && old.phase === 'checking') { old.phase = 'abandoned'; old.completed_at = receivedAt; }
      }
      control.active = { slot, generation: control.generation, token: record.attempt_id, lease_until: receivedAt + BUSY_LEASE_MS };
      history.push(record);
      await tx.put(CONTROL_KEY, control); await tx.put(HISTORY_KEY, bounded(history));
      return control.active;
    });
    if (!active) return;
    const startedAt = Date.now();
    let targets: TargetObservation[], phase: SlotRecord['phase'] = 'completed';
    try { targets = await checkTargets(); }
    catch { targets = unknownTargets(); phase = 'internal_error'; }
    const finishedAt = Date.now();
    await this.finish(active, targets, phase, startedAt, finishedAt);
  }

  private async finish(active: Active, targets: TargetObservation[], phase: SlotRecord['phase'], startedAt: number, finishedAt: number): Promise<void> {
    const saved = await this.ctx.storage.transaction<SlotRecord | null>(async tx => {
      const control = await tx.get<Control>(CONTROL_KEY) ?? initial();
      // A stopped/restarted generation or a newer owner must never accept this late result.
      if (!control.enabled || control.generation !== active.generation || control.active?.token !== active.token) return null;
      const history = await tx.get<SlotRecord[]>(HISTORY_KEY) ?? [];
      const record = history.find(row => row.attempt_id === active.token && row.phase === 'checking');
      if (!record) return null;
      record.phase = phase; record.completed_at = Date.now(); record.targets = targets;
      record.probe_started_at = startedAt; record.probe_finished_at = finishedAt;
      control.active = null;
      await tx.put(CONTROL_KEY, control); await tx.put(HISTORY_KEY, bounded(history));
      return record;
    });
    // Log only accepted alarm results, after the transaction acknowledges storage.
    // This allowlist excludes headers, response bodies/reasons and administrative inputs.
    if (saved) console.info({
      event: 'witness_slot_result', slot: saved.slot, generation: saved.generation,
      attempt_id: saved.attempt_id, alarm_received_at: saved.alarm_received_at,
      alarm_lateness_ms: saved.alarm_lateness_ms, alarm_retry_count: saved.alarm_retry_count,
      phase: saved.phase, completed_at: saved.completed_at,
      probe_started_at: saved.probe_started_at, probe_finished_at: saved.probe_finished_at,
      version: { id: saved.version.id, tag: saved.version.tag, timestamp: saved.version.timestamp },
      targets: saved.targets.map(target => ({
        target: target.target, status: target.status, observed_at: target.observed_at, finished_at: target.finished_at,
        http_status: target.http_status, total_ms: target.total_ms, database_ms: target.database_ms,
        failure: target.failure, request_id: target.request_id, response_request_id: target.response_request_id,
        request_id_matched: target.request_id_matched, headers_ms: target.headers_ms, body_ms: target.body_ms,
        timeout_callback_elapsed_ms: target.timeout_callback_elapsed_ms, deadline_overrun_ms: target.deadline_overrun_ms,
        healthz_version: target.healthz_version,
      })),
    });
  }

  private async status(compact = false): Promise<Response> {
    // Public retirement verification is read-only and must never expose raw history or ownership identifiers.
    if (isRetired(this.env)) {
      const snapshot = await this.ctx.storage.transaction(async tx => ({
        control: await tx.get<Control>(CONTROL_KEY) ?? initial(),
        history: await tx.get<SlotRecord[]>(HISTORY_KEY) ?? [],
        alarm: await tx.getAlarm(),
      }));
      const last = [...snapshot.history].reverse().find(row => row.phase === 'completed' || row.phase === 'internal_error');
      return json({ version: 1, source: 'cloudflare_alarm', retired: true,
        enabled: snapshot.control.enabled, next_alarm: snapshot.control.next_slot,
        alarm_at: snapshot.alarm, alarm_present: snapshot.alarm !== null,
        active_present: snapshot.control.active !== null, generation: snapshot.control.generation,
        history_count: snapshot.history.length, last_claimed_slot: snapshot.control.last_claimed_slot,
        last_observation: last ? { slot: last.slot, observed_at: last.probe_started_at, finished_at: last.probe_finished_at } : null,
        readiness: { status: 'retired' }, witness_version: version(this.env) });
    }
    const { control, history } = await this.ctx.storage.transaction(async tx => ({
      control: await tx.get<Control>(CONTROL_KEY) ?? initial(),
      history: await tx.get<SlotRecord[]>(HISTORY_KEY) ?? [],
    }));
    const now = Date.now();
    const latest = [...history].reverse().find(row => row.generation === control.generation &&
      (row.phase === 'completed' || row.phase === 'internal_error')) ?? null;
    const age = latest?.probe_started_at == null ? null : Math.max(0, now - latest.probe_started_at);
    const fresh = control.enabled && latest !== null && age !== null && age <= STALE_AFTER_MS &&
      latest.probe_finished_at !== null && latest.probe_started_at! <= latest.probe_finished_at && latest.probe_finished_at <= now &&
      latest.targets.length === 2 && latest.targets.every(target => target.observed_at !== null &&
        target.finished_at !== null && target.observed_at <= target.finished_at && target.finished_at <= now &&
        now - target.observed_at <= STALE_AFTER_MS && now - target.finished_at <= STALE_AFTER_MS);
    const targets = fresh ? latest.targets : unknownTargets().map(target => ({ ...target, failure: null }));
    const statuses = targets.map(target => target.status);
    const status: Status = !fresh || statuses.includes('unknown') ? 'unknown'
      : statuses.includes('down') ? 'down' : statuses.includes('degraded') ? 'degraded' : 'ok';
    if (compact) return json({ version: 1, source: 'cloudflare_alarm', enabled: control.enabled,
      observed_at: fresh ? latest.probe_started_at : null,
      finished_at: fresh ? latest.probe_finished_at : null, age_ms: age,
      readiness: { status: fresh ? 'fresh' : 'unknown' },
      results: targets.map(target => ({
        monitor_id: target.target === 'portal' ? 5 : 6, status: target.status,
        url: TARGETS.find(configured => configured.target === target.target)!.url, db_threshold_ms: 1000,
        observed_at: target.observed_at, finished_at: target.finished_at,
        http_status: target.http_status, total_ms: target.total_ms, database_ms: target.database_ms,
        request_id: target.request_id, response_request_id: target.response_request_id,
        healthz_version: target.healthz_version, failure: target.failure,
      })), witness_version: version(this.env),
    });
    return json({ service: 'helth-witness', status, scope: 'public_fetch_from_separate_cloudflare_do',
      enabled: control.enabled, observed_at: now, fresh, age_ms: age,
      stale_after_ms: STALE_AFTER_MS, interval_ms: INTERVAL_MS,
      next_alarm: control.next_slot, phase: control.active ? 'checking' : control.enabled ? 'waiting' : 'stopped',
      targets, latest, history: history.slice(-15), version: version(this.env),
    });
  }
}
