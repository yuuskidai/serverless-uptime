export interface Env {
  DB: D1Database;
  DISCORD_WEBHOOK_URL: string;
  API_TOKEN: string;
  RETENTION_DAYS: string;
  HIDDEN_MONITOR_IDS?: string;
}

export type CheckStatus = 'up' | 'down';

export interface Monitor {
  id: number;
  name: string;
  url: string;
  method: string;
  expected_status: number;
  keyword: string | null;
  timeout_ms: number;
  interval_minutes: number;
  enabled: number;
  retry_threshold: number;
  created_at: number;
}

export interface CheckRow {
  id: number;
  monitor_id: number;
  status: CheckStatus;
  status_code: number | null;
  latency_ms: number | null;
  error: string | null;
  ts: number;
}

export interface MonitorState {
  monitor_id: number;
  current_status: CheckStatus;
  consecutive_failures: number;
  last_notified_at: number | null;
  down_since: number | null;
}

export interface CheckResult {
  status: CheckStatus;
  status_code: number | null;
  latency_ms: number | null;
  error: string | null;
}
