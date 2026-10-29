# Independent Cloudflare health witness

Retired on 2026-10-29. The committed `RETIRED="true"` deployment consumes existing
alarm deliveries without running probes, disables further alarms, and returns only
safe retirement metadata from `/status` and `/latest`. Those GET requests do not
perform cleanup. Both administrative controls return 410; do not restart or redeploy
the normal probe mode. Disconnect Workers Builds after verifying this retirement
deployment so later monitor changes cannot recreate the Worker.

Retirement preserves generation, history, the claimed-slot watermark and any active
ownership record. An active record can remain after an older in-flight result is
fenced out; `active_present` does not prove a request is still running or drained.
Worker/namespace deletion is a separate data-destructive step, not performed by this
flag. The sections below document the former operating mode.

`helth-witness` checks the fixed public `/healthz` endpoints for Partner Portal
and Core OS once per minute using a single SQLite Durable Object alarm. It has
no Cron trigger, business D1 database, service bindings, notification credentials,
or Cloudflare API token. This is a separate Cloudflare execution path for comparing
observations with `helth`; it does not establish independence from Cloudflare itself.

The shared `kuma-lite/src/monitor.ts` probe preserves strict health JSON, no-store
freshness, the Database component, a 1000 ms Database threshold, a 10 second
headers-and-body deadline, an 8 KiB body limit, and manual redirects. Both checks
run concurrently. The first placement hint is `apac`, which is best effort and
does not guarantee an execution region.

Only the constant singleton object name is reachable. The object reserves its next
alarm and records ownership before performing network I/O. Repeated delivery of
the same slot cannot issue a second probe. Expired owners become abandoned; late
completions cannot overwrite a newer owner or a stopped/restarted generation.
Delayed alarms skip catch-up and retain their original due slot and actual lateness.
The constructor and public GET requests never start or restart monitoring.

- `GET /healthz`: Worker liveness only; it does not assert target health.
- `GET /status`: current summary, latest current-generation observation, and at
  most 15 slot records. Results are `unknown` before first start/check, while
  stopped, after restart until a new check, or when actual probe times are older
  than 150 seconds. Stored historical results remain labelled with their times.
- `GET /latest`: the same current summary as a compact version-1
  `cloudflare_alarm` DTO, without history, for the main monitor's optional display.
- `POST /admin/start` and `POST /admin/stop`: bodyless requests authenticated by
  `Authorization: Bearer <ADMIN_SECRET>`. The secret must be a random 32-byte value
  encoded as 64 hex characters or 43 unpadded base64url characters. No URL, target,
  interval, object name or other external configuration is accepted.

An alarm is an at-least-once scheduling mechanism and can be delayed. The nominal
one-minute interval is not a one-minute execution SLA. Missing/old observations
never establish availability. Storage contains only bounded operational metadata
and sanitized numeric/status/version/request-ID observations, without response
bodies, reasons, credentials or request headers.
Every accepted completed alarm emits a sanitized `witness_slot_result` structured
log after storage acknowledges it. Cloudflare logs use 100% sampling for this
Worker; these events support comparisons beyond the 15-slot public history,
within the account's log retention period. Rejected late owners and duplicate
deliveries do not emit accepted-result events, and administrative HTTP adds no logs.

Use the Node 24 toolchain and the pinned dependencies installed by `npm ci` in
`../kuma-lite`. This package downloads no separate toolchain:

```sh
npm run typecheck
npm test
npm run dry-run
```

Deploy and provision `ADMIN_SECRET` separately before issuing the authenticated
start request. Deployment alone leaves an uninitialised object `unknown` and
stopped. Invocation logs are disabled to keep administrative bearer headers out
of invocation metadata; the probe's own structured logs contain no credentials.

Workers Builds deploys this Worker from the repository's `master` branch, watching
both `health-witness/**` and its shared `kuma-lite/**` dependencies. The build root
is `/health-witness`; it installs the pinned sibling dependencies and typechecks
before deploying. `NODE_VERSION=24.22.1` selects Node and `packageManager` selects
npm 11.21.1. Keep the existing runtime secret and SQLite namespace across releases;
a deployment must not stop, restart, or clear the scheduler's stored state.

The main monitor may read the fixed `/latest` endpoint through its
`CLOUDFLARE_WITNESS` Service Binding. That binding carries no administrative bearer
and does not change where or when these public HTTPS measurements run.
