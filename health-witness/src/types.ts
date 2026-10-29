export interface Env {
  SCHEDULER: DurableObjectNamespace;
  /** Committed retirement mode; omitted only by normal-mode regression fixtures. */
  RETIRED?: string;
  ADMIN_SECRET?: string;
  VERSION_METADATA?: WorkerVersionMetadata;
}

export type Status = 'ok' | 'degraded' | 'down' | 'unknown';
export type Phase = 'checking' | 'completed' | 'cancelled' | 'abandoned' | 'skipped_busy' | 'internal_error';
export interface Version { id: string | null; tag: string | null; timestamp: string | null }
export interface TargetObservation {
  target: 'portal' | 'core';
  observed_at: number | null;
  finished_at: number | null;
  status: Status;
  http_status: number | null;
  total_ms: number | null;
  database_ms: number | null;
  failure: 'timeout' | 'headers' | 'body' | 'invalid_healthz' | 'internal' | null;
  request_id: string | null;
  response_request_id: string | null;
  request_id_matched: boolean;
  headers_ms: number | null;
  body_ms: number | null;
  timeout_callback_elapsed_ms: number | null;
  deadline_overrun_ms: number | null;
  healthz_version: string | null;
}
export interface SlotRecord {
  slot: number;
  generation: number;
  attempt_id: string;
  alarm_received_at: number;
  alarm_lateness_ms: number;
  alarm_retry_count: number;
  phase: Phase;
  completed_at: number | null;
  probe_started_at: number | null;
  probe_finished_at: number | null;
  version: Version;
  targets: TargetObservation[];
}
export interface Active { slot: number; generation: number; token: string; lease_until: number }
export interface Control {
  enabled: boolean;
  generation: number;
  next_slot: number | null;
  last_claimed_slot: number;
  active: Active | null;
}
