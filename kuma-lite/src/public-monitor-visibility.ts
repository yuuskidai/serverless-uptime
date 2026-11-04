import type { Env, Monitor } from './types';

/** Hidden means excluded from every public view, not just its dashboard card. */
export function hiddenPublicMonitorIds(input: string | undefined): Set<number> {
  const values = (input ?? '').split(',').map(value => value.trim()).filter(Boolean);
  // A malformed privacy setting must not silently publish everything.
  if (values.some(value => !/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value)))) {
    throw new Error('Invalid HIDDEN_MONITOR_IDS configuration');
  }
  return new Set(values.map(Number));
}

export function publicMonitorVisible(monitor: Pick<Monitor, 'id' | 'monitor_role' | 'enabled'>, hidden: Set<number>): boolean {
  return monitor.enabled === 1 && (monitor.monitor_role ?? 'availability') === 'availability' && !hidden.has(monitor.id);
}

/** Old cached pages must not bypass a changed privacy setting or URL renderer. */
export async function publicMonitorCacheScope(env: Pick<Env, 'HIDDEN_MONITOR_IDS' | 'VERSION_METADATA'>): Promise<string> {
  const hidden = [...hiddenPublicMonitorIds(env.HIDDEN_MONITOR_IDS)].sort((a, b) => a - b);
  const input = JSON.stringify(['public-presentation-security-v1', env.VERSION_METADATA?.id ?? '', hidden]);
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
}
