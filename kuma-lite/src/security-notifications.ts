import type { Env } from './types';

/** Capability-only DTO. No free-form message, destination, URL, or Slack payload is accepted. */
export interface SecurityAlert {
  version: 1;
  id: string;
  source: 'core' | 'portal' | 'waf' | 'ddos' | 'pipeline';
  kind: 'auth_failure_burst' | 'account_locked' | 'auth_rate_limited_burst'
    | 'authorization_denied_burst' | 'admin_privilege_changed' | 'totp_disabled' | 'security_policy_weakened'
    | 'waf_activity' | 'ddos_attack' | 'pipeline_degraded';
  severity: 'warning' | 'critical';
  occurredAt: number;
  windowStart: number;
  windowEnd: number;
  count: number;
  subjectHash?: string;
  host?: 'core-os.opus-system.jp' | 'partner-portal.opus-system.jp' | 'opus-system.jp';
  action?: 'block' | 'managed_challenge' | 'js_challenge' | 'challenge' | 'log' | 'mixed';
  ruleId?: string;
  detailCode?: 'password' | 'totp' | 'recovery' | 'ip' | 'account' | 'sampled_waf'
    | 'native_ddos' | 'analytics_unavailable' | 'analytics_gap' | 'queue_capacity' | 'delivery_failed';
}

export type SecurityDeliveryCode = 'invalid_alert' | 'not_configured' | 'timeout' | 'network_error'
  | 'rate_limited' | 'slack_unavailable' | 'slack_rejected' | 'invalid_response';
export type SecurityDeliveryResult = { ok: true }
  | { ok: false; code: SecurityDeliveryCode; retryAfterMs?: number };

const SEVEN_DAYS = 7 * 86_400_000;
const MAX_RESPONSE_BYTES = 16_384;
const REQUIRED = ['version', 'id', 'source', 'kind', 'severity', 'occurredAt', 'windowStart', 'windowEnd', 'count'];
const ALLOWED = new Set([...REQUIRED, 'subjectHash', 'host', 'action', 'ruleId', 'detailCode']);
const APP_KINDS = new Set(['auth_failure_burst', 'account_locked', 'auth_rate_limited_burst',
  'authorization_denied_burst', 'admin_privilege_changed', 'totp_disabled', 'security_policy_weakened']);
const CRITICAL_KINDS = new Set(['admin_privilege_changed', 'totp_disabled', 'security_policy_weakened']);
const HOSTS = new Set(['core-os.opus-system.jp', 'partner-portal.opus-system.jp', 'opus-system.jp']);
const ACTIONS = new Set(['block', 'managed_challenge', 'js_challenge', 'challenge', 'log', 'mixed']);
const DETAILS = new Set(['password', 'totp', 'recovery', 'ip', 'account', 'sampled_waf', 'native_ddos',
  'analytics_unavailable', 'analytics_gap', 'queue_capacity', 'delivery_failed']);

export function validSecurityAlert(value: unknown, now = Date.now()): value is SecurityAlert {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const v = value as Record<string, unknown>;
    if (Object.keys(v).some(key => !ALLOWED.has(key)) || REQUIRED.some(key => !Object.hasOwn(v, key))) return false;
    if (v.version !== 1 || typeof v.id !== 'string'
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(v.id)) return false;
    if (typeof v.kind !== 'string') return false;
    if (v.source === 'core' || v.source === 'portal') {
      if (!APP_KINDS.has(v.kind)) return false;
      const expectedHost = v.source === 'core' ? 'core-os.opus-system.jp' : 'partner-portal.opus-system.jp';
      if (v.host !== undefined && v.host !== expectedHost) return false;
    } else if (!((v.source === 'waf' && v.kind === 'waf_activity')
      || (v.source === 'ddos' && v.kind === 'ddos_attack')
      || (v.source === 'pipeline' && v.kind === 'pipeline_degraded'))) return false;
    if (v.severity !== (CRITICAL_KINDS.has(v.kind) ? 'critical' : 'warning')) return false;
    if (!Number.isSafeInteger(v.count) || (v.count as number) < 1 || (v.count as number) > 1_000_000_000) return false;
    for (const key of ['occurredAt', 'windowStart', 'windowEnd']) {
      if (!Number.isSafeInteger(v[key]) || (v[key] as number) < 0 || (v[key] as number) > now + 60_000) return false;
    }
    if ((v.occurredAt as number) < now - SEVEN_DAYS || (v.windowStart as number) > (v.windowEnd as number)
      || (v.windowEnd as number) - (v.windowStart as number) > SEVEN_DAYS) return false;
    if (v.subjectHash !== undefined && (typeof v.subjectHash !== 'string' || !/^[0-9a-f]{64}$/.test(v.subjectHash))) return false;
    if (v.host !== undefined && !HOSTS.has(v.host as string)) return false;
    if (v.action !== undefined && !ACTIONS.has(v.action as string)) return false;
    if (v.ruleId !== undefined && (typeof v.ruleId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(v.ruleId))) return false;
    if (v.detailCode !== undefined && !DETAILS.has(v.detailCode as string)) return false;
    return true;
  } catch { return false; }
}

const TITLES: Record<SecurityAlert['kind'], string> = {
  auth_failure_burst: '認証失敗の集中を検知',
  account_locked: '認証失敗によりアカウントをロック',
  auth_rate_limited_burst: '認証試行の制限超過を検知',
  authorization_denied_burst: '権限違反の繰り返しを検知',
  admin_privilege_changed: '管理者権限の変更を記録',
  totp_disabled: '二段階認証の無効化を記録',
  security_policy_weakened: 'セキュリティ設定の緩和を記録',
  waf_activity: 'WAFセキュリティイベントを検知',
  ddos_attack: 'CloudflareからHTTP DDoS通知を受信',
  pipeline_degraded: 'セキュリティ監視の一部を確認できません',
};
const SOURCE_LABELS: Record<SecurityAlert['source'], string> = {
  core: 'Core OS', portal: 'Partner Portal', waf: 'Cloudflare WAF',
  ddos: 'Cloudflare DDoS', pipeline: 'セキュリティ通知基盤',
};
const DETAIL_LABELS: Record<NonNullable<SecurityAlert['detailCode']>, string> = {
  password: 'パスワード', totp: '二段階認証', recovery: 'リカバリーコード', ip: '接続元単位',
  account: 'アカウント単位', sampled_waf: 'サンプリングされたWAF記録', native_ddos: 'Cloudflare標準通知',
  analytics_unavailable: '分析APIを取得できません', analytics_gap: '分析記録に欠測があります',
  queue_capacity: '通知保存枠に達しました', delivery_failed: '通知の配信を確認できません',
};

/** Every variable field has already passed a narrow alphabet/enum validation. */
export function renderSecurityAlert(alert: SecurityAlert): string {
  const lines = [
    `${alert.severity === 'critical' ? '【要確認】' : '【警告】'}${TITLES[alert.kind]}`,
    `対象: ${SOURCE_LABELS[alert.source]}${alert.host ? ` (${alert.host})` : ''}`,
    `件数: ${alert.count}`,
    `観測: ${new Date(alert.windowStart).toISOString()} ～ ${new Date(alert.windowEnd).toISOString()}`,
  ];
  if (alert.detailCode) lines.push(`区分: ${DETAIL_LABELS[alert.detailCode]}`);
  if (alert.action) lines.push(`Cloudflare処理: ${alert.action}`);
  if (alert.ruleId) lines.push(`ルール: ${alert.ruleId}`);
  if (alert.subjectHash) lines.push(`対象識別子: ${alert.subjectHash}`);
  lines.push('この通知だけで不正侵入が成立したとは判断できません。', `通知ID: ${alert.id}`);
  return lines.join('\n');
}

function cancel(response?: Response): void {
  if (!response?.body) return;
  try { void response.body.cancel().catch(() => undefined); } catch { /* Best effort, never wait for an ACK. */ }
}

function retryAfterMs(value: string | null, now: number): number {
  let ms = 60_000;
  if (value && /^\d{1,10}$/.test(value.trim())) ms = Number(value) * 1000;
  else if (value) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) ms = parsed - now;
  }
  return Math.max(1000, Math.min(3_600_000, ms));
}

/** Separated from the RPC class so local tests can exercise every I/O failure without sending messages. */
export async function deliverSecurityAlert(
  env: Pick<Env, 'SLACK_BOT_TOKEN' | 'SLACK_DEFAULT_CHANNEL'>,
  input: unknown,
  options: { fetchImpl?: typeof fetch; timeoutMs?: number; monotonicNow?: () => number; wallNow?: () => number } = {},
): Promise<SecurityDeliveryResult> {
  const wallNow = options.wallNow ?? Date.now;
  if (!validSecurityAlert(input, wallNow())) return { ok: false, code: 'invalid_alert' };
  if (!env.SLACK_BOT_TOKEN || !env.SLACK_DEFAULT_CHANNEL
    || !/^[CG][A-Z0-9]{8,31}$/.test(env.SLACK_DEFAULT_CHANNEL)) return { ok: false, code: 'not_configured', retryAfterMs: 3_600_000 };
  const text = renderSecurityAlert(input);
  const fetchImpl = options.fetchImpl ?? fetch.bind(globalThis);
  const monotonicNow = options.monotonicNow ?? (() => performance.now());
  const deadline = monotonicNow() + (options.timeoutMs ?? 6000);
  const controller = new AbortController();
  let response: Response | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let expired = false;
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      expired = true;
      controller.abort();
      try { void reader?.cancel().catch(() => undefined); } catch { /* Do not wait for cleanup. */ }
      cancel(response);
      reject(new Error('security_delivery_timeout'));
    }, Math.max(0, deadline - monotonicNow()));
  });
  const checkDeadline = (): void => {
    if (expired || monotonicNow() >= deadline) {
      expired = true;
      throw new Error('security_delivery_timeout');
    }
  };
  const operation = (async (): Promise<SecurityDeliveryResult> => {
    checkDeadline();
    const pending = fetchImpl('https://slack.com/api/chat.postMessage', {
      method: 'POST', redirect: 'manual', signal: controller.signal,
      headers: { Authorization: `Bearer ${env.SLACK_BOT_TOKEN}`, 'Content-Type': 'application/json; charset=utf-8', Accept: 'application/json' },
      body: JSON.stringify({ channel: env.SLACK_DEFAULT_CHANNEL, client_msg_id: input.id,
        text, mrkdwn: false, parse: 'none', link_names: false, unfurl_links: false, unfurl_media: false,
        blocks: [{ type: 'section', text: { type: 'plain_text', text, emoji: false } }],
      }),
    });
    // A non-cooperative transport can resolve after this call has already timed out.
    void pending.then(late => { if (expired) cancel(late); }, () => undefined);
    response = await pending;
    checkDeadline();
    if (response.status === 429) {
      return { ok: false, code: 'rate_limited', retryAfterMs: retryAfterMs(response.headers.get('Retry-After'), wallNow()) };
    }
    if (response.status >= 500 || response.status === 408) return { ok: false, code: 'slack_unavailable' };
    if (!response.ok) return { ok: false, code: 'slack_rejected', retryAfterMs: 3_600_000 };
    const length = response.headers.get('Content-Length');
    if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_RESPONSE_BYTES)) return { ok: false, code: 'invalid_response' };
    if (!response.body) return { ok: false, code: 'invalid_response' };
    reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });
    let bytes = 0;
    let json = '';
    while (true) {
      const chunk = await reader.read();
      checkDeadline();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) return { ok: false, code: 'invalid_response' };
      json += decoder.decode(chunk.value, { stream: true });
    }
    json += decoder.decode();
    let payload: unknown;
    try { payload = JSON.parse(json); } catch { return { ok: false, code: 'invalid_response' }; }
    checkDeadline();
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return { ok: false, code: 'invalid_response' };
    const result = payload as Record<string, unknown>;
    if (result.ok !== true) {
      if (result.error === 'ratelimited') return { ok: false, code: 'rate_limited', retryAfterMs: 60_000 };
      return { ok: false, code: 'slack_rejected', retryAfterMs: 3_600_000 };
    }
    if (result.channel !== env.SLACK_DEFAULT_CHANNEL || typeof result.ts !== 'string'
      || !/^\d{10,16}\.\d{1,16}$/.test(result.ts)) return { ok: false, code: 'invalid_response' };
    return { ok: true };
  })();
  try { return await Promise.race([operation, timeout]); }
  catch { return { ok: false, code: expired ? 'timeout' : 'network_error' }; }
  finally {
    clearTimeout(timer!);
    controller.abort();
    try { void reader?.cancel().catch(() => undefined); } catch { /* Do not await cancellation. */ }
    cancel(response);
  }
}
