import type { Monitor } from './types';

const MINUTE = 60_000;
type ScheduleMonitor = Pick<Monitor, 'id' | 'config_revision' | 'interval_minutes'>;
export interface CheckScheduleRow {
  monitor_id?: number;
  config_revision?: number | null;
  probe_trace_json?: string | null;
}

export function validIntervalMinutes(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= 60 ? value : null;
}

function snapshotInterval(traceJson: string | null | undefined): { present: boolean; minutes: number | null } {
  if (traceJson == null) return { present: false, minutes: null };
  let traces: unknown;
  try { traces = JSON.parse(traceJson); } catch { return { present: true, minutes: null }; }
  if (!Array.isArray(traces) || traces.length > 2 ||
      traces.some(trace => trace == null || typeof trace !== 'object' || Array.isArray(trace))) {
    return { present: true, minutes: null };
  }
  if (!traces.some(trace => Object.hasOwn(trace, 'interval_minutes'))) return { present: false, minutes: null };
  const minutes = traces.map(trace => validIntervalMinutes(trace.interval_minutes));
  return { present: true, minutes: minutes[0] !== null && minutes.every(value => value === minutes[0]) ? minutes[0] : null };
}

/** Keep the interpretation displayed immediately before this cutover, not a claim about all original settings. */
function frozenLegacyInterval(id: number, revision: number | null | undefined): number | null {
  const limit = id === 5 || id === 6 ? 1 : id === 9 || id === 10 ? 3 : 0;
  const historicalRevision = revision ?? 1;
  return limit > 0 && Number.isSafeInteger(historicalRevision) && historicalRevision >= 1 && historicalRevision <= limit ? MINUTE : null;
}

/** Freeze the four cutover targets' old interpretation; retain unrelated legacy display compatibility. */
export function resolveCheckIntervalMs(monitor: ScheduleMonitor, check: CheckScheduleRow): number | null {
  if (check.monitor_id != null && check.monitor_id !== monitor.id) return null;
  const snapshot = snapshotInterval(check.probe_trace_json);
  if (snapshot.present) return snapshot.minutes === null ? null : snapshot.minutes * MINUTE;
  const frozen = frozenLegacyInterval(monitor.id, check.config_revision);
  if (frozen !== null) return frozen;
  const current = validIntervalMinutes(monitor.interval_minutes);
  // Preserve unrelated monitors' prior display interpretation; this is not their original interval history.
  if (![5, 6, 9, 10].includes(monitor.id)) return current === null ? null : current * MINUTE;
  return current !== null && check.config_revision != null && Number.isSafeInteger(check.config_revision) &&
    check.config_revision >= 1 && check.config_revision === (monitor.config_revision ?? 1) ? current * MINUTE : null;
}

/** Nullable interval_ms counterpart of resolveCheckIntervalMs; aliases are trusted identifiers only. */
export function historicalIntervalSql(checkAlias = 'checks'): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(checkAlias)) throw new Error('Invalid SQL alias');
  const c = checkAlias;
  const json = `(CASE WHEN json_valid(${c}.probe_trace_json) THEN ${c}.probe_trace_json ELSE 'null' END)`;
  const object = `(CASE WHEN schedule_trace.type = 'object' THEN schedule_trace.value ELSE '{}' END)`;
  const value = `json_extract(${object}, '$.interval_minutes')`;
  const hasSnapshot = `EXISTS (SELECT 1 FROM json_each(${json}) schedule_trace
    WHERE json_type(${object}, '$.interval_minutes') IS NOT NULL)`;
  const validShape = `(json_type(${json}) = 'array' AND json_array_length(${json}) BETWEEN 0 AND 2
    AND NOT EXISTS (SELECT 1 FROM json_each(${json}) schedule_trace WHERE schedule_trace.type <> 'object'))`;
  const first = `json_extract(${json}, '$[0].interval_minutes')`;
  const validSnapshot = `NOT EXISTS (SELECT 1 FROM json_each(${json}) schedule_trace
    WHERE json_type(${object}, '$.interval_minutes') IS NULL
      OR json_type(${object}, '$.interval_minutes') NOT IN ('integer','real')
      OR ${value} NOT BETWEEN 1 AND 60 OR ${value} <> CAST(${value} AS INTEGER)
      OR ${value} <> ${first})`;
  return `(CASE WHEN ${c}.probe_trace_json IS NOT NULL AND (NOT ${validShape} OR ${hasSnapshot})
    THEN CASE WHEN ${validShape} AND ${hasSnapshot} AND ${validSnapshot} THEN ${first} * 60000 ELSE NULL END
    WHEN typeof(COALESCE(${c}.config_revision,1)) IN ('integer','real')
      AND COALESCE(${c}.config_revision,1)=CAST(COALESCE(${c}.config_revision,1) AS INTEGER)
      AND COALESCE(${c}.config_revision,1) BETWEEN 1 AND CASE
      WHEN ${c}.monitor_id IN (5,6) THEN 1 WHEN ${c}.monitor_id IN (9,10) THEN 3 ELSE 0 END THEN 60000
    ELSE (SELECT interval_minutes * 60000 FROM monitors schedule_monitor
      WHERE schedule_monitor.id=${c}.monitor_id AND (${c}.monitor_id NOT IN (5,6,9,10)
        OR (${c}.config_revision=COALESCE(schedule_monitor.config_revision,1)
          AND typeof(${c}.config_revision) IN ('integer','real') AND ${c}.config_revision>=1
          AND ${c}.config_revision=CAST(${c}.config_revision AS INTEGER)))
        AND typeof(schedule_monitor.interval_minutes) IN ('integer','real')
        AND schedule_monitor.interval_minutes BETWEEN 1 AND 60
        AND schedule_monitor.interval_minutes=CAST(schedule_monitor.interval_minutes AS INTEGER))
    END)`;
}

function validIntervalMs(value: number): boolean {
  return Number.isSafeInteger(value) && value >= MINUTE && value <= 60 * MINUTE && value % MINUTE === 0;
}

/** The production scheduler uses epoch-minute phase zero. */
export function isDueSlot(slotMs: number, intervalMs: number): boolean {
  return Number.isSafeInteger(slotMs) && slotMs >= 0 && validIntervalMs(intervalMs) && slotMs % intervalMs === 0;
}

/** First phase-zero due slot at or after slotMs. */
export function nextDueSlot(slotMs: number, intervalMs: number): number {
  if (!Number.isSafeInteger(slotMs) || slotMs < 0 || !validIntervalMs(intervalMs)) throw new Error('Invalid check schedule');
  const next = Math.ceil(slotMs / intervalMs) * intervalMs;
  if (!Number.isSafeInteger(next)) throw new Error('Invalid check schedule');
  return next;
}
