import type { Monitor } from './types';

/** Missing roles belong to the legacy availability series; unknown roles fail closed. */
export function isAvailabilityMonitor(monitor: Pick<Monitor, 'monitor_role'>): boolean {
  return monitor.monitor_role === undefined || monitor.monitor_role === 'availability';
}

/** Start of the public availability series. Historical internal checks remain stored. */
export function availabilitySince(monitor: Pick<Monitor, 'availability_since_ms'>): number {
  const since = monitor.availability_since_ms;
  return typeof since === 'number' && Number.isSafeInteger(since) && since > 0 ? since : 0;
}

/** SQL counterpart used by all public monitor selectors. */
export const AVAILABILITY_ROLE_SQL = "COALESCE(monitor_role, 'availability') = 'availability'";

/** Only the checks at/after the recorded cutover belong to the public series. */
export function availabilityHistorySql(checkAlias = 'checks'): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(checkAlias)) throw new Error('Invalid SQL alias');
  return `${checkAlias}.ts >= COALESCE((SELECT availability_since_ms FROM monitors WHERE id = ${checkAlias}.monitor_id), 0)
    AND COALESCE(${checkAlias}.monitor_role, 'availability') = 'availability'
    AND (COALESCE((SELECT availability_since_ms FROM monitors WHERE id = ${checkAlias}.monitor_id), 0) = 0
         OR ${checkAlias}.probe_transport = 'public_fetch')`;
}
