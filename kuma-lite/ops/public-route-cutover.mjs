/** SQL generation only. Never connects to Cloudflare or sends a notification. */
import { createHash } from 'node:crypto';

export const CONFIG_FIELDS = Object.freeze([
  'id', 'name', 'url', 'description', 'fallback_url', 'service_binding',
  'probe_transport', 'monitor_role', 'parent_monitor_id', 'response_mode',
  'config_revision', 'availability_since_ms', 'method', 'expected_status',
  'keyword', 'timeout_ms', 'interval_minutes', 'enabled', 'retry_threshold',
  'latency_threshold_ms', 'db_latency_threshold_ms', 'http_latency_threshold_ms', 'created_at',
]);
const IDS = [5, 6, 9, 10];
const HOUR = 3_600_000, INTERVAL = 120_000, FRESHNESS = 360_000, REVIEW_MAX_AGE = 300_000;

function insist(condition, message) {
  if (!condition) throw new Error(`Cutover refused: ${message}`);
}

function configuration(monitors) {
  insist(Array.isArray(monitors) && monitors.length === 4, 'exactly four monitor settings are required');
  const rows = IDS.map(id => {
    const matches = monitors.filter(row => row.id === id);
    insist(matches.length === 1, 'unexpected monitor identities');
    const row = matches[0];
    insist(CONFIG_FIELDS.every(key => Object.hasOwn(row, key)), 'incomplete configuration snapshot');
    return Object.fromEntries(CONFIG_FIELDS.map(key => [key, row[key]]));
  });
  return rows;
}

export function configurationFingerprint(monitors) {
  return createHash('sha256').update(JSON.stringify(configuration(monitors))).digest('hex');
}

function validate(snapshot, review, nowMs, direction) {
  insist(Number.isSafeInteger(nowMs), 'explicit current time is required');
  const monitors = configuration(snapshot?.monitors);
  insist(review?.eligible === true && review.commonWaitResolved === true && review.publicMisclassificationResolved === true,
    'an eligible review with resolved common-wait and public-misclassification findings is required');
  insist(Number.isSafeInteger(review.reviewedAtMs) && nowMs >= review.reviewedAtMs &&
    nowMs - review.reviewedAtMs <= REVIEW_MAX_AGE, 'review is stale or from the future');
  for (const key of ['windowStartMs', 'windowEndMs', 'policyEpochMs'])
    insist(Number.isSafeInteger(review[key]), 'comparison bounds are required');
  insist(review.windowStartMs >= review.policyEpochMs &&
    review.windowEndMs - review.windowStartMs >= 24 * HOUR &&
    review.windowEndMs <= review.reviewedAtMs &&
    review.reviewedAtMs - review.windowEndMs <= REVIEW_MAX_AGE,
  'a recent complete 24 hours under the reviewed policy are required');
  insist(typeof snapshot.sourceSha === 'string' && /^[a-f0-9]{40}$/.test(snapshot.sourceSha) &&
    review.sourceSha === snapshot.sourceSha, 'source identity mismatch');
  insist(typeof snapshot.workerVersion === 'string' && snapshot.workerVersion.length > 0 &&
    review.workerVersion === snapshot.workerVersion, 'Worker version mismatch');
  insist(review.configFingerprint === configurationFingerprint(monitors), 'configuration fingerprint mismatch');
  insist(typeof review.healthVersion === 'string' && /^[a-f0-9]{7,40}$/.test(review.healthVersion),
    'application health version is required');
  const publicIds = direction === 'forward' ? [9, 10] : [5, 6];
  insist(Array.isArray(review.targets) && review.targets.length === 2 && publicIds.every(id => {
    const matches = review.targets.filter(target => target.monitorId === id);
    if (matches.length !== 1) return false;
    const target = matches[0];
    return target.configRevision === monitors.find(row => row.id === id).config_revision &&
      Number.isFinite(target.coverage) && target.coverage >= .99 && target.coverage <= 1 &&
      Number.isFinite(target.failureRate) && target.failureRate >= 0 && target.failureRate <= .01 &&
      target.duplicates === 0 && target.invalidSnapshots === 0 && target.contractErrors === 0 &&
      target.requestIdsUnique === true && target.latestTwoHealthy === true;
  }), 'each public comparison must satisfy coverage, failure, identity and response-contract gates');
  for (const row of monitors) {
    const primary = row.id === 5 || row.id === 6;
    insist(row.enabled === 1 && row.interval_minutes === 2 && row.timeout_ms === 10000 &&
      row.retry_threshold === 2 && row.db_latency_threshold_ms === 1500 && row.latency_threshold_ms === 1500 &&
      row.http_latency_threshold_ms === null && row.method === 'GET' && row.expected_status === 200,
    'approved probe policy changed');
    insist(row.url === `https://${row.id === 5 || row.id === 9 ? 'partner-portal' : 'core-os'}.opus-system.jp/healthz` &&
      row.service_binding === (row.id === 5 || row.id === 9 ? 'PARTNER_PORTAL' : 'CORE_OS'), 'target identity changed');
    insist(row.parent_monitor_id === (primary ? null : row.id === 9 ? 5 : 6), 'parent relationship changed');
    if (direction === 'forward') {
      insist(row.config_revision === (primary ? 2 : 4) && row.monitor_role === (primary ? 'availability' : 'shadow') &&
        row.probe_transport === (primary ? 'legacy' : 'public_fetch') &&
        row.response_mode === (primary ? 'legacy_http' : 'strict_healthz') && row.availability_since_ms === null,
      'settings do not match the reviewed pre-cutover generation');
    } else {
      insist(Number.isSafeInteger(row.config_revision) && row.config_revision >= (primary ? 3 : 5) &&
        row.monitor_role === (primary ? 'availability' : 'diagnostic') &&
        row.probe_transport === (primary ? 'public_fetch' : 'service_binding') && row.response_mode === 'strict_healthz' &&
        (primary ? Number.isSafeInteger(row.availability_since_ms) && row.availability_since_ms > 0 : row.availability_since_ms === null),
      'settings do not match a public-availability generation');
      if (primary) insist(review.windowStartMs >= row.availability_since_ms,
        'rollback comparison predates the public-availability boundary');
    }
  }
  return monitors;
}

/** A lost write ACK requires readback against before/after; never retry this statement blindly. */
function build(snapshot, review, nowMs, direction) {
  const monitors = validate(snapshot, review, nowMs, direction);
  const expected = monitors.map(row => ({ ...row,
    effective_transport: row.probe_transport === 'legacy' ? 'service_binding' : row.probe_transport,
  }));
  const forward = direction === 'forward';
  const sql = `WITH
clock(now_ms) AS MATERIALIZED (SELECT CAST(strftime('%s','now') AS INTEGER)*1000),
expected AS MATERIALIZED (SELECT value FROM json_each(?)),
latest AS MATERIALIZED (
  SELECT c.*, ROW_NUMBER() OVER (PARTITION BY c.monitor_id ORDER BY c.scheduled_slot DESC,c.id DESC) AS rn
  FROM checks c JOIN expected e ON c.monitor_id=json_extract(e.value,'$.id')
  WHERE c.config_revision=json_extract(e.value,'$.config_revision')
),
healthy AS MATERIALIZED (
  SELECT c.monitor_id,c.scheduled_slot,
    json_extract(CASE WHEN json_valid(c.probe_trace_json) THEN c.probe_trace_json ELSE '[]' END,'$[0].request_id') AS request_id
  FROM latest c JOIN expected e ON c.monitor_id=json_extract(e.value,'$.id')
  WHERE c.rn<=2 AND c.status='up' AND c.status_code=200 AND c.healthz_status='ok'
    AND c.healthz_version=? AND c.error IS NULL AND c.used_fallback=0 AND c.in_maintenance=0
    AND c.monitor_role=json_extract(e.value,'$.monitor_role')
    AND c.probe_transport=json_extract(e.value,'$.effective_transport')
    AND c.ts>(SELECT now_ms FROM clock)-${FRESHNESS} AND c.ts<=(SELECT now_ms FROM clock)
    AND c.scheduled_slot>(SELECT now_ms FROM clock)-${FRESHNESS} AND c.scheduled_slot<=(SELECT now_ms FROM clock)
    AND c.scheduled_slot%${INTERVAL}=0
    AND json_array_length(CASE WHEN json_valid(c.probe_trace_json) THEN c.probe_trace_json ELSE '[]' END)=1
    AND json_extract(CASE WHEN json_valid(c.probe_trace_json) THEN c.probe_trace_json ELSE '[]' END,'$[0].transport')=json_extract(e.value,'$.effective_transport')
    AND json_extract(CASE WHEN json_valid(c.probe_trace_json) THEN c.probe_trace_json ELSE '[]' END,'$[0].interval_minutes')=2
    AND json_type(CASE WHEN json_valid(c.probe_trace_json) THEN c.probe_trace_json ELSE '[]' END,'$[0].request_id')='text'
    AND length(json_extract(CASE WHEN json_valid(c.probe_trace_json) THEN c.probe_trace_json ELSE '[]' END,'$[0].request_id')) BETWEEN 1 AND 128
),
eligible(ready) AS MATERIALIZED (
  SELECT CASE WHEN
    (SELECT now_ms FROM clock)>=? AND (SELECT now_ms FROM clock)-?<=${REVIEW_MAX_AGE}
    AND (SELECT COUNT(*) FROM monitors m JOIN expected e ON m.id=json_extract(e.value,'$.id')
      WHERE ${CONFIG_FIELDS.map(key => `m.${key} IS json_extract(e.value,'$.${key}')`).join('\n        AND ')})=4
    AND (SELECT COUNT(*) FROM healthy)=8
    AND (SELECT COUNT(DISTINCT request_id) FROM healthy)=8
    AND (SELECT COUNT(*) FROM (SELECT monitor_id FROM healthy GROUP BY monitor_id
      HAVING COUNT(*)=2 AND MAX(scheduled_slot)-MIN(scheduled_slot)=${INTERVAL}))=4
    AND (SELECT COUNT(*) FROM monitor_state s JOIN expected e ON s.monitor_id=json_extract(e.value,'$.id')
      WHERE s.current_status='up' AND s.config_revision=json_extract(e.value,'$.config_revision')
        AND s.down_since IS NULL AND s.slack_alert_ts IS NULL
        AND (s.maintenance_to IS NULL OR s.maintenance_to<=(SELECT now_ms FROM clock))
        AND s.last_check_slot=(SELECT MAX(scheduled_slot) FROM healthy h WHERE h.monitor_id=s.monitor_id))=4
    AND NOT EXISTS (SELECT 1 FROM monitor_execution p WHERE p.monitor_id IN (5,6,9,10)
      AND p.lease_until>(SELECT now_ms FROM clock))
    AND NOT EXISTS (SELECT 1 FROM notification_delivery_state d WHERE d.monitor_id IN (5,6,9,10)
      AND (d.lease_until>(SELECT now_ms FROM clock) OR d.active_outbox_id IS NOT NULL OR d.slack_alert_ts IS NOT NULL))
    AND NOT EXISTS (SELECT 1 FROM notification_outbox o WHERE o.monitor_id IN (5,6,9,10)
      AND (o.status IN ('pending','processing','uncertain','failed') OR o.lease_until>(SELECT now_ms FROM clock)))
    THEN 1 ELSE 0 END
)
UPDATE monitors SET
  probe_transport=CASE WHEN id IN (5,6) THEN '${forward ? 'public_fetch' : 'legacy'}' ELSE '${forward ? 'service_binding' : 'public_fetch'}' END,
  monitor_role=CASE WHEN id IN (5,6) THEN 'availability' ELSE '${forward ? 'diagnostic' : 'shadow'}' END,
  response_mode=CASE WHEN id IN (5,6) THEN '${forward ? 'strict_healthz' : 'legacy_http'}' ELSE 'strict_healthz' END,
  availability_since_ms=CASE WHEN id IN (5,6) THEN ${forward ? '(SELECT now_ms FROM clock)' : 'NULL'} ELSE NULL END,
  name=CASE id WHEN 9 THEN 'Partner Portal ${forward ? 'internal path' : 'public shadow'}'
    WHEN 10 THEN 'Core OS ${forward ? 'internal path' : 'public shadow'}' ELSE name END,
  config_revision=config_revision+1
WHERE id IN (5,6,9,10) AND (SELECT ready FROM eligible)=1
RETURNING id,name,probe_transport,monitor_role,parent_monitor_id,response_mode,config_revision,availability_since_ms;`;
  return { sql, params: [JSON.stringify(expected), review.healthVersion, review.reviewedAtMs, review.reviewedAtMs],
    direction, before: monitors, beforeFingerprint: configurationFingerprint(monitors),
    requiresDeploymentRecheck: true, expectedChanges: 4,
    preservedPublicBoundaries: monitors.filter(row => row.availability_since_ms !== null)
      .map(({ id, availability_since_ms }) => ({ id, availability_since_ms })),
    warning: 'Read deployment/version immediately before execution; unknown ACK requires readback, not retry. No state/history/thread writes are included.',
  };
}

export function buildPublicRouteCutover({ snapshot, review, nowMs }) {
  return build(snapshot, review, nowMs, 'forward');
}

/** Rollback clears the current public boundary; archive preservedPublicBoundaries first.
 * Raw path/revision snapshots remain stored. A later public return must create a new boundary.
 */
export function buildPublicRouteRollback({ snapshot, review, nowMs }) {
  return build(snapshot, review, nowMs, 'rollback');
}
