export interface Env {
  DB: D1Database;
  DISCORD_WEBHOOK_URL: string;
  API_TOKEN: string;
  RETENTION_DAYS: string;
  HIDDEN_MONITOR_IDS?: string;

  // Slack via chat-sdk. Configure all three (or none) to enable Slack
  // notifications and the `/status` slash command. SLACK_DEFAULT_CHANNEL
  // is the channel id (e.g. "C0123ABCD") where DOWN/recovery alerts
  // are posted.
  SLACK_BOT_TOKEN?: string;
  SLACK_SIGNING_SECRET?: string;
  SLACK_DEFAULT_CHANNEL?: string;
}

/**
 * Tri-state status used by the badge, header, and notifier. The
 * `checks` table still stores binary 'up' | 'down' for bar aggregation
 * (see CheckRow.status); 'degraded' lives in monitor_state and in the
 * derived bucket-level effState in status-page.ts.
 */
export type CheckStatus = 'up' | 'degraded' | 'down';

/** Binary outcome stored on each check row (drives bars + uptime %). */
export type CheckBinaryStatus = 'up' | 'down';

/**
 * Structured status reported by the monitored site's /healthz JSON.
 * Lives in checks.healthz_status. NULL when the response wasn't
 * parseable structured JSON (legacy site, fallback URL probe, parse
 * failure, etc.).
 */
export type HealthzStatus = 'ok' | 'degraded' | 'down';

export interface Monitor {
  id: number;
  name: string;
  url: string;
  /**
   * Optional plain-language note about what business function this URL
   * represents (e.g., "ログイン機能", "決済 API"). Surfaced on the
   * status card and incident detail page so non-technical readers see
   * the function name alongside or instead of the raw URL.
   */
  description: string | null;
  /**
   * Liveness fallback URL probed when the primary `url` (typically
   * `/healthz`) does not return parseable structured JSON or fails
   * outright. Lets us distinguish "app-layer healthz broken, site
   * still responding" from "site fully down".
   */
  fallback_url: string | null;
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
  /** Binary 'up' | 'down'. */
  status: CheckBinaryStatus;
  status_code: number | null;
  latency_ms: number | null;
  error: string | null;
  ts: number;
  healthz_status: HealthzStatus | null;
  healthz_reason: string | null;
  /** JSON-stringified ComponentHealth[]; NULL when the site didn't return components. */
  healthz_components: string | null;
  healthz_version: string | null;
  used_fallback: number; // 0 | 1
  in_maintenance: number; // 0 | 1
}

export interface MonitorState {
  monitor_id: number;
  current_status: CheckStatus;
  consecutive_failures: number;
  last_notified_at: number | null;
  down_since: number | null;
  /** Slack message ts of the open DOWN alert; null when monitor is up. */
  slack_alert_ts: string | null;
  /** Most recent declared maintenance window (ms epoch). */
  maintenance_from: number | null;
  maintenance_to: number | null;
  maintenance_reason: string | null;
}

/**
 * What `performCheck` produced for a single tick. The binary `status`
 * is what gets persisted as checks.status; the structured fields
 * mirror the columns added in migration 0002.
 */
export interface CheckResult {
  status: CheckBinaryStatus;
  status_code: number | null;
  latency_ms: number | null;
  error: string | null;
  healthz_status: HealthzStatus | null;
  healthz_reason: string | null;
  /** Components as already-stringified JSON (or null). */
  healthz_components: string | null;
  healthz_version: string | null;
  used_fallback: boolean;
  /** Maintenance window declared by the site at the time of this check. */
  maintenance: MaintenanceWindow | null;
}

export interface ComponentHealth {
  name: string;
  status: HealthzStatus;
  latency_ms?: number;
  reason?: string | null;
}

export interface MaintenanceWindow {
  /** ISO 8601 with offset (kept verbatim for display). */
  from: string;
  to: string;
  reason: string;
  /** Parsed ms-epoch values (NaN safety filtered upstream). */
  from_ms: number;
  to_ms: number;
}

/**
 * Shape of the JSON body returned by monitored sites at /healthz.
 * Mirror of integration-spec.md §1.1 — kept loose (all fields
 * optional) so we never throw on malformed payloads.
 */
export interface HealthzPayload {
  status?: HealthzStatus;
  version?: string;
  reason?: string | null;
  components?: ComponentHealth[];
  maintenance?: {
    from?: string;
    to?: string;
    reason?: string;
  } | null;
}
