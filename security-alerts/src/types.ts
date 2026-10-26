export const ZONE_ID = '6a83ef6dd7723ac97485c613c9a5ca34';
export const HOSTS = ['core-os.opus-system.jp', 'partner-portal.opus-system.jp'] as const;
export const SINGLETON = 'fixed-security-hub-v1';
export const MINUTE = 60_000;
export const KINDS = ['auth_failure', 'account_locked', 'auth_rate_limited', 'authorization_denied', 'admin_privilege_changed', 'totp_disabled', 'security_policy_weakened'] as const;
export const REASONS = ['password', 'totp', 'recovery', 'ip', 'account'] as const;
export type App = 'core' | 'portal';
export type EventKind = typeof KINDS[number];
export interface AppEvent {
  version: 1; eventId: string; occurredAt: number; kind: EventKind;
  reason?: typeof REASONS[number]; actorHash?: string; networkHash?: string; requestId?: string;
}
export type AlertKind = 'auth_failure_burst' | 'account_locked' | 'auth_rate_limited_burst' | 'authorization_denied_burst'
  | 'admin_privilege_changed' | 'totp_disabled' | 'security_policy_weakened' | 'waf_activity' | 'ddos_attack' | 'pipeline_degraded';
export interface Alert {
  version: 1; id: string; source: App | 'waf' | 'ddos' | 'pipeline'; kind: AlertKind;
  severity: 'warning' | 'critical'; occurredAt: number; windowStart: number; windowEnd: number; count: number;
  subjectHash?: string; host?: typeof HOSTS[number] | 'opus-system.jp';
  action?: 'block' | 'managed_challenge' | 'js_challenge' | 'challenge' | 'log' | 'mixed';
  ruleId?: string;
  detailCode?: typeof REASONS[number] | 'sampled_waf' | 'native_ddos' | 'analytics_unavailable' | 'analytics_gap' | 'queue_capacity' | 'delivery_failed';
}
export interface DeliveryResult { ok: boolean; retryAfterMs?: number; code?: string }
export interface Env {
  SECURITY_HUB: DurableObjectNamespace;
  SLACK_NOTIFIER?: { sendSecurityAlert(alert: Alert): Promise<DeliveryResult> };
  CF_ANALYTICS_TOKEN?: string; ADMIN_SECRET?: string;
  VERSION_METADATA?: WorkerVersionMetadata;
}
export interface WafGroup { action: Alert['action']; host: typeof HOSTS[number]; count: number; ruleId?: string }
export type AnalyticsDiagnosticCode = 'credential_missing' | 'http_unauthorized' | 'http_forbidden' | 'http_rate_limited'
  | 'http_server_error' | 'http_unexpected_status' | 'request_timeout' | 'network_error'
  | 'graphql_unknown_type' | 'graphql_unknown_field' | 'graphql_invalid_variable' | 'graphql_query_invalid'
  | 'graphql_unauthorized' | 'graphql_forbidden' | 'graphql_dataset_forbidden' | 'graphql_rate_limited' | 'graphql_error'
  | 'invalid_response' | 'zone_missing' | 'dataset_missing' | 'row_invalid' | 'result_truncated' | 'unexpected_error';
export interface Control {
  enabled: boolean; generation: number; lastAlarm: number | null;
  active: { token: string; until: number; generation: number } | null;
  seenCount: number; criticalSeenCount: number; lockedSeenCount: number; bucketCount: number; pending: number;
  saturationUntil: number; quota: Record<'regular'|'critical'|'locked'|'pipeline', {pending:number;day:number}>;
  sent: number; dead: number; deadAcknowledged: number; deadAcknowledgedAt: number | null; rejected: number; saturated: boolean;
  day: number; queuedToday: number; suppressed: number;
  analytics: { cursor: number | null; lastSuccess: number | null; nextTry: number;
    diagnostic?: {code:AnalyticsDiagnosticCode;httpStatus:number|null;at:number} | null;
    status: 'unknown' | 'ok'; code: 'not_started' | 'analytics_unavailable' | 'analytics_gap' | null; sampled: true };
}
