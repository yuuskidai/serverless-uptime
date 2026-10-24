# Health response and monitoring evidence contract

## Structured response

A health endpoint returns a small JSON object with `status: "ok" | "degraded" | "down"`.
Optional `reason`, `version`, `components`, and `maintenance` fields retain their existing meanings.
A component has a name, a status, optional `latency_ms`, and an optional reason.
The monitor reads at most 8192 response bytes, with one deadline covering headers and body.
A truncated structured JSON document cannot establish a successful readiness result.

A recognized structured status takes precedence over the HTTP status, as in the original integration.
An unhealthy component is preserved even if the overall JSON incorrectly says `ok`.
A successful fallback proves that the fallback path responds; its result remains `degraded`
until the primary health endpoint returns a healthy result.

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
Duration labels describe the **observed monitor down duration**, not continuous downtime for every user.
A degraded-only recovery has no fictitious "down for 0 seconds" field.

Provider calls have bounded deadlines. Notifications are started only by the committed lease owner;
timed-out notification work does not start a new RCA job. A provider may accept a request whose
acknowledgment is lost, so external notification delivery cannot guarantee exactly-once semantics.

## AI analysis

Confirmed observations are rendered by code. AI suggestions are separately labeled unconfirmed
hypotheses and must cite known evidence IDs. Missing/sampled logs, transport errors, and the absence
of an independent public probe are evidence limits, not proof of health or of a database/region cause.
No scheduled second public monitor is created automatically.
