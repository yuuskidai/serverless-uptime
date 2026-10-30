/** Offline statement generation only. No Cloudflare client or notification sender. */
import { createHash } from 'node:crypto';

export const CONFIG_FIELDS = Object.freeze([
  'id', 'name', 'url', 'description', 'fallback_url', 'service_binding',
  'probe_transport', 'monitor_role', 'parent_monitor_id', 'response_mode',
  'config_revision', 'availability_since_ms', 'method', 'expected_status',
  'keyword', 'timeout_ms', 'interval_minutes', 'enabled', 'retry_threshold',
  'latency_threshold_ms', 'db_latency_threshold_ms', 'http_latency_threshold_ms', 'created_at',
]);
export const SAFE_STATE_FIELDS = Object.freeze([
  'monitor_id', 'current_status', 'consecutive_failures', 'consecutive_degraded',
  'consecutive_successes', 'last_check_slot', 'config_revision', 'last_notified_at',
  'down_since', 'slack_alert_ts', 'maintenance_from', 'maintenance_to', 'maintenance_reason',
]);
export const DELIVERY_FIELDS = Object.freeze([
  'monitor_id', 'lease_until', 'active_outbox_id', 'last_processed_slot', 'slack_alert_ts',
]);
const IDS = [5, 6, 9, 10];
const INTERVAL = 120_000, FRESHNESS = 360_000, REVIEW_MAX_AGE = 300_000;
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

function insist(condition, message) {
  if (!condition) throw new Error(`Cutover refused: ${message}`);
}

function rows(input, fields, key, label) {
  insist(Array.isArray(input) && input.length === 4, `exactly four ${label} rows are required`);
  return IDS.map(id => {
    const matches = input.filter(row => row?.[key] === id);
    insist(matches.length === 1, `unexpected ${label} identities`);
    const row = matches[0];
    insist(fields.every(field => Object.hasOwn(row, field)), `incomplete ${label} snapshot`);
    insist(fields.every(field => row[field] === null || typeof row[field] === 'string' ||
      (typeof row[field] === 'number' && Number.isFinite(row[field]))), `invalid ${label} snapshot value`);
    return Object.fromEntries(fields.map(field => [field, row[field]]));
  });
}
const configuration = input => rows(input, CONFIG_FIELDS, 'id', 'configuration');
const states = input => rows(input, SAFE_STATE_FIELDS, 'monitor_id', 'state');
const deliveries = input => rows(input, DELIVERY_FIELDS, 'monitor_id', 'delivery');
export const configurationFingerprint = input => hash(configuration(input));

function safeState(row, nowMs) {
  return row.current_status === 'up' && row.down_since === null && row.slack_alert_ts === null &&
    (row.maintenance_to === null || row.maintenance_to <= nowMs) &&
    Number.isSafeInteger(row.config_revision) && row.config_revision > 0 &&
    Number.isSafeInteger(row.last_check_slot);
}
function safeDelivery(row, nowMs) {
  return Number.isSafeInteger(row.lease_until) && row.lease_until <= nowMs &&
    row.active_outbox_id === null && row.slack_alert_ts === null;
}

function snapshotRows(snapshot, nowMs) {
  insist(Number.isSafeInteger(nowMs), 'explicit current time is required');
  insist(typeof snapshot?.sourceSha === 'string' && /^[a-f0-9]{40}$/.test(snapshot.sourceSha), 'source identity is required');
  insist(typeof snapshot.workerVersion === 'string' && snapshot.workerVersion.length > 0, 'Worker identity is required');
  return { monitors: configuration(snapshot.monitors), states: states(snapshot.states), delivery: deliveries(snapshot.delivery) };
}
function reviewed(snapshot, review, nowMs, direction) {
  insist(review?.eligible === true && review.missingAsUnknown === true,
    'an eligible reviewed decision retaining missing observations as UNKNOWN is required');
  insist(Number.isSafeInteger(review.reviewedAtMs) && nowMs >= review.reviewedAtMs &&
    nowMs - review.reviewedAtMs <= REVIEW_MAX_AGE, 'review is stale or from the future');
  insist(review.sourceSha === snapshot.sourceSha && review.workerVersion === snapshot.workerVersion,
    'review source or Worker identity mismatch');
  insist(review.configFingerprint === configurationFingerprint(snapshot.monitors), 'configuration fingerprint mismatch');
  if (direction === 'forward') {
    insist(review.routeEvidenceReviewed === true && review.strictPublicResponseReviewed === true &&
      review.immediateRollbackReviewed === true, 'route, strict-response and immediate-backout evidence must be reviewed');
    insist(typeof review.healthVersion === 'string' && /^[a-f0-9]{7,40}$/.test(review.healthVersion),
      'application health version is required');
    insist(Array.isArray(review.targets) && review.targets.length === 2 && [9, 10].every(id => {
      const matches = review.targets.filter(target => target.monitorId === id);
      const target = matches[0];
      return matches.length === 1 && target.configRevision === snapshot.monitors.find(row => row.id === id).config_revision &&
        target.duplicates === 0 && target.invalidSnapshots === 0 && target.contractErrors === 0 &&
        target.requestIdsUnique === true && target.latestTwoHealthy === true;
    }), 'public comparisons must preserve route identity, strict response correctness and fresh normal observations');
  } else insist(review.rollbackReviewed === true, 'the rollback decision must be explicitly reviewed');
}

function policy(monitors) {
  for (const row of monitors) {
    const primary = row.id < 9, portal = row.id === 5 || row.id === 9;
    insist(row.enabled === 1 && row.interval_minutes === 2 && row.timeout_ms === 10000 &&
      row.retry_threshold === 2 && row.db_latency_threshold_ms === 1500 && row.latency_threshold_ms === 1500 &&
      row.http_latency_threshold_ms === null && row.method === 'GET' && row.expected_status === 200,
    'approved probe policy changed');
    insist(row.url === `https://${portal ? 'partner-portal' : 'core-os'}.opus-system.jp/healthz` &&
      row.service_binding === (portal ? 'PARTNER_PORTAL' : 'CORE_OS'), 'target identity changed');
    insist(row.parent_monitor_id === (primary ? null : portal ? 5 : 6), 'parent relationship changed');
  }
}
function initial(monitors) {
  policy(monitors);
  for (const row of monitors) {
    const primary = row.id < 9;
    insist(row.config_revision === (primary ? 2 : 4) && row.monitor_role === (primary ? 'availability' : 'shadow') &&
      row.probe_transport === (primary ? 'legacy' : 'public_fetch') &&
      row.response_mode === (primary ? 'legacy_http' : 'strict_healthz') && row.availability_since_ms === null,
    'settings do not match the reviewed pre-cutover generation');
  }
}
function afterConfiguration(before, boundary) {
  return before.map(row => ({ ...row,
    name: row.id === 9 ? 'Partner Portal internal path' : row.id === 10 ? 'Core OS internal path' : row.name,
    probe_transport: row.id < 9 ? 'public_fetch' : 'service_binding',
    monitor_role: row.id < 9 ? 'availability' : 'diagnostic', response_mode: 'strict_healthz',
    config_revision: row.config_revision + 1, availability_since_ms: row.id < 9 ? boundary : null,
  }));
}
function equalRows(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

/** Capture only from a confirmed four-row acknowledgement/readback, never from an assumed ACK. */
export function createHandoffReceipt({ beforeSnapshot, afterSnapshot, reviewedAtMs, nowMs }) {
  const before = snapshotRows(beforeSnapshot, nowMs), after = snapshotRows(afterSnapshot, nowMs);
  initial(before.monitors);
  insist(Number.isSafeInteger(reviewedAtMs) && nowMs >= reviewedAtMs && nowMs - reviewedAtMs <= REVIEW_MAX_AGE,
    'a fresh handoff review is required');
  insist(beforeSnapshot.sourceSha === afterSnapshot.sourceSha && beforeSnapshot.workerVersion === afterSnapshot.workerVersion,
    'handoff deployment identity changed');
  insist(before.states.every(row => safeState(row, nowMs) && row.config_revision === before.monitors.find(m => m.id === row.monitor_id).config_revision) &&
    before.delivery.every(row => safeDelivery(row, nowMs)), 'the saved pre-cutover state was not safe');
  const boundary = after.monitors[0].availability_since_ms;
  insist(Number.isSafeInteger(boundary) && boundary > 0 && boundary >= Math.floor(reviewedAtMs / 1000) * 1000 && boundary <= nowMs,
    'actual public availability boundary is missing or outside the handoff');
  insist(equalRows(after.monitors, afterConfiguration(before.monitors, boundary)), 'readback is not the exact four-row handoff');
  // Natural observations may progress after the write. Retain the guarded BEFORE
  // state, rather than falsely requiring the readback state to remain unchanged.
  const receipt = { version: 2, sourceSha: beforeSnapshot.sourceSha, workerVersion: beforeSnapshot.workerVersion,
    reviewedAtMs, appliedAtMs: boundary, recordedAtMs: nowMs,
    beforeMonitors: before.monitors, beforeStates: before.states, beforeDelivery: before.delivery,
    afterMonitors: after.monitors, beforeFingerprint: hash(before), afterFingerprint: configurationFingerprint(after.monitors) };
  return { ...receipt, receiptFingerprint: hash(receipt) };
}
function receiptRows(receipt, snapshot, nowMs) {
  insist(receipt?.version === 2, 'a confirmed handoff receipt is required');
  const { receiptFingerprint, ...contents } = receipt;
  insist(receiptFingerprint === hash(contents), 'handoff receipt integrity mismatch');
  insist(receipt.sourceSha === snapshot.sourceSha && receipt.workerVersion === snapshot.workerVersion,
    'handoff deployment identity mismatch');
  const before = { monitors: configuration(receipt.beforeMonitors), states: states(receipt.beforeStates), delivery: deliveries(receipt.beforeDelivery) };
  const after = configuration(receipt.afterMonitors);
  initial(before.monitors);
  insist(Number.isSafeInteger(receipt.reviewedAtMs) && Number.isSafeInteger(receipt.recordedAtMs) &&
    receipt.recordedAtMs >= receipt.reviewedAtMs && receipt.recordedAtMs <= nowMs &&
    receipt.recordedAtMs - receipt.reviewedAtMs <= REVIEW_MAX_AGE,
  'handoff receipt timing is invalid');
  insist(receipt.beforeFingerprint === hash(before) && receipt.afterFingerprint === configurationFingerprint(after), 'handoff baseline fingerprint mismatch');
  insist(Number.isSafeInteger(receipt.appliedAtMs) && receipt.appliedAtMs > 0 && receipt.appliedAtMs <= receipt.recordedAtMs &&
    receipt.appliedAtMs >= Math.floor(receipt.reviewedAtMs / 1000) * 1000 &&
    equalRows(after, afterConfiguration(before.monitors, receipt.appliedAtMs)), 'handoff baseline transition mismatch');
  insist(before.states.every(row => safeState(row, receipt.recordedAtMs) && row.config_revision === before.monitors.find(m => m.id === row.monitor_id).config_revision) &&
    before.delivery.every(row => safeDelivery(row, receipt.recordedAtMs)), 'handoff pre-state is not safe');
  insist(equalRows(configuration(snapshot.monitors), after), 'current settings do not match the handoff receipt');
  return { before, after };
}

const compare = (alias, expectedAlias, fields) => fields.map(key => `${alias}.${key} IS json_extract(${expectedAlias}.value,'$.${key}')`).join(' AND ');
const ownerIdleSql = `NOT EXISTS (SELECT 1 FROM monitor_execution p WHERE p.monitor_id IN (5,6,9,10) AND p.lease_until>(SELECT now_ms FROM clock))
    AND NOT EXISTS (SELECT 1 FROM notification_delivery_state d WHERE d.monitor_id IN (5,6,9,10)
      AND (d.lease_until>(SELECT now_ms FROM clock) OR d.active_outbox_id IS NOT NULL OR d.slack_alert_ts IS NOT NULL))
    AND NOT EXISTS (SELECT 1 FROM notification_outbox o WHERE o.monitor_id IN (5,6,9,10)
      AND (o.status IN ('pending','processing','uncertain','failed') OR o.lease_until>(SELECT now_ms FROM clock)))`;
const baselineSql = `
    (SELECT COUNT(*) FROM monitors m JOIN expected e ON m.id=json_extract(e.value,'$.id') WHERE ${compare('m', 'e', CONFIG_FIELDS)})=4
    AND (SELECT COUNT(*) FROM monitor_state s JOIN state_expected se ON s.monitor_id=json_extract(se.value,'$.monitor_id')
      WHERE ${compare('s', 'se', SAFE_STATE_FIELDS)} AND s.current_status='up' AND s.down_since IS NULL AND s.slack_alert_ts IS NULL
      AND (s.maintenance_to IS NULL OR s.maintenance_to<=(SELECT now_ms FROM clock)))=4
    AND (SELECT COUNT(*) FROM notification_delivery_state d JOIN delivery_expected de ON d.monitor_id=json_extract(de.value,'$.monitor_id')
      WHERE ${compare('d', 'de', DELIVERY_FIELDS)})=4
    AND ${ownerIdleSql}`;
const ctes = `clock(now_ms) AS MATERIALIZED (SELECT CAST(strftime('%s','now') AS INTEGER)*1000),
expected AS MATERIALIZED (SELECT value FROM json_each(?)),
state_expected AS MATERIALIZED (SELECT value FROM json_each(?)),
delivery_expected AS MATERIALIZED (SELECT value FROM json_each(?)),
latest AS MATERIALIZED (
 SELECT c.*,ROW_NUMBER() OVER(PARTITION BY c.monitor_id ORDER BY c.scheduled_slot DESC,c.id DESC) AS rn
 FROM checks c JOIN expected e ON c.monitor_id=json_extract(e.value,'$.id')
 WHERE c.config_revision=json_extract(e.value,'$.config_revision')
)`;
const fullReturning = `RETURNING ${CONFIG_FIELDS.join(',')}`;
function plan(snapshot, snap, review, direction, sql, params) {
  return { sql, params, direction, before: snap.monitors, beforeStates: snap.states, beforeDelivery: snap.delivery,
    beforeFingerprint: configurationFingerprint(snap.monitors), reviewedAtMs: review.reviewedAtMs,
    sourceSha: snapshot.sourceSha, workerVersion: snapshot.workerVersion, requiresDeploymentRecheck: true, expectedChanges: 4,
    warning: 'Recheck deployed source/version immediately before execution. Unknown ACK requires actual-state readback, never blind retry. State/history/notifications are not modified.' };
}

export function buildPublicRouteCutover({ snapshot, review, nowMs }) {
  const snap = snapshotRows(snapshot, nowMs);
  reviewed(snapshot, review, nowMs, 'forward'); initial(snap.monitors);
  insist(snap.states.every(row => safeState(row, nowMs) && row.config_revision === snap.monitors.find(m => m.id === row.monitor_id).config_revision) &&
    snap.delivery.every(row => safeDelivery(row, nowMs)), 'current state or delivery is not safe');
  const expected = snap.monitors.map(row => ({ ...row, effective_transport: row.probe_transport === 'legacy' ? 'service_binding' : row.probe_transport }));
  const sql = `WITH ${ctes},
healthy AS MATERIALIZED (
 SELECT c.monitor_id,c.scheduled_slot,
  json_extract(CASE WHEN json_valid(c.probe_trace_json) THEN c.probe_trace_json ELSE '[]' END,'$[0].request_id') AS request_id
 FROM latest c JOIN expected e ON c.monitor_id=json_extract(e.value,'$.id')
 WHERE c.monitor_id IN (9,10) AND c.rn<=2 AND c.status='up' AND c.status_code=200 AND c.healthz_status='ok'
  AND c.healthz_version=? AND c.error IS NULL AND c.used_fallback=0 AND c.in_maintenance=0
  AND c.monitor_role=json_extract(e.value,'$.monitor_role') AND c.probe_transport='public_fetch'
  AND c.ts>(SELECT now_ms FROM clock)-${FRESHNESS} AND c.ts<=(SELECT now_ms FROM clock)
  AND c.scheduled_slot>(SELECT now_ms FROM clock)-${FRESHNESS} AND c.scheduled_slot<=(SELECT now_ms FROM clock)
  AND c.scheduled_slot%${INTERVAL}=0
  AND json_array_length(CASE WHEN json_valid(c.probe_trace_json) THEN c.probe_trace_json ELSE '[]' END)=1
  AND json_extract(CASE WHEN json_valid(c.probe_trace_json) THEN c.probe_trace_json ELSE '[]' END,'$[0].transport')='public_fetch'
  AND json_extract(CASE WHEN json_valid(c.probe_trace_json) THEN c.probe_trace_json ELSE '[]' END,'$[0].interval_minutes')=2
  AND json_type(CASE WHEN json_valid(c.probe_trace_json) THEN c.probe_trace_json ELSE '[]' END,'$[0].request_id')='text'
  AND length(request_id) BETWEEN 1 AND 128
),
eligible(ready) AS MATERIALIZED (
 SELECT CASE WHEN (SELECT now_ms FROM clock)>=? AND (SELECT now_ms FROM clock)-?<=${REVIEW_MAX_AGE}
  AND ${baselineSql}
  AND (SELECT COUNT(*) FROM healthy)=4 AND (SELECT COUNT(DISTINCT request_id) FROM healthy)=4
  AND (SELECT COUNT(*) FROM (SELECT monitor_id FROM healthy GROUP BY monitor_id HAVING COUNT(*)=2 AND MAX(scheduled_slot)-MIN(scheduled_slot)=${INTERVAL}))=2
  AND (SELECT COUNT(*) FROM monitor_state s JOIN latest c ON c.monitor_id=s.monitor_id AND c.rn=1
    WHERE s.config_revision=c.config_revision AND s.last_check_slot=c.scheduled_slot
      AND c.monitor_role=(SELECT monitor_role FROM monitors WHERE id=s.monitor_id)
      AND c.probe_transport=CASE WHEN s.monitor_id IN(5,6) THEN 'service_binding' ELSE 'public_fetch' END)=4
 THEN 1 ELSE 0 END
)
UPDATE monitors SET probe_transport=CASE WHEN id IN(5,6) THEN 'public_fetch' ELSE 'service_binding' END,
 monitor_role=CASE WHEN id IN(5,6) THEN 'availability' ELSE 'diagnostic' END,response_mode='strict_healthz',
 availability_since_ms=CASE WHEN id IN(5,6) THEN (SELECT now_ms FROM clock) ELSE NULL END,
 name=CASE id WHEN 9 THEN 'Partner Portal internal path' WHEN 10 THEN 'Core OS internal path' ELSE name END,
 config_revision=config_revision+1
WHERE id IN(5,6,9,10) AND (SELECT ready FROM eligible)=1 ${fullReturning};`;
  const clock = Math.floor(review.reviewedAtMs / 1000) * 1000;
  return plan(snapshot, snap, review, 'forward', sql, [JSON.stringify(expected), JSON.stringify(snap.states), JSON.stringify(snap.delivery), review.healthVersion, clock, clock]);
}

/** Exact receipt plus live state CAS supports backout before any new observation,
 * or after safe observations, including a first failing probe before an alert.
 * An open incident or pending/uncertain notification must never be erased.
 */
export function buildPublicRouteRollback({ snapshot, review, receipt, nowMs }) {
  const snap = snapshotRows(snapshot, nowMs);
  reviewed(snapshot, review, nowMs, 'rollback'); policy(snap.monitors);
  const handoff = receiptRows(receipt, snapshot, nowMs);
  insist(snap.states.every(row => safeState(row, nowMs)) && snap.delivery.every(row => safeDelivery(row, nowMs)),
    'current state or delivery is not safe for rollback');
  for (const state of snap.states) {
    const old = handoff.before.states.find(row => row.monitor_id === state.monitor_id);
    const setting = snap.monitors.find(row => row.id === state.monitor_id);
    insist(state.config_revision === setting.config_revision || equalRows(state, old), 'state is neither an exact saved baseline nor the current generation');
  }
  const sql = `WITH ${ctes},
pre_state AS MATERIALIZED (SELECT value FROM json_each(?)),
restore AS MATERIALIZED (SELECT value FROM json_each(?)),
eligible(ready) AS MATERIALIZED (
 SELECT CASE WHEN (SELECT now_ms FROM clock)>=? AND (SELECT now_ms FROM clock)-?<=${REVIEW_MAX_AGE}
  AND ${baselineSql}
  AND (SELECT COUNT(*) FROM monitor_state s JOIN expected e ON s.monitor_id=json_extract(e.value,'$.id')
    JOIN pre_state b ON s.monitor_id=json_extract(b.value,'$.monitor_id')
    WHERE (
      (s.config_revision=json_extract(b.value,'$.config_revision') AND ${compare('s', 'b', SAFE_STATE_FIELDS)}
       AND NOT EXISTS(SELECT 1 FROM checks c WHERE c.monitor_id=s.monitor_id AND c.config_revision=json_extract(e.value,'$.config_revision')))
      OR
      (s.config_revision=json_extract(e.value,'$.config_revision') AND EXISTS(
        SELECT 1 FROM latest c WHERE c.monitor_id=s.monitor_id AND c.rn=1 AND c.scheduled_slot=s.last_check_slot
         AND c.monitor_role=json_extract(e.value,'$.monitor_role') AND c.probe_transport=json_extract(e.value,'$.probe_transport')
         AND c.ts<=(SELECT now_ms FROM clock) AND c.scheduled_slot<=(SELECT now_ms FROM clock)))
    ))=4
 THEN 1 ELSE 0 END
)
UPDATE monitors SET
 name=(SELECT json_extract(r.value,'$.name') FROM restore r WHERE json_extract(r.value,'$.id')=monitors.id),
 probe_transport=(SELECT json_extract(r.value,'$.probe_transport') FROM restore r WHERE json_extract(r.value,'$.id')=monitors.id),
 monitor_role=(SELECT json_extract(r.value,'$.monitor_role') FROM restore r WHERE json_extract(r.value,'$.id')=monitors.id),
 response_mode=(SELECT json_extract(r.value,'$.response_mode') FROM restore r WHERE json_extract(r.value,'$.id')=monitors.id),
 availability_since_ms=NULL,config_revision=config_revision+1
WHERE id IN(5,6,9,10) AND (SELECT ready FROM eligible)=1 ${fullReturning};`;
  const clock = Math.floor(review.reviewedAtMs / 1000) * 1000;
  const result = plan(snapshot, snap, review, 'rollback', sql, [JSON.stringify(snap.monitors), JSON.stringify(snap.states), JSON.stringify(snap.delivery),
    JSON.stringify(handoff.before.states), JSON.stringify(handoff.before.monitors), clock, clock]);
  result.preservedPublicBoundaries = snap.monitors.filter(row => row.availability_since_ms !== null)
    .map(({ id, availability_since_ms }) => ({ id, availability_since_ms }));
  return result;
}
