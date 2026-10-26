# Cloudflare security notifications

`helth-security` runs within the existing Cloudflare account. It does not upgrade the `opus-system.jp` Free zone or purchase an option. Worker/SQLite Durable Object usage consumes existing account quotas and may have separate usage charges.

The standard HTTP DDoS alert is a separate Cloudflare notification policy connected directly to the existing Slack destination. This Worker deliberately has no public DDoS webhook or public event-ingestion endpoint.

## Trust and input

`CoreSecurityEvents.record(event)` and `PortalSecurityEvents.record(event)` are named Worker RPC entrypoints. Each pins its source; only the corresponding application receives its binding. Input is a strict versioned allowlist with UUID event ID, bounded timestamp, event kind and optional pseudonymous hashes/reason. Unknown fields, raw email/IP, arbitrary text, invalid IDs, stale events and future times are rejected. Application operations use best-effort asynchronous dispatch; a completed business/auth operation does not prove the telemetry reached durable storage.

Fixed events: authentication failure, actual account lock, rate-limit denial, authorization denial, committed administrator permission change, committed TOTP disable and committed security-policy weakening. The last three are observed sensitive changes, not assertions that an attacker succeeded.

The DO persists deduplication, aggregates and outbox atomically before acknowledging ingestion. Event IDs are retained for 15 minutes (longer than the five-minute accepted event age). Regular events have 1,792 reserved IDs; sensitive changes and account locks each have 128 independent reserved IDs. Per-event lookups are indexed; pruning runs in the alarm.

## Alert policy

- Windows are five minutes anchored to the first observed event for each aggregation key, rather than a strict rolling history. Same actor/network: five authentication failures; ten rate-limit or authorization denials per window.
- Distributed spray: twenty authentication failures, or fifty rate-limit/authorization denials, per application in five minutes, even across subjects.
- Repeated burst alerts have a 15-minute cooldown. Distinct sensitive commits and account-lock events notify individually, with event-ID deduplication.
- WAF groups are fixed to the two application hostnames. A blocked/challenged/logged group generates an activity warning, with a 15-minute host/action cooldown. Data is sampled; neither every request nor every intrusion can be detected. Alerts show the actual API query interval, not a fabricated current attack interval.
- Passwords, OTPs, cookies, tokens, raw email/IP, URL query strings, request bodies and arbitrary user text never enter the alert DTO. Slack formatting and destination are independently validated by `helth.SecurityNotifications`.

## Scheduling and bounded storage

A SQLite DO alarm reserves the next one-minute alarm before I/O. WAF reads have a 90-second ingestion lag, a five-second total I/O deadline, at most five minutes per query and at most 15 minutes of backfill. A permission error, malformed/truncated response or lost interval remains unknown and queues a pipeline warning. Permission failures back off five minutes. No data is fabricated as zero attacks. The API token needs the zone Analytics Read permission; lack of permission is not working WAF monitoring.

Subject buckets are limited to 256 and expire after an hour. Fixed global/pipeline/WAF keys do not consume the subject quota. Queue and UTC-day capacities are independent:

| Priority | Pending capacity | Alerts per UTC day |
|---|---:|---:|
| Sensitive committed change | 16 | 20 |
| Pipeline degradation | 8 | 10 |
| Account lock | 8 | 10 |
| Other warnings | 96 | 160 |

Thus low-priority or account-lock floods cannot exhaust the sensitive-change reservation. Dispatch selects sensitive changes first, then pipeline warnings, account locks and other warnings. Saturation is visible as unknown, counted and reported through reserved pipeline capacity. Current capacity can recover; cumulative rejection/suppression counters remain.

Up to four deliveries run per alarm, outside storage transactions. Each has a 30-second lease and an eight-second RPC deadline; the bridge has its own six-second HTTP budget. New claims require the current generation and active owner. An old in-flight acknowledgement is accepted only while its exact row lease still belongs to that send, so stop/start cannot provoke an avoidable retry of a known success. Stable alert UUIDs are reused across retries. Exactly-once Slack delivery is not promised.

Retries start at one minute, grow to at most an hour, honor bounded `Retry-After`, and stop after eight attempts or 24 hours. Dead-letter alerts remain as safe DTOs in receipts for seven days (at most 1,600 receipts). Non-pipeline dead letters queue a bounded nonrecursive delivery-failed warning. Losses never become successful receipts.

## Configuration and operations

Bindings:

- `SECURITY_HUB`: local `SecurityHub` SQLite DO namespace.
- `SLACK_NOTIFIER`: service `helth`, entrypoint `SecurityNotifications`; no Slack credential is copied here.
- `CF_ANALYTICS_TOKEN`: secret, limited to Analytics Read for the fixed zone where possible.
- `ADMIN_SECRET`: random 32-byte hex or base64url secret; never sent to applications or Slack.

Only `GET /healthz` is public, and it reports Worker liveness only. Exact authenticated admin endpoints are `POST /admin/start`, `POST /admin/stop`, `POST /admin/acknowledge` (all bodyless) and `GET /admin/status`. Requests with query parameters or unknown paths are rejected. Public reads never start/restart alarms. Administrative requests are not logged as invocation records.

Status is private and includes freshness, WAF coverage state, bounded queue/receipt counters, current capacity, recent safe dead letters and cumulative delivery losses. Acknowledging dead letters requires fresh healthy WAF monitoring, no pending deliveries and no active execution/lease. It preserves receipts and cumulative counters and records an explicit acknowledgement time; it is not an automatic recovery or a re-send.

Use the shared pinned toolchain: install `../kuma-lite` with `npm ci --ignore-scripts`, then `npm run typecheck`, `npm test`, and `npm run dry-run`. The helper preserves inherited proxy, authentication and guard environment and selects top-level Wrangler configuration with `--env ''`. Do not reset the existing DO namespace or migration ledger during redeployment.
