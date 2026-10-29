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
2. Compare at least 24 hours of natural observations under the reviewed policy,
   application/configuration epochs and exact routes/revisions. Do not supplement
   that interval with older settings or diagnostic experiments. For each public
   target require coverage >=99%, failures <=1%, no duplicate/off-schedule checks,
   consistent routes/revisions, unique request IDs and no strict-contract errors.
   Count expected two-minute slots; not-due minutes are not missing. Missing
   expected slots remain UNKNOWN, not success. Review denied attempts and delivery
   lag separately from target failures. Record the failure-rate denominator.
3. Require two consecutive healthy, fresh natural observations for each affected
   target in its current generation. Verify original slot times as well as check
   completion times. Cached content, redirects, HTML or a successful site-root
   fallback cannot establish `/healthz` readiness.
4. Review common monitor waiting and public-path misclassification explicitly.
   If either remains unresolved, the decision is **hold** even if numerical
   coverage/failure limits pass. Public fetch shares the monitor's Cloudflare,
   Cron, D1 state and execution failure modes.
5. Require all four current states UP, no open incident/thread or maintenance,
   no live probe or delivery lease, no active delivery outbox pointer, and no
   pending, processing, uncertain or failed notification requiring investigation.
   Do not delete notification evidence or manufacture recovery to pass a gate.
6. Produce a fresh reviewed report tied to the exact source/Worker version,
   configuration fingerprint, application health version and comparison epoch.
   An old report or manually setting its decision true is not a new review.
   Both the review age and the gap from the comparison end to the review must
   be at most five minutes; refreshing a decision cannot refresh old evidence.

The statement generator in `public-route-cutover.mjs` is offline only. It has no
Cloudflare client or deployment command. A hold report must be rejected before a
mutating SQL statement can be generated. Generation does not itself prove that
the live deployment still matches; the executor must re-read it immediately before
submission. Read-only validation must never be described as an applied cutover.

The exported interfaces are `configurationFingerprint(monitors)`,
`buildPublicRouteCutover({ snapshot, review, nowMs })` and
`buildPublicRouteRollback({ snapshot, review, nowMs })`. `snapshot` contains the
complete `CONFIG_FIELDS` for all four rows, the deployed monitor `sourceSha` and
`workerVersion`. The review binds those identities and the fingerprint, records
`healthVersion`, `policyEpochMs`, `windowStartMs`, `windowEndMs`, `reviewedAtMs`,
and per-target revision/coverage/failure/contract/identity findings. All three
decisions (`eligible`, `commonWaitResolved`, `publicMisclassificationResolved`)
must be explicitly true. The reviewed public targets are 9/10 before the handoff
and 5/6 before rollback. Inspect the implementation and tests for the exact shape.
Never include ownership tokens in these inputs or persist the raw API response.

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

Prepare rollback from a saved exact post-handoff baseline. It is another guarded
four-row configuration update with increased revisions and the same ownership,
incident, maintenance and notification protections. Do not roll back an active
incident by force or use another path's healthy state to clear it. Returning the
primary to binding clears the current public availability boundary, matching the
API's existing behavior; retain the prior boundary and route/revision evidence in
the audit record and check history presentation after rollback. Do not restore an
old Worker, delete new schema/history, downgrade revisions or restart retired
supplementary monitors.

This generator's rollback also requires 24 hours of reviewed public observations
after the saved public boundary. It implements a conservative planned rollback,
not an immediate emergency rollback. Do not bypass its guards to get around that
restriction. A return to public availability after rollback requires a new reviewed
generation-specific procedure: the first handoff's revision-2/4 expectations must
not simply be reused or weakened.

## 2026-10-30 preparation decision

At the initial review cutoff 2026-10-29 23:05 UTC (2026-10-30 08:05 JST), the
two-minute/revision-2-and-4 policy had only 17 hours 53 minutes of observations.
The 22:20 UTC slot had state-read timeouts before all four probes. Persistent
Logs confirm that the 22:24 UTC invocation reached the handler but its schema
read timed out and its run audit was unconfirmed. The 22:26 UTC slot has neither
durable checks nor a matching sampled log; its execution/delivery remains unknown.
Do not call all three missing slots application downtime or undelivered Cron.

The decision is **hold**: insufficient duration and unresolved common waiting.
Policy-only 24 hours cannot occur before 2026-10-30 05:12 UTC; the then-current
monitor source (`1180cafa`) slots reach 24 hours at 07:18 UTC. Comparing a full interval after the latest
application binding configuration needs the first complete slot after 10:55:36 UTC,
namely 2026-10-30 10:56 UTC (19:56 JST). These are earliest time bounds, not a
scheduled switch or assurance that the other gates will pass.
With the collector's two-minute stability exclusion, re-evaluate that complete
post-configuration window no earlier than 10:58 UTC (19:58 JST). In the initial
12-hour-9-minute post-configuration window, Core's public coverage was 361/365
(98.904%), independently below the 99% requirement.

Latest task-specific evidence is kept separately under
`/workspace/.cache/public-route-cutover-20261030/`. Re-evaluate actual state before
any subsequent operation; this historical preparation note is not execution approval.
