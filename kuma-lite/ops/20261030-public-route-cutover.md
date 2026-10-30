# Public HTTPS availability handoff

This procedure changes the monitoring path, not application delivery or business data.
It supplements `docs/health-monitoring-contract.md`; its older one-minute/1000 ms
rollout examples and retired witness instructions are not the current configuration.
Do not execute the earlier `review_promote.py`, reapply a migration, recreate a
retired Worker, weaken WAF rules, or change plans, billing or limits.

## Intended configuration

| ID | Service | Current | After handoff |
| --- | --- | --- | --- |
| 5 | Partner Portal | binding availability, revision 2 | public HTTPS availability, strict health response |
| 6 | Core OS | binding availability, revision 2 | public HTTPS availability, strict health response |
| 9 | Partner Portal | public HTTPS shadow, revision 4 | binding diagnostic, parent 5, strict health response |
| 10 | Core OS | public HTTPS shadow, revision 4 | binding diagnostic, parent 6, strict health response |

Keep existing IDs, target URLs, bindings, two-minute intervals, 10-second deadlines,
1500 ms Database thresholds and two-observation failure/recovery thresholds.
The first handoff increments revisions to 3/3/5/5. Revisions never move backwards.
There are still four scheduled probes per eligible slot; no new Worker or external
monitoring service is required.

Public availability controls service status and service DOWN/recovery messages.
The existing diagnostic role already sends `INTERNAL PATH WARNING/NORMAL` messages
with an explicit distinction from public availability. Verify that wording and
independent incident threads; a binding success cannot recover a public incident,
and a binding failure cannot create a public service incident.

## Evidence required before generating a handoff

1. Read the actual deployment/source, settings, states, leases and notification
   outcomes again. Identify app code and configuration deployment boundaries.
2. Review natural observations under the actual policy, application/configuration
   epochs and exact routes/revisions. Reject unexplained route-specific contract
   errors or false healthy results, duplicate/off-schedule checks, inconsistent
   route/revision snapshots and reused request IDs. A 24-hour comparison remains
   useful for daily variation; duration, coverage99% and failures1% are not
   standalone admission gates. An actual application503 correctly detected by the
   monitor is not a monitor error. Count expected two-minute slots; not-due minutes
   are not missing. Missing expected slots remain UNKNOWN, not success. Review
   rejected attempts, delivery lag and missing spans separately from target health.
3. Require two consecutive healthy, fresh natural observations for each public
   comparison target in its current generation. Verify original slot times as well as check
   completion times. Cached content, redirects, HTML or a successful site-root
   fallback cannot establish `/healthz` readiness.
4. Review public-path misclassification explicitly. A shared state/schema wait is
   still an unresolved monitoring problem, but resolving its root cause is not a
   prerequisite for adopting the public path. Public fetch shares Cloudflare,
   Cron, D1 state and execution failure modes. Keep their missing observations
   UNKNOWN and investigate them independently; do not claim the handoff fixes them.
5. Require all four current states UP, no open incident/thread or maintenance,
   no live probe or delivery lease, no active delivery outbox pointer, and no
   pending, processing, uncertain or failed notification requiring investigation.
   Do not delete notification evidence or manufacture recovery to pass a gate.
6. Produce a fresh reviewed report tied to the exact source/Worker version,
   configuration fingerprint, application health version and comparison epoch.
   An old report or manually setting its decision true is not a new review.
   Recheck the actual source/version and current state immediately before applying.
   A fresh review cannot manufacture a recent observation or conceal a missing slot.

The statement generator in `public-route-cutover.mjs` is offline only. It has no
Cloudflare client or deployment command. A hold report must be rejected before a
mutating SQL statement can be generated. Generation does not itself prove that
the live deployment still matches; the executor must re-read it immediately before
submission. Read-only validation must never be described as an applied cutover.

The exported interfaces are `configurationFingerprint(monitors)`,
`buildPublicRouteCutover({ snapshot, review, nowMs })` and
`buildPublicRouteRollback({ snapshot, review, receipt, nowMs })`, and
`createHandoffReceipt({ beforeSnapshot, afterSnapshot, reviewedAtMs, nowMs })`.
`snapshot` contains the
complete `CONFIG_FIELDS` for all four rows, safe state and delivery projections,
the deployed monitor `sourceSha` and `workerVersion`. The forward review binds
those identities and the fingerprint, records `healthVersion`, `reviewedAtMs`,
strict public-response evidence, UNKNOWN handling and verified immediate-backout
readiness. Public comparison targets are9/10 before the handoff. Rollback has a
separate review; it does not attest that the rejected new path has two healthy
observations. Inspect the implementation and tests for the exact shape.
Never include ownership tokens or raw API responses in these inputs.

## Application and acknowledgement

Save minimized pre-change settings/source/version and the reviewed report. Do not
save credentials, raw headers/bodies, lease tokens or ownership attempt IDs.

Use only the monitoring D1 database
`2f9aa24f-2a0d-496b-ab08-1cd76dcf04cc` in account
`ba6339e31e01a9bc4e2036728864bae2`, through the normal configured proxy.
The generator builds one statement with materialized eligibility so checking the
four old settings does not change underneath the UPDATE. It rechecks current
settings, probe/notification ownership, healthy states and recent observations
in the same statement. The handoff changes all four rows or zero rows.
The current single-monitor PATCH API alone does not provide a four-row handoff.

Require exactly four returned rows and verify their complete settings by a fresh
read. A rejected guard is a hold, not permission to force-clear a lease, retry
blindly, reset state or use an older unguarded script. On an unknown write ACK,
read actual settings first and classify: all four still old, all four exactly new,
or mixed/unexpected. Do not automatically resubmit; investigate unexpected state
and possible changes by another operator.

Only monitor configuration rows change. Preserve checks, attempts, runs, counters,
open incidents, notification outbox and Slack threads. The server/database clock
marks the public availability boundary. Do not relabel old binding or shadow
results as historical public availability. Until fresh current-revision checks
exist, status is UNKNOWN. A configuration change must not emit a synthetic recovery.

After four-row readback, create and archive a handoff receipt from the exact saved
before snapshot and actual after snapshot. It binds all expected new settings,
revisions, the actual shared DB-clock public boundary, unchanged pre-handoff safe
states and source/Worker identities. A hypothetical after snapshot is not a receipt.
For a lost ACK, classify real state by readback before constructing any receipt.

## Verification and rollback

After a real handoff, verify two fresh natural checks per row, all revisions and
routes, public status/RSS/incident filtering, internal warning wording, independent
notification threads and `/readyz` freshness. Use existing local strict-probe,
visibility, execution/revision, notification and interval/history tests. No manual
Slack message or artificial outage is needed.

Review the following 24 hours of checks/runs/attempts and notification delivery.
Reconcile every expected slot, route, missing/rejected observation and actual
outbox outcome. The endpoint's healthy response does not establish that login or
all business screens work; service-wide recovery needs evidence appropriate to
those functions.

Prepare rollback from that verified receipt and a fresh current snapshot. It is
another guarded four-row configuration update with increased revisions and the
same ownership, incident, maintenance and notification protections. It requires
neither24 hours after the public boundary nor two healthy new-path observations.

Before the first new-generation result, the old-generation state is allowed only
when it exactly matches the saved pre-handoff state and no new-generation check
has committed. After a new result, the inspected current-generation state must
still be UP with no open incident and must agree with its latest committed check.
Both branches compare all inspected safe state/delivery/configuration fields in
the same materialized guard and reject concurrent changes. Preserve counters,
state, histories and notifications even when returning to the old path. A pending
probe, notification, new open incident or unexpected mutation is not permission
to force a rollback or manufacture recovery.

Returning primary to binding clears the current public boundary, matching the
API's existing behavior. Save the prior boundary and path/revision evidence in the
receipt and check history presentation: the view is then the legacy internal
main series, not a continuing public-only series. Raw observations remain stored.
Do not restore an old Worker, delete schema/history, downgrade revisions or restart
retired supplementary monitors. Returning to public later requires a newly reviewed
generation-specific procedure; do not weaken the first handoff's expected revisions.

## Historical preparation decision (superseded admission policy)

At the initial review cutoff 2026-10-29 23:05 UTC (2026-10-30 08:05 JST), the
two-minute/revision-2-and-4 policy had only 17 hours 53 minutes of observations.
The 22:20 UTC slot had state-read timeouts before all four probes. Persistent
Logs confirm that the 22:24 UTC invocation reached the handler but its schema
read timed out and its run audit was unconfirmed. The 22:26 UTC slot has neither
durable checks nor a matching sampled log; its execution/delivery remains unknown.
Do not call all three missing slots application downtime or undelivered Cron.

Under the initial policy the decision was **hold** for duration and common waiting.
The subsequent operator-approved reassessment replaces those standalone gates with
the four route/ownership/preservation/UNKNOWN-and-immediate-backout criteria above.
Policy-only 24 hours cannot occur before 2026-10-30 05:12 UTC; the then-current
monitor source (`1180cafa`) slots reach 24 hours at 07:18 UTC. Comparing a full interval after the latest
application binding configuration used the first complete slot after 10:55:36 UTC,
namely 2026-10-30 10:56 UTC (19:56 JST). These are earliest time bounds, not a
scheduled switch or assurance that other protections pass. They are no longer
mandatory waiting deadlines for a handoff under the reassessed criteria.
With the collector's two-minute stability exclusion, re-evaluate that complete
post-configuration window no earlier than 10:58 UTC (19:58 JST). In the initial
12-hour-9-minute post-configuration window, Core's public coverage was 361/365
(98.904%), below the former99% gate. Those missing observations remain UNKNOWN.

Latest task-specific evidence is kept separately under
`/workspace/.cache/public-route-cutover-20261030/`. Re-evaluate actual state before
any subsequent operation; this historical preparation note is not execution approval.
