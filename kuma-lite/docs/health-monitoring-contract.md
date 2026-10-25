# Health response and monitoring evidence contract

## Structured response

A health endpoint returns a small JSON object with `status: "ok" | "degraded" | "down"`.
Optional `reason`, `version`, `components`, and `maintenance` fields retain their existing meanings.
A component has a name, a status, optional `latency_ms`, and an optional reason.
The monitor reads at most 8192 response bytes, with one deadline covering headers and body.
A truncated structured JSON document cannot establish a successful readiness result.

A recognized structured status takes precedence over the HTTP status for `legacy_http` monitors.
An unhealthy component is preserved even if the overall JSON incorrectly says `ok`.
A successful fallback proves that the fallback path responds; its result remains `degraded`
until the primary health endpoint returns a healthy result.

`strict_healthz` is an opt-in readiness contract for the Core OS / Portal integration.
It requires HTTPS GET, JSON content type, an explicit valid status, valid components,
and one identifiable Database component with a finite non-negative duration. HTTP 200
is required for availability; HTTP 503 with a valid explicit `down` preserves the
unhealthy component evidence. HTML, empty/malformed JSON, unknown status types,
contradictory HTTP errors, redirects and cached responses cannot establish health.
The response must include `Cache-Control: no-store`. The request disables caching,
does not follow redirects, and never replaces a failed health endpoint with a site root.
Missing request-ID echo remains diagnostic so older application versions still work.

## Explicit paths and roles

- `probe_transport`: `legacy` keeps existing binding resolution; `public_fetch` always
  uses the public HTTPS path; `service_binding` requires the named binding. An explicit
  missing binding is a configuration error and never silently switches paths.
- `monitor_role`: `availability` drives public status, RSS, incident pages, Slack status
  and service alerts. `diagnostic` is an independent internal-path series with operational
  wording and no public incident or AI RCA. `shadow` records results without notifications.
- `parent_monitor_id`: diagnostics and shadows reference their availability monitor.
  Each row has its own lease, deadline, streak, history and request IDs. The public
  result commits and notifies without awaiting the diagnostic result.
- `config_revision`: server-managed on every settings update. Claims, commits, notification
  reservations and thread updates reject stale revisions. A revision change or missing
  scheduled slot breaks streaks without deleting an open incident or its thread.
- `availability_since_ms`: server-managed public-path boundary. Existing internal history
  is retained but is not relabeled as public HTTPS availability. The boundary day is
  reconstructed from raw public observations; its bounded raw slice is retained while
  needed by the 30-day chart. Leaving public availability clears the current boundary.

Public views must filter by role, including direct incident URLs and Slack commands;
`HIDDEN_MONITOR_IDS` alone is not an authorization boundary. New checks snapshot role,
actual transport and configuration revision rather than inferring old paths from current settings.

`/healthz` on the monitor remains DB-independent process liveness. `/readyz` is a minimal
uncached monitoring-data heartbeat: stale/missing current-revision availability results
return HTTP 503 with `status: "unknown"`. The default freshness allowance is three
minutes for a one-minute monitor (three intervals for longer intervals). It does not
declare the target healthy: a recent recorded DOWN still proves monitoring-data freshness.
Public cards and Slack status show unknown for stale/missing data instead of stale green.

## Route rollout and rollback

1. Test schema parity, strict response validation, path separation, stale-revision fencing,
   missing-slot streaks, role visibility, notifications and history boundaries locally.
2. Apply **only migration 0010**, once, to the monitoring DB. Do not reapply 0009 or touch
   the applications' business database. The additive fields preserve existing settings and history.
3. Deploy the role-aware Worker through this repository's `master` build pipeline. Verify
   the exact source SHA, live Worker version, existing bindings and Cron schedules.
4. Keep existing availability rows unchanged. Add public-fetch strict shadows only after
   the new Worker is live, and verify natural scheduled requests from that Worker. Workspace
   HTTPS success does not prove that Worker-origin requests avoid Cloudflare error 1042.
5. Compare public and binding results for approximately 24 hours without shadow notifications.
   Check coverage, delays, cache policy, response contracts and execution errors. A quiet
   short sample is not proof that the provider's internal waiting has been fixed.
6. Promote only after review and with both affected availability monitors stable UP and
   no active leases. Switch existing IDs to explicit public availability, switch their
   shadow rows to explicit binding diagnostics, and increment revisions atomically. Do not
   manufacture recovery for an existing incident. Retain 1-minute / 10-second / 2-failure
   settings and the operator's 1000ms DB threshold. Verify two fresh natural samples.
7. Screen the following 24 hours and reconcile expected notification transitions with actual
   Slack delivery. Public-normal/internal-timeout must never create a service DOWN alert;
   public failures cannot be cleared by an internal success.

Before rollback, save source/version, settings, state, Cron and bindings. Reverting to
the old Worker requires disabling all new diagnostic/shadow rows first, because it does
not understand roles. Do not drop the additive schema, delete history, clear open threads
or reapply old migrations. A route rollback starts a new settings revision and must not
reuse another path's failure streak.

A Worker-origin public fetch still shares Cloudflare and Cron failure modes. Independent
external monitoring should check both public health endpoints and the monitor's `/readyz`.
Use a real labeled vantage point; a service binding or a workspace request is not proof of
Japan/APAC coverage. External probes must not receive the monitor's general management token.
Public health establishes bounded endpoint and DB readiness, not authenticated business-flow completion.

## Independent notification delivery and execution audit

Migrations 0011–0013 are additive and monitoring-only. Apply each once after 0010;
never reapply 0009 or 0010. Fresh installations use `schema.sql` instead.

The accepted check, state transition and notification outbox event commit in one
D1 transaction. Probe ownership is released before any notification adapter runs.
`notification_delivery_state` owns a separate expiring lease, delivery order and
incident thread; a recovery can queue while its earlier DOWN is still being sent.
Its original detection time is retained. A periodic drain also handles old pending work.
Route changes and deletion reject active/pending notification ownership as well as
probe conflicts. Settings changes cannot silently erase a pending DOWN or recovery:
a fresh current observation can replace a cancelled old-revision event once.

Delivery outcomes are `sent`, `cancelled`, `failed` or `uncertain`. A lost provider
acknowledgement or expired processing lease cannot safely be retried automatically;
it remains visible for investigation. `sent` is an acknowledged delivery outcome,
not a guarantee that every external recipient read the message. Pending/processing
work is not pruned; uncertain outcomes are retained for at least 30 days.

`monitor_runs` records exact schedule/receipt times and the top-level lifecycle.
`monitor_attempts` records the decision for each delivered monitor attempt, including
the observed configuration, previous slot and lease expiry. Claim and rejection
decisions are captured in the claim transaction. Reasons distinguish disabled,
changed configuration, already-recorded/superseded slots and a busy lease. Commit,
release and error phases retain their outcomes. Missing observations stay missing.
Audit updates are bounded and do not gate probe entry or probe-lease release; an
unacknowledged audit is logged without retrying an ownership mutation. Read-only
monitor/state requests have a five-second deadline; write acknowledgements remain
protected by the database lease and revision fences rather than blind retries.
Cold schema reads have the same five-second budget. A timed-out or unavailable
read is distinct from missing migration columns and cannot populate the success cache.
The deliberate five-second offset is measured from the provider's raw scheduled
time; a delayed delivery does not add another five seconds. It retains its original
slot, and a newer committed slot still supersedes it. Rejected attempts retain
pre-claim timings; failed state/probe/commit waits retain their actual elapsed time.

Authenticated inspection endpoints are `GET /api/runs`, `/api/attempts`,
`/api/notifications` and `/api/external-observations`. Filters are bounded to 24 hours
and at most 200 rows. Ownership tokens, notification payloads and credentials are
not included. Normal audit and external records follow the configured raw retention.

## Supplemental GitHub-hosted witness

`.github/workflows/external-health.yml` probes the fixed HTTPS targets and the
monitor's `/readyz` from a GitHub-hosted runner every five minutes. It preserves
the sanitized result in the GitHub run, summary and seven-day artifact even if
the Cloudflare receiver is unavailable. Target health, monitor freshness and
report-delivery failures are separate. Public cards and Slack status show this
external confirmation separately and never clear a primary incident with it.

The receiver accepts only a short-lived GitHub OIDC token for the configured
repository numeric ID, owner, master ref, workflow reference, subject and exact
audience. It verifies RS256 against the fixed GitHub issuer/JWKS. No management
API token or shared probe secret is sent to GitHub. Run/attempt/result identity
makes identical retransmissions idempotent and conflicting payloads fail. Both
targets' configuration is checked atomically; no partial healthy result is stored.
Observations more than 15 minutes old are displayed as unknown, not healthy.

Configure the five `EXTERNAL_PROBE_*` identity values listed in
`wrangler.toml.example` before enabling the workflow. Persistent Worker secrets
are a convenient configuration store preserved by Workers Builds; these identity
values are not a shared authentication secret. Keep the fixed non-secret target
configuration in `external-targets.json` consistent with monitored URLs/DB thresholds.

GitHub schedule is best effort: it can start late or drop runs, and public-repository
schedules can disable after 60 days of repository inactivity. Monitor result age and
workflow status. This witness is outside Cloudflare, but does not establish a Japan/
APAC location or one-minute execution SLA. It is supplemental; primary cadence and
the configured consecutive-failure policy remain separate.

### Optional Cloudflare alarm Worker display

`CLOUDFLARE_WITNESS_URL=https://helth-witness.opus-system.workers.dev` selects a
read-only supplement from the separate alarm Worker. The status cards and Slack
status label it **別Worker確認（Cloudflare）**: it uses the same Cloudflare provider
and does not establish provider independence. When the setting is absent, the
GitHub supplement remains selected. When present, a failed or invalid Cloudflare
response is unknown; a healthy GitHub row is never substituted.

The consumer only fetches the exact allowlisted origin's `/latest`, with a
two-second absolute deadline including headers and body, no redirects, no-store,
and an 8 KiB body limit. Cached responses cannot establish health. It checks enabled/current-generation readiness, local
timestamps (less than 150 seconds old and no more than 30 seconds in the future),
the two fixed target identities, and their URLs/DB thresholds against current
availability monitors. Stopped, restarted without a new observation, stale, or
configuration-mismatched results remain unknown. The only Cloudflare provenance
link is the fixed `/status`; GitHub run links are never fabricated for alarm runs.

This selection neither writes monitoring records nor changes primary checks,
state, incident/recovery decisions, or notifications. `/api/external-observations`
continues to expose authenticated GitHub observation history. Activating this
display requires a separately verified deployment of `health-witness/`.

## Separate latency thresholds

- `db_latency_threshold_ms`: nullable positive safe integer. Compares only an identifiable
  `Database`, `DB`, or `D1` component's own `latency_ms`. Raising this ceiling may clear only
  that component's known latency-only reason, `応答が Nms を超過 (Nms)`.
  Other component failures, mixed/unknown reasons, and `down` are retained.
- `http_latency_threshold_ms`: nullable positive safe integer, disabled by default. Compares
  the HTTP probe's full headers-plus-body elapsed time. It can add degradation, never clear
  a target's degradation. Service-binding elapsed time measures the binding path, not public DNS/TLS.
- `latency_threshold_ms`: deprecated API alias for the DB threshold. New API writes mirror it
  to the DB field. Conflicting alias/DB values are rejected. An explicit DB `null` disables
  the override. HTTP `null` disables HTTP latency alerting independently.

Migration 0009 copies valid legacy positive safe integers into the new DB field once.
It does **not** copy legacy values into the HTTP field. For example, an existing legacy
1000ms setting keeps its DB intent while an HTTP round-trip of 2051ms does not, by itself,
start a new HTTP latency incident. Existing values and target timeouts are not automatically retuned.

## Correlation and phases

Each attempt, including a fallback, sends a unique UUID in `X-Monitor-Request-ID`.
The application echoes a validated ASCII `[A-Za-z0-9._:-]{1,64}` ID or generates its own.
The ID is diagnostic data and conveys no authentication or authorization.
A missing/mismatched echo is recorded; it does not make a healthy response fail.

`checks.probe_trace_json` contains at most two bounded records:

- `attempt`: `primary` or `fallback`; `transport`: `service_binding` or `public_fetch`.
- `request_id`, validated `response_request_id`, and `request_id_matched`.
- `status_code`, `headers_ms`, `body_ms`, `total_ms`, `failure_phase`, `body_truncated`.
- `timeout_ms`, `timeout_callback_elapsed_ms` (null if the timer never ran),
  and `deadline_overrun_ms` (observed completion beyond the configured deadline).

Headers and body completions must also pass an absolute deadline check; a delayed
timer cannot let an overdue healthy response establish readiness. These checks do
not make JavaScript execute while its runtime is paused. Timer callback/completion
overruns are diagnostic evidence, not proof of an application or provider substage.

Monitor structured events use `event: "monitor_probe"` and `monitor_id` plus these fields.
They contain no URL, query, cookies, authorization headers, response body, or provider metadata.
New `checks.latency_ms` values include the bounded body read; historical values measured
headers only. For comparisons across this rollout, compare historical latency with
`probe_trace_json[].headers_ms`, rather than treating the two definitions as one series.
App logs use `event: "health_probe"` and the same `request_id`. Their private phase/D1 metadata
may be joined only to that exact ID and mapped Worker. The public health response does not expose it.
A service binding is not an independent regional/public-HTTP vantage point.

## State and notification meaning

`DOWN -> DEGRADED` means **response restored, degradation continues**. It is a yellow partial
recovery in the existing incident thread and does not add a resolved checkmark.
`DEGRADED -> OK` requires the configured consecutive-success threshold and emits full recovery,
including for degraded-only incidents. A down/degraded/full sequence retains the original thread.
`DOWN -> OK` retains the existing single-success recovery rule.
Duration labels describe the **observed monitor down duration**, not continuous downtime for every user.
A degraded-only recovery has no fictitious "down for 0 seconds" field.

Provider calls have bounded deadlines. Notifications are started only by the committed lease owner;
timed-out notification work does not start a new RCA job. A provider may accept a request whose
acknowledgment is lost, so external notification delivery cannot guarantee exactly-once semantics.

## AI analysis

Confirmed observations are rendered by code. AI suggestions are separately labeled unconfirmed
hypotheses and must cite known evidence IDs. Missing/sampled logs, transport errors, and the absence
of an independent public probe are evidence limits, not proof of health or of a database/region cause.
Public shadows are explicitly configured by the operator; RCA never creates monitors or changes paths.
